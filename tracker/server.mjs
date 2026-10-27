import { createServer } from 'node:http';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, ApiError, issueTypes, priorities, linkTypes } from './lib/store.js';
import { statuses, statusView, availableTransitions, transitionView } from './lib/workflow.js';
import { parseBasicAuth } from './lib/access.js';
import {
  createSessions, readCookie, sessionCookie, clearedCookie, hostIsLoopback, fromLoopback, sameOrigin, secretMatches, generateSecret, generateCode
} from './lib/session.js';

const root = process.env.TRACKER_ROOT
  ? resolve(process.env.TRACKER_ROOT)
  : fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const publicFiles = new Set(['/index.html', '/styles.css', '/app.js', '/api.js', '/views.js', '/tree.js', '/calendar.js', '/home.js', '/theme.js', '/favicon.svg']);
const jsonType = 'application/json; charset=utf-8';
const maxBody = 1024 * 1024;
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
const version = '0.2.0';

export function listenOptions(env = process.env) {
  const value = env.PORT || '7180';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return { host: env.HOST || '127.0.0.1', port: Number(value) };
}

export function authMode(env = process.env) {
  const value = env.TRACKER_AUTH || 'login';
  if (!['none', 'basic', 'login'].includes(value)) throw new Error('TRACKER_AUTH must be "login", "basic" or "none".');
  if (value === 'none' && !loopback.has(env.HOST || '127.0.0.1')) {
    throw new Error('TRACKER_AUTH=none is only allowed when HOST is a loopback address.');
  }
  return value;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new ApiError(413, ['Request entity too large.']);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, ['Request body is not valid JSON.']);
  }
}

function route(method, pattern, handler, { anonymous = false } = {}) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
  return { method, regex, names, handler, anonymous };
}

const page = (values, url) => {
  const startAt = Math.max(Number(url.searchParams.get('startAt')) || 0, 0);
  const maxResults = Math.min(Math.max(Number(url.searchParams.get('maxResults')) || 50, 1), 200);
  const slice = values.slice(startAt, startAt + maxResults);
  return { maxResults, startAt, total: values.length, isLast: startAt + maxResults >= values.length, values: slice };
};

const inlineTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const attachmentPath = /^\/rest\/api\/3\/issue\/[^/]+\/attachments$/;

async function readFiles(request, perFile) {
  const type = request.headers['content-type'] || '';
  if (!/^multipart\/form-data\b/i.test(type)) throw new ApiError(415, ['Send attachments as multipart/form-data in a "file" field.']);
  const limit = perFile * 10 + 64 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, ['Request entity too large.']);
    chunks.push(chunk);
  }
  let form;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new ApiError(400, ['The multipart body could not be read.']);
  }
  const files = form.getAll('file').filter(entry => typeof entry === 'object');
  return Promise.all(files.map(async entry => ({ filename: entry.name, mimeType: entry.type, data: Buffer.from(await entry.arrayBuffer()) })));
}

