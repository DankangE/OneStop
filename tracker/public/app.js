import { api, currentUserId, setCurrentUserId, setCredentials, clearCredentials, hasCredentials, setAuthMode, onSignedOut, savedProjectKey, saveProjectKey, savedSet, saveSet, savedPref, savePref } from './api.js';
import { h, renderBoard, renderList, renderDetail, renderBacklog, renderLogin, renderMembers, renderSettings, renderProjectAdmin, renderPermissions, renderCalendar, moveSpan, assigneePicker, sprintBanner, sprintForm, projectForm, tokensPanel, passwordDialog, temporaryPasswordDialog, renderHome, renderUsers, archivePanel, labels, roleLabel } from './views.js';
import { homeSummary } from './home.js';
import { groupLanes, recentDoneDays, isStaleDone } from './tree.js';
import { localToday, shiftMonth, peopleOf, toDay, fromDay } from './calendar.js';
import { resolvedTheme, toggledTheme } from './theme.js';

const state = {
  authMode: 'none',
  meta: null,
  me: null,
  siteAdmin: false,
  project: null,
  perms: {},
  assignable: [],
  teams: [],
  roles: [],
  issues: [],
  sprints: [],
  allSprints: [],
  detail: null,
  detailContext: null,
  adminStatus: 'live',
  adminProjects: [],
  boardFilter: { text: '', mine: false, epic: '' },
  listError: null,
  listIssues: [],
  scheme: null,
  inspect: null,
  prefs: {
    group: savedPref('boardGroup', 'none'),
    nest: savedPref('nestSubtasks', 'true') === 'true',
    listTree: savedPref('listTree', 'true') === 'true'
  },
  openCards: savedSet('openCards'),
  closedLanes: savedSet('closedLanes'),
  closedRows: savedSet('closedRows'),
  openKids: savedSet('openKids'),
  calendar: {
    month: localToday().slice(0, 7),
    mode: savedPref('calendarMode', 'month'),
    hideDone: savedPref('calendarHideDone', 'false') === 'true',
    selected: savedSet('calendarPeople')
  },
  showOldDone: false,
  archiveDays: Number(savedPref('archiveDays', '90')) || 90
};

const setNames = { openCards: 'openCards', closedLanes: 'closedLanes', closedRows: 'closedRows', openKids: 'openKids' };

function flip(name, key, redraw = renderMain) {
  const set = state[name];
  if (set.has(key)) set.delete(key);
  else set.add(key);
  saveSet(setNames[name], set);
  redraw();
}

function setPref(name, stored, value) {
  state.prefs[name] = value;
  savePref(stored, value);
  renderMain();
}

const main = document.querySelector('#main');
const drawer = document.querySelector('#drawer');
const toast = document.querySelector('#toast');
const dialog = document.querySelector('#create-dialog');
const form = document.querySelector('#create-form');
const auxDialog = document.querySelector('#aux-dialog');
const account = document.querySelector('#account');
const switcher = document.querySelector('#project-switch');
const createButton = document.querySelector('#create-open');
const backlogLink = document.querySelector('[data-nav=backlog]');
const settingsLink = document.querySelector('[data-nav=settings]');
const permissionsLink = document.querySelector('[data-nav=permissions]');
const usersLink = document.querySelector('[data-nav=users]');
const sidenav = document.querySelector('#sidenav');
const navToggle = document.querySelector('#nav-toggle');
const navBackdrop = document.querySelector('#nav-backdrop');
const themeToggle = document.querySelector('#theme-toggle');
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function paintThemeToggle() {
  const dark = resolvedTheme(document.documentElement.dataset.theme, themeQuery.matches) === 'dark';
  themeToggle.textContent = dark ? '라이트' : '다크';
  themeToggle.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
  themeToggle.setAttribute('aria-pressed', String(dark));
}

paintThemeToggle();
themeToggle.addEventListener('click', () => {
  const next = toggledTheme(resolvedTheme(document.documentElement.dataset.theme, themeQuery.matches));
  document.documentElement.dataset.theme = next;
  savePref('theme', next);
  paintThemeToggle();
});
themeQuery.addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) paintThemeToggle();
});

function setNavOpen(open) {
  const next = Boolean(open);
  sidenav.classList.toggle('open', next);
  document.body.classList.toggle('nav-open', next);
  navToggle.setAttribute('aria-expanded', String(next));
  navBackdrop.hidden = !next;
}

const toPerms = report => Object.fromEntries(Object.values(report.permissions).map(p => [p.key, p.havePermission]));
const projectKey = () => state.project?.key;
const boardId = () => state.project?.properties.boardId;
const isScrum = () => state.project?.properties.boardType === 'scrum';

function notify(message, tone = 'info') {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function fail(error) {
  if (error.status === 401 && state.authMode !== 'none') {
    clearCredentials();
    showLogin('로그인이 만료되었습니다. 다시 로그인해 주세요.');
    return;
  }
  notify(error.message, 'error');
}

function readRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const view = { '/home': 'home', '/users': 'users', '/list': 'list', '/calendar': 'calendar', '/backlog': 'backlog', '/members': 'members', '/permissions': 'permissions', '/settings': 'settings', '/projects': 'projects' }[path] ?? 'board';
  return { view, params };
}

