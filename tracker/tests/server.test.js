import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, listenOptions } from '../server.mjs';
import { createStore } from '../lib/store.js';

async function withServer(run) {
  const server = createAppServer(createStore());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  try {
    await run(call, base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('every module the UI imports is served', async () => {
  const { readFile } = await import('node:fs/promises');
  const pending = ['app.js'];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    for (const [, name] of source.matchAll(/from '\.\/([\w.-]+\.js)'/g)) pending.push(name);
  }
  await withServer(async (_call, base) => {
    for (const file of seen) {
      const response = await fetch(`${base}/${file}`);
      assert.equal(response.status, 200, `${file} must be listed in publicFiles`);
      assert.match(response.headers.get('content-type'), /javascript/);
    }
  });
  assert.ok(seen.has('tree.js'));
});

test('listenOptions validates the port', () => {
  assert.deepEqual(listenOptions({ PORT: '8080' }), { host: '127.0.0.1', port: 8080 });
  assert.throws(() => listenOptions({ PORT: 'abc' }), /PORT/);
});

test('create, read, transition and comment follow the Jira REST v3 shapes', async () => {
  await withServer(async call => {
    const created = await call('POST', '/rest/api/3/issue', {
      fields: { project: { key: 'OS' }, issuetype: { id: '10002' }, summary: 'Ship board', description: 'Line one\n\nLine two' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.key, 'OS-1');
    assert.match(created.body.self, /\/rest\/api\/3\/issue\/\d+$/);

    const issue = await call('GET', '/rest/api/3/issue/OS-1');
    assert.equal(issue.body.fields.status.name, 'To Do');
    assert.equal(issue.body.fields.status.statusCategory.key, 'new');
    assert.equal(issue.body.fields.description.type, 'doc');
    assert.equal(issue.body.fields.description.content.length, 2);

    const transitions = await call('GET', '/rest/api/3/issue/OS-1/transitions');
    assert.deepEqual(transitions.body.transitions.map(t => t.id), ['21']);

    const moved = await call('POST', '/rest/api/3/issue/OS-1/transitions', { transition: { id: '21' } });
    assert.equal(moved.status, 204);

    const comment = await call('POST', '/rest/api/3/issue/OS-1/comment', { body: 'Picked up' }, { 'X-Tracker-User': 'u-doyun' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.author.displayName, '이도윤');

    const expanded = await call('GET', '/rest/api/3/issue/OS-1?expand=changelog');
    assert.equal(expanded.body.changelog.histories[0].items[0].toString, 'In Progress');
  });
});

test('errors use the errorMessages/errors envelope with proper status codes', async () => {
  await withServer(async (call, base) => {
    const missing = await call('GET', '/rest/api/3/issue/OS-404');
    assert.equal(missing.status, 404);
    assert.ok(missing.body.errorMessages.length);
    const invalid = await call('POST', '/rest/api/3/issue', { fields: { project: { key: 'OS' } } });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.errors.summary);
    const badJson = await fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.deepEqual((await badJson.json()).errorMessages, ['Request body is not valid JSON.']);
    const method = await call('PATCH', '/rest/api/3/issue/OS-1');
    assert.equal(method.status, 405);
    assert.match(method.headers.get('allow'), /GET/);
    const jql = await call('POST', '/rest/api/3/search/jql', { jql: 'status = ' });
    assert.equal(jql.status, 400);
  });
});

test('search supports POST and GET with pagination', async () => {
  await withServer(async call => {
    for (const summary of ['A', 'B', 'C']) {
      await call('POST', '/rest/api/3/issue', { fields: { project: { key: 'OS' }, issuetype: { name: 'Task' }, summary } });
    }
    const page = await call('POST', '/rest/api/3/search/jql', { jql: 'project = OS ORDER BY key DESC', maxResults: 2 });
    assert.deepEqual(page.body.issues.map(i => i.key), ['OS-3', 'OS-2']);
    assert.equal(page.body.isLast, false);
    const next = await call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent('project = OS ORDER BY key DESC')}&maxResults=2&nextPageToken=${page.body.nextPageToken}`);
    assert.deepEqual(next.body.issues.map(i => i.key), ['OS-1']);
    assert.equal(next.body.isLast, true);
  });
});

test('agile and link endpoints follow the Jira Software and platform shapes', async () => {
  await withServer(async call => {
    for (const summary of ['A', 'B', 'C']) {
      await call('POST', '/rest/api/3/issue', { fields: { project: { key: 'OS' }, issuetype: { name: 'Story' }, summary } });
    }
    const boards = await call('GET', '/rest/agile/1.0/board');
    assert.equal(boards.body.values[0].id, 1);

    const sprint = await call('POST', '/rest/agile/1.0/sprint', { name: 'S1', originBoardId: 1 });
    assert.equal(sprint.status, 201);
    assert.equal(sprint.body.state, 'future');
    assert.match(sprint.body.self, /\/rest\/agile\/1\.0\/sprint\/1$/);

    assert.equal((await call('POST', '/rest/agile/1.0/sprint/1/issue', { issues: ['OS-1', 'OS-3'] })).status, 204);
    assert.equal((await call('PUT', '/rest/agile/1.0/issue/rank', { issues: ['OS-3'], rankBeforeIssue: 'OS-1' })).status, 204);
    const inSprint = await call('GET', '/rest/agile/1.0/sprint/1/issue');
    assert.deepEqual(inSprint.body.issues.map(i => i.key), ['OS-3', 'OS-1']);
    assert.equal(inSprint.body.issues[0].fields.sprint.name, 'S1');
    const backlog = await call('GET', '/rest/agile/1.0/board/1/backlog');
    assert.deepEqual(backlog.body.issues.map(i => i.key), ['OS-2']);

    const noDates = await call('POST', '/rest/agile/1.0/sprint/1', { state: 'active' });
    assert.equal(noDates.status, 400);
    const started = await call('POST', '/rest/agile/1.0/sprint/1', { state: 'active', startDate: '2026-10-21', endDate: '2026-11-04' });
    assert.equal(started.body.state, 'active');
    const active = await call('GET', '/rest/agile/1.0/board/1/sprint?state=active');
    assert.deepEqual(active.body.values.map(s => s.name), ['S1']);
    assert.equal((await call('POST', '/rest/agile/1.0/backlog/1/issue', { issues: ['OS-1'] })).status, 204);

    const link = await call('POST', '/rest/api/3/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: 'OS-2' }, inwardIssue: { key: 'OS-3' } });
    assert.equal(link.status, 201);
    assert.equal(link.body, null);
    const types = await call('GET', '/rest/api/3/issueLinkType');
    assert.deepEqual(types.body.issueLinkTypes.map(t => t.name), ['Duplicate', 'Blocks', 'Relates']);
    const linked = await call('GET', '/rest/api/3/issue/OS-3');
    const entry = linked.body.fields.issuelinks[0];
    assert.equal(entry.outwardIssue.key, 'OS-2');
    assert.equal((await call('GET', `/rest/api/3/issueLink/${entry.id}`)).body.inwardIssue.key, 'OS-3');
    assert.equal((await call('DELETE', `/rest/api/3/issueLink/${entry.id}`)).status, 204);
    assert.equal((await call('GET', `/rest/api/3/issueLink/${entry.id}`)).status, 404);
  });
});

test('static assets are served and unknown paths are not', async () => {
  await withServer(async (call, base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/../server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/lib/store.js`)).status, 404);
  });
});