export function createRoutes(store, { auth, sessions = createSessions(store), setup = { code: null } }) {
  const issuesPage = (issues, url, base, viewer) => {
    const { values, ...meta } = page(issues, url);
    return { ...meta, issues: values.map(issue => store.issueView(issue, base, { viewer })) };
  };
  const loginOnly = () => {
    if (auth !== 'login') throw new ApiError(400, ['Password sign-in is turned off on this server.']);
  };
  const signedIn = (request, owner, base, status = 200) => [status, {
    user: store.userView(owner.accountId, base, { withEmail: true }),
    mustChangePassword: owner.mustChangePassword === true
  }, { 'Set-Cookie': sessionCookie(request, sessions.open(owner.accountId)) }];
  return [
    route('GET', '/rest/tracker/1/session', ({ request, base }) => {
      if (auth !== 'login') return [200, { authentication: auth }];
      const accountId = sessions.find(readCookie(request));
      if (!accountId) return [200, { authentication: auth, authenticated: false, setupRequired: store.needsSetup() }];
      return [200, {
        authentication: auth,
        authenticated: true,
        user: store.userView(accountId, base, { withEmail: true }),
        mustChangePassword: store.accountState(accountId).mustChangePassword
      }];
    }, { anonymous: true }),
    route('POST', '/rest/tracker/1/session', async ({ request, base }) => {
      loginOnly();
      const body = await readJson(request);
      return signedIn(request, store.login(body.email, body.password), base);
    }, { anonymous: true }),
    route('DELETE', '/rest/tracker/1/session', ({ request }) => {
      sessions.close(readCookie(request));
      return [204, undefined, { 'Set-Cookie': clearedCookie(request) }];
    }, { anonymous: true }),
    route('POST', '/rest/tracker/1/setup', async ({ request, base }) => {
      loginOnly();
      const body = await readJson(request);
      if (!store.needsSetup()) throw new ApiError(409, ['Setup is already complete. Sign in instead.']);
      if (!secretMatches(String(body.setupCode ?? '').trim().toUpperCase(), setup.code)) {
        throw new ApiError(403, [], { setupCode: 'The setup code is incorrect. Check the server console.' });
      }
      const owner = store.setupAdmin(body.email, body.password);
      setup.code = null;
      return signedIn(request, owner, base, 201);
    }, { anonymous: true }),
    route('PUT', '/rest/tracker/1/password', async ({ request, actor, via, base }) => {
      const body = await readJson(request);
      const owner = store.changePassword(actor, body.current, body.next);
      if (via !== 'session') return [204];
      sessions.close(readCookie(request));
      return signedIn(request, owner, base);
    }),
    route('POST', '/rest/tracker/1/user/{accountId}/password/reset', ({ params, actor }) => (
      [200, { temporaryPassword: store.resetPassword(params.accountId, actor) }]
    )),
    route('GET', '/rest/tracker/1/notification', ({ actor, base }) => [200, store.listNotifications(actor, base)]),
    route('POST', '/rest/tracker/1/notification/read', ({ actor }) => { store.markAllNotificationsRead(actor); return [204]; }),
    route('POST', '/rest/tracker/1/notification/{id}/read', ({ params, actor }) => { store.markNotificationRead(params.id, actor); return [204]; }),
    route('GET', '/rest/tracker/1/users', ({ actor }) => [200, { users: store.directory(actor) }]),
    route('PUT', '/rest/api/3/issue/archive', async ({ request, actor }) => [200, store.archiveIssues(await readJson(request), actor)]),
    route('PUT', '/rest/api/3/issue/unarchive', async ({ request, actor }) => [200, store.unarchiveIssues(await readJson(request), actor)]),
    route('GET', '/rest/tracker/1/project/{key}/archived', ({ params, actor, base }) => [200, {
      issues: store.archivedIssues(params.key, actor).map(issue => store.issueView(issue, base, { viewer: actor }))
    }]),
    route('PUT', '/rest/tracker/1/user/{accountId}/active', async ({ request, params, actor, base }) => {
      const target = store.setUserActive(params.accountId, (await readJson(request)).active, actor);
      return [200, store.userView(target.accountId, base, { withEmail: true })];
    }),
    route('POST', '/rest/api/3/user', async ({ request, actor, base }) => {
      const { user, temporaryPassword } = store.createUser(await readJson(request), actor);
      return [201, { ...store.userView(user.accountId, base, { withEmail: true }), temporaryPassword }];
    }),
    route('POST', '/rest/api/3/issue/{key}/attachments', async ({ request, params, actor, base }) => {
      const added = await store.addAttachments(params.key, await readFiles(request, store.maxAttachment), actor);
      return [200, added.map(a => store.attachmentView(a, base))];
    }),
    route('GET', '/rest/api/3/attachment/{id}', ({ params, actor, base }) => (
      [200, store.attachmentView(store.requireAttachment(params.id, actor).attachment, base)]
    )),
    route('DELETE', '/rest/api/3/attachment/{id}', async ({ params, actor }) => {
      await store.deleteAttachment(params.id, actor);
      return [204];
    }),
    route('GET', '/rest/api/3/attachment/content/{id}', async ({ params, actor }) => {
      const { attachment, bytes } = await store.attachmentContent(params.id, actor);
      const inline = inlineTypes.has(attachment.mimeType);
      return [200, bytes, {
        'Content-Type': inline ? attachment.mimeType : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'",
        'Cache-Control': 'private, no-cache'
      }];
    }),
    route('GET', '/rest/api/3/serverInfo', ({ base }) => [200, {
      baseUrl: base, version, deploymentType: 'Local', serverTitle: 'OneStop 트래커', authentication: auth
    }], { anonymous: true }),
    route('GET', '/rest/api/3/myself', ({ actor, base }) => [200, store.userView(actor, base, { withEmail: true })]),
    route('GET', '/rest/api/3/mypermissions', ({ actor, url }) => {
      const keys = url.searchParams.get('permissions')?.split(',').map(k => k.trim()).filter(Boolean);
      return [200, store.myPermissions(actor, {
        projectKey: url.searchParams.get('projectKey') || url.searchParams.get('projectId') || undefined,
        issueKey: url.searchParams.get('issueKey') || url.searchParams.get('issueId') || undefined,
        keys: keys?.length ? keys : undefined
      })];
    }),
    route('GET', '/rest/api/3/users/search', ({ base }) => [200, store.users().map(u => store.userView(u.accountId, base))]),
    route('GET', '/rest/api/3/user/assignable/search', ({ url, actor, base }) => [200, store.assignableUsers({
      project: url.searchParams.get('project') || undefined,
      issueKey: url.searchParams.get('issueKey') || url.searchParams.get('issueId') || undefined,
      query: url.searchParams.get('query') || ''
    }, actor).map(u => store.userView(u.accountId, base))]),
    route('GET', '/rest/api/3/project', ({ actor, base }) => [200, store.visibleProjects(actor).map(p => store.projectView(p, base, actor))]),
    route('GET', '/rest/api/3/project/search', ({ actor, url, base }) => {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const statuses = (url.searchParams.get('status') || 'live').split(',').map(s => s.trim()).filter(Boolean);
      const unknown = statuses.find(s => !['live', 'archived', 'deleted'].includes(s));
      if (unknown) throw new ApiError(400, [`Invalid project status '${unknown}'. Use live, archived or deleted.`]);
      const found = store.projectsFor(actor, statuses).filter(p => !query || p.key.toLowerCase().includes(query) || p.name.toLowerCase().includes(query));
      return [200, page(found.map(p => store.projectView(p, base, actor)), url)];
    }),
    route('POST', '/rest/api/3/project', async ({ request, actor, base }) => {
      const created = store.createProject(await readJson(request), actor);
      return [201, { id: Number(created.id), key: created.key, self: `${base}/rest/api/3/project/${created.id}` }];
    }),
    route('GET', '/rest/api/3/project/{key}', ({ params, actor, base }) => [200, store.projectView(store.requireProject(params.key, actor), base, actor)]),
    route('PUT', '/rest/api/3/project/{key}', async ({ request, params, actor, base }) => [200, store.projectView(store.updateProject(params.key, await readJson(request), actor), base, actor)]),
    route('DELETE', '/rest/api/3/project/{key}', ({ params, url, actor }) => {
      store.deleteProject(params.key, { enableUndo: url.searchParams.get('enableUndo') !== 'false' }, actor);
      return [204];
    }),
    route('POST', '/rest/api/3/project/{key}/archive', ({ params, actor }) => {
      store.archiveProject(params.key, actor);
      return [204];
    }),
    route('POST', '/rest/api/3/project/{key}/restore', ({ params, actor, base }) => [200, store.projectView(store.restoreProject(params.key, actor), base, actor)]),
    route('GET', '/rest/api/3/project/{key}/permissionscheme', ({ params, actor, base }) => [200, store.schemeView(store.schemeProject(params.key, actor), base)]),
    route('GET', '/rest/api/3/permissionscheme/{id}', ({ params, url, actor, base }) => {
      const expand = (url.searchParams.get('expand') || '').split(',').map(s => s.trim());
      const target = store.requireScheme(params.id, actor);
      return [200, store.schemeView(target, base, { expand: expand.includes('permissions') || expand.includes('all') })];
    }),
    route('GET', '/rest/api/3/permissionscheme/{id}/permission', ({ params, actor, base }) => {
      const target = store.requireScheme(params.id, actor);
      return [200, { expand: 'user,projectRole,all', permissions: target.scheme.grants.map(g => store.grantView(g, base)) }];
    }),
    route('POST', '/rest/api/3/permissionscheme/{id}/permission', async ({ request, params, actor, base }) => {
      const { grant } = store.addGrant(params.id, await readJson(request), actor);
      return [201, store.grantView(grant, base)];
    }),
    route('DELETE', '/rest/api/3/permissionscheme/{id}/permission/{grantId}', ({ params, actor }) => {
      store.removeGrant(params.id, params.grantId, actor);
      return [204];
    }),
    route('GET', '/rest/api/3/project/{key}/role', ({ params, actor, base }) => {
      const target = store.requireProject(params.key, actor);
      return [200, Object.fromEntries(store.projectRoles().map(role => [role.name, `${base}/rest/api/3/project/${target.key}/role/${role.id}`]))];
    }),
    route('GET', '/rest/api/3/project/{key}/role/{id}', ({ params, actor, base }) => {
      const target = store.requireProject(params.key, actor);
      return [200, store.roleView(target, store.requireRole(params.id), base)];
    }),
    route('POST', '/rest/api/3/project/{key}/role/{id}', async ({ request, params, actor, base }) => {
      const { target, role } = store.addRoleActors(params.key, params.id, await readJson(request), actor);
      return [200, store.roleView(target, role, base)];
    }),
    route('DELETE', '/rest/api/3/project/{key}/role/{id}', ({ params, url, actor }) => {
      store.removeRoleActor(params.key, params.id, url.searchParams.get('user'), actor);
      return [204];
    }),
    route('GET', '/rest/api/3/project/{key}/team', ({ params, actor, base }) => {
      const { target, teams } = store.teamsOf(params.key, actor);
      return [200, teams.map(team => store.teamView(target, team, base))];
    }),
    route('POST', '/rest/api/3/project/{key}/team', async ({ request, params, actor, base }) => {
      const { target, team } = store.createTeam(params.key, await readJson(request), actor);
      return [201, store.teamView(target, team, base)];
    }),
    route('PUT', '/rest/api/3/project/{key}/team/{id}', async ({ request, params, actor, base }) => {
      const { target, team } = store.updateTeam(params.key, params.id, await readJson(request), actor);
      return [200, store.teamView(target, team, base)];
    }),
    route('DELETE', '/rest/api/3/project/{key}/team/{id}', ({ params, actor }) => {
      store.deleteTeam(params.key, params.id, actor);
      return [204];
    }),
    route('GET', '/rest/api/3/issuetype', ({ base }) => [200, issueTypes.map(t => store.issueTypeView(t, base))]),
    route('GET', '/rest/api/3/priority', ({ base }) => [200, priorities.map(p => ({ ...p, self: `${base}/rest/api/3/priority/${p.id}` }))]),
    route('GET', '/rest/api/3/status', ({ base }) => [200, statuses.map(s => statusView(s, base))]),
    route('POST', '/rest/api/3/issue', async ({ request, actor, base }) => {
      const issue = store.createIssue(await readJson(request), actor);
      return [201, { id: issue.id, key: issue.key, self: `${base}/rest/api/3/issue/${issue.id}` }];
    }),
    route('GET', '/rest/api/3/issue/{key}', ({ params, url, actor, base }) => {
      const expand = (url.searchParams.get('expand') || '').split(',').map(s => s.trim()).filter(Boolean);
      return [200, store.issueView(store.requireIssue(params.key, actor), base, { expand, viewer: actor })];
    }),
    route('PUT', '/rest/api/3/issue/{key}', async ({ request, params, actor }) => {
      store.updateIssue(params.key, await readJson(request), actor);
      return [204];
    }),
    route('DELETE', '/rest/api/3/issue/{key}', ({ params, url, actor }) => {
      store.deleteIssue(params.key, { deleteSubtasks: url.searchParams.get('deleteSubtasks') === 'true' }, actor);
      return [204];
    }),
    route('GET', '/rest/api/3/issue/{key}/transitions', ({ params, actor, base }) => {
      const issue = store.requireIssue(params.key, actor);
      return [200, { transitions: availableTransitions(issue.statusId).map(t => transitionView(t, base)) }];
    }),
    route('POST', '/rest/api/3/issue/{key}/transitions', async ({ request, params, actor }) => {
      const body = await readJson(request);
      store.transitionIssue(params.key, body.transition, actor, { fields: body.fields, update: body.update });
      return [204];
    }),
    route('GET', '/rest/api/3/issue/{key}/comment', ({ params, actor, base }) => {
      const issue = store.requireIssue(params.key, actor);
      const comments = issue.comments.map(c => store.commentView(c, issue, base));
      return [200, { comments, startAt: 0, maxResults: comments.length, total: comments.length }];
    }),
    route('POST', '/rest/api/3/issue/{key}/comment', async ({ request, params, actor, base }) => {
      const { issue, comment } = store.addComment(params.key, (await readJson(request)).body, actor);
      return [201, store.commentView(comment, issue, base)];
    }),
    route('PUT', '/rest/api/3/issue/{key}/comment/{id}', async ({ request, params, actor, base }) => {
      const { issue, comment } = store.updateComment(params.key, params.id, (await readJson(request)).body, actor);
      return [200, store.commentView(comment, issue, base)];
    }),
    route('DELETE', '/rest/api/3/issue/{key}/comment/{id}', ({ params, actor }) => {
      store.deleteComment(params.key, params.id, actor);
      return [204];
    }),
    route('GET', '/rest/api/3/search/jql', ({ url, actor, base }) => searchResponse(store, {
      jql: url.searchParams.get('jql') || '',
      maxResults: url.searchParams.get('maxResults'),
      nextPageToken: url.searchParams.get('nextPageToken'),
      startAt: url.searchParams.get('startAt'),
      expand: url.searchParams.get('expand') || ''
    }, actor, base)),
    route('POST', '/rest/api/3/search/jql', async ({ request, actor, base }) => searchResponse(store, await readJson(request), actor, base)),
    route('GET', '/rest/api/3/issueLinkType', ({ base }) => [200, { issueLinkTypes: linkTypes.map(t => store.linkTypeView(t, base)) }]),
    route('POST', '/rest/api/3/issueLink', async ({ request, actor }) => {
      store.createLink(await readJson(request), actor);
      return [201];
    }),
    route('GET', '/rest/api/3/issueLink/{id}', ({ params, actor, base }) => [200, store.linkView(store.requireLink(params.id, actor), base)]),
    route('DELETE', '/rest/api/3/issueLink/{id}', ({ params, actor }) => {
      store.deleteLink(params.id, actor);
      return [204];
    }),
    route('GET', '/rest/agile/1.0/board', ({ url, actor, base }) => [200, page(
      store.boardsFor(actor, url.searchParams.get('projectKeyOrId') || undefined).map(b => store.boardView(b, base)), url)]),
    route('GET', '/rest/agile/1.0/board/{boardId}', ({ params, actor, base }) => [200, store.boardView(store.requireBoard(params.boardId, actor), base)]),
    route('GET', '/rest/agile/1.0/board/{boardId}/sprint', ({ params, url, actor, base }) => {
      const states = url.searchParams.get('state')?.split(',').map(s => s.trim()).filter(Boolean);
      const sprints = store.boardSprints(params.boardId, states?.length ? states : undefined, actor);
      return [200, page(sprints.map(s => store.sprintView(s, base)), url)];
    }),
    route('GET', '/rest/agile/1.0/board/{boardId}/backlog', ({ params, url, actor, base }) => [200, issuesPage(store.backlogIssues(params.boardId, actor), url, base, actor)]),
    route('POST', '/rest/agile/1.0/sprint', async ({ request, actor, base }) => [201, store.sprintView(store.createSprint(await readJson(request), actor), base)]),
    route('GET', '/rest/agile/1.0/sprint/{id}', ({ params, actor, base }) => [200, store.sprintView(store.requireSprint(params.id, actor), base)]),
    route('PUT', '/rest/agile/1.0/sprint/{id}', async ({ request, params, actor, base }) => [200, store.sprintView(store.updateSprint(params.id, await readJson(request), actor, { partial: false }), base)]),
    route('POST', '/rest/agile/1.0/sprint/{id}', async ({ request, params, actor, base }) => [200, store.sprintView(store.updateSprint(params.id, await readJson(request), actor, { partial: true }), base)]),
    route('DELETE', '/rest/agile/1.0/sprint/{id}', ({ params, actor }) => {
      store.deleteSprint(params.id, actor);
      return [204];
    }),
    route('GET', '/rest/agile/1.0/sprint/{id}/issue', ({ params, url, actor, base }) => [200, issuesPage(store.sprintIssues(params.id, actor), url, base, actor)]),
    route('POST', '/rest/agile/1.0/sprint/{id}/issue', async ({ request, params, actor }) => {
      store.moveToSprint(params.id, await readJson(request), actor);
      return [204];
    }),
    route('POST', '/rest/agile/1.0/backlog/{boardId}/issue', async ({ request, params, actor }) => {
      store.moveToBacklog(params.boardId, await readJson(request), actor);
      return [204];
    }),
    route('PUT', '/rest/agile/1.0/issue/rank', async ({ request, actor }) => {
      store.rankIssues(await readJson(request), actor);
      return [204];
    }),
    route('GET', '/rest/tracker/1/token', ({ actor }) => [200, { tokens: store.listTokens(actor) }]),
    route('POST', '/rest/tracker/1/token', async ({ request, actor }) => [201, store.createToken(actor, (await readJson(request)).label)]),
    route('DELETE', '/rest/tracker/1/token/{id}', ({ params, actor }) => {
      store.revokeToken(actor, params.id);
      return [204];
    })
  ];
}