function go(view, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const hash = `#/${view}${query.size ? `?${query}` : ''}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

function openIssue(key) {
  const { view, params } = readRoute();
  go(view, { jql: params.get('jql'), issue: key });
}

function closeIssue() {
  const { view, params } = readRoute();
  go(view, { jql: params.get('jql') });
}

async function loadMeta() {
  if (state.authMode === 'none') {
    const users = await api.users();
    if (!currentUserId() || !users.some(u => u.accountId === currentUserId())) setCurrentUserId(users[0].accountId);
  }
  const [users, projects, issueTypes, priorities, statuses, linkTypes, me, global] = await Promise.all([
    api.users(), api.projects(), api.issueTypes(), api.priorities(), api.statuses(), api.linkTypes(), api.myself(), api.globalPermissions()
  ]);
  state.meta = { users, projects, issueTypes, priorities, statuses, linkTypes: linkTypes.issueLinkTypes };
  state.me = me;
  state.siteAdmin = toPerms(global).ADMINISTER === true;
  await loadProject();
  renderChrome();
}

async function loadProject() {
  const projects = state.meta.projects;
  state.project = projects.find(p => p.key === savedProjectKey()) ?? projects[0] ?? null;
  if (!state.project) {
    Object.assign(state, { perms: {}, assignable: [], roles: [], teams: [] });
    return;
  }
  const key = state.project.key;
  saveProjectKey(key);
  const [permissions, assignable, roleLinks, teams] = await Promise.all([api.permissions(key), api.assignable(key), api.roles(key), api.teams(key)]);
  const roles = await Promise.all(Object.values(roleLinks).map(link => api.role(key, link.split('/').pop())));
  state.perms = toPerms(permissions);
  state.assignable = assignable;
  state.teams = teams;
  state.roles = roles.map(role => ({ role, actors: role.actors }));
}

function roleOf(accountId) {
  const held = state.roles.find(({ actors }) => actors.some(a => a.actorUser.accountId === accountId));
  return held ? roleLabel[held.role.name.toLowerCase()] : '참여 안 함';
}

async function switchProject(key, view = readRoute().view) {
  saveProjectKey(key);
  state.boardFilter = { text: '', mine: false, epic: '' };
  try {
    await loadProject();
    renderChrome();
    await refreshIssues();
    go(view);
  } catch (error) {
    fail(error);
  }
}

async function refreshProjects() {
  state.meta.projects = await api.projects();
  await loadProject();
  renderChrome();
  await refreshIssues();
}

async function projectAction(work, message, { toList = false } = {}) {
  try {
    await work();
    notify(message);
    await refreshProjects();
    if (toList) go('projects');
    else await render();
  } catch (error) {
    fail(error);
  }
}

const issueCount = project => project.insight.totalIssueCount;

function archiveProject(project) {
  if (!confirm(`${project.name}(${project.key})을(를) 보관할까요?\n목록과 검색에서 사라지고 편집할 수 없게 됩니다. 프로젝트 관리의 보관됨 탭에서 복원할 수 있습니다.`)) return;
  state.adminStatus = 'archived';
  projectAction(() => api.archiveProject(project.key), `${project.key} 프로젝트를 보관했습니다.`, { toList: true });
}

function trashProject(project) {
  if (!confirm(`${project.name}(${project.key})을(를) 휴지통으로 옮길까요?\n이슈 ${issueCount(project)}개도 함께 숨겨집니다. 휴지통에서 복원할 수 있습니다.`)) return;
  state.adminStatus = 'deleted';
  projectAction(() => api.deleteProject(project.key, true), `${project.key} 프로젝트를 휴지통으로 옮겼습니다.`, { toList: true });
}

function restoreProject(project) {
  projectAction(() => api.restoreProject(project.key), `${project.key} 프로젝트를 복원했습니다.`);
}

function purgeProject(project) {
  const typed = prompt(`${project.name}을(를) 영구 삭제하면 이슈 ${issueCount(project)}개와 보드, 스프린트, 링크가 모두 사라지며 되돌릴 수 없습니다.\n확인하려면 프로젝트 키 ${project.key}을(를) 입력하세요.`);
  if (typed == null) return;
  if (typed.trim().toUpperCase() !== project.key) {
    notify('키가 맞지 않아 삭제하지 않았습니다.', 'warn');
    return;
  }
  projectAction(() => api.deleteProject(project.key, false), `${project.key} 프로젝트를 영구 삭제했습니다.`);
}

function openProjectForm() {
  projectForm(auxDialog, {
    users: state.meta.users,
    lead: state.me.accountId,
    onSubmit: async body => {
      const created = await api.createProject(body);
      state.meta.projects = await api.projects();
      notify(`${created.key} 프로젝트를 만들었습니다. 멤버를 추가해 보세요.`);
      saveProjectKey(created.key);
      await loadProject();
      renderChrome();
      await refreshIssues();
      go('members');
    }
  });
}

function renderProjectSwitch() {
  const options = state.meta.projects.map(p => h('option', { value: p.key, selected: p.key === projectKey() }, `${p.name} (${p.key})`));
  if (!options.length) options.push(h('option', { value: '', selected: true }, '프로젝트 없음'));
  options.push(h('hr'), h('option', { value: '__manage' }, '프로젝트 관리…'));
  if (state.siteAdmin) options.push(h('option', { value: '__new' }, '+ 새 프로젝트…'));
  switcher.replaceChildren(h('select', { 'aria-label': '프로젝트', onChange: event => {
    const key = event.target.value;
    event.target.value = projectKey() ?? '';
    if (key === '__manage') go('projects');
    else if (key === '__new') openProjectForm();
    else if (key) switchProject(key);
  } }, options));
}

const inbox = document.querySelector('#inbox');
const inboxToggle = document.querySelector('#inbox-toggle');
const inboxPanel = document.querySelector('#inbox-panel');
let inboxOpen = false;
let inboxTimer = null;

function inboxWhen(iso) {
  return new Date(String(iso).replace('+0000', 'Z')).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderInbox() {
  const unread = state.inbox?.unread ?? 0;
  inboxToggle.replaceChildren('알림');
  if (unread) inboxToggle.append(h('span', { class: 'inbox-count' }, String(unread)));
  inboxToggle.setAttribute('aria-expanded', String(inboxOpen));
  inboxPanel.hidden = !inboxOpen;
  if (!inboxOpen) return;
  const items = state.inbox?.notifications ?? [];
  inboxPanel.replaceChildren(
    h('div', { class: 'inbox-head' },
      h('h2', {}, '알림'),
      h('span', { class: 'spacer' }),
      unread ? h('button', { class: 'button ghost small', type: 'button', onClick: async () => {
        await api.readNotifications();
        await refreshInbox();
      } }, '모두 읽음') : null),
    items.length ? h('ul', { class: 'inbox-list' }, items.map(item => h('li', {}, h('button', {
      class: `inbox-item${item.read ? ' read' : ''}`,
      type: 'button',
      onClick: async () => {
        if (!item.read) await api.readNotification(item.id);
        inboxOpen = false;
        renderInbox();
        openIssue(item.issueKey);
        refreshInbox();
      }
    }, h('strong', {}, item.text), h('span', { class: 'muted small' }, `${item.issueKey} · ${inboxWhen(item.created)}`)))))
      : h('p', { class: 'muted small' }, '새 알림이 없습니다.'));
}

async function refreshInbox() {
  if (!state.meta) return;
  try {
    state.inbox = await api.notifications();
  } catch (error) {
    if (error.status === 401) fail(error);
    return;
  }
  renderInbox();
}

function renderChrome() {
  renderProjectSwitch();
  backlogLink.hidden = !isScrum();
  settingsLink.hidden = !state.project || !(state.perms.ADMINISTER_PROJECTS || state.siteAdmin);
  permissionsLink.hidden = !state.project || !state.perms.ADMINISTER_PROJECTS;
  usersLink.hidden = !state.siteAdmin;
  renderAccount();
  renderInbox();
}

function renderAccount() {
  createButton.hidden = !state.perms.CREATE_ISSUES;
  if (state.authMode === 'none') {
    const picker = h('select', { 'aria-label': '작업자', title: '괄호 안은 현재 프로젝트에서의 역할입니다', onChange: async event => {
      setCurrentUserId(event.target.value);
      notify(`${state.meta.users.find(u => u.accountId === event.target.value).displayName}(으)로 작업합니다.`);
      await reload();
    } }, state.meta.users.map(u => h('option', { value: u.accountId, selected: u.accountId === currentUserId() }, `${u.displayName} (${roleOf(u.accountId)})`)));
    account.replaceChildren(h('label', { class: 'who-am-i' }, '작업자', picker));
    return;
  }
  account.replaceChildren(
    h('span', { class: 'identity' }, h('strong', {}, state.me.displayName), h('span', { class: 'muted small' }, state.me.emailAddress)),
    state.authMode === 'login'
      ? h('button', { class: 'button ghost', type: 'button', onClick: () => passwordDialog(auxDialog, {
        onSubmit: async (current, next) => {
          await api.changePassword(current, next);
          notify('비밀번호를 바꿨습니다.');
        }
      }) }, '비밀번호')
      : null,
    h('button', { class: 'button ghost', type: 'button', onClick: () => tokensPanel(auxDialog, {
      load: api.tokens,
      create: api.createToken,
      revoke: api.revokeToken
    }) }, 'API 토큰'),
    h('button', { class: 'button ghost', type: 'button', onClick: signOut }, '로그아웃'));
}

async function createUser(email, name, joinProject) {
  const created = await api.createUser(email, name);
  if (joinProject && state.project) {
    await api.addToRole(projectKey(), 10000, [created.accountId]).catch(error => notify(`사용자는 만들었지만 프로젝트에 추가하지 못했습니다: ${error.message}`, 'error'));
  }
  temporaryPasswordDialog(auxDialog, { user: created, password: created.temporaryPassword });
  notify(`${created.displayName}님을 추가했습니다.`);
  await reload();
}

async function signOut() {
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
  inboxOpen = false;
  if (state.authMode === 'login') await api.logout().catch(() => {});
  clearCredentials();
  showLogin();
}

async function refreshIssues() {
  if (!state.project) {
    Object.assign(state, { issues: [], sprints: [], allSprints: [] });
    return;
  }
  const [result, sprints] = await Promise.all([
    api.searchAll(`project = ${projectKey()} ORDER BY rank ASC`),
    isScrum() ? api.sprints(boardId(), 'future,active,closed') : { values: [] }
  ]);
  state.issues = result.issues;
  state.allSprints = sprints.values;
  state.sprints = sprints.values.filter(s => s.state !== 'closed');
}

const activeSprint = () => state.sprints.find(s => s.state === 'active') ?? null;

function boardIssues() {
  const { text, mine, epic } = state.boardFilter;
  const needle = text.trim().toLowerCase();
  const sprint = activeSprint();
  const shown = state.issues.filter(issue => {
    const f = issue.fields;
    if (f.issuetype.name === 'Epic') return false;
    if (sprint && f.sprint?.id !== sprint.id) return false;
    if (mine && !isMine(issue)) return false;
    if (epic) {
      const parentKey = f.parent?.key;
      const grandParent = parentKey && state.issues.find(i => i.key === parentKey)?.fields.parent?.key;
      if (parentKey !== epic && grandParent !== epic) return false;
    }
    if (needle && !`${issue.key} ${f.summary}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  if (!state.prefs.nest) return shown;
  const onBoard = new Set(shown.map(issue => issue.key));
  return shown.filter(issue => !(issue.fields.issuetype.subtask && onBoard.has(issue.fields.parent?.key)));
}

