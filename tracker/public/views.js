import { adfToText } from './api.js';
import { donutRatio } from './home.js';
import { buildTree, flattenTree, parentKeys, childProgress, dueState, isStaleDone, recentDoneDays } from './tree.js';
import { monthWeeks, monthDays, layoutRange, spans, byPerson, busyDays, toDay, fromDay, weekday, assigneeChoices, chosenIds, pickAssignees, teamIds, teamPicked, toggleTeam } from './calendar.js';

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'dataset') Object.assign(element.dataset, value);
    else if (name.startsWith('on')) element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const typeGlyph = { Epic: '◆', Story: '■', Task: '✓', Bug: '●', Subtask: '▸' };
const priorityRank = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
const statusLabel = { 'To Do': '할 일', 'In Progress': '진행 중', 'In Review': '검토 중', Done: '완료' };
const transitionLabel = { 'To Do': '할 일로 되돌리기', 'Start progress': '진행 시작', 'Request review': '검토 요청', Done: '완료 처리', Reopen: '다시 열기' };
const typeLabel = { Epic: '에픽', Story: '스토리', Task: '작업', Bug: '버그', Subtask: '하위 작업' };
const priorityLabel = { Highest: '최상', High: '높음', Medium: '보통', Low: '낮음', Lowest: '최하' };

export const labels = { status: statusLabel, transition: transitionLabel, type: typeLabel, priority: priorityLabel };

const visibleLabels = list => list.filter(label => !label.startsWith('plan-'));

export function typeBadge(issuetype) {
  return h('span', { class: `type type-${issuetype.name.toLowerCase()}`, title: typeLabel[issuetype.name] ?? issuetype.name }, typeGlyph[issuetype.name] ?? '■');
}

export function priorityBadge(priority) {
  const rank = priorityRank[priority.name] ?? 3;
  return h('span', { class: `priority p${rank}`, title: `우선순위: ${priorityLabel[priority.name] ?? priority.name}` },
    h('i'), h('i'), h('i'));
}

