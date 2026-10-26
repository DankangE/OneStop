import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalizeState, seedState } from '../lib/store.js';
import { hasPermission } from '../lib/access.js';
import { teamIds, teamPicked, toggleTeam, assigneeChoices, peopleOf, byPerson, spans, pickAssignees, chosenIds } from '../public/calendar.js';

const task = fields => ({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: '묶음 배정', ...fields } });

test('an issue can be assigned to several people and a whole team at once', () => {
  const store = createStore();
  const { team } = store.createTeam('OS', { name: '앱', members: ['u-seoyeon', 'u-agent'] }, 'u-haneul');
  const created = store.createIssue(task({ assignees: [{ accountId: 'u-doyun' }, 'u-haneul', 'u-doyun'], team: { id: team.id } }), 'u-haneul');
  const view = store.issueView(created, 'http://t').fields;
  assert.equal(view.assignee.accountId, 'u-doyun');
  assert.deepEqual(view.assignees.map(u => u.accountId), ['u-doyun', 'u-haneul']);
  assert.equal(view.team.name, '앱');
  const found = jql => store.search({ jql }, 'u-haneul').issues.map(i => i.key);
  assert.deepEqual(found('assignee = u-agent'), [created.key], 'team members count as assignees');
  assert.deepEqual(found(`team = "앱"`), [created.key]);
  const project = store.requireProject('OS', 'u-haneul');
  assert.equal(hasPermission({ ...project, scheme: { grants: [{ permission: 'EDIT_ISSUES', holder: { type: 'assignee' } }] } }, 'u-seoyeon', 'EDIT_ISSUES', created), true);
});

test('setting the Jira assignee replaces the primary but keeps co-assignees, and clearing it unassigns everyone', () => {
  const store = createStore();
  const created = store.createIssue(task({ assignees: ['u-doyun', 'u-seoyeon', 'u-agent'] }), 'u-haneul');
  store.updateIssue(created.key, { fields: { assignee: { accountId: 'u-haneul' } } }, 'u-haneul');
  assert.deepEqual([created.assigneeId, ...created.coAssigneeIds], ['u-haneul', 'u-seoyeon', 'u-agent']);
  assert.equal(created.changelog.at(-1).items[0].field, 'assignees');
  store.updateIssue(created.key, { fields: { assignee: null } }, 'u-haneul');
  assert.deepEqual([created.assigneeId, ...created.coAssigneeIds], [null]);
  assert.throws(() => store.updateIssue(created.key, { fields: { assignees: ['u-guest'] } }, 'u-haneul'), error => 'assignees' in error.body.errors);
  assert.throws(() => store.updateIssue(created.key, { fields: { team: { id: 999 } } }, 'u-haneul'), error => 'team' in error.body.errors);
  rejects(() => store.updateIssue(created.key, { fields: { team: null } }, 'u-guest'), 403);
});

test('deleting a team unassigns it from issues and records the change', () => {
  const store = createStore();
  const { team } = store.createTeam('OS', { name: 'QA', members: ['u-doyun'] }, 'u-haneul');
  const created = store.createIssue(task({ team: { id: team.id } }), 'u-haneul');
  store.deleteTeam('OS', team.id, 'u-haneul');
  assert.equal(created.teamId, null);
  assert.deepEqual(created.changelog.at(-1).items, [{ field: 'team', fromString: 'QA', toString: null }]);
});

test('the calendar puts a team-assigned issue on every member row', () => {
  const doyun = { accountId: 'u-doyun', displayName: '이도윤' };
  const seoyeon = { accountId: 'u-seoyeon', displayName: '박서연' };
  const issue = { key: 'A', fields: { startdate: '2026-10-01', duedate: '2026-10-02', assignee: doyun, assignees: [doyun], team: { id: 1, name: '앱', members: [seoyeon, doyun] } } };
  assert.deepEqual(peopleOf(issue).map(p => p.accountId), ['u-doyun', 'u-seoyeon']);
  const rows = byPerson(spans([issue]), [seoyeon, doyun]);
  assert.deepEqual(rows.map(r => r.items.length), [1, 1]);
  const choices = assigneeChoices([issue], [seoyeon, doyun]);
  assert.deepEqual(pickAssignees([issue], chosenIds(new Set(['u-seoyeon']), choices)).map(i => i.key), ['A']);
});

const rejects = (fn, status) => assert.throws(fn, error => error.status === status);