const isMine = issue => peopleOf(issue).some(person => person.accountId === state.me.accountId);
const mineToMove = issue => isMine(issue) || issue.fields.reporter?.accountId === state.me.accountId;
const canMoveCard = issue => Boolean(state.perms.TRANSITION_ISSUES || state.perms.SCHEDULE_ISSUES || mineToMove(issue));

function boardToolbar() {
  const epics = state.issues.filter(issue => issue.fields.issuetype.name === 'Epic');
  const done = epics.map(epic => {
    const kids = state.issues.filter(i => i.fields.parent?.key === epic.key);
    const finished = kids.filter(i => i.fields.status.statusCategory.key === 'done').length;
    return { epic, kids: kids.length, finished };
  });
  return h('div', { class: 'toolbar' },
    h('input', {
      type: 'search', class: 'quick', placeholder: '키 또는 요약으로 찾기', value: state.boardFilter.text, 'aria-label': '보드 검색',
      onInput: event => {
        state.boardFilter.text = event.target.value;
        renderMain();
        const quick = main.querySelector('.quick');
        quick.focus();
        quick.setSelectionRange(quick.value.length, quick.value.length);
      }
    }),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: state.boardFilter.mine, onChange: event => { state.boardFilter.mine = event.target.checked; renderMain(); } }),
      '내 담당만'),
    h('label', { class: 'toggle', title: '상위 카드가 보드에 있으면 하위 작업은 그 카드 안에 접어 둡니다' },
      h('input', { type: 'checkbox', checked: state.prefs.nest, onChange: event => setPref('nest', 'nestSubtasks', event.target.checked) }),
      '하위 작업은 상위 카드 안에'),
    h('label', { class: 'toggle' }, '묶기',
      h('select', { class: 'group-by', 'aria-label': '보드 묶기 기준', onChange: event => setPref('group', 'boardGroup', event.target.value) },
        [['none', '없음'], ['epic', '에픽별'], ['assignee', '담당자별']].map(([value, label]) => h('option', { value, selected: state.prefs.group === value }, label)))),
    h('div', { class: 'epics', role: 'group', 'aria-label': '에픽 필터' },
      done.map(({ epic, kids, finished }) => h('button', {
        class: `epic-chip${state.boardFilter.epic === epic.key ? ' on' : ''}`,
        'aria-pressed': String(state.boardFilter.epic === epic.key),
        onClick: () => { state.boardFilter.epic = state.boardFilter.epic === epic.key ? '' : epic.key; renderMain(); },
        onDblclick: () => openIssue(epic.key),
        title: `${epic.key} · 더블클릭하면 에픽을 엽니다`
      },
      h('span', { class: 'epic-name' }, epic.fields.summary),
      h('span', { class: 'meter', style: `--ratio:${kids ? finished / kids : 0}` }),
      h('span', { class: 'num small' }, `${finished}/${kids}`)))));
}

