import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRichText, adfToText } from './adf.js';
import { runJql, JqlError } from './jql.js';
import {
  statuses, statusCategories, initialStatusId, findTransition,
  availableTransitions, statusView, transitionView
} from './workflow.js';
import {
  hasPermission, permissionCatalog, permissionReport, projectRoles, generateToken, hashToken, tokenMatches,
  defaultGrants, validateGrant, normalizeHolder, isLockedGrant, upgradeScheme, issuePeople,
  hashPassword, passwordMatches, generatePassword, minPasswordLength
} from './access.js';
import { isSqliteFile, prepareSql, sqliteBackend } from './sql.js';

const assignFields = ['assignee', 'assignees', 'team'];

export class ApiError extends Error {
  constructor(status, errorMessages = [], errors = {}) {
    super(errorMessages[0] || Object.values(errors)[0] || `HTTP ${status}`);
    this.status = status;
    this.body = { errorMessages, errors };
  }
}

export const issueTypes = [
  { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1, description: '여러 작업을 묶는 큰 단위의 목표입니다.' },
  { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0, description: '사용자 관점의 기능 요구입니다.' },
  { id: '10002', name: 'Task', subtask: false, hierarchyLevel: 0, description: '처리해야 할 작업입니다.' },
  { id: '10003', name: 'Bug', subtask: false, hierarchyLevel: 0, description: '고쳐야 할 결함입니다.' },
  { id: '10004', name: 'Subtask', subtask: true, hierarchyLevel: -1, description: '상위 작업을 쪼갠 단위입니다.' }
];

export const priorities = [
  { id: '1', name: 'Highest' },
  { id: '2', name: 'High' },
  { id: '3', name: 'Medium' },
  { id: '4', name: 'Low' },
  { id: '5', name: 'Lowest' }
];

export const linkTypes = [
  { id: '1000', name: 'Duplicate', inward: 'Duplicated by', outward: 'Duplicates' },
  { id: '1010', name: 'Blocks', inward: 'Blocked by', outward: 'Blocks' },
  { id: '1020', name: 'Relates', inward: 'Relates to', outward: 'Relates to' }
];

const defaultPriorityId = '3';
const maxBatch = 50;
const sprintStates = ['future', 'active', 'closed'];

export function seedState() {
  return {
    counters: { issue: 10000, comment: 10000, changelog: 10000, link: 10000, sprint: 0, token: 0, board: 1, grant: 10000, team: 0, attachment: 10000, project: { OS: 0 } },
    projects: [{
      id: '10000', key: 'OS', name: 'OneStop', leadId: 'u-haneul', description: '',
      roles: { 'u-haneul': 'administrators', 'u-doyun': 'members', 'u-seoyeon': 'members', 'u-agent': 'members', 'u-guest': 'viewers' }
    }],
    boards: [{ id: 1, name: 'OS 보드', type: 'scrum', projectId: '10000' }],
    users: [
      { accountId: 'u-haneul', displayName: '김하늘', email: 'haneul@onestop.local', siteAdmin: true },
      { accountId: 'u-doyun', displayName: '이도윤', email: 'doyun@onestop.local' },
      { accountId: 'u-seoyeon', displayName: '박서연', email: 'seoyeon@onestop.local' },
      { accountId: 'u-agent', displayName: 'Build Agent', email: 'agent@onestop.local' },
      { accountId: 'u-guest', displayName: '정민재', email: 'guest@onestop.local' }
    ],
    issues: [],
    sprints: [],
    links: [],
    tokens: [],
    attachments: []
  };
}

export function normalizeState(state) {
  const seed = seedState();
  state.counters = { ...seed.counters, ...state.counters, project: { ...state.counters?.project } };
  state.boards ??= seed.boards;
  state.sprints ??= [];
  state.links ??= [];
  state.tokens ??= [];
  state.attachments ??= [];
  for (const seeded of seed.users) {
    const existing = state.users.find(u => u.accountId === seeded.accountId);
    if (existing) {
      existing.email ??= seeded.email;
      if (seeded.siteAdmin) existing.siteAdmin ??= true;
    } else state.users.push(seeded);
  }
  for (const project of state.projects) {
    project.roles ??= seed.projects.find(p => p.key === project.key)?.roles ?? {};
    project.description ??= '';
    project.url ??= '';
    project.assigneeType ??= 'UNASSIGNED';
    project.status ??= 'live';
    project.scheme ??= defaultScheme(state, project.id);
    upgradeScheme(project.scheme, () => ++state.counters.grant);
    project.teams ??= [];
  }
  for (const board of state.boards) {
    if (board.projectId == null) board.projectId = state.projects.find(p => p.key === board.projectKey)?.id ?? state.projects[0].id;
    delete board.projectKey;
  }
  state.counters.board = Math.max(state.counters.board, ...state.boards.map(b => b.id));
  for (const project of state.projects) {
    if (state.boards.some(b => b.projectId === project.id)) continue;
    state.counters.board += 1;
    state.boards.push({ id: state.counters.board, name: `${project.key} 보드`, type: 'scrum', projectId: project.id });
  }
  let next = Math.max(0, ...state.issues.map(issue => issue.rank ?? 0));
  for (const issue of [...state.issues].sort((a, b) => Number(a.id) - Number(b.id))) {
    issue.rank ??= ++next;
    issue.sprintId ??= null;
    issue.closedSprintIds ??= [];
    issue.startdate ??= null;
    issue.coAssigneeIds ??= [];
    issue.teamId ??= null;
  }
  return state;
}

function defaultScheme(state, projectId) {
  const grants = defaultGrants().map(grant => ({ id: ++state.counters.grant, ...grant }));
  return upgradeScheme({ id: Number(projectId), grants }, () => ++state.counters.grant);
}

export function jiraTime(date = new Date()) {
  return date.toISOString().replace('Z', '+0000');
}

const byIdOrName = (list, ref, label) => {
  if (ref == null) return null;
  const id = typeof ref === 'object' ? ref.id : ref;
  const name = typeof ref === 'object' ? ref.name : ref;
  const found = list.find(item => (id != null && item.id === String(id)) || (name != null && item.name.toLowerCase() === String(name).toLowerCase()));
  if (!found) throw new ApiError(400, [], { [label]: `${label} "${id ?? name}" is not valid.` });
  return found;
};

