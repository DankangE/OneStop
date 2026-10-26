import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalizeState, seedState } from '../lib/store.js';
import { createAppServer } from '../server.mjs';

const admin = 'u-haneul';
const issue = (store, key, actor, extra = {}) => store.createIssue({ fields: { project: { key }, issuetype: { name: 'Task' }, summary: `${key} work`, ...extra } }, actor);

function twoProjects() {
  const store = createStore();
  store.createProject({ key: 'WEB', name: '웹사이트', leadAccountId: 'u-doyun' }, admin);
  store.addRoleActors('WEB', 10000, { user: ['u-seoyeon'] }, 'u-doyun');
  return store;
}

test('only site admins create projects, and each project gets its own board and admins', () => {
  const store = createStore();
  assert.throws(() => store.createProject({ key: 'WEB', name: '웹', leadAccountId: 'u-doyun' }, 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.createProject({ key: 'os', name: 'x', leadAccountId: 'u-doyun' }, admin), error => error.status === 400 && 'projectKey' in error.body.errors);
  assert.throws(() => store.createProject({ key: 'OS', name: 'x', leadAccountId: 'u-doyun' }, admin), /uses this project key/);
  assert.throws(() => store.createProject({ key: 'WEB', name: 'OneStop', leadAccountId: 'u-doyun' }, admin), /already exists/);
  assert.throws(() => store.createProject({ key: 'WEB', name: '웹', leadAccountId: 'nobody' }, admin), error => 'projectLead' in error.body.errors);
  assert.throws(() => store.createProject({ key: 'WEB', name: '웹', leadAccountId: 'u-doyun', projectTypeKey: 'business' }, admin), /software/);

  const created = store.createProject({ key: 'WEB', name: '웹사이트', leadAccountId: 'u-doyun', projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-kanban-template' }, admin);
  assert.deepEqual(created.roles, { 'u-haneul': 'administrators', 'u-doyun': 'administrators' });
  const board = store.boardsFor(admin, 'WEB');
  assert.equal(board.length, 1);
  assert.equal(board[0].type, 'kanban');
  assert.equal(store.boardView(board[0], 'http://t').location.projectKey, 'WEB');
  assert.equal(issue(store, 'WEB', 'u-doyun').key, 'WEB-1', 'issue keys are numbered per project');
});

test('permissions and visibility follow the project of each issue', () => {
  const store = twoProjects();
  const web = issue(store, 'WEB', 'u-seoyeon');
  const os = issue(store, 'OS', 'u-agent');

  assert.throws(() => issue(store, 'WEB', 'u-agent'), error => error.status === 403 && /project WEB/.test(error.message));
  assert.throws(() => store.requireIssue(web.key, 'u-agent'), error => error.status === 404, 'non-members cannot see the issue');
  assert.throws(() => store.addComment(web.key, 'hi', 'u-guest'), error => error.status === 404);
  assert.equal(store.requireIssue(os.key, 'u-guest').key, os.key);

  const keys = actor => store.search({ jql: 'ORDER BY key ASC', currentUser: actor }).issues.map(i => i.key);
  assert.deepEqual(keys('u-seoyeon'), [web.key, os.key]);
  assert.deepEqual(keys('u-agent'), [os.key]);
  assert.deepEqual(store.visibleProjects('u-agent').map(p => p.key), ['OS']);
  assert.deepEqual(store.boardsFor('u-agent').map(b => b.id), [1]);

  assert.equal(store.myPermissions('u-seoyeon', { projectKey: 'WEB', keys: ['DELETE_ISSUES'] }).permissions.DELETE_ISSUES.havePermission, false);
  assert.equal(store.myPermissions('u-doyun', { projectKey: 'WEB', keys: ['DELETE_ISSUES'] }).permissions.DELETE_ISSUES.havePermission, true);
  assert.equal(store.myPermissions('u-doyun', { issueKey: os.key, keys: ['DELETE_ISSUES'] }).permissions.DELETE_ISSUES.havePermission, false);
  assert.equal(store.myPermissions('u-doyun', { keys: ['ADMINISTER'] }).permissions.ADMINISTER.havePermission, false);
  assert.equal(store.myPermissions(admin, { keys: ['ADMINISTER'] }).permissions.ADMINISTER.type, 'GLOBAL');
  assert.throws(() => store.myPermissions('u-agent', { projectKey: 'WEB' }), error => error.status === 404);
});

test('assignees, parents, ranks and sprints stay inside one project', () => {
  const store = twoProjects();
  const web = issue(store, 'WEB', 'u-doyun');
  const os = issue(store, 'OS', admin);
  assert.throws(() => store.updateIssue(web.key, { fields: { assignee: { accountId: 'u-agent' } } }, 'u-doyun'), /cannot be assigned/);
  store.updateIssue(web.key, { fields: { assignee: { accountId: 'u-seoyeon' } } }, 'u-doyun');
  assert.deepEqual(store.assignableUsers({ project: 'WEB' }, 'u-doyun').map(u => u.accountId).sort(), ['u-doyun', 'u-haneul', 'u-seoyeon']);
  assert.deepEqual(store.assignableUsers({ project: 'WEB', query: '서연' }, 'u-doyun').map(u => u.accountId), ['u-seoyeon']);

  assert.throws(() => issue(store, 'WEB', 'u-doyun', { issuetype: { name: 'Subtask' }, parent: { key: os.key } }), /same project/);
  assert.throws(() => store.rankIssues({ issues: [web.key], rankBeforeIssue: os.key }, admin), /within one project/);

  const webBoard = store.boardsFor(admin, 'WEB')[0];
  const sprint = store.createSprint({ originBoardId: webBoard.id }, 'u-doyun');
  assert.equal(sprint.name, 'WEB 스프린트 1');
  assert.throws(() => store.moveToSprint(sprint.id, { issues: [os.key] }, admin), /not in project WEB/);
  assert.throws(() => store.createSprint({ originBoardId: webBoard.id }, 'u-agent'), error => error.status === 404);
  const osSprint = store.createSprint({ originBoardId: 1 }, admin);
  const dates = { startDate: '2026-10-22T00:00:00.000Z', endDate: '2026-11-05T00:00:00.000Z' };
  store.updateSprint(osSprint.id, { state: 'active', ...dates }, admin, { partial: true });
  store.updateSprint(sprint.id, { state: 'active', ...dates }, 'u-doyun', { partial: true });
  assert.equal(sprint.state, 'active', 'each board has its own active sprint');
  store.moveToSprint(sprint.id, { issues: [web.key] }, 'u-seoyeon');
  assert.deepEqual(store.backlogIssues(1).map(i => i.key), [os.key]);
});

test('project role actors can be listed, added, moved and removed by project admins', () => {
  const store = twoProjects();
  const target = store.requireProject('WEB', 'u-doyun');
  const members = store.roleView(target, store.requireRole(10000), 'http://t');
  assert.deepEqual(members.actors.map(a => a.actorUser.accountId), ['u-seoyeon']);
  assert.equal(members.scope.project.key, 'WEB');

  assert.throws(() => store.addRoleActors('WEB', 10000, { user: ['u-agent'] }, 'u-seoyeon'), error => error.status === 403);
  store.addRoleActors('WEB', 10001, { user: ['u-seoyeon'] }, 'u-doyun');
  assert.equal(target.roles['u-seoyeon'], 'viewers', 'adding to another role moves the user');
  store.removeRoleActor('WEB', 10001, 'u-seoyeon', 'u-doyun');
  assert.equal(target.roles['u-seoyeon'], undefined);
  assert.throws(() => store.removeRoleActor('WEB', 10001, 'u-seoyeon', 'u-doyun'), error => error.status === 404);
  store.removeRoleActor('WEB', 10002, 'u-haneul', 'u-doyun');
  assert.throws(() => store.removeRoleActor('WEB', 10002, 'u-doyun', 'u-doyun'), /at least one administrator/);
  assert.throws(() => store.addRoleActors('WEB', 10000, { user: ['u-doyun'] }, 'u-doyun'), /at least one administrator/);
  assert.throws(() => store.requireRole(1), error => error.status === 404);
});

test('project admins edit details; the key stays fixed and a new lead becomes an admin', () => {
  const store = twoProjects();
  assert.throws(() => store.updateProject('WEB', { name: 'x' }, 'u-seoyeon'), error => error.status === 403);
  assert.throws(() => store.updateProject('WEB', { name: 'x' }, 'u-agent'), error => error.status === 404);
  assert.throws(() => store.updateProject('WEB', { key: 'WWW' }, 'u-doyun'), error => 'projectKey' in error.body.errors);
  assert.throws(() => store.updateProject('WEB', { name: 'OneStop' }, 'u-doyun'), /already exists/);
  assert.throws(() => store.updateProject('WEB', { url: 'ftp://x' }, 'u-doyun'), error => 'url' in error.body.errors);
  assert.throws(() => store.updateProject('WEB', { assigneeType: 'ANYONE' }, 'u-doyun'), error => 'assigneeType' in error.body.errors);
  assert.throws(() => store.updateProject('WEB', { leadAccountId: 'nobody' }, 'u-doyun'), error => 'projectLead' in error.body.errors);

  const updated = store.updateProject('WEB', { name: '웹 2.0', description: '개편', url: 'https://example.com', leadAccountId: 'u-seoyeon', assigneeType: 'PROJECT_LEAD', key: 'WEB' }, 'u-doyun');
  assert.equal(updated.name, '웹 2.0');
  assert.equal(updated.roles['u-seoyeon'], 'administrators');
  assert.equal(updated.roles['u-doyun'], 'administrators', 'the previous lead keeps their role');
  const view = store.projectView(updated, 'http://t', 'u-doyun');
  assert.equal(view.lead.accountId, 'u-seoyeon');
  assert.equal(view.url, 'https://example.com');
  assert.equal(view.properties.memberCount, 3);

  assert.equal(issue(store, 'WEB', 'u-doyun').assigneeId, 'u-seoyeon', 'PROJECT_LEAD assigns new issues to the lead');
  assert.equal(issue(store, 'WEB', 'u-doyun', { assignee: null }).assigneeId, null, 'an explicit empty assignee wins');
});

test('archived and trashed projects disappear until a site admin restores them', () => {
  const store = twoProjects();
  const web = issue(store, 'WEB', 'u-doyun');
  assert.throws(() => store.archiveProject('WEB', 'u-doyun'), error => error.status === 403, 'project admins cannot archive');
  assert.throws(() => store.archiveProject('WEB', 'u-agent'), error => error.status === 404);
  store.archiveProject('WEB', admin);
  assert.throws(() => store.archiveProject('WEB', admin), /already archived/);
  assert.throws(() => store.requireIssue(web.key, 'u-doyun'), error => error.status === 404);
  assert.throws(() => issue(store, 'WEB', 'u-doyun'), error => error.status === 403);
  assert.deepEqual(store.visibleProjects('u-doyun').map(p => p.key), ['OS']);
  assert.deepEqual(store.projectsFor('u-doyun', ['archived']).map(p => p.key), []);
  assert.deepEqual(store.projectsFor(admin, ['archived']).map(p => p.key), ['WEB']);
  assert.throws(() => store.deleteProject('WEB', {}, admin), /archived project/);

  store.restoreProject('WEB', admin);
  assert.equal(store.requireIssue(web.key, 'u-doyun').key, web.key);
  assert.throws(() => store.restoreProject('WEB', admin), /not archived/);

  store.deleteProject('WEB', {}, admin);
  assert.deepEqual(store.projectsFor(admin, ['deleted']).map(p => p.key), ['WEB']);
  assert.throws(() => store.deleteProject('WEB', {}, admin), /already in the trash/);
  assert.throws(() => store.deleteProject('OS', {}, admin), /last active project/);
  store.restoreProject('WEB', admin);
  assert.equal(store.requireProject('WEB', 'u-doyun').status, 'live');
});

test('permanent delete removes the project with its issues, board, sprints and links', () => {
  const store = twoProjects();
  const web = issue(store, 'WEB', 'u-doyun');
  const os = issue(store, 'OS', admin);
  store.createLink({ type: { name: 'Relates' }, inwardIssue: { key: os.key }, outwardIssue: { key: web.key } }, admin);
  const board = store.boardsFor(admin, 'WEB')[0];
  store.createSprint({ originBoardId: board.id }, admin);
  store.deleteProject('WEB', {}, admin);
  store.deleteProject('WEB', { enableUndo: false }, admin);
  assert.equal(store.projects().some(p => p.key === 'WEB'), false);
  assert.equal(store.state.issues.some(i => i.key === web.key), false);
  assert.equal(store.state.links.length, 0);
  assert.equal(store.state.boards.some(b => b.id === board.id), false);
  assert.equal(store.state.sprints.some(s => s.originBoardId === board.id), false);
  assert.equal(store.createProject({ key: 'WEB', name: '웹사이트', leadAccountId: 'u-doyun' }, admin).key, 'WEB', 'the key is free again');
});

test('old single-project data gets a board per project and a site admin', () => {
  const old = seedState();
  old.boards = [{ id: 1, name: 'OS 보드', type: 'scrum', projectKey: 'OS' }];
  delete old.counters.board;
  delete old.users[0].siteAdmin;
  old.projects.push({ id: '10001', key: 'RD', name: '연구', leadId: 'u-doyun', roles: { 'u-doyun': 'administrators' } });
  const state = normalizeState(old);
  assert.deepEqual(state.boards.map(b => [b.id, b.projectId]), [[1, '10000'], [2, '10001']]);
  assert.equal(state.users[0].siteAdmin, true);
  assert.equal(state.counters.board, 2);
});

test('project, role and assignable-user endpoints use the Jira shapes', async () => {
  const store = twoProjects();
  const server = createAppServer(store);
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, user = admin) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Tracker-User': user }, body: body && JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const created = await call('POST', '/rest/api/3/project', { key: 'OPS', name: '운영', leadAccountId: 'u-agent', projectTypeKey: 'software', projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template' });
    assert.equal(created.status, 201);
    assert.equal(created.body.key, 'OPS');
    assert.match(created.body.self, /\/rest\/api\/3\/project\/\d+$/);
    assert.equal((await call('POST', '/rest/api/3/project', { key: 'NO', name: 'no', leadAccountId: 'u-agent' }, 'u-agent')).status, 403);

    const list = await call('GET', '/rest/api/3/project', undefined, 'u-agent');
    assert.deepEqual(list.body.map(p => p.key), ['OS', 'OPS']);
    assert.equal(list.body[1].properties.role, 'administrators');
    const search = await call('GET', '/rest/api/3/project/search?query=웹', undefined, 'u-seoyeon');
    assert.deepEqual(search.body.values.map(p => p.key), ['WEB']);
    assert.equal((await call('GET', '/rest/api/3/project/WEB', undefined, 'u-agent')).status, 404);

    const roles = await call('GET', '/rest/api/3/project/WEB/role', undefined, 'u-seoyeon');
    assert.match(roles.body.Members, /\/project\/WEB\/role\/10000$/);
    const added = await call('POST', '/rest/api/3/project/WEB/role/10000', { user: ['u-agent'] }, 'u-doyun');
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.actors.map(a => a.displayName), ['박서연', 'Build Agent'], 'sorted by display name in Korean collation');
    assert.equal((await call('DELETE', '/rest/api/3/project/WEB/role/10000?user=u-agent', undefined, 'u-doyun')).status, 204);

    const assignable = await call('GET', '/rest/api/3/user/assignable/search?project=WEB', undefined, 'u-doyun');
    assert.deepEqual(assignable.body.map(u => u.accountId).sort(), ['u-doyun', 'u-haneul', 'u-seoyeon']);
    const boards = await call('GET', '/rest/agile/1.0/board?projectKeyOrId=WEB', undefined, 'u-doyun');
    assert.deepEqual(boards.body.values.map(b => b.location.projectKey), ['WEB']);

    const edited = await call('PUT', '/rest/api/3/project/WEB', { description: '새 설명', assigneeType: 'PROJECT_LEAD' }, 'u-doyun');
    assert.equal(edited.status, 200);
    assert.equal(edited.body.description, '새 설명');
    assert.equal((await call('POST', '/rest/api/3/project/OPS/archive')).status, 204);
    const archived = await call('GET', '/rest/api/3/project/search?status=archived');
    assert.deepEqual(archived.body.values.map(p => [p.key, p.properties.status]), [['OPS', 'archived']]);
    assert.equal((await call('GET', '/rest/api/3/project/search?status=gone')).status, 400);
    assert.equal((await call('POST', '/rest/api/3/project/OPS/restore')).body.properties.status, 'live');
    assert.equal((await call('DELETE', '/rest/api/3/project/OPS')).status, 204);
    assert.equal((await call('DELETE', '/rest/api/3/project/OPS?enableUndo=false')).status, 204);
    assert.equal((await call('GET', '/rest/api/3/project/search?status=live,archived,deleted')).body.values.some(p => p.key === 'OPS'), false);

    const perms = await call('GET', '/rest/api/3/mypermissions?projectKey=WEB&permissions=ADMINISTER_PROJECTS,BROWSE_PROJECTS', undefined, 'u-seoyeon');
    assert.equal(perms.body.permissions.ADMINISTER_PROJECTS.havePermission, false);
    assert.equal(perms.body.permissions.BROWSE_PROJECTS.havePermission, true);
  } finally {
    await new Promise(done => server.close(done));
  }
});