async function moveCard(key, status, rank) {
  const issue = state.issues.find(i => i.key === key);
  if (!issue) return;
  const moving = issue.fields.status.id !== status.id;
  if (!moving && !rank) return;
  try {
    if (moving) {
      const { transitions } = await api.transitions(key);
      const transition = transitions.find(t => t.to.id === status.id);
      if (!transition) {
        const from = labels.status[issue.fields.status.name];
        notify(`${from}에서 ${labels.status[status.name]}(으)로는 바로 옮길 수 없습니다. 워크플로 순서를 따라 주세요.`, 'warn');
        return;
      }
      await api.transition(key, transition.id);
      notify(`${key}: ${labels.transition[transition.name] ?? transition.name}`);
    }
    if (rank && (state.perms.SCHEDULE_ISSUES || !moving)) await api.rank([key], rank);
    await refreshAll();
  } catch (error) {
    fail(error);
    await refreshAll().catch(() => {});
  }
}

async function run(work, message) {
  try {
    await work();
    if (message) notify(message);
  } catch (error) {
    fail(error);
  }
  await refreshAll().catch(fail);
}

function completeSprint(sprint) {
  const members = state.issues.filter(i => i.fields.sprint?.id === sprint.id && !i.fields.issuetype.subtask);
  const open = members.filter(i => i.fields.status.statusCategory.key !== 'done').length;
  const note = open ? `끝나지 않은 이슈 ${open}개는 백로그로 돌아갑니다.` : '모든 이슈를 끝냈습니다.';
  if (!confirm(`${sprint.name}을(를) 완료할까요? ${note}`)) return;
  run(() => api.updateSprint(sprint.id, { state: 'closed' }), `${sprint.name}을(를) 완료했습니다.`);
}

function moveInBacklog(key, target, rank) {
  const issue = state.issues.find(i => i.key === key);
  if (!issue) return;
  const current = issue.fields.sprint?.id ?? null;
  const destination = target.sprint?.id ?? null;
  if (current === destination) {
    if (rank) run(() => api.rank([key], rank));
    return;
  }
  const extra = rank ?? {};
  run(() => (destination ? api.moveToSprint(destination, [key], extra) : api.moveToBacklog(boardId(), [key], extra)),
    destination ? `${key} 이슈를 ${target.sprint.name}에 넣었습니다.` : `${key} 이슈를 백로그로 옮겼습니다.`);
}

async function changeMembers(work, message) {
  try {
    await work();
    notify(message);
    state.meta.projects = await api.projects();
    await loadProject();
    renderChrome();
    await refreshAll();
  } catch (error) {
    fail(error);
  }
}

