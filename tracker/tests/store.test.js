import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, loadStore, ApiError } from '../lib/store.js';

const actor = 'u-haneul';
const make = (store, fields) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: 'Work', ...fields } }, actor);

test('createIssue assigns sequential project keys and Jira defaults', () => {
  const store = createStore();
  const first = make(store, { summary: 'First' });
  const second = make(store, { summary: 'Second', priority: { name: 'High' } });
  assert.equal(first.key, 'OS-1');
  assert.equal(second.key, 'OS-2');
  assert.equal(first.statusId, '10000');
  assert.equal(first.priorityId, '3');
  assert.equal(second.priorityId, '2');
  assert.equal(first.reporterId, actor);
});

test('createIssue reports every missing required field at once', () => {
  const store = createStore();
  assert.throws(() => store.createIssue({ fields: {} }, actor), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.deepEqual(Object.keys(error.body.errors).sort(), ['issuetype', 'project', 'summary']);
    return true;
  });
});

test('hierarchy: epic > story > subtask is enforced', () => {
  const store = createStore();
  const epic = make(store, { issuetype: { name: 'Epic' } });
  const story = make(store, { issuetype: { name: 'Story' }, parent: { key: epic.key } });
  make(store, { issuetype: { name: 'Subtask' }, parent: { key: story.key } });
  assert.throws(() => make(store, { issuetype: { name: 'Subtask' } }), /must have a parent/);
  assert.throws(() => make(store, { issuetype: { name: 'Subtask' }, parent: { key: epic.key } }), /cannot be a child/);
  assert.throws(() => make(store, { issuetype: { name: 'Epic' }, parent: { key: epic.key } }), /cannot be a child/);
});

test('workflow allows only defined transitions and records the changelog', () => {
  const store = createStore();
  const issue = make(store);
  assert.throws(() => store.transitionIssue(issue.key, { id: '41' }, actor), /not valid/);
  store.transitionIssue(issue.key, { id: '21' }, actor);
  store.transitionIssue(issue.key, { id: '31' }, actor);
  store.transitionIssue(issue.key, { id: '41' }, actor);
  assert.equal(issue.statusId, '10003');
  assert.equal(issue.resolution, 'Done');
  assert.ok(issue.resolutiondate);
  store.transitionIssue(issue.key, { id: '51' }, actor);
  assert.equal(issue.resolution, null);
  const statusChanges = issue.changelog.flatMap(entry => entry.items).filter(item => item.field === 'status');
  assert.deepEqual(statusChanges.map(item => item.toString), ['In Progress', 'In Review', 'Done', 'To Do']);
});

test('a parent cannot be done while its subtasks are open', () => {
  const store = createStore();
  const story = make(store, { issuetype: { name: 'Story' } });
  const sub = make(store, { issuetype: { name: 'Subtask' }, parent: { key: story.key } });
  store.transitionIssue(story.key, { id: '21' }, actor);
  assert.throws(() => store.transitionIssue(story.key, { id: '41' }, actor), error => error.status === 409);
  store.transitionIssue(sub.key, { id: '21' }, actor);
  store.transitionIssue(sub.key, { id: '41' }, actor);
  store.transitionIssue(story.key, { id: '41' }, actor);
  assert.equal(story.resolution, 'Done');
});

test('transition can add a comment through update.comment', () => {
  const store = createStore();
  const issue = make(store);
  store.transitionIssue(issue.key, { id: '21' }, actor, { update: { comment: [{ add: { body: 'Started.' } }] } });
  assert.equal(issue.comments.length, 1);
});

test('updateIssue records only real changes and supports label operations', () => {
  const store = createStore();
  const issue = make(store, { labels: ['api'] });
  store.updateIssue(issue.key, { fields: { summary: 'Work' } }, actor);
  assert.equal(issue.changelog.length, 0);
  store.updateIssue(issue.key, { update: { labels: [{ add: 'ui' }, { remove: 'api' }] } }, actor);
  assert.deepEqual(issue.labels, ['ui']);
  store.updateIssue(issue.key, { fields: { assignee: { accountId: 'u-doyun' } } }, actor);
  assert.deepEqual(issue.changelog.at(-1).items, [{ field: 'assignee', fromString: null, toString: '이도윤' }]);
  assert.throws(() => store.updateIssue(issue.key, { fields: { assignee: { accountId: 'ghost' } } }, actor), /does not exist/);
});

test('deleteIssue requires deleteSubtasks for parents', () => {
  const store = createStore();
  const story = make(store, { issuetype: { name: 'Story' } });
  make(store, { issuetype: { name: 'Subtask' }, parent: { key: story.key } });
  assert.throws(() => store.deleteIssue(story.key, {}, actor), /child issues/);
  store.deleteIssue(story.key, { deleteSubtasks: true }, actor);
  assert.equal(store.state.issues.length, 0);
});

test('search paginates with nextPageToken', () => {
  const store = createStore();
  for (let i = 0; i < 5; i += 1) make(store, { summary: `Item ${i}` });
  const first = store.search({ jql: 'project = OS ORDER BY key ASC', maxResults: 2 });
  assert.deepEqual(first.issues.map(i => i.key), ['OS-1', 'OS-2']);
  const second = store.search({ jql: 'project = OS ORDER BY key ASC', maxResults: 2, nextPageToken: first.nextPageToken });
  assert.deepEqual(second.issues.map(i => i.key), ['OS-3', 'OS-4']);
  assert.throws(() => store.search({ jql: 'project = ' }), /Error in the JQL Query/);
});

test('state persists to disk and reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-'));
  try {
    const file = join(dir, 'db.json');
    const store = await loadStore(file);
    make(store, { summary: 'Persist me' });
    await store.flush();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.issues[0].summary, 'Persist me');
    const reloaded = await loadStore(file);
    assert.equal(reloaded.findIssue('OS-1').summary, 'Persist me');
    assert.equal(make(reloaded).key, 'OS-2');
    await reloaded.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
