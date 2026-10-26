import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedTheme, toggledTheme } from '../public/theme.js';

test('theme follows the system until a choice is saved', () => {
  assert.equal(resolvedTheme(null, false), 'light');
  assert.equal(resolvedTheme('', true), 'dark');
  assert.equal(resolvedTheme('light', true), 'light');
  assert.equal(resolvedTheme('dark', false), 'dark');
  assert.equal(resolvedTheme('other', true), 'dark');
});

test('the appearance toggle switches between light and dark', () => {
  assert.equal(toggledTheme('light'), 'dark');
  assert.equal(toggledTheme('dark'), 'light');
});
