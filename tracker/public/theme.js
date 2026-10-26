export function resolvedTheme(stored, systemDark) {
  if (stored === 'dark' || stored === 'light') return stored;
  return systemDark ? 'dark' : 'light';
}

export function toggledTheme(current) {
  return current === 'dark' ? 'light' : 'dark';
}
