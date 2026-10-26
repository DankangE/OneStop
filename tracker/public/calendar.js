const dayMs = 86400000;

export const toDay = iso => Math.round(Date.parse(`${iso}T00:00:00Z`) / dayMs);
export const fromDay = n => new Date(n * dayMs).toISOString().slice(0, 10);
export const weekday = iso => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function localToday(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function monthDays(month) {
  const first = toDay(`${month}-01`);
  const last = toDay(`${shiftMonth(month, 1)}-01`) - 1;
  return { first, last, days: Array.from({ length: last - first + 1 }, (_, i) => fromDay(first + i)) };
}

export function monthWeeks(month) {
  const { first, last } = monthDays(month);
  const start = first - weekday(fromDay(first));
  const weeks = [];
  for (let day = start; day <= last; day += 7) weeks.push(Array.from({ length: 7 }, (_, i) => fromDay(day + i)));
  return weeks;
}

export function issueSpan(issue) {
  const { startdate, duedate } = issue.fields;
  const start = startdate ?? duedate;
  const end = duedate ?? startdate;
  if (!start) return null;
  return { start, end, onlyDue: !startdate, onlyStart: !duedate };
}

export function spans(issues) {
  return issues.flatMap(issue => {
    const span = issueSpan(issue);
    return span ? [{ issue, ...span }] : [];
  });
}

export function layoutRange(items, from, to) {
  const lo = toDay(from);
  const hi = toDay(to);
  const placed = items
    .map(item => ({ item, s: toDay(item.start), e: toDay(item.end) }))
    .filter(({ s, e }) => e >= lo && s <= hi)
    .sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || a.item.issue.key.localeCompare(b.item.issue.key, 'en', { numeric: true }));
  const laneEnds = [];
  return placed.map(({ item, s, e }) => {
    const from_ = Math.max(s, lo);
    const to_ = Math.min(e, hi);
    let lane = laneEnds.findIndex(end => end < from_);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = to_;
    return { ...item, col: from_ - lo, span: to_ - from_ + 1, lane, cutStart: s < lo, cutEnd: e > hi };
  });
}

export function peopleOf(issue) {
  const f = issue.fields;
  const named = f.assignees ?? (f.assignee ? [f.assignee] : []);
  const people = new Map();
  for (const person of [...named, ...(f.team?.members ?? [])]) if (person && !people.has(person.accountId)) people.set(person.accountId, person);
  return [...people.values()];
}

export function byPerson(items, people) {
  const rows = people.map(person => ({ person, items: [] }));
  const unassigned = { person: null, items: [] };
  for (const item of items) {
    const who = peopleOf(item.issue);
    if (!who.length) unassigned.items.push(item);
    for (const person of who) {
      const row = rows.find(r => r.person.accountId === person.accountId);
      if (row) row.items.push(item);
      else rows.push({ person, items: [item] });
    }
  }
  return unassigned.items.length ? [...rows, unassigned] : rows;
}

export const UNASSIGNED = '-';

const assigneeIds = issue => {
  const ids = peopleOf(issue).map(person => person.accountId);
  return ids.length ? ids : [UNASSIGNED];
};

export function assigneeChoices(issues, people) {
  const choices = people.map(person => ({ id: person.accountId, person, count: 0 }));
  const byId = new Map(choices.map(choice => [choice.id, choice]));
  for (const issue of issues) {
    const who = new Map(peopleOf(issue).map(person => [person.accountId, person]));
    for (const id of assigneeIds(issue)) {
      if (!byId.has(id)) {
        const choice = { id, person: who.get(id) ?? null, count: 0 };
        byId.set(id, choice);
        choices.push(choice);
      }
      byId.get(id).count += 1;
    }
  }
  const unassigned = byId.get(UNASSIGNED);
  return unassigned ? [...choices.filter(choice => choice !== unassigned), unassigned] : choices;
}

export function chosenIds(selected, choices) {
  return new Set(choices.map(choice => choice.id).filter(id => selected.has(id)));
}

export function teamIds(team, choices) {
  const here = new Set(choices.map(choice => choice.id));
  return team.members.map(member => member.accountId).filter(id => here.has(id));
}

export function teamPicked(chosen, ids) {
  return ids.length > 0 && ids.every(id => chosen.has(id));
}

export function toggleTeam(chosen, ids) {
  return teamPicked(chosen, ids) ? [...chosen].filter(id => !ids.includes(id)) : [...new Set([...chosen, ...ids])];
}

export function pickAssignees(issues, chosen) {
  return chosen.size ? issues.filter(issue => assigneeIds(issue).some(id => chosen.has(id))) : issues;
}

export function busyDays(items, days) {
  return days.map(day => items.filter(item => item.start <= day && day <= item.end).length);
}
