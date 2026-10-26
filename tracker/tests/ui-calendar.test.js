import test from 'node:test';
import assert from 'node:assert/strict';
import { monthWeeks, monthDays, shiftMonth, issueSpan, spans, layoutRange, byPerson, busyDays, assigneeChoices, chosenIds, pickAssignees, UNASSIGNED } from '../public/calendar.js';
import { moveSpan } from '../public/views.js';
import { createStore } from '../lib/store.js';

const doyun = { accountId: 'u-doyun', displayName: '이도윤' };
const seoyeon = { accountId: 'u-seoyeon', displayName: '박서연' };
const issue = (key, startdate, duedate, assignee = null) => ({ key, fields: { startdate, duedate, assignee } });

test('month grids start on Sunday and cover every day of the month', () => {
  const weeks = monthWeeks('2026-10');
  assert.equal(weeks[0][0], '2026-09-27');
  assert.equal(weeks[0][4], '2026-10-01');
  assert.equal(weeks.at(-1).at(-1), '2026-10-31');
  assert.equal(weeks.length, 5);
  assert.equal(monthWeeks('2026-02').length, 4);
  assert.equal(monthDays('2026-02').days.length, 28);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test('an issue spans start to due, and a single date becomes one day', () => {
  assert.deepEqual(issueSpan(issue('A', '2026-10-01', '2026-10-03')), { start: '2026-10-01', end: '2026-10-03', onlyDue: false, onlyStart: false });
  assert.deepEqual(issueSpan(issue('B', null, '2026-10-05')), { start: '2026-10-05', end: '2026-10-05', onlyDue: true, onlyStart: false });
  assert.equal(issueSpan(issue('C', null, null)), null);
  assert.equal(spans([issue('C', null, null), issue('D', '2026-10-02', null)]).length, 1);
});

test('bars are cut at the range edges and stacked into lanes without overlap', () => {
  const items = spans([
    issue('OS-1', '2026-09-25', '2026-09-29'),
    issue('OS-2', '2026-09-28', '2026-10-06'),
    issue('OS-3', '2026-09-30', '2026-09-30'),
    issue('OS-4', '2026-10-01', '2026-10-01'),
    issue('OS-5', '2026-10-10', '2026-10-11')
  ]);
  const week = layoutRange(items, '2026-09-27', '2026-10-03');
  const by = Object.fromEntries(week.map(s => [s.issue.key, s]));
  assert.equal(by['OS-5'], undefined);
  assert.deepEqual([by['OS-1'].col, by['OS-1'].span, by['OS-1'].cutStart, by['OS-1'].cutEnd], [0, 3, true, false]);
  assert.deepEqual([by['OS-2'].col, by['OS-2'].span, by['OS-2'].cutEnd], [1, 6, true]);
  assert.notEqual(by['OS-1'].lane, by['OS-2'].lane);
  assert.equal(by['OS-3'].lane, by['OS-1'].lane, 'a free lane is reused');
  assert.equal(by['OS-4'].lane, by['OS-1'].lane);
});

test('people rows keep project members, add other assignees, and collect unassigned work', () => {
  const items = spans([
    issue('A', '2026-10-01', '2026-10-02', doyun),
    issue('B', '2026-10-02', '2026-10-02', { accountId: 'u-guest', displayName: '정민재' }),
    issue('C', '2026-10-02', '2026-10-04')
  ]);
  const rows = byPerson(items, [seoyeon, doyun]);
  assert.deepEqual(rows.map(r => [r.person?.displayName ?? '없음', r.items.length]), [['박서연', 0], ['이도윤', 1], ['정민재', 1], ['없음', 1]]);
  assert.deepEqual(busyDays(items, ['2026-10-01', '2026-10-02', '2026-10-03']), [1, 3, 1]);
});

test('checked assignees narrow the calendar, and an empty or foreign selection shows everyone', () => {
  const issues = [
    issue('A', '2026-10-01', null, doyun),
    issue('B', '2026-10-02', null, seoyeon),
    issue('C', '2026-10-03', null),
    issue('D', '2026-10-04', null, { accountId: 'u-agent', displayName: 'Build Agent' }),
    issue('E', '2026-10-05', null, doyun)
  ];
  const choices = assigneeChoices(issues, [seoyeon, doyun]);
  assert.deepEqual(choices.map(c => [c.id, c.count]), [['u-seoyeon', 1], ['u-doyun', 2], ['u-agent', 1], [UNASSIGNED, 1]]);
  const pick = selected => pickAssignees(issues, chosenIds(new Set(selected), choices)).map(i => i.key);
  assert.deepEqual(pick([]), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(pick(['u-doyun']), ['A', 'E']);
  assert.deepEqual(pick(['u-seoyeon', UNASSIGNED]), ['B', 'C']);
  assert.deepEqual(pick(['u-from-another-project']), ['A', 'B', 'C', 'D', 'E']);
});

test('dragging a bar keeps its length and moves the start to the drop day', () => {
  assert.deepEqual(moveSpan(issue('A', '2026-10-01', '2026-10-03'), '2026-10-10'), { startdate: '2026-10-10', duedate: '2026-10-12' });
  assert.deepEqual(moveSpan(issue('B', null, '2026-10-05'), '2026-10-01'), { startdate: null, duedate: '2026-10-01' });
  assert.deepEqual(moveSpan(issue('C', '2026-10-30', '2026-11-02'), '2026-12-31'), { startdate: '2026-12-31', duedate: '2027-01-03' });
});

test('start dates are validated, searchable and recorded like due dates', () => {
  const store = createStore();
  const created = store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: '일정', startdate: '2026-10-01', duedate: '2026-10-03' } }, 'u-haneul');
  assert.equal(store.issueView(created, 'http://t').fields.startdate, '2026-10-01');
  assert.throws(() => store.updateIssue(created.key, { fields: { startdate: '2026-10-04' } }, 'u-haneul'), error => 'startdate' in error.body.errors);
  assert.throws(() => store.updateIssue(created.key, { fields: { duedate: '2026-09-30' } }, 'u-haneul'), /on or before/);
  assert.throws(() => store.updateIssue(created.key, { fields: { startdate: '2026-13-01' } }, 'u-haneul'), /yyyy-MM-dd/);
  store.updateIssue(created.key, { fields: { startdate: '2026-10-02', duedate: '2026-10-05' } }, 'u-haneul');
  const fields = store.requireIssue(created.key).changelog.at(-1).items.map(item => item.field);
  assert.deepEqual(fields, ['startdate', 'duedate']);
  assert.equal(store.search({ jql: 'startdate >= 2026-10-02 ORDER BY startdate ASC' }, 'u-haneul').issues.length, 1);
  assert.equal(store.search({ jql: 'startdate < 2026-10-02' }, 'u-haneul').issues.length, 0);
});

test('a rejected create does not use up an issue key', () => {
  const store = createStore();
  const fields = { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: '키' };
  const first = store.createIssue({ fields }, 'u-haneul');
  assert.throws(() => store.createIssue({ fields: { ...fields, startdate: '2026-10-05', duedate: '2026-10-01' } }, 'u-haneul'));
  const next = store.createIssue({ fields }, 'u-haneul');
  assert.equal(Number(next.key.split('-')[1]), Number(first.key.split('-')[1]) + 1);
  assert.equal(Number(next.id), Number(first.id) + 1);
});