function searchResponse(store, query, actor, base) {
  const result = store.search({ ...query, currentUser: actor });
  const expand = String(query.expand || '').split(',').map(s => s.trim()).filter(Boolean);
  return [200, {
    issues: result.issues.map(issue => store.issueView(issue, base, { expand, viewer: actor })),
    startAt: result.startAt,
    maxResults: result.maxResults,
    total: result.total,
    isLast: result.isLast,
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {})
  }];
}

function identify(store, request, { auth, sessions, automationKey }) {
  if (auth === 'none') {
    const requested = request.headers['x-tracker-user'];
    return { actor: requested && store.user(requested) ? requested : store.users()[0].accountId, via: 'none' };
  }
  if (auth === 'login') {
    const accountId = sessions.find(readCookie(request));
    if (accountId) return { actor: accountId, via: 'session' };
  }
  const credentials = parseBasicAuth(request.headers.authorization);
  if (credentials) return { actor: store.authenticate(credentials.email, credentials.token), via: 'token' };
  const requested = request.headers['x-tracker-user'];
  if (auth === 'login' && requested && fromLoopback(request)
    && secretMatches(request.headers['x-tracker-automation-key'], automationKey) && store.accountState(requested)?.active) {
    return { actor: requested, via: 'automation' };
  }
  return { actor: null, via: null };
}

