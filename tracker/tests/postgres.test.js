import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrl, externalUser, mergeDatabaseUsers, createPostgresBackend } from '../lib/postgres.js';
import { createStore, seedState } from '../lib/store.js';

test('a postgres url is chosen without preferring the unpooled address', () => {
  const found = databaseUrl({
    STORAGE_URL_UNPOOLED: 'postgres://unpooled.example/db',
    STORAGE_URL: 'postgres://pooled.example/db',
    OTHER: 'https://example.test'
  });
  assert.equal(found.key, 'STORAGE_URL');
  assert.equal(databaseUrl({}), null);
});

test('a user row in the database becomes the login password', () => {
  const state = seedState();
  mergeDatabaseUsers(state, [
    { email: 'haneul@onestop.local', password_hash: 'admin123' },
    { email: 'new@onestop.local', password: 'second-pass', name: '새 사람' },
    { email: 'skip@onestop.local' }
  ]);
  const store = createStore({ state });
  const owner = store.login('haneul@onestop.local', 'admin123');
  assert.equal(owner.mustChangePassword, true);
  assert.match(owner.passwordHash, /^scrypt\$/);
  const created = store.login('new@onestop.local', 'second-pass');
  assert.equal(created.displayName, '새 사람');
  assert.equal(externalUser({ email: 'skip@onestop.local' }), null);
});

test('the same plain password is not applied again after it was hashed', () => {
  const state = seedState();
  mergeDatabaseUsers(state, [{ email: 'haneul@onestop.local', password_hash: 'admin123' }]);
  const store = createStore({ state });
  const version = store.accountState('u-haneul').sessionVersion;
  mergeDatabaseUsers(store.state, [{ email: 'haneul@onestop.local', password_hash: 'admin123' }]);
  assert.equal(store.accountState('u-haneul').sessionVersion, version);
  assert.equal(store.login('haneul@onestop.local', 'admin123').accountId, 'u-haneul');
});

test('a password the person already set is not overwritten from the database', () => {
  const state = seedState();
  mergeDatabaseUsers(state, [{ email: 'haneul@onestop.local', password_hash: 'admin123' }]);
  const store = createStore({ state });
  store.changePassword('u-haneul', 'admin123', 'own-secret');
  mergeDatabaseUsers(store.state, [{ email: 'haneul@onestop.local', password_hash: 'admin123' }]);
  assert.equal(store.accountState('u-haneul').mustChangePassword, false);
  assert.equal(store.login('haneul@onestop.local', 'own-secret').accountId, 'u-haneul');
});

test('a new temporary password in the database is used until the person changes it', () => {
  const state = seedState();
  mergeDatabaseUsers(state, [{ email: 'haneul@onestop.local', password_hash: 'admin123' }]);
  const store = createStore({ state });
  mergeDatabaseUsers(store.state, [{ email: 'haneul@onestop.local', password_hash: 'onestop!12' }]);
  const again = createStore({ state: store.state });
  const owner = again.login('haneul@onestop.local', 'onestop!12');
  assert.equal(owner.mustChangePassword, true);
});

test('a changed database password is read on the next pull', async () => {
  let document = null;
  let users = [{ email: 'haneul@onestop.local', password_hash: 'admin123' }];
  const sql = async (text, values) => {
    if (text.startsWith('CREATE')) return [];
    if (text.startsWith('SELECT document')) return document ? [{ document }] : [];
    if (text.startsWith('INSERT')) {
      document = JSON.parse(values[0]);
      return [];
    }
    if (text.includes(`to_regclass`)) return [{ name: 'users' }];
    if (text.startsWith('SELECT * FROM users')) return users;
    if (text.includes('string_agg')) return [{ stamp: JSON.stringify(users) }];
    if (text.startsWith('SELECT md5(document')) return [{ stamp: document ? 'saved' : '' }];
    throw new Error(`unexpected ${text}`);
  };
  const backend = createPostgresBackend({ query: sql });
  await backend.ensure();
  const state = seedState();
  await backend.overlay(state);
  const store = createStore({ state, backend, seen: await backend.stamp() });
  assert.equal(store.login('haneul@onestop.local', 'admin123').accountId, 'u-haneul');
  users = [{ email: 'haneul@onestop.local', password_hash: 'changed-pass' }];
  await store.pull();
  assert.equal(store.login('haneul@onestop.local', 'changed-pass').mustChangePassword, true);
});
