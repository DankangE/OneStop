export const statusCategories = {
  new: { id: 2, key: 'new', colorName: 'blue-gray', name: 'To Do' },
  indeterminate: { id: 4, key: 'indeterminate', colorName: 'yellow', name: 'In Progress' },
  done: { id: 3, key: 'done', colorName: 'green', name: 'Done' }
};

export const statuses = [
  { id: '10000', name: 'To Do', category: 'new', description: '아직 시작하지 않은 작업입니다.' },
  { id: '10001', name: 'In Progress', category: 'indeterminate', description: '담당자가 처리 중입니다.' },
  { id: '10002', name: 'In Review', category: 'indeterminate', description: '검토를 기다리고 있습니다.' },
  { id: '10003', name: 'Done', category: 'done', description: '처리가 끝났습니다.' }
];

export const initialStatusId = '10000';

export const transitions = [
  { id: '11', name: 'To Do', from: ['10001', '10002'], to: '10000' },
  { id: '21', name: 'Start progress', from: ['10000', '10002'], to: '10001' },
  { id: '31', name: 'Request review', from: ['10001'], to: '10002' },
  { id: '41', name: 'Done', from: ['10001', '10002'], to: '10003', resolution: 'Done' },
  { id: '51', name: 'Reopen', from: ['10003'], to: '10000', clearsResolution: true }
];

export function findStatus(idOrName) {
  const needle = String(idOrName).toLowerCase();
  return statuses.find(status => status.id === needle || status.name.toLowerCase() === needle) || null;
}

export function availableTransitions(statusId) {
  return transitions.filter(transition => transition.from.includes(statusId));
}

export function findTransition(statusId, transitionId) {
  return availableTransitions(statusId).find(transition => transition.id === String(transitionId)) || null;
}

export function statusView(status, baseUrl) {
  const category = statusCategories[status.category];
  return {
    self: `${baseUrl}/rest/api/3/status/${status.id}`,
    id: status.id,
    name: status.name,
    description: status.description,
    statusCategory: { ...category, self: `${baseUrl}/rest/api/3/statuscategory/${category.id}` }
  };
}

export function transitionView(transition, baseUrl) {
  return {
    id: transition.id,
    name: transition.name,
    to: statusView(findStatus(transition.to), baseUrl),
    hasScreen: false,
    isGlobal: false,
    isInitial: false,
    isAvailable: true,
    isConditional: false
  };
}
