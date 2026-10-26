export function buildTree(issues) {
  const byKey = new Map(issues.map(issue => [issue.key, { issue, children: [] }]));
  const roots = [];
  for (const node of byKey.values()) {
    const parent = byKey.get(node.issue.fields.parent?.key);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function flattenTree(roots, isOpen, depth = 0) {
  return roots.flatMap(node => {
    const open = node.children.length > 0 && isOpen(node.issue.key);
    const row = { issue: node.issue, depth, childCount: node.children.length, open };
    return open ? [row, ...flattenTree(node.children, isOpen, depth + 1)] : [row];
  });
}

export function parentKeys(roots) {
  return roots.flatMap(node => (node.children.length ? [node.issue.key, ...parentKeys(node.children)] : []));
}

export function childProgress(issue) {
  const kids = [...(issue.fields.subtasks ?? []), ...(issue.fields.children ?? [])];
  const done = kids.filter(kid => kid.fields.status.statusCategory.key === 'done').length;
  return { total: kids.length, done, kids };
}

const epicOf = (issue, byKey) => {
  if (issue.fields.issuetype.name === 'Epic') return issue.key;
  const parent = issue.fields.parent && byKey.get(issue.fields.parent.key);
  if (!parent) return issue.fields.parent?.fields.issuetype.name === 'Epic' ? issue.fields.parent.key : null;
  return parent.fields.issuetype.name === 'Epic' ? parent.key : parent.fields.parent?.key ?? null;
};

export function groupLanes(issues, by, everything = issues) {
  if (by === 'none') return [{ id: 'all', title: null, issues }];
  const byKey = new Map(everything.map(issue => [issue.key, issue]));
  const lanes = new Map();
  const add = (id, title, issue, order) => {
    if (!lanes.has(id)) lanes.set(id, { id, title, issues: [], order });
    lanes.get(id).issues.push(issue);
  };
  for (const issue of issues) {
    if (by === 'assignee') {
      const who = issue.fields.assignee;
      const team = issue.fields.team;
      if (who) add(who.accountId, who.displayName, issue, 0);
      else if (team) add(`team:${team.id}`, `팀 ${team.name}`, issue, 0);
      else add('-', '담당자 없음', issue, 1);
    } else {
      const epic = epicOf(issue, byKey);
      const owner = epic && byKey.get(epic);
      add(epic ?? '-', epic ? `${owner?.fields.summary ?? epic}` : '에픽 없음', issue, epic ? 0 : 1);
    }
  }
  return [...lanes.values()].sort((a, b) => a.order - b.order || String(a.title).localeCompare(String(b.title), 'ko'));
}

export const recentDoneDays = 14;

export function finishedOn(issue) {
  return (issue.fields.resolutiondate ?? issue.fields.updated ?? '').slice(0, 10);
}

export function isStaleDone(issue, cutoff) {
  return Boolean(cutoff) && issue.fields.status.statusCategory.key === 'done' && finishedOn(issue) < cutoff;
}

export function dueState(duedate, today = new Date()) {
  if (!duedate) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = duedate.split('-').map(Number);
  const days = Math.round((new Date(y, m - 1, d) - start) / 86400000);
  return { days, tone: days < 0 ? 'late' : days <= 2 ? 'soon' : 'later' };
}
