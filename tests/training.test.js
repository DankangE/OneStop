import test from 'node:test';
import assert from 'node:assert/strict';
import { DronePhysics, FIXED_DT, clamp, wrap, DEG } from '../sim/physics.js';
import { TrainingSession, WAYPOINTS } from '../sim/training.js';

const tick = (session, drone, seconds, input = {}) => { for (let i = 0; i < Math.ceil(seconds / FIXED_DT); i++) session.tick(FIXED_DT, drone, input); };
function droneAtFive() { const d = new DronePhysics(); d.reset({ altitude: 5.26 }); return d; }

test('hover needs ten continuous stable seconds, restarting after an excursion', () => {
  const s = new TrainingSession('hover', 'position', 0), d = droneAtFive();
  tick(s, d, 8); assert.equal(s.finished, false);
  d.position.x = 2; tick(s, d, 0.1); assert.equal(s.hold, 0);
  d.position.x = 0; tick(s, d, 9); assert.equal(s.finished, false);
  tick(s, d, 1.1); assert.ok(s.passed);
});

test('passing through hover volume at speed does not count as hovering', () => {
  const s = new TrainingSession('hover', 'position', 0), d = droneAtFive();
  d.velocity.x = 2; tick(s, d, 12); assert.equal(s.finished, false); assert.equal(s.progress, 0);
});

test('square requires all four ordered points and two seconds stopped at each', () => {
  const s = new TrainingSession('square', 'position', 0), d = droneAtFive();
  d.position.set(...[12,5.26,0]); tick(s, d, 3); assert.equal(s.stage, 0);
  for (const [x, y, z] of WAYPOINTS) { d.position.set(x, y + 0.26, z); tick(s, d, 2.02); }
  assert.ok(s.finished && s.passed);
});

test('precision landing rejects a fast touchdown even without a crash', () => {
  const s = new TrainingSession('landing', 'position', 0), d = droneAtFive();
  d.contact = { sink: 1.3, horizontalSpeed: 0, tilt: 0, x: 0, z: 0 };
  s.tick(FIXED_DT, d, {}); assert.ok(s.finished); assert.equal(s.passed, false);
  const good = new TrainingSession('landing', 'position', 0);
  d.contact.sink = 0.35; good.tick(FIXED_DT, d, {}); assert.ok(good.passed);
});

test('an off-pad landing is not awarded precision landing completion', () => {
  const s = new TrainingSession('landing', 'position', 0), d = droneAtFive();
  d.contact = { sink: 0.2, horizontalSpeed: 0.1, tilt: 2, x: 4, z: 0 };
  s.tick(FIXED_DT, d, {}); assert.equal(s.passed, false);
});

test('rescue is recorded by activation and duration, separately from task completion', () => {
  const s = new TrainingSession('hover', 'attitude', 1.5), d = droneAtFive();
  tick(s, d, 2, { rescue: true }); tick(s, d, 1); tick(s, d, 2, { rescue: true });
  assert.equal(s.assistance, 2); assert.ok(Math.abs(s.assistedSeconds - 4) < 0.01);
  const r = s.report(); assert.equal(r.mode, 'attitude'); assert.equal(r.wind, 1.5); assert.equal(r.passed, false); assert.ok(r.samples.length > 10);
});

test('a physical collision terminates a lesson without success', () => {
  const s = new TrainingSession('hover', 'position', 0), d = droneAtFive();
  d.crash('collision'); s.tick(FIXED_DT, d, {});
  assert.equal(s.passed, false); assert.equal(s.reason, 'collision');
});

test('attitude lesson is completable through real roll, pitch, braking and yaw inputs', () => {
  const s = new TrainingSession('attitude', 'position', 0), d = droneAtFive();
  d.armMotors();
  for (let i = 0; i < 90 / FIXED_DT && !s.finished; i++) {
    const input = {};
    if (s.stage === 0) input.roll = 0.8;
    if (s.stage === 2) input.pitch = -0.8;
    if (s.stage === 4) input.yaw = clamp(wrap((90 - d.heading) * DEG) / DEG / 40, -1, 1);
    d.step(FIXED_DT, input); s.tick(FIXED_DT, d, input);
  }
  assert.ok(s.passed, `Attitude lesson stopped at stage ${s.stage}: ${s.reason}`);
});

test('the full square course can be flown using nose-relative position-mode input', () => {
  const s = new TrainingSession('square', 'position', 0), d = droneAtFive();
  d.armMotors();
  for (let i = 0; i < 120 / FIXED_DT && !s.finished; i++) {
    const target = WAYPOINTS[Math.min(s.stage, 3)];
    const input = { roll: clamp((target[0] - d.position.x) * 0.2, -1, 1), pitch: clamp((target[2] - d.position.z) * 0.2, -1, 1) };
    d.step(FIXED_DT, input); s.tick(FIXED_DT, d, input);
  }
  assert.ok(s.passed, `Square lesson stopped at point ${s.stage}: ${s.reason}`);
});
