import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../server.mjs';
import { dataFile, inboundUrl } from '../api/index.mjs';

test('the tracker server file exports a function and does not listen', () => {
  assert.equal(typeof handler, 'function');
});

test('vercel data file stays on the explicit path', () => {
  assert.equal(dataFile({ TRACKER_DATA: '/tmp/tracker.sqlite', VERCEL: '1' }), '/tmp/tracker.sqlite');
  assert.equal(dataFile({ VERCEL: '1' }), join(tmpdir(), 'tracker.json'));
  assert.throws(() => dataFile({}), /TRACKER_DATA/);
});

test('function path restores the original request url', () => {
  assert.equal(inboundUrl({ url: '/api', headers: { 'x-forwarded-uri': '/styles.css' } }), '/styles.css');
  assert.equal(inboundUrl({ url: '/healthz', headers: {} }), '/healthz');
});

test('vercel handler answers healthz without listening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-vercel-'));
  const previous = process.env.TRACKER_DATA;
  process.env.TRACKER_DATA = join(dir, 'tracker.sqlite');
  try {
    const { default: handler } = await import('../api/index.mjs');
    const request = { method: 'GET', url: '/healthz', headers: { host: 'tracker.example' }, socket: {} };
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
    await handler(request, response);
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"status":"ok"}');
  } finally {
    if (previous === undefined) delete process.env.TRACKER_DATA;
    else process.env.TRACKER_DATA = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
