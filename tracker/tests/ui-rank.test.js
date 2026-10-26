import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankPlacement } from '../public/views.js';
import { createStore } from '../lib/store.js';

test('a drop above or below a card becomes rankBeforeIssue or rankAfterIssue', () => {
  assert.deepEqual(rankPlacement('OS-3', { key: 'OS-1', before: true }), { rankBeforeIssue: 'OS-1' });
  assert.deepEqual(rankPlacement('OS-3', { key: 'OS-1', before: false }), { rankAfterIssue: 'OS-1' });
  assert.equal(rankPlacement('OS-3', { key: 'OS-3', before: true }), null, 'dropping on itself keeps the order');
  assert.equal(rankPlacement('OS-3', null), null, 'dropping on empty column space only changes status');
});

test('the board and backlog load issues in rank order, so a saved order survives a reload', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /ORDER BY rank ASC/);
  assert.doesNotMatch(app, /ORDER BY priority DESC, key ASC/);

  const store = createStore();
  for (const summary of ['A', 'B', 'C']) store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary } }, 'u-agent');
  store.rankIssues({ issues: ['OS-3'], ...rankPlacement('OS-3', { key: 'OS-1', before: true }) }, 'u-agent');
  const reloaded = createStore({ state: structuredClone(store.state) });
  assert.deepEqual(reloaded.search({ jql: 'project = OS ORDER BY rank ASC' }).issues.map(i => i.key), ['OS-3', 'OS-1', 'OS-2']);
});
