import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcadeFlight } from '../sim/arcade-flight.js';
import { RushSession, RUN_SECONDS, OVERDRIVE_SECONDS, targetDefinitions, traceShot, ringPrecision, scoreRank } from '../sim/rush.js';
import { FIXED_DT } from '../sim/physics.js';
import { ringDefinitions, sceneryDefinitions, sceneryObstacles } from '../sim/maps.js';
import { hitsObstacle } from '../sim/collision.js';

function fly() { const drone = new ArcadeFlight(); drone.armMotors(); return drone; }
function advance(drone, seconds, input = {}, session = null) {
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    drone.step(FIXED_DT, input); session?.tick(FIXED_DT, drone, input);
    if (session) drone.obstacles = drone.obstacles.filter(o => o.type !== 'torus').concat(session.rings.slice(session.ringIndex));
  }
}

test('arcade movement holds altitude while aiming, and brakes quickly on release', () => {
  const drone = fly(); drone.look(0, -200);
  advance(drone, 1, { pitch: -1 });
  assert.ok(drone.position.z < -7);
  assert.equal(drone.altitude, 5);
  assert.ok(drone.aimDirection.y > .4);
  const before = drone.position.z;
  advance(drone, .5, { rescue: true });
  assert.ok(drone.horizontalSpeed < .01);
  assert.ok(before - drone.position.z < .7);
});

test('strafe and yaw follow the nose; diagonals do not gain extra speed', () => {
  const straight = fly(), diagonal = fly();
  advance(straight, 1, { pitch: -1 }); advance(diagonal, 1, { pitch: -1, roll: 1 });
  assert.ok(Math.abs(straight.horizontalSpeed - diagonal.horizontalSpeed) < .001);
  const turned = fly(); turned.angles.y = -Math.PI / 2;
  advance(turned, 1, { pitch: -1 });
  assert.ok(turned.position.x > 7 && Math.abs(turned.position.z) < .001);
});

test('boost doubles speed, drains energy, locks when empty and recovers', () => {
  const drone = fly(); advance(drone, 1, { pitch: -1, boost: true });
  assert.ok(drone.horizontalSpeed > 20 && drone.energy < 70);
  advance(drone, 2.2, { pitch: -1, boost: true });
  assert.equal(drone.exhausted, true); assert.equal(drone.boosting, false);
  advance(drone, 1.6);
  assert.equal(drone.exhausted, false);
  advance(drone, .1, { pitch: -1, boost: true }); assert.equal(drone.boosting, true);
});

test('boosted flight cannot tunnel through thin obstacles and damage has a grace period', () => {
  const drone = fly();
  drone.obstacles = [{ type: 'box', label: 'wall', min: { x: -10, y: 0, z: -5.1 }, max: { x: 10, y: 15, z: -5 } }];
  advance(drone, .5, { pitch: -1, boost: true });
  assert.equal(drone.hull, 2); assert.ok(drone.position.z > -5);
  advance(drone, .8, { pitch: -1 }); assert.equal(drone.hull, 2);
  advance(drone, 3, { pitch: -1 });
  assert.equal(drone.hull, 0); assert.ok(drone.crashed);
});

test('both courses can reach the first gate with WASD forward and collect energy', () => {
  for (const map of ['city', 'forest']) {
    const drone = fly(), session = new RushSession(map);
    drone.energy = 10;
    drone.obstacles = [...sceneryObstacles(sceneryDefinitions(map)), ...ringDefinitions(map)];
    advance(drone, 1.5, { pitch: -1 }, session);
    assert.equal(session.ringsPassed, 1); assert.equal(session.crystalsCollected, 1);
    assert.equal(session.score, 200); assert.equal(session.perfects, 1);
    assert.equal(drone.hull, 3); assert.ok(drone.energy > 70);
  }
});

test('moving target patrols remain clear of scenery in both worlds', () => {
  for (const map of ['city', 'forest']) {
    const obstacles = sceneryObstacles(sceneryDefinitions(map));
    for (const target of targetDefinitions(map)) for (let t = 0; t < 20; t += .2) {
      const point = { x: target.home[0] + Math.sin(t * .7 + target.id) * .7, y: target.home[1] + Math.sin(t * 1.4 + target.id) * .35, z: target.home[2] };
      assert.ok(!obstacles.some(o => hitsObstacle(point, o, 1)), `${map} target ${target.id} intersects scenery`);
    }
  }
});

