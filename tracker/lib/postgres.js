import { neon } from '../vendor/neon.mjs';
import { passwordMatches } from './access.js';

const postgresUrl = /^postgres(?:ql)?:\/\//i;

export function databaseUrl(env = process.env) {
  const found = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && postgresUrl.test(value))
    .map(([key, url]) => ({ key, url, pooled: !/UNPOOLED/i.test(key) }))
    .sort((a, b) => Number(b.pooled) - Number(a.pooled) || a.key.localeCompare(b.key));
  return found[0] ?? null;
}

const text = value => {
  const raw = value == null ? '' : String(value).trim();
  return raw || null;
};

export function externalUser(row) {
  const email = text(row.email ?? row.email_address);
  const passwordHash = text(row.password_hash ?? row.password ?? row.passwd);
  if (!email || !passwordHash) return null;
  const id = row.account_id ?? row.accountid ?? row.id;
  return {
    accountId: text(row.account_id ?? row.accountid) || (id == null ? `db-${email.toLowerCase()}` : `db-${id}`),
    email,
    displayName: text(row.display_name ?? row.displayname ?? row.name) || email,
    siteAdmin: row.site_admin === true || row.site_admin === 1 || row.site_admin === '1' || row.admin === true,
    passwordHash,
    mustChangePassword: row.must_change_password === true || row.must_change_password === 1
  };
}

export function mergeDatabaseUsers(state, rows) {
  for (const row of rows ?? []) {
    const incoming = externalUser(row);
    if (!incoming) continue;
    let existing = state.users.find(user => user.email?.toLowerCase() === incoming.email.toLowerCase());
    if (!existing) {
      existing = {
        accountId: incoming.accountId,
        displayName: incoming.displayName,
        email: incoming.email,
        active: true,
        siteAdmin: incoming.siteAdmin || !state.users.some(user => user.passwordHash)
      };
      state.users.push(existing);
      const project = state.projects?.[0];
      if (project) project.roles[existing.accountId] ??= 'members';
    }
    if (incoming.displayName) existing.displayName = incoming.displayName;
    if (incoming.siteAdmin) existing.siteAdmin = true;
    const next = incoming.passwordHash;
    const hashed = existing.passwordHash?.startsWith('scrypt$');
    if (next === existing.passwordHash) continue;
    if (hashed && passwordMatches(next, existing.passwordHash)) continue;
    if (hashed && existing.mustChangePassword !== true && incoming.mustChangePassword !== true) continue;
    existing.passwordHash = next;
    existing.mustChangePassword = true;
    existing.sessionVersion = (existing.sessionVersion ?? 0) + 1;
  }
  return state;
}

export function createPostgresBackend(sql) {
  const query = (text, values) => (typeof sql.query === 'function' ? sql.query(text, values) : sql(text, values));
  return {
    async ensure() {
      await query(`CREATE TABLE IF NOT EXISTS tracker_state (
        id integer PRIMARY KEY,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    },
    async read() {
      const rows = await query('SELECT document FROM tracker_state WHERE id = 1');
      const document = rows[0]?.document;
      if (!document) return null;
      return typeof document === 'string' ? JSON.parse(document) : document;
    },
    async write(state) {
      await query(
        `INSERT INTO tracker_state (id, document, updated_at)
         VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
        [JSON.stringify(state)]
      );
    },
    async overlay(state) {
      const exists = await query(`SELECT to_regclass('public.users') AS name`);
      if (!exists[0]?.name) return;
      mergeDatabaseUsers(state, await query('SELECT * FROM users'));
    },
    async stamp() {
      const doc = await query(`SELECT md5(document::text) AS stamp FROM tracker_state WHERE id = 1`);
      const exists = await query(`SELECT to_regclass('public.users') AS name`);
      let users = '';
      if (exists[0]?.name) {
        const rows = await query(`SELECT md5(COALESCE(string_agg(users::text, ',' ORDER BY ctid), '')) AS stamp FROM users`);
        users = rows[0]?.stamp ?? '';
      }
      return `${doc[0]?.stamp ?? ''}:${users}`;
    }
  };
}

export async function connectPostgres(url) {
  return createPostgresBackend(neon(url));
}
