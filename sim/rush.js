import { ArcadeSession } from './arcade.js';
import { MAPS } from './maps.js';
import { hitsObstacle } from './collision.js';

export const RUN_SECONDS = 120;
export const OVERDRIVE_SECONDS = 8;
export const RUSH_RULES = 'rush-v2';

export function targetDefinitions(mapId) {
  const route = MAPS[mapId].rings;
  return [0, 2, 4, 6].map((index, id) => {
    const a = route[index], b = route[(index + 1) % route.length];
    const home = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + .26, (a[2] + b[2]) / 2];
    return { id, home, position: [...home], health: 2, respawnAt: 0, hitAt: -Infinity };
  });
}

// One targeting calculation drives both shots and the HUD. Scenery always wins.
export function traceShot(drone, targets) {
  const origin = drone.position, direction = drone.aimDirection;
  let distance = 65, target = null;
  for (const candidate of targets) {
    if (candidate.health <= 0) continue;
    const delta = candidate.position.map((value, i) => value - origin.getComponent(i));
    const along = delta.reduce((sum, value, i) => sum + value * direction.getComponent(i), 0);
    const perpendicular = delta.reduce((sum, value) => sum + value * value, 0) - along * along;
    if (along > 0 && perpendicular < .95 ** 2) {
      const entry = Math.max(0, along - Math.sqrt(.95 ** 2 - perpendicular));
      if (entry < distance) { distance = entry; target = candidate; }
    }
  }
  let blocked = false;
  for (let step = 0; step < distance; step += .2) {
    const point = origin.clone().addScaledVector(direction, step);
    if (point.y < .1 || drone.obstacles.some(obstacle => hitsObstacle(point, obstacle, .08))) {
      distance = step; target = null; blocked = true; break;
    }
  }
  return { target, distance, blocked, point: origin.clone().addScaledVector(direction, distance).toArray() };
}

// Use the actual crossing point, so a fast pass and a slow pass get the same grade.
export function ringPrecision(from, to, ring) {
  const plane = p => p.reduce((sum, value, i) => sum + (value - ring.center[i]) * ring.normal[i], 0);
  const before = plane(from), after = plane(to);
  if (before >= 0 || after < 0) return Infinity;
  const t = before / (before - after);
  return Math.hypot(...from.map((value, i) => value + (to[i] - value) * t - ring.center[i]));
}

export function scoreRank(score) {
  return score >= 6000 ? 'S' : score >= 3500 ? 'A' : score >= 1800 ? 'B' : score >= 750 ? 'C' : 'D';
}

export class RushSession extends ArcadeSession {
  constructor(mapId) {
    super(mapId);
    this.targets = targetDefinitions(mapId);
    this.destroyed = 0; this.shots = 0; this.hits = 0;
    this.cooldown = 0; this.heat = 0; this.overheated = false;
    this.damageCount = 0; this.hull = 3;
    this.effects = []; this.effectId = 0;
    this.charge = 0; this.overdrive = 0; this.overdrives = 0;
    this.perfects = 0; this.boostRings = 0;
    this.killStreak = 0; this.bestStreak = 0; this.lastKillTime = -Infinity;
    this.countdownWarning = 11;
  }

  get remaining() { return Math.max(0, RUN_SECONDS - this.elapsed); }
  get comboRemaining() { return Math.max(0, 1 - (this.elapsed - this.lastRingTime) / 12); }

  addCharge(amount, drone) {
    if (this.overdrive > 0) return;
    this.charge = Math.min(100, this.charge + amount);
    if (this.charge < 100) return;
    this.charge = 0; this.overdrive = OVERDRIVE_SECONDS; this.overdrives++;
    this.heat = 0; this.overheated = false;
    drone.energy = 100; drone.exhausted = false; drone.overdrive = true;
    this.events.push({ type: 'overdrive' });
  }

  effect(type, properties = {}) {
    this.effects.push({ id: ++this.effectId, type, time: this.elapsed, ...properties });
  }

