import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, flattenTree, parentKeys, childProgress, groupLanes, dueState } from '../public/tree.js';

const status = key => ({ statusCategory: { key } });
const issue = (key, type, parent = null, extra = {}) => ({
  key,
  fields: {
    summary: `${key} 요약`,
    issuetype: { name: type },
    status: status(extra.done ? 'done' : 'new'),
    parent: parent && { key: parent.key, fields: { summary: parent.fields.summary, issuetype: parent.fields.issuetype } },
    assignee: extra.assignee ?? null,
    subtasks: [],
    children: []
  }
});

const epic = issue('OS-1', 'Epic');
const story = issue('OS-2', 'Story', epic, { assignee: { accountId: 'u-doyun', displayName: '이도윤' } });
const sub = issue('OS-3', 'Subtask', story, { done: true });
const loose = issue('OS-4', 'Task');
const all = [epic, story, sub, loose];

test('the list tree nests children under parents that are in the result', () => {
  const roots = buildTree(all);
  assert.deepEqual(roots.map(node => node.issue.key), ['OS-1', 'OS-4']);
  assert.deepEqual(parentKeys(roots), ['OS-1', 'OS-2']);

  const open = flattenTree(roots, () => true).map(row => `${row.issue.key}@${row.depth}${row.open ? '+' : ''}`);
  assert.deepEqual(open, ['OS-1@0+', 'OS-2@1+', 'OS-3@2', 'OS-4@0']);
  const epicClosed = flattenTree(roots, key => key !== 'OS-1').map(row => row.issue.key);
  assert.deepEqual(epicClosed, ['OS-1', 'OS-4']);

  const orphan = buildTree([sub, loose]);
  assert.deepEqual(orphan.map(node => node.issue.key), ['OS-3', 'OS-4'], 'a child whose parent is not shown becomes a root');
});

test('child progress counts subtasks and epic children together', () => {
  const parent = issue('OS-9', 'Story');
  parent.fields.subtasks = [sub, issue('OS-10', 'Subtask')];
  assert.deepEqual({ ...childProgress(parent), kids: undefined }, { total: 2, done: 1, kids: undefined });
  assert.equal(childProgress(loose).total, 0);
});

test('board lanes group by epic, including subtasks through their story, or by assignee', () => {
  const byEpic = groupLanes([story, sub, loose], 'epic', all);
  assert.deepEqual(byEpic.map(lane => [lane.id, lane.issues.map(i => i.key)]), [['OS-1', ['OS-2', 'OS-3']], ['-', ['OS-4']]]);
  assert.equal(byEpic[0].title, 'OS-1 요약');
  assert.equal(byEpic.at(-1).title, '에픽 없음');

  const byPerson = groupLanes([story, loose], 'assignee');
  assert.deepEqual(byPerson.map(lane => lane.title), ['이도윤', '담당자 없음']);
  assert.equal(groupLanes(all, 'none').length, 1);
});

test('due dates are classified relative to today', () => {
  const today = new Date(2026, 9, 23);
  assert.equal(dueState(null, today), null);
  assert.deepEqual(dueState('2026-10-22', today), { days: -1, tone: 'late' });
  assert.deepEqual(dueState('2026-10-23', today), { days: 0, tone: 'soon' });
  assert.deepEqual(dueState('2026-11-02', today), { days: 10, tone: 'later' });
});