test('administrators and deputy administrators manage teams; members and viewers cannot', () => {
  const store = createStore();
  store.addRoleActors('OS', 10003, { user: ['u-seoyeon'] }, 'u-haneul');
  const { team } = store.createTeam('OS', { name: '프론트엔드', members: ['u-doyun'] }, 'u-haneul');
  store.updateTeam('OS', team.id, { members: ['u-doyun', 'u-agent'] }, 'u-seoyeon');
  store.updateTeam('OS', team.id, { name: '웹 프론트' }, 'u-seoyeon');
  rejects(() => store.createTeam('OS', { name: '백엔드' }, 'u-doyun'), 403);
  rejects(() => store.deleteTeam('OS', team.id, 'u-guest'), 403);
  const [only] = store.teamsOf('OS', 'u-guest').teams;
  assert.deepEqual(store.teamView(store.requireProject('OS', 'u-haneul'), only, 'http://t').members.map(m => m.accountId), ['u-doyun', 'u-agent']);
  assert.equal(only.name, '웹 프론트');
  store.deleteTeam('OS', team.id, 'u-seoyeon');
  assert.equal(store.teamsOf('OS', 'u-haneul').teams.length, 0);
});

test('deputy administrators cannot change members or permissions', () => {
  const store = createStore();
  store.addRoleActors('OS', 10003, { user: ['u-seoyeon'] }, 'u-haneul');
  const project = store.requireProject('OS', 'u-haneul');
  assert.equal(hasPermission(project, 'u-seoyeon', 'MANAGE_SPRINTS_PERMISSION'), true);
  assert.equal(hasPermission(project, 'u-seoyeon', 'ADMINISTER_PROJECTS'), false);
  rejects(() => store.addRoleActors('OS', 10000, { user: ['u-guest'] }, 'u-seoyeon'), 403);
});

test('team names are unique and only project members can join', () => {
  const store = createStore();
  store.createTeam('OS', { name: 'QA' }, 'u-haneul');
  assert.throws(() => store.createTeam('OS', { name: 'qa' }, 'u-haneul'), error => 'name' in error.body.errors);
  assert.throws(() => store.createTeam('OS', { name: ' ' }, 'u-haneul'), error => 'name' in error.body.errors);
  assert.throws(() => store.createTeam('OS', { name: '외부', members: ['u-nobody'] }, 'u-haneul'), error => 'members' in error.body.errors);
  rejects(() => store.updateTeam('OS', 999, { name: 'x' }, 'u-haneul'), 404);
});

test('removing someone from the project also takes them out of its teams', () => {
  const store = createStore();
  const { team } = store.createTeam('OS', { name: '앱', members: ['u-doyun', 'u-seoyeon'] }, 'u-haneul');
  store.removeRoleActor('OS', 10000, 'u-doyun', 'u-haneul');
  assert.deepEqual(store.teamsOf('OS', 'u-haneul').teams.find(t => t.id === team.id).members, ['u-seoyeon']);
});

test('existing permission schemes gain the deputy role and team management once', () => {
  const state = seedState();
  state.projects[0].scheme = { id: 10000, grants: [{ id: 10001, permission: 'BROWSE_PROJECTS', holder: { type: 'projectRole', parameter: '10002' } }] };
  normalizeState(state);
  const grants = state.projects[0].scheme.grants;
  assert.ok(grants.some(g => g.permission === 'MANAGE_TEAMS' && g.holder.parameter === '10002'));
  assert.ok(grants.some(g => g.permission === 'MANAGE_TEAMS' && g.holder.parameter === '10003'));
  assert.ok(!grants.some(g => g.permission === 'ADMINISTER_PROJECTS' && g.holder.parameter === '10003'));
  state.projects[0].scheme.grants = grants.filter(g => g.holder.parameter !== '10003');
  normalizeState(state);
  assert.ok(!state.projects[0].scheme.grants.some(g => g.holder.parameter === '10003'), 'a revoked deputy grant is not re-added');
  assert.equal(new Set(state.projects[0].scheme.grants.map(g => g.id)).size, state.projects[0].scheme.grants.length);
});

test('a team chip selects all of its members and clears them again', () => {
  const choices = assigneeChoices([], [{ accountId: 'a', displayName: 'A' }, { accountId: 'b', displayName: 'B' }, { accountId: 'c', displayName: 'C' }]);
  const ids = teamIds({ members: [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'gone' }] }, choices);
  assert.deepEqual(ids, ['a', 'b']);
  const picked = new Set(toggleTeam(new Set(['c']), ids));
  assert.deepEqual([...picked].sort(), ['a', 'b', 'c']);
  assert.equal(teamPicked(picked, ids), true);
  assert.equal(teamPicked(new Set(['a']), ids), false);
  assert.deepEqual(toggleTeam(picked, ids), ['c']);
});
