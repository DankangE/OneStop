import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcadeInput } from '../sim/arcade-input.js';

function setup(t, { supported = true } = {}) {
  const previous = new Map(['window', 'document', 'matchMedia'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const canvas = new EventTarget(), window = new EventTarget(), document = new EventTarget();
  const classes = new Set();
  document.body = { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } };
  document.querySelectorAll = () => [];
  document.pointerLockElement = null;
  document.exitPointerLock = () => { document.pointerLockElement = null; document.dispatchEvent(new Event('pointerlockchange')); };
  globalThis.document = document; globalThis.window = window; globalThis.matchMedia = () => ({ matches: true });
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  let active = true, pauses = 0, captures = 0;
  const looks = [], notices = [];
  canvas.requestPointerLock = () => {
    captures++;
    if (!supported) return Promise.reject(new Error('Unavailable'));
    document.pointerLockElement = canvas; document.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  const input = new ArcadeInput({ canvas, active: () => active, look: (...delta) => looks.push(delta), pause: () => pauses++, notify: message => notices.push(message) });
  const dispatch = (target, type, values = {}) => {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerType: 'mouse', button: 0, clientX: 10, clientY: 20, ...values }); target.dispatchEvent(event);
  };
  return { canvas, window, document, input, dispatch, looks, notices, setActive: value => { active = value; }, get pauses() { return pauses; }, get captures() { return captures; } };
}

test('left fire and right focus release independently, and reset clears held buttons', t => {
  const f = setup(t);
  f.dispatch(f.canvas, 'pointerdown');
  assert.equal(f.input.firing, true); assert.equal(f.captures, 1);
  f.dispatch(f.canvas, 'pointerdown', { button: 2 });
  assert.equal(f.input.focused, true);
  f.dispatch(f.window, 'pointerup', { button: 2 });
  assert.equal(f.input.focused, false); assert.equal(f.input.firing, true);
  f.dispatch(f.canvas, 'pointerdown', { button: 2 });
  f.dispatch(f.window, 'pointerup', { button: 0 });
  assert.equal(f.input.firing, false); assert.equal(f.input.focused, true);
  f.input.reset(); assert.equal(f.input.focused, false);
  assert.equal(f.input.firing, false); assert.equal(f.input.drag, null);
});

test('when pointer lock is unavailable drag aiming and firing still work', async t => {
  const f = setup(t, { supported: false });
  f.dispatch(f.canvas, 'pointerdown');
  await Promise.resolve();
  assert.equal(f.notices.length, 1); assert.equal(f.input.firing, true);
  f.dispatch(f.document, 'pointermove', { clientX: 24, clientY: 15 });
  assert.deepEqual(f.looks, [[14, -5]]);
  f.dispatch(f.window, 'pointercancel');
  assert.equal(f.input.firing, false); assert.equal(f.input.focused, false);
  f.dispatch(f.document, 'pointermove', { clientX: 50, clientY: 50 });
  assert.equal(f.looks.length, 1);
});

test('losing mouse capture pauses an active game but not a modal or observer view', t => {
  const f = setup(t);
  f.input.capture(); f.document.exitPointerLock(); assert.equal(f.pauses, 1);
  f.input.capture(); f.setActive(false); f.document.exitPointerLock(); assert.equal(f.pauses, 1);
  f.input.capture(); assert.equal(f.captures, 2);
  f.dispatch(f.canvas, 'pointerdown'); assert.equal(f.input.firing, false);
});