function renderMain() {
  const route = readRoute();
  const { params } = route;
  const view = route.view === 'backlog' && !isScrum() ? 'board' : route.view;
  document.querySelectorAll('[data-nav]').forEach(link => {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (view === 'projects') {
    main.replaceChildren(renderProjectAdmin({
      projects: state.adminProjects,
      status: state.adminStatus,
      siteAdmin: state.siteAdmin,
      currentKey: projectKey(),
      onStatus: status => { state.adminStatus = status; render(); },
      onCreate: openProjectForm,
      onOpen: project => switchProject(project.key, 'board'),
      onSettings: project => (project.key === projectKey() ? go('settings') : switchProject(project.key, 'settings')),
      onArchive: archiveProject,
      onRestore: restoreProject,
      onTrash: trashProject,
      onPurge: purgeProject
    }));
    return;
  }
  if (view === 'home') {
    main.replaceChildren(renderHome({
      summary: homeSummary(state.home ?? [], state.me.accountId, localToday()),
      me: state.me,
      onOpen: openIssue,
      onProject: key => switchProject(key, 'board')
    }));
    return;
  }
  if (view === 'users') {
    main.replaceChildren(state.siteAdmin ? renderUsers({
      users: state.directory ?? [],
      me: state.me.accountId,
      project: state.project,
      onCreate: createUser,
      onReset: async person => {
        if (!confirm(`${person.displayName}님의 비밀번호를 임시 비밀번호로 바꿀까요? 지금 로그인된 세션은 모두 끊깁니다.`)) return;
        try {
          const { temporaryPassword } = await api.resetPassword(person.accountId);
          temporaryPasswordDialog(auxDialog, { user: person, password: temporaryPassword });
          await render();
        } catch (error) {
          fail(error);
        }
      },
      onToggleActive: async person => {
        const next = !person.active;
        if (!confirm(next
          ? `${person.displayName}님을 다시 활성화할까요? 예전 프로젝트 역할이 그대로 돌아옵니다.`
          : `${person.displayName}님을 비활성화할까요? 바로 로그아웃되고 로그인할 수 없게 됩니다. 이슈 기록은 남습니다.`)) return;
        try {
          await api.setUserActive(person.accountId, next);
          notify(next ? `${person.displayName}님을 다시 활성화했습니다.` : `${person.displayName}님을 비활성화했습니다.`);
          await reload();
        } catch (error) {
          fail(error);
        }
      }
    }) : h('p', { class: 'muted' }, '사이트 관리자만 사용자를 관리할 수 있습니다.'));
    return;
  }
  if (!state.project) {
    main.replaceChildren(h('div', { class: 'empty-project' },
      h('h1', {}, '참여 중인 프로젝트가 없습니다'),
      h('p', { class: 'muted' }, '프로젝트 관리자에게 멤버로 추가해 달라고 요청하세요.'),
      state.siteAdmin ? h('div', { class: 'row-actions' },
        h('button', { class: 'button primary', type: 'button', onClick: openProjectForm }, '새 프로젝트 만들기'),
        h('a', { class: 'button', href: '#/projects' }, '보관·휴지통 보기')) : null));
    return;
  }
  if (view === 'settings') {
    const key = projectKey();
    main.replaceChildren(renderSettings({
      project: state.project,
      users: state.meta.users,
      canEdit: state.perms.ADMINISTER_PROJECTS,
      siteAdmin: state.siteAdmin,
      onSave: async body => {
        await api.updateProject(key, body);
        notify('프로젝트 설정을 저장했습니다.');
        await refreshProjects();
        await render();
      },
      onArchive: () => archiveProject(state.project),
      onTrash: () => trashProject(state.project)
    }));
    if (canArchiveIssues()) {
      main.append(archivePanel({
        days: state.archiveDays,
        candidates: staleDone(state.archiveDays),
        archived: state.archived ?? [],
        onDays: days => { state.archiveDays = days; savePref('archiveDays', days); renderMain(); },
        onArchive: archiveStale,
        onRestore: issue => run(() => api.unarchive([issue.key]), `${issue.key}을(를) 보관 해제했습니다.`),
        onOpen: openIssue
      }));
    }
    return;
  }
  if (view === 'members') {
    const key = projectKey();
    main.replaceChildren(renderMembers({
      project: state.project,
      roles: state.roles,
      users: state.meta.users,
      canAdmin: state.perms.ADMINISTER_PROJECTS,
      teams: state.teams,
      canManageTeams: state.perms.MANAGE_TEAMS,
      onCreateTeam: name => changeMembers(() => api.createTeam(key, { name, members: [] }), `'${name}' 팀을 만들었습니다.`),
      onUpdateTeam: (team, body) => changeMembers(() => api.updateTeam(key, team.id, body), 'name' in body ? '팀 이름을 바꿨습니다.' : '팀원을 바꿨습니다.'),
      onDeleteTeam: team => {
        if (!confirm(`'${team.name}' 팀을 삭제할까요? 팀원의 역할과 이슈는 그대로 남습니다.`)) return;
        changeMembers(() => api.deleteTeam(key, team.id), `'${team.name}' 팀을 삭제했습니다.`);
      },
      onResetPassword: state.authMode === 'login' && state.siteAdmin ? async person => {
        if (!confirm(`${person.displayName}님의 비밀번호를 임시 비밀번호로 바꿀까요? 지금 로그인된 세션은 모두 끊깁니다.`)) return;
        try {
          const { temporaryPassword } = await api.resetPassword(person.accountId);
          temporaryPasswordDialog(auxDialog, { user: person, password: temporaryPassword });
        } catch (error) {
          fail(error);
        }
      } : null,
      onAdd: (accountId, roleId) => changeMembers(() => api.addToRole(key, roleId, [accountId]), '멤버를 추가했습니다.'),
      onChangeRole: (accountId, roleId) => changeMembers(() => api.addToRole(key, roleId, [accountId]), '역할을 바꿨습니다.'),
      onRemove: (accountId, roleId, name) => {
        if (!confirm(`${name}님을 ${state.project.name}에서 제외할까요? 맡고 있던 이슈의 담당자는 그대로 남습니다.`)) return;
        changeMembers(() => api.removeFromRole(key, roleId, accountId), `${name}님을 제외했습니다.`);
      }
    }));
    return;
  }
  if (view === 'permissions') {
    if (!state.scheme) {
      main.replaceChildren(h('p', { class: 'muted' }, '프로젝트 관리자만 권한 구성을 볼 수 있습니다.'));
      return;
    }
    const schemeId = state.scheme.id;
    main.replaceChildren(renderPermissions({
      project: state.project,
      grants: state.scheme.permissions,
      users: state.meta.users,
      roles: state.roles,
      canEdit: state.perms.ADMINISTER_PROJECTS,
      inspect: state.inspect,
      onInspect: accountId => { state.inspect = accountId; renderMain(); },
      onGrant: (permission, holder) => changeGrants(() => api.grant(schemeId, permission, holder), '권한을 주었습니다.'),
      onRevoke: grant => changeGrants(() => api.revoke(schemeId, grant.id), '권한을 회수했습니다.')
    }));
    return;
  }
  if (view === 'calendar') {
    const cal = state.calendar;
    main.replaceChildren(renderCalendar({
      ...cal,
      issues: state.issues,
      people: state.assignable,
      teams: state.teams,
      today: localToday(),
      me: state.me.accountId,
      canCreate: state.perms.CREATE_ISSUES,
      canMove: issue => Boolean(state.perms.EDIT_ISSUES || mineToMove(issue)),
      onMonth: delta => { cal.month = delta ? shiftMonth(cal.month, delta) : localToday().slice(0, 7); renderMain(); },
      onMode: mode => { cal.mode = mode; savePref('calendarMode', mode); renderMain(); },
      onHideDone: on => { cal.hideDone = on; savePref('calendarHideDone', on); renderMain(); },
      onPeople: selected => { cal.selected = selected; saveSet('calendarPeople', selected); renderMain(); },
      onOpen: openIssue,
      onCreateOn: day => openCreate({ type: 'Task', day }),
      onMove: rescheduleIssue
    }));
    main.querySelector(`.cal-bar[data-key="${params.get('issue')}"]`)?.classList.add('focused');
    return;
  }
  if (view === 'list') {
    const isOpen = key => !state.closedRows.has(key);
    main.replaceChildren(renderList({
      issues: state.listIssues,
      jql: params.get('jql') ?? defaultJql(),
      error: state.listError,
      tree: state.prefs.listTree,
      isOpen,
      onTree: on => setPref('listTree', 'listTree', on),
      onToggle: key => flip('closedRows', key),
      onExpandAll: keys => { keys.forEach(key => state.closedRows.delete(key)); saveSet('closedRows', state.closedRows); renderMain(); },
      onCollapseAll: keys => { keys.forEach(key => state.closedRows.add(key)); saveSet('closedRows', state.closedRows); renderMain(); },
      onSearch: jql => go('list', { jql }),
      onOpen: openIssue
    }));
    const focused = main.querySelector(`tr[data-key="${params.get('issue')}"]`);
    focused?.classList.add('focused');
    return;
  }
  if (view === 'backlog') {
    main.replaceChildren(renderBacklog({
      sprints: state.sprints,
      issues: state.issues.filter(i => i.fields.issuetype.hierarchyLevel === 0),
      perms: state.perms,
      onOpen: openIssue,
      onMove: moveInBacklog,
      onCreateSprint: () => run(() => api.createSprint(boardId(), { name: `${projectKey()} 스프린트 ${nextSprintNumber()}` }), '새 스프린트를 만들었습니다.'),
      onStart: sprint => {
        if (activeSprint()) { notify(`${activeSprint().name}이(가) 진행 중입니다. 먼저 완료해 주세요.`, 'warn'); return; }
        sprintForm(auxDialog, {
          title: `${sprint.name} 시작`,
          sprint,
          submitLabel: '시작',
          onSubmit: async body => {
            await api.updateSprint(sprint.id, { ...body, state: 'active' });
            notify(`${body.name}을(를) 시작했습니다.`);
            await refreshAll();
          }
        });
      },
      onComplete: completeSprint,
      onDelete: sprint => {
        if (!confirm(`${sprint.name}을(를) 삭제할까요? 들어 있던 이슈는 백로그로 돌아갑니다.`)) return;
        run(() => api.deleteSprint(sprint.id), `${sprint.name}을(를) 삭제했습니다.`);
      }
    }));
    return;
  }
  const sprint = activeSprint();
  const issues = boardIssues();
  const banner = !isScrum() ? null : sprint
    ? sprintBanner({ sprint, issues: state.issues.filter(i => i.fields.sprint?.id === sprint.id && !i.fields.issuetype.subtask), canManage: state.perms.MANAGE_SPRINTS_PERMISSION, onComplete: () => completeSprint(sprint) })
    : h('p', { class: 'notice' }, '진행 중인 스프린트가 없어 모든 이슈를 보여 줍니다. ', h('a', { href: '#/backlog' }, '백로그에서 스프린트를 시작하세요.'));
  main.replaceChildren(boardToolbar(), renderBoard({
    statuses: state.meta.statuses,
    lanes: groupLanes(issues, state.prefs.group, state.issues),
    banner,
    canMove: canMoveCard,
    focusKey: params.get('issue'),
    openCards: state.openCards,
    closedLanes: state.closedLanes,
    lookup: lookupIssue,
    doneCutoff: sprint ? null : fromDay(toDay(localToday()) - recentDoneDays),
    showOldDone: state.showOldDone,
    onShowOldDone: on => { state.showOldDone = on; renderMain(); },
    onOpen: openIssue,
    onDrop: moveCard,
    onToggleCard: key => flip('openCards', key),
    onToggleLane: id => flip('closedLanes', id)
  }));
}

function rescheduleIssue(key, day) {
  const issue = state.issues.find(i => i.key === key);
  if (!issue || !(issue.fields.startdate || issue.fields.duedate)) return;
  const fields = moveSpan(issue, day);
  if (fields.startdate === issue.fields.startdate && fields.duedate === issue.fields.duedate) return;
  const range = [fields.startdate, fields.duedate].filter(Boolean);
  run(() => api.update(key, fields), `${key} 일정을 ${[...new Set(range)].join(' ~ ')}(으)로 옮겼습니다.`);
}

const maxAttachmentBytes = 10 * 1024 * 1024;

const canArchiveIssues = () => Boolean(state.project) && (state.siteAdmin || state.perms.ADMINISTER_PROJECTS === true);

function staleDone(days) {
  const cutoff = fromDay(toDay(localToday()) - days);
  return state.issues.filter(issue => !issue.fields.issuetype.subtask && isStaleDone(issue, cutoff));
}

async function archiveStale() {
  const keys = staleDone(state.archiveDays).map(issue => issue.key);
  if (!keys.length) return;
  if (!confirm(`완료된 지 ${state.archiveDays}일이 지난 이슈 ${keys.length}개(하위 작업 포함)를 보관할까요? 보드·목록·검색에서 빠지고, 설정 화면에서 언제든 보관 해제할 수 있습니다.`)) return;
  await run(async () => {
    let total = 0;
    for (let i = 0; i < keys.length; i += 1000) total += (await api.archive(keys.slice(i, i + 1000))).numberOfIssuesUpdated;
    notify(`${total}개 이슈를 보관했습니다.`);
  });
}

const lookupIssue = key => state.issues.find(issue => issue.key === key) ?? state.listIssues.find(issue => issue.key === key);

async function changeGrants(work, message) {
  try {
    await work();
    notify(message);
    await loadProject();
    state.scheme = await api.scheme(projectKey());
    renderChrome();
  } catch (error) {
    fail(error);
  }
  renderMain();
}

function nextSprintNumber() {
  const numbers = state.allSprints.map(s => Number(/(\d+)$/.exec(s.name)?.[1] ?? 0));
  return Math.max(state.allSprints.length, ...numbers) + 1;
}

function renderDrawer() {
  if (!state.detail) {
    drawer.hidden = true;
    drawer.replaceChildren();
    return;
  }
  const key = state.detail.key;
  const context = state.detailContext;
  drawer.hidden = false;
  drawer.replaceChildren(renderDetail({
    issue: state.detail,
    users: context.users,
    teams: context.teams,
    priorities: state.meta.priorities,
    linkTypes: state.meta.linkTypes,
    sprints: context.sprints,
    perms: context.perms,
    me: state.me.accountId,
    lookup: lookupIssue,
    openKids: state.openKids,
    onToggleKid: childKey => flip('openKids', childKey, renderDrawer),
    onClose: closeIssue,
    onOpen: openIssue,
    onTransition: id => run(() => api.transition(key, id)),
    onUpdate: fields => run(() => api.update(key, fields), '저장했습니다.'),
    onComment: text => run(() => api.comment(key, text), '댓글을 남겼습니다.'),
    onEditComment: (comment, text) => run(() => api.editComment(key, comment.id, text), '댓글을 고쳤습니다.'),
    onDeleteComment: comment => {
      if (!confirm('이 댓글을 삭제할까요? 되돌릴 수 없습니다.')) return;
      run(() => api.deleteComment(key, comment.id), '댓글을 삭제했습니다.');
    },
    onCreateChild: type => openCreate({ type, parent: key }),
    onLink: (type, outward, inward) => run(() => api.link(type, outward, inward), `${outward === key ? inward : outward} 이슈와 연결했습니다.`),
    onUnlink: id => run(() => api.unlink(id), '연결을 끊었습니다.'),
    onSprint: id => run(() => (id ? api.moveToSprint(id, [key]) : api.moveToBacklog(context.boardId, [key])), id ? '스프린트에 넣었습니다.' : '백로그로 옮겼습니다.'),
    loadBlob: api.attachmentBlob,
    canArchive: state.siteAdmin || context.perms.ADMINISTER_PROJECTS === true,
    onArchive: () => {
      if (!confirm(`${key}을(를) 보관할까요? 하위 작업도 함께 보관되고, 보드·목록·검색에서 빠집니다.`)) return;
      run(() => api.archive([key]), `${key}을(를) 보관했습니다.`);
    },
    onUnarchive: () => run(() => api.unarchive([key]), `${key}을(를) 보관 해제했습니다.`),
    onUpload: files => {
      const tooBig = files.find(file => file.size > maxAttachmentBytes);
      if (tooBig) {
        notify(`${tooBig.name}은(는) 10MB를 넘어서 올릴 수 없습니다.`, 'error');
        return;
      }
      notify(`${files.length}개 파일을 올리는 중입니다…`);
      run(() => api.attach(key, files), files.length > 1 ? `${files.length}개 파일을 첨부했습니다.` : `${files[0].name}을(를) 첨부했습니다.`);
    },
    onDeleteAttachment: attachment => {
      if (!confirm(`${attachment.filename} 첨부파일을 삭제할까요? 되돌릴 수 없습니다.`)) return;
      run(() => api.deleteAttachment(attachment.id), '첨부파일을 삭제했습니다.');
    },
    onDelete: () => {
      if (!confirm(`${key} 이슈와 그 하위 항목을 삭제할까요? 되돌릴 수 없습니다.`)) return;
      run(async () => { await api.remove(key); closeIssue(); }, `${key} 이슈를 삭제했습니다.`);
    }
  }));
}

const defaultJql = () => `project = ${projectKey()} ORDER BY key DESC`;

async function issueContext(issue) {
  const key = issue.fields.project.key;
  if (key === projectKey()) {
    const permissions = await api.issuePermissions(issue.key);
    return { perms: toPerms(permissions), users: state.assignable, teams: state.teams, sprints: state.sprints, boardId: boardId() };
  }
  const [permissions, users, boards, teams] = await Promise.all([api.issuePermissions(issue.key), api.issueAssignable(issue.key), api.boards(key), api.teams(key)]);
  const board = boards.values[0];
  const sprints = board?.type === 'scrum' ? (await api.sprints(board.id)).values : [];
  return { perms: toPerms(permissions), users, teams, sprints, boardId: board?.id };
}

async function render() {
  if (!state.meta) return;
  const { view, params } = readRoute();
  try {
    if (view === 'projects') {
      if (!state.siteAdmin) state.adminStatus = 'live';
      state.adminProjects = (await api.searchProjects(state.adminStatus)).values;
    }
    if (view === 'permissions') {
      state.scheme = state.project && state.perms.ADMINISTER_PROJECTS ? await api.scheme(projectKey()) : null;
    }
    if (view === 'settings') state.archived = canArchiveIssues() ? (await api.archived(projectKey())).issues : [];
    if (view === 'home') state.home = (await api.searchAll('ORDER BY updated DESC')).issues;
    if (view === 'users') state.directory = state.siteAdmin ? (await api.directory()).users : [];
    if (view === 'list' && state.project) {
      try {
        state.listIssues = (await api.search(params.get('jql') ?? defaultJql())).issues;
        state.listError = null;
      } catch (error) {
        if (error.status === 401) throw error;
        state.listIssues = [];
        state.listError = error.message;
      }
    }
    const key = params.get('issue');
    state.detail = key ? await api.issue(key).catch(error => { if (error.status === 401) throw error; notify(error.message, 'error'); return null; }) : null;
    state.detailContext = state.detail ? await issueContext(state.detail) : null;
  } catch (error) {
    fail(error);
    return;
  }
  renderMain();
  renderDrawer();
}

async function refreshAll() {
  await refreshIssues();
  await render();
}

async function reload() {
  try {
    await loadMeta();
    await refreshAll();
  } catch (error) {
    fail(error);
  }
}

function parentOptions(typeName) {
  const level = state.meta.issueTypes.find(t => t.name === typeName)?.hierarchyLevel ?? 0;
  return state.issues.filter(issue => issue.fields.issuetype.hierarchyLevel === level + 1);
}

function syncParentSelect(selected = '') {
  const typeName = form.elements.issuetype.value;
  const candidates = parentOptions(typeName);
  const required = typeName === 'Subtask';
  const options = candidates.map(issue => h('option', { value: issue.key, selected: issue.key === selected }, `${issue.key} ${issue.fields.summary}`));
  if (!required) options.unshift(h('option', { value: '' }, typeName === 'Epic' ? '에픽은 상위 항목이 없습니다' : '연결하지 않음'));
  form.elements.parent.replaceChildren(...options);
  form.elements.parent.disabled = typeName === 'Epic';
  form.elements.parent.required = required;
}

let createAssign = { team: null, people: [] };

function renderCreateAssignee() {
  dialog.querySelector('.assignee-slot').replaceChildren(assigneePicker({
    users: state.assignable,
    teams: state.teams,
    value: createAssign,
    disabled: !state.perms.ASSIGN_ISSUES,
    onChange: next => { createAssign = next; renderCreateAssignee(); }
  }));
}

function openCreate({ type = 'Story', parent = '', day = '' } = {}) {
  if (!state.perms.CREATE_ISSUES) return;
  form.reset();
  form.elements.issuetype.replaceChildren(...state.meta.issueTypes.map(t => h('option', { value: t.name, selected: t.name === type }, labels.type[t.name] ?? t.name)));
  form.elements.priority.replaceChildren(...state.meta.priorities.map(p => h('option', { value: p.id, selected: p.name === 'Medium' }, labels.priority[p.name] ?? p.name)));
  dialog.querySelector('#create-title').textContent = `이슈 만들기 · ${state.project.name}`;
  createAssign = { team: null, people: [] };
  renderCreateAssignee();
  syncParentSelect(parent);
  form.elements.startdate.value = day;
  form.elements.duedate.value = day;
  dialog.querySelector('.form-error').textContent = '';
  dialog.showModal();
  form.elements.summary.focus();
}

form.elements.issuetype.addEventListener('change', () => syncParentSelect());

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(form);
  const fields = {
    project: { key: projectKey() },
    issuetype: { name: data.get('issuetype') },
    summary: data.get('summary'),
    priority: { id: data.get('priority') },
    labels: String(data.get('labels') || '').split(/\s+/).filter(Boolean)
  };
  if (data.get('description')) fields.description = data.get('description');
  if (createAssign.people.length) fields.assignees = createAssign.people.map(accountId => ({ accountId }));
  if (createAssign.team != null) fields.team = { id: createAssign.team };
  if (data.get('parent')) fields.parent = { key: data.get('parent') };
  if (data.get('startdate')) fields.startdate = data.get('startdate');
  if (data.get('duedate')) fields.duedate = data.get('duedate');
  try {
    const created = await api.create(fields);
    dialog.close();
    notify(`${created.key} 이슈를 만들었습니다.`);
    await refreshIssues();
    openIssue(created.key);
  } catch (error) {
    dialog.querySelector('.form-error').textContent = error.message;
  }
});

