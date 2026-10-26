import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';

const admin = 'u-haneul';
const member = 'u-doyun';
const make = (store, fields = {}) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Story' }, summary: 'Work', ...fields } }, admin);
const order = store => store.search({ jql: 'ORDER BY rank ASC' }).issues.map(i => i.key);
const dates = { startDate: '2026-10-21T00:00:00.000Z', endDate: '2026-11-04T00:00:00.000Z' };

test('new issues are ranked at the bottom', () => {
  const store = createStore();
  make(store); make(store); make(store);
  assert.deepEqual(order(store), ['OS-1', 'OS-2', 'OS-3']);
});

test('rankBeforeIssue and rankAfterIssue reorder and log the change', () => {
  const store = createStore();
  for (let i = 0; i < 4; i += 1) make(store);
  store.rankIssues({ issues: ['OS-4'], rankBeforeIssue: 'OS-2' }, member);
  assert.deepEqual(order(store), ['OS-1', 'OS-4', 'OS-2', 'OS-3']);
  store.rankIssues({ issues: ['OS-1', 'OS-2'], rankAfterIssue: 'OS-3' }, member);
  assert.deepEqual(order(store), ['OS-4', 'OS-3', 'OS-1', 'OS-2']);
  const items = store.findIssue('OS-4').changelog.flatMap(e => e.items);
  assert.deepEqual(items.at(-1), { field: 'Rank', fromString: null, toString: 'Ranked higher' });
});

test('rank validates its anchor, batch size and permission', () => {
  const store = createStore();
  make(store); make(store);
  assert.throws(() => store.rankIssues({ issues: ['OS-1'] }, admin), /exactly one/);
  assert.throws(() => store.rankIssues({ issues: ['OS-1'], rankBeforeIssue: 'OS-1' }, admin), /itself/);
  assert.throws(() => store.rankIssues({ issues: Array(51).fill('OS-1'), rankBeforeIssue: 'OS-2' }, admin), /At most 50/);
  assert.throws(() => store.rankIssues({ issues: ['OS-1'], rankAfterIssue: 'OS-2' }, 'u-guest'), error => error.status === 403);
});

test('sprint lifecycle: future → active → closed', () => {
  let clock = new Date('2026-10-21T09:00:00Z');
  const store = createStore({ now: () => clock });
  const done = make(store);
  const open = make(store);
  const sub = make(store, { issuetype: { name: 'Subtask' }, parent: { key: open.key } });
  const sprint = store.createSprint({ name: 'OS 스프린트 1', originBoardId: 1, goal: '보드 완성' }, admin);
  assert.equal(sprint.state, 'future');
  store.moveToSprint(sprint.id, { issues: [done.key, open.key] }, member);
  assert.equal(sub.sprintId, sprint.id, 'subtasks follow their parent');
  assert.throws(() => store.updateSprint(sprint.id, { state: 'active' }, admin, { partial: true }), /start date and an end date/);
  store.updateSprint(sprint.id, { state: 'active', ...dates }, admin, { partial: true });
  assert.equal(sprint.state, 'active');

  for (const id of ['21', '41']) store.transitionIssue(done.key, { id }, admin);
  clock = new Date('2026-11-04T09:00:00Z');
  store.updateSprint(sprint.id, { state: 'closed' }, admin, { partial: true });
  assert.equal(sprint.completeDate, '2026-11-04T09:00:00.000Z');
  assert.equal(done.sprintId, sprint.id, 'finished work stays in the closed sprint');
  assert.equal(open.sprintId, null, 'unfinished work returns to the backlog');
  assert.deepEqual(open.closedSprintIds, [sprint.id]);
  assert.deepEqual(store.backlogIssues(1).map(i => i.key), [open.key]);
  assert.deepEqual(store.sprintIssues(sprint.id).map(i => i.key), [done.key, open.key, sub.key]);

  store.updateSprint(sprint.id, { name: '회고 완료', state: 'active', endDate: '2027-01-01' }, admin, { partial: true });
  assert.equal(sprint.name, '회고 완료');
  assert.equal(sprint.state, 'closed', 'closed sprints ignore everything but name and goal');
  assert.equal(sprint.endDate, dates.endDate);
  const next = store.createSprint({ name: 'OS 스프린트 2', originBoardId: 1 }, admin);
  assert.throws(() => store.updateSprint(next.id, { state: 'closed' }, admin, { partial: true }), /future sprint cannot change to closed/);
  assert.throws(() => store.moveToSprint(sprint.id, { issues: [open.key] }, admin), /future or active/);
});

