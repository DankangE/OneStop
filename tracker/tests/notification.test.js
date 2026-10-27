import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, loadStore, ApiError } from '../lib/store.js';

const actor = 'u-haneul';
const make = (store, fields) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: '알림 확인', ...fields } }, actor);

test('assignment and comments notify the other people, not the actor', () => {
  const store = createStore();
  const issue = make(store);
  store.updateIssue(issue.key, { fields: { assignees: [{ accountId: 'u-doyun' }, { accountId: 'u-seoyeon' }] } }, actor);
  assert.equal(store.listNotifications(actor).unread, 0);
  const doyun = store.listNotifications('u-doyun');
  assert.equal(doyun.unread, 1);
  assert.equal(doyun.notifications[0].kind, 'assigned');
  assert.match(doyun.notifications[0].text, /OS-1/);
  assert.equal(store.listNotifications('u-seoyeon').unread, 1);

  store.updateIssue(issue.key, { fields: { assignee: { accountId: actor } } }, actor);
  assert.equal(store.listNotifications(actor).unread, 0);

  store.addComment(issue.key, '확인해 주세요', 'u-seoyeon');
  const afterComment = store.listNotifications('u-doyun');
  assert.equal(afterComment.notifications.filter(item => item.kind === 'comment').length, 0);
  const reporter = store.listNotifications(actor);
  assert.equal(reporter.notifications.filter(item => item.kind === 'comment' && !item.read).length, 1);
  store.addComment(issue.key, '한 번 더', 'u-seoyeon');
  assert.equal(store.listNotifications(actor).notifications.filter(item => item.kind === 'comment').length, 1);
  assert.match(store.listNotifications(actor).notifications.find(item => item.kind === 'comment').text, /한 번 더/);
});

test('a team assignment notifies members, and reading or deleting clears the notice', () => {
  const store = createStore();
  const issue = make(store);
  const { team } = store.createTeam('OS', { name: '웹', members: ['u-seoyeon', 'u-doyun'] }, actor);
  store.updateIssue(issue.key, { fields: { team: { id: team.id } } }, actor);
  assert.equal(store.listNotifications('u-seoyeon').unread, 1);
  assert.equal(store.listNotifications('u-doyun').unread, 1);
  const id = store.listNotifications('u-doyun').notifications[0].id;
  assert.throws(() => store.markNotificationRead(id, 'u-seoyeon'), error => error instanceof ApiError && error.status === 404);
  store.markNotificationRead(id, 'u-doyun');
  assert.equal(store.listNotifications('u-doyun').unread, 0);
  store.markAllNotificationsRead('u-seoyeon');
  assert.equal(store.listNotifications('u-seoyeon').unread, 0);
  store.deleteIssue(issue.key, {}, actor);
  assert.equal(store.listNotifications('u-doyun').notifications.length, 0);
});

test('notifications survive a sqlite reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-notice-'));
  try {
    const file = join(dir, 'tracker.sqlite');
    const store = await loadStore(file);
    const issue = make(store);
    store.updateIssue(issue.key, { fields: { assignee: { accountId: 'u-doyun' } } }, actor);
    await store.flush();
    const reloaded = await loadStore(file);
    assert.equal(reloaded.listNotifications('u-doyun').unread, 1);
    assert.equal(reloaded.listNotifications('u-doyun').notifications[0].issueKey, issue.key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
