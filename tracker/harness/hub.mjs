// Harness Hub 요약 파일(schemaVersion 1)을 만든다.
// 계획(plan.json), 트래커 원장, gh의 열린 PR만 읽고 원장에는 쓰지 않는다.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adfToText } from '../lib/adf.js';
import { isSqliteFile, readState } from '../lib/sql.js';
import { linkTypes } from '../lib/store.js';
import { statuses } from '../lib/workflow.js';

const tracker = fileURLToPath(new URL('..', import.meta.url));
const blocksTypeId = linkTypes.find(type => type.name === 'Blocks').id;
const categoryOf = Object.fromEntries(statuses.map(status => [status.id, status.category]));
const pullRequestLimit = 200;

// run.mjs의 리뷰어가 검증 실패로 티켓을 진행 중으로 되돌릴 때 남기는 댓글 첫 줄. 되돌림 집계의 기준이다.
export const reworkNote = '검증이 실패해 진행 중으로 되돌립니다.';

const iso = value => new Date(value).toISOString();

function run(command, args, cwd) {
  return new Promise(done => {
    execFile(command, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      done(error ? null : stdout.trim());
    });
  });
}

// 트래커와 같은 규칙으로 원장을 고른다: SQLite가 초기화돼 있으면 그것을, 아니면 옆의 db.json을 읽는다.
// 원장이 없으면 null을 돌려준다. SQLite는 읽기 전용으로 열어 가져오기·스키마 생성을 하지 않는다.
export async function readLedger(file) {
  let json = file;
  if (isSqliteFile(file)) {
    json = join(dirname(file), 'db.json');
    if (await access(file).then(() => true, () => false)) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (db.prepare(`SELECT value FROM meta WHERE key = 'initialized'`).get()) return readState(db);
      } finally {
        db.close();
      }
    }
  }
  try {
    return JSON.parse(await readFile(json, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 열린 PR을 gh로 조회한다. 조회하지 못하면 null, 목록이 잘렸으면 truncated를 표시한다.
export async function openPullRequests(cwd) {
  const out = await run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,url', '--limit', String(pullRequestLimit)], cwd);
  if (out === null) return null;
  try {
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return null;
    return { list: list.map(({ number, title, url }) => ({ number, title, url })), truncated: list.length >= pullRequestLimit };
  } catch {
    return null;
  }
}

export async function readRevision(cwd) {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const commit = await run('git', ['rev-parse', '--short', 'HEAD'], cwd);
  return { branch: branch && branch !== 'HEAD' ? branch : null, commit: commit || null };
}

// 하네스와 같은 정의로 판정한다.
// - 티켓: plan.json의 epics[].tickets[] (에픽·하위 작업 제외, 보고서의 "티켓 N개"와 같다)
// - 대응 이슈: plan.project 프로젝트에서 `plan-<id>` 라벨이 붙은 이슈 (run.mjs의 findByPlanId)
// - 완료: 상태 범주 done. 착수 후보: To Do이고, 보류(defer) 에픽이 아니며, 막는 티켓이 모두 done
// - 불일치: 계획에는 있으나 원장에 대응 이슈가 없는 티켓 (하네스가 아직 등록하지 않음)
// - 되돌림: 계획 이슈에 남은 reworkNote 댓글 수
export function buildSnapshot({ plan, state, pulls, revision = {}, generatedAt = new Date() }) {
  const tickets = plan.epics.flatMap(epic => epic.tickets.map(ticket => ({ ...ticket, deferred: Boolean(epic.defer) })));
  const progress = {
    completeness: 'unavailable',
    totalTickets: tickets.length,
    doneTickets: null,
    openPullRequests: null,
    actionableTickets: null,
    mismatchCount: null,
    branch: revision.branch ?? null,
    commit: revision.commit ?? null,
    tasks: tickets.map(ticket => ({ id: ticket.id, title: ticket.summary, stage: 'UNJUDGED' })),
    pullRequests: []
  };
  const snapshot = { schemaVersion: 1, generatedAt: iso(generatedAt), progress };
  if (!state) return snapshot;

  const project = state.projects.find(p => p.key === (plan.project ?? 'OS'));
  const planIssues = state.issues.filter(issue => issue.projectId === project?.id && (issue.labels ?? []).some(label => label.startsWith('plan-')));
  const byPlanId = new Map();
  for (const issue of planIssues) {
    for (const label of issue.labels) if (label.startsWith('plan-') && !byPlanId.has(label.slice(5))) byPlanId.set(label.slice(5), issue);
  }
  const issueById = new Map(state.issues.map(issue => [issue.id, issue]));
  const isDone = issue => Boolean(issue) && categoryOf[issue.statusId] === 'done';
  const stageOf = issue => {
    if (!issue) return 'MISMATCH';
    const category = categoryOf[issue.statusId];
    return category === 'done' ? 'DONE' : category === 'new' ? 'TODO' : category === 'indeterminate' ? 'IN_PROGRESS' : 'UNJUDGED';
  };
  const blockersCleared = (ticket, issue) => {
    const planned = (ticket.blockedBy ?? []).map(id => byPlanId.get(id));
    const linked = (state.links ?? []).filter(link => link.typeId === blocksTypeId && link.inwardId === issue.id).map(link => issueById.get(link.outwardId));
    return [...planned, ...linked].every(isDone);
  };

  const judged = tickets.map(ticket => {
    const issue = byPlanId.get(ticket.id);
    const stage = stageOf(issue);
    return { ticket, issue, stage, actionable: stage === 'TODO' && !ticket.deferred && blockersCleared(ticket, issue) };
  });
  progress.tasks = judged.map(({ ticket, issue, stage }) => ({ id: issue?.key ?? ticket.id, title: ticket.summary, stage }));

  if (pulls) {
    progress.openPullRequests = pulls.list.length;
    progress.pullRequests = pulls.list;
  }
  if (pulls && !pulls.truncated) {
    progress.completeness = 'complete';
    progress.doneTickets = judged.filter(j => j.stage === 'DONE').length;
    progress.actionableTickets = judged.filter(j => j.actionable).length;
    progress.mismatchCount = judged.filter(j => j.stage === 'MISMATCH').length;
  } else {
    progress.completeness = 'partial';
  }

  if (planIssues.length) {
    const reworkCount = planIssues.reduce((n, issue) => n + (issue.comments ?? []).filter(c => adfToText(c.body).startsWith(reworkNote)).length, 0);
    const start = planIssues.map(issue => Date.parse(issue.created)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Date.parse(generatedAt));
    snapshot.period = { start: iso(start), end: snapshot.generatedAt };
    snapshot.scope = [
      `트래커 원장의 ${plan.project ?? 'OS'} 프로젝트에서 harness/plan.json 항목(plan-* 라벨 이슈 ${planIssues.length}개).`,
      '되돌림은 하네스 리뷰어가 검증 실패로 In Review → In Progress로 되돌리며 남긴 댓글 수다.',
      '사람 개입·리뷰 결함·토큰·비용은 원천 기록이 없어 집계하지 않는다.'
    ].join(' ');
    snapshot.pricingAsOf = null;
    snapshot.metrics = {
      humanInterventions: null,
      reworkCount,
      reviewFindings: null,
      firstRoundFindingsPerPr: null,
      reviewedPrCount: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null
    };
  }
  return snapshot;
}

export async function writeHubSnapshot({ data, plan: planFile, out, log = () => {} }) {
  const plan = JSON.parse(await readFile(resolve(planFile), 'utf8'));
  const cwd = dirname(resolve(planFile));
  let state = null;
  try {
    state = await readLedger(resolve(data));
    if (!state) log(`허브 요약: 원장 ${data}이(가) 없어 진행 현황을 판정하지 않습니다.`);
  } catch (error) {
    log(`허브 요약: 원장을 읽지 못했습니다 (${error.message}).`);
  }
  const [pulls, revision] = await Promise.all([openPullRequests(cwd), readRevision(cwd)]);
  if (!pulls) log('허브 요약: gh로 열린 PR을 조회하지 못해 완료·착수·불일치를 확정하지 않습니다.');
  const snapshot = buildSnapshot({ plan, state, pulls, revision, generatedAt: new Date() });
  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
  return { file: target, snapshot };
}

export const defaults = {
  data: join(tracker, 'data', 'tracker.sqlite'),
  plan: join(tracker, 'harness', 'plan.json'),
  out: join(tracker, '..', 'docs', 'harness-hub.json')
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      data: { type: 'string', default: defaults.data },
      plan: { type: 'string', default: defaults.plan },
      out: { type: 'string', default: defaults.out }
    }
  });
  writeHubSnapshot({ ...values, log: message => console.error(message) })
    .then(({ file, snapshot }) => {
      const p = snapshot.progress;
      console.log(`허브 요약: ${file}`);
      console.log(`  ${p.completeness} · 티켓 ${p.totalTickets} · 완료 ${p.doneTickets ?? '-'} · 착수 후보 ${p.actionableTickets ?? '-'} · 불일치 ${p.mismatchCount ?? '-'} · 열린 PR ${p.openPullRequests ?? '-'}`);
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
