import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';

const admin = 'u-haneul';
const make = (store, summary) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary } }, admin);
const base = 'http://tracker.test';

test('a Blocks link shows from both sides with Jira link directions', () => {
  const store = createStore();
  const api = make(store, 'API');
  const ui = make(store, 'UI');
  store.createLink({ type: { name: 'Blocks' }, outwardIssue: { key: api.key }, inwardIssue: { key: ui.key }, comment: { body: 'UI waits for API.' } }, 'u-doyun');

  const blocker = store.issueView(api, base).fields.issuelinks;
  assert.equal(blocker.length, 1);
  assert.equal(blocker[0].type.outward, 'Blocks');
  assert.equal(blocker[0].inwardIssue.key, ui.key);

  const blocked = store.issueView(ui, base).fields.issuelinks;
  assert.equal(blocked[0].type.inward, 'Blocked by');
  assert.equal(blocked[0].outwardIssue.key, api.key);

  assert.equal(api.comments.length, 1, 'the comment goes to the outward issue');
  assert.equal(ui.changelog.at(-1).items[0].toString, 'This issue blocked by OS-1');
  const view = store.linkView(store.requireLink(blocker[0].id), base);
  assert.equal(view.outwardIssue.key, api.key);
});

test('links reject self links, duplicates, unknown types and viewers', () => {
  const store = createStore();
  const a = make(store, 'A');
  const b = make(store, 'B');
  const link = (type, from, to, actor = admin) => store.createLink({ type: { name: type }, outwardIssue: { key: from.key }, inwardIssue: { key: to.key } }, actor);
  assert.throws(() => link('Blocks', a, a), /itself/);
  link('Duplicate', a, b);
  assert.throws(() => link('Duplicate', a, b), /already duplicates/);
  link('Duplicate', b, a);
  assert.throws(() => link('Causes', a, b), /does not exist/);
  assert.throws(() => link('Relates', a, b, 'u-guest'), error => error.status === 403);
  assert.throws(() => store.createLink({ type: { name: 'Blocks' }, outwardIssue: { key: 'OS-99' }, inwardIssue: { key: a.key } }, admin), error => error.status === 404);
});

test('deleting a link or an issue removes the relationship', () => {
  const store = createStore();
  const a = make(store, 'A');
  const b = make(store, 'B');
  const c = make(store, 'C');
  const first = store.createLink({ type: { id: '1020' }, outwardIssue: { key: a.key }, inwardIssue: { key: b.key } }, admin);
  store.createLink({ type: { name: 'Blocks' }, outwardIssue: { key: c.key }, inwardIssue: { key: a.key } }, admin);
  store.deleteLink(first.id, admin);
  assert.throws(() => store.requireLink(first.id), error => error.status === 404);
  assert.equal(b.changelog.at(-1).items[0].fromString, 'This issue relates to OS-1');
  store.deleteIssue(c.key, {}, admin);
  assert.equal(store.state.links.length, 0);
  assert.deepEqual(store.issueView(a, base).fields.issuelinks, []);
});
