import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textToAdf } from '../lib/adf.js';
import { loadStore } from '../lib/store.js';
import { buildSnapshot, readLedger, reworkNote } from '../harness/hub.mjs';

const plan = {
  project: 'OS',
  epics: [
    { id: 'e1', summary: 'Epic', tickets: [
      { id: 'a', summary: 'Done ticket' },
      { id: 'b', summary: 'Free to start' },
      { id: 'c', summary: 'Waits for b', blockedBy: ['b'] },
      { id: 'd', summary: 'Linked blocker is open' },
      { id: 'e', summary: 'Being worked on' },
      { id: 'f', summary: 'Not registered yet' }
    ] },
    { id: 'later', defer: true, summary: 'Deferred', tickets: [{ id: 'g', summary: 'Deferred ticket' }] }
  ]
};

const issue = (id, key, label, statusId, extra = {}) => ({
  id, key, projectId: '10000', labels: [`plan-${label}`], statusId, created: '2026-10-21T06:36:18.170+0000', comments: [], ...extra
});

const state = {
  projects: [{ id: '10000', key: 'OS' }, { id: '10001', key: 'WEB' }],
  issues: [
    issue('1', 'OS-1', 'e1', '10001'),
    issue('2', 'OS-2', 'a', '10003', { comments: [{ body: textToAdf(`${reworkNote}\n\n$ node -e 1`) }, { body: textToAdf('검증 결과를 확인했습니다.') }] }),
    issue('3', 'OS-3', 'b', '10000', { created: '2026-10-20T01:00:00.000+0000' }),
    issue('4', 'OS-4', 'c', '10000'),
    issue('5', 'OS-5', 'd', '10000'),
    issue('6', 'OS-6', 'e', '10002', { comments: [{ body: textToAdf(`${reworkNote}\n\nfailed`) }] }),
    issue('7', 'OS-7', 'g', '10000'),
    issue('8', 'OS-8', 'x', '10000'),
    { ...issue('9', 'WEB-1', 'f', '10003'), projectId: '10001' }
  ],
  links: [{ id: '1', typeId: '1010', inwardId: '5', outwardId: '8' }]
};

const pulls = { list: [{ number: 3, title: 'Open PR', url: 'https://github.com/DankangE/OneStop/pull/3' }], truncated: false };
const at = new Date('2026-10-29T00:00:00Z');

test('hub snapshot judges plan tickets against the tracker ledger', () => {
  const snapshot = buildSnapshot({ plan, state, pulls, revision: { branch: 'main', commit: 'abc1234' }, generatedAt: at });
  const p = snapshot.progress;
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, '2026-10-29T00:00:00.000Z');
  assert.equal(p.completeness, 'complete');
  assert.equal(p.totalTickets, 7);
  assert.equal(p.doneTickets, 1);
  assert.equal(p.actionableTickets, 1, 'only b: c waits for b, d has an open Blocks link, g is deferred');
  assert.equal(p.mismatchCount, 1, 'f has no plan-f issue in OS (the WEB issue does not count)');
  assert.equal(p.openPullRequests, 1);
  assert.deepEqual(p.pullRequests, pulls.list);
  assert.deepEqual(p.tasks.map(t => [t.id, t.stage]), [
    ['OS-2', 'DONE'], ['OS-3', 'TODO'], ['OS-4', 'TODO'], ['OS-5', 'TODO'], ['OS-6', 'IN_PROGRESS'], ['f', 'MISMATCH'], ['OS-7', 'TODO']
  ]);
  assert.equal(p.branch, 'main');
  assert.equal(p.commit, 'abc1234');
});

test('hub snapshot counts only the harness rework note and states its window', () => {
  const snapshot = buildSnapshot({ plan, state, pulls, generatedAt: at });
  assert.equal(snapshot.metrics.reworkCount, 2);
  for (const key of ['humanInterventions', 'reviewFindings', 'firstRoundFindingsPerPr', 'reviewedPrCount', 'inputTokens', 'outputTokens', 'estimatedCostUsd']) {
    assert.equal(snapshot.metrics[key], null, `${key} has no source and stays null`);
  }
  assert.deepEqual(snapshot.period, { start: '2026-10-20T01:00:00.000Z', end: '2026-10-29T00:00:00.000Z' });
  assert.match(snapshot.scope, /plan-\* 라벨 이슈 8개/);
});

test('hub snapshot withholds judgements when gh or the ledger is unavailable', () => {
  const noGh = buildSnapshot({ plan, state, pulls: null, generatedAt: at }).progress;
  assert.equal(noGh.completeness, 'partial');
  assert.deepEqual([noGh.doneTickets, noGh.actionableTickets, noGh.mismatchCount, noGh.openPullRequests], [null, null, null, null]);

  const truncated = buildSnapshot({ plan, state, pulls: { ...pulls, truncated: true }, generatedAt: at }).progress;
  assert.equal(truncated.completeness, 'partial');
  assert.equal(truncated.openPullRequests, 1);
  assert.equal(truncated.doneTickets, null);

  const noLedger = buildSnapshot({ plan, state: null, pulls, generatedAt: at });
  assert.equal(noLedger.progress.completeness, 'unavailable');
  assert.equal(noLedger.progress.totalTickets, 7);
  assert.equal(noLedger.progress.openPullRequests, null);
  assert.ok(noLedger.progress.tasks.every(t => t.stage === 'UNJUDGED'));
  assert.equal(noLedger.metrics, undefined);
});

test('hub ledger reader prefers SQLite, falls back to db.json, and never imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-hub-'));
  try {
    const sqlite = join(dir, 'tracker.sqlite');
    assert.equal(await readLedger(sqlite), null);
    await writeFile(join(dir, 'db.json'), JSON.stringify({ projects: [], issues: [{ key: 'OS-1' }] }));
    assert.deepEqual((await readLedger(sqlite)).issues, [{ key: 'OS-1' }]);
    await assert.rejects(access(sqlite), { code: 'ENOENT' }, 'reading must not create or import the SQLite ledger');

    await rm(join(dir, 'db.json'));
    const store = await loadStore(sqlite);
    await store.flush();
    const ledger = await readLedger(sqlite);
    assert.ok(ledger.projects.some(p => p.key === 'OS'));
    assert.deepEqual(ledger.issues.map(i => i.key), store.state.issues.map(i => i.key));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