export function createStore({ file = null, state = null, now = () => new Date(), backend = null } = {}) {
  let data = normalizeState(state ?? seedState());
  let writing = Promise.resolve();
  let seen = backend ? backend.stamp() : 0;

  const findProject = ref => {
    const key = typeof ref === 'object' ? ref?.key ?? ref?.id : ref;
    if (key == null) return null;
    return data.projects.find(p => p.id === String(key) || p.key.toLowerCase() === String(key).toLowerCase()) || null;
  };
  const projectOf = issue => data.projects.find(p => p.id === issue.projectId);
  const isLive = target => (target?.status ?? 'live') === 'live';
  const can = (accountId, key, target, issue = null) => isLive(target) && isActive(accountId) && hasPermission(target, accountId, key, issue);
  const canBrowse = (accountId, target) => can(accountId, 'BROWSE_PROJECTS', target);
  const requirePermission = (accountId, key, target, issue = null) => {
    if (!can(accountId, key, target, issue)) {
      const scope = issue ? `issue ${issue.key}` : `project ${target.key}`;
      throw new ApiError(403, [`You do not have the ${permissionCatalog[key].name} permission for ${scope}.`]);
    }
  };
  const requireOnEach = (accountId, key, issues) => {
    for (const issue of issues) requirePermission(accountId, key, projectOf(issue), issue);
  };

  const project = ref => {
    const found = findProject(ref);
    if (!found) throw new ApiError(400, [], { project: `Project "${typeof ref === 'object' ? ref?.key ?? ref?.id : ref}" does not exist.` });
    return found;
  };
  const requireProject = (ref, actorId) => {
    const found = findProject(ref);
    if (!found || (actorId && !canBrowse(actorId, found))) throw new ApiError(404, [`No project could be found with key '${ref}'.`]);
    return found;
  };
  const sameProject = (issues, message) => {
    const owners = new Set(issues.map(issue => issue.projectId));
    if (owners.size > 1) throw new ApiError(400, [message]);
    return projectOf(issues[0]);
  };
  const user = accountId => data.users.find(u => u.accountId === accountId) || null;
  const isActive = accountId => user(accountId)?.active !== false;
  const userRef = (ref, label) => {
    if (ref == null) return null;
    const id = typeof ref === 'object' ? ref.accountId ?? ref.id : ref;
    if (id == null) return null;
    if (!user(id)) throw new ApiError(400, [], { [label]: `User "${id}" does not exist.` });
    return id;
  };
  const type = id => issueTypes.find(t => t.id === id);
  const priority = id => priorities.find(p => p.id === id);
  const status = id => statuses.find(s => s.id === id);
  const findIssue = idOrKey => {
    const needle = String(idOrKey).toUpperCase();
    return data.issues.find(issue => issue.id === needle || issue.key === needle) || null;
  };
  const requireIssue = (idOrKey, actorId) => {
    const issue = findIssue(idOrKey);
    if (!issue || (actorId && !canBrowse(actorId, projectOf(issue)))) {
      throw new ApiError(404, ['Issue does not exist or you do not have permission to see it.']);
    }
    return issue;
  };
  const children = issue => data.issues.filter(candidate => candidate.parentId === issue.id);
  const requireLive = issue => {
    if (issue.archived) throw new ApiError(400, [`Issue ${issue.key} is archived. Restore it before making changes.`]);
    return issue;
  };

  function resolveParent(ref, issueType, projectId, self = null) {
    if (ref == null) {
      if (issueType.subtask) throw new ApiError(400, [], { parent: 'A subtask must have a parent.' });
      return null;
    }
    const parent = findIssue(typeof ref === 'object' ? ref.key ?? ref.id : ref);
    if (!parent) throw new ApiError(400, [], { parent: 'The parent issue does not exist.' });
    if (self && parent.id === self.id) throw new ApiError(400, [], { parent: 'An issue cannot be its own parent.' });
    if (parent.projectId !== projectId) throw new ApiError(400, [], { parent: 'The parent must be in the same project.' });
    const parentType = type(parent.typeId);
    if (issueType.hierarchyLevel !== parentType.hierarchyLevel - 1) {
      throw new ApiError(400, [], { parent: `A ${issueType.name} cannot be a child of a ${parentType.name}.` });
    }
    return parent.id;
  }

  function persist() {
    if (backend) {
      writing = writing.then(() => {
        backend.write(data);
        seen = backend.stamp();
      }).catch(error => {
        console.error('Tracker state write failed:', error.message);
      });
      return writing;
    }
    if (!file) return writing;
    const snapshot = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot);
      await rename(temp, file);
    }).catch(error => {
      console.error('Tracker state write failed:', error.message);
    });
    return writing;
  }

  async function pull() {
    if (!backend) return;
    await writing;
    const stamp = backend.stamp();
    if (stamp > seen) {
      data = normalizeState(backend.read());
      seen = stamp;
    }
  }

  function record(issue, actorId, items) {
    const changed = items.filter(item => item.fromString !== item.toString);
    if (changed.length === 0) return;
    data.counters.changelog += 1;
    issue.changelog.push({ id: String(data.counters.changelog), authorId: actorId, created: jiraTime(now()), items: changed });
    issue.updated = jiraTime(now());
  }

  const display = {
    priority: id => priority(id)?.name ?? null,
    user: id => user(id)?.displayName ?? null,
    issue: id => data.issues.find(i => i.id === id)?.key ?? null,
    text: doc => (doc ? adfToText(doc) : null),
    labels: labels => (labels.length ? labels.join(' ') : null)
  };

  function applyFields(issue, fields, actorId, { creating = false } = {}) {
    const items = [];
    const set = (field, key, value, show) => {
      const before = issue[key];
      issue[key] = value;
      if (!creating) items.push({ field, fromString: show(before), toString: show(value) });
    };
    if ('summary' in fields) {
      const summary = String(fields.summary ?? '').trim();
      if (!summary) throw new ApiError(400, [], { summary: 'You must specify a summary of the issue.' });
      if (summary.length > 255) throw new ApiError(400, [], { summary: 'Summary must be less than 255 characters.' });
      set('summary', 'summary', summary, v => v ?? null);
    }
    if ('description' in fields) {
      let doc;
      try { doc = normalizeRichText(fields.description); } catch (error) { throw new ApiError(400, [], { description: error.message }); }
      set('description', 'description', doc, display.text);
    }
    if ('priority' in fields) {
      const value = fields.priority == null ? defaultPriorityId : byIdOrName(priorities, fields.priority, 'priority').id;
      set('priority', 'priorityId', value, display.priority);
    }
    if ('assignees' in fields || 'assignee' in fields) {
      const owner = projectOf(issue);
      const before = [issue.assigneeId, ...issue.coAssigneeIds].filter(Boolean);
      const label = 'assignees' in fields ? 'assignees' : 'assignee';
      let ids;
      if (label === 'assignees') {
        if (fields.assignees != null && !Array.isArray(fields.assignees)) throw new ApiError(400, [], { assignees: 'assignees must be a list of users.' });
        ids = [...new Set((fields.assignees ?? []).map(ref => userRef(ref, 'assignees')).filter(Boolean))];
      } else {
        const assignee = userRef(fields.assignee, 'assignee');
        ids = assignee ? [assignee, ...issue.coAssigneeIds.filter(id => id !== assignee)] : [];
      }
      for (const id of ids) {
        if (!before.includes(id) && !can(id, 'ASSIGNABLE_USER', owner)) {
          throw new ApiError(400, [], { [label]: `User '${user(id).displayName}' cannot be assigned issues in project ${owner.key}.` });
        }
      }
      issue.assigneeId = ids[0] ?? null;
      issue.coAssigneeIds = ids.slice(1);
      if (!creating) {
        const names = list => (list.length ? list.map(display.user).join(', ') : null);
        items.push(before.length > 1 || ids.length > 1
          ? { field: 'assignees', fromString: names(before), toString: names(ids) }
          : { field: 'assignee', fromString: names(before), toString: names(ids) });
      }
    }
    if ('team' in fields) {
      const owner = projectOf(issue);
      const ref = fields.team;
      const id = ref == null ? null : Number(typeof ref === 'object' ? ref.id : ref);
      if (id != null && !owner.teams.some(t => t.id === id)) throw new ApiError(400, [], { team: `Team '${typeof ref === 'object' ? ref.id : ref}' does not exist in project ${owner.key}.` });
      set('team', 'teamId', id, value => owner.teams.find(t => t.id === value)?.name ?? null);
    }
    if ('reporter' in fields && fields.reporter != null) set('reporter', 'reporterId', userRef(fields.reporter, 'reporter'), display.user);
    if ('labels' in fields) {
      const labels = fields.labels ?? [];
      if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string' || /\s/.test(label) || !label)) {
        throw new ApiError(400, [], { labels: 'Labels must be non-empty strings without spaces.' });
      }
      set('labels', 'labels', [...new Set(labels)], display.labels);
    }
    const day = (name, label) => {
      const value = fields[name] || null;
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
        throw new ApiError(400, [], { [name]: `${label} must use the yyyy-MM-dd format.` });
      }
      return value;
    };
    const start = 'startdate' in fields ? day('startdate', 'Start date') : issue.startdate ?? null;
    const due = 'duedate' in fields ? day('duedate', 'Due date') : issue.duedate ?? null;
    if (start && due && start > due) throw new ApiError(400, [], { startdate: 'Start date must be on or before the due date.' });
    if ('startdate' in fields) set('startdate', 'startdate', start, v => v);
    if ('duedate' in fields) set('duedate', 'duedate', due, v => v);
    if (!creating && 'parent' in fields) {
      set('parent', 'parentId', resolveParent(fields.parent, type(issue.typeId), issue.projectId, issue), display.issue);
    }
    if (!creating && 'issuetype' in fields) {
      throw new ApiError(400, [], { issuetype: 'Changing the issue type is not supported. Create a new issue instead.' });
    }
    return items;
  }

  function moveTo(issue, transition) {
    issue.statusId = transition.to;
    if (transition.resolution) {
      issue.resolution = transition.resolution;
      issue.resolutiondate = jiraTime(now());
    }
    if (transition.clearsResolution) {
      issue.resolution = null;
      issue.resolutiondate = null;
    }
  }

  function transitionIssue(idOrKey, transitionRef, actorId, extra = {}) {
    const issue = requireLive(requireIssue(idOrKey, actorId));
    requirePermission(actorId, 'TRANSITION_ISSUES', projectOf(issue), issue);
    if (extra.update?.comment?.length) requirePermission(actorId, 'ADD_COMMENTS', projectOf(issue), issue);
    const transitionId = typeof transitionRef === 'object' ? transitionRef?.id : transitionRef;
    if (transitionId == null) throw new ApiError(400, ['You must specify a transition.']);
    const transition = findTransition(issue.statusId, transitionId);
    if (!transition) {
      throw new ApiError(400, [`Transition id '${transitionId}' is not valid for this issue.`]);
    }
    if (transition.to === '10003') {
      const open = children(issue).filter(child => status(child.statusId).category !== 'done' && type(child.typeId).subtask);
      if (open.length) {
        throw new ApiError(409, [`Finish the subtasks first: ${open.map(child => child.key).join(', ')}.`]);
      }
    }
    const fieldItems = extra.fields ? applyFields(issue, extra.fields, actorId) : [];
    const before = issue.statusId;
    const beforeResolution = issue.resolution;
    moveTo(issue, transition);
    record(issue, actorId, [
      ...fieldItems,
      { field: 'status', fromString: status(before).name, toString: status(issue.statusId).name },
      { field: 'resolution', fromString: beforeResolution, toString: issue.resolution }
    ]);
    for (const entry of extra.update?.comment ?? []) {
      if (entry.add) addComment(issue.key, entry.add.body, actorId, { persistNow: false });
    }
    persist();
    return issue;
  }

  function createIssue(body, actorId) {
    const fields = body?.fields;
    if (!fields || typeof fields !== 'object') throw new ApiError(400, ['Request body must contain "fields".']);
    const errors = {};
    if (!fields.project) errors.project = 'Specify a valid project ID or key.';
    if (!fields.issuetype) errors.issuetype = 'Specify an issue type.';
    if (!String(fields.summary ?? '').trim()) errors.summary = 'You must specify a summary of the issue.';
    if (Object.keys(errors).length) throw new ApiError(400, [], errors);
    const owner = project(fields.project);
    requirePermission(actorId, 'CREATE_ISSUES', owner);
    if (fields.assignee != null || fields.assignees?.length || fields.team != null) requirePermission(actorId, 'ASSIGN_ISSUES', owner);
    const issueType = byIdOrName(issueTypes, fields.issuetype, 'issuetype');
    const parentId = resolveParent(fields.parent, issueType, owner.id);
    data.counters.issue += 1;
    data.counters.project[owner.key] = (data.counters.project[owner.key] || 0) + 1;
    const created = jiraTime(now());
    const issue = {
      id: String(data.counters.issue),
      key: `${owner.key}-${data.counters.project[owner.key]}`,
      projectId: owner.id,
      typeId: issueType.id,
      summary: '',
      description: null,
      statusId: initialStatusId,
      priorityId: defaultPriorityId,
      assigneeId: null,
      coAssigneeIds: [],
      teamId: null,
      reporterId: actorId,
      labels: [],
      parentId,
      startdate: null,
      duedate: null,
      resolution: null,
      resolutiondate: null,
      created,
      updated: created,
      rank: Math.max(0, ...data.issues.map(other => other.rank)) + 1,
      sprintId: null,
      closedSprintIds: [],
      comments: [],
      changelog: []
    };
    try {
      applyFields(issue, fields, actorId, { creating: true });
    } catch (error) {
      data.counters.issue -= 1;
      data.counters.project[owner.key] -= 1;
      throw error;
    }
    if (!assignFields.some(name => name in fields) && owner.assigneeType === 'PROJECT_LEAD' && can(owner.leadId, 'ASSIGNABLE_USER', owner)) {
      issue.assigneeId = owner.leadId;
    }
    data.issues.push(issue);
    if (body.transition) {
      try {
        transitionIssue(issue.key, body.transition, actorId);
      } catch (error) {
        data.issues.pop();
        data.counters.project[owner.key] -= 1;
        throw error;
      }
    }
    persist();
    return issue;
  }

  function updateIssue(idOrKey, body, actorId) {
    const issue = requireLive(requireIssue(idOrKey, actorId));
    const fields = { ...(body?.fields ?? {}) };
    const touched = [...Object.keys(fields), ...Object.keys(body?.update ?? {})];
    if (touched.some(name => assignFields.includes(name))) requirePermission(actorId, 'ASSIGN_ISSUES', projectOf(issue), issue);
    if (touched.some(name => !assignFields.includes(name))) requirePermission(actorId, 'EDIT_ISSUES', projectOf(issue), issue);
    for (const [name, operations] of Object.entries(body?.update ?? {})) {
      if (name !== 'labels') throw new ApiError(400, [], { [name]: `Update operations on ${name} are not supported.` });
      let labels = [...issue.labels];
      for (const operation of operations) {
        if ('set' in operation) labels = [...operation.set];
        if ('add' in operation) labels.push(operation.add);
        if ('remove' in operation) labels = labels.filter(label => label !== operation.remove);
      }
      fields.labels = labels;
    }
    record(issue, actorId, applyFields(issue, fields, actorId));
    persist();
    return issue;
  }

  function deleteIssue(idOrKey, { deleteSubtasks = false } = {}, actorId) {
    const issue = requireIssue(idOrKey, actorId);
    requirePermission(actorId, 'DELETE_ISSUES', projectOf(issue), issue);
    const kids = children(issue);
    if (kids.length && !deleteSubtasks) {
      throw new ApiError(400, ['The issue has child issues. Set deleteSubtasks=true to delete them too.']);
    }
    const doomed = new Set([issue.id, ...kids.map(kid => kid.id)]);
    for (const kid of kids) for (const grandchild of children(kid)) doomed.add(grandchild.id);
    data.issues = data.issues.filter(candidate => !doomed.has(candidate.id));
    data.links = data.links.filter(link => !doomed.has(link.inwardId) && !doomed.has(link.outwardId));
    const orphaned = data.attachments.filter(a => doomed.has(a.issueId));
    data.attachments = data.attachments.filter(a => !doomed.has(a.issueId));
    for (const attachment of orphaned) blobs.remove(attachment.id).catch(error => console.error('Attachment cleanup failed:', error.message));
    persist();
  }

  const maxArchive = 1000;
  const archiveErrors = {
    issuesNotFound: 'Issue not found.',
    issueIsSubtask: 'Issue is subtask.',
    issuesInArchivedProjects: 'Issue exists in archived project.',
    issuesWithoutPermission: 'You need to be a site administrator or an administrator of the issue\'s project.'
  };

  function setArchived(body, actorId, archive) {
    const refs = body?.issueIdsOrKeys;
    if (!Array.isArray(refs) || refs.length === 0) throw new ApiError(400, [], { issueIdsOrKeys: 'Specify at least one issue ID or key.' });
    if (refs.length > maxArchive) throw new ApiError(400, [], { issueIdsOrKeys: `At most ${maxArchive} issues can be changed at once.` });
    const failed = {};
    const fail = (reason, ref) => (failed[reason] ??= []).push(String(ref));
    const siteAdmin = user(actorId)?.siteAdmin === true;
    const when = jiraTime(now());
    let updated = 0;
    for (const ref of new Set(refs.map(String))) {
      const issue = findIssue(ref);
      const owner = issue && projectOf(issue);
      if (!issue || !(siteAdmin || canBrowse(actorId, owner))) { fail('issuesNotFound', ref); continue; }
      if (type(issue.typeId).subtask) { fail('issueIsSubtask', ref); continue; }
      if (!isLive(owner)) { fail('issuesInArchivedProjects', ref); continue; }
      if (!siteAdmin && !can(actorId, 'ADMINISTER_PROJECTS', owner)) { fail('issuesWithoutPermission', ref); continue; }
      for (const target of [issue, ...children(issue).filter(kid => type(kid.typeId).subtask)]) {
        if (Boolean(target.archived) === archive) continue;
        target.archived = archive ? { date: when, by: actorId } : null;
        if (archive && target.sprintId != null && sprint(target.sprintId)?.state !== 'closed') target.sprintId = null;
        updated += 1;
      }
    }
    if (updated) persist();
    const errors = Object.fromEntries(Object.entries(failed).map(([reason, ids]) => [reason, { count: ids.length, issueIdsOrKeys: ids, message: archiveErrors[reason] }]));
    if (!updated && Object.keys(errors).length) {
      throw new ApiError(400, Object.values(errors).map(e => `${e.message} (${e.issueIdsOrKeys.join(', ')})`));
    }
    return { errors, numberOfIssuesUpdated: updated };
  }

  function archivedIssues(projectRef, actorId) {
    const target = requireProject(projectRef, actorId);
    if (!user(actorId)?.siteAdmin) requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    return data.issues
      .filter(issue => issue.projectId === target.id && issue.archived && !type(issue.typeId).subtask)
      .sort((a, b) => (a.archived.date < b.archived.date ? 1 : -1));
  }

  function addComment(idOrKey, body, actorId, { persistNow = true } = {}) {
    const issue = requireLive(requireIssue(idOrKey, actorId));
    requirePermission(actorId, 'ADD_COMMENTS', projectOf(issue), issue);
    const doc = commentBody(body);
    data.counters.comment += 1;
    const created = jiraTime(now());
    const comment = { id: String(data.counters.comment), authorId: actorId, body: doc, created, updated: created };
    issue.comments.push(comment);
    issue.updated = created;
    if (persistNow) persist();
    return { issue, comment };
  }

  function commentBody(body) {
    let doc;
    try { doc = normalizeRichText(body); } catch (error) { throw new ApiError(400, [], { comment: error.message }); }
    if (!doc || !adfToText(doc).trim()) throw new ApiError(400, [], { comment: 'Comment body can not be empty!' });
    return doc;
  }

  function ownedComment(idOrKey, commentId, actorId, [own, all]) {
    const issue = requireLive(requireIssue(idOrKey, actorId));
    const comment = issue.comments.find(c => c.id === String(commentId));
    if (!comment) throw new ApiError(404, [`Can not find a comment for key: ${commentId}.`]);
    const owner = projectOf(issue);
    const allowed = can(actorId, all, owner, issue) || (comment.authorId === actorId && can(actorId, own, owner, issue));
    if (!allowed) {
      throw new ApiError(403, [`You do not have the ${permissionCatalog[all].name} or ${permissionCatalog[own].name} permission for issue ${issue.key}.`]);
    }
    return { issue, comment };
  }

  function updateComment(idOrKey, commentId, body, actorId) {
    const { issue, comment } = ownedComment(idOrKey, commentId, actorId, ['EDIT_OWN_COMMENTS', 'EDIT_ALL_COMMENTS']);
    comment.body = commentBody(body);
    comment.updated = jiraTime(now());
    comment.updateAuthorId = actorId;
    persist();
    return { issue, comment };
  }

  function deleteComment(idOrKey, commentId, actorId) {
    const { issue, comment } = ownedComment(idOrKey, commentId, actorId, ['DELETE_OWN_COMMENTS', 'DELETE_ALL_COMMENTS']);
    issue.comments = issue.comments.filter(c => c !== comment);
    persist();
  }

  const byRank = (a, b) => a.rank - b.rank;

  function batch(keys, actorId) {
    if (!Array.isArray(keys) || keys.length === 0) throw new ApiError(400, [], { issues: 'Specify at least one issue.' });
    if (keys.length > maxBatch) throw new ApiError(400, [], { issues: `At most ${maxBatch} issues can be moved at once.` });
    return [...new Set(keys.map(key => requireLive(requireIssue(key, actorId))))];
  }

  function applyRank(moving, { rankBeforeIssue, rankAfterIssue }, actorId) {
    if ((rankBeforeIssue == null) === (rankAfterIssue == null)) {
      throw new ApiError(400, ['Specify exactly one of rankBeforeIssue or rankAfterIssue.']);
    }
    const anchor = requireIssue(rankBeforeIssue ?? rankAfterIssue, actorId);
    if (moving.includes(anchor)) throw new ApiError(400, ['An issue cannot be ranked relative to itself.']);
    sameProject([...moving, anchor], 'Issues can only be ranked within one project.');
    const before = new Map(data.issues.map(issue => [issue.id, issue.rank]));
    const ordered = [...data.issues].sort(byRank).filter(issue => !moving.includes(issue));
    const index = ordered.indexOf(anchor) + (rankAfterIssue != null ? 1 : 0);
    ordered.splice(index, 0, ...[...moving].sort(byRank));
    ordered.forEach((issue, position) => { issue.rank = position + 1; });
    for (const issue of moving) {
      const previous = before.get(issue.id);
      if (previous === issue.rank) continue;
      record(issue, actorId, [{ field: 'Rank', fromString: null, toString: issue.rank < previous ? 'Ranked higher' : 'Ranked lower' }]);
    }
  }

  function rankIssues(body, actorId) {
    const issues = batch(body?.issues, actorId);
    sameProject(issues, 'Issues can only be ranked within one project.');
    requireOnEach(actorId, 'SCHEDULE_ISSUES', issues);
    applyRank(issues, body ?? {}, actorId);
    persist();
  }

  const sprint = id => data.sprints.find(s => s.id === Number(id)) || null;
  const boardProject = board => data.projects.find(p => p.id === board.projectId);
  const sprintProject = target => boardProject(data.boards.find(b => b.id === target.originBoardId));
  const requireSprint = (id, actorId) => {
    const found = sprint(id);
    if (!found || (actorId && !canBrowse(actorId, sprintProject(found)))) {
      throw new ApiError(404, ['The sprint does not exist or you do not have permission to view it.']);
    }
    return found;
  };
  const requireBoard = (id, actorId) => {
    const found = data.boards.find(board => board.id === Number(id));
    if (!found || (actorId && !canBrowse(actorId, boardProject(found)))) {
      throw new ApiError(404, ['The board does not exist or you do not have permission to view it.']);
    }
    return found;
  };
  const inProject = (issues, target) => {
    const stray = issues.filter(issue => issue.projectId !== target.id);
    if (stray.length) throw new ApiError(400, [`${stray.map(i => i.key).join(', ')} not in project ${target.key}.`]);
    return issues;
  };
  const isoDate = (value, label) => {
    if (value == null || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new ApiError(400, [], { [label]: `${label} must be an ISO 8601 date.` });
    return parsed.toISOString();
  };
  const sprintName = value => {
    const name = String(value ?? '').trim();
    if (!name) throw new ApiError(400, [], { name: 'Sprint name is required.' });
    if (name.length > 60) throw new ApiError(400, [], { name: 'Sprint name must be 60 characters or fewer.' });
    return name;
  };

  function createSprint(body, actorId) {
    body ||= {};
    const board = requireBoard(body.originBoardId ?? 0, actorId);
    requirePermission(actorId, 'MANAGE_SPRINTS_PERMISSION', boardProject(board));
    const startDate = isoDate(body.startDate, 'startDate');
    const endDate = isoDate(body.endDate, 'endDate');
    if (startDate && endDate && endDate <= startDate) throw new ApiError(400, [], { endDate: 'The end date must be after the start date.' });
    data.counters.sprint += 1;
    const ordinal = data.sprints.filter(s => s.originBoardId === board.id).length + 1;
    const created = {
      id: data.counters.sprint,
      name: sprintName(body.name ?? `${boardProject(board).key} 스프린트 ${ordinal}`),
      state: 'future',
      goal: String(body.goal ?? ''),
      startDate,
      endDate,
      completeDate: null,
      createdDate: new Date(now()).toISOString(),
      originBoardId: Number(body.originBoardId)
    };
    data.sprints.push(created);
    persist();
    return created;
  }

  function closeSprint(target, actorId) {
    target.state = 'closed';
    target.completeDate = new Date(now()).toISOString();
    for (const issue of data.issues.filter(i => i.sprintId === target.id)) {
      if (status(issue.statusId).category === 'done') continue;
      issue.sprintId = null;
      issue.closedSprintIds.push(target.id);
      record(issue, actorId, [{ field: 'Sprint', fromString: target.name, toString: null }]);
    }
  }

  function updateSprint(id, body, actorId, { partial }) {
    const target = requireSprint(id, actorId);
    requirePermission(actorId, 'MANAGE_SPRINTS_PERMISSION', sprintProject(target));
    const next = partial ? { ...target, ...body } : { ...body };
    if (target.state === 'closed') {
      if ('name' in body || !partial) target.name = sprintName(next.name);
      if ('goal' in body || !partial) target.goal = String(next.goal ?? '');
      persist();
      return target;
    }
    const state = next.state ?? target.state;
    if (!sprintStates.includes(state)) throw new ApiError(400, [], { state: `Unknown sprint state "${state}".` });
    const startDate = isoDate(next.startDate, 'startDate');
    const endDate = isoDate(next.endDate, 'endDate');
    if (startDate && endDate && endDate <= startDate) throw new ApiError(400, [], { endDate: 'The end date must be after the start date.' });
    if (state !== target.state) {
      const allowed = (target.state === 'future' && state === 'active') || (target.state === 'active' && state === 'closed');
      if (!allowed) throw new ApiError(400, [`A ${target.state} sprint cannot change to ${state}.`]);
      if (state === 'active') {
        if (!startDate || !endDate) throw new ApiError(400, ['A sprint needs a start date and an end date before it can start.']);
        const running = data.sprints.find(s => s.state === 'active' && s.originBoardId === target.originBoardId);
        if (running) throw new ApiError(400, [`Sprint "${running.name}" is already active. Complete it first.`]);
      }
    }
    target.name = sprintName(next.name);
    target.goal = String(next.goal ?? '');
    target.startDate = startDate;
    target.endDate = endDate;
    if (state === 'closed' && target.state === 'active') closeSprint(target, actorId);
    target.state = state;
    persist();
    return target;
  }

  function deleteSprint(id, actorId) {
    const target = requireSprint(id, actorId);
    requirePermission(actorId, 'MANAGE_SPRINTS_PERMISSION', sprintProject(target));
    if (target.state !== 'future') throw new ApiError(400, ['Only future sprints can be deleted.']);
    for (const issue of data.issues.filter(i => i.sprintId === target.id)) issue.sprintId = null;
    data.sprints = data.sprints.filter(s => s !== target);
    persist();
  }

  function schedulable(issues) {
    for (const issue of issues) {
      const issueType = type(issue.typeId);
      if (issueType.subtask) throw new ApiError(400, [`${issue.key} is a subtask. Subtasks move with their parent.`]);
      if (issueType.hierarchyLevel > 0) throw new ApiError(400, [`${issue.key} is an epic. Epics cannot be scheduled into sprints.`]);
    }
    return issues;
  }

  function assignSprint(issues, sprintId, actorId) {
    const label = id => sprint(id)?.name ?? null;
    for (const issue of issues) {
      for (const member of [issue, ...children(issue)]) {
        if (member.sprintId === sprintId) continue;
        const from = sprint(member.sprintId)?.state === 'closed' ? null : member.sprintId;
        if (member.sprintId && sprint(member.sprintId)?.state === 'closed' && !member.closedSprintIds.includes(member.sprintId)) {
          member.closedSprintIds.push(member.sprintId);
        }
        member.sprintId = sprintId;
        record(member, actorId, [{ field: 'Sprint', fromString: label(from), toString: label(sprintId) }]);
      }
    }
  }

  function moveToSprint(id, body, actorId) {
    const target = requireSprint(id, actorId);
    const owner = sprintProject(target);
    if (target.state === 'closed') throw new ApiError(400, ['Issues can only be moved to future or active sprints.']);
    const issues = inProject(schedulable(batch(body?.issues, actorId)), owner);
    requireOnEach(actorId, 'SCHEDULE_ISSUES', issues);
    assignSprint(issues, target.id, actorId);
    if (body.rankBeforeIssue != null || body.rankAfterIssue != null) applyRank(issues, body, actorId);
    persist();
  }

  function moveToBacklog(boardId, body, actorId) {
    const owner = boardProject(requireBoard(boardId, actorId));
    const issues = inProject(schedulable(batch(body?.issues, actorId)), owner);
    requireOnEach(actorId, 'SCHEDULE_ISSUES', issues);
    assignSprint(issues, null, actorId);
    if (body.rankBeforeIssue != null || body.rankAfterIssue != null) applyRank(issues, body, actorId);
    persist();
  }

  const openSprint = issue => {
    const current = sprint(issue.sprintId);
    return current && current.state !== 'closed' ? current : null;
  };

  function boardSprints(boardId, states = sprintStates, actorId) {
    requireBoard(boardId, actorId);
    return data.sprints.filter(s => s.originBoardId === Number(boardId) && states.includes(s.state));
  }

  function backlogIssues(boardId, actorId) {
    const board = requireBoard(boardId, actorId);
    return data.issues
      .filter(issue => issue.projectId === board.projectId && !issue.archived && !openSprint(issue)
        && type(issue.typeId).hierarchyLevel === 0 && status(issue.statusId).category !== 'done')
      .sort(byRank);
  }

  function sprintIssues(id, actorId) {
    const target = requireSprint(id, actorId);
    return data.issues.filter(issue => !issue.archived && (issue.sprintId === target.id || issue.closedSprintIds.includes(target.id))).sort(byRank);
  }

  const linkType = ref => {
    const id = typeof ref === 'object' ? ref?.id : null;
    const name = typeof ref === 'object' ? ref?.name : ref;
    const found = linkTypes.find(t => (id != null && t.id === String(id)) || (name != null && t.name.toLowerCase() === String(name).toLowerCase()));
    if (!found) throw new ApiError(400, [], { issuelinks: `Issue link type "${id ?? name}" does not exist.` });
    return found;
  };

  function createLink(body, actorId) {
    if (!body?.type || !body?.inwardIssue || !body?.outwardIssue) {
      throw new ApiError(400, ['Specify type, inwardIssue and outwardIssue.']);
    }
    const kind = linkType(body.type);
    const inward = requireIssue(body.inwardIssue.key ?? body.inwardIssue.id, actorId);
    const outward = requireIssue(body.outwardIssue.key ?? body.outwardIssue.id, actorId);
    requireOnEach(actorId, 'LINK_ISSUES', [outward, inward]);
    if (inward === outward) throw new ApiError(400, ['You cannot link an issue to itself.']);
    if (data.links.some(l => l.typeId === kind.id && l.inwardId === inward.id && l.outwardId === outward.id)) {
      throw new ApiError(400, [`${outward.key} already ${kind.outward.toLowerCase()} ${inward.key}.`]);
    }
    data.counters.link += 1;
    const link = { id: String(data.counters.link), typeId: kind.id, inwardId: inward.id, outwardId: outward.id };
    data.links.push(link);
    record(outward, actorId, [{ field: 'Link', fromString: null, toString: `This issue ${kind.outward.toLowerCase()} ${inward.key}` }]);
    record(inward, actorId, [{ field: 'Link', fromString: null, toString: `This issue ${kind.inward.toLowerCase()} ${outward.key}` }]);
    if (body.comment?.body) addComment(outward.key, body.comment.body, actorId, { persistNow: false });
    persist();
    return link;
  }

  function requireLink(id, actorId) {
    const link = data.links.find(l => l.id === String(id));
    const visible = issueId => canBrowse(actorId, projectOf(data.issues.find(i => i.id === issueId)));
    if (!link || (actorId && !(visible(link.inwardId) && visible(link.outwardId)))) {
      throw new ApiError(404, ['The issue link does not exist.']);
    }
    return link;
  }

  function deleteLink(id, actorId) {
    const link = requireLink(id, actorId);
    const kind = linkType({ id: link.typeId });
    const inward = data.issues.find(i => i.id === link.inwardId);
    const outward = data.issues.find(i => i.id === link.outwardId);
    requireOnEach(actorId, 'LINK_ISSUES', [outward, inward]);
    data.links = data.links.filter(l => l !== link);
    record(outward, actorId, [{ field: 'Link', fromString: `This issue ${kind.outward.toLowerCase()} ${inward.key}`, toString: null }]);
    record(inward, actorId, [{ field: 'Link', fromString: `This issue ${kind.inward.toLowerCase()} ${outward.key}`, toString: null }]);
    persist();
  }

  const projectKeyPattern = /^[A-Z][A-Z0-9]{1,9}$/;
  const softwareTemplates = ['com.pyxis.greenhopper.jira:gh-scrum-template', 'com.pyxis.greenhopper.jira:gh-kanban-template'];

  const assigneeTypes = ['PROJECT_LEAD', 'UNASSIGNED'];

  function projectDetails(body, self, errors) {
    const values = {};
    if (!self || 'name' in body) {
      const name = String(body.name ?? '').trim();
      if (!name) errors.projectName = 'You must specify a valid project name.';
      else if (name.length > 80) errors.projectName = 'The project name must not exceed 80 characters in length.';
      else if (data.projects.some(p => p !== self && p.name.toLowerCase() === name.toLowerCase())) errors.projectName = 'A project with that name already exists.';
      values.name = name;
    }
    if (!self || 'leadAccountId' in body) {
      if (!body.leadAccountId || !user(body.leadAccountId)) errors.projectLead = 'You must specify a valid project lead.';
      values.leadId = body.leadAccountId;
    }
    if ('description' in body) {
      const description = String(body.description ?? '');
      if (description.length > 2000) errors.description = 'The description must not exceed 2000 characters.';
      values.description = description;
    }
    if ('url' in body) {
      const url = String(body.url ?? '').trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) errors.url = 'The URL must start with http:// or https://.';
      values.url = url;
    }
    if ('assigneeType' in body) {
      if (!assigneeTypes.includes(body.assigneeType)) errors.assigneeType = 'Use PROJECT_LEAD or UNASSIGNED.';
      values.assigneeType = body.assigneeType;
    }
    return values;
  }

  function createProject(body, actorId) {
    if (!user(actorId)?.siteAdmin) throw new ApiError(403, ['You must have the Administer Jira global permission to create projects.']);
    body ??= {};
    const errors = {};
    const key = String(body.key ?? '').trim();
    if (!projectKeyPattern.test(key)) errors.projectKey = 'Project keys must start with an uppercase letter, followed by 1 to 9 uppercase letters or digits.';
    else if (data.projects.some(p => p.key === key)) errors.projectKey = `Project '${data.projects.find(p => p.key === key).name}' uses this project key.`;
    const values = projectDetails(body, null, errors);
    if ((body.projectTypeKey ?? 'software') !== 'software') errors.projectTypeKey = 'Only software projects are supported.';
    if (body.projectTemplateKey != null && !softwareTemplates.includes(body.projectTemplateKey)) errors.projectTemplateKey = 'Use a scrum or kanban software template.';
    if (Object.keys(errors).length) throw new ApiError(400, [], errors);
    const id = String(Math.max(...data.projects.map(p => Number(p.id))) + 1);
    const created = {
      id, key, description: '', url: '', assigneeType: 'UNASSIGNED', status: 'live', ...values,
      roles: { [actorId]: 'administrators', [body.leadAccountId]: 'administrators' },
      scheme: defaultScheme(data, id),
      teams: []
    };
    data.projects.push(created);
    data.counters.project[key] = 0;
    data.counters.board += 1;
    const kanban = body.projectTemplateKey === softwareTemplates[1];
    data.boards.push({ id: data.counters.board, name: `${key} 보드`, type: kanban ? 'kanban' : 'scrum', projectId: id });
    persist();
    return created;
  }

  function updateProject(ref, body, actorId) {
    const target = requireProject(ref, actorId);
    requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    if (!body || typeof body !== 'object') throw new ApiError(400, ['Request body must be a JSON object.']);
    const errors = {};
    if ('key' in body && body.key !== target.key) errors.projectKey = 'Changing the project key is not supported.';
    const values = projectDetails(body, target, errors);
    if (Object.keys(errors).length) throw new ApiError(400, [], errors);
    Object.assign(target, values);
    if (values.leadId && target.roles[values.leadId] !== 'administrators') target.roles = { ...target.roles, [values.leadId]: 'administrators' };
    persist();
    return target;
  }

  function adminProject(ref, actorId) {
    const target = findProject(ref);
    const siteAdmin = user(actorId)?.siteAdmin === true;
    if (!target || (!siteAdmin && !canBrowse(actorId, target))) throw new ApiError(404, [`No project could be found with key '${ref}'.`]);
    if (!siteAdmin) throw new ApiError(403, ['You must have the Administer Jira global permission to archive, delete or restore projects.']);
    return target;
  }

  function archiveProject(ref, actorId) {
    const target = adminProject(ref, actorId);
    if (target.status === 'archived') throw new ApiError(400, ['The project is already archived.']);
    if (target.status === 'deleted') throw new ApiError(400, ['Restore the project from the trash before archiving it.']);
    Object.assign(target, { status: 'archived', archivedDate: jiraTime(now()), archivedBy: actorId });
    persist();
  }

  function purgeProject(target) {
    const doomed = new Set(data.issues.filter(i => i.projectId === target.id).map(i => i.id));
    const boards = new Set(data.boards.filter(b => b.projectId === target.id).map(b => b.id));
    data.issues = data.issues.filter(i => !doomed.has(i.id));
    data.links = data.links.filter(l => !doomed.has(l.inwardId) && !doomed.has(l.outwardId));
    data.sprints = data.sprints.filter(s => !boards.has(s.originBoardId));
    data.boards = data.boards.filter(b => !boards.has(b.id));
    data.projects = data.projects.filter(p => p !== target);
    delete data.counters.project[target.key];
  }

  function deleteProject(ref, { enableUndo = true } = {}, actorId) {
    const target = adminProject(ref, actorId);
    if (target.status === 'archived') throw new ApiError(400, ["You can't delete an archived project. Restore the project and then delete it."]);
    if (data.projects.filter(p => p.status !== 'deleted').length === 1 && target.status !== 'deleted') {
      throw new ApiError(400, ['The last active project cannot be deleted.']);
    }
    if (!enableUndo) purgeProject(target);
    else if (target.status === 'deleted') throw new ApiError(400, ['The project is already in the trash.']);
    else Object.assign(target, { status: 'deleted', deletedDate: jiraTime(now()), deletedBy: actorId });
    persist();
  }

  function restoreProject(ref, actorId) {
    const target = adminProject(ref, actorId);
    if (isLive(target)) throw new ApiError(400, ['The project is not archived or in the trash.']);
    target.status = 'live';
    for (const field of ['archivedDate', 'archivedBy', 'deletedDate', 'deletedBy']) delete target[field];
    persist();
    return target;
  }

  const visibleProjects = actorId => data.projects.filter(p => canBrowse(actorId, p));

  function projectsFor(actorId, statuses = ['live']) {
    const siteAdmin = user(actorId)?.siteAdmin === true;
    return data.projects.filter(p => statuses.includes(p.status ?? 'live') && (isLive(p) ? canBrowse(actorId, p) : siteAdmin));
  }

  const requireRole = id => {
    const role = projectRoles.find(r => r.id === Number(id));
    if (!role) throw new ApiError(404, [`Project role with id ${id} does not exist.`]);
    return role;
  };

  function roleActors(target, role) {
    return data.users
      .filter(u => target.roles[u.accountId] === role.key)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
  }

  function addRoleActors(projectRef, roleId, body, actorId) {
    const target = requireProject(projectRef, actorId);
    requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    const role = requireRole(roleId);
    const accounts = body?.user;
    if (!Array.isArray(accounts) || accounts.length === 0) throw new ApiError(400, ['Specify at least one user account ID in "user".']);
    for (const accountId of accounts) userRef(accountId, 'user');
    const next = { ...target.roles };
    for (const accountId of accounts) next[accountId] = role.key;
    if (!Object.values(next).includes('administrators')) throw new ApiError(400, ['A project must keep at least one administrator.']);
    target.roles = next;
    persist();
    return { target, role };
  }

  function removeRoleActor(projectRef, roleId, accountId, actorId) {
    const target = requireProject(projectRef, actorId);
    requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    const role = requireRole(roleId);
    if (!accountId) throw new ApiError(400, ['Specify the user to remove with the "user" query parameter.']);
    if (target.roles[accountId] !== role.key) throw new ApiError(404, [`User '${accountId}' is not a member of role ${role.name}.`]);
    const next = { ...target.roles };
    delete next[accountId];
    if (!Object.values(next).includes('administrators')) throw new ApiError(400, ['A project must keep at least one administrator.']);
    target.roles = next;
    for (const team of target.teams) team.members = team.members.filter(id => id !== accountId);
    persist();
  }

  function teamsOf(projectRef, actorId) {
    const target = requireProject(projectRef, actorId);
    return { target, teams: target.teams };
  }

  function requireTeam(target, teamId) {
    const team = target.teams.find(t => t.id === Number(teamId));
    if (!team) throw new ApiError(404, [`Team ${teamId} does not exist in project ${target.key}.`]);
    return team;
  }

  function teamValues(target, body, current) {
    if (!body || typeof body !== 'object') throw new ApiError(400, ['Request body must be a JSON object.']);
    const errors = {};
    const values = {};
    if (!current || 'name' in body) {
      const name = String(body.name ?? '').trim();
      if (!name) errors.name = 'Specify a team name.';
      else if (name.length > 40) errors.name = 'Team names can be at most 40 characters.';
      else if (target.teams.some(t => t !== current && t.name.toLowerCase() === name.toLowerCase())) errors.name = `A team named '${name}' already exists.`;
      values.name = name;
    }
    if (!current || 'members' in body) {
      const members = body.members ?? [];
      if (!Array.isArray(members)) errors.members = 'members must be a list of account IDs.';
      else {
        const outsiders = members.filter(id => !target.roles[id]);
        if (outsiders.length) errors.members = `Only project members can join a team: ${outsiders.join(', ')}.`;
        values.members = [...new Set(members.map(String))];
      }
    }
    if (Object.keys(errors).length) throw new ApiError(400, [], errors);
    return values;
  }

  function createTeam(projectRef, body, actorId) {
    const target = requireProject(projectRef, actorId);
    requirePermission(actorId, 'MANAGE_TEAMS', target);
    const values = teamValues(target, body, null);
    data.counters.team += 1;
    const team = { id: data.counters.team, ...values };
    target.teams.push(team);
    persist();
    return { target, team };
  }

  function updateTeam(projectRef, teamId, body, actorId) {
    const target = requireProject(projectRef, actorId);
    const team = requireTeam(target, teamId);
    requirePermission(actorId, 'MANAGE_TEAMS', target);
    Object.assign(team, teamValues(target, body, team));
    persist();
    return { target, team };
  }

  function deleteTeam(projectRef, teamId, actorId) {
    const target = requireProject(projectRef, actorId);
    const team = requireTeam(target, teamId);
    requirePermission(actorId, 'MANAGE_TEAMS', target);
    target.teams = target.teams.filter(t => t !== team);
    for (const issue of data.issues.filter(i => i.projectId === target.id && i.teamId === team.id)) {
      issue.teamId = null;
      record(issue, actorId, [{ field: 'team', fromString: team.name, toString: null }]);
    }
    persist();
  }

  function teamRef(target, teamId, baseUrl) {
    const team = teamId == null ? null : target.teams.find(t => t.id === teamId);
    return team ? teamView(target, team, baseUrl) : null;
  }

  function teamView(target, team, baseUrl) {
    return {
      self: `${baseUrl}/rest/api/3/project/${target.key}/team/${team.id}`,
      id: team.id,
      name: team.name,
      members: team.members.filter(id => target.roles[id]).map(id => userView(id, baseUrl))
    };
  }

  function assignableUsers({ project: projectRef, issueKey, query = '' }, actorId) {
    const target = issueKey ? projectOf(requireIssue(issueKey, actorId)) : projectRef ? requireProject(projectRef, actorId) : null;
    if (!target) throw new ApiError(400, ['Specify a project or an issue key.']);
    const needle = String(query).trim().toLowerCase();
    return data.users
      .filter(u => can(u.accountId, 'ASSIGNABLE_USER', target))
      .filter(u => !needle || u.displayName.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle));
  }

  function myPermissions(accountId, { projectKey, issueKey, keys } = {}) {
    const issue = issueKey ? requireIssue(issueKey, accountId) : null;
    const scope = issue ? [projectOf(issue)]
      : projectKey ? [requireProject(projectKey, accountId)]
        : data.projects.filter(isLive);
    return permissionReport(scope, user(accountId), keys, issue);
  }

  function schemeProject(ref, actorId) {
    const target = requireProject(ref, actorId);
    requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    return target;
  }

  function requireScheme(schemeId, actorId) {
    const target = data.projects.find(p => p.scheme?.id === Number(schemeId));
    if (!target || !canBrowse(actorId, target)) throw new ApiError(404, [`A permission scheme with ID ${schemeId} does not exist.`]);
    requirePermission(actorId, 'ADMINISTER_PROJECTS', target);
    return target;
  }

  function addGrant(schemeId, body, actorId) {
    const target = requireScheme(schemeId, actorId);
    const problem = validateGrant(body, accountId => Boolean(user(accountId)));
    if (problem) throw new ApiError(400, [problem]);
    const holder = normalizeHolder(body.holder);
    const same = g => g.permission === body.permission && g.holder.type === holder.type && g.holder.parameter === holder.parameter;
    if (target.scheme.grants.some(same)) throw new ApiError(400, ['This permission is already granted to the holder.']);
    data.counters.grant += 1;
    const grant = { id: data.counters.grant, permission: body.permission, holder };
    target.scheme.grants.push(grant);
    persist();
    return { target, grant };
  }

  function removeGrant(schemeId, grantId, actorId) {
    const target = requireScheme(schemeId, actorId);
    const grant = target.scheme.grants.find(g => g.id === Number(grantId));
    if (!grant) throw new ApiError(404, [`Permission grant ${grantId} does not exist in scheme ${schemeId}.`]);
    if (isLockedGrant(grant)) throw new ApiError(400, ['The Administrators role must keep Browse Projects and Administer Projects.']);
    target.scheme.grants = target.scheme.grants.filter(g => g !== grant);
    persist();
  }

  function schemeView(target, baseUrl, { expand = false } = {}) {
    const view = {
      self: `${baseUrl}/rest/api/3/permissionscheme/${target.scheme.id}`,
      id: target.scheme.id,
      name: `${target.name} 권한 구성표`,
      description: `${target.key} 프로젝트 전용 권한 구성표입니다.`,
      scope: { type: 'PROJECT', project: { id: target.id, key: target.key } }
    };
    if (expand) view.permissions = target.scheme.grants.map(grant => grantView(grant, baseUrl));
    return view;
  }

  function grantView(grant, baseUrl) {
    const { type: holderType, parameter } = grant.holder;
    const holder = parameter == null ? { type: holderType } : { type: holderType, parameter, value: parameter };
    if (holderType === 'user') holder.user = userView(parameter, baseUrl);
    if (holderType === 'projectRole') holder.projectRole = projectRoles.find(r => String(r.id) === parameter);
    return {
      id: grant.id,
      self: `${baseUrl}/rest/api/3/permissionscheme/permission/${grant.id}`,
      holder,
      permission: grant.permission,
      locked: isLockedGrant(grant)
    };
  }

  function boardsFor(actorId, projectRef) {
    const only = projectRef ? requireProject(projectRef, actorId) : null;
    return data.boards.filter(board => canBrowse(actorId, boardProject(board)) && (!only || board.projectId === only.id));
  }

  function authenticate(email, token) {
    const owner = data.users.find(u => u.email?.toLowerCase() === String(email).toLowerCase());
    if (!owner || owner.active === false) return null;
    const match = data.tokens.find(t => t.accountId === owner.accountId && tokenMatches(token, t.hash));
    if (!match) return null;
    match.lastUsed = new Date(now()).toISOString();
    return owner.accountId;
  }

  function createToken(accountId, label) {
    const name = String(label ?? '').trim() || 'API 토큰';
    if (name.length > 60) throw new ApiError(400, [], { label: 'Token label must be 60 characters or fewer.' });
    const token = generateToken();
    data.counters.token += 1;
    const entry = { id: String(data.counters.token), accountId, label: name, hash: hashToken(token), created: new Date(now()).toISOString(), lastUsed: null };
    data.tokens.push(entry);
    persist();
    return { ...tokenView(entry), token };
  }

  const tokenView = ({ id, label, created, lastUsed }) => ({ id, label, created, lastUsed });

  function listTokens(accountId) {
    return data.tokens.filter(t => t.accountId === accountId).map(tokenView);
  }

  function revokeToken(accountId, id) {
    const entry = data.tokens.find(t => t.id === String(id) && t.accountId === accountId);
    if (!entry) throw new ApiError(404, ['The token does not exist.']);
    data.tokens = data.tokens.filter(t => t !== entry);
    persist();
  }

  const byEmail = email => data.users.find(u => u.email?.toLowerCase() === String(email ?? '').trim().toLowerCase()) ?? null;
  const loginFailures = new Map();
  const lockAfter = 5;
  const lockMs = 60_000;
  const clock = () => Number(now());

  function checkNewPassword(password, field = 'password') {
    if (typeof password !== 'string' || password.length < minPasswordLength) {
      throw new ApiError(400, [], { [field]: `Passwords must be at least ${minPasswordLength} characters.` });
    }
    if (password.length > 200) throw new ApiError(400, [], { [field]: 'Passwords must be 200 characters or fewer.' });
  }

  function storePassword(target, password, mustChange) {
    target.passwordHash = hashPassword(password);
    target.mustChangePassword = mustChange;
    target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  }

  const needsSetup = () => !data.users.some(u => u.passwordHash);

  function login(email, password) {
    const key = String(email ?? '').trim().toLowerCase();
    const failure = loginFailures.get(key);
    if (failure?.until > clock()) throw new ApiError(429, ['Too many failed attempts. Wait a minute and try again.']);
    const owner = byEmail(email);
    if (!owner || !passwordMatches(password, owner.passwordHash)) {
      const count = (failure?.until ? 0 : failure?.count ?? 0) + 1;
      loginFailures.set(key, { count, until: count >= lockAfter ? clock() + lockMs : 0 });
      throw new ApiError(401, ['The email address or password is incorrect.']);
    }
    loginFailures.delete(key);
    if (owner.active === false) throw new ApiError(403, ['This account has been deactivated. Ask a site administrator.']);
    return owner;
  }

  function setupAdmin(email, password) {
    if (!needsSetup()) throw new ApiError(409, ['Setup is already complete. Sign in instead.']);
    const owner = byEmail(email);
    if (!owner?.siteAdmin) throw new ApiError(400, [], { email: 'Use the email address of a site administrator.' });
    checkNewPassword(password);
    storePassword(owner, password, false);
    persist();
    return owner;
  }

  function changePassword(accountId, current, next) {
    const owner = user(accountId);
    if (!passwordMatches(current, owner?.passwordHash)) throw new ApiError(400, [], { current: 'The current password is incorrect.' });
    checkNewPassword(next, 'next');
    if (current === next) throw new ApiError(400, [], { next: 'Choose a password different from the current one.' });
    storePassword(owner, next, false);
    persist();
    return owner;
  }

  function resetPassword(targetId, actorId) {
    if (!user(actorId)?.siteAdmin) throw new ApiError(403, ['Only site administrators can reset passwords.']);
    const target = user(targetId);
    if (!target) throw new ApiError(404, [`User '${targetId}' does not exist.`]);
    const temporary = generatePassword();
    storePassword(target, temporary, true);
    loginFailures.delete(String(target.email).toLowerCase());
    persist();
    return temporary;
  }

  const requireSiteAdmin = (actorId, action) => {
    if (!user(actorId)?.siteAdmin) throw new ApiError(403, [`Only site administrators can ${action}.`]);
  };

  function createUser(body, actorId) {
    requireSiteAdmin(actorId, 'create users');
    const email = String(body?.emailAddress ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 120) throw new ApiError(400, [], { emailAddress: 'Enter a valid email address.' });
    if (byEmail(email)) throw new ApiError(400, [], { emailAddress: 'A user with this email address already exists.' });
    const displayName = String(body?.displayName ?? '').trim() || email.split('@')[0];
    if (displayName.length > 60) throw new ApiError(400, [], { displayName: 'Display names must be 60 characters or fewer.' });
    let accountId;
    do accountId = `u-${randomUUID().slice(0, 8)}`; while (user(accountId));
    const created = { accountId, displayName, email, active: true };
    const temporaryPassword = generatePassword();
    storePassword(created, temporaryPassword, true);
    data.users.push(created);
    persist();
    return { user: created, temporaryPassword };
  }

  function setUserActive(accountId, active, actorId) {
    requireSiteAdmin(actorId, 'activate or deactivate users');
    const target = user(accountId);
    if (!target) throw new ApiError(404, [`User '${accountId}' does not exist.`]);
    if (typeof active !== 'boolean') throw new ApiError(400, [], { active: 'Set active to true or false.' });
    if (!active && accountId === actorId) throw new ApiError(400, ['You cannot deactivate your own account.']);
    target.active = active;
    if (!active) target.sessionVersion = (target.sessionVersion ?? 0) + 1;
    persist();
    return target;
  }

  function directory(actorId) {
    requireSiteAdmin(actorId, 'see the user directory');
    return data.users.map(u => ({
      accountId: u.accountId,
      displayName: u.displayName,
      emailAddress: u.email,
      active: u.active !== false,
      siteAdmin: u.siteAdmin === true,
      hasPassword: Boolean(u.passwordHash),
      mustChangePassword: u.mustChangePassword === true,
      projects: data.projects.filter(p => p.roles?.[u.accountId] && isLive(p)).map(p => ({ key: p.key, name: p.name, role: p.roles[u.accountId] }))
    }));
  }

  const maxAttachment = 10 * 1024 * 1024;
  const maxAttachmentsPerRequest = 10;
  const memoryBlobs = new Map();
  const blobDir = file ? join(dirname(file), 'attachments') : null;
  const blobs = {
    async write(id, bytes) {
      if (!blobDir) return void memoryBlobs.set(id, bytes);
      await mkdir(blobDir, { recursive: true });
      await writeFile(join(blobDir, id), bytes);
    },
    async read(id) {
      if (!blobDir) return memoryBlobs.get(id) ?? null;
      return readFile(join(blobDir, id)).catch(() => null);
    },
    async remove(id) {
      if (!blobDir) return void memoryBlobs.delete(id);
      await rm(join(blobDir, id), { force: true });
    }
  };

  const cleanFilename = name => {
    const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim();
    return (base || 'file').slice(-200);
  };

  async function addAttachments(idOrKey, files, actorId) {
    const issue = requireLive(requireIssue(idOrKey, actorId));
    requirePermission(actorId, 'CREATE_ATTACHMENTS', projectOf(issue), issue);
    if (!files.length) throw new ApiError(400, [], { file: 'Attach at least one file in the "file" field.' });
    if (files.length > maxAttachmentsPerRequest) throw new ApiError(400, [], { file: `At most ${maxAttachmentsPerRequest} files can be attached at once.` });
    for (const entry of files) {
      if (entry.data.length > maxAttachment) throw new ApiError(413, [`${cleanFilename(entry.filename)} is larger than ${maxAttachment / 1024 / 1024} MB.`]);
    }
    const created = jiraTime(now());
    const added = [];
    for (const entry of files) {
      data.counters.attachment += 1;
      const id = String(data.counters.attachment);
      await blobs.write(id, entry.data);
      const attachment = {
        id, issueId: issue.id, filename: cleanFilename(entry.filename),
        mimeType: String(entry.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100),
        size: entry.data.length, authorId: actorId, created
      };
      data.attachments.push(attachment);
      added.push(attachment);
    }
    record(issue, actorId, added.map(a => ({ field: 'Attachment', fieldtype: 'jira', from: null, fromString: null, to: a.id, toString: a.filename })));
    persist();
    return added;
  }

  function requireAttachment(id, actorId) {
    const attachment = data.attachments.find(a => a.id === String(id));
    const issue = attachment && findIssue(attachment.issueId);
    if (!issue || !canBrowse(actorId, projectOf(issue))) throw new ApiError(404, ['The attachment does not exist or you do not have permission to see it.']);
    return { attachment, issue };
  }

  async function attachmentContent(id, actorId) {
    const { attachment } = requireAttachment(id, actorId);
    const bytes = await blobs.read(attachment.id);
    if (!bytes) throw new ApiError(404, ['The attachment file is missing on the server.']);
    return { attachment, bytes };
  }

  async function deleteAttachment(id, actorId) {
    const { attachment, issue } = requireAttachment(id, actorId);
    requireLive(issue);
    const owner = projectOf(issue);
    const allowed = can(actorId, 'DELETE_ALL_ATTACHMENTS', owner, issue)
      || (attachment.authorId === actorId && can(actorId, 'DELETE_OWN_ATTACHMENTS', owner, issue));
    if (!allowed) throw new ApiError(403, [`You do not have the Delete All Attachments or Delete Own Attachments permission for issue ${issue.key}.`]);
    data.attachments = data.attachments.filter(a => a !== attachment);
    record(issue, actorId, [{ field: 'Attachment', fieldtype: 'jira', from: attachment.id, fromString: attachment.filename, to: null, toString: null }]);
    await blobs.remove(attachment.id);
    persist();
  }

  function attachmentView(attachment, baseUrl) {
    return {
      self: `${baseUrl}/rest/api/3/attachment/${attachment.id}`,
      id: attachment.id,
      filename: attachment.filename,
      author: userView(attachment.authorId, baseUrl),
      created: attachment.created,
      size: attachment.size,
      mimeType: attachment.mimeType,
      content: `${baseUrl}/rest/api/3/attachment/content/${attachment.id}`
    };
  }

  const accountState = accountId => {
    const owner = user(accountId);
    return owner ? {
      hasPassword: Boolean(owner.passwordHash),
      mustChangePassword: owner.mustChangePassword === true,
      sessionVersion: owner.sessionVersion ?? 0,
      active: owner.active !== false
    } : null;
  };

  const fieldValues = (field, issue) => {
    const pair = (id, name) => (id == null ? [] : [id, name]);
    switch (field) {
      case 'project': { const p = data.projects.find(x => x.id === issue.projectId); return [p.key, p.id, p.name]; }
      case 'key': case 'issuekey': case 'id': return [issue.key, issue.id];
      case 'status': return pair(issue.statusId, status(issue.statusId).name);
      case 'statuscategory': { const c = statusCategories[status(issue.statusId).category]; return [c.key, c.name]; }
      case 'issuetype': case 'type': return pair(issue.typeId, type(issue.typeId).name);
      case 'priority': return pair(issue.priorityId, priority(issue.priorityId).name);
      case 'assignee': return issuePeople(issue, projectOf(issue)).flatMap(id => pair(id, user(id)?.displayName));
      case 'team': { const t = projectOf(issue).teams.find(x => x.id === issue.teamId); return t ? [String(t.id), t.name] : []; }
      case 'reporter': return pair(issue.reporterId, user(issue.reporterId)?.displayName);
      case 'labels': return issue.labels;
      case 'parent': { const p = data.issues.find(x => x.id === issue.parentId); return p ? [p.key, p.id] : []; }
      case 'resolution': return issue.resolution ? [issue.resolution] : [];
      case 'summary': return [issue.summary];
      case 'description': return issue.description ? [adfToText(issue.description)] : [];
      case 'comment': return issue.comments.map(c => adfToText(c.body));
      case 'text': return [issue.summary, adfToText(issue.description), ...issue.comments.map(c => adfToText(c.body))];
      case 'startdate': case 'duedate': case 'created': case 'updated': return issue[field] ? [issue[field].slice(0, 10)] : [];
      case 'sprint': return [issue.sprintId, ...issue.closedSprintIds].filter(Boolean).flatMap(id => [String(id), sprint(id)?.name]);
      default: return undefined;
    }
  };

  const jqlFunctions = {
    opensprints: () => data.sprints.filter(s => s.state !== 'closed').map(s => String(s.id)),
    closedsprints: () => data.sprints.filter(s => s.state === 'closed').map(s => String(s.id))
  };

  const sortValue = (field, issue) => {
    switch (field) {
      case 'key': case 'issuekey': case 'id': return Number(issue.id);
      case 'created': case 'updated': case 'resolutiondate': return issue[field] ?? '';
      case 'startdate': case 'duedate': return issue[field] ?? '9999-12-31';
      case 'priority': return 6 - Number(issue.priorityId);
      case 'status': return statuses.findIndex(s => s.id === issue.statusId);
      case 'summary': return issue.summary.toLowerCase();
      case 'issuetype': case 'type': return Number(issue.typeId);
      case 'assignee': return user(issue.assigneeId)?.displayName ?? '\uffff';
      case 'rank': return issue.rank;
      default: return undefined;
    }
  };

  function search({ jql = '', startAt = 0, maxResults = 50, nextPageToken = null, currentUser = null } = {}) {
    let matched;
    try {
      const visible = data.issues.filter(issue => !issue.archived && (!currentUser || canBrowse(currentUser, projectOf(issue))));
      matched = runJql(jql, visible, { fieldValues, sortValue, currentUser, functions: jqlFunctions });
    } catch (error) {
      if (error instanceof JqlError) throw new ApiError(400, [`Error in the JQL Query: ${error.message}`]);
      throw error;
    }
    const limit = Math.min(Math.max(Number(maxResults) || 50, 1), 200);
    let offset = Math.max(Number(startAt) || 0, 0);
    if (nextPageToken) {
      offset = Number(Buffer.from(String(nextPageToken), 'base64url').toString());
      if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, ['The nextPageToken is not valid.']);
    }
    const page = matched.slice(offset, offset + limit);
    const more = offset + limit < matched.length;
    return {
      issues: page,
      startAt: offset,
      maxResults: limit,
      total: matched.length,
      nextPageToken: more ? Buffer.from(String(offset + limit)).toString('base64url') : undefined,
      isLast: !more
    };
  }

  function userView(id, baseUrl, { withEmail = false } = {}) {
    const found = user(id);
    if (!found) return null;
    const view = { self: `${baseUrl}/rest/api/3/user?accountId=${found.accountId}`, accountId: found.accountId, displayName: found.displayName, active: found.active !== false };
    if (withEmail) view.emailAddress = found.email;
    return view;
  }

  function sprintView(target, baseUrl) {
    if (!target) return null;
    return {
      id: target.id,
      self: `${baseUrl}/rest/agile/1.0/sprint/${target.id}`,
      state: target.state,
      name: target.name,
      startDate: target.startDate ?? undefined,
      endDate: target.endDate ?? undefined,
      completeDate: target.completeDate ?? undefined,
      createdDate: target.createdDate,
      originBoardId: target.originBoardId,
      goal: target.goal
    };
  }

  function linkTypeView(kind, baseUrl) {
    return { ...kind, self: `${baseUrl}/rest/api/3/issueLinkType/${kind.id}` };
  }

  function linkView(link, baseUrl) {
    return {
      id: link.id,
      self: `${baseUrl}/rest/api/3/issueLink/${link.id}`,
      type: linkTypeView(linkType({ id: link.typeId }), baseUrl),
      inwardIssue: summaryView(data.issues.find(i => i.id === link.inwardId), baseUrl),
      outwardIssue: summaryView(data.issues.find(i => i.id === link.outwardId), baseUrl)
    };
  }

  function issueLinks(issue, baseUrl, viewer) {
    const visible = id => !viewer || canBrowse(viewer, projectOf(data.issues.find(i => i.id === id)));
    return data.links
      .filter(link => (link.inwardId === issue.id || link.outwardId === issue.id) && visible(link.inwardId) && visible(link.outwardId))
      .map(link => {
        const kind = linkTypeView(linkType({ id: link.typeId }), baseUrl);
        const base = { id: link.id, self: `${baseUrl}/rest/api/3/issueLink/${link.id}`, type: kind };
        return link.outwardId === issue.id
          ? { ...base, inwardIssue: summaryView(data.issues.find(i => i.id === link.inwardId), baseUrl) }
          : { ...base, outwardIssue: summaryView(data.issues.find(i => i.id === link.outwardId), baseUrl) };
      });
  }

  function issueTypeView(issueType, baseUrl) {
    return { self: `${baseUrl}/rest/api/3/issuetype/${issueType.id}`, ...issueType };
  }

  function summaryView(issue, baseUrl) {
    return {
      id: issue.id,
      key: issue.key,
      self: `${baseUrl}/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        status: statusView(status(issue.statusId), baseUrl),
        priority: { ...priority(issue.priorityId), self: `${baseUrl}/rest/api/3/priority/${issue.priorityId}` },
        issuetype: issueTypeView(type(issue.typeId), baseUrl)
      }
    };
  }

  function commentView(comment, issue, baseUrl) {
    return {
      self: `${baseUrl}/rest/api/3/issue/${issue.id}/comment/${comment.id}`,
      id: comment.id,
      author: userView(comment.authorId, baseUrl),
      updateAuthor: userView(comment.updateAuthorId ?? comment.authorId, baseUrl),
      body: comment.body,
      created: comment.created,
      updated: comment.updated
    };
  }

  function projectView(target, baseUrl, viewer) {
    const board = data.boards.find(b => b.projectId === target.id);
    return {
      self: `${baseUrl}/rest/api/3/project/${target.id}`,
      id: target.id,
      key: target.key,
      name: target.name,
      description: target.description,
      url: target.url,
      assigneeType: target.assigneeType,
      projectTypeKey: 'software',
      style: 'classic',
      lead: userView(target.leadId, baseUrl),
      insight: { totalIssueCount: data.issues.filter(i => i.projectId === target.id).length },
      properties: {
        boardId: board?.id ?? null,
        boardType: board?.type ?? null,
        role: viewer ? target.roles[viewer] ?? null : undefined,
        memberCount: Object.keys(target.roles).length,
        status: target.status ?? 'live',
        archivedDate: target.archivedDate,
        archivedBy: target.archivedBy && userView(target.archivedBy, baseUrl),
        deletedDate: target.deletedDate,
        deletedBy: target.deletedBy && userView(target.deletedBy, baseUrl)
      }
    };
  }

  function roleView(target, role, baseUrl) {
    return {
      self: `${baseUrl}/rest/api/3/project/${target.key}/role/${role.id}`,
      id: role.id,
      name: role.name,
      description: role.description,
      scope: { type: 'PROJECT', project: { id: target.id, key: target.key, name: target.name } },
      actors: roleActors(target, role).map(u => ({
        displayName: u.displayName,
        type: 'atlassian-user-role-actor',
        actorUser: { accountId: u.accountId }
      }))
    };
  }

  function boardView(board, baseUrl) {
    const owner = boardProject(board);
    return {
      id: board.id,
      self: `${baseUrl}/rest/agile/1.0/board/${board.id}`,
      name: board.name,
      type: board.type,
      location: { projectId: Number(owner.id), projectKey: owner.key, projectName: owner.name, displayName: `${owner.name} (${owner.key})`, projectTypeKey: 'software' }
    };
  }

  function issueView(issue, baseUrl, { expand = [], viewer = null } = {}) {
    const owner = data.projects.find(p => p.id === issue.projectId);
    const parent = data.issues.find(candidate => candidate.id === issue.parentId);
    const view = {
      id: issue.id,
      key: issue.key,
      self: `${baseUrl}/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        description: issue.description,
        project: { self: `${baseUrl}/rest/api/3/project/${owner.id}`, id: owner.id, key: owner.key, name: owner.name },
        issuetype: issueTypeView(type(issue.typeId), baseUrl),
        status: statusView(status(issue.statusId), baseUrl),
        priority: { ...priority(issue.priorityId), self: `${baseUrl}/rest/api/3/priority/${issue.priorityId}` },
        assignee: userView(issue.assigneeId, baseUrl),
        assignees: [issue.assigneeId, ...issue.coAssigneeIds].filter(Boolean).map(id => userView(id, baseUrl)),
        team: teamRef(owner, issue.teamId, baseUrl),
        reporter: userView(issue.reporterId, baseUrl),
        labels: issue.labels,
        startdate: issue.startdate ?? null,
        duedate: issue.duedate,
        resolution: issue.resolution ? { name: issue.resolution } : null,
        resolutiondate: issue.resolutiondate,
        created: issue.created,
        updated: issue.updated,
        parent: parent ? summaryView(parent, baseUrl) : undefined,
        subtasks: children(issue).filter(child => type(child.typeId).subtask).map(child => summaryView(child, baseUrl)),
        children: children(issue).filter(child => !type(child.typeId).subtask).map(child => summaryView(child, baseUrl)),
        issuelinks: issueLinks(issue, baseUrl, viewer),
        attachment: data.attachments.filter(a => a.issueId === issue.id).map(a => attachmentView(a, baseUrl)),
        archiveddate: issue.archived?.date ?? null,
        archivedby: issue.archived ? userView(issue.archived.by, baseUrl) : null,
        sprint: sprintView(openSprint(issue), baseUrl),
        closedSprints: [...issue.closedSprintIds, ...(sprint(issue.sprintId)?.state === 'closed' ? [issue.sprintId] : [])]
          .map(id => sprintView(sprint(id), baseUrl)),
        comment: {
          comments: issue.comments.map(comment => commentView(comment, issue, baseUrl)),
          maxResults: issue.comments.length,
          total: issue.comments.length,
          startAt: 0
        }
      }
    };
    if (expand.includes('changelog')) {
      view.changelog = {
        startAt: 0,
        maxResults: issue.changelog.length,
        total: issue.changelog.length,
        histories: issue.changelog.map(entry => ({
          id: entry.id,
          author: userView(entry.authorId, baseUrl),
          created: entry.created,
          items: entry.items
        }))
      };
    }
    if (expand.includes('transitions')) {
      view.transitions = availableTransitions(issue.statusId).map(t => transitionView(t, baseUrl));
    }
    return view;
  }

  return {
    get state() { return data; },
    users: () => data.users,
    projects: () => data.projects,
    boards: () => data.boards,
    user,
    can: (accountId, key, ref) => can(accountId, key, project(ref)),
    myPermissions,
    schemeProject,
    requireScheme,
    addGrant,
    removeGrant,
    schemeView,
    grantView,
    visibleProjects,
    requireProject,
    createProject,
    updateProject,
    archiveProject,
    deleteProject,
    restoreProject,
    projectsFor,
    projectRoles: () => projectRoles,
    requireRole,
    addRoleActors,
    removeRoleActor,
    teamsOf,
    createTeam,
    updateTeam,
    deleteTeam,
    teamView,
    assignableUsers,
    boardsFor,
    requireBoard,
    projectView,
    roleView,
    boardView,
    findIssue,
    requireIssue,
    createIssue,
    updateIssue,
    deleteIssue,
    transitionIssue,
    addComment,
    updateComment,
    deleteComment,
    rankIssues,
    createSprint,
    updateSprint,
    deleteSprint,
    requireSprint,
    moveToSprint,
    moveToBacklog,
    boardSprints,
    backlogIssues,
    sprintIssues,
    createLink,
    deleteLink,
    requireLink,
    authenticate,
    needsSetup,
    login,
    setupAdmin,
    changePassword,
    resetPassword,
    accountState,
    archiveIssues: (body, actorId) => setArchived(body, actorId, true),
    unarchiveIssues: (body, actorId) => setArchived(body, actorId, false),
    archivedIssues,
    createUser,
    setUserActive,
    directory,
    addAttachments,
    requireAttachment,
    attachmentContent,
    deleteAttachment,
    attachmentView,
    maxAttachment,
    createToken,
    listTokens,
    revokeToken,
    search,
    issueView,
    userView,
    commentView,
    issueTypeView,
    sprintView,
    linkView,
    linkTypeView,
    flush: () => writing,
    pull,
    reset(next = seedState()) { data = next; return persist(); }
  };
}

export async function loadStore(file, options = {}) {
  if (isSqliteFile(file)) {
    const prepared = await prepareSql(file);
    const state = normalizeState(prepared.initial ?? seedState());
    const backend = sqliteBackend(prepared.db, file);
    if (!prepared.ready) {
      backend.write(state);
      if (prepared.importedFrom) console.log(`Imported ${prepared.importedFrom} into ${file}`);
    }
    return createStore({ ...options, file, state, backend });
  }
  let state = null;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read tracker state ${file}: ${error.message}`);
  }
  return createStore({ ...options, file, state });
}