function showAuth(props) {
  state.meta = null;
  setNavOpen(false);
  document.body.classList.add('signed-out');
  inbox.hidden = true;
  inboxOpen = false;
  drawer.hidden = true;
  if (dialog.open) dialog.close();
  if (auxDialog.open) auxDialog.close();
  account.replaceChildren();
  switcher.replaceChildren();
  createButton.hidden = true;
  main.replaceChildren(renderLogin(props));
  main.querySelector('input')?.focus();
}

async function afterSignIn(session) {
  if (session.mustChangePassword) showChangePassword(session.user);
  else await start();
}

function showLogin(error) {
  if (state.authMode === 'basic') {
    showAuth({
      kind: 'token',
      error,
      onSubmit: async ({ email, token }) => {
        setCredentials(email, token);
        try {
          await start();
        } catch (failure) {
          clearCredentials();
          throw new Error(failure.status === 401 ? '이메일 또는 토큰이 맞지 않습니다.' : failure.message);
        }
      }
    });
    return;
  }
  showAuth({
    kind: 'password',
    error,
    onSubmit: async ({ email, password }) => {
      try {
        await afterSignIn(await api.login(email, password));
      } catch (failure) {
        throw authError(failure);
      }
    }
  });
}

const authMessages = {
  email: '사이트 관리자 이메일이 아닙니다. 서버 터미널에 설정 코드와 함께 찍힌 이메일을 넣으세요.',
  setupCode: '설정 코드가 틀렸습니다. 서버를 실행한 터미널에 찍힌 코드를 확인하세요.',
  current: '현재 비밀번호가 틀렸습니다.'
};

