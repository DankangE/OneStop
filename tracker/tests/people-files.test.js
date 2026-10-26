import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, normalizeState, seedState } from '../lib/store.js';
import { createAppServer } from '../server.mjs';
import { homeSummary } from '../public/home.js';

const fields = { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: 'Work' };

async function serve(store, options = { auth: 'none' }) {
  const server = createAppServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

const upload = (base, key, files, { user = 'u-doyun', token = 'no-check' } = {}) => {
  const form = new FormData();
  for (const [name, text, type = 'text/plain'] of files) form.append('file', new Blob([text], { type }), name);
  return fetch(`${base}/rest/api/3/issue/${key}/attachments`, {
    method: 'POST',
    headers: { 'X-Tracker-User': user, ...(token ? { 'X-Atlassian-Token': token } : {}) },
    body: form
  });
};

test('site admins create users with a temporary password and can deactivate them', () => {
  const store = createStore();
  assert.throws(() => store.createUser({ emailAddress: 'new@onestop.local' }, 'u-doyun'), error => error.status === 403);
  assert.throws(() => store.createUser({ emailAddress: 'nope' }, 'u-haneul'), error => error.status === 400 && /valid email/.test(error.message));
  assert.throws(() => store.createUser({ emailAddress: 'DOYUN@onestop.local' }, 'u-haneul'), /already exists/);

  const { user, temporaryPassword } = store.createUser({ emailAddress: 'Mina@OneStop.local', displayName: '한미나' }, 'u-haneul');
  assert.match(user.accountId, /^u-[0-9a-f]{8}$/);
  assert.equal(user.email, 'mina@onestop.local');
  assert.equal(store.login('mina@onestop.local', temporaryPassword).mustChangePassword, true);
  assert.equal(store.directory('u-haneul').find(u => u.accountId === user.accountId).projects.length, 0);

  store.addRoleActors('OS', 10000, { user: [user.accountId] }, 'u-haneul');
  assert.ok(store.createIssue({ fields }, user.accountId));
  const { token } = store.createToken(user.accountId, 'ci');

  assert.throws(() => store.setUserActive('u-haneul', false, 'u-haneul'), /your own account/);
  const before = store.accountState(user.accountId).sessionVersion;
  store.setUserActive(user.accountId, false, 'u-haneul');
  assert.ok(store.accountState(user.accountId).sessionVersion > before, 'deactivation ends sessions');
  assert.throws(() => store.createIssue({ fields }, user.accountId), error => error.status === 404 || error.status === 403);
  assert.throws(() => store.login('mina@onestop.local', temporaryPassword), error => error.status === 403);
  assert.equal(store.authenticate('mina@onestop.local', token), null);
  assert.ok(!store.assignableUsers({ project: 'OS' }, 'u-haneul').some(u => u.accountId === user.accountId));
  assert.equal(store.userView(user.accountId, '').active, false);

  store.setUserActive(user.accountId, true, 'u-haneul');
  assert.equal(store.directory('u-haneul').find(u => u.accountId === user.accountId).projects[0].key, 'OS', 'roles come back');
});

test('POST /rest/api/3/user returns the Jira user shape plus a one-time password', async () => {
  const app = await serve(createStore());
  try {
    const response = await fetch(`${app.base}/rest/api/3/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tracker-User': 'u-haneul' },
      body: JSON.stringify({ emailAddress: 'jun@onestop.local', displayName: '오준', products: ['jira-software'] })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual([body.displayName, body.emailAddress, body.active], ['오준', 'jun@onestop.local', true]);
    assert.equal(typeof body.temporaryPassword, 'string');
    const directory = await (await fetch(`${app.base}/rest/tracker/1/users`, { headers: { 'X-Tracker-User': 'u-doyun' } })).json();
    assert.ok(directory.errorMessages, 'only site admins can list the directory');
  } finally {
    await app.close();
  }
});

test('attachments upload with the XSRF header, download safely, and follow permissions', async () => {
  const store = createStore();
  const issue = store.createIssue({ fields }, 'u-doyun');
  const app = await serve(store);
  try {
    assert.equal((await upload(app.base, issue.key, [['a.txt', 'hi']], { token: null })).status, 403);
    assert.equal((await upload(app.base, issue.key, [['a.txt', 'hi']], { user: 'u-guest' })).status, 403);

    const response = await upload(app.base, issue.key, [['../../notes.txt', 'hello'], ['shot.png', 'PNGDATA', 'image/png'], ['page.html', '<script>x</script>', 'text/html']]);
    assert.equal(response.status, 200);
    const added = await response.json();
    assert.deepEqual(added.map(a => a.filename), ['notes.txt', 'shot.png', 'page.html']);
    assert.equal(added[0].size, 5);
    assert.match(added[0].content, /\/rest\/api\/3\/attachment\/content\/\d+$/);

    const view = await (await fetch(`${app.base}/rest/api/3/issue/${issue.key}?expand=changelog`, { headers: { 'X-Tracker-User': 'u-guest' } })).json();
    assert.equal(view.fields.attachment.length, 3);
    assert.ok(view.changelog.histories.some(h => h.items.some(i => i.field === 'Attachment' && i.toString === 'shot.png')));

    const image = await fetch(added[1].content, { headers: { 'X-Tracker-User': 'u-guest' } });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('content-disposition'), /^inline/);
    assert.equal(await image.text(), 'PNGDATA');
    const html = await fetch(added[2].content, { headers: { 'X-Tracker-User': 'u-guest' } });
    assert.equal(html.headers.get('content-type'), 'application/octet-stream');
    assert.match(html.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''page\.html/);
    assert.match(html.headers.get('content-security-policy'), /sandbox/);

    const del = (id, user) => fetch(`${app.base}/rest/api/3/attachment/${id}`, { method: 'DELETE', headers: { 'X-Tracker-User': user } });
    assert.equal((await del(added[0].id, 'u-seoyeon')).status, 403, 'members delete only their own');
    assert.equal((await del(added[0].id, 'u-doyun')).status, 204);
    assert.equal((await del(added[1].id, 'u-haneul')).status, 204, 'admins delete any');
    assert.equal((await fetch(added[1].content, { headers: { 'X-Tracker-User': 'u-haneul' } })).status, 404);
  } finally {
    await app.close();
  }
});

test('attachment files live next to the data file and go away with their issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-'));
  try {
    const store = createStore({ file: join(dir, 'db.json') });
    const issue = store.createIssue({ fields }, 'u-doyun');
    await store.addAttachments(issue.key, [{ filename: 'a.bin', mimeType: 'application/zip', data: Buffer.from('zip') }], 'u-doyun');
    assert.deepEqual(await readdir(join(dir, 'attachments')), ['10001']);
    await assert.rejects(store.addAttachments(issue.key, [{ filename: 'big', data: Buffer.alloc(store.maxAttachment + 1) }], 'u-doyun'), error => error.status === 413);
    store.deleteIssue(issue.key, {}, 'u-haneul');
    await store.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(join(dir, 'attachments')), []);
    assert.equal(store.state.attachments.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('old data gets attachment permissions once', () => {
  const legacy = seedState();
  delete legacy.attachments;
  const state = normalizeState(legacy);
  const grants = state.projects[0].scheme.grants;
  const holders = key => grants.filter(g => g.permission === key).map(g => g.holder.parameter).sort();
  assert.deepEqual(holders('DELETE_ALL_ATTACHMENTS'), ['10002', '10003']);
  assert.deepEqual(holders('CREATE_ATTACHMENTS'), ['10000', '10002', '10003']);
  const again = normalizeState(state);
  assert.equal(again.projects[0].scheme.grants.length, grants.length);
});

test('home summary sorts my work by due date and groups projects', () => {
  const person = id => ({ accountId: id, displayName: id });
  const issue = (key, { cat = 'new', due = null, people = [], reporter = 'u-x', updated = '2026-10-01', project = 'OS', priority = 'Medium', team = null } = {}) => ({
    key,
    fields: {
      project: { key: project, name: project },
      status: { statusCategory: { key: cat } },
      duedate: due,
      assignees: people.map(person),
      team,
      reporter: person(reporter),
      priority: { name: priority },
      updated,
      resolutiondate: cat === 'done' ? `${updated}T10:00:00.000+0000` : null
    }
  });
  const issues = [
    issue('OS-1', { people: ['me'], due: '2026-10-30' }),
    issue('OS-2', { people: ['me'], due: '2026-10-20' }),
    issue('OS-3', { team: { members: [person('me')] } }),
    issue('OS-4', { reporter: 'me', due: '2026-10-25', updated: '2026-10-22' }),
    issue('MOB-1', { project: 'MOB', cat: 'done', people: ['me'], updated: '2026-10-21' })
  ];
  const summary = homeSummary(issues, 'me', '2026-10-23');
  assert.deepEqual(summary.mine.map(i => i.key), ['OS-2', 'OS-1', 'OS-3']);
  assert.deepEqual(summary.overdue.map(i => i.key), ['OS-2']);
  assert.deepEqual(summary.soon.map(i => i.key), ['OS-4', 'OS-1']);
  assert.deepEqual(summary.reported.map(i => i.key), ['OS-4']);
  assert.equal(summary.recent[0].key, 'OS-4');
  assert.deepEqual(summary.projects.map(p => [p.key, p.total, p.done, p.overdue]), [['MOB', 1, 1, 0], ['OS', 4, 0, 1]]);
  assert.equal(summary.counts.doneThisWeek, 1);
});