const passwordChangeRoutes = new Set(['/rest/tracker/1/password', '/rest/api/3/myself', '/rest/api/3/serverInfo']);
const hasBody = request => Number(request.headers['content-length'] || 0) > 0 || Boolean(request.headers['transfer-encoding']);

export function createAppServer(store, { auth = 'none', automationKey = null } = {}) {
  const sessions = createSessions(store);
  const setup = { code: auth === 'login' && store.needsSetup() ? generateCode() : null };
  const routes = createRoutes(store, { auth, sessions, setup });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Cache-Control', 'no-cache');
    const send = (status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
      if (body === undefined) {
        response.writeHead(status, headers);
        response.end();
        return;
      }
      response.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      send(400, 'Bad request');
      return;
    }
    const base = `http://${request.headers.host || 'localhost'}`;
    if (url.pathname === '/healthz') {
      send(200, '{"status":"ok"}', jsonType);
      return;
    }
    if (url.pathname.startsWith('/rest/')) {
      try {
        await store.pull?.();
      } catch (error) {
        console.error('Tracker state read failed:', error);
        send(500, JSON.stringify({ errorMessages: ['Internal server error.'], errors: {} }), jsonType);
        request.resume();
        return;
      }
      const matching = routes.filter(r => r.regex.test(url.pathname));
      const found = matching.find(r => r.method === request.method);
      try {
        if (!found) {
          request.resume();
          if (matching.length) {
            response.setHeader('Allow', matching.map(r => r.method).join(', '));
            throw new ApiError(405, ['Method not allowed.']);
          }
          throw new ApiError(404, ['No REST resource matches this path.']);
        }
        if (!sameOrigin(request)) {
          request.resume();
          throw new ApiError(403, ['Cross-origin requests are not allowed.']);
        }
        if (auth === 'none' && !hostIsLoopback(request)) {
          request.resume();
          throw new ApiError(403, ['This server only answers requests addressed to localhost.']);
        }
        if (attachmentPath.test(url.pathname) && request.method === 'POST') {
          if (String(request.headers['x-atlassian-token'] || '').toLowerCase() !== 'no-check') {
            request.resume();
            throw new ApiError(403, ['XSRF check failed. Send the header X-Atlassian-Token: no-check.']);
          }
        } else if (hasBody(request) && !/^application\/json\b/i.test(request.headers['content-type'] || '')) {
          request.resume();
          throw new ApiError(415, ['Send request bodies as application/json.']);
        }
        const { actor, via } = found.anonymous ? { actor: null, via: null } : identify(store, request, { auth, sessions, automationKey });
        if (!found.anonymous && !actor) {
          request.resume();
          throw new ApiError(401, [auth === 'login'
            ? 'Sign in to continue.'
            : 'Authentication required. Send your email address and an API token with Basic authentication.']);
        }
        if (via === 'session' && store.accountState(actor).mustChangePassword && !passwordChangeRoutes.has(url.pathname)) {
          request.resume();
          throw new ApiError(403, ['Change your temporary password before continuing.']);
        }
        const values = found.regex.exec(url.pathname).slice(1).map(decodeURIComponent);
        const params = Object.fromEntries(found.names.map((name, i) => [name, values[i]]));
        const [status, body, headers = {}] = await found.handler({ request, url, params, actor, via, base });
        if (Buffer.isBuffer(body)) send(status, body, headers['Content-Type'], headers);
        else send(status, body === undefined ? undefined : JSON.stringify(body), jsonType, headers);
      } catch (error) {
        if (error instanceof ApiError) {
          send(error.status, JSON.stringify(error.body), jsonType);
        } else {
          console.error('Request failed:', error);
          send(500, JSON.stringify({ errorMessages: ['Internal server error.'], errors: {} }), jsonType);
        }
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'Method not allowed');
      request.resume();
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!publicFiles.has(path)) {
      send(404, 'Not found');
      return;
    }
    try {
      const data = await readFile(join(root, 'public', path));
      send(200, data, types[extname(path)] || 'application/octet-stream');
    } catch (error) {
      console.error('Asset read failed:', error.code || error.message);
      send(error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
    }
  });
  Object.defineProperty(server, 'setupCode', { get: () => setup.code });
  return server;
}