export function avatar(user, size = 'sm') {
  if (!user) return h('span', { class: `avatar ${size} empty`, title: '담당자 없음' }, '–');
  const initial = [...user.displayName][0];
  return h('span', { class: `avatar ${size}`, title: user.displayName, dataset: { hue: String([...user.accountId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5) } }, initial);
}

const namedPeople = f => f.assignees ?? (f.assignee ? [f.assignee] : []);

export function whoText(f) {
  const people = namedPeople(f).map(p => p.displayName);
  const parts = [f.team ? `${f.team.name} 팀` : null, people.length > 2 ? `${people.slice(0, 2).join(', ')} 외 ${people.length - 2}명` : people.join(', ')].filter(Boolean);
  return parts.join(' · ') || '담당자 없음';
}

export function whoStack(f, max = 3) {
  const people = namedPeople(f);
  if (!f.team && people.length <= 1) return avatar(people[0] ?? null);
  const title = [f.team ? `${f.team.name} 팀 (${f.team.members.map(m => m.displayName).join(', ') || '팀원 없음'})` : null, ...people.map(p => p.displayName)].filter(Boolean).join('\n');
  return h('span', { class: 'who-stack', title },
    f.team ? h('span', { class: 'team-badge' }, f.team.name) : null,
    people.slice(0, max).map(p => avatar(p)),
    people.length > max ? h('span', { class: 'avatar sm more' }, `+${people.length - max}`) : null);
}

export function assigneePicker({ users, teams, value, known = [], disabled = false, onChange }) {
  const byId = new Map([...known, ...users].map(u => [u.accountId, u]));
  const team = teams.find(t => t.id === value.team) ?? null;
  const emit = next => onChange({ team: value.team, people: value.people, ...next });
  const choices = h('select', {
    class: 'add-person', 'aria-label': '담당자 추가', disabled,
    onChange: event => {
      const [kind, id] = event.target.value.split(':');
      if (kind === 'team') emit({ team: Number(id) });
      if (kind === 'user') emit({ people: [...value.people, id] });
    }
  },
  h('option', { value: '' }, value.people.length || team ? '+ 담당자' : '+ 담당자 (팀 또는 사람)'),
  teams.length ? h('optgroup', { label: '팀 전체' }, teams.filter(t => t.id !== value.team).map(t => h('option', { value: `team:${t.id}` }, `${t.name} (${t.members.length}명)`))) : null,
  h('optgroup', { label: '사람' }, users.filter(u => !value.people.includes(u.accountId)).map(u => h('option', { value: `user:${u.accountId}` }, u.displayName))));
  return h('div', { class: 'assignee-picker' },
    team ? h('span', { class: 'person-chip team-chip', title: team.members.map(m => m.displayName).join(', ') || '팀원 없음' },
      h('span', { class: 'team-badge' }, '팀'), `${team.name} · ${team.members.length}명`,
      disabled ? null : h('button', { class: 'icon-button small', type: 'button', 'aria-label': `${team.name} 팀 빼기`, onClick: () => emit({ team: null }) }, '✕')) : null,
    value.people.map(id => {
      const person = byId.get(id) ?? { accountId: id, displayName: id };
      return h('span', { class: 'person-chip' }, avatar(person), person.displayName,
        disabled ? null : h('button', { class: 'icon-button small', type: 'button', 'aria-label': `${person.displayName} 빼기`, onClick: () => emit({ people: value.people.filter(other => other !== id) }) }, '✕'));
    }),
    !team && !value.people.length && disabled ? h('span', { class: 'muted small' }, '담당자 없음') : null,
    disabled ? null : choices);
}

export function statusPill(status) {
  return h('span', { class: `status cat-${status.statusCategory.key}` }, statusLabel[status.name] ?? status.name);
}

function relative(iso) {
  const date = new Date(iso.replace('+0000', 'Z'));
  const minutes = Math.round((Date.now() - date) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export function blockers(issue) {
  return (issue.fields.issuelinks ?? []).filter(link => link.type.name === 'Blocks' && link.outwardIssue
    && link.outwardIssue.fields.status.statusCategory.key !== 'done').map(link => link.outwardIssue.key);
}

export function rankPlacement(draggedKey, target) {
  if (!target || target.key === draggedKey) return null;
  return target.before ? { rankBeforeIssue: target.key } : { rankAfterIssue: target.key };
}

function dropTarget(event, container, selector) {
  const target = event.target.closest(selector);
  if (!target || !container.contains(target)) return null;
  const box = target.getBoundingClientRect();
  return { element: target, key: target.dataset.key, before: event.clientY < box.top + box.height / 2 };
}

export function sortable(container, selector, onDrop) {
  const clear = () => container.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  container.addEventListener('dragover', event => {
    event.preventDefault();
    container.classList.add('over');
    clear();
    const target = dropTarget(event, container, selector);
    if (target) target.element.classList.add(target.before ? 'drop-before' : 'drop-after');
  });
  container.addEventListener('dragleave', event => {
    if (!container.contains(event.relatedTarget)) { container.classList.remove('over'); clear(); }
  });
  container.addEventListener('drop', event => {
    event.preventDefault();
    container.classList.remove('over');
    clear();
    const key = event.dataTransfer.getData('text/plain');
    if (!key) return;
    onDrop(key, rankPlacement(key, dropTarget(event, container, selector)));
  });
  return container;
}

export function draggable(key, enabled) {
  if (!enabled) return {};
  return {
    draggable: 'true',
    onDragstart: event => {
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.effectAllowed = 'move';
      event.currentTarget.classList.add('dragging');
    },
    onDragend: event => event.currentTarget.classList.remove('dragging')
  };
}

const stop = handler => event => { event.stopPropagation(); handler(event); };

export function dueChip(duedate) {
  const due = dueState(duedate);
  if (!due) return null;
  const text = due.days < 0 ? `${-due.days}일 지남` : due.days === 0 ? '오늘 마감' : due.days <= 7 ? `D-${due.days}` : formatDay(duedate);
  return h('span', { class: `chip due ${due.tone}`, title: `기한 ${duedate}` }, text);
}

export function progressChip({ done, total }, { open, onToggle, label = '하위' } = {}) {
  if (!total) return null;
  const body = [h('span', { class: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'), `${label} ${done}/${total}`, h('span', { class: 'meter', style: `--ratio:${done / total}` })];
  return onToggle
    ? h('button', { class: `chip progress${open ? ' open' : ''}`, type: 'button', 'aria-expanded': String(Boolean(open)), title: open ? '하위 항목 접기' : '하위 항목 펼치기', onClick: stop(onToggle) }, body)
    : h('span', { class: 'chip progress' }, body.slice(1));
}

function card(issue, { focusKey, movable, open, lookup, onOpen, onToggle }) {
  const f = issue.fields;
  const blockedBy = blockers(issue);
  const tags = visibleLabels(f.labels);
  const progress = childProgress(issue);
  const parent = f.parent;
  return h('li', {},
    h('article', {
      class: `card${issue.key === focusKey ? ' focused' : ''}${movable ? '' : ' locked'} cat-${f.status.statusCategory.key}`,
      tabindex: '0',
      'aria-label': `${issue.key} ${f.summary}`,
      dataset: { key: issue.key },
      onClick: () => onOpen(issue.key),
      onKeydown: event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(issue.key); } },
      ...draggable(issue.key, movable)
    },
    h('div', { class: 'card-top' },
      typeBadge(f.issuetype),
      h('span', { class: `card-key${f.status.statusCategory.key === 'done' ? ' done' : ''}` }, issue.key),
      h('span', { class: 'spacer' }),
      priorityBadge(f.priority),
      whoStack(f)),
    parent ? h('button', { class: `card-parent parent-${parent.fields.issuetype.name.toLowerCase()}`, type: 'button', title: `상위 ${parent.key} 열기`, onClick: stop(() => onOpen(parent.key)) },
      typeGlyph[parent.fields.issuetype.name] ?? '■', ' ', parent.fields.summary) : null,
    h('p', { class: 'card-summary' }, f.summary),
    tags.length || f.duedate || blockedBy.length || progress.total ? h('div', { class: 'card-tags' },
      blockedBy.length ? h('span', { class: 'chip blocked', title: `${blockedBy.join(', ')}이(가) 끝나야 진행할 수 있습니다` }, `막힘 ${blockedBy.length}`) : null,
      dueChip(f.duedate),
      tags.slice(0, 3).map(tag => h('span', { class: 'chip label' }, tag)),
      tags.length > 3 ? h('span', { class: 'chip label' }, `+${tags.length - 3}`) : null,
      h('span', { class: 'spacer' }),
      progressChip(progress, { open, onToggle: () => onToggle(issue.key) })) : null,
    open && progress.total ? h('ul', { class: 'card-kids' }, progress.kids.map(kid => {
      const full = lookup(kid.key);
      return h('li', {}, h('button', { class: 'kid', type: 'button', onClick: stop(() => onOpen(kid.key)) },
        typeBadge(kid.fields.issuetype),
        h('span', { class: `num${kid.fields.status.statusCategory.key === 'done' ? ' struck' : ''}` }, kid.key),
        h('span', { class: 'grow' }, kid.fields.summary),
        h('span', { class: `dot cat-${kid.fields.status.statusCategory.key}`, title: statusLabel[kid.fields.status.name] ?? kid.fields.status.name }),
        full ? whoStack(full.fields, 2) : avatar(null)));
    })) : null));
}

const flowed = columns => columns.flatMap((column, i) => (i === 0 ? [column] : [h('span', { class: 'flow', 'aria-hidden': 'true' }), column]));

export function renderBoard({ statuses, lanes, focusKey, canMove, banner, openCards, closedLanes, lookup, doneCutoff = null, showOldDone = false, onShowOldDone, onOpen, onDrop, onToggleCard, onToggleLane }) {
  const laneMode = lanes.length > 1 || lanes[0]?.title != null;
  const cardOptions = issue => ({ focusKey, movable: canMove(issue), open: openCards.has(issue.key), lookup, onOpen, onToggle: onToggleCard });
  const columnsFor = issues => statuses.map((status, index) => {
    const all = issues.filter(issue => issue.fields.status.id === status.id);
    const stale = all.filter(issue => isStaleDone(issue, doneCutoff));
    const items = showOldDone ? all : all.filter(issue => !stale.includes(issue));
    const more = stale.length
      ? h('button', { class: 'button ghost small old-done', type: 'button', title: `${recentDoneDays}일보다 전에 완료된 이슈`, onClick: () => onShowOldDone(!showOldDone) },
        showOldDone ? `최근 ${recentDoneDays}일 것만 보기` : `이전 완료 ${stale.length}개 더 보기`)
      : null;
    const list = h('ol', { class: 'cards', 'aria-label': `${statusLabel[status.name]} 열` }, items.map(issue => card(issue, cardOptions(issue))), more ? h('li', { class: 'old-done-row' }, more) : null);
    const column = h('section', { class: `column cat-${status.statusCategory.key}${laneMode ? ' in-lane' : ''}`, dataset: { status: status.id } },
      laneMode ? null : h('header', { class: 'column-head' },
        h('h2', {}, statusLabel[status.name] ?? status.name),
        h('span', { class: 'count', title: stale.length && !showOldDone ? `숨긴 이전 완료 ${stale.length}개 포함 ${all.length}개` : null }, all.length)),
      items.length || more ? list : laneMode ? null : h('p', { class: 'empty-column' }, index === 0 ? '새 이슈를 만들면 여기에 쌓입니다.' : '카드를 끌어다 놓아 상태를 바꾸세요.'));
    sortable(column, '.card', (key, rank) => onDrop(key, status, rank));
    return column;
  });
  if (!laneMode) return h('div', { class: 'board-wrap' }, banner, h('div', { class: 'board' }, flowed(columnsFor(lanes[0]?.issues ?? []))));

  const all = lanes.flatMap(lane => lane.issues);
  const heads = statuses.map(status => h('header', { class: `column-head lane-col cat-${status.statusCategory.key}` },
    h('h2', {}, statusLabel[status.name] ?? status.name),
    h('span', { class: 'count' }, all.filter(issue => issue.fields.status.id === status.id).length)));
  return h('div', { class: 'board-wrap' },
    banner,
    h('div', { class: 'board lane-heads' }, flowed(heads)),
    lanes.map(lane => {
      const closed = closedLanes.has(lane.id);
      const done = lane.issues.filter(issue => issue.fields.status.statusCategory.key === 'done').length;
      return h('section', { class: `lane${closed ? ' closed' : ''}` },
        h('button', { class: 'lane-toggle', type: 'button', 'aria-expanded': String(!closed), onClick: () => onToggleLane(lane.id) },
          h('span', { class: 'caret', 'aria-hidden': 'true' }, closed ? '▸' : '▾'),
          h('strong', {}, lane.title),
          h('span', { class: 'muted small' }, `${lane.issues.length}개 · ${done} 완료`),
          h('span', { class: 'meter', style: `--ratio:${lane.issues.length ? done / lane.issues.length : 0}` })),
        closed ? null : h('div', { class: 'board' }, flowed(columnsFor(lane.issues))));
    }));
}

function formatDay(iso) {
  return iso ? new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) : '날짜 미정';
}

export function sprintBanner({ sprint, issues, canManage, onComplete }) {
  const done = issues.filter(i => i.fields.status.statusCategory.key === 'done').length;
  const daysLeft = sprint.endDate ? Math.ceil((new Date(sprint.endDate) - Date.now()) / 86400000) : null;
  return h('div', { class: 'sprint-banner' },
    h('div', { class: 'sprint-title' },
      h('h2', {}, sprint.name),
      h('span', { class: 'muted small' }, `${formatDay(sprint.startDate)} – ${formatDay(sprint.endDate)}`),
      daysLeft != null ? h('span', { class: `days${daysLeft < 0 ? ' late' : ''}` }, daysLeft < 0 ? `${-daysLeft}일 지남` : `${daysLeft}일 남음`) : null),
    sprint.goal ? h('p', { class: 'sprint-goal' }, sprint.goal) : null,
    h('span', { class: 'meter wide', style: `--ratio:${issues.length ? done / issues.length : 0}` }),
    h('span', { class: 'num small' }, `${done}/${issues.length} 완료`),
    canManage ? h('button', { class: 'button', onClick: onComplete }, '스프린트 완료') : null);
}

function backlogRow(issue, { canSchedule, onOpen }) {
  return h('li', { class: 'row', dataset: { key: issue.key }, ...draggable(issue.key, canSchedule) },
    h('button', { class: 'row-open', onClick: () => onOpen(issue.key) },
      typeBadge(issue.fields.issuetype),
      h('span', { class: 'num' }, issue.key),
      h('span', { class: 'grow' }, issue.fields.summary),
      blockers(issue).length ? h('span', { class: 'card-blocked inline' }, '막힘') : null,
      statusPill(issue.fields.status),
      priorityBadge(issue.fields.priority),
      whoStack(issue.fields)));
}

export function renderBacklog({ sprints, issues, perms, onOpen, onMove, onCreateSprint, onStart, onComplete, onDelete }) {
  const inSprint = id => issues.filter(i => i.fields.sprint?.id === id);
  const backlog = issues.filter(i => !i.fields.sprint && i.fields.status.statusCategory.key !== 'done');
  const section = (title, meta, items, target, actions) => {
    const list = h('ol', { class: 'rows' }, items.map(issue => backlogRow(issue, { canSchedule: perms.SCHEDULE_ISSUES, onOpen })));
    const box = h('section', { class: `bucket${target.sprint?.state === 'active' ? ' active' : ''}` },
      h('header', { class: 'bucket-head' }, h('h2', {}, title), meta, h('span', { class: 'spacer' }), actions),
      items.length ? list : h('p', { class: 'empty-column' }, target.sprint ? '백로그에서 이슈를 끌어다 놓아 계획하세요.' : '모든 이슈가 스프린트에 들어갔습니다.'));
    if (perms.SCHEDULE_ISSUES) sortable(box, '.row', (key, rank) => onMove(key, target, rank));
    return box;
  };
  return h('div', { class: 'backlog' },
    h('div', { class: 'toolbar' },
      h('p', { class: 'muted small' }, '이슈를 끌어 스프린트에 넣거나 순서를 바꾸세요. 위에 있을수록 먼저 처리합니다.'),
      h('span', { class: 'spacer' }),
      perms.MANAGE_SPRINTS_PERMISSION ? h('button', { class: 'button', onClick: onCreateSprint }, '스프린트 만들기') : null),
    sprints.map(sprint => {
      const items = inSprint(sprint.id);
      const actions = !perms.MANAGE_SPRINTS_PERMISSION ? null : sprint.state === 'active'
        ? h('button', { class: 'button', onClick: () => onComplete(sprint) }, '스프린트 완료')
        : [h('button', { class: 'button ghost small', onClick: () => onDelete(sprint) }, '삭제'),
          h('button', { class: 'button primary small', onClick: () => onStart(sprint) }, '스프린트 시작')];
      const meta = h('span', { class: 'muted small' },
        sprint.state === 'active' ? `진행 중 · ${formatDay(sprint.startDate)} – ${formatDay(sprint.endDate)}` : '예정',
        ` · 이슈 ${items.length}개`);
      return section(sprint.name, meta, items, { sprint }, actions);
    }),
    section('백로그', h('span', { class: 'muted small' }, `이슈 ${backlog.length}개`), backlog, { sprint: null }, null));
}

export function sprintForm(dialog, { title, sprint, submitLabel, onSubmit }) {
  const today = new Date();
  const toInput = iso => (iso ? iso.slice(0, 10) : '');
  const inTwoWeeks = new Date(today.getTime() + 14 * 86400000);
  const form = h('form', { method: 'dialog', class: 'dialog-form' },
    h('h2', {}, title),
    h('div', { class: 'grid' },
      h('label', { class: 'wide' }, '이름', h('input', { name: 'name', required: true, maxlength: '60', value: sprint?.name ?? '' })),
      h('label', { class: 'wide' }, '목표', h('textarea', { name: 'goal', rows: '2', placeholder: '이번 스프린트에서 끝낼 것' }, sprint?.goal ?? '')),
      h('label', {}, '시작일', h('input', { name: 'startDate', type: 'date', required: true, value: toInput(sprint?.startDate) || toInput(today.toISOString()) })),
      h('label', {}, '종료일', h('input', { name: 'endDate', type: 'date', required: true, value: toInput(sprint?.endDate) || toInput(inTwoWeeks.toISOString()) }))),
    h('p', { class: 'form-error', role: 'alert' }),
    h('footer', {},
      h('button', { class: 'button ghost', type: 'button', onClick: () => dialog.close() }, '취소'),
      h('button', { class: 'button primary', type: 'submit' }, submitLabel)));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await onSubmit({
        name: data.name,
        goal: data.goal,
        startDate: new Date(`${data.startDate}T09:00:00`).toISOString(),
        endDate: new Date(`${data.endDate}T18:00:00`).toISOString()
      });
      dialog.close();
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
    }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

const minPassword = 8;
const emailField = () => h('label', {}, '이메일', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' }));
const passwordField = (label, name, autocomplete) => h('label', {}, label, h('input', {
  name, type: 'password', required: true, autocomplete, ...(autocomplete === 'new-password' ? { minlength: String(minPassword) } : {})
}));

const authForms = {
  password: {
    title: 'OneStop 트래커에 로그인',
    hint: '이메일과 비밀번호를 입력하세요. 비밀번호가 없거나 잊었다면 사이트 관리자에게 임시 비밀번호를 요청하세요.',
    fields: () => [emailField(), passwordField('비밀번호', 'password', 'current-password')],
    submit: '로그인'
  },
  token: {
    title: 'OneStop 트래커에 로그인',
    hint: '이메일과 API 토큰을 입력하세요. 토큰이 없으면 관리자에게 요청하거나 서버에서 npm run token -- create <이메일>로 발급합니다.',
    fields: () => [emailField(), passwordField('API 토큰', 'token', 'current-password')],
    submit: '로그인'
  },
  setup: {
    title: '처음 설정',
    hint: '아직 비밀번호를 가진 사람이 없습니다. 사이트 관리자 이메일과 비밀번호를 정하세요. 정한 뒤에는 본인이 비밀번호를 바꿀 수 있습니다.',
    fields: () => [
      emailField(),
      passwordField(`새 비밀번호 (${minPassword}자 이상)`, 'next', 'new-password'),
      passwordField('새 비밀번호 확인', 'confirm', 'new-password')
    ],
    submit: '비밀번호 정하고 시작'
  },
  change: {
    title: '비밀번호 바꾸기',
    hint: '임시 비밀번호로 로그인했습니다. 계속하려면 나만 아는 새 비밀번호로 바꾸세요.',
    fields: () => [
      passwordField('현재(임시) 비밀번호', 'current', 'current-password'),
      passwordField(`새 비밀번호 (${minPassword}자 이상)`, 'next', 'new-password'),
      passwordField('새 비밀번호 확인', 'confirm', 'new-password')
    ],
    submit: '바꾸고 계속'
  }
};

export function renderLogin({ kind = 'password', error, hint, who, onSubmit, onCancel }) {
  const spec = authForms[kind];
  const message = h('p', { class: 'error', role: 'alert', hidden: !error }, error ?? '');
  const show = text => {
    message.textContent = text;
    message.hidden = false;
  };
  const form = h('form', { class: 'login', onSubmit: async event => {
    event.preventDefault();
    const values = Object.fromEntries([...new FormData(event.currentTarget)].map(([k, v]) => [k, k === 'email' ? String(v).trim() : String(v)]));
    if ('confirm' in values && values.confirm !== values.next) {
      show('새 비밀번호 두 칸이 서로 다릅니다.');
      return;
    }
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    message.hidden = true;
    try {
      await onSubmit(values);
    } catch (failure) {
      show(failure.message);
      const field = Object.keys(failure.body?.errors ?? {})[0];
      form.querySelector(`input[name=${field === 'password' ? 'next' : field}]`)?.focus();
    } finally {
      button.disabled = false;
    }
  } },
  h('h1', {}, spec.title),
  who ? h('p', { class: 'identity' }, h('strong', {}, who.displayName), h('span', { class: 'muted small' }, who.emailAddress)) : null,
  h('p', { class: 'muted' }, hint ?? spec.hint),
  spec.fields(),
  message,
  h('div', { class: 'login-actions' },
    h('button', { class: 'button primary', type: 'submit' }, spec.submit),
    onCancel ? h('button', { class: 'button ghost', type: 'button', onClick: onCancel }, kind === 'change' ? '로그아웃' : '취소') : null));
  return h('div', { class: 'login-wrap' }, form);
}

export function passwordDialog(dialog, { onSubmit }) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'token-panel', onSubmit: async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (data.next !== data.confirm) {
      error.textContent = '새 비밀번호 두 칸이 서로 다릅니다.';
      return;
    }
    try {
      await onSubmit(data.current, data.next);
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
    }
  } },
  h('h2', {}, '비밀번호 바꾸기'),
  h('p', { class: 'muted small' }, '바꾸면 다른 브라우저에 로그인된 세션은 모두 로그아웃됩니다.'),
  passwordField('현재 비밀번호', 'current', 'current-password'),
  passwordField(`새 비밀번호 (${minPassword}자 이상)`, 'next', 'new-password'),
  passwordField('새 비밀번호 확인', 'confirm', 'new-password'),
  error,
  h('footer', {},
    h('button', { class: 'button ghost', type: 'button', onClick: () => dialog.close() }, '취소'),
    h('button', { class: 'button primary', type: 'submit' }, '바꾸기')));
  dialog.replaceChildren(form);
  dialog.showModal();
  form.querySelector('input')?.focus();
}

