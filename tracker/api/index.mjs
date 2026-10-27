import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecret } from '../lib/session.js';

const trackerRoot = fileURLToPath(new URL('..', import.meta.url));
process.env.TRACKER_ROOT ??= trackerRoot;

const { loadStore } = await import('../lib/store.js');
const { createAppServer, authMode } = await import('../server.mjs');

export function dataFile(env = process.env) {
  if (env.TRACKER_DATA) return env.TRACKER_DATA;
  if (env.VERCEL) return join(tmpdir(), 'tracker.sqlite');
  throw new Error('TRACKER_DATA is required outside Vercel.');
}

export function inboundUrl(request) {
  const raw = request.headers?.['x-vercel-original-url'] || request.headers?.['x-forwarded-uri'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.startsWith('/')) return value;
  return request.url;
}

function restorePath(request) {
  const path = String(request.url || '').split('?')[0];
  if (path === '/api' || path === '/api/index' || path === '/api/index.mjs') request.url = inboundUrl(request);
}

let ready;

function boot() {
  ready ??= (async () => {
    const auth = authMode();
    const store = await loadStore(dataFile());
    const server = createAppServer(store, { auth, automationKey: auth === 'login' ? generateSecret() : null });
    if (server.setupCode) {
      const admins = store.users().filter(user => user.siteAdmin).map(user => user.email).join(', ');
      console.log(`First-time setup: no one has a password yet. Enter setup code ${server.setupCode} with a site administrator's email (${admins}).`);
    }
    return server;
  })();
  return ready;
}

export default async function handler(request, response) {
  restorePath(request);
  const server = await boot();
  await new Promise((resolve, reject) => {
    const finish = () => resolve();
    if (typeof response.once === 'function') response.once('finish', finish);
    else {
      const end = response.end.bind(response);
      response.end = (...args) => {
        const result = end(...args);
        finish();
        return result;
      };
    }
    try {
      server.emit('request', request, response);
    } catch (error) {
      reject(error);
    }
  });
}