test('two hits destroy a target, cannot farm a dead target, and scenery blocks shots', () => {
  const drone = fly(), session = new RushSession('city');
  session.targets = [{ id: 0, home: [0, 5.26, -10], position: [0, 5.26, -10], health: 2, respawnAt: 0 }];
  session.shoot(drone); assert.equal(session.score, 0); assert.equal(session.hits, 1);
  session.shoot(drone); assert.equal(session.score, 150); assert.equal(session.destroyed, 1);
  session.shoot(drone); assert.equal(session.score, 150);
  session.targets[0].health = 2;
  drone.obstacles = [{ type: 'box', label: 'wall', min: { x: -2, y: 0, z: -5 }, max: { x: 2, y: 10, z: -4 } }];
  session.shoot(drone); assert.equal(session.targets[0].health, 2);
});

test('continuous fire overheats and requires cooling before another shot', () => {
  const drone = fly(), session = new RushSession('city');
  for (let i = 0; i < 400 && !session.overheated; i++) session.tick(FIXED_DT, drone, { fire: true });
  assert.ok(session.overheated);
  const shots = session.shots;
  for (let i = 0; i < 60; i++) session.tick(FIXED_DT, drone, { fire: true });
  assert.equal(session.shots, shots);
  for (let i = 0; i < 360; i++) session.tick(FIXED_DT, drone);
  assert.equal(session.overheated, false);
  session.tick(FIXED_DT, drone, { fire: true }); assert.equal(session.shots, shots + 1);
});

test('120 seconds ends the run once and freezes scores and shots', () => {
  const drone = fly(), session = new RushSession('forest');
  advance(drone, RUN_SECONDS + 1, {}, session);
  assert.equal(session.finished, true); assert.equal(session.passed, true); assert.equal(session.remaining, 0);
  const report = session.report();
  advance(drone, 1, { fire: true }, session);
  assert.equal(session.score, report.score); assert.equal(session.shots, report.shots);
  assert.equal(session.elapsed, RUN_SECONDS);
});

test('fifth crystal repairs one shield; collision clears combo without awarding rescue', () => {
  const drone = fly(), session = new RushSession('city');
  drone.hull = 2; session.crystalsCollected = 4;
  const crystal = session.crystals[0].position;
  session.previous = [crystal[0], crystal[1], crystal[2] + 1];
  drone.position.set(...crystal); session.tick(FIXED_DT, drone, { rescue: true });
  assert.equal(drone.hull, 3); assert.equal(session.assistance, 0);
  session.combo = 3; session.lastRingTime = session.elapsed;
  drone.damage('wall'); session.tick(FIXED_DT, drone);
  assert.equal(session.combo, 1); assert.equal(session.comboRemaining, 0);
  assert.equal(session.report().damage, 1);
});

test('ring precision uses the plane crossing, and boost adds a distinct bonus', () => {
  const ring = ringDefinitions('city')[0];
  assert.equal(ringPrecision([0, 5.26, -8], [0, 5.26, -16], ring), 0);
  assert.equal(ringPrecision([1.5, 5.26, -8], [1.5, 5.26, -16], ring), 1.5);
  assert.equal(ringPrecision([0, 5.26, -16], [0, 5.26, -8], ring), Infinity);
  for (const [offset, expected, perfect] of [[0, 225, 1], [1.5, 150, 0]]) {
    const drone = fly(), session = new RushSession('city');
    session.previous = [offset, 5.26, -11]; drone.position.set(offset, 5.26, -13);
    drone.boosting = true; session.tick(FIXED_DT, drone);
    assert.equal(session.score, expected); assert.equal(session.perfects, perfect);
    assert.equal(session.boostRings, 1);
    session.tick(FIXED_DT, drone); assert.equal(session.score, expected);
  }
});

