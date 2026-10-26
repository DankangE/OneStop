import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createAppServer } from '../server.mjs';
import { createStore, loadStore } from '../lib/store.js';

const tracker = fileURLToPath(new URL('..', import.meta.url));
const T = { todo: '11', start: '21', review: '31', done: '41', reopen: '51' };

const { values: options } = parseArgs({
  options: {
    url: { type: 'string' },
    data: { type: 'string', default: join(tracker, 'data', 'db.json') },
    plan: { type: 'string', default: join(tracker, 'harness', 'plan.json') },
    scenario: { type: 'string', default: 'plan' },
    'dry-run': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
});

const log = (...parts) => { if (!options.quiet) console.log(...parts); };

const automationKey = options.url
  ? (await readFile(join(dirname(resolve(options.data)), '.automation-key'), 'utf8').catch(() => '')).trim()
  : '';

function client(base, accountId) {
  return async (method, path, body) => {
    const response = await fetch(`${base}/rest/api/3${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tracker-User': accountId,
        ...(automationKey ? { 'X-Tracker-Automation-Key': automationKey } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = [...(data?.errorMessages ?? []), ...Object.values(data?.errors ?? {})].join(' ');
      throw new Error(`${method} ${path} → ${response.status} ${detail}`);
    }
    return data;
  };
}

function runVerify(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'node') {
    return Promise.resolve({ ok: false, output: 'Verification commands must start with "node".', ms: 0 });
  }
  const started = Date.now();
  return new Promise(done => {
    execFile(process.execPath, argv.slice(1), { cwd: tracker, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().split('\n').slice(-8).join('\n');
      done({ ok: !error, output, ms: Date.now() - started });
    });
  });
}

async function startServer(store) {
  const server = createAppServer(store);
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function runPlan(plan, base, { dryRun = false } = {}) {
  const as = role => client(base, plan.roles[role]);
  const owner = as('owner');
  const analyst = as('analyst');
  const builder = as('builder');
  const reviewer = as('reviewer');
  const results = [];

  const findByPlanId = async id => (await owner('POST', '/search/jql', { jql: `labels = plan-${id}`, maxResults: 1 })).issues[0] ?? null;
  const ensure = async (call, id, fields) => {
    const existing = await findByPlanId(id);
    if (existing) return { key: existing.key, created: false };
    const created = await call('POST', '/issue', {
      fields: { project: { key: plan.project }, ...fields, labels: [...(fields.labels ?? []), `plan-${id}`] }
    });
    return { key: created.key, created: true };
  };
  const status = async key => (await owner('GET', `/issue/${key}`)).fields.status.name;

  log('\n① 이슈 등록 (owner)');
  for (const epic of plan.epics) {
    epic.key = (await ensure(owner, epic.id, { issuetype: { name: 'Epic' }, summary: epic.summary, description: epic.description, priority: { name: 'High' } })).key;
    log(`  ${epic.key}  ${epic.summary}`);
  }

  log('\n② 티켓 분해 (analyst)');
  for (const epic of plan.epics) {
    for (const ticket of epic.tickets) {
      ticket.key = (await ensure(analyst, ticket.id, {
        issuetype: { name: ticket.type ?? 'Story' },
        summary: ticket.summary,
        description: ticket.description ?? `${epic.summary}의 티켓입니다.\n\n완료 조건: ${ticket.verify?.join(' ') ?? '검증 명령을 정한 뒤 처리합니다.'}`,
        priority: { name: ticket.priority ?? 'Medium' },
        labels: ticket.labels ?? [],
        parent: { key: epic.key }
      })).key;
      log(`  ${epic.key} ⟶ ${ticket.key}  ${ticket.summary}`);
      for (const sub of ticket.subtasks ?? []) {
        sub.key = (await ensure(analyst, sub.id, {
          issuetype: { name: 'Subtask' },
          summary: sub.summary,
          description: `완료 조건: ${sub.verify.join(' ')} 통과`,
          labels: ticket.labels ?? [],
          parent: { key: ticket.key }
        })).key;
        log(`      ⟶ ${sub.key}  ${sub.summary}`);
      }
    }
  }
  const byId = Object.fromEntries(plan.epics.flatMap(epic => epic.tickets).map(ticket => [ticket.id, ticket]));
  for (const ticket of Object.values(byId)) {
    for (const id of ticket.blockedBy ?? []) {
      const blocker = byId[id];
      if (!blocker) throw new Error(`Plan ticket "${ticket.id}" is blocked by unknown ticket "${id}".`);
      const links = (await analyst('GET', `/issue/${ticket.key}`)).fields.issuelinks;
      if (links.some(link => link.type.name === 'Blocks' && link.outwardIssue?.key === blocker.key)) continue;
      await analyst('POST', '/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: blocker.key }, inwardIssue: { key: ticket.key } });
      log(`  ${blocker.key} ⊣ ${ticket.key}  (${blocker.key}이(가) 막음)`);
    }
  }
  if (dryRun) return results;

  const openBlockers = async key => (await owner('GET', `/issue/${key}`)).fields.issuelinks
    .filter(link => link.type.name === 'Blocks' && link.outwardIssue && link.outwardIssue.fields.status.statusCategory.key !== 'done')
    .map(link => link.outwardIssue.key);

  async function handle(item, kind) {
    const before = await status(item.key);
    if (before === 'Done') {
      results.push({ key: item.key, summary: item.summary, kind, outcome: 'already-done' });
      log(`  ${item.key}  이미 완료`);
      return true;
    }
    if (!item.verify) {
      results.push({ key: item.key, summary: item.summary, kind, outcome: 'failed', output: '검증 명령(verify)이 계획에 없습니다.' });
      log(`  ${item.key}  실패: 검증 명령 없음`);
      return false;
    }
    try {
      return await work(item, kind, before);
    } catch (error) {
      const output = `하네스가 처리 중 멈췄습니다: ${error.message}`;
      await builder('POST', `/issue/${item.key}/comment`, { body: output }).catch(() => {});
      results.push({ key: item.key, summary: item.summary, kind, outcome: 'failed', output });
      log(`  ${item.key}  실패: ${error.message}`);
      return false;
    }
  }

  async function work(item, kind, before) {
    await builder('PUT', `/issue/${item.key}`, { fields: { assignee: { accountId: plan.roles.builder } } });
    if (before === 'To Do') {
      await builder('POST', `/issue/${item.key}/transitions`, {
        transition: { id: T.start },
        update: { comment: [{ add: { body: `착수합니다. 완료 조건: ${item.verify.join(' ')}` } }] }
      });
    }
    const check = await runVerify(item.verify);
    const evidence = `$ ${item.verify.join(' ')}\n${check.output || '(출력 없음)'}\n(${check.ms}ms, ${check.ok ? '통과' : '실패'})`;
    if (before !== 'In Review') {
      await builder('POST', `/issue/${item.key}/transitions`, {
        transition: { id: T.review },
        update: { comment: [{ add: { body: `검토 요청합니다.\n\n${evidence}` } }] }
      });
    }
    if (check.ok) {
      await reviewer('POST', `/issue/${item.key}/transitions`, {
        transition: { id: T.done },
        update: { comment: [{ add: { body: '검증 결과를 확인했습니다. 완료 처리합니다.' } }] }
      });
    } else {
      await reviewer('POST', `/issue/${item.key}/transitions`, {
        transition: { id: T.start },
        update: { comment: [{ add: { body: `검증이 실패해 진행 중으로 되돌립니다.\n\n${evidence}` } }] }
      });
    }
    results.push({ key: item.key, summary: item.summary, kind, outcome: check.ok ? 'done' : 'failed', ms: check.ms, output: check.output });
    log(`  ${item.key}  ${check.ok ? '완료' : '실패 → 진행 중'}  (${check.ms}ms)  ${item.summary}`);
    return check.ok;
  }

  log('\n③ 순차 처리 (builder → reviewer)');
  for (const epic of plan.epics) {
    if (epic.defer) {
      for (const ticket of epic.tickets) results.push({ key: ticket.key, summary: ticket.summary, kind: ticket.type ?? 'Story', outcome: 'deferred' });
      results.push({ key: epic.key, summary: epic.summary, kind: 'Epic', outcome: 'deferred' });
      log(`  ${epic.key}  다음 단계로 보류 (티켓 ${epic.tickets.length}개)`);
      continue;
    }
    let allDone = true;
    let queue = [...epic.tickets];
    while (queue.length) {
      const waiting = [];
      for (const ticket of queue) {
        const blockers = await openBlockers(ticket.key);
        if (blockers.length) {
          waiting.push(ticket);
          log(`  ${ticket.key}  ${blockers.join(', ')}에 막혀 뒤로 미룸`);
          continue;
        }
        let subsDone = true;
        for (const sub of ticket.subtasks ?? []) subsDone = (await handle(sub, 'Subtask')) && subsDone;
        if (subsDone) allDone = (await handle(ticket, ticket.type ?? 'Story')) && allDone;
        else {
          allDone = false;
          results.push({ key: ticket.key, summary: ticket.summary, kind: ticket.type ?? 'Story', outcome: 'blocked' });
          log(`  ${ticket.key}  하위 작업 실패로 보류`);
        }
      }
      if (waiting.length === queue.length) {
        for (const ticket of waiting) {
          const blockers = await openBlockers(ticket.key);
          results.push({ key: ticket.key, summary: ticket.summary, kind: ticket.type ?? 'Story', outcome: 'blocked', output: `${blockers.join(', ')}이(가) 끝나지 않았습니다.` });
          log(`  ${ticket.key}  ${blockers.join(', ')}이(가) 끝나지 않아 보류`);
        }
        allDone = false;
        break;
      }
      queue = waiting;
    }
    const epicStatus = await status(epic.key);
    if (allDone && epicStatus !== 'Done') {
      if (epicStatus === 'To Do') await owner('POST', `/issue/${epic.key}/transitions`, { transition: { id: T.start } });
      await owner('POST', `/issue/${epic.key}/transitions`, {
        transition: { id: T.done },
        update: { comment: [{ add: { body: `모든 티켓(${epic.tickets.map(t => t.key).join(', ')})이 검증을 통과해 에픽을 닫습니다.` } }] }
      });
    } else if (!allDone && epicStatus === 'To Do') {
      await owner('POST', `/issue/${epic.key}/transitions`, { transition: { id: T.start } });
    }
    const final = await status(epic.key);
    results.push({ key: epic.key, summary: epic.summary, kind: 'Epic', outcome: final === 'Done' ? 'done' : 'open' });
    log(`  ${epic.key}  에픽 → ${final}`);
  }
  return results;
}

function report(results, plan) {
  const icon = { done: '완료', 'already-done': '완료(이전 실행)', failed: '실패', blocked: '보류', open: '진행 중', deferred: '다음 단계' };
  const lines = [
    '# 하네스 실행 보고서',
    '',
    `- 실행 시각: ${new Date().toISOString()}`,
    `- 에픽 ${plan.epics.length}개, 티켓 ${plan.epics.reduce((n, e) => n + e.tickets.length, 0)}개, 하위 작업 ${plan.epics.reduce((n, e) => n + e.tickets.reduce((m, t) => m + (t.subtasks?.length ?? 0), 0), 0)}개`,
    `- 실패 ${results.filter(r => r.outcome === 'failed').length}건, 보류 ${results.filter(r => r.outcome === 'blocked').length}건`,
    '',
    '| 키 | 유형 | 요약 | 결과 |',
    '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.key} | ${r.kind} | ${r.summary} | ${icon[r.outcome]} |`)
  ];
  const failures = results.filter(r => (r.outcome === 'failed' || r.outcome === 'blocked') && r.output);
  if (failures.length) {
    lines.push('', '## 실패·보류 사유', '');
    for (const f of failures) lines.push(`### ${f.key} ${f.summary}`, '', '```', f.output, '```', '');
  }
  return `${lines.join('\n')}\n`;
}

async function smoke() {
  const store = createStore();
  const { server, base } = await startServer(store);
  try {
    const plan = {
      project: 'OS',
      roles: { owner: 'u-haneul', analyst: 'u-seoyeon', builder: 'u-agent', reviewer: 'u-doyun' },
      epics: [{
        id: 'smoke', summary: 'Smoke epic', description: 'Harness self-test.',
        tickets: [
          { id: 'smoke-pass', type: 'Story', summary: 'Passing story', verify: ['node', '-e', 'process.exit(0)'],
            subtasks: [{ id: 'smoke-sub', summary: 'Passing subtask', verify: ['node', '-e', 'process.exit(0)'] }] },
          { id: 'smoke-wait', type: 'Story', summary: 'Waits for the bug', verify: ['node', '-e', 'process.exit(0)'], blockedBy: ['smoke-fail'] },
          { id: 'smoke-after', type: 'Task', summary: 'Runs after its blocker', verify: ['node', '-e', 'process.exit(0)'], blockedBy: ['smoke-late'] },
          { id: 'smoke-fail', type: 'Bug', summary: 'Failing bug', verify: ['node', '-e', 'process.exit(3)'] },
          { id: 'smoke-late', type: 'Task', summary: 'Unblocks a ticket', verify: ['node', '-e', 'process.exit(0)'] },
          { id: 'smoke-unplanned', type: 'Task', summary: 'Ticket without a check' }
        ]
      }]
    };
    const results = await runPlan(plan, base);
    const byKey = Object.fromEntries(results.map(r => [r.summary, r.outcome]));
    const expected = {
      'Passing subtask': 'done', 'Passing story': 'done', 'Failing bug': 'failed', 'Unblocks a ticket': 'done',
      'Runs after its blocker': 'done', 'Waits for the bug': 'blocked', 'Ticket without a check': 'failed', 'Smoke epic': 'open'
    };
    for (const [summary, outcome] of Object.entries(expected)) {
      if (byKey[summary] !== outcome) throw new Error(`smoke: "${summary}" ended as ${byKey[summary]}, expected ${outcome}.`);
    }
    const order = results.map(r => r.summary);
    if (order.indexOf('Unblocks a ticket') > order.indexOf('Runs after its blocker')) {
      throw new Error('smoke: a blocked ticket must be processed after the ticket that blocks it.');
    }
    const bug = store.state.issues.find(i => i.summary === 'Failing bug');
    if (store.state.issues.length !== 8 || bug.statusId !== '10001' || bug.comments.length !== 3 || store.state.links.length !== 2) {
      throw new Error('smoke: tracker state does not match the expected issue → ticket → processing trail.');
    }
    const rerun = await runPlan(plan, base);
    if (store.state.issues.length !== 8 || store.state.links.length !== 2 || rerun.find(r => r.summary === 'Passing story').outcome !== 'already-done') {
      throw new Error('smoke: a second run must reuse existing issues and links and skip finished tickets.');
    }
    console.log('ok smoke: issue → ticket → processing trail verified, blockers respected, rerun is idempotent');
  } finally {
    await new Promise(done => server.close(done));
  }
}

async function main() {
  if (options.scenario === 'smoke') return smoke();
  if (options.scenario !== 'plan') throw new Error(`Unknown scenario "${options.scenario}". Use plan or smoke.`);
  const plan = JSON.parse(await readFile(resolve(options.plan), 'utf8'));
  let server = null;
  let store = null;
  let base = options.url;
  if (!base) {
    store = await loadStore(resolve(options.data));
    ({ server, base } = await startServer(store));
  }
  try {
    log(`트래커: ${base}${store ? ` (데이터: ${options.data})` : ''}`);
    const results = await runPlan(plan, base, { dryRun: options['dry-run'] });
    if (options['dry-run']) return;
    const text = report(results, plan);
    await mkdir(join(tracker, 'reports'), { recursive: true });
    await writeFile(join(tracker, 'reports', 'latest.md'), text);
    log(`\n보고서: reports/latest.md`);
    if (results.some(r => r.outcome === 'failed' || r.outcome === 'blocked')) process.exitCode = 1;
  } finally {
    if (server) await new Promise(done => server.close(done));
    if (store) await store.flush();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
