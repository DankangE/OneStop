import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalizeState, seedState } from '../lib/store.js';
import { createAppServer } from '../server.mjs';

const admin = 'u-haneul';
const schemeId = 10000;
const grantsOf = (store, key) => store.state.projects.find(p => p.key === key).scheme.grants;
const grantFor = (store, permission, holder) => grantsOf(store, 'OS').find(g => g.permission === permission
  && g.holder.type === holder.type && g.holder.parameter === holder.parameter);
const task = (store, actor, extra = {}) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: 'work', ...extra } }, actor);

test('every project gets a scheme that reproduces the role table', () => {
  const store = createStore();
  const scheme = store.state.projects[0].scheme;
  assert.equal(scheme.id, schemeId);
  assert.ok(store.can('u-doyun', 'EDIT_OWN_COMMENTS', 'OS'));
  assert.ok(!store.can('u-doyun', 'EDIT_ALL_COMMENTS', 'OS'));
  assert.ok(!store.can('u-doyun', 'DELETE_ISSUES', 'OS'));
  assert.ok(store.can(admin, 'DELETE_ALL_COMMENTS', 'OS'));
  assert.ok(!store.can('u-guest', 'CREATE_ISSUES', 'OS'));
  const web = store.createProject({ key: 'WEB', name: '웹', leadAccountId: 'u-doyun' }, admin);
  assert.notEqual(web.scheme.id, scheme.id);
  assert.ok(web.scheme.grants.every(g => !scheme.grants.some(other => other.id === g.id)), 'grant ids are unique across schemes');
});

test('grants can target one user, the reporter, the assignee or the lead', () => {
  const store = createStore();
  const members = { type: 'projectRole', parameter: '10000' };
  store.removeGrant(schemeId, grantFor(store, 'TRANSITION_ISSUES', members).id, admin);
  store.addGrant(schemeId, { permission: 'TRANSITION_ISSUES', holder: { type: 'assignee' } }, admin);
  store.addGrant(schemeId, { permission: 'DELETE_ISSUES', holder: { type: 'reporter' } }, admin);
  store.addGrant(schemeId, { permission: 'MANAGE_SPRINTS_PERMISSION', holder: { type: 'user', value: 'u-seoyeon' } }, admin);

  const mine = task(store, 'u-doyun', { assignee: { accountId: 'u-seoyeon' } });
  assert.throws(() => store.transitionIssue(mine.key, '21', 'u-doyun'), error => error.status === 403 && /issue OS-1/.test(error.message));
  store.transitionIssue(mine.key, '21', 'u-seoyeon');
  assert.equal(store.myPermissions('u-seoyeon', { issueKey: mine.key, keys: ['TRANSITION_ISSUES'] }).permissions.TRANSITION_ISSUES.havePermission, true);
  assert.equal(store.myPermissions('u-doyun', { issueKey: mine.key, keys: ['TRANSITION_ISSUES'] }).permissions.TRANSITION_ISSUES.havePermission, false);

  assert.ok(store.can('u-seoyeon', 'MANAGE_SPRINTS_PERMISSION', 'OS'));
  assert.ok(!store.can('u-doyun', 'MANAGE_SPRINTS_PERMISSION', 'OS'));

  const other = task(store, 'u-agent');
  assert.throws(() => store.deleteIssue(other.key, {}, 'u-doyun'), error => error.status === 403);
  store.deleteIssue(mine.key, {}, 'u-doyun');
  assert.equal(store.findIssue(mine.key), null);

  store.addGrant(schemeId, { permission: 'CREATE_ISSUES', holder: { type: 'projectLead' } }, admin);
  assert.equal(grantsOf(store, 'OS').at(-1).holder.type, 'projectLead');
});