test('collecting a ring activates overdrive, which expires without renewing itself', () => {
  const drone = fly(), session = new RushSession('city');
  session.charge = 80; session.heat = 95; session.overheated = true;
  session.previous = [0, 5.26, -11]; drone.position.set(0, 5.26, -13);
  session.tick(FIXED_DT, drone);
  assert.equal(session.overdrive, OVERDRIVE_SECONDS); assert.equal(session.overdrives, 1);
  assert.equal(drone.overdrive, true); assert.equal(session.overheated, false);
  assert.equal(session.charge, 0); assert.equal(session.heat, 0);
  session.addCharge(100, drone); assert.equal(session.charge, 0);
  for (let i = 0; i <= OVERDRIVE_SECONDS / FIXED_DT; i++) session.tick(FIXED_DT, drone);
  assert.equal(session.overdrive, 0); assert.equal(drone.overdrive, false);
  assert.equal(session.overdrives, 1);
});

test('overdrive doubles rewards, prevents weapon heat, and keeps boost charged', () => {
  const drone = fly(), session = new RushSession('city');
  session.addCharge(100, drone);
  session.previous = [0, 5.26, -11]; drone.position.set(0, 5.26, -13);
  drone.boosting = true; session.tick(FIXED_DT, drone);
  assert.equal(session.score, 450);
  drone.position.set(0, 5.26, 0); drone.energy = 10;
  drone.step(FIXED_DT, { pitch: -1, boost: true });
  assert.equal(drone.energy, 100); assert.equal(drone.boosting, true);
  session.targets = [{ id: 0, home: [0, 5.26, -10], position: [0, 5.26, -10], health: 2, respawnAt: 0 }];
  session.shoot(drone); session.shoot(drone);
  assert.equal(session.score, 750);
  for (let i = 0; i < 40; i++) session.shoot(drone);
  assert.equal(session.heat, 0); assert.equal(session.overheated, false);
  assert.ok(session.cooldown < .1);
});

test('kill streak rewards expire after five seconds and damage resets them', () => {
  const drone = fly(), session = new RushSession('city');
  const kill = () => {
    session.targets = [{ id: 0, position: [0, 5.26, -10], health: 2, respawnAt: 0 }];
    session.shoot(drone); session.shoot(drone);
  };
  kill(); assert.equal(session.score, 150);
  session.elapsed = 3; kill(); assert.equal(session.score, 350);
  session.elapsed = 9; kill(); assert.equal(session.score, 500);
  assert.equal(session.bestStreak, 2);
  drone.damage('wall'); session.targets = []; session.tick(FIXED_DT, drone);
  assert.equal(session.killStreak, 0);
});

test('the target hint and weapon agree on cover and do not select destroyed targets', () => {
  const drone = fly(), session = new RushSession('city');
  const target = { id: 0, position: [0, 5.26, -10], health: 2 };
  session.targets = [target];
  assert.equal(traceShot(drone, session.targets).target, target);
  drone.obstacles = [{ type: 'box', min: { x: -2, y: 0, z: -5.02 }, max: { x: 2, y: 10, z: -5 } }];
  const blocked = traceShot(drone, session.targets);
  assert.equal(blocked.target, null); assert.equal(blocked.blocked, true);
  session.shoot(drone); assert.equal(target.health, 2);
  drone.obstacles = []; target.health = 0;
  assert.equal(traceShot(drone, session.targets).target, null);
});

test('finishing a run freezes direct shots and produces a versioned rank report', () => {
  const drone = fly(), session = new RushSession('forest');
  session.finish(true, 'done'); const before = session.report();
  session.shoot(drone); session.tick(1, drone, { fire: true });
  const after = session.report();
  for (const key of ['score', 'shots', 'hits', 'elapsed']) assert.equal(after[key], before[key]);
  assert.equal(after.rules, 'rush-v2');
  assert.equal(after.rank, 'D');
  assert.equal(scoreRank(749), 'D'); assert.equal(scoreRank(750), 'C');
  assert.equal(scoreRank(1800), 'B'); assert.equal(scoreRank(3500), 'A'); assert.equal(scoreRank(6000), 'S');
});