function authError(failure) {
  const errors = failure.body?.errors ?? {};
  const field = Object.keys(errors)[0];
  let message = authMessages[field];
  if (!message && (field === 'password' || field === 'next')) {
    message = /different/.test(errors[field]) ? '지금 비밀번호와 다른 비밀번호를 고르세요.' : '비밀번호는 8자 이상 200자 이하로 정하세요.';
  }
  if (!message && failure.status === 401) message = '이메일 또는 비밀번호가 맞지 않습니다.';
  if (!message && failure.status === 429) message = '여러 번 틀려서 1분 동안 잠겼습니다. 잠시 뒤 다시 시도하세요.';
  return Object.assign(new Error(message ?? failure.message), { status: failure.status, body: failure.body });
}

function showSetup(error) {
  showAuth({
    kind: 'setup',
    error,
    onSubmit: async ({ setupCode, email, next }) => {
      let session;
      try {
        session = await api.setup(setupCode, email, next);
      } catch (failure) {
        if (failure.status === 409) {
          showLogin('이미 처음 설정이 끝났습니다. 로그인하세요.');
          return;
        }
        throw authError(failure);
      }
      await afterSignIn(session);
      notify('첫 비밀번호를 정했습니다. 멤버 화면에서 다른 사람에게 임시 비밀번호를 발급할 수 있습니다.');
    }
  });
}

