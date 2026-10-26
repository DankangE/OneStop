import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalizeState } from '../lib/store.js';
import { parseBasicAuth, hashToken } from '../lib/access.js';
import { createAppServer, authMode } from '../server.mjs';

const fields = { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: 'Work' };

test('roles grant the documented permission sets', () => {
  const store = createStore();
  const issue = store.createIssue({ fields }, 'u-doyun');
  assert.throws(() => store.createIssue({ fields }, 'u-guest'), error => error.status === 403 && /Create Issues/.test(error.message));
  assert.throws(() => store.addComment(issue.key, 'hi', 'u-guest'), error => error.status === 403);
  assert.throws(() => store.deleteIssue(issue.key, {}, 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.updateIssue(issue.key, { fields: { assignee: { accountId: 'u-doyun' } } }, 'u-guest'), /Assign Issues/);
  store.deleteIssue(issue.key, {}, 'u-haneul');

  const report = store.myPermissions('u-doyun', { projectKey: 'OS', keys: ['DELETE_ISSUES', 'EDIT_ISSUES', 'NOPE'] });
  assert.deepEqual(Object.keys(report.permissions), ['DELETE_ISSUES', 'EDIT_ISSUES']);
  assert.equal(report.permissions.DELETE_ISSUES.havePermission, false);
  assert.equal(report.permissions.EDIT_ISSUES.havePermission, true);
  assert.equal(report.permissions.EDIT_ISSUES.type, 'PROJECT');
});

test('tokens are stored hashed, shown once, and can be revoked', () => {
  const store = createStore();
  const created = store.createToken('u-doyun', 'laptop');
  assert.match(created.token, /^ost_[A-Za-z0-9_-]{32}$/);
  const stored = store.state.tokens[0];
  assert.equal(stored.hash, hashToken(created.token));
  assert.ok(!JSON.stringify(store.state).includes(created.token));
  assert.equal(store.authenticate('DOYUN@onestop.local', created.token), 'u-doyun');
  assert.equal(store.authenticate('doyun@onestop.local', `${created.token}x`), null);
  assert.equal(store.authenticate('haneul@onestop.local', created.token), null);
  assert.deepEqual(store.listTokens('u-doyun').map(t => t.label), ['laptop']);
  assert.throws(() => store.revokeToken('u-haneul', created.id), error => error.status === 404);
  store.revokeToken('u-doyun', created.id);
  assert.equal(store.authenticate('doyun@onestop.local', created.token), null);
});

test('parseBasicAuth handles colons in tokens and rejects junk', () => {
  const header = `Basic ${Buffer.from('a@b.c:tok:en').toString('base64')}`;
  assert.deepEqual(parseBasicAuth(header), { email: 'a@b.c', token: 'tok:en' });
  assert.equal(parseBasicAuth('Bearer x'), null);
  assert.equal(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`), null);
});

test('authMode defaults to password login and refuses none off loopback', () => {
  assert.equal(authMode({}), 'login');
  assert.equal(authMode({ HOST: '0.0.0.0' }), 'login');
  assert.equal(authMode({ TRACKER_AUTH: 'none' }), 'none');
  assert.equal(authMode({ HOST: '0.0.0.0', TRACKER_AUTH: 'basic' }), 'basic');
  assert.throws(() => authMode({ HOST: '0.0.0.0', TRACKER_AUTH: 'none' }), /loopback/);
  assert.throws(() => authMode({ TRACKER_AUTH: 'yes' }), /TRACKER_AUTH/);
});

test('old data files are migrated with ranks, sprints, links and roles', () => {
  const legacy = {
    counters: { issue: 10002, comment: 10000, changelog: 10000, project: { OS: 2 } },
    projects: [{ id: '10000', key: 'OS', name: 'OneStop', leadId: 'u-haneul' }],
    users: [{ accountId: 'u-haneul', displayName: '김하늘' }],
    issues: [{ id: '10002', key: 'OS-2' }, { id: '10001', key: 'OS-1' }]
  };
  const state = normalizeState(legacy);
  assert.deepEqual(state.issues.map(i => [i.key, i.rank]), [['OS-2', 2], ['OS-1', 1]]);
  assert.equal(state.users.find(u => u.accountId === 'u-haneul').email, 'haneul@onestop.local');
  assert.equal(state.projects[0].roles['u-guest'], 'viewers');
  assert.equal(state.counters.link, 10000);
  assert.deepEqual([state.sprints, state.links, state.tokens], [[], [], []]);
});

async function serve(store, options) {
  const server = createAppServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('basic auth mode requires a valid email and API token', async () => {
  const store = createStore();
  const { token } = store.createToken('u-seoyeon', 'test');
  const { server, base } = await serve(store, { auth: 'basic' });
  try {
    const info = await (await fetch(`${base}/rest/api/3/serverInfo`)).json();
    assert.equal(info.authentication, 'basic');
    const anonymous = await fetch(`${base}/rest/api/3/myself`, { headers: { 'X-Tracker-User': 'u-haneul' } });
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`${base}/rest/api/3/myself`, { headers: { Authorization: `Basic ${Buffer.from('seoyeon@onestop.local:nope').toString('base64')}` } });
    assert.equal(wrong.status, 401);
    const auth = { Authorization: `Basic ${Buffer.from(`seoyeon@onestop.local:${token}`).toString('base64')}` };
    const me = await (await fetch(`${base}/rest/api/3/myself`, { headers: auth })).json();
    assert.equal(me.accountId, 'u-seoyeon');
    assert.equal(me.emailAddress, 'seoyeon@onestop.local');
    const minted = await fetch(`${base}/rest/tracker/1/token`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"label":"ci"}' });
    assert.equal(minted.status, 201);
    const list = await (await fetch(`${base}/rest/tracker/1/token`, { headers: auth })).json();
    assert.deepEqual(list.tokens.map(t => t.label), ['test', 'ci']);
    assert.ok(list.tokens.every(t => !('hash' in t) && !('token' in t)));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('viewers can browse but get 403 on writes over HTTP', async () => {
  const store = createStore();
  const { server, base } = await serve(store, { auth: 'none' });
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Tracker-User': 'u-guest' };
    assert.equal((await fetch(`${base}/rest/api/3/search/jql`, { method: 'POST', headers, body: '{}' })).status, 200);
    const denied = await fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers, body: JSON.stringify({ fields }) });
    assert.equal(denied.status, 403);
    assert.ok((await denied.json()).errorMessages[0].includes('Create Issues'));
    const perms = await (await fetch(`${base}/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,CREATE_ISSUES`, { headers })).json();
    assert.deepEqual(Object.values(perms.permissions).map(p => p.havePermission), [true, false]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
