import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const minPasswordLength = 8;

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 64).toString('base64')}`;
}

export function passwordMatches(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  return timingSafeEqual(scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length), expected);
}

export function generatePassword() {
  return randomBytes(9).toString('base64url');
}

export const permissionCatalog = {
  BROWSE_PROJECTS: { id: '1', name: 'Browse Projects', category: 'project', description: '프로젝트와 이슈를 볼 수 있습니다.' },
  CREATE_ISSUES: { id: '2', name: 'Create Issues', category: 'issue', description: '이슈를 만들 수 있습니다.' },
  EDIT_ISSUES: { id: '3', name: 'Edit Issues', category: 'issue', issueScoped: true, description: '이슈 필드를 수정할 수 있습니다.' },
  ASSIGN_ISSUES: { id: '4', name: 'Assign Issues', category: 'issue', issueScoped: true, description: '담당자를 바꿀 수 있습니다.' },
  TRANSITION_ISSUES: { id: '5', name: 'Transition Issues', category: 'issue', issueScoped: true, description: '이슈 상태를 바꿀 수 있습니다.' },
  DELETE_ISSUES: { id: '6', name: 'Delete Issues', category: 'issue', issueScoped: true, description: '이슈를 삭제할 수 있습니다.' },
  ADD_COMMENTS: { id: '7', name: 'Add Comments', category: 'comment', issueScoped: true, description: '댓글을 남길 수 있습니다.' },
  LINK_ISSUES: { id: '8', name: 'Link Issues', category: 'issue', issueScoped: true, description: '이슈를 서로 연결할 수 있습니다.' },
  SCHEDULE_ISSUES: { id: '9', name: 'Schedule Issues', category: 'issue', issueScoped: true, description: '랭크와 스프린트를 조정할 수 있습니다.' },
  MANAGE_SPRINTS_PERMISSION: { id: '10', name: 'Manage Sprints', category: 'project', description: '스프린트를 만들고 시작·완료할 수 있습니다.' },
  ASSIGNABLE_USER: { id: '11', name: 'Assignable User', category: 'issue', description: '이슈의 담당자가 될 수 있습니다.' },
  ADMINISTER_PROJECTS: { id: '12', name: 'Administer Projects', category: 'project', description: '프로젝트 설정, 멤버, 권한을 관리할 수 있습니다.' },
  EDIT_OWN_COMMENTS: { id: '13', name: 'Edit Own Comments', category: 'comment', issueScoped: true, description: '자기가 쓴 댓글을 고칠 수 있습니다.' },
  EDIT_ALL_COMMENTS: { id: '14', name: 'Edit All Comments', category: 'comment', issueScoped: true, description: '누가 쓴 댓글이든 고칠 수 있습니다.' },
  DELETE_OWN_COMMENTS: { id: '15', name: 'Delete Own Comments', category: 'comment', issueScoped: true, description: '자기가 쓴 댓글을 지울 수 있습니다.' },
  DELETE_ALL_COMMENTS: { id: '16', name: 'Delete All Comments', category: 'comment', issueScoped: true, description: '누가 쓴 댓글이든 지울 수 있습니다.' },
  MANAGE_TEAMS: { id: '17', name: 'Manage Teams', category: 'project', description: '팀을 만들고 팀원을 정할 수 있습니다.' },
  CREATE_ATTACHMENTS: { id: '18', name: 'Create Attachments', category: 'attachment', issueScoped: true, description: '이슈에 파일을 첨부할 수 있습니다.' },
  DELETE_OWN_ATTACHMENTS: { id: '19', name: 'Delete Own Attachments', category: 'attachment', issueScoped: true, description: '자기가 올린 첨부파일을 지울 수 있습니다.' },
  DELETE_ALL_ATTACHMENTS: { id: '20', name: 'Delete All Attachments', category: 'attachment', issueScoped: true, description: '누가 올린 첨부파일이든 지울 수 있습니다.' },
  ADMINISTER: { id: '0', name: 'Administer Jira', description: '프로젝트를 만들고 보관·삭제할 수 있습니다.', type: 'GLOBAL' }
};

export const projectPermissionKeys = Object.keys(permissionCatalog).filter(key => permissionCatalog[key].type !== 'GLOBAL');
const memberDenied = new Set(['DELETE_ISSUES', 'MANAGE_SPRINTS_PERMISSION', 'ADMINISTER_PROJECTS', 'EDIT_ALL_COMMENTS', 'DELETE_ALL_COMMENTS', 'MANAGE_TEAMS', 'DELETE_ALL_ATTACHMENTS']);

export const roleGrants = {
  administrators: new Set(projectPermissionKeys),
  deputies: new Set(projectPermissionKeys.filter(key => key !== 'ADMINISTER_PROJECTS')),
  members: new Set(projectPermissionKeys.filter(key => !memberDenied.has(key))),
  viewers: new Set(['BROWSE_PROJECTS'])
};

export const roleLabels = { administrators: '관리자', deputies: '부관리자', members: '멤버', viewers: '보기 전용' };

export const projectRoles = [
  { id: 10002, key: 'administrators', name: 'Administrators', description: '프로젝트의 모든 작업과 멤버 관리를 할 수 있습니다.' },
  { id: 10003, key: 'deputies', name: 'Deputy administrators', description: '팀, 스프린트, 이슈 정리를 맡습니다. 멤버와 권한 설정은 할 수 없습니다.' },
  { id: 10000, key: 'members', name: 'Members', description: '이슈를 만들고 처리합니다. 삭제와 스프린트 관리는 할 수 없습니다.' },
  { id: 10001, key: 'viewers', name: 'Viewers', description: '프로젝트를 볼 수만 있습니다.' }
];

export const holderTypes = ['projectRole', 'user', 'projectLead', 'reporter', 'assignee'];
const issueHolders = new Set(['reporter', 'assignee']);
const administratorsRole = '10002';
const deputiesRole = '10003';
export const lockedGrants = ['ADMINISTER_PROJECTS', 'BROWSE_PROJECTS'];

export function isLockedGrant(grant) {
  return grant.holder.type === 'projectRole' && grant.holder.parameter === administratorsRole && lockedGrants.includes(grant.permission);
}

export function defaultGrants() {
  return projectRoles.flatMap(role => projectPermissionKeys
    .filter(key => roleGrants[role.key].has(key))
    .map(permission => ({ permission, holder: { type: 'projectRole', parameter: String(role.id) } })));
}

const forRole = role => grant => grant.holder.type === 'projectRole' && grant.holder.parameter === role;

const schemeUpgrades = {
  teams: grants => {
    const added = [];
    if (!grants.some(forRole(deputiesRole))) added.push(...defaultGrants().filter(forRole(deputiesRole)));
    if (!grants.some(g => g.permission === 'MANAGE_TEAMS' && forRole(administratorsRole)(g))) {
      added.push({ permission: 'MANAGE_TEAMS', holder: { type: 'projectRole', parameter: administratorsRole } });
    }
    return added;
  },
  attachments: grants => {
    const keys = ['CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS'];
    return defaultGrants().filter(grant => keys.includes(grant.permission)
      && !grants.some(g => g.permission === grant.permission && g.holder.parameter === grant.holder.parameter));
  }
};

export function upgradeScheme(scheme, nextId) {
  scheme.upgrades ??= [];
  for (const [name, missing] of Object.entries(schemeUpgrades)) {
    if (scheme.upgrades.includes(name)) continue;
    for (const grant of missing(scheme.grants)) scheme.grants.push({ id: nextId(), ...grant });
    scheme.upgrades.push(name);
  }
  return scheme;
}

export function validateGrant(body, userExists) {
  const permission = body?.permission;
  const holder = body?.holder ?? {};
  const parameter = holder.value ?? holder.parameter;
  if (!projectPermissionKeys.includes(permission)) return `Permission '${permission}' is not a project permission.`;
  if (!holderTypes.includes(holder.type)) return `Holder type '${holder.type}' is not supported. Use ${holderTypes.join(', ')}.`;
  if (holder.type === 'projectRole' && !projectRoles.some(r => String(r.id) === String(parameter))) return `Project role '${parameter}' does not exist.`;
  if (holder.type === 'user' && !userExists(parameter)) return `User '${parameter}' does not exist.`;
  if (issueHolders.has(holder.type) && !permissionCatalog[permission].issueScoped) {
    return `${permissionCatalog[permission].name} is a project-wide permission and cannot be granted to the ${holder.type}.`;
  }
  return null;
}

export function normalizeHolder(holder) {
  const parameter = holder.value ?? holder.parameter;
  return ['projectRole', 'user'].includes(holder.type) ? { type: holder.type, parameter: String(parameter) } : { type: holder.type };
}

export function issuePeople(issue, project) {
  const team = issue.teamId == null ? null : project?.teams?.find(t => t.id === issue.teamId);
  return [...new Set([issue.assigneeId, ...(issue.coAssigneeIds ?? []), ...(team?.members ?? [])].filter(Boolean))];
}

export function holderMatches(holder, project, accountId, issue) {
  switch (holder.type) {
    case 'projectRole': return projectRoles.find(r => String(r.id) === holder.parameter)?.key === project.roles?.[accountId];
    case 'user': return holder.parameter === accountId;
    case 'projectLead': return project.leadId === accountId;
    case 'reporter': return Boolean(issue) && issue.reporterId === accountId;
    case 'assignee': return Boolean(issue) && issuePeople(issue, project).includes(accountId);
    default: return false;
  }
}

export function hasPermission(project, accountId, key, issue = null) {
  if (!project || !accountId) return false;
  const grants = project.scheme?.grants;
  if (!grants) return Boolean(roleGrants[project.roles?.[accountId]]?.has(key));
  return grants.some(grant => grant.permission === key && holderMatches(grant.holder, project, accountId, issue));
}

export function permissionReport(projects, user, keys = Object.keys(permissionCatalog), issue = null) {
  const permissions = {};
  for (const key of keys) {
    const entry = permissionCatalog[key];
    if (!entry) continue;
    const type = entry.type ?? 'PROJECT';
    const havePermission = type === 'GLOBAL'
      ? Boolean(user?.siteAdmin)
      : projects.some(project => hasPermission(project, user?.accountId, key, issue));
    permissions[key] = { id: entry.id, key, name: entry.name, type, description: entry.description, havePermission };
  }
  return { permissions };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken() {
  return `ost_${randomBytes(24).toString('base64url')}`;
}

export function tokenMatches(token, hash) {
  const candidate = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function parseBasicAuth(header) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 1) return null;
  return { email: decoded.slice(0, split), token: decoded.slice(split + 1) };
}
