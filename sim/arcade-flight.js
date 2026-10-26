import { Vector3, Quaternion, Euler } from 'three';
import { GROUND, DEG, clamp } from './physics.js';
import { hitsObstacle } from './collision.js';

// A responsive, altitude-holding flight model for the game. Training keeps its
// separate rigid-body model; looking up does not unexpectedly change altitude.
export class ArcadeFlight {
  constructor() { this.obstacles = []; this.reset(); }

  reset({ altitude = 5.26 } = {}) {
    this.position = new Vector3(0, altitude, 0);
    this.velocity = new Vector3();
    this.quaternion = new Quaternion();
    this.angles = new Euler(0, 0, 0, 'YXZ');
    this.aimPitch = 0;
    this.energy = 100;
    this.hull = 3;
    this.immunity = 0;
    this.damageCount = 0;
    this.boosting = false;
    this.overdrive = false;
    this.focusing = false;
    this.exhausted = false;
    this.armed = this.crashed = this.grounded = false;
    this.contact = null;
    this.crashReason = '';
    this.wind = new Vector3(); this.windSpeed = 0; this.gusts = false;
    this.motors = [0, 0, 0, 0];
  }

  get altitude() { return Math.max(0, this.position.y - GROUND); }
  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get heading() { return ((-this.angles.y / DEG) % 360 + 360) % 360; }
  get pitch() { return this.angles.x / DEG; }
  get roll() { return -this.angles.z / DEG; }
  get throttle() { return this.armed ? .43 + Math.min(.45, this.velocity.length() / 45) : 0; }
  get aimDirection() { return new Vector3(0, 0, -1).applyEuler(new Euler(this.aimPitch, this.angles.y, 0, 'YXZ')); }
  armMotors() { this.armed = true; }

  look(dx, dy, sensitivity = 1) {
    this.angles.y -= dx * .0024 * sensitivity;
    this.aimPitch = clamp(this.aimPitch - dy * .0024 * sensitivity, -.95, .95);
  }

  damage(label) {
    if (this.immunity > 0 || this.crashed) return;
    this.hull--; this.damageCount++; this.immunity = 1.6;
    if (this.hull <= 0) { this.crashed = true; this.crashReason = `${label} 충돌로 기체가 파손되었습니다.`; }
  }

  step(dt, input = {}) {
    if (!this.armed || this.crashed) return;
    this.focusing = !!input.focus;
    this.immunity = Math.max(0, this.immunity - dt);
    this.angles.y -= (input.yaw || 0) * 1.9 * dt;
    this.aimPitch = clamp(this.aimPitch + (input.look || 0) * 1.3 * dt, -.95, .95);
    if (this.energy >= 25) this.exhausted = false;
    const forward = -(input.pitch || 0), strafe = input.roll || 0;
    this.boosting = !!input.boost && !input.rescue && !this.exhausted && this.energy > 0 && Math.hypot(forward, strafe) > .1;
    this.energy = this.overdrive ? 100 : clamp(this.energy + (this.boosting ? -32 : 18) * dt, 0, 100);
    if (this.energy === 0) this.exhausted = true;
    const speed = this.boosting ? 21 : 9;
    const length = Math.max(1, Math.hypot(forward, strafe));
    const yaw = this.angles.y;
    const wanted = new Vector3(
      (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed / length,
      (input.lift || 0) * 5.5,
      (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed / length
    );
    if (input.rescue) wanted.set(0, 0, 0);
    this.velocity.lerp(wanted, 1 - Math.exp(-dt * (input.rescue ? 16 : 7)));
    // Substeps keep even boosted flight from tunnelling through thin ring rims.
    const steps = Math.max(1, Math.ceil(this.velocity.length() * dt / .15));
    for (let i = 0; i < steps; i++) {
      const next = this.position.clone().addScaledVector(this.velocity, dt / steps);
      const obstacle = this.obstacles.find(o => hitsObstacle(next, o));
      const floor = next.y < GROUND + .25;
      const boundary = Math.hypot(next.x, next.z) > 72 || next.y > 48;
      if (obstacle || floor || boundary) {
        this.damage(obstacle?.label || (floor ? '지면' : '비행 구역 경계'));
        this.velocity.multiplyScalar(-.25);
        this.boosting = false;
        break;
      }
      this.position.copy(next);
    }
    const response = 1 - Math.exp(-dt * 9);
    this.angles.x += (-forward * .19 - this.angles.x) * response;
    this.angles.z += (-strafe * .28 - (input.yaw || 0) * .15 - this.angles.z) * response;
    this.quaternion.setFromEuler(this.angles);
    this.motors.fill(this.throttle * 6.6);
  }
}
