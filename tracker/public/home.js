import { peopleOf, toDay, fromDay } from './calendar.js';

const priorityRank = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
const isDone = issue => issue.fields.status.statusCategory.key === 'done';
const due = issue => issue.fields.duedate ?? null;

export function byUrgency(a, b) {
  const [da, db] = [due(a), due(b)];
  if (da !== db) return da == null ? 1 : db == null ? -1 : da < db ? -1 : 1;
  return (priorityRank[b.fields.priority?.name] ?? 3) - (priorityRank[a.fields.priority?.name] ?? 3);
}

export function homeSummary(issues, me, today, { soonDays = 7, recent = 8 } = {}) {
  const open = issues.filter(issue => !isDone(issue));
  const horizon = fromDay(toDay(today) + soonDays);
  const isMine = issue => peopleOf(issue).some(person => person.accountId === me);
  const mine = open.filter(isMine).sort(byUrgency);
  const projects = new Map();
  for (const issue of issues) {
    const { key, name } = issue.fields.project;
    const row = projects.get(key) ?? { key, name, new: 0, indeterminate: 0, done: 0, total: 0, overdue: 0 };
    row[issue.fields.status.statusCategory.key] += 1;
    row.total += 1;
    if (!isDone(issue) && due(issue) && due(issue) < today) row.overdue += 1;
    projects.set(key, row);
  }
  return {
    mine,
    overdue: open.filter(issue => due(issue) && due(issue) < today).sort(byUrgency),
    soon: open.filter(issue => due(issue) && due(issue) >= today && due(issue) <= horizon).sort(byUrgency),
    reported: open.filter(issue => issue.fields.reporter?.accountId === me && !isMine(issue)).sort(byUrgency),
    recent: [...issues].sort((a, b) => (a.fields.updated < b.fields.updated ? 1 : -1)).slice(0, recent),
    projects: [...projects.values()].sort((a, b) => a.key.localeCompare(b.key)),
    counts: { open: open.length, mine: mine.length, doneThisWeek: issues.filter(issue => isDone(issue) && issue.fields.resolutiondate && issue.fields.resolutiondate.slice(0, 10) > fromDay(toDay(today) - 7)).length }
  };
}
