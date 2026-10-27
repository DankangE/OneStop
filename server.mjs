import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './tracker/assets.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};
const publicFiles = new Set(['/index.html', '/styles.css', '/arcade.css', '/app.js', '/node_modules/three/build/three.core.js', '/node_modules/three/build/three.module.js']);
const jsonType = 'application/json; charset=utf-8';

export function listenOptions(env = process.env) {
  const value = env.PORT || '7175';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return { host: env.HOST || '0.0.0.0', port: Number(value) };
}

export function isPublicPath(path) {
  return publicFiles.has(path) || /^\/sim\/[a-z0-9-]+\.js$/.test(path);
}

export function createAppServer() {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Cache-Control', 'no-cache');
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'Method not allowed');
      request.resume();
      return;
    }
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      send(400, 'Bad request');
      return;
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      send(400, 'Bad request');
      return;
    }
    if (path === '/healthz') {
      send(200, '{"status":"ok"}', jsonType);
      return;
    }
    if (path === '/') path = '/index.html';
    if (!isPublicPath(path)) {
      send(404, 'Not found');
      return;
    }
    try {
      const [base, file] = await Promise.all([realpath(root), realpath(resolve(root, `.${path}`))]);
      if (!file.startsWith(base + sep)) {
        send(404, 'Not found');
        return;
      }
      const data = await readFile(file);
      send(200, data, types[extname(path)] || 'application/octet-stream');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) send(404, 'Not found');
      else {
        console.error('Asset read failed:', error.code || error.message);
        send(500, 'Internal server error');
      }
    }
  });
}

if (process.env.VERCEL) {
  process.env.TRACKER_ROOT ??= fileURLToPath(new URL('./tracker/', import.meta.url));
  process.env.TRACKER_EMBEDDED = '1';
  process.env.TRACKER_DATA ??= join(tmpdir(), 'tracker.json');
  const server = createServer(async (request, response) => {
    const { default: handle } = await import('./tracker/server.mjs');
    await handle(request, response);
  });
  server.listen(Number(process.env.PORT || 3000));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = listenOptions();
    const server = createAppServer();
    server.on('error', error => {
      console.error(`AIRFRAME could not listen on ${options.host}:${options.port}: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(options, () => {
      console.log(`AIRFRAME listening on http://${options.host}:${options.port}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        console.log(`${signal}: stopping AIRFRAME`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
