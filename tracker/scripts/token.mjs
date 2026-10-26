import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore } from '../lib/store.js';

const tracker = fileURLToPath(new URL('..', import.meta.url));
const file = process.env.TRACKER_DATA || join(tracker, 'data', 'tracker.sqlite');
const [command, email, ...rest] = process.argv.slice(2);
const usage = 'Usage: npm run token -- create <email> [label] | list <email> | revoke <email> <token-id>\nStop the tracker server first; it overwrites the data file with its own copy.';

try {
  const store = await loadStore(file);
  const owner = store.users().find(u => u.email?.toLowerCase() === String(email ?? '').toLowerCase());
  if (!command || !email) throw new Error(usage);
  if (!owner) throw new Error(`No user has the email ${email}. Known: ${store.users().map(u => u.email).join(', ')}`);
  if (command === 'create') {
    const created = store.createToken(owner.accountId, rest.join(' ') || 'CLI 발급');
    await store.flush();
    console.log(`Token for ${owner.displayName} (${owner.email}), id ${created.id}. It is shown only once:\n${created.token}`);
  } else if (command === 'list') {
    for (const t of store.listTokens(owner.accountId)) console.log(`${t.id}\t${t.label}\tcreated ${t.created}\tlast used ${t.lastUsed ?? 'never'}`);
  } else if (command === 'revoke') {
    store.revokeToken(owner.accountId, rest[0]);
    await store.flush();
    console.log(`Revoked token ${rest[0]}.`);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
