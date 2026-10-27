import { readFile, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adfToText, textToAdf } from './adf.js';

const schema = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS users (
  account_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  site_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER,
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lead_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  assignee_type TEXT NOT NULL DEFAULT 'UNASSIGNED',
  status TEXT NOT NULL DEFAULT 'live',
  scheme_id INTEGER,
  archived_date TEXT,
  archived_by TEXT,
  deleted_date TEXT,
  deleted_by TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS project_roles (
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (project_id, account_id)
) STRICT;
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  holder_type TEXT NOT NULL,
  holder_parameter TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS scheme_upgrades (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (team_id, account_id)
) STRICT;
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sprints (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  complete_date TEXT,
  created_date TEXT,
  origin_board_id INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description_json TEXT,
  description_text TEXT,
  status_id TEXT NOT NULL,
  priority_id TEXT NOT NULL,
  assignee_id TEXT,
  team_id INTEGER,
  reporter_id TEXT,
  parent_id TEXT,
  startdate TEXT,
  duedate TEXT,
  resolution TEXT,
  resolutiondate TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  rank INTEGER NOT NULL,
  sprint_id INTEGER,
  archived_date TEXT,
  archived_by TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (issue_id, label)
) STRICT;
CREATE TABLE IF NOT EXISTS issue_co_assignees (
  issue_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (issue_id, account_id)
) STRICT;
CREATE TABLE IF NOT EXISTS issue_closed_sprints (
  issue_id TEXT NOT NULL,
  sprint_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (issue_id, sprint_id)
) STRICT;
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_id TEXT,
  update_author_id TEXT,
  body_json TEXT,
  body_text TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  position INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS changelogs (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_id TEXT,
  created TEXT NOT NULL,
  position INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS changelog_items (
  changelog_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  field TEXT NOT NULL,
  fieldtype TEXT,
  from_value TEXT,
  from_string TEXT,
  to_value TEXT,
  to_string TEXT,
  PRIMARY KEY (changelog_id, position)
) STRICT;
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  inward_id TEXT NOT NULL,
  outward_id TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  hash TEXT NOT NULL,
  created TEXT NOT NULL,
  last_used TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL,
  created TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  author_id TEXT,
  created TEXT NOT NULL
) STRICT;
CREATE VIEW IF NOT EXISTS issue_list AS
SELECT
  i.key,
  i.summary,
  CASE i.type_id
    WHEN '10000' THEN 'Epic'
    WHEN '10001' THEN 'Story'
    WHEN '10002' THEN 'Task'
    WHEN '10003' THEN 'Bug'
    WHEN '10004' THEN 'Subtask'
    ELSE i.type_id
  END AS type_name,
  CASE i.status_id
    WHEN '10000' THEN 'To Do'
    WHEN '10001' THEN 'In Progress'
    WHEN '10002' THEN 'In Review'
    WHEN '10003' THEN 'Done'
    ELSE i.status_id
  END AS status_name,
  CASE i.priority_id
    WHEN '1' THEN 'Highest'
    WHEN '2' THEN 'High'
    WHEN '3' THEN 'Medium'
    WHEN '4' THEN 'Low'
    WHEN '5' THEN 'Lowest'
    ELSE i.priority_id
  END AS priority_name,
  u.display_name AS assignee,
  i.startdate,
  i.duedate,
  p.key AS project_key,
  i.rank
FROM issues i
JOIN projects p ON p.id = i.project_id
LEFT JOIN users u ON u.account_id = i.assignee_id;
`;

const dataTables = [
  'changelog_items', 'changelogs', 'comments', 'issue_closed_sprints', 'issue_co_assignees', 'issue_labels',
  'attachments', 'links', 'tokens', 'notifications', 'issues', 'sprints', 'boards', 'team_members', 'teams',
  'scheme_upgrades', 'grants', 'project_roles', 'projects', 'users', 'counters', 'meta'
];

const flag = value => (value ? 1 : 0);
const nullableFlag = value => (value == null ? null : value ? 1 : 0);

function fileStamp(file) {
  let max = 0;
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try { max = Math.max(max, statSync(path).mtimeMs); } catch { /* missing sidecar */ }
  }
  return max;
}

function insert(db, table, columns, rows) {
  if (rows.length === 0) return;
  const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of rows) statement.run(...row);
}

function richText(json, text) {
  if (json) {
    try {
      const doc = JSON.parse(json);
      if (doc && typeof doc === 'object' && (text == null || adfToText(doc) === text)) return doc;
    } catch { /* Adminer에 일반 텍스트를 넣은 경우 */ }
  }
  if (text) return textToAdf(text);
  return null;
}

function grouped(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

export function writeState(db, state) {
  const counters = [
    ...['issue', 'comment', 'changelog', 'link', 'sprint', 'token', 'board', 'grant', 'team', 'attachment', 'notification'].map(name => [name, state.counters[name] ?? 0]),
    ...Object.entries(state.counters.project ?? {}).map(([key, value]) => [`project:${key}`, value])
  ];
  const roles = [];
  const grants = [];
  const upgrades = [];
  const teams = [];
  const members = [];
  for (const project of state.projects) {
    for (const [accountId, role] of Object.entries(project.roles ?? {})) roles.push([project.id, accountId, role]);
    for (const grant of project.scheme?.grants ?? []) {
      grants.push([grant.id, project.id, grant.permission, grant.holder.type, grant.holder.parameter ?? null]);
    }
    for (const name of project.scheme?.upgrades ?? []) upgrades.push([project.id, name]);
    for (const team of project.teams ?? []) {
      teams.push([team.id, project.id, team.name]);
      team.members.forEach((accountId, position) => members.push([team.id, accountId, position]));
    }
  }
  const labels = [];
  const coAssignees = [];
  const closedSprints = [];
  const comments = [];
  const histories = [];
  const historyItems = [];
  for (const issue of state.issues) {
    (issue.labels ?? []).forEach((label, position) => labels.push([issue.id, label, position]));
    (issue.coAssigneeIds ?? []).forEach((accountId, position) => coAssignees.push([issue.id, accountId, position]));
    (issue.closedSprintIds ?? []).forEach((sprintId, position) => closedSprints.push([issue.id, sprintId, position]));
    (issue.comments ?? []).forEach((comment, position) => comments.push([
      comment.id, issue.id, comment.authorId ?? null, comment.updateAuthorId ?? null,
      comment.body ? JSON.stringify(comment.body) : null, comment.body ? adfToText(comment.body) : null,
      comment.created, comment.updated, position
    ]));
    (issue.changelog ?? []).forEach((entry, position) => {
      histories.push([entry.id, issue.id, entry.authorId ?? null, entry.created, position]);
      (entry.items ?? []).forEach((item, itemPosition) => historyItems.push([
        entry.id, itemPosition, item.field, item.fieldtype ?? null, item.from ?? null, item.fromString ?? null, item.to ?? null, item.toString ?? null
      ]));
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of dataTables) db.prepare(`DELETE FROM ${table}`).run();
    insert(db, 'meta', ['key', 'value'], [['initialized', '1']]);
    insert(db, 'counters', ['name', 'value'], counters);
    insert(db, 'users', ['account_id', 'display_name', 'email', 'site_admin', 'active', 'password_hash', 'must_change_password', 'session_version'], state.users.map(user => [
      user.accountId, user.displayName, user.email ?? null, flag(user.siteAdmin), nullableFlag(user.active),
      user.passwordHash ?? null, flag(user.mustChangePassword), user.sessionVersion ?? 0
    ]));
    insert(db, 'projects', ['id', 'key', 'name', 'lead_id', 'description', 'url', 'assignee_type', 'status', 'scheme_id', 'archived_date', 'archived_by', 'deleted_date', 'deleted_by'], state.projects.map(project => [
      project.id, project.key, project.name, project.leadId ?? null, project.description ?? '', project.url ?? '',
      project.assigneeType ?? 'UNASSIGNED', project.status ?? 'live', project.scheme?.id ?? Number(project.id),
      project.archivedDate ?? null, project.archivedBy ?? null, project.deletedDate ?? null, project.deletedBy ?? null
    ]));
    insert(db, 'project_roles', ['project_id', 'account_id', 'role'], roles);
    insert(db, 'grants', ['id', 'project_id', 'permission', 'holder_type', 'holder_parameter'], grants);
    insert(db, 'scheme_upgrades', ['project_id', 'name'], upgrades);
    insert(db, 'teams', ['id', 'project_id', 'name'], teams);
    insert(db, 'team_members', ['team_id', 'account_id', 'position'], members);
    insert(db, 'boards', ['id', 'name', 'type', 'project_id'], state.boards.map(board => [board.id, board.name, board.type, board.projectId]));
    insert(db, 'sprints', ['id', 'name', 'state', 'goal', 'start_date', 'end_date', 'complete_date', 'created_date', 'origin_board_id'], state.sprints.map(sprint => [
      sprint.id, sprint.name, sprint.state, sprint.goal ?? '', sprint.startDate ?? null, sprint.endDate ?? null,
      sprint.completeDate ?? null, sprint.createdDate ?? null, sprint.originBoardId
    ]));
    insert(db, 'issues', [
      'id', 'key', 'project_id', 'type_id', 'summary', 'description_json', 'description_text', 'status_id', 'priority_id',
      'assignee_id', 'team_id', 'reporter_id', 'parent_id', 'startdate', 'duedate', 'resolution', 'resolutiondate',
      'created', 'updated', 'rank', 'sprint_id', 'archived_date', 'archived_by'
    ], state.issues.map(issue => [
      issue.id, issue.key, issue.projectId, issue.typeId, issue.summary,
      issue.description ? JSON.stringify(issue.description) : null, issue.description ? adfToText(issue.description) : null,
      issue.statusId, issue.priorityId, issue.assigneeId ?? null, issue.teamId ?? null, issue.reporterId ?? null, issue.parentId ?? null,
      issue.startdate ?? null, issue.duedate ?? null, issue.resolution ?? null, issue.resolutiondate ?? null,
      issue.created, issue.updated, issue.rank ?? 0, issue.sprintId ?? null, issue.archived?.date ?? null, issue.archived?.by ?? null
    ]));
    insert(db, 'issue_labels', ['issue_id', 'label', 'position'], labels);
    insert(db, 'issue_co_assignees', ['issue_id', 'account_id', 'position'], coAssignees);
    insert(db, 'issue_closed_sprints', ['issue_id', 'sprint_id', 'position'], closedSprints);
    insert(db, 'comments', ['id', 'issue_id', 'author_id', 'update_author_id', 'body_json', 'body_text', 'created', 'updated', 'position'], comments);
    insert(db, 'changelogs', ['id', 'issue_id', 'author_id', 'created', 'position'], histories);
    insert(db, 'changelog_items', ['changelog_id', 'position', 'field', 'fieldtype', 'from_value', 'from_string', 'to_value', 'to_string'], historyItems);
    insert(db, 'links', ['id', 'type_id', 'inward_id', 'outward_id'], state.links.map(link => [link.id, link.typeId, link.inwardId, link.outwardId]));
    insert(db, 'tokens', ['id', 'account_id', 'label', 'hash', 'created', 'last_used'], state.tokens.map(token => [
      token.id, token.accountId, token.label, token.hash, token.created, token.lastUsed ?? null
    ]));
    insert(db, 'notifications', ['id', 'account_id', 'kind', 'issue_id', 'actor_id', 'text', 'created', 'read'], (state.notifications ?? []).map(entry => [
      entry.id, entry.accountId, entry.kind, entry.issueId, entry.actorId ?? null, entry.text, entry.created, flag(entry.read)
    ]));
    insert(db, 'attachments', ['id', 'issue_id', 'filename', 'mime_type', 'size', 'author_id', 'created'], state.attachments.map(attachment => [
      attachment.id, attachment.issueId, attachment.filename, attachment.mimeType, attachment.size, attachment.authorId ?? null, attachment.created
    ]));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export function readState(db) {
  const counters = { project: {} };
  for (const row of db.prepare('SELECT name, value FROM counters').all()) {
    if (row.name.startsWith('project:')) counters.project[row.name.slice('project:'.length)] = row.value;
    else counters[row.name] = row.value;
  }
  const users = db.prepare('SELECT * FROM users').all().map(row => {
    const user = { accountId: row.account_id, displayName: row.display_name, email: row.email ?? undefined };
    if (row.site_admin) user.siteAdmin = true;
    if (row.active != null) user.active = row.active === 1;
    if (row.password_hash) user.passwordHash = row.password_hash;
    if (row.must_change_password) user.mustChangePassword = true;
    if (row.session_version) user.sessionVersion = row.session_version;
    return user;
  });
  const roleRows = grouped(db.prepare('SELECT * FROM project_roles').all(), 'project_id');
  const grantRows = grouped(db.prepare('SELECT * FROM grants ORDER BY id').all(), 'project_id');
  const upgradeRows = grouped(db.prepare('SELECT * FROM scheme_upgrades').all(), 'project_id');
  const teamRows = grouped(db.prepare('SELECT * FROM teams ORDER BY id').all(), 'project_id');
  const memberRows = grouped(db.prepare('SELECT * FROM team_members ORDER BY position').all(), 'team_id');
  const projects = db.prepare('SELECT * FROM projects').all().map(row => {
    const project = {
      id: row.id,
      key: row.key,
      name: row.name,
      leadId: row.lead_id,
      description: row.description ?? '',
      url: row.url ?? '',
      assigneeType: row.assignee_type,
      status: row.status,
      roles: Object.fromEntries((roleRows.get(row.id) ?? []).map(role => [role.account_id, role.role])),
      scheme: {
        id: row.scheme_id ?? Number(row.id),
        grants: (grantRows.get(row.id) ?? []).map(grant => {
          const holder = { type: grant.holder_type };
          if (grant.holder_parameter != null) holder.parameter = grant.holder_parameter;
          return { id: grant.id, permission: grant.permission, holder };
        }),
        upgrades: (upgradeRows.get(row.id) ?? []).map(upgrade => upgrade.name)
      },
      teams: (teamRows.get(row.id) ?? []).map(team => ({
        id: team.id,
        name: team.name,
        members: (memberRows.get(team.id) ?? []).map(member => member.account_id)
      }))
    };
    if (row.archived_date) project.archivedDate = row.archived_date;
    if (row.archived_by) project.archivedBy = row.archived_by;
    if (row.deleted_date) project.deletedDate = row.deleted_date;
    if (row.deleted_by) project.deletedBy = row.deleted_by;
    return project;
  });
  const labelRows = grouped(db.prepare('SELECT * FROM issue_labels ORDER BY position').all(), 'issue_id');
  const coRows = grouped(db.prepare('SELECT * FROM issue_co_assignees ORDER BY position').all(), 'issue_id');
  const closedRows = grouped(db.prepare('SELECT * FROM issue_closed_sprints ORDER BY position').all(), 'issue_id');
  const commentRows = grouped(db.prepare('SELECT * FROM comments ORDER BY position').all(), 'issue_id');
  const historyRows = grouped(db.prepare('SELECT * FROM changelogs ORDER BY position').all(), 'issue_id');
  const itemRows = grouped(db.prepare('SELECT * FROM changelog_items ORDER BY position').all(), 'changelog_id');
  const issues = db.prepare('SELECT * FROM issues').all().map(row => {
    const issue = {
      id: row.id,
      key: row.key,
      projectId: row.project_id,
      typeId: row.type_id,
      summary: row.summary,
      description: richText(row.description_json, row.description_text),
      statusId: row.status_id,
      priorityId: row.priority_id,
      assigneeId: row.assignee_id,
      coAssigneeIds: (coRows.get(row.id) ?? []).map(item => item.account_id),
      teamId: row.team_id,
      reporterId: row.reporter_id,
      labels: (labelRows.get(row.id) ?? []).map(item => item.label),
      parentId: row.parent_id,
      startdate: row.startdate,
      duedate: row.duedate,
      resolution: row.resolution,
      resolutiondate: row.resolutiondate,
      created: row.created,
      updated: row.updated,
      rank: row.rank,
      sprintId: row.sprint_id,
      closedSprintIds: (closedRows.get(row.id) ?? []).map(item => item.sprint_id),
      comments: (commentRows.get(row.id) ?? []).map(comment => {
        const value = {
          id: comment.id,
          authorId: comment.author_id,
          body: richText(comment.body_json, comment.body_text),
          created: comment.created,
          updated: comment.updated
        };
        if (comment.update_author_id) value.updateAuthorId = comment.update_author_id;
        return value;
      }),
      changelog: (historyRows.get(row.id) ?? []).map(entry => ({
        id: entry.id,
        authorId: entry.author_id,
        created: entry.created,
        items: (itemRows.get(entry.id) ?? []).map(item => {
          const value = { field: item.field, fromString: item.from_string, toString: item.to_string };
          if (item.fieldtype != null) value.fieldtype = item.fieldtype;
          if (item.from_value != null) value.from = item.from_value;
          if (item.to_value != null) value.to = item.to_value;
          return value;
        })
      }))
    };
    if (row.archived_date) issue.archived = { date: row.archived_date, by: row.archived_by };
    return issue;
  });
  return {
    counters,
    projects,
    boards: db.prepare('SELECT * FROM boards').all().map(row => ({ id: row.id, name: row.name, type: row.type, projectId: row.project_id })),
    users,
    issues,
    sprints: db.prepare('SELECT * FROM sprints').all().map(row => ({
      id: row.id, name: row.name, state: row.state, goal: row.goal ?? '', startDate: row.start_date, endDate: row.end_date,
      completeDate: row.complete_date, createdDate: row.created_date, originBoardId: row.origin_board_id
    })),
    links: db.prepare('SELECT * FROM links').all().map(row => ({ id: row.id, typeId: row.type_id, inwardId: row.inward_id, outwardId: row.outward_id })),
    tokens: db.prepare('SELECT * FROM tokens').all().map(row => ({
      id: row.id, accountId: row.account_id, label: row.label, hash: row.hash, created: row.created, lastUsed: row.last_used
    })),
    notifications: db.prepare('SELECT * FROM notifications').all().map(row => ({
      id: row.id, accountId: row.account_id, kind: row.kind, issueId: row.issue_id, actorId: row.actor_id,
      text: row.text, created: row.created, read: row.read === 1
    })),
    attachments: db.prepare('SELECT * FROM attachments').all().map(row => ({
      id: row.id, issueId: row.issue_id, filename: row.filename, mimeType: row.mime_type, size: row.size, authorId: row.author_id, created: row.created
    }))
  };
}

export async function openDatabase(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: false });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(schema);
  return db;
}

export function sqliteBackend(db, file) {
  return {
    write(state) { writeState(db, state); },
    read() { return readState(db); },
    stamp() { return fileStamp(file); }
  };
}

async function legacyState(file) {
  const legacy = join(dirname(file), 'db.json');
  try {
    return { path: legacy, state: JSON.parse(await readFile(legacy, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read tracker state ${legacy}: ${error.message}`);
  }
}

export async function prepareSql(file) {
  await mkdir(dirname(file), { recursive: true });
  const db = await openDatabase(file);
  const ready = db.prepare(`SELECT value FROM meta WHERE key = 'initialized'`).get();
  if (ready) return { db, initial: readState(db), ready: true, importedFrom: null };
  const legacy = await legacyState(file);
  return { db, initial: legacy?.state ?? null, ready: false, importedFrom: legacy?.path ?? null };
}

export function isSqliteFile(file) {
  return typeof file === 'string' && /\.(?:sqlite3?|db)$/i.test(file);
}
