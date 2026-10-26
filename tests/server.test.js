import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createAppServer, listenOptions } from '../server.mjs';

const server = createAppServer();
let origin;
before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('default listener accepts LAN traffic on 7175; overrides are validated', () => {
  assert.deepEqual(listenOptions({}), { host: '0.0.0.0', port: 7175 });
  assert.deepEqual(listenOptions({ HOST: '127.0.0.1', PORT: '7176' }), { host: '127.0.0.1', port: 7176 });
  for (const PORT of ['abc', '0', '-1', '65536', '7175.1']) assert.throws(() => listenOptions({ PORT }), /PORT/);
});

test('game HTML, styles, modules and Three.js load with correct MIME types', async () => {
  for (const [path, type] of [
    ['/', 'text/html'], ['/index.html?v=deploy', 'text/html'], ['/styles.css', 'text/css'],
    ['/arcade.css', 'text/css'], ['/app.js', 'text/javascript'],
    ['/sim/physics.js', 'text/javascript'], ['/sim/training.js', 'text/javascript'],
    ['/sim/scene.js', 'text/javascript'], ['/sim/arcade.js', 'text/javascript'],
    ['/sim/arcade-scene.js', 'text/javascript'], ['/sim/maps.js', 'text/javascript'],
    ['/sim/arcade-flight.js', 'text/javascript'], ['/sim/arcade-input.js', 'text/javascript'],
    ['/sim/rush.js', 'text/javascript'], ['/sim/rush-scene.js', 'text/javascript'],
    ['/sim/collision.js', 'text/javascript'], ['/node_modules/three/build/three.module.js', 'text/javascript'],
    ['/node_modules/three/build/three.core.js', 'text/javascript'],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type), path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).length > 0, path);
  }
});

test('deployment files, archives and traversal paths are never public', async () => {
  for (const path of ['/server.mjs', '/package.json', '/README.md', '/.env', '/.git/config',
    '/compose.yaml', '/Dockerfile', '/tests/server.test.js', '/dist/airframe-flight-club-v0.3.0.zip',
    '/sim/../server.mjs', '/sim/%2e%2e%2fserver.mjs', '/%2e%2e/%2e%2e/etc/passwd',
    '/node_modules/three/package.json', '/node_modules/three/LICENSE',
    '/sim/%5c..%5cserver.mjs', '/sim/physics.js%00', '/sim/missing.js']) {
    const response = await rawGet(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body, 'Not found', path);
  }
});

test('health check works and HEAD returns headers without a body', async () => {
  const health = await fetch(origin + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const full = await fetch(origin + '/');
  const html = await full.text();
  const head = await fetch(origin + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));
  assert.equal(await head.text(), '');
});

test('unsupported methods and malformed URLs fail without stopping the server', async () => {
  const response = await fetch(origin + '/', { method: 'POST', body: 'ignored' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  await response.text();
  assert.equal((await rawGet('/%ZZ')).status, 400);
  assert.equal((await rawGet('/healthz')).status, 200);
});

test('removed tools and airspace endpoints return 404', async () => {
  for (const path of [
    '/pilot', '/pilot/', '/pilot/index.html', '/pilot/app.js', '/pilot/lib/mission.js',
    '/prep', '/prep/', '/prep/index.html', '/prep/app.js', '/prep/sw.js',
    '/prep/manifest.webmanifest', '/prep/lib/vworld.js',
    '/brief', '/brief/', '/brief/index.html', '/brief/app.js', '/brief/lib/weather.js',
    '/extension/manifest.json', '/extension/popup.html',
    '/prep/airspace?lat=37.5&lng=127', '/airspace?lat=37.5&lng=127'
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found', path);
  }
});