export function temporaryPasswordDialog(dialog, { user, password }) {
  dialog.replaceChildren(h('div', { class: 'token-panel' },
    h('h2', {}, '임시 비밀번호'),
    h('p', {}, `${user.displayName}(${user.emailAddress ?? user.accountId})님의 임시 비밀번호입니다. 이 창을 닫으면 다시 볼 수 없으니 본인에게 직접 전달하세요. 첫 로그인 때 새 비밀번호로 바꾸게 됩니다.`),
    h('div', { class: 'fresh-token' }, h('code', {}, password)),
    h('footer', {}, h('button', { class: 'button primary', type: 'button', onClick: () => dialog.close() }, '닫기'))));
  dialog.showModal();
}

export function tokensPanel(dialog, { load, create, revoke }) {
  const list = h('ul', { class: 'tokens' });
  const fresh = h('div', { class: 'fresh-token', hidden: true });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const label = h('input', { name: 'label', placeholder: '예: 노트북, CI', maxlength: '60', 'aria-label': '토큰 이름' });
  const refresh = async () => {
    const { tokens } = await load();
    list.replaceChildren(...(tokens.length ? tokens.map(t => h('li', {},
      h('span', { class: 'grow' }, h('strong', {}, t.label), h('span', { class: 'muted small' }, ` · ${new Date(t.created).toLocaleDateString('ko-KR')} 발급 · ${t.lastUsed ? `${new Date(t.lastUsed).toLocaleString('ko-KR')} 사용` : '아직 사용 안 함'}`)),
      h('button', { class: 'button ghost small', onClick: async () => {
        if (!confirm(`"${t.label}" 토큰을 폐기할까요? 이 토큰을 쓰는 스크립트는 더 이상 동작하지 않습니다.`)) return;
        await revoke(t.id);
        await refresh();
      } }, '폐기'))) : [h('li', { class: 'muted small' }, '발급한 토큰이 없습니다.')]));
  };
  const form = h('form', { class: 'dialog-form', onSubmit: async event => {
    event.preventDefault();
    try {
      const created = await create(label.value);
      fresh.hidden = false;
      fresh.replaceChildren(
        h('p', {}, '새 토큰입니다. 이 창을 닫으면 다시 볼 수 없으니 지금 복사해 두세요.'),
        h('code', {}, created.token));
      label.value = '';
      error.textContent = '';
      await refresh();
    } catch (failure) {
      error.textContent = failure.message;
    }
  } },
  h('h2', {}, 'API 토큰'),
  h('p', { class: 'muted small' }, '스크립트나 다른 도구에서 Basic 인증(이메일:토큰)으로 REST API를 호출할 때 씁니다.'),
  list,
  h('div', { class: 'token-create' }, label, h('button', { class: 'button primary', type: 'submit' }, '토큰 발급')),
  fresh,
  error,
  h('footer', {}, h('button', { class: 'button ghost', type: 'button', onClick: () => dialog.close() }, '닫기')));
  dialog.replaceChildren(form);
  dialog.showModal();
  refresh().catch(failure => { error.textContent = failure.message; });
}

export const roleLabel = { administrators: '관리자', 'deputy administrators': '부관리자', deputies: '부관리자', members: '멤버', viewers: '보기 전용' };

function renderTeams({ teams, members, canManage, onCreate, onUpdate, onDelete }) {
  const teamCard = team => {
    const inTeam = new Set(team.members.map(m => m.accountId));
    const others = members.filter(m => !inTeam.has(m.accountId));
    const setMembers = ids => onUpdate(team, { members: ids });
    return h('li', { class: 'team-card' },
      h('div', { class: 'team-head' },
        h('strong', {}, team.name),
        h('span', { class: 'muted small' }, `${team.members.length}명`),
        h('span', { class: 'spacer' }),
        canManage ? h('button', { class: 'button ghost small', type: 'button', onClick: () => {
          const name = prompt('팀 이름', team.name);
          if (name && name.trim() !== team.name) onUpdate(team, { name: name.trim() });
        } }, '이름 바꾸기') : null,
        canManage ? h('button', { class: 'button ghost small danger', type: 'button', onClick: () => onDelete(team) }, '삭제') : null),
      h('div', { class: 'team-people' },
        team.members.length ? team.members.map(m => h('span', { class: 'person-chip' },
          avatar(m), m.displayName,
          canManage ? h('button', { class: 'icon-button small', type: 'button', 'aria-label': `${team.name}에서 ${m.displayName} 빼기`,
            onClick: () => setMembers([...inTeam].filter(id => id !== m.accountId)) }, '✕') : null))
          : h('span', { class: 'muted small' }, '아직 팀원이 없습니다.'),
        canManage && others.length ? h('select', {
          class: 'add-person', 'aria-label': `${team.name}에 넣을 사람`,
          onChange: event => { if (event.target.value) setMembers([...inTeam, event.target.value]); }
        }, h('option', { value: '' }, '+ 팀원'), others.map(u => h('option', { value: u.accountId }, u.displayName))) : null));
  };
  const createForm = canManage ? h('form', { class: 'member-add', onSubmit: event => {
    event.preventDefault();
    const input = event.currentTarget.elements.name;
    if (input.value.trim()) onCreate(input.value.trim());
  } },
  h('label', {}, '새 팀', h('input', { name: 'name', maxLength: 40, placeholder: '예: 프론트엔드', required: true })),
  h('button', { class: 'button primary', type: 'submit' }, '팀 만들기')) : null;
  return h('section', { class: 'bucket teams' },
    h('header', { class: 'bucket-head' },
      h('h2', {}, '팀'),
      h('span', { class: 'muted small' }, canManage
        ? `${teams.length}개 · 캘린더 담당자 필터에서 팀 단위로 골라 볼 수 있습니다.`
        : `${teams.length}개 · 팀 구성은 관리자와 부관리자가 바꿀 수 있습니다.`)),
    createForm,
    h('ul', { class: 'team-list' }, teams.length ? teams.map(teamCard) : [h('li', { class: 'row muted small' }, '아직 팀이 없습니다.')]));
}

export function renderMembers({ project, roles, users, canAdmin, teams = [], canManageTeams = false, onAdd, onChangeRole, onRemove, onCreateTeam, onUpdateTeam, onDeleteTeam, onResetPassword = null }) {
  const holder = new Map(roles.flatMap(({ role, actors }) => actors.map(actor => [actor.actorUser.accountId, role])));
  const userById = new Map(users.map(u => [u.accountId, u]));
  const roleSelect = (selected, props = {}) => h('select', props,
    roles.map(({ role }) => h('option', { value: role.id, selected: role.id === selected?.id }, roleLabel[role.name.toLowerCase()] ?? role.name)));

  const sections = roles.map(({ role, actors }) => h('section', { class: 'bucket' },
    h('header', { class: 'bucket-head' },
      h('h2', {}, roleLabel[role.name.toLowerCase()] ?? role.name),
      h('span', { class: 'muted small' }, `${actors.length}명 · ${role.description}`)),
    h('ul', { class: 'rows members' }, actors.length ? actors.map(actor => {
      const id = actor.actorUser.accountId;
      const person = userById.get(id) ?? { accountId: id, displayName: actor.displayName };
      return h('li', { class: 'row' },
        avatar(person),
        h('span', { class: 'grow' }, person.displayName, id === project.lead?.accountId ? h('span', { class: 'muted small' }, ' · 리드') : null),
        canAdmin
          ? roleSelect(role, { 'aria-label': `${person.displayName} 역할`, onChange: event => onChangeRole(id, Number(event.target.value)) })
          : null,
        canAdmin
          ? h('button', { class: 'button ghost small', type: 'button', onClick: () => onRemove(id, role.id, person.displayName) }, '제외')
          : null,
        onResetPassword
          ? h('button', { class: 'button ghost small', type: 'button', title: '임시 비밀번호를 만들어 전달합니다', onClick: () => onResetPassword(person) }, '비밀번호 재설정')
          : null);
    }) : [h('li', { class: 'row muted small' }, '아직 아무도 없습니다.')])));

  const outsiders = users.filter(u => !holder.has(u.accountId) && u.active !== false);
  const addForm = canAdmin && outsiders.length
    ? h('form', { class: 'member-add', onSubmit: event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onAdd(data.get('user'), Number(data.get('role')));
    } },
    h('label', {}, '사람', h('select', { name: 'user' }, outsiders.map(u => h('option', { value: u.accountId }, u.displayName)))),
    h('label', {}, '역할', roleSelect(roles.find(r => r.role.name === 'Members')?.role, { name: 'role' })),
    h('button', { class: 'button primary', type: 'submit' }, '추가'))
    : null;

  return h('div', { class: 'backlog' },
    h('div', { class: 'members-head' },
      h('h1', {}, `${project.name} 멤버`),
      h('p', { class: 'muted small' }, canAdmin
        ? '역할을 바꾸거나 사람을 추가·제외할 수 있습니다. 관리자는 최소 한 명 있어야 합니다.'
        : '프로젝트 관리자만 멤버를 바꿀 수 있습니다.')),
    addForm,
    sections,
    renderTeams({
      teams,
      members: users.filter(u => holder.has(u.accountId)).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko')),
      canManage: canManageTeams,
      onCreate: onCreateTeam,
      onUpdate: onUpdateTeam,
      onDelete: onDeleteTeam
    }));
}

const permissionGroups = [
  ['project', '프로젝트', [
    ['BROWSE_PROJECTS', '프로젝트 보기', '프로젝트와 이슈를 볼 수 있습니다.'],
    ['ADMINISTER_PROJECTS', '프로젝트 관리', '설정, 멤버, 권한을 바꿀 수 있습니다.'],
    ['MANAGE_SPRINTS_PERMISSION', '스프린트 관리', '스프린트를 만들고 시작·완료·삭제합니다.'],
    ['MANAGE_TEAMS', '팀 관리', '팀을 만들고 이름과 팀원을 바꿉니다.']]],
  ['issue', '이슈', [
    ['CREATE_ISSUES', '이슈 만들기', '새 이슈와 하위 작업을 만듭니다.'],
    ['EDIT_ISSUES', '이슈 수정', '요약, 설명, 우선순위, 레이블, 기한을 고칩니다.'],
    ['TRANSITION_ISSUES', '상태 변경', '보드에서 카드를 옮기거나 상태 버튼을 누릅니다.'],
    ['ASSIGN_ISSUES', '담당자 지정', '이슈의 담당자를 바꿉니다.'],
    ['ASSIGNABLE_USER', '담당자가 될 수 있음', '담당자 목록에 나타납니다.'],
    ['SCHEDULE_ISSUES', '순서·스프린트 조정', '순위를 바꾸고 스프린트에 넣거나 뺍니다.'],
    ['LINK_ISSUES', '이슈 연결', '막음·중복·관련 연결을 만들고 끊습니다.'],
    ['DELETE_ISSUES', '이슈 삭제', '이슈와 그 하위 항목을 지웁니다.']]],
  ['comment', '댓글', [
    ['ADD_COMMENTS', '댓글 쓰기', '이슈에 댓글을 남깁니다.'],
    ['EDIT_OWN_COMMENTS', '내 댓글 수정', '자기가 쓴 댓글을 고칩니다.'],
    ['EDIT_ALL_COMMENTS', '모든 댓글 수정', '누가 쓴 댓글이든 고칩니다.'],
    ['DELETE_OWN_COMMENTS', '내 댓글 삭제', '자기가 쓴 댓글을 지웁니다.'],
    ['DELETE_ALL_COMMENTS', '모든 댓글 삭제', '누가 쓴 댓글이든 지웁니다.']]],
  ['attachment', '첨부파일', [
    ['CREATE_ATTACHMENTS', '파일 첨부', '이슈에 파일을 올립니다.'],
    ['DELETE_OWN_ATTACHMENTS', '내 첨부 삭제', '자기가 올린 첨부파일을 지웁니다.'],
    ['DELETE_ALL_ATTACHMENTS', '모든 첨부 삭제', '누가 올린 첨부파일이든 지웁니다.']]]
];
const projectWide = new Set(['BROWSE_PROJECTS', 'ADMINISTER_PROJECTS', 'MANAGE_SPRINTS_PERMISSION', 'MANAGE_TEAMS', 'CREATE_ISSUES', 'ASSIGNABLE_USER']);
const holderColumns = [
  { type: 'projectRole', parameter: '10002', label: '관리자' },
  { type: 'projectRole', parameter: '10003', label: '부관리자' },
  { type: 'projectRole', parameter: '10000', label: '멤버' },
  { type: 'projectRole', parameter: '10001', label: '보기 전용' },
  { type: 'projectLead', label: '프로젝트 리드' },
  { type: 'reporter', label: '보고자', hint: '그 이슈를 만든 사람' },
  { type: 'assignee', label: '담당자', hint: '그 이슈를 맡은 사람' }
];
const sameHolder = (grant, holder) => grant.holder.type === holder.type && (holder.parameter == null || grant.holder.parameter === holder.parameter);

