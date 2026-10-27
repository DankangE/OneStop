import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createStore } from '../lib/store.js';
import { hashPassword, passwordMatches } from '../lib/access.js';
import { sharedSetupCode } from '../lib/session.js';
import { createAppServer } from '../server.mjs';

const json = { 'Content-Type': 'application/json' };

async function serve(store, options = {}) {
  const server = createAppServer(store, { auth: 'login', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, cookie, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : json), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { server, base, call, close: () => new Promise(resolve => server.close(resolve)) };
}

const statusWithHost = (base, path, host, headers = {}) => new Promise((resolve, reject) => {
  const target = new URL(path, base);
  request({ hostname: target.hostname, port: target.port, path: target.pathname, headers: { ...headers, Host: host } }, response => {
    response.resume();
    resolve(response.statusCode);
  }).on('error', reject).end();
});

const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

test('passwords are hashed with a salt and verified', () => {
  const one = hashPassword('correct horse');
  assert.match(one, /^scrypt\$/);
  assert.notEqual(one, hashPassword('correct horse'));
  assert.ok(passwordMatches('correct horse', one));
  assert.ok(!passwordMatches('correct horsf', one));
  assert.ok(!passwordMatches('x', undefined));
});

test('one Vercel deployment shares a single setup code', () => {
  const env = { VERCEL: '1', VERCEL_DEPLOYMENT_ID: 'dpl_same' };
  const code = sharedSetupCode(env);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(sharedSetupCode(env), code);
  assert.notEqual(sharedSetupCode({ VERCEL: '1', VERCEL_DEPLOYMENT_ID: 'dpl_other' }), code);
  assert.equal(sharedSetupCode({}), null);
  const first = createAppServer(createStore(), { auth: 'login', env });
  const second = createAppServer(createStore(), { auth: 'login', env });
  assert.equal(first.setupCode, code);
  assert.equal(second.setupCode, code);
});

test('first setup needs the console code and a site administrator', async () => {
  const store = createStore();
  const app = await serve(store);
  try {
    assert.match(app.server.setupCode, /^[A-Z2-9]{8}$/);
    assert.equal((await app.call('GET', '/rest/api/3/myself')).status, 401);
    const status = await (await app.call('GET', '/rest/tracker/1/session')).json();
    assert.deepEqual([status.authenticated, status.setupRequired], [false, true]);

    const wrongCode = await app.call('POST', '/rest/tracker/1/setup', { body: { setupCode: 'NOPE', email: 'haneul@onestop.local', password: 'longenough' } });
    assert.equal(wrongCode.status, 403);
    const notAdmin = await app.call('POST', '/rest/tracker/1/setup', { body: { setupCode: app.server.setupCode, email: 'doyun@onestop.local', password: 'longenough' } });
    assert.equal(notAdmin.status, 400);
    const short = await app.call('POST', '/rest/tracker/1/setup', { body: { setupCode: app.server.setupCode, email: 'haneul@onestop.local', password: 'short' } });
    assert.equal(short.status, 400);

    const done = await app.call('POST', '/rest/tracker/1/setup', { body: { setupCode: app.server.setupCode.toLowerCase(), email: 'haneul@onestop.local', password: 'longenough' } });
    assert.equal(done.status, 201);
    assert.match(done.headers.get('set-cookie'), /tracker_session=.+; Path=\/; HttpOnly; SameSite=Strict/);
    assert.equal(app.server.setupCode, null);
    const me = await (await app.call('GET', '/rest/api/3/myself', { cookie: cookieOf(done) })).json();
    assert.equal(me.accountId, 'u-haneul');
    assert.ok(!JSON.stringify(store.state).includes('longenough'));

    const again = await app.call('POST', '/rest/tracker/1/setup', { body: { setupCode: 'ANY', email: 'haneul@onestop.local', password: 'longenough' } });
    assert.equal(again.status, 409);
  } finally {
    await app.close();
  }
});

test('login, temporary passwords, forced change and logout', async () => {
  const store = createStore();
  store.setupAdmin('haneul@onestop.local', 'admin-pass');
  const app = await serve(store);
  try {
    assert.equal(app.server.setupCode, null);
    const bad = await app.call('POST', '/rest/tracker/1/session', { body: { email: 'haneul@onestop.local', password: 'wrong-pass' } });
    assert.equal(bad.status, 401);
    const admin = cookieOf(await app.call('POST', '/rest/tracker/1/session', { body: { email: 'HANEUL@onestop.local', password: 'admin-pass' } }));
    assert.ok(admin);

    const first = await (await app.call('POST', '/rest/tracker/1/user/u-doyun/password/reset', { cookie: admin })).json();
    assert.match(first.temporaryPassword, /^[A-Za-z0-9_-]{12}$/);
    const early = cookieOf(await app.call('POST', '/rest/tracker/1/session', { body: { email: 'doyun@onestop.local', password: first.temporaryPassword } }));
    const reset = await (await app.call('POST', '/rest/tracker/1/user/u-doyun/password/reset', { cookie: admin })).json();
    assert.equal((await app.call('GET', '/rest/api/3/myself', { cookie: early })).status, 401, 'a reset ends existing sessions');
    assert.equal((await app.call('POST', '/rest/tracker/1/session', { body: { email: 'doyun@onestop.local', password: first.temporaryPassword } })).status, 401);

    const doyunLogin = await app.call('POST', '/rest/tracker/1/session', { body: { email: 'doyun@onestop.local', password: reset.temporaryPassword } });
    assert.equal((await doyunLogin.json()).mustChangePassword, true);
    const doyun = cookieOf(doyunLogin);
    assert.equal((await app.call('POST', '/rest/tracker/1/user/u-seoyeon/password/reset', { cookie: doyun })).status, 403);
    assert.equal((await app.call('GET', '/rest/api/3/project', { cookie: doyun })).status, 403);
    assert.equal((await app.call('GET', '/rest/api/3/myself', { cookie: doyun })).status, 200);

    const sameAgain = await app.call('PUT', '/rest/tracker/1/password', { cookie: doyun, body: { current: reset.temporaryPassword, next: reset.temporaryPassword } });
    assert.equal(sameAgain.status, 400);
    const changed = await app.call('PUT', '/rest/tracker/1/password', { cookie: doyun, body: { current: reset.temporaryPassword, next: 'doyun-secret' } });
    assert.equal(changed.status, 200);
    const fresh = cookieOf(changed);
    assert.equal((await app.call('GET', '/rest/api/3/project', { cookie: doyun })).status, 401);
    assert.equal((await app.call('GET', '/rest/api/3/project', { cookie: fresh })).status, 200);

    assert.equal((await app.call('DELETE', '/rest/tracker/1/session', { cookie: fresh })).status, 204);
    assert.equal((await app.call('GET', '/rest/api/3/myself', { cookie: fresh })).status, 401);
  } finally {
    await app.close();
  }
});

test('the user header alone no longer picks who you are', async () => {
  const store = createStore();
  store.setupAdmin('haneul@onestop.local', 'admin-pass');
  const app = await serve(store, { automationKey: 'local-key' });
  try {
    assert.equal((await app.call('GET', '/rest/api/3/myself', { headers: { 'X-Tracker-User': 'u-haneul' } })).status, 401);
    const wrongKey = await app.call('GET', '/rest/api/3/myself', { headers: { 'X-Tracker-User': 'u-haneul', 'X-Tracker-Automation-Key': 'guess' } });
    assert.equal(wrongKey.status, 401);
    const local = await app.call('GET', '/rest/api/3/myself', { headers: { 'X-Tracker-User': 'u-seoyeon', 'X-Tracker-Automation-Key': 'local-key' } });
    assert.equal((await local.json()).accountId, 'u-seoyeon');
    const headers = { 'X-Tracker-User': 'u-seoyeon', 'X-Tracker-Automation-Key': 'local-key' };
    assert.equal(await statusWithHost(app.base, '/rest/api/3/myself', new URL(app.base).host, headers), 200);
    assert.equal(await statusWithHost(app.base, '/rest/api/3/myself', 'evil.example', headers), 401);
  } finally {
    await app.close();
  }
});

test('cross-origin and non-JSON writes are rejected', async () => {
  const store = createStore();
  const app = await serve(store, { auth: 'none' });
  try {
    const host = new URL(app.base).host;
    const crossSite = await app.call('POST', '/rest/api/3/issue', { headers: { Origin: 'https://evil.example' }, body: { fields: {} } });
    assert.equal(crossSite.status, 403);
    const sameSite = await app.call('GET', '/rest/api/3/myself', { headers: { Origin: `http://${host}` } });
    assert.equal(sameSite.status, 200);
    const form = await fetch(`${app.base}/rest/api/3/issue`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"fields":{}}' });
    assert.equal(form.status, 415);
    assert.equal(await statusWithHost(app.base, '/rest/api/3/myself', 'evil.example:7180'), 403);
  } finally {
    await app.close();
  }
});

test('login attempts are locked for a minute after five failures', () => {
  let clock = 1_000_000;
  const store = createStore({ now: () => new Date(clock) });
  store.setupAdmin('haneul@onestop.local', 'admin-pass');
  for (let i = 0; i < 5; i += 1) assert.throws(() => store.login('haneul@onestop.local', 'nope'), error => error.status === 401);
  assert.throws(() => store.login('haneul@onestop.local', 'admin-pass'), error => error.status === 429);
  clock += 61_000;
  assert.equal(store.login('haneul@onestop.local', 'admin-pass').accountId, 'u-haneul');
});
