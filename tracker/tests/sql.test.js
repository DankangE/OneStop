import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, loadStore } from '../lib/store.js';
import { adfToText } from '../lib/adf.js';

const actor = 'u-haneul';
const make = (store, fields) => store.createIssue({ fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary: 'Work', ...fields } }, actor);

test('sqlite store reloads issues, comments, and sprints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-sql-'));
  try {
    const file = join(dir, 'tracker.sqlite');
    const store = await loadStore(file);
    const issue = make(store, { summary: 'Persist me', labels: ['sql'] });
    store.addComment(issue.key, '남겨 둔 댓글', actor);
    store.createSprint({ name: '1차', originBoardId: 1 }, actor);
    await store.flush();
    const reloaded = await loadStore(file);
    const saved = reloaded.findIssue('OS-1');
    assert.equal(saved.summary, 'Persist me');
    assert.deepEqual(saved.labels, ['sql']);
    assert.equal(adfToText(saved.comments[0].body), '남겨 둔 댓글');
    assert.equal(reloaded.state.sprints[0].name, '1차');
    assert.equal(make(reloaded).key, 'OS-2');
    await reloaded.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an Adminer edit is visible on the next read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-sql-'));
  try {
    const file = join(dir, 'tracker.sqlite');
    const store = await loadStore(file);
    make(store, { summary: 'Before' });
    await store.flush();
    const editor = new DatabaseSync(file, { timeout: 5000 });
    editor.prepare('UPDATE issues SET summary = ?, description_text = ? WHERE key = ?').run('After', '설명 수정', 'OS-1');
    editor.close();
    await store.pull();
    const issue = store.findIssue('OS-1');
    assert.equal(issue.summary, 'After');
    assert.equal(adfToText(issue.description), '설명 수정');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new sqlite file imports the sibling db.json once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-sql-'));
  try {
    const json = await loadStore(join(dir, 'db.json'));
    make(json, { summary: 'From JSON' });
    await json.flush();
    const store = await loadStore(join(dir, 'tracker.sqlite'));
    assert.equal(store.findIssue('OS-1').summary, 'From JSON');
    const editor = new DatabaseSync(join(dir, 'tracker.sqlite'), { timeout: 5000 });
    editor.prepare('UPDATE issues SET summary = ? WHERE key = ?').run('Kept', 'OS-1');
    editor.close();
    const again = await loadStore(join(dir, 'tracker.sqlite'));
    assert.equal(again.findIssue('OS-1').summary, 'Kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory stores still do not require a database file', () => {
  const store = createStore();
  assert.equal(make(store).key, 'OS-1');
});
