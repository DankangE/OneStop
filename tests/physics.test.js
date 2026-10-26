import test from 'node:test';
import assert from 'node:assert/strict';
import { DronePhysics, FIXED_DT, GROUND } from '../sim/physics.js';

function simulate(drone, seconds, input = {}) { for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) drone.step(FIXED_DT, input); return drone; }
function airborne(mode = 'position', wind = 0) { const drone = new DronePhysics(); drone.reset({ altitude: 5 + GROUND, mode, wind }); drone.armMotors(); return drone; }

test('neutral position control stays in a 5m hover without gaining energy', () => {
  const d = simulate(airborne(), 60);
  assert.ok(Math.abs(d.altitude - 5) < 0.01);
  assert.ok(d.velocity.length() < 0.01);
  assert.ok(Math.abs(d.quaternion.length() - 1) < 1e-10);
});

test('zero manual thrust falls under gravity; correct level thrust balances gravity', () => {
  const hover = simulate(airborne('manual'), 5);
  assert.ok(Math.abs(hover.altitude - 5) < 0.01);
  const falling = airborne('manual'); falling.manualThrottle = 0;
  simulate(falling, 0.5);
  assert.ok(falling.velocity.y < -3);
  assert.ok(falling.altitude < 4.2);
});

test('motor spool response is delayed instead of applying requested force instantly', () => {
  const d = new DronePhysics(); d.armMotors(); d.step(FIXED_DT, { lift: 1 });
  assert.ok(d.throttle > 0);
  assert.ok(d.throttle < d.commandedThrottle * 0.3);
});

test('pitch produces acceleration and raw thrust loses altitude while tilted', () => {
  const d = simulate(airborne('manual'), 1.5, { pitch: -0.7 });
  assert.ok(d.pitch < -15);
  assert.ok(d.position.z < -1);
  assert.ok(d.altitude < 4.8);
});

test('ATTI self-levels but leaves momentum; position mode actively brakes', () => {
  const atti = airborne('attitude'), pos = airborne();
  simulate(atti, 1.6, { pitch: -0.6 }); simulate(pos, 1.6, { pitch: -0.6 });
  simulate(atti, 3); simulate(pos, 3);
  assert.ok(Math.abs(atti.pitch) < 1);
  assert.ok(atti.horizontalSpeed > 0.5);
  assert.ok(pos.horizontalSpeed < 0.15);
  assert.ok(Math.abs(atti.altitude - 5) < 0.15);
});

test('crosswind drifts ATTI while the position controller compensates by tilting', () => {
  const atti = simulate(airborne('attitude', 3), 15), pos = simulate(airborne('position', 3), 15);
  assert.ok(atti.position.x > 15);
  assert.ok(Math.hypot(pos.position.x, pos.position.z) < 0.2);
  assert.ok(pos.tilt > 3);
});

test('yaw changes the nose-relative direction of forward input', () => {
  const d = airborne('attitude');
  simulate(d, 1.3, { yaw: 1 }); simulate(d, 1.5); simulate(d, 1.5, { pitch: -0.5 });
  assert.ok(d.heading > 85 && d.heading < 97);
  assert.ok(d.position.x > 1);
  assert.ok(Math.abs(d.position.z) < 0.25);
});

test('rescue actively brakes an ATTI drift and release returns to ATTI', () => {
  const d = airborne('attitude'); simulate(d, 1.5, { roll: 0.5 });
  assert.ok(d.horizontalSpeed > 1);
  simulate(d, 6, { rescue: true }); assert.ok(d.horizontalSpeed < 0.05);
  simulate(d, 1, { roll: 0.5 }); assert.ok(d.horizontalSpeed > 0.5);
  assert.equal(d.mode, 'attitude');
});

test('soft landing reports contact speed; a hard landing stops the simulation', () => {
  const soft = airborne(); let contact;
  for (let i = 0; i < 2400; i++) { soft.step(FIXED_DT, { lift: -0.25 }); if (soft.contact) { contact = soft.contact; break; } }
  assert.ok(contact && contact.sink < 0.8);
  assert.equal(soft.crashed, false); assert.equal(soft.position.y, GROUND);
  const hard = airborne('manual'); hard.manualThrottle = 0; simulate(hard, 2);
  assert.equal(hard.crashed, true); assert.equal(hard.armed, false);
});

test('obstacle contact and airspace boundary end a flight; reset clears state', () => {
  const d = airborne(); d.obstacles = [{ min: { x: -1, y: 4, z: -1 }, max: { x: 1, y: 6, z: 1 } }];
  d.step(FIXED_DT); assert.ok(d.crashed);
  d.obstacles = []; d.reset(); assert.equal(d.crashed, false); assert.equal(d.armed, false);
  d.armMotors(); d.position.x = 76; d.step(FIXED_DT); assert.ok(d.crashed);
});

test('precision descent remains substantially slower than full descent', () => {
  const fine = simulate(airborne(), 1.5, { lift: -0.25 });
  const normal = simulate(airborne(), 1.5, { lift: -1 });
  assert.ok(Math.abs(fine.velocity.y) < 0.45);
  assert.ok(Math.abs(normal.velocity.y) > 1.2);
});