function showChangePassword(who, error) {
  showAuth({
    kind: 'change',
    who,
    error,
    onCancel: signOut,
    onSubmit: async ({ current, next }) => {
      try {
        await api.changePassword(current, next);
      } catch (failure) {
        throw authError(failure);
      }
      notify('비밀번호를 바꿨습니다.');
      await start();
    }
  });
}

async function start() {
  await loadMeta();
  document.body.classList.remove('signed-out');
  inbox.hidden = false;
  await refreshIssues();
  if (!location.hash) history.replaceState(null, '', '#/home');
  await render();
  await refreshInbox();
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = setInterval(refreshInbox, 20000);
}

inboxToggle.addEventListener('click', async () => {
  inboxOpen = !inboxOpen;
  if (inboxOpen) await refreshInbox();
  else renderInbox();
});
document.addEventListener('click', event => {
  if (!inboxOpen || inbox.contains(event.target)) return;
  inboxOpen = false;
  renderInbox();
});

document.querySelector('#create-cancel').addEventListener('click', () => dialog.close());
createButton.addEventListener('click', () => openCreate());
navToggle.addEventListener('click', () => setNavOpen(!sidenav.classList.contains('open')));
navBackdrop.addEventListener('click', () => setNavOpen(false));
sidenav.addEventListener('click', event => {
  if (event.target.closest('a')) setNavOpen(false);
});
window.matchMedia('(max-width: 900px)').addEventListener('change', event => {
  if (!event.matches) setNavOpen(false);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sidenav.classList.contains('open')) {
    setNavOpen(false);
    return;
  }
  if (!state.meta || event.target.closest('input, textarea, select, dialog')) return;
  if (event.key === 'c') { event.preventDefault(); openCreate(); }
  if (event.key === 'Escape' && state.detail) closeIssue();
});
window.addEventListener('hashchange', render);

try {
  const info = await api.serverInfo();
  state.authMode = info.authentication;
  setAuthMode(state.authMode);
  onSignedOut(() => { if (state.meta) showLogin('로그인이 만료되었습니다. 다시 로그인해 주세요.'); });
  if (state.authMode === 'login') {
    const session = await api.session();
    if (session.authenticated) await afterSignIn(session);
    else if (session.setupRequired) showSetup();
    else showLogin();
  } else if (state.authMode === 'basic' && !hasCredentials()) showLogin();
  else await start();
} catch (error) {
  if (error.status === 401) showLogin();
  else main.replaceChildren(h('p', { class: 'error' }, `트래커 서버에 연결하지 못했습니다: ${error.message}`));
}
