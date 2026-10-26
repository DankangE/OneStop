import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createAppServer } from '../server.mjs';
import { isStaleDone, finishedOn } from '../public/tree.js';

const make = (store, summary, extra = {}, actor = 'u-doyun') =>
  store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary, ...extra } }, actor);

test('archiving hides issues from search and keeps them readable but frozen', () => {
  const store = createStore();
  const task = make(store, 'Old task');
  const sub = make(store, 'Child', { issuetype: { name: 'Subtask' }, parent: { key: task.key } });
  const other = make(store, 'Keep me');

  assert.throws(() => store.archiveIssues({ issueIdsOrKeys: [task.key] }, 'u-doyun'), error => error.status === 400 && /administrator/.test(error.message));
  const result = store.archiveIssues({ issueIdsOrKeys: [task.key, sub.key, 'OS-999'] }, 'u-haneul');
  assert.equal(result.numberOfIssuesUpdated, 2, 'the subtask moves with its parent and is counted');
  assert.deepEqual(result.errors.issueIsSubtask.issueIdsOrKeys, [sub.key]);
  assert.deepEqual(result.errors.issuesNotFound, { count: 1, issueIdsOrKeys: ['OS-999'], message: 'Issue not found.' });

  const keys = store.search({ jql: 'project = OS', currentUser: 'u-doyun', maxResults: 100 }).issues.map(i => i.key);
  assert.deepEqual(keys.sort(), [other.key]);
  const view = store.issueView(store.state.issues.find(i => i.key === task.key), '');
  assert.ok(view.fields.archiveddate);
  assert.equal(view.fields.archivedby.accountId, 'u-haneul');
  assert.throws(() => store.updateIssue(task.key, { fields: { summary: 'x' } }, 'u-haneul'), /archived/);
  assert.throws(() => store.addComment(sub.key, 'hi', 'u-haneul'), /archived/);
  assert.deepEqual(store.archivedIssues('OS', 'u-haneul').map(i => i.key), [task.key]);
  assert.throws(() => store.archivedIssues('OS', 'u-doyun'), error => error.status === 403);

  assert.equal(store.archiveIssues({ issueIdsOrKeys: [task.key] }, 'u-haneul').numberOfIssuesUpdated, 0, 'already archived is a no-op');
  assert.equal(store.unarchiveIssues({ issueIdsOrKeys: [task.key] }, 'u-haneul').numberOfIssuesUpdated, 2);
  assert.equal(store.search({ jql: 'project = OS', currentUser: 'u-doyun', maxResults: 100 }).total, 3);
  store.updateIssue(task.key, { fields: { summary: 'Back' } }, 'u-haneul');
});

test('PUT /rest/api/3/issue/archive and unarchive follow the Jira shape', async () => {
  const store = createStore();
  const task = make(store, 'Ship it');
  const server = createAppServer(store, { auth: 'none' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (path, body, user = 'u-haneul') => fetch(`${base}/rest/api/3/issue/${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Tracker-User': user }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await put('archive', {})).status, 400);
    assert.equal((await put('archive', { issueIdsOrKeys: Array.from({ length: 1001 }, (_, i) => `OS-${i}`) })).status, 400);
    const archived = await put('archive', { issueIdsOrKeys: [task.key] });
    assert.equal(archived.status, 200);
    assert.deepEqual(await archived.json(), { errors: {}, numberOfIssuesUpdated: 1 });
    const listed = await (await fetch(`${base}/rest/tracker/1/project/OS/archived`, { headers: { 'X-Tracker-User': 'u-haneul' } })).json();
    assert.deepEqual(listed.issues.map(i => i.key), [task.key]);
    assert.equal((await fetch(`${base}/rest/api/3/issue/${task.key}`, { headers: { 'X-Tracker-User': 'u-doyun' } })).status, 200);
    assert.equal((await put('unarchive', { issueIdsOrKeys: [task.key] })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the board treats issues finished before the cutoff as old', () => {
  const issue = (cat, resolutiondate, updated = '2026-10-20T00:00:00.000+0000') => ({ fields: { status: { statusCategory: { key: cat } }, resolutiondate, updated } });
  assert.equal(finishedOn(issue('done', '2026-10-01T09:00:00.000+0000')), '2026-10-01');
  assert.equal(finishedOn(issue('done', null)), '2026-10-20', 'falls back to the last update');
  assert.ok(isStaleDone(issue('done', '2026-10-01T09:00:00.000+0000'), '2026-10-09'));
  assert.ok(!isStaleDone(issue('done', '2026-10-09T09:00:00.000+0000'), '2026-10-09'));
  assert.ok(!isStaleDone(issue('indeterminate', '2026-01-01T00:00:00.000+0000'), '2026-10-09'));
  assert.ok(!isStaleDone(issue('done', '2026-01-01T00:00:00.000+0000'), null), 'no cutoff during an active sprint');
});