export function permissionSources(grants, { accountId, roleId, isLead }) {
  const sources = {};
  for (const grant of grants) {
    const { type, parameter } = grant.holder;
    const reason = type === 'projectRole' && parameter === String(roleId) ? '역할'
      : type === 'user' && parameter === accountId ? '개별 부여'
        : type === 'projectLead' && isLead ? '프로젝트 리드'
          : type === 'reporter' ? '보고자일 때'
            : type === 'assignee' ? '담당자일 때' : null;
    if (reason) (sources[grant.permission] ??= []).push(reason);
  }
  return sources;
}

export function renderPermissions({ project, grants, users, roles, canEdit, inspect, onInspect, onGrant, onRevoke }) {
  const userById = new Map(users.map(u => [u.accountId, u]));
  const toggle = (permission, holder, grant) => (grant ? onRevoke(grant) : onGrant(permission, holder));
  const rows = permissionGroups.flatMap(([category, title, items]) => [
    h('tr', { class: 'group-row' }, h('th', { colspan: String(holderColumns.length + 2), scope: 'colgroup' }, title)),
    ...items.map(([permission, name, description]) => {
      const granted = grants.filter(g => g.permission === permission);
      const userGrants = granted.filter(g => g.holder.type === 'user');
      const outsiders = users.filter(u => !userGrants.some(g => g.holder.parameter === u.accountId));
      return h('tr', { dataset: { permission, category } },
        h('th', { scope: 'row' }, h('strong', {}, name), h('span', { class: 'muted small' }, description)),
        holderColumns.map(holder => {
          const grant = granted.find(g => sameHolder(g, holder));
          const impossible = projectWide.has(permission) && (holder.type === 'reporter' || holder.type === 'assignee');
          return h('td', { class: 'cell' }, impossible ? h('span', { class: 'muted', title: '이슈마다 달라지는 대상에는 프로젝트 전체 권한을 줄 수 없습니다' }, '—')
            : h('input', {
              type: 'checkbox',
              checked: Boolean(grant),
              disabled: !canEdit || grant?.locked,
              title: grant?.locked ? '관리자 역할은 이 권한을 잃을 수 없습니다' : null,
              'aria-label': `${holder.label}: ${name}`,
              onChange: () => toggle(permission, holder, grant)
            }));
        }),
        h('td', { class: 'people' },
          userGrants.map(g => h('span', { class: 'person-chip' },
            avatar(userById.get(g.holder.parameter)),
            userById.get(g.holder.parameter)?.displayName ?? g.holder.parameter,
            canEdit ? h('button', { class: 'icon-button small', type: 'button', 'aria-label': `${userById.get(g.holder.parameter)?.displayName} ${name} 회수`, onClick: () => onRevoke(g) }, '✕') : null)),
          canEdit && outsiders.length ? h('select', {
            class: 'add-person', 'aria-label': `${name}을(를) 줄 사람`,
            onChange: event => { if (event.target.value) onGrant(permission, { type: 'user', parameter: event.target.value }); }
          }, h('option', { value: '' }, '+ 사람'), outsiders.map(u => h('option', { value: u.accountId }, u.displayName))) : null));
    })]);

  const roleOfUser = accountId => roles.find(({ actors }) => actors.some(a => a.actorUser.accountId === accountId))?.role;
  const subject = userById.get(inspect) ?? users[0];
  const subjectRole = subject && roleOfUser(subject.accountId);
  const sources = subject ? permissionSources(grants, { accountId: subject.accountId, roleId: subjectRole?.id, isLead: project.lead?.accountId === subject.accountId }) : {};
  const inspector = subject ? h('section', { class: 'settings-form inspector' },
    h('div', { class: 'section-head' },
      h('h2', {}, '사람별 권한 확인'),
      h('select', { 'aria-label': '확인할 사람', onChange: event => onInspect(event.target.value) },
        users.map(u => h('option', { value: u.accountId, selected: u.accountId === subject.accountId }, u.displayName)))),
    h('p', { class: 'muted small' }, `${subject.displayName} · ${subjectRole ? roleLabel[subjectRole.name.toLowerCase()] : '역할 없음'}${project.lead?.accountId === subject.accountId ? ' · 프로젝트 리드' : ''}`),
    h('ul', { class: 'effective' }, permissionGroups.flatMap(([, , items]) => items).map(([permission, name]) => {
      const why = sources[permission] ?? [];
      const always = why.some(reason => reason !== '보고자일 때' && reason !== '담당자일 때');
      return h('li', { class: always ? 'yes' : why.length ? 'some' : 'no' },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, always ? '✓' : why.length ? '◐' : '–'),
        h('span', {}, name),
        h('span', { class: 'muted small' }, why.join(', ') || '권한 없음'));
    }))) : null;

  return h('div', { class: 'settings permissions' },
    h('div', { class: 'members-head' },
      h('h1', {}, `${project.name} 권한`),
      h('p', { class: 'muted small' }, canEdit
        ? '권한마다 누구에게 줄지 고릅니다. 역할 단위로 주거나, 특정 사람에게만 주거나, 그 이슈의 보고자·담당자에게만 줄 수 있습니다. 바꾸면 바로 적용됩니다.'
        : '프로젝트 관리자만 권한을 바꿀 수 있습니다.')),
    h('div', { class: 'matrix-wrap' }, h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, '권한'),
        holderColumns.map(holder => h('th', { scope: 'col', title: holder.hint }, holder.label)),
        h('th', { scope: 'col' }, '특정 사람'))),
      h('tbody', {}, rows))),
    inspector);
}

const boardTypeLabel = { scrum: '스크럼', kanban: '칸반' };
const shortDate = value => (value ? new Date(value.replace(/\+0000$/, 'Z')).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function renderSettings({ project, users, canEdit, siteAdmin, onSave, onArchive, onTrash }) {
  const stats = [
    ['키', project.key],
    ['이슈', `${project.insight.totalIssueCount}개`],
    ['멤버', `${project.properties.memberCount}명`],
    ['보드', boardTypeLabel[project.properties.boardType] ?? '없음']
  ];
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'settings-form', onSubmit: async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    error.textContent = '';
    try {
      await onSave({ name: data.name.trim(), leadAccountId: data.lead, assigneeType: data.assigneeType, url: data.url.trim(), description: data.description });
    } catch (failure) {
      error.textContent = failure.message;
    }
  } },
  h('h2', {}, '세부 정보'),
  h('div', { class: 'grid' },
    h('label', { class: 'wide' }, '이름', h('input', { name: 'name', required: true, maxlength: '80', value: project.name, disabled: !canEdit })),
    h('label', {}, '키', h('input', { value: project.key, disabled: true, title: '이슈 키가 바뀌지 않도록 프로젝트 키는 바꿀 수 없습니다' })),
    h('label', {}, '리드', h('select', { name: 'lead', disabled: !canEdit },
      users.map(u => h('option', { value: u.accountId, selected: u.accountId === project.lead?.accountId }, u.displayName)))),
    h('label', {}, '기본 담당자', h('select', { name: 'assigneeType', disabled: !canEdit },
      h('option', { value: 'UNASSIGNED', selected: project.assigneeType !== 'PROJECT_LEAD' }, '담당자 없음'),
      h('option', { value: 'PROJECT_LEAD', selected: project.assigneeType === 'PROJECT_LEAD' }, '프로젝트 리드'))),
    h('label', {}, 'URL', h('input', { name: 'url', type: 'url', value: project.url ?? '', placeholder: 'https://', disabled: !canEdit })),
    h('label', { class: 'wide' }, '설명', h('textarea', { name: 'description', rows: '3', maxlength: '2000', disabled: !canEdit }, project.description ?? ''))),
  h('p', { class: 'muted small' }, canEdit
    ? '리드를 바꾸면 새 리드가 관리자가 됩니다. 기본 담당자를 리드로 두면 담당자를 고르지 않은 새 이슈가 리드에게 배정됩니다.'
    : '프로젝트 관리자만 바꿀 수 있습니다.'),
  error,
  canEdit ? h('footer', {}, h('button', { class: 'button primary', type: 'submit' }, '저장')) : null);

  const danger = siteAdmin
    ? h('section', { class: 'danger-zone' },
      h('h2', {}, '프로젝트 정리'),
      h('div', { class: 'danger-row' },
        h('div', {}, h('strong', {}, '보관'), h('p', { class: 'muted small' }, '목록과 검색에서 숨기고 편집을 막습니다. 데이터는 그대로이며 언제든 복원할 수 있습니다.')),
        h('button', { class: 'button', type: 'button', onClick: onArchive }, '보관')),
      h('div', { class: 'danger-row' },
        h('div', {}, h('strong', {}, '휴지통으로 이동'), h('p', { class: 'muted small' }, '프로젝트 관리의 휴지통에서 복원하거나 영구 삭제할 수 있습니다.')),
        h('button', { class: 'button danger', type: 'button', onClick: onTrash }, '휴지통으로 이동')))
    : null;

  return h('div', { class: 'settings' },
    h('div', { class: 'members-head' }, h('h1', {}, `${project.name} 설정`)),
    h('dl', { class: 'stats' }, stats.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))),
    form,
    danger);
}

const statusTabs = [['live', '활성'], ['archived', '보관됨'], ['deleted', '휴지통']];

