import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const cookieName = 'tracker_session';
const ttlMs = 7 * 24 * 60 * 60 * 1000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = token => createHash('sha256').update(token).digest('hex');

export function createSessions(store, { now = () => Date.now() } = {}) {
  const sessions = new Map();
  return {
    open(accountId) {
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), { accountId, version: store.accountState(accountId).sessionVersion, expires: now() + ttlMs });
      return token;
    },
    find(token) {
      if (!token) return null;
      const key = digest(token);
      const entry = sessions.get(key);
      if (!entry) return null;
      if (entry.expires <= now() || store.accountState(entry.accountId)?.sessionVersion !== entry.version) {
        sessions.delete(key);
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

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generateCode = (length = 8) => Array.from(randomBytes(length), b => codeAlphabet[b % codeAlphabet.length]).join('');

export function sharedSetupCode(env = process.env) {
  if (!env.VERCEL || !env.VERCEL_DEPLOYMENT_ID) return null;
  const digest = createHash('sha256').update(`onestop-setup:${env.VERCEL_DEPLOYMENT_ID}`).digest();
  return Array.from(digest.subarray(0, 8), byte => codeAlphabet[byte % codeAlphabet.length]).join('');
}