test('only one sprint can be active and only future sprints can be deleted', () => {
  const store = createStore();
  const first = store.createSprint({ name: 'A', originBoardId: 1, ...dates }, admin);
  const second = store.createSprint({ name: 'B', originBoardId: 1, ...dates }, admin);
  store.updateSprint(first.id, { state: 'active' }, admin, { partial: true });
  assert.throws(() => store.updateSprint(second.id, { state: 'active' }, admin, { partial: true }), /already active/);
  assert.throws(() => store.deleteSprint(first.id, admin), /Only future/);
  const issue = make(store);
  store.moveToSprint(second.id, { issues: [issue.key] }, admin);
  store.deleteSprint(second.id, admin);
  assert.equal(issue.sprintId, null);
});

test('PUT is a full update: missing name is rejected', () => {
  const store = createStore();
  const sprint = store.createSprint({ name: 'A', originBoardId: 1 }, admin);
  assert.throws(() => store.updateSprint(sprint.id, { goal: 'x' }, admin, { partial: false }), /name is required/);
});

test('epics and subtasks cannot be scheduled directly; members cannot manage sprints', () => {
  const store = createStore();
  const epic = make(store, { issuetype: { name: 'Epic' } });
  const story = make(store, { parent: { key: epic.key } });
  const sub = make(store, { issuetype: { name: 'Subtask' }, parent: { key: story.key } });
  const sprint = store.createSprint({ name: 'A', originBoardId: 1 }, admin);
  assert.throws(() => store.moveToSprint(sprint.id, { issues: [epic.key] }, admin), /epic/);
  assert.throws(() => store.moveToSprint(sprint.id, { issues: [sub.key] }, admin), /subtask/);
  assert.throws(() => store.createSprint({ name: 'B', originBoardId: 1 }, member), error => error.status === 403);
  assert.throws(() => store.createSprint({ name: 'B', originBoardId: 9 }, admin), error => error.status === 404);
});

test('JQL understands sprint, openSprints() and closedSprints()', () => {
  const store = createStore();
  const a = make(store);
  const b = make(store);
  make(store);
  const sprint = store.createSprint({ name: 'Alpha', originBoardId: 1, ...dates }, admin);
  store.moveToSprint(sprint.id, { issues: [a.key, b.key] }, admin);
  const keys = jql => store.search({ jql }).issues.map(i => i.key);
  assert.deepEqual(keys('sprint in openSprints()'), ['OS-1', 'OS-2']);
  assert.deepEqual(keys('sprint = Alpha'), ['OS-1', 'OS-2']);
  assert.deepEqual(keys(`sprint = ${sprint.id}`), ['OS-1', 'OS-2']);
  assert.deepEqual(keys('sprint is EMPTY'), ['OS-3']);
  store.updateSprint(sprint.id, { state: 'active' }, admin, { partial: true });
  store.updateSprint(sprint.id, { state: 'closed' }, admin, { partial: true });
  assert.deepEqual(keys('sprint in closedSprints()'), ['OS-1', 'OS-2']);
  assert.deepEqual(keys('sprint in openSprints()'), []);
});

test('moving with rankAfterIssue schedules and ranks together', () => {
  const store = createStore();
  make(store); make(store); make(store);
  store.moveToBacklog(1, { issues: ['OS-1'], rankAfterIssue: 'OS-3' }, admin);
  assert.deepEqual(order(store), ['OS-2', 'OS-3', 'OS-1']);
});