export function trackerDataFile(env = process.env) {
  if (env.TRACKER_DATA) return env.TRACKER_DATA;
  if (env.VERCEL) return join(tmpdir(), 'tracker.json');
  return join(root, 'data', 'tracker.sqlite');
}

export async function createTracker() {
  const auth = authMode();
  const dataFile = trackerDataFile();
  const store = await loadStore(dataFile);
  const automationKey = auth === 'login' && !process.env.VERCEL ? generateSecret() : null;
  if (automationKey) {
    const keyFile = join(dirname(resolve(dataFile)), '.automation-key');
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, `${automationKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
  }
  const server = createAppServer(store, { auth, automationKey });
  console.log(`Tracker data: ${dataFile}`);
  if (server.setupCode) {
    const admins = store.users().filter(user => user.siteAdmin).map(user => user.email).join(', ');
    console.log(`First-time setup: no one has a password yet. Open the tracker and enter setup code ${server.setupCode} with a site administrator's email (${admins}).`);
  }
  return { server, store };
}

export async function startTracker() {
  const options = listenOptions();
  const { server, store } = await createTracker();
  server.on('error', error => {
    console.error(`Tracker could not listen on ${options.host}:${options.port}: ${error.message}`);
    process.exitCode = 1;
  });
  const logReady = () => console.log(`Tracker listening on http://${options.host}:${options.port} (auth: ${authMode()})`);
  if (process.env.VERCEL) server.listen(process.env.PORT || 3000, logReady);
  else server.listen(options, logReady);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(async () => {
        await store.flush();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}

let vercelApp;

function vercelReady() {
  vercelApp ??= createTracker().then(result => result.server).catch(error => {
    vercelApp = null;
    throw error;
  });
  return vercelApp;
}

const vercelServer = createServer(async (request, response) => {
  try {
    const app = await vercelReady();
    app.emit('request', request, response);
  } catch (error) {
    const body = error.stack || error.message;
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    }
    response.end(body);
  }
});

if (process.env.VERCEL && !process.env.TRACKER_EMBEDDED) {
  vercelServer.listen(Number(process.env.PORT || 3000));
}

export default vercelServer;

const launched = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launched) {
  startTracker().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