test('grants are validated and the administrators role cannot lock itself out', () => {
  const store = createStore();
  const bad = body => assert.throws(() => store.addGrant(schemeId, body, admin), error => error.status === 400);
  bad({ permission: 'ADMINISTER', holder: { type: 'user', value: 'u-doyun' } });
  bad({ permission: 'EDIT_ISSUES', holder: { type: 'group', value: 'jira-users' } });
  bad({ permission: 'EDIT_ISSUES', holder: { type: 'user', value: 'nobody' } });
  bad({ permission: 'EDIT_ISSUES', holder: { type: 'projectRole', value: '999' } });
  bad({ permission: 'BROWSE_PROJECTS', holder: { type: 'reporter' } });
  bad({ permission: 'EDIT_ISSUES', holder: { type: 'projectRole', value: '10000' } });

  const adminsBrowse = grantFor(store, 'BROWSE_PROJECTS', { type: 'projectRole', parameter: '10002' });
  assert.throws(() => store.removeGrant(schemeId, adminsBrowse.id, admin), /must keep/);
  assert.throws(() => store.removeGrant(schemeId, 1, admin), error => error.status === 404);
  assert.throws(() => store.addGrant(schemeId, { permission: 'EDIT_ISSUES', holder: { type: 'reporter' } }, 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.addGrant(99999, { permission: 'EDIT_ISSUES', holder: { type: 'reporter' } }, admin), error => error.status === 404);
});

test('own and all comment permissions decide who may edit or delete a comment', () => {
  const store = createStore();
  const issue = task(store, 'u-doyun');
  const { comment: doyuns } = store.addComment(issue.key, '이도윤 댓글', 'u-doyun');
  const { comment: seoyeons } = store.addComment(issue.key, '박서연 댓글', 'u-seoyeon');

  const { comment: edited } = store.updateComment(issue.key, doyuns.id, '고친 댓글', 'u-doyun');
  assert.equal(edited.updateAuthorId, 'u-doyun');
  assert.throws(() => store.updateComment(issue.key, seoyeons.id, '남의 댓글', 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.deleteComment(issue.key, seoyeons.id, 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.updateComment(issue.key, doyuns.id, '  ', 'u-doyun'), error => error.status === 400);
  assert.throws(() => store.updateComment(issue.key, '1', 'x', 'u-doyun'), error => error.status === 404);

  store.updateComment(issue.key, seoyeons.id, '관리자가 고침', admin);
  assert.equal(store.issueView(store.requireIssue(issue.key), 'http://t').fields.comment.comments[1].updateAuthor.accountId, admin);
  store.deleteComment(issue.key, seoyeons.id, admin);
  store.deleteComment(issue.key, doyuns.id, 'u-doyun');
  assert.equal(store.requireIssue(issue.key).comments.length, 0);
});

test('older data gets a default scheme on load', () => {
  const state = seedState();
  delete state.counters.grant;
  const normalized = normalizeState(state);
  assert.ok(normalized.projects[0].scheme.grants.length > 10);
  assert.equal(normalized.counters.grant, 10000 + normalized.projects[0].scheme.grants.length);
});

test('permission scheme and comment endpoints use the Jira shapes', async () => {
  const store = createStore();
  const issue = task(store, 'u-doyun');
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
    const assigned = await call('GET', '/rest/api/3/project/OS/permissionscheme');
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.id, schemeId);
    assert.equal(assigned.body.permissions, undefined);
    assert.equal((await call('GET', '/rest/api/3/project/OS/permissionscheme', null, 'u-doyun')).status, 403);

    const expanded = await call('GET', `/rest/api/3/permissionscheme/${schemeId}?expand=permissions`);
    const first = expanded.body.permissions[0];
    assert.deepEqual(Object.keys(first).sort(), ['holder', 'id', 'locked', 'permission', 'self']);
    assert.equal(first.holder.type, 'projectRole');
    assert.equal(first.holder.value, first.holder.parameter);

    const created = await call('POST', `/rest/api/3/permissionscheme/${schemeId}/permission`, { holder: { type: 'user', value: 'u-guest' }, permission: 'ADD_COMMENTS' });
    assert.equal(created.status, 201);
    assert.equal(created.body.holder.user.accountId, 'u-guest');
    const listed = await call('GET', `/rest/api/3/permissionscheme/${schemeId}/permission`);
    assert.ok(listed.body.permissions.some(g => g.id === created.body.id));

    const comment = await call('POST', `/rest/api/3/issue/${issue.key}/comment`, { body: '손님 댓글' }, 'u-guest');
    assert.equal(comment.status, 201);
    assert.equal((await call('DELETE', `/rest/api/3/permissionscheme/${schemeId}/permission/${created.body.id}`)).status, 204);
    assert.equal((await call('POST', `/rest/api/3/issue/${issue.key}/comment`, { body: '다시' }, 'u-guest')).status, 403);

    const updated = await call('PUT', `/rest/api/3/issue/${issue.key}/comment/${comment.body.id}`, { body: '수정' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.updateAuthor.accountId, admin);
    assert.equal((await call('DELETE', `/rest/api/3/issue/${issue.key}/comment/${comment.body.id}`)).status, 204);
  } finally {
    server.close();
  }
});
