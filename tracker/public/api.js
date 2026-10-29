const userKey = 'tracker.user';
const authKey = 'tracker.auth';
const projectKey = 'tracker.project';

export class RequestError extends Error {
  constructor(status, body) {
    const messages = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})];
    super(messages.join(' ') || `요청이 실패했습니다 (HTTP ${status}).`);
    this.status = status;
    this.body = body;
  }
}

export function currentUserId() {
  return localStorage.getItem(userKey);
}

export function setCurrentUserId(accountId) {
  localStorage.setItem(userKey, accountId);
}

export function savedProjectKey() {
  return localStorage.getItem(projectKey);
}

export function saveProjectKey(key) {
  localStorage.setItem(projectKey, key);
}

export function savedSet(name) {
  try { return new Set(JSON.parse(localStorage.getItem(`tracker.${name}`) ?? '[]')); } catch { return new Set(); }
}

export function saveSet(name, values) {
  localStorage.setItem(`tracker.${name}`, JSON.stringify([...values].slice(-500)));
}

export function savedPref(name, fallback) {
  return localStorage.getItem(`tracker.${name}`) ?? fallback;
}

export function savePref(name, value) {
  localStorage.setItem(`tracker.${name}`, String(value));
}

export function setCredentials(email, token) {
  sessionStorage.setItem(authKey, btoa(String.fromCharCode(...new TextEncoder().encode(`${email}:${token}`))));
}

export function clearCredentials() {
  sessionStorage.removeItem(authKey);
}

export function hasCredentials() {
  return Boolean(sessionStorage.getItem(authKey));
}

let mode = 'login';
let signedOut = () => {};

export function setAuthMode(value) {
  mode = value;
}

export function onSignedOut(handler) {
  signedOut = handler;
}

function authHeaders() {
  const headers = {};
  const credentials = mode === 'basic' && sessionStorage.getItem(authKey);
  if (credentials) headers.Authorization = `Basic ${credentials}`;
  else if (mode === 'none' && currentUserId()) headers['X-Tracker-User'] = currentUserId();
  return headers;
}

function call(method, url, body) {
  return send(method, url, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { 'Content-Type': 'application/json' });
}

async function send(method, url, body, extra = {}) {
  const headers = { Accept: 'application/json', ...authHeaders(), ...extra };
  const response = await fetch(url, { method, headers, credentials: 'same-origin', body });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && mode === 'login' && !url.startsWith('/rest/tracker/1/session')) signedOut();
    throw new RequestError(response.status, data);
  }
  return data;
}

const tracker = (method, path, body) => call(method, `/rest/tracker/1${path}`, body);

const platform = (method, path, body) => call(method, `/rest/api/3${path}`, body);
const agile = (method, path, body) => call(method, `/rest/agile/1.0${path}`, body);
const key = value => encodeURIComponent(value);

