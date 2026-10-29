import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const cookieName = 'tracker_session';
const ttlMs = 7 * 24 * 60 * 60 * 1000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = token => createHash('sha256').update(token).digest('hex');

const signBody = (body, key) => `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;

const readSigned = (token, key) => {
  if (!token || !key) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
};

export function createSessions(store, { now = () => Date.now(), key = null } = {}) {
  const sessions = new Map();
  if (key) {
    return {
      open(accountId) {
        const body = Buffer.from(JSON.stringify({ a: accountId, v: store.accountState(accountId).sessionVersion, e: now() + ttlMs })).toString('base64url');
        return signBody(body, key);
      },
      find(token) {
        const payload = readSigned(token, key);
        if (!payload || payload.e <= now()) return null;
        const state = store.accountState(payload.a);
        if (!state || state.sessionVersion !== payload.v) return null;
        return payload.a;
      },
      close() {}
    };
  }
  return {
    open(accountId) {
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), { accountId, version: store.accountState(accountId).sessionVersion, expires: now() + ttlMs });
      return token;
    },
    find(token) {
      if (!token) return null;
      const id = digest(token);
      const entry = sessions.get(id);
      if (!entry) return null;
      if (entry.expires <= now() || store.accountState(entry.accountId)?.sessionVersion !== entry.version) {
        sessions.delete(id);
        return null;
      }
      entry.expires = now() + ttlMs;
      return entry.accountId;
    },
    close(token) {
      if (token) sessions.delete(digest(token));
    }
  };
}

export function readCookie(request, name = cookieName) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

const secure = request => request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';

export function sessionCookie(request, token) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlMs / 1000}${secure(request) ? '; Secure' : ''}`;
}

export function clearedCookie(request) {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(request) ? '; Secure' : ''}`;
}

export function hostIsLoopback(request) {
  try {
    return loopbackHosts.has(new URL(`http://${request.headers.host}`).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

export function fromLoopback(request) {
  return loopbackAddresses.has(request.socket.remoteAddress) && hostIsLoopback(request);
}

export function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function secretMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(digest(given));
  const b = Buffer.from(digest(expected));
  return timingSafeEqual(a, b);
}

export const generateSecret = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function deploymentSeed(env = process.env) {
  if (!env.VERCEL) return null;
  return env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || env.VERCEL_GIT_COMMIT_SHA || null;
}

export const vaultName = 'tracker_vault';

export function vaultCookie(request, owner, key) {
  const body = Buffer.from(JSON.stringify({
    a: owner.accountId,
    h: owner.passwordHash,
    v: owner.sessionVersion ?? 0
  })).toString('base64url');
  return `${vaultName}=${signBody(body, key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlMs / 1000}${secure(request) ? '; Secure' : ''}`;
}

export function readVault(token, key) {
  const saved = readSigned(token, key);
  if (!saved?.a || !saved.h) return null;
  return { accountId: saved.a, passwordHash: saved.h, sessionVersion: saved.v ?? 0 };
}