export function renderProjectAdmin({ projects, status, siteAdmin, currentKey, onStatus, onCreate, onOpen, onSettings, onArchive, onRestore, onTrash, onPurge }) {
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, (siteAdmin ? statusTabs : statusTabs.slice(0, 1)).map(([value, label]) =>
    h('button', { class: `tab${value === status ? ' on' : ''}`, role: 'tab', 'aria-selected': String(value === status), type: 'button', onClick: () => onStatus(value) }, label)));
  const actions = project => {
    const key = project.key;
    const admin = project.properties.role === 'administrators';
    if (status === 'archived') return [h('button', { class: 'button small', type: 'button', onClick: () => onRestore(project) }, '복원')];
    if (status === 'deleted') {
      return [
        h('button', { class: 'button small', type: 'button', onClick: () => onRestore(project) }, '복원'),
        h('button', { class: 'button small danger', type: 'button', onClick: () => onPurge(project) }, '영구 삭제')
      ];
    }
    return [
      key === currentKey ? h('span', { class: 'muted small' }, '보는 중') : h('button', { class: 'button small', type: 'button', onClick: () => onOpen(project) }, '열기'),
      admin || siteAdmin ? h('button', { class: 'button small ghost', type: 'button', onClick: () => onSettings(project) }, '설정') : null,
      siteAdmin ? h('button', { class: 'button small ghost', type: 'button', onClick: () => onArchive(project) }, '보관') : null,
      siteAdmin ? h('button', { class: 'button small ghost danger', type: 'button', onClick: () => onTrash(project) }, '휴지통') : null
    ];
  };
  const when = project => (status === 'archived'
    ? `${shortDate(project.properties.archivedDate)} · ${project.properties.archivedBy?.displayName ?? ''}`
    : status === 'deleted' ? `${shortDate(project.properties.deletedDate)} · ${project.properties.deletedBy?.displayName ?? ''}` : null);
  const empty = { live: '볼 수 있는 프로젝트가 없습니다.', archived: '보관된 프로젝트가 없습니다.', deleted: '휴지통이 비어 있습니다.' }[status];

  return h('div', { class: 'settings' },
    h('div', { class: 'admin-head' },
      h('div', {}, h('h1', {}, '프로젝트 관리'), h('p', { class: 'muted small' }, siteAdmin
        ? '모든 프로젝트를 보고 보관·복원·삭제할 수 있습니다.'
        : '참여 중인 프로젝트입니다. 관리자인 프로젝트는 설정을 바꿀 수 있습니다.')),
      siteAdmin ? h('button', { class: 'button primary', type: 'button', onClick: onCreate }, '새 프로젝트') : null),
    tabs,
    projects.length
      ? h('table', { class: 'project-table' },
        h('thead', {}, h('tr', {}, ['프로젝트', '리드', '이슈', '멤버', '보드', status === 'live' ? '내 역할' : status === 'archived' ? '보관' : '삭제', ''].map(label => h('th', { scope: 'col' }, label)))),
        h('tbody', {}, projects.map(project => h('tr', {},
          h('td', {}, h('strong', {}, project.name), h('span', { class: 'muted small' }, ` ${project.key}`),
            project.description ? h('div', { class: 'muted small clamp' }, project.description) : null),
          h('td', {}, project.lead ? h('span', { class: 'who' }, avatar(project.lead), project.lead.displayName) : '—'),
          h('td', { class: 'num' }, project.insight.totalIssueCount),
          h('td', { class: 'num' }, project.properties.memberCount),
          h('td', {}, boardTypeLabel[project.properties.boardType] ?? '—'),
          h('td', { class: 'small' }, when(project) ?? (roleLabel[project.properties.role] ?? (siteAdmin ? '사이트 관리자' : '—'))),
          h('td', {}, h('div', { class: 'row-actions' }, actions(project)))))))
      : h('p', { class: 'notice' }, empty));
}

export function projectForm(dialog, { users, lead, onSubmit }) {
  const form = h('form', { method: 'dialog', class: 'dialog-form' },
    h('h2', {}, '새 프로젝트'),
    h('div', { class: 'grid' },
      h('label', { class: 'wide' }, '이름', h('input', { name: 'name', required: true, maxlength: '80', autocomplete: 'off' })),
      h('label', {}, '키', h('input', { name: 'key', required: true, pattern: '[A-Z][A-Z0-9]{1,9}', maxlength: '10', autocomplete: 'off', placeholder: '예: WEB', title: '영문 대문자로 시작하는 2~10자 (대문자·숫자)', onInput: event => { event.target.value = event.target.value.toUpperCase(); } })),
      h('label', {}, '리드', h('select', { name: 'lead' }, users.map(u => h('option', { value: u.accountId, selected: u.accountId === lead }, u.displayName)))),
      h('label', { class: 'wide' }, '보드 방식', h('select', { name: 'template' },
        h('option', { value: 'com.pyxis.greenhopper.jira:gh-scrum-template' }, '스크럼 — 스프린트로 계획'),
        h('option', { value: 'com.pyxis.greenhopper.jira:gh-kanban-template' }, '칸반 — 흐름대로 진행'))),
      h('label', { class: 'wide' }, '설명', h('textarea', { name: 'description', rows: '2' }))),
    h('p', { class: 'muted small' }, '이슈 키는 이 키로 시작합니다 (예: WEB-1). 만든 사람과 리드는 관리자가 됩니다.'),
    h('p', { class: 'form-error', role: 'alert' }),
    h('footer', {},
      h('button', { class: 'button ghost', type: 'button', onClick: () => dialog.close() }, '취소'),
      h('button', { class: 'button primary', type: 'submit' }, '만들기')));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await onSubmit({ key: data.key, name: data.name.trim(), leadAccountId: data.lead, projectTemplateKey: data.template, description: data.description });
      dialog.close();
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
    }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
  form.elements.name.focus();
}

export function renderList({ issues, jql, error, tree, isOpen, onTree, onToggle, onExpandAll, onCollapseAll, onSearch, onOpen }) {
  const input = h('input', { type: 'search', class: 'jql', value: jql, 'aria-label': 'JQL 검색어', spellcheck: 'false', placeholder: 'project = OS AND status != Done ORDER BY priority DESC' });
  const form = h('form', { class: 'jql-bar', onSubmit: event => { event.preventDefault(); onSearch(input.value); } },
    input, h('button', { class: 'button', type: 'submit' }, '검색'));
  const roots = buildTree(issues);
  const parents = parentKeys(roots);
  const shown = new Set(issues.map(issue => issue.key));
  const rows = (tree ? flattenTree(roots, isOpen) : issues.map(issue => ({ issue, depth: 0, childCount: 0, open: false })))
    .map(({ issue, depth, childCount, open }) => {
      const f = issue.fields;
      const progress = childProgress(issue);
      const outsideParent = f.parent && (!tree || !shown.has(f.parent.key)) ? f.parent : null;
      return h('tr', {
        tabindex: '0',
        class: `depth-${Math.min(depth, 2)} cat-${f.status.statusCategory.key}`,
        dataset: { key: issue.key },
        onClick: () => onOpen(issue.key),
        onKeydown: event => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter') onOpen(issue.key);
          if (childCount && ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open))) onToggle(issue.key);
        }
      },
      h('td', {}, h('div', { class: 'tree-cell' },
        h('span', { class: 'tree-indent', style: `--depth:${depth}` }),
        childCount
          ? h('button', { class: 'twisty', type: 'button', 'aria-expanded': String(open), 'aria-label': `${issue.key} 하위 ${childCount}개 ${open ? '접기' : '펼치기'}`, onClick: stop(() => onToggle(issue.key)) }, open ? '▾' : '▸')
          : h('span', { class: 'twisty placeholder', 'aria-hidden': 'true' }),
        typeBadge(f.issuetype),
        h('span', { class: `num${f.status.statusCategory.key === 'done' ? ' struck' : ''}` }, issue.key))),
      h('td', { class: 'grow' },
        h('div', { class: 'summary-cell' },
          h('span', { class: 'summary-text' }, f.summary),
          outsideParent ? h('button', { class: `card-parent parent-${outsideParent.fields.issuetype.name.toLowerCase()}`, type: 'button', title: `상위 ${outsideParent.key} 열기`, onClick: stop(() => onOpen(outsideParent.key)) },
            typeGlyph[outsideParent.fields.issuetype.name] ?? '■', ' ', outsideParent.key) : null,
          blockers(issue).length ? h('span', { class: 'chip blocked' }, '막힘') : null,
          visibleLabels(f.labels).slice(0, 2).map(tag => h('span', { class: 'chip label' }, tag)))),
      h('td', {}, statusPill(f.status)),
      h('td', {}, h('span', { class: 'with-icon' }, priorityBadge(f.priority), priorityLabel[f.priority.name] ?? f.priority.name)),
      h('td', {}, h('span', { class: 'with-icon' }, whoStack(f, 2), f.assignee || f.team ? whoText(f) : h('span', { class: 'muted' }, '없음'))),
      h('td', {}, dueChip(f.duedate) ?? h('span', { class: 'muted' }, '—')),
      h('td', {}, progressChip(progress) ?? h('span', { class: 'muted' }, '—')),
      h('td', { class: 'num muted' }, relative(f.updated)));
    });
  const treeTools = h('div', { class: 'list-tools' },
    error ? h('p', { class: 'error', role: 'alert' }, error) : h('span', { class: 'muted small' }, `${issues.length}건`),
    h('span', { class: 'spacer' }),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: tree, onChange: event => onTree(event.target.checked) }), '상위·하위로 묶어 보기'),
    tree && parents.length ? [
      h('button', { class: 'button ghost small', type: 'button', onClick: () => onExpandAll(parents) }, '모두 펼치기'),
      h('button', { class: 'button ghost small', type: 'button', onClick: () => onCollapseAll(parents) }, '모두 접기')] : null);
  return h('div', { class: 'list-view' },
    form,
    treeTools,
    issues.length
      ? h('table', { class: 'issue-table' },
        h('thead', {}, h('tr', {}, ['키', '요약', '상태', '우선순위', '담당자', '기한', '하위', '수정'].map(label => h('th', { scope: 'col' }, label)))),
        h('tbody', {}, rows))
      : h('p', { class: 'list-empty' }, error ? '' : '조건에 맞는 이슈가 없습니다. 검색어를 바꿔 보세요.'));
}

const weekdayLabel = ['일', '월', '화', '수', '목', '금', '토'];
const hueOf = user => (user ? String([...user.accountId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5) : 'none');

function calendarBar(item, { today, canMove, onOpen, compact = false }) {
  const f = item.issue.fields;
  const done = f.status.statusCategory.key === 'done';
  const late = !done && f.duedate && f.duedate < today;
  const range = item.start === item.end ? item.start : `${item.start} ~ ${item.end}`;
  return h('button', {
    class: `cal-bar${done ? ' done' : ''}${late ? ' late' : ''}${item.cutStart ? ' cut-start' : ''}${item.cutEnd ? ' cut-end' : ''}`,
    type: 'button',
    style: `grid-column:${item.col + 1} / span ${item.span}; grid-row:${item.lane + 1}`,
    dataset: { hue: hueOf(f.assignee), key: item.issue.key },
    title: `${item.issue.key} ${f.summary}\n담당: ${whoText(f)}\n${item.onlyDue ? '기한' : item.onlyStart ? '시작' : '기간'}: ${range}${late ? '\n기한 지남' : ''}`,
    draggable: canMove(item.issue) ? 'true' : null,
    onDragstart: event => {
      event.dataTransfer.setData('text/plain', item.issue.key);
      event.dataTransfer.effectAllowed = 'move';
    },
    onClick: () => onOpen(item.issue.key)
  },
  compact ? null : whoStack(f, 2),
  h('span', { class: 'cal-key' }, item.issue.key),
  h('span', { class: 'cal-title' }, f.summary),
  item.onlyDue && !compact ? h('span', { class: 'cal-flag' }, '마감') : null);
}

function dropDays(element, days, { offset = 0 } = {}, onDrop) {
  element.addEventListener('dragover', event => { event.preventDefault(); element.classList.add('over'); });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('over'); });
  element.addEventListener('drop', event => {
    event.preventDefault();
    element.classList.remove('over');
    const key = event.dataTransfer.getData('text/plain');
    const box = element.getBoundingClientRect();
    const width = (box.width - offset) / days.length;
    const index = Math.min(days.length - 1, Math.max(0, Math.floor((event.clientX - box.left - offset) / width)));
    if (key) onDrop(key, days[index]);
  });
}

export function moveSpan(issue, day) {
  const { startdate, duedate } = issue.fields;
  const anchor = startdate ?? duedate;
  const delta = toDay(day) - toDay(anchor);
  const shift = value => (value ? fromDay(toDay(value) + delta) : value);
  return { startdate: shift(startdate), duedate: shift(duedate) };
}

function assigneeFilter(choices, teams, selected, chosen, me, onPeople) {
  const here = new Set(choices.map(choice => choice.id));
  const commit = ids => onPeople(new Set([...[...selected].filter(id => !here.has(id)), ...ids]));
  const toggle = id => commit(chosen.has(id) ? [...chosen].filter(other => other !== id) : [...chosen, id]);
  const mine = here.has(me);
  const teamChips = teams.map(team => ({ team, ids: teamIds(team, choices) })).filter(({ ids }) => ids.length).map(({ team, ids }) => {
    const on = teamPicked(chosen, ids);
    return h('label', { class: `who-chip team${on ? ' on' : ''}`, title: `${team.name}: ${team.members.map(m => m.displayName).join(', ')}` },
      h('input', { type: 'checkbox', checked: on, onChange: () => commit(toggleTeam(chosen, ids)) }),
      h('span', { class: 'team-mark', 'aria-hidden': 'true' }, '팀'),
      h('span', {}, team.name),
      h('span', { class: 'num muted' }, `${ids.length}명`));
  });
  return h('div', { class: 'who-filter', role: 'group', 'aria-label': '담당자 골라 보기' },
    teamChips.length ? [h('span', { class: 'muted small' }, '팀'), teamChips, h('span', { class: 'who-sep', 'aria-hidden': 'true' })] : null,
    h('span', { class: 'muted small' }, '담당자'),
    choices.map(({ id, person, count }) => h('label', { class: `who-chip${chosen.has(id) ? ' on' : ''}`, title: `${person?.displayName ?? '담당자 없음'} · ${count}건` },
      h('input', { type: 'checkbox', checked: chosen.has(id), onChange: () => toggle(id) }),
      avatar(person, 'sm'),
      h('span', {}, person?.displayName ?? '담당자 없음'),
      h('span', { class: 'num muted' }, count))),
    mine ? h('button', { class: 'button ghost small', type: 'button', onClick: () => commit([me]) }, '나만') : null,
    h('button', { class: 'button ghost small', type: 'button', disabled: chosen.size === 0, onClick: () => commit([]) },
      chosen.size ? `전체 보기 (${chosen.size}명 선택 중)` : '전체 보는 중'));
}

