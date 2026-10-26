import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJql, runJql, JqlError } from '../lib/jql.js';

const issues = [
  { key: 'OS-1', status: 'To Do', assignee: 'u-a', labels: ['api'], rank: 1 },
  { key: 'OS-2', status: 'Done', assignee: null, labels: [], rank: 3 },
  { key: 'OS-3', status: 'In Progress', assignee: 'u-b', labels: ['ui', 'api'], rank: 2 }
];
const context = {
  currentUser: 'u-a',
  fieldValues: (field, issue) => ({
    status: [issue.status], assignee: issue.assignee ? [issue.assignee] : [], labels: issue.labels, key: [issue.key], summary: [`Work ${issue.key}`]
  })[field],
  sortValue: (field, issue) => ({ rank: issue.rank, key: issue.key })[field]
};
const keys = (jql) => runJql(jql, issues, context).map(issue => issue.key);

test('empty query returns every issue in input order', () => {
  assert.deepEqual(keys(''), ['OS-1', 'OS-2', 'OS-3']);
});

test('equality, inequality and IN are case-insensitive', () => {
  assert.deepEqual(keys('status = "to do"'), ['OS-1']);
  assert.deepEqual(keys('status != Done'), ['OS-1', 'OS-3']);
  assert.deepEqual(keys('status in ("To Do", Done)'), ['OS-1', 'OS-2']);
  assert.deepEqual(keys('status not in (Done)'), ['OS-1', 'OS-3']);
});

test('AND binds tighter than OR and parentheses override it', () => {
  assert.deepEqual(keys('status = Done OR labels = api AND assignee = u-b'), ['OS-2', 'OS-3']);
  assert.deepEqual(keys('(status = Done OR labels = api) AND assignee is not empty'), ['OS-1', 'OS-3']);
});

test('EMPTY, currentUser() and text contains', () => {
  assert.deepEqual(keys('assignee is EMPTY'), ['OS-2']);
  assert.deepEqual(keys('assignee = currentUser()'), ['OS-1']);
  assert.deepEqual(keys('summary ~ "os-3"'), ['OS-3']);
  assert.deepEqual(keys('NOT labels = api'), ['OS-2']);
});

test('IN accepts a bare function and custom functions resolve through the context', () => {
  const withFns = { ...context, functions: { picked: () => ['u-b'] } };
  assert.deepEqual(runJql('assignee in picked()', issues, withFns).map(i => i.key), ['OS-3']);
  assert.deepEqual(runJql('assignee in (picked(), u-a)', issues, withFns).map(i => i.key), ['OS-1', 'OS-3']);
  assert.throws(() => runJql('assignee in nothing()', issues, withFns), /Unsupported function/);
});

test('ORDER BY sorts with multiple keys', () => {
  assert.deepEqual(keys('ORDER BY rank DESC'), ['OS-2', 'OS-3', 'OS-1']);
  assert.deepEqual(keys('labels = api order by rank asc, key desc'), ['OS-1', 'OS-3']);
});

test('invalid queries raise JqlError with a useful message', () => {
  assert.throws(() => parseJql('status ='), JqlError);
  assert.throws(() => parseJql('status = "open'), /Unterminated string/);
  assert.throws(() => keys('nosuchfield = 1'), /does not exist/);
  assert.throws(() => parseJql('status = Done extra'), /Unexpected/);
});