export const api = {
  serverInfo: () => platform('GET', '/serverInfo'),
  myself: () => platform('GET', '/myself'),
  globalPermissions: () => platform('GET', '/mypermissions?permissions=ADMINISTER'),
  permissions: project => platform('GET', `/mypermissions?projectKey=${key(project)}`),
  issuePermissions: issueKey => platform('GET', `/mypermissions?issueKey=${key(issueKey)}`),
  users: () => platform('GET', '/users/search'),
  assignable: project => platform('GET', `/user/assignable/search?project=${key(project)}`),
  issueAssignable: issueKey => platform('GET', `/user/assignable/search?issueKey=${key(issueKey)}`),
  projects: () => platform('GET', '/project'),
  createProject: body => platform('POST', '/project', { projectTypeKey: 'software', ...body }),
  searchProjects: status => platform('GET', `/project/search?maxResults=100&status=${status}`),
  updateProject: (project, body) => platform('PUT', `/project/${key(project)}`, body),
  archiveProject: project => platform('POST', `/project/${key(project)}/archive`),
  restoreProject: project => platform('POST', `/project/${key(project)}/restore`),
  deleteProject: (project, undo = true) => platform('DELETE', `/project/${key(project)}?enableUndo=${undo}`),
  roles: project => platform('GET', `/project/${key(project)}/role`),
  role: (project, id) => platform('GET', `/project/${key(project)}/role/${id}`),
  addToRole: (project, id, accountIds) => platform('POST', `/project/${key(project)}/role/${id}`, { user: accountIds }),
  removeFromRole: (project, id, accountId) => platform('DELETE', `/project/${key(project)}/role/${id}?user=${key(accountId)}`),
  teams: project => platform('GET', `/project/${key(project)}/team`),
  createTeam: (project, body) => platform('POST', `/project/${key(project)}/team`, body),
  updateTeam: (project, id, body) => platform('PUT', `/project/${key(project)}/team/${id}`, body),
  deleteTeam: (project, id) => platform('DELETE', `/project/${key(project)}/team/${id}`),
  boards: project => agile('GET', `/board?projectKeyOrId=${key(project)}`),
  issueTypes: () => platform('GET', '/issuetype'),
  priorities: () => platform('GET', '/priority'),
  statuses: () => platform('GET', '/status'),
  linkTypes: () => platform('GET', '/issueLinkType'),
  search: (jql, maxResults = 200, nextPageToken) => platform('POST', '/search/jql', { jql, maxResults, nextPageToken }),
  async searchAll(jql) {
    const issues = [];
    let token;
    do {
      const page = await api.search(jql, 200, token);
      issues.push(...page.issues);
      token = page.nextPageToken;
    } while (token);
    return { issues };
  },
  issue: issueKey => platform('GET', `/issue/${key(issueKey)}?expand=changelog,transitions`),
  create: fields => platform('POST', '/issue', { fields }),
  update: (issueKey, fields) => platform('PUT', `/issue/${key(issueKey)}`, { fields }),
  remove: issueKey => platform('DELETE', `/issue/${key(issueKey)}?deleteSubtasks=true`),
  transitions: issueKey => platform('GET', `/issue/${key(issueKey)}/transitions`),
  transition: (issueKey, id) => platform('POST', `/issue/${key(issueKey)}/transitions`, { transition: { id } }),
  comment: (issueKey, text) => platform('POST', `/issue/${key(issueKey)}/comment`, { body: text }),
  editComment: (issueKey, id, text) => platform('PUT', `/issue/${key(issueKey)}/comment/${key(id)}`, { body: text }),
  deleteComment: (issueKey, id) => platform('DELETE', `/issue/${key(issueKey)}/comment/${key(id)}`),
  async scheme(project) {
    const assigned = await platform('GET', `/project/${key(project)}/permissionscheme`);
    return platform('GET', `/permissionscheme/${assigned.id}?expand=permissions`);
  },
  grant: (schemeId, permission, holder) => platform('POST', `/permissionscheme/${schemeId}/permission`, { permission, holder }),
  revoke: (schemeId, grantId) => platform('DELETE', `/permissionscheme/${schemeId}/permission/${grantId}`),
  link: (type, outwardKey, inwardKey) => platform('POST', '/issueLink', { type: { name: type }, outwardIssue: { key: outwardKey }, inwardIssue: { key: inwardKey } }),
  unlink: id => platform('DELETE', `/issueLink/${key(id)}`),
  sprints: (boardId, states = 'future,active') => agile('GET', `/board/${boardId}/sprint?state=${states}`),
  createSprint: (boardId, body) => agile('POST', '/sprint', { originBoardId: boardId, ...body }),
  updateSprint: (id, body) => agile('POST', `/sprint/${id}`, body),
  deleteSprint: id => agile('DELETE', `/sprint/${id}`),
  moveToSprint: (id, issues, rank = {}) => agile('POST', `/sprint/${id}/issue`, { issues, ...rank }),
  moveToBacklog: (boardId, issues, rank = {}) => agile('POST', `/backlog/${boardId}/issue`, { issues, ...rank }),
  rank: (issues, rank) => agile('PUT', '/issue/rank', { issues, ...rank }),
  tokens: () => call('GET', '/rest/tracker/1/token'),
  createToken: label => call('POST', '/rest/tracker/1/token', { label }),
  revokeToken: id => call('DELETE', `/rest/tracker/1/token/${key(id)}`),
  session: () => tracker('GET', '/session'),
  login: (email, password) => tracker('POST', '/session', { email, password }),
  logout: () => tracker('DELETE', '/session'),
  setup: (email, password) => tracker('POST', '/setup', { email, password }),
  changePassword: (current, next) => tracker('PUT', '/password', { current, next }),
  resetPassword: accountId => tracker('POST', `/user/${key(accountId)}/password/reset`),
  directory: () => tracker('GET', '/users'),
  notifications: () => tracker('GET', '/notification'),
  readNotification: id => tracker('POST', `/notification/${key(id)}/read`, {}),
  readNotifications: () => tracker('POST', '/notification/read', {}),
  archive: issueIdsOrKeys => platform('PUT', '/issue/archive', { issueIdsOrKeys }),
  unarchive: issueIdsOrKeys => platform('PUT', '/issue/unarchive', { issueIdsOrKeys }),
  archived: project => tracker('GET', `/project/${key(project)}/archived`),
  createUser: (emailAddress, displayName) => platform('POST', '/user', { emailAddress, displayName, products: ['jira-software'] }),
  setUserActive: (accountId, active) => tracker('PUT', `/user/${key(accountId)}/active`, { active }),
  attach: (issueKey, files) => {
    const form = new FormData();
    for (const file of files) form.append('file', file, file.name);
    return send('POST', `/rest/api/3/issue/${key(issueKey)}/attachments`, form, { 'X-Atlassian-Token': 'no-check' });
  },
  deleteAttachment: id => platform('DELETE', `/attachment/${key(id)}`),
  async attachmentBlob(id) {
    const response = await fetch(`/rest/api/3/attachment/content/${key(id)}`, { headers: authHeaders(), credentials: 'same-origin' });
    if (!response.ok) throw new RequestError(response.status, await response.json().catch(() => null));
    return response.blob();
  }
};

export function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const children = node.content ?? [];
  return children.map(adfToText).join(node.type === 'doc' ? '\n\n' : '');
}