  tick(dt, drone, input = {}) {
    if (this.finished) return;
    const step = Math.min(dt, this.remaining);
    this.overdrive = Math.max(0, this.overdrive - step);
    drone.overdrive = this.overdrive > 0;
    const multiplier = this.overdrive > 0 ? 2 : 1;
    const crystals = this.crystalsCollected, previous = [...this.previous];
    const ring = this.rings[this.ringIndex], eventStart = this.events.length;
    super.tick(step, drone, {});
    this.hull = drone.hull;
    if (drone.damageCount !== this.damageCount) {
      this.damageCount = drone.damageCount;
      this.combo = 1; this.lastRingTime = -Infinity; this.killStreak = 0;
      this.charge = Math.max(0, this.charge - 20);
      this.events.push({ type: 'damage', hull: drone.hull });
    }
    if (this.finished) { drone.overdrive = false; return; }

    let chargeEarned = 0;
    for (const event of this.events.slice(eventStart)) {
      if (event.type === 'ring') {
        const perfect = ringPrecision(previous, drone.position.toArray(), ring) <= 1.05;
        const boosted = drone.boosting;
        const base = event.points;
        event.points = (base + (perfect ? 75 : 0) + (boosted ? 50 : 0)) * multiplier;
        event.perfect = perfect; event.boosted = boosted;
        this.score += event.points - base;
        this.perfects += Number(perfect); this.boostRings += Number(boosted);
        chargeEarned += perfect ? 26 : 18;
        drone.energy = Math.min(100, drone.energy + 25);
        this.effect('ring', { position: [...ring.center], normal: [...ring.normal], perfect });
      } else if (event.type === 'crystal') {
        this.score += event.points * (multiplier - 1); event.points *= multiplier;
        chargeEarned += 8; drone.energy = Math.min(100, drone.energy + 25);
        this.effect('pickup', { position: drone.position.toArray() });
      }
    }
    if (Math.floor(this.crystalsCollected / 5) > Math.floor(crystals / 5) && drone.hull < 3) {
      drone.hull++; this.hull = drone.hull; this.events.push({ type: 'repair' });
    }
    this.addCharge(chargeEarned, drone);
    const seconds = Math.ceil(this.remaining);
    if (seconds <= 10 && seconds > 0 && seconds < this.countdownWarning) {
      this.countdownWarning = seconds; this.events.push({ type: 'time', seconds });
    }
    if (this.remaining <= 0) { this.finish(true, '120초 비행 완료. 다음 비행에서 최고 기록을 넘어보세요.'); drone.overdrive = false; return; }
    this.cooldown = Math.max(0, this.cooldown - step);
    this.heat = Math.max(0, this.heat - step * (this.overdrive > 0 ? 100 : 26));
    if (this.heat < 30) this.overheated = false;
    if (this.elapsed - this.lastKillTime > 5) this.killStreak = 0;
    for (const target of this.targets) {
      if (target.health <= 0 && this.elapsed >= target.respawnAt) target.health = 2;
      target.position = [target.home[0] + Math.sin(this.elapsed * .7 + target.id) * .7, target.home[1] + Math.sin(this.elapsed * 1.4 + target.id) * .35, target.home[2]];
    }
    if (input.fire && this.cooldown === 0 && !this.overheated) this.shoot(drone);
    this.effects = this.effects.filter(effect => this.elapsed - effect.time < .8);
  }

  shoot(drone) {
    if (this.finished) return;
    const powered = this.overdrive > 0;
    this.cooldown = powered ? .085 : .14;
    this.shots++;
    this.heat = powered ? 0 : Math.min(100, this.heat + 11);
    if (this.heat >= 99 && !this.overheated) {
      this.overheated = true; this.events.push({ type: 'overheat' });
    }
    const hit = traceShot(drone, this.targets);
    this.events.push({ type: 'shot', powered });
    this.effect('beam', { from: drone.position.toArray(), to: hit.point, powered });
    if (hit.target || hit.blocked) this.effect('spark', { position: hit.point, target: !!hit.target });
    if (!hit.target) return;
    const target = hit.target;
    this.hits++; target.health--; target.hitAt = this.elapsed;
    this.events.push({ type: 'hit', destroyed: target.health === 0 });
    if (target.health === 0) {
      target.respawnAt = this.elapsed + 9; this.destroyed++;
      this.killStreak = this.elapsed - this.lastKillTime <= 5 ? this.killStreak + 1 : 1;
      this.lastKillTime = this.elapsed; this.bestStreak = Math.max(this.bestStreak, this.killStreak);
      const points = (150 + Math.min(3, this.killStreak - 1) * 50) * (powered ? 2 : 1);
      this.score += points;
      this.events.push({ type: 'target', points, streak: this.killStreak });
      this.effect('burst', { position: [...target.position], powered });
      this.addCharge(22, drone);
    }
  }

  finish(passed, reason) { super.finish(passed, reason); this.passed = passed; }
  report() {
    return { ...super.report(), rules: RUSH_RULES, destroyed: this.destroyed, shots: this.shots, hits: this.hits, hull: this.hull, damage: this.damageCount, perfects: this.perfects, boostRings: this.boostRings, overdrives: this.overdrives, bestStreak: this.bestStreak, rank: scoreRank(this.score) };
  }
}