export function renderCalendar({ month, mode, issues, people, teams = [], today, hideDone, selected, me, canCreate, canMove, onMonth, onMode, onHideDone, onPeople, onOpen, onCreateOn, onMove }) {
  const visible = issues.filter(issue => !(hideDone && issue.fields.status.statusCategory.key === 'done'));
  const choices = assigneeChoices(visible, people);
  const chosen = chosenIds(selected, choices);
  const filtered = pickAssignees(visible, chosen);
  const dated = spans(filtered);
  const undated = filtered.filter(issue => !issue.fields.startdate && !issue.fields.duedate && issue.fields.status.statusCategory.key !== 'done');
  const [year, mon] = month.split('-').map(Number);
  const barOptions = { today, canMove, onOpen };

  const toolbar = h('div', { class: 'toolbar cal-toolbar' },
    h('div', { class: 'row-actions' },
      h('button', { class: 'button small', type: 'button', 'aria-label': '이전 달', onClick: () => onMonth(-1) }, '‹'),
      h('button', { class: 'button small', type: 'button', onClick: () => onMonth(0) }, '오늘'),
      h('button', { class: 'button small', type: 'button', 'aria-label': '다음 달', onClick: () => onMonth(1) }, '›')),
    h('h1', { class: 'cal-title-month' }, `${year}년 ${mon}월`),
    h('div', { class: 'tabs compact', role: 'tablist' },
      [['month', '월간 달력'], ['people', '사람별 일정']].map(([value, label]) => h('button', {
        class: `tab${mode === value ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(mode === value), onClick: () => onMode(value)
      }, label))),
    h('span', { class: 'spacer' }),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: hideDone, onChange: event => onHideDone(event.target.checked) }), '완료 숨기기'));

  const legend = h('p', { class: 'muted small cal-legend' },
    '막대는 시작일부터 기한까지입니다. 기한만 있으면 그날 하루로, ',
    h('span', { class: 'cal-flag' }, '마감'),
    '으로 표시합니다. 막대를 끌어 다른 날에 놓으면 그날이 새 시작일이 되고 기간 길이는 유지됩니다.');

  let body;
  if (mode === 'people') {
    const { days } = monthDays(month);
    const rows = byPerson(spans(filtered), chosen.size ? people.filter(person => chosen.has(person.accountId)) : people);
    const columns = `grid-template-columns: repeat(${days.length}, minmax(1.45rem, 1fr))`;
    const head = h('div', { class: 'people-row head' },
      h('div', { class: 'who-cell' }, '담당자'),
      h('div', { class: 'day-strip', style: columns }, days.map(day => h('span', {
        class: `day-head${day === today ? ' today' : ''}${[0, 6].includes(weekday(day)) ? ' weekend' : ''}`
      }, h('b', {}, Number(day.slice(8))), h('small', {}, weekdayLabel[weekday(day)])))));
    const personRows = rows.map(({ person: who, items }) => {
      const placed = layoutRange(items, days[0], days.at(-1));
      const busy = busyDays(items, days);
      const lanes = Math.max(1, ...placed.map(p => p.lane + 1));
      const strip = h('div', { class: 'day-strip lanes', style: `${columns}; grid-template-rows: repeat(${lanes}, 1.65rem)` },
        days.map((day, i) => h('span', {
          class: `heat${day === today ? ' today' : ''}${[0, 6].includes(weekday(day)) ? ' weekend' : ''}`,
          style: `grid-column:${i + 1}; grid-row: 1 / span ${lanes}`,
          dataset: { load: String(Math.min(busy[i], 3)) },
          title: `${day} · ${busy[i]}건`
        })),
        placed.map(item => calendarBar(item, { ...barOptions, compact: true })));
      dropDays(strip, days, {}, onMove);
      const active = items.filter(item => item.start <= today && today <= item.end).length;
      return h('div', { class: 'people-row' },
        h('div', { class: 'who-cell' },
          avatar(who),
          h('span', { class: 'grow' }, who?.displayName ?? '담당자 없음'),
          h('span', { class: 'muted small num', title: '이번 달 일정 / 오늘 진행 중' }, `${placed.length}건${active ? ` · 오늘 ${active}` : ''}`)),
        strip);
    });
    body = h('div', { class: 'people-cal' }, head, personRows);
  } else {
    const weeks = monthWeeks(month);
    body = h('div', { class: 'month-cal' },
      h('div', { class: 'week-head' }, weekdayLabel.map((label, i) => h('span', { class: [0, 6].includes(i) ? 'weekend' : '' }, label))),
      weeks.map(week => {
        const placed = layoutRange(dated, week[0], week[6]);
        const lanes = Math.max(0, ...placed.map(p => p.lane + 1));
        const cells = week.map((day, i) => h('div', {
          class: `cal-day${day.slice(0, 7) !== month ? ' other' : ''}${day === today ? ' today' : ''}${[0, 6].includes(i) ? ' weekend' : ''}`,
          style: `grid-column:${i + 1}; grid-row: 1 / span ${lanes + 2}`
        },
        h('span', { class: 'day-num' }, Number(day.slice(8))),
        canCreate ? h('button', { class: 'day-add', type: 'button', title: `${day}에 이슈 만들기`, 'aria-label': `${day}에 이슈 만들기`, onClick: () => onCreateOn(day) }, '+') : null));
        const bars = lanes ? h('div', { class: 'week-bars', style: `grid-row: 2 / span ${lanes}; grid-template-rows: repeat(${lanes}, 1.6rem)` }, placed.map(item => calendarBar(item, barOptions))) : null;
        const row = h('div', { class: 'week', style: `grid-template-rows: 1.7rem ${lanes ? `repeat(${lanes}, 1.6rem) ` : ''}minmax(1.4rem, auto)` }, cells, bars);
        dropDays(row, week, {}, onMove);
        return row;
      }));
  }

  return h('div', { class: 'calendar' },
    toolbar,
    choices.length ? assigneeFilter(choices, teams, selected, chosen, me, onPeople) : null,
    legend,
    body,
    undated.length ? h('details', { class: 'undated' },
      h('summary', {}, `날짜가 없는 진행 중 이슈 ${undated.length}개`, h('span', { class: 'muted small' }, ' · 열어서 시작일·기한을 정하세요')),
      h('ul', { class: 'children' }, undated.map(issue => h('li', {}, h('button', { class: 'child', onClick: () => onOpen(issue.key) },
        typeBadge(issue.fields.issuetype),
        h('span', { class: 'num' }, issue.key),
        h('span', { class: 'grow' }, issue.fields.summary),
        whoStack(issue.fields, 2),
        statusPill(issue.fields.status)))))) : null);
}

const relationLabel = { blocks: '막음', 'blocked by': '막힘', duplicates: '중복함', 'duplicated by': '중복됨', 'relates to': '관련' };

function linkPhrase(text) {
  const match = /^This issue (.+) (\S+)$/.exec(text ?? '');
  return match ? `${match[2]} (${relationLabel[match[1]] ?? match[1]})` : text;
}

function historyLine(entry) {
  return entry.items.map(item => {
    if (item.field === 'Rank') return item.toString === 'Ranked higher' ? '순위를 올렸습니다' : '순위를 내렸습니다';
    if (item.field === 'Link') return item.toString ? `연결 추가: ${linkPhrase(item.toString)}` : `연결 제거: ${linkPhrase(item.fromString)}`;
    if (item.field === 'Attachment') return item.toString ? `파일 첨부: ${item.toString}` : `첨부 삭제: ${item.fromString}`;
    const field = { status: '상태', assignee: '담당자', assignees: '담당자', team: '담당 팀', priority: '우선순위', summary: '요약', description: '설명', labels: '레이블', resolution: '해결', duedate: '기한', startdate: '시작일', parent: '상위 항목', Sprint: '스프린트' }[item.field] ?? item.field;
    const show = value => (item.field === 'status' ? statusLabel[value] ?? value : item.field === 'priority' ? priorityLabel[value] ?? value : value) ?? '없음';
    if (item.field === 'description') return `${field}을 수정했습니다`;
    return `${field}: ${show(item.fromString)} → ${show(item.toString)}`;
  }).join(', ');
}

function linksSection({ issue, linkTypes, canLink, onOpen, onLink, onUnlink }) {
  const links = issue.fields.issuelinks ?? [];
  const relations = linkTypes.flatMap(type => (type.inward === type.outward
    ? [{ value: `${type.name}|outward`, label: relationLabel[type.outward.toLowerCase()] ?? type.outward }]
    : [{ value: `${type.name}|outward`, label: relationLabel[type.outward.toLowerCase()] ?? type.outward },
      { value: `${type.name}|inward`, label: relationLabel[type.inward.toLowerCase()] ?? type.inward }]));
  const relation = h('select', { 'aria-label': '이 이슈와의 관계', title: '이 이슈가 상대 이슈를 막는지, 상대 이슈에 막히는지 고르세요' }, relations.map(r => h('option', { value: r.value }, r.label)));
  const target = h('input', { placeholder: 'OS-12', 'aria-label': '연결할 이슈 키', size: '8', required: true, pattern: '[A-Za-z]+-\\d+' });
  const form = canLink ? h('form', { class: 'link-form', onSubmit: event => {
    event.preventDefault();
    const [type, side] = relation.value.split('|');
    const other = target.value.trim().toUpperCase();
    if (side === 'outward') onLink(type, issue.key, other);
    else onLink(type, other, issue.key);
  } }, relation, target, h('button', { class: 'button ghost small', type: 'submit' }, '연결')) : null;
  return h('section', {},
    h('div', { class: 'section-head' }, h('h3', {}, '연결된 이슈'), links.length ? h('span', { class: 'muted small' }, `${links.length}건`) : null),
    links.length ? h('ul', { class: 'children' }, links.map(link => {
      const other = link.inwardIssue ?? link.outwardIssue;
      const phrase = link.inwardIssue ? link.type.outward : link.type.inward;
      return h('li', { class: 'link-row' },
        h('span', { class: 'relation muted small' }, relationLabel[phrase.toLowerCase()] ?? phrase),
        h('button', { class: 'child', onClick: () => onOpen(other.key) },
          typeBadge(other.fields.issuetype),
          h('span', { class: 'num' }, other.key),
          h('span', { class: 'grow' }, other.fields.summary),
          statusPill(other.fields.status)),
        canLink ? h('button', { class: 'icon-button', title: '연결 끊기', 'aria-label': `${other.key} 연결 끊기`, onClick: () => onUnlink(link.id) }, '✕') : null);
    })) : null,
    form);
}

function commentItem(c, { me, perms, onEdit, onDelete }) {
  const mine = c.author?.accountId === me;
  const canEdit = perms.EDIT_ALL_COMMENTS || (mine && perms.EDIT_OWN_COMMENTS);
  const canDelete = perms.DELETE_ALL_COMMENTS || (mine && perms.DELETE_OWN_COMMENTS);
  const text = h('p', {}, adfToText(c.body));
  const edited = c.updated !== c.created;
  const item = h('li', { class: 'comment' },
    h('div', { class: 'who' },
      avatar(c.author),
      h('strong', {}, c.author.displayName),
      h('span', { class: 'muted small', title: edited ? `${c.updateAuthor?.displayName ?? ''} 수정 · ${relative(c.updated)}` : null }, relative(c.created), edited ? ' · 수정됨' : ''),
      h('span', { class: 'spacer' }),
      canEdit ? h('button', { class: 'icon-button small', type: 'button', onClick: () => startEdit() }, '수정') : null,
      canDelete ? h('button', { class: 'icon-button small', type: 'button', onClick: () => onDelete(c) }, '삭제') : null),
    text);
  const startEdit = () => {
    const box = h('textarea', { rows: '3', 'aria-label': '댓글 수정' }, adfToText(c.body));
    const editor = h('form', { class: 'comment-form', onSubmit: event => {
      event.preventDefault();
      if (box.value.trim()) onEdit(c, box.value);
    } }, box, h('div', { class: 'row-actions' },
      h('button', { class: 'button ghost small', type: 'button', onClick: () => editor.replaceWith(text) }, '취소'),
      h('button', { class: 'button small primary', type: 'submit' }, '저장')));
    text.replaceWith(editor);
    box.focus();
  };
  return item;
}

function childTree(kids, { lookup, openKids, onToggleKid, onOpen, depth = 0 }) {
  return h('ul', { class: `children${depth ? ' nested' : ''}` }, kids.map(child => {
    const full = lookup(child.key);
    const grand = full ? childProgress(full) : { total: 0, done: 0, kids: [] };
    const open = openKids.has(child.key);
    return h('li', {},
      h('div', { class: 'child-row' },
        grand.total
          ? h('button', { class: 'twisty', type: 'button', 'aria-expanded': String(open), 'aria-label': `${child.key} 하위 ${open ? '접기' : '펼치기'}`, onClick: () => onToggleKid(child.key) }, open ? '▾' : '▸')
          : h('span', { class: 'twisty placeholder', 'aria-hidden': 'true' }),
        h('button', { class: 'child', onClick: () => onOpen(child.key) },
          typeBadge(child.fields.issuetype),
          h('span', { class: `num${child.fields.status.statusCategory.key === 'done' ? ' struck' : ''}` }, child.key),
          h('span', { class: 'grow' }, child.fields.summary),
          grand.total ? h('span', { class: 'muted small num' }, `${grand.done}/${grand.total}`) : null,
          full ? whoStack(full.fields, 2) : null,
          statusPill(child.fields.status))),
      open && grand.total ? childTree(grand.kids, { lookup, openKids, onToggleKid, onOpen, depth: depth + 1 }) : null);
  }));
}

export function archivePanel({ days, candidates, archived, onDays, onArchive, onRestore, onOpen }) {
  const when = iso => (iso ? new Date(iso.replace('+0000', 'Z')).toLocaleDateString('ko-KR') : '');
  return h('section', { class: 'settings-form archive-panel' },
    h('h2', {}, '이슈 보관'),
    h('p', { class: 'muted small' }, '오래 전에 완료된 이슈를 보관하면 보드·목록·검색·홈에서 빠져 화면과 불러오기가 가벼워집니다. 이슈 키로는 계속 열 수 있고(읽기 전용), 아래에서 언제든 보관 해제할 수 있습니다. 하위 작업은 상위 항목과 함께 움직입니다.'),
    h('div', { class: 'archive-run' },
      h('label', {}, '완료된 지',
        h('select', { 'aria-label': '보관 기준', onChange: event => onDays(Number(event.target.value)) },
          [30, 60, 90, 180, 365].map(n => h('option', { value: n, selected: n === days }, `${n}일`)))),
      h('span', {}, '지난 이슈'),
      h('strong', {}, `${candidates.length}개`),
      h('button', { class: 'button primary', type: 'button', disabled: !candidates.length, onClick: onArchive }, '보관하기')),
    h('h3', {}, `보관된 이슈 ${archived.length}개`),
    archived.length
      ? h('ul', { class: 'rows archived-list' }, archived.map(issue => h('li', { class: 'row' },
        h('button', { class: 'row-open', type: 'button', onClick: () => onOpen(issue.key) },
          typeBadge(issue.fields.issuetype),
          h('span', { class: 'key' }, issue.key),
          h('span', { class: 'grow' }, issue.fields.summary),
          h('span', { class: 'muted small' }, `${when(issue.fields.archiveddate)} · ${issue.fields.archivedby?.displayName ?? ''}`)),
        h('button', { class: 'button ghost small', type: 'button', onClick: () => onRestore(issue) }, '보관 해제'))))
      : h('p', { class: 'muted small' }, '아직 보관된 이슈가 없습니다.'));
}

function homeRow(issue, { onOpen, showProject }) {
  const f = issue.fields;
  return h('li', {},
    h('button', { class: 'home-row', type: 'button', onClick: () => onOpen(issue.key) },
      typeBadge(f.issuetype),
      h('span', { class: 'key' }, issue.key),
      h('span', { class: 'grow summary-text' }, f.summary),
      dueChip(f.duedate),
      statusPill(f.status),
      showProject ? null : whoStack(f)));
}

function homeCard({ title, hint, issues, empty, onOpen, limit = 8, tone, showProject = false, feature = false }) {
  return h('section', { class: `home-card${feature ? ' feature' : ''}${tone ? ` ${tone}` : ''}` },
    h('header', {},
      h('h2', {}, title),
      h('span', { class: 'count' }, issues.length),
      hint ? h('span', { class: 'muted small' }, hint) : null),
    issues.length
      ? h('ul', { class: 'home-list' }, issues.slice(0, limit).map(issue => homeRow(issue, { onOpen, showProject })))
      : h('p', { class: 'muted small home-empty' }, empty),
    issues.length > limit ? h('p', { class: 'muted small home-more' }, `외 ${issues.length - limit}개`) : null);
}

const svgNs = 'http://www.w3.org/2000/svg';

function donutSvg(ratio, tone) {
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('class', 'donut');
  svg.setAttribute('aria-hidden', 'true');
  const circle = (cls, attrs) => {
    const node = document.createElementNS(svgNs, 'circle');
    node.setAttribute('cx', '18');
    node.setAttribute('cy', '18');
    node.setAttribute('r', '14');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke-width', '3.5');
    node.setAttribute('class', cls);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  svg.append(circle('donut-track', {}));
  if (ratio > 0) {
    const length = 2 * Math.PI * 14;
    svg.append(circle(`donut-arc ${tone}`, {
      'stroke-linecap': ratio >= 1 ? 'butt' : 'round',
      'stroke-dasharray': `${(length * ratio).toFixed(3)} ${length.toFixed(3)}`,
      transform: 'rotate(-90 18 18)'
    }));
  }
  return svg;
}

function homeDonut({ value, total, label, tone }) {
  const ratio = donutRatio(value, total);
  return h('div', {
    class: `home-donut ${tone}`,
    role: 'img',
    'aria-label': total ? `${label} ${value}개, 열린 이슈 ${total}개 중` : `${label} ${value}개`
  },
  h('div', { class: 'donut-face' }, donutSvg(ratio, tone), h('strong', {}, value)),
  h('span', { class: 'donut-copy' },
    h('span', { class: 'donut-label' }, label),
    h('span', { class: 'muted small' }, total ? `열린 이슈 ${total}개 중` : '열린 이슈 없음')));
}

export function renderHome({ summary, me, onOpen, onProject }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침입니다' : hour < 18 ? '좋은 오후입니다' : '수고 많으셨습니다';
  const open = summary.counts.open;
  return h('div', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', {},
        h('p', { class: 'home-kicker' }, '대시보드'),
        h('h1', {}, `${greeting}, ${me.displayName}님`)),
      h('div', { class: 'home-donuts' },
        homeDonut({ value: summary.counts.mine, total: open, label: '내 할 일', tone: 'mine' }),
        homeDonut({ value: summary.overdue.length, total: open, label: '기한 지남', tone: 'late' }),
        homeDonut({ value: summary.soon.length, total: open, label: '7일 안 마감', tone: 'soon' }),
        h('div', { class: 'home-donut good', role: 'img', 'aria-label': `최근 7일 완료 ${summary.counts.doneThisWeek}개` },
          h('div', { class: 'donut-face plain' }, h('strong', {}, summary.counts.doneThisWeek)),
          h('span', { class: 'donut-copy' },
            h('span', { class: 'donut-label' }, '최근 7일 완료'),
            h('span', { class: 'muted small' }, '완료로 닫힌 이슈'))))),
    homeCard({ title: '내 할 일', hint: '나·내 팀에 배정된 미완료, 기한 순', issues: summary.mine, empty: '배정된 일이 없습니다.', onOpen, limit: 10, showProject: true, feature: true }),
    h('div', { class: 'home-grid' },
      homeCard({ title: '기한 지남', issues: summary.overdue, empty: '기한이 지난 이슈가 없습니다.', onOpen, tone: summary.overdue.length ? 'late' : '' }),
      homeCard({ title: '곧 마감', hint: '7일 안', issues: summary.soon, empty: '7일 안에 마감되는 이슈가 없습니다.', onOpen }),
      homeCard({ title: '내가 요청한 일', hint: '내가 보고했고 아직 안 끝난 것', issues: summary.reported, empty: '기다리는 일이 없습니다.', onOpen }),
      h('section', { class: 'home-card' },
        h('header', {}, h('h2', {}, '최근 변경')),
        summary.recent.length
          ? h('ul', { class: 'home-list' }, summary.recent.map(issue => h('li', {},
            h('button', { class: 'home-row', type: 'button', onClick: () => onOpen(issue.key) },
              typeBadge(issue.fields.issuetype),
              h('span', { class: 'key' }, issue.key),
              h('span', { class: 'grow summary-text' }, issue.fields.summary),
              h('span', { class: 'muted small' }, relative(issue.fields.updated))))))
          : h('p', { class: 'muted small home-empty' }, '아직 이슈가 없습니다.')),
      h('section', { class: 'home-card' },
        h('header', {}, h('h2', {}, '프로젝트 현황')),
        summary.projects.length
          ? h('ul', { class: 'home-projects' }, summary.projects.map(p => h('li', {},
            h('button', { class: 'home-project', type: 'button', onClick: () => onProject(p.key) },
              h('span', { class: 'home-project-name' }, h('strong', {}, p.key), ` ${p.name}`),
              h('span', { class: 'stack-bar', title: `할 일 ${p.new} · 진행 ${p.indeterminate} · 완료 ${p.done}` },
                h('i', { class: 'cat-new', style: `flex:${p.new}` }),
                h('i', { class: 'cat-indeterminate', style: `flex:${p.indeterminate}` }),
                h('i', { class: 'cat-done', style: `flex:${p.done}` })),
              h('span', { class: 'muted small' }, `${p.done}/${p.total} 완료${p.overdue ? ` · ${p.overdue}개 지남` : ''}`)))))
          : h('p', { class: 'muted small home-empty' }, '볼 수 있는 프로젝트가 없습니다.'))));
}

const userState = u => !u.active ? ['비활성', 'off']
  : !u.hasPassword ? ['비밀번호 없음', 'warn']
    : u.mustChangePassword ? ['임시 비밀번호', 'warn'] : ['사용 중', 'on'];

export function renderUsers({ users, me, project, onCreate, onReset, onToggleActive }) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'member-add user-add', onSubmit: async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    error.textContent = '';
    try {
      await onCreate(String(data.get('email')).trim(), String(data.get('name')).trim(), data.get('join') === 'on');
      event.target.reset();
    } catch (failure) {
      error.textContent = failure.message;
    }
  } },
  h('label', {}, '이름', h('input', { name: 'name', required: true, maxlength: '60', placeholder: '홍길동' })),
  h('label', {}, '이메일', h('input', { name: 'email', type: 'email', required: true, maxlength: '120', placeholder: 'name@company.com' })),
  project ? h('label', { class: 'check' }, h('input', { name: 'join', type: 'checkbox', checked: true }), `${project.name}에 멤버로 추가`) : null,
  h('button', { class: 'button primary', type: 'submit' }, '사용자 추가'));
  const active = users.filter(u => u.active).length;
  return h('div', { class: 'backlog' },
    h('div', { class: 'members-head' },
      h('h1', {}, '사용자'),
      h('p', { class: 'muted small' }, `활성 ${active}명 · 전체 ${users.length}명. 새 사용자에게는 임시 비밀번호가 발급되고, 첫 로그인 때 직접 바꿉니다. 비활성 사용자는 로그인할 수 없고 권한도 잃지만 이슈 기록은 남습니다.`)),
    form,
    error,
    h('section', { class: 'bucket' },
      h('ul', { class: 'rows members users' }, users.map(u => {
        const [label, tone] = userState(u);
        return h('li', { class: `row${u.active ? '' : ' inactive'}` },
          avatar(u),
          h('span', { class: 'grow' },
            h('span', {}, u.displayName, u.siteAdmin ? h('span', { class: 'muted small' }, ' · 사이트 관리자') : null),
            h('span', { class: 'muted small user-sub' }, u.emailAddress, u.projects.length ? ` · ${u.projects.map(p => `${p.key} ${roleLabel[p.role] ?? p.role}`).join(', ')}` : ' · 참여 프로젝트 없음')),
          h('span', { class: `user-state ${tone}` }, label),
          u.active ? h('button', { class: 'button ghost small', type: 'button', onClick: () => onReset(u) }, '비밀번호 재설정') : null,
          u.accountId === me ? null : h('button', { class: 'button ghost small', type: 'button', onClick: () => onToggleActive(u) }, u.active ? '비활성화' : '다시 활성화'));
      }))));
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const previewable = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function attachmentsSection({ attachments, perms, me, onUpload, onDeleteAttachment, loadBlob }) {
  const canAdd = perms.CREATE_ATTACHMENTS;
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onChange: event => {
    if (event.target.files.length) onUpload([...event.target.files]);
    event.target.value = '';
  } });
  const download = async attachment => {
    const url = URL.createObjectURL(await loadBlob(attachment.id));
    h('a', { href: url, download: attachment.filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const item = attachment => {
    const thumb = h('span', { class: 'attach-thumb', 'aria-hidden': 'true' }, attachment.filename.split('.').pop().slice(0, 4).toUpperCase());
    if (previewable.has(attachment.mimeType)) {
      loadBlob(attachment.id).then(blob => {
        const img = h('img', { src: URL.createObjectURL(blob), alt: '' });
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
        thumb.replaceChildren(img);
        thumb.classList.add('image');
      }).catch(() => {});
    }
    const mayDelete = perms.DELETE_ALL_ATTACHMENTS || (perms.DELETE_OWN_ATTACHMENTS && attachment.author?.accountId === me);
    return h('li', { class: 'attachment' },
      h('button', { class: 'attach-open', type: 'button', title: `${attachment.filename} 내려받기`, onClick: () => download(attachment).catch(() => {}) },
        thumb,
        h('span', { class: 'attach-meta' },
          h('span', { class: 'attach-name' }, attachment.filename),
          h('span', { class: 'muted small' }, `${fileSize(attachment.size)} · ${attachment.author?.displayName ?? '알 수 없음'} · ${relative(attachment.created)}`))),
      mayDelete ? h('button', { class: 'icon-button', type: 'button', 'aria-label': `${attachment.filename} 삭제`, title: '삭제', onClick: () => onDeleteAttachment(attachment) }, '✕') : null);
  };
  const section = h('section', { class: 'attachments' },
    h('div', { class: 'section-head' },
      h('h3', {}, '첨부파일'),
      attachments.length ? h('span', { class: 'muted small' }, `${attachments.length}개`) : null,
      h('span', { class: 'spacer' }),
      canAdd ? h('button', { class: 'button ghost small', type: 'button', onClick: () => picker.click() }, '파일 첨부') : null,
      picker),
    attachments.length
      ? h('ul', { class: 'attach-list' }, attachments.map(item))
      : h('p', { class: 'muted small attach-empty' }, canAdd ? '파일을 여기로 끌어다 놓거나 \'파일 첨부\'를 누르세요. 한 파일에 10MB까지 됩니다.' : '첨부파일이 없습니다.'));
  if (canAdd) {
    section.addEventListener('dragover', event => {
      if (![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      section.classList.add('dropping');
    });
    section.addEventListener('dragleave', event => { if (!section.contains(event.relatedTarget)) section.classList.remove('dropping'); });
    section.addEventListener('drop', event => {
      event.preventDefault();
      section.classList.remove('dropping');
      if (event.dataTransfer.files.length) onUpload([...event.dataTransfer.files]);
    });
  }
  return section;
}

export function renderDetail({ issue, users, teams = [], priorities, linkTypes, sprints, perms, me, lookup, openKids, onToggleKid, onClose, onTransition, onUpdate, onComment, onEditComment, onDeleteComment, onOpen, onDelete, onCreateChild, onLink, onUnlink, onSprint, onUpload, onDeleteAttachment, loadBlob, canArchive = false, onArchive, onUnarchive }) {
  const f = issue.fields;
  const archived = Boolean(f.archiveddate);
  if (archived) perms = {};
  const readOnly = !perms.EDIT_ISSUES;
  const summary = h('textarea', { class: 'detail-summary', rows: '1', 'aria-label': '요약', readonly: readOnly }, f.summary);
  summary.addEventListener('change', () => onUpdate({ summary: summary.value }));
  summary.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); summary.blur(); } });
  const description = h('textarea', { class: 'detail-description', rows: '5', placeholder: '무엇을, 왜 해야 하는지 적어 주세요.', 'aria-label': '설명', readonly: readOnly }, adfToText(f.description));
  description.addEventListener('change', () => onUpdate({ description: description.value }));

  const assignee = assigneePicker({
    users,
    teams,
    known: f.assignees ?? [],
    value: { team: f.team?.id ?? null, people: (f.assignees ?? []).map(p => p.accountId) },
    disabled: !perms.ASSIGN_ISSUES,
    onChange: ({ team, people }) => onUpdate({ team: team == null ? null : { id: team }, assignees: people.map(accountId => ({ accountId })) })
  });
  const priority = h('select', { 'aria-label': '우선순위', disabled: readOnly, onChange: event => onUpdate({ priority: { id: event.target.value } }) },
    priorities.map(p => h('option', { value: p.id, selected: f.priority.id === p.id }, priorityLabel[p.name] ?? p.name)));
  const labelInput = h('input', { value: f.labels.join(' '), 'aria-label': '레이블', placeholder: '공백으로 구분', readonly: readOnly });
  labelInput.addEventListener('change', () => onUpdate({ labels: labelInput.value.split(/\s+/).filter(Boolean) }));
  const due = h('input', { type: 'date', value: f.duedate ?? '', min: f.startdate ?? null, 'aria-label': '기한', readonly: readOnly, onChange: event => onUpdate({ duedate: event.target.value || null }) });
  const start = h('input', { type: 'date', value: f.startdate ?? '', max: f.duedate ?? null, 'aria-label': '시작일', readonly: readOnly, onChange: event => onUpdate({ startdate: event.target.value || null }) });
  const schedulable = f.issuetype.hierarchyLevel === 0;
  const sprintField = !schedulable
    ? h('span', { class: 'muted small' }, f.sprint ? `${f.sprint.name} (상위 항목을 따름)` : f.issuetype.subtask ? '상위 항목을 따름' : '에픽은 스프린트에 넣지 않습니다')
    : h('select', { 'aria-label': '스프린트', disabled: !perms.SCHEDULE_ISSUES, onChange: event => onSprint(event.target.value ? Number(event.target.value) : null) },
      h('option', { value: '' }, '백로그'),
      (f.sprint && !sprints.some(s => s.id === f.sprint.id) ? [f.sprint, ...sprints] : sprints)
        .map(s => h('option', { value: s.id, selected: f.sprint?.id === s.id }, `${s.name}${s.state === 'active' ? ' (진행 중)' : s.state === 'closed' ? ' (완료)' : ''}`)));

  const commentBox = h('textarea', { rows: '3', placeholder: '처리 내용이나 질문을 남기세요.', 'aria-label': '댓글' });
  const commentForm = perms.ADD_COMMENTS ? h('form', { class: 'comment-form', onSubmit: event => {
    event.preventDefault();
    if (commentBox.value.trim()) onComment(commentBox.value);
  } }, commentBox, h('button', { class: 'button', type: 'submit' }, '댓글 남기기')) : null;

  const linked = [...f.children, ...f.subtasks];
  const childType = f.issuetype.name === 'Epic' ? 'Story' : f.issuetype.subtask ? null : 'Subtask';
  const activity = [
    ...f.comment.comments.map(c => ({ at: c.created, node: commentItem(c, { me, perms, onEdit: onEditComment, onDelete: onDeleteComment }) })),
    ...(issue.changelog?.histories ?? []).map(entry => ({ at: entry.created, node: h('li', { class: 'history' },
      h('span', { class: 'muted small' }, `${entry.author?.displayName ?? '시스템'} · ${relative(entry.created)}`),
      h('span', {}, historyLine(entry))) }))
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return h('aside', { class: 'detail', 'aria-label': `${issue.key} 상세` },
    h('header', { class: 'detail-head' },
      (() => {
        const grand = f.parent && lookup(f.parent.key)?.fields.parent;
        return grand ? h('button', { class: 'crumb', title: grand.fields.summary, onClick: () => onOpen(grand.key) }, typeBadge(grand.fields.issuetype), grand.key) : null;
      })(),
      f.parent ? h('button', { class: 'crumb', title: f.parent.fields.summary, onClick: () => onOpen(f.parent.key) }, typeBadge(f.parent.fields.issuetype), f.parent.key) : null,
      h('span', { class: 'crumb current' }, typeBadge(f.issuetype), issue.key),
      h('span', { class: 'spacer' }),
      canArchive && !archived && !f.issuetype.subtask ? h('button', { class: 'icon-button', onClick: onArchive, title: '보드·목록·검색에서 빼고 보관합니다' }, '보관') : null,
      perms.DELETE_ISSUES ? h('button', { class: 'icon-button', onClick: onDelete, title: '이슈 삭제', 'aria-label': '이슈 삭제' }, '삭제') : null,
      h('button', { class: 'icon-button', onClick: onClose, 'aria-label': '닫기' }, '✕')),
    archived ? h('div', { class: 'archived-banner', role: 'status' },
      h('span', {}, `보관된 이슈입니다 · ${new Date(f.archiveddate.replace('+0000', 'Z')).toLocaleDateString('ko-KR')} · ${f.archivedby?.displayName ?? ''}. 보관 중에는 고칠 수 없습니다.`),
      canArchive && !f.issuetype.subtask ? h('button', { class: 'button small', type: 'button', onClick: onUnarchive }, '보관 해제') : null) : null,
    summary,
    h('div', { class: 'workflow' },
      statusPill(f.status),
      (perms.TRANSITION_ISSUES ? issue.transitions ?? [] : []).map(t => h('button', {
        class: `button ${t.to.statusCategory.key === 'done' ? 'primary' : 'ghost'}`,
        onClick: () => onTransition(t.id)
      }, transitionLabel[t.name] ?? t.name)),
      f.resolution ? h('span', { class: 'muted small' }, `해결: ${f.resolution.name}`) : null),
    h('dl', { class: 'fields' },
      h('dt', {}, '담당자'), h('dd', {}, assignee),
      h('dt', {}, '보고자'), h('dd', {}, f.reporter?.displayName ?? '—'),
      h('dt', {}, '우선순위'), h('dd', {}, priority),
      h('dt', {}, '레이블'), h('dd', {}, labelInput),
      h('dt', {}, '시작일'), h('dd', {}, start),
      h('dt', {}, '기한'), h('dd', {}, due),
      h('dt', {}, '스프린트'), h('dd', {}, sprintField),
      h('dt', {}, '만든 시각'), h('dd', {}, new Date(f.created.replace('+0000', 'Z')).toLocaleString('ko-KR'))),
    h('section', {},
      h('h3', {}, '설명'),
      description),
    childType || linked.length ? h('section', {},
      h('div', { class: 'section-head' },
        h('h3', {}, f.issuetype.name === 'Epic' ? '에픽의 티켓' : '하위 작업'),
        linked.length ? h('span', { class: 'muted small' }, `${linked.filter(c => c.fields.status.statusCategory.key === 'done').length}/${linked.length} 완료`) : null,
        h('span', { class: 'spacer' }),
        childType && perms.CREATE_ISSUES ? h('button', { class: 'button ghost small', onClick: () => onCreateChild(childType) }, childType === 'Story' ? '티켓 추가' : '하위 작업 추가') : null),
      linked.length ? h('span', { class: 'meter wide', style: `--ratio:${linked.filter(c => c.fields.status.statusCategory.key === 'done').length / linked.length}` }) : null,
      linked.length ? childTree(linked, { lookup, openKids, onToggleKid, onOpen }) : null) : null,
    linksSection({ issue, linkTypes, canLink: perms.LINK_ISSUES, onOpen, onLink, onUnlink }),
    attachmentsSection({ attachments: f.attachment ?? [], perms, me, onUpload, onDeleteAttachment, loadBlob }),
    h('section', {},
      h('h3', {}, '활동'),
      commentForm,
      h('ol', { class: 'activity' }, activity.map(a => a.node))));
}
