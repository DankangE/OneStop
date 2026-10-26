import { Vector3, Quaternion, Euler } from 'three';
import { hitsObstacle } from './collision.js';

export const FIXED_DT = 1 / 120;
export const G = 9.81;
export const GROUND = 0.26;
export const DEG = Math.PI / 180;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const MODES = {
  position: { label: '위치 보조', code: 'POS', description: '손을 떼면 위치와 고도를 유지합니다. 처음 비행할 때 추천해요.' },
  attitude: { label: '자세 모드', code: 'ATTI', description: '수평과 고도만 보조합니다. 관성과 바람에 의한 이동은 직접 상쇄하세요.' },
  manual: { label: '수동 추력', code: 'STAB', description: '수평만 보조합니다. W/S로 추력을 조절하며, 손을 떼어도 설정한 추력이 유지됩니다.' }
};

/** Educational rigid-body quadrotor. SI units, Y up, nose toward local -Z.
 * Not a PX4 firmware model or an identified model of a commercial aircraft.
 * Body X = pitch, Y = yaw, Z = roll. Rotor forces act along body +Y.
 */
export class DronePhysics {
  constructor() {
    this.mass = 1.15;
    this.maxMotorForce = 6.6;
    this.arm = 0.24;
    this.yawCoefficient = 0.028;
    this.inertia = new Vector3(0.025, 0.045, 0.025);
    this.obstacles = [];
    this.reset();
  }

  reset({ altitude = GROUND, mode = 'position', wind = 0, gusts = false } = {}) {
    this.position = new Vector3(0, altitude, 0);
    this.velocity = new Vector3();
    this.quaternion = new Quaternion();
    this.omega = new Vector3();
    this.angles = new Euler(0, 0, 0, 'YXZ');
    this.holdPosition = this.position.clone();
    this.horizontalIntegral = new Vector3();
    this.targetYaw = 0;
    this.mode = mode;
    this.windSpeed = wind;
    this.gusts = gusts;
    this.wind = new Vector3();
    this.time = 0;
    this.armed = false;
    this.crashed = false;
    this.grounded = altitude <= GROUND;
    this.wasHorizontal = false;
    this.wasVertical = false;
    this.wasRescue = false;
    this.manualThrottle = this.grounded ? 0 : this.hoverThrottle;
    this.motors = Array(4).fill(this.grounded ? 0 : this.mass * G / 4);
    this.commandedThrottle = this.manualThrottle;
    this.contact = null;
    this.input = { pitch: 0, roll: 0, yaw: 0, lift: 0, rescue: false };
  }

  get hoverThrottle() { return this.mass * G / (4 * this.maxMotorForce); }
  get altitude() { return Math.max(0, this.position.y - GROUND); }
  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get heading() { return ((-this.angles.y / DEG) % 360 + 360) % 360; }
  get pitch() { return this.angles.x / DEG; }
  get roll() { return -this.angles.z / DEG; }
  get throttle() { return this.motors.reduce((a, b) => a + b, 0) / (4 * this.maxMotorForce); }
  get tilt() { return Math.acos(clamp(new Vector3(0, 1, 0).applyQuaternion(this.quaternion).y, -1, 1)) / DEG; }

  armMotors() { this.armed = true; }

  step(dt, input = {}) {
    this.contact = null;
    if (!this.armed || this.crashed) return;
    this.time += dt;
    const command = { pitch: 0, roll: 0, yaw: 0, lift: 0, rescue: false, ...input };
    for (const key of ['pitch', 'roll', 'yaw', 'lift']) command[key] = clamp(command[key], -1, 1);
    this.input = command;
    const rescue = command.rescue;
    const mode = rescue ? 'position' : this.mode;
    if (rescue !== this.wasRescue) {
      this.holdPosition.copy(this.position);
      this.holdPosition.x += this.velocity.x * 0.35;
      this.holdPosition.z += this.velocity.z * 0.35;
      this.holdPosition.y += this.velocity.y * 0.28;
      this.horizontalIntegral.set(0, 0, 0);
      this.wasHorizontal = this.wasVertical = false;
    }
    this.wasRescue = rescue;
    if (rescue) command.pitch = command.roll = command.lift = command.yaw = 0;
    const gust = this.gusts ? 1 + 0.3 * Math.sin(this.time * 1.1) + 0.16 * Math.sin(this.time * 2.3) : 1;
    this.wind.set(this.windSpeed * 0.86 * gust, 0, this.windSpeed * -0.51 * gust);
    this.targetYaw = wrap(this.targetYaw - command.yaw * 70 * DEG * dt);
    this.angles.setFromQuaternion(this.quaternion, 'YXZ');
    const cy = Math.cos(this.angles.y), sy = Math.sin(this.angles.y);
    let targetPitch = command.pitch * 25 * DEG;
    let targetRoll = -command.roll * 25 * DEG;
    const maxAcceleration = 4.4;

    if (mode === 'position') {
      const moving = Math.abs(command.pitch) + Math.abs(command.roll) > 0.001;
      let ax, az;
      if (moving) {
        // Pitch up moves backward; right bank moves right, relative to the nose.
        const vx = (command.roll * cy + command.pitch * sy) * 4.2;
        const vz = (-command.roll * sy + command.pitch * cy) * 4.2;
        ax = (vx - this.velocity.x) * 2.5;
        az = (vz - this.velocity.z) * 2.5;
        this.holdPosition.x = this.position.x;
        this.holdPosition.z = this.position.z;
        this.horizontalIntegral.set(0, 0, 0);
      } else {
        if (this.wasHorizontal) {
          this.holdPosition.x = this.position.x + this.velocity.x * 0.35;
          this.holdPosition.z = this.position.z + this.velocity.z * 0.35;
        }
        const ex = this.holdPosition.x - this.position.x, ez = this.holdPosition.z - this.position.z;
        this.horizontalIntegral.x = clamp(this.horizontalIntegral.x + ex * dt, -2.5, 2.5);
        this.horizontalIntegral.z = clamp(this.horizontalIntegral.z + ez * dt, -2.5, 2.5);
        ax = ex * 2.2 - this.velocity.x * 3 + this.horizontalIntegral.x * 0.8;
        az = ez * 2.2 - this.velocity.z * 3 + this.horizontalIntegral.z * 0.8;
      }
      this.wasHorizontal = moving;
      const magnitude = Math.hypot(ax, az);
      if (magnitude > maxAcceleration) { ax *= maxAcceleration / magnitude; az *= maxAcceleration / magnitude; }
      targetPitch = Math.atan2(ax * sy + az * cy, G);
      targetRoll = -Math.atan2(ax * cy - az * sy, G);
    }

    const up = new Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    let force;
    if (mode === 'manual') {
      this.manualThrottle = clamp(this.manualThrottle + command.lift * 0.24 * dt, 0, 1);
      force = this.manualThrottle * this.maxMotorForce * 4;
    } else {
      const vertical = Math.abs(command.lift) > 0.001;
      let desiredVelocity;
      if (vertical) {
        desiredVelocity = command.lift * (command.lift > 0 ? 2.5 : 1.5);
        this.holdPosition.y = this.position.y;
      } else {
        if (this.wasVertical) this.holdPosition.y = this.position.y + this.velocity.y * 0.28;
        desiredVelocity = clamp((this.holdPosition.y - this.position.y) * 2, -2, 2);
      }
      this.wasVertical = vertical;
      const verticalAcceleration = clamp((desiredVelocity - this.velocity.y) * 4, -5, 7);
      force = this.mass * (G + verticalAcceleration) / Math.max(up.y, 0.4);
      if (this.grounded && command.lift <= 0 && !rescue) force = this.mass * G * 0.14;
    }
    this.commandedThrottle = clamp(force / (4 * this.maxMotorForce), 0, 1);

    const target = new Quaternion().setFromEuler(new Euler(targetPitch, this.targetYaw, targetRoll, 'YXZ'));
    const error = this.quaternion.clone().invert().multiply(target);
    if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
    const desiredRate = new Vector3(error.x, error.y, error.z).multiplyScalar(10);
    desiredRate.clampLength(0, 3.2);
    const torque = desiredRate.sub(this.omega).multiply(this.inertia).multiplyScalar(14);
    torque.x = clamp(torque.x, -0.45, 0.45);
    torque.y = clamp(torque.y, -0.20, 0.20);
    torque.z = clamp(torque.z, -0.45, 0.45);

    const positions = [[-this.arm, -this.arm], [this.arm, -this.arm], [this.arm, this.arm], [-this.arm, this.arm]];
    const spins = [1, -1, 1, -1];
    const actualTorque = new Vector3();
    let totalForce = 0;
    positions.forEach(([x, z], i) => {
      const allocation = force / 4 - z * torque.x / (4 * this.arm ** 2) + x * torque.z / (4 * this.arm ** 2) + spins[i] * torque.y / (4 * this.yawCoefficient);
      const motorTarget = clamp(allocation, 0, this.maxMotorForce);
      this.motors[i] += (motorTarget - this.motors[i]) * (1 - Math.exp(-dt / 0.055));
      const f = this.motors[i];
      totalForce += f;
      actualTorque.x -= z * f;
      actualTorque.y += spins[i] * this.yawCoefficient * f;
      actualTorque.z += x * f;
    });
    const gyroscopic = this.omega.clone().cross(this.omega.clone().multiply(this.inertia));
    const angularAcceleration = actualTorque.sub(gyroscopic).divide(this.inertia).addScaledVector(this.omega, -0.14);
    this.omega.addScaledVector(angularAcceleration, dt);
    const rotation = this.omega.length() * dt;
    if (rotation > 1e-10) this.quaternion.multiply(new Quaternion().setFromAxisAngle(this.omega.clone().normalize(), rotation)).normalize();
    this.angles.setFromQuaternion(this.quaternion, 'YXZ');
    const thrust = new Vector3(0, totalForce / this.mass, 0).applyQuaternion(this.quaternion);
    const relativeAir = this.velocity.clone().sub(this.wind);
    const drag = relativeAir.multiplyScalar((0.28 + relativeAir.length() * 0.035) / this.mass);
    const acceleration = thrust.sub(drag).add(new Vector3(0, -G, 0));
    this.velocity.addScaledVector(acceleration, dt);
    this.position.addScaledVector(this.velocity, dt);

    if (this.position.y <= GROUND) {
      if (!this.grounded) {
        this.contact = { sink: Math.max(0, -this.velocity.y), horizontalSpeed: this.horizontalSpeed, tilt: this.tilt, x: this.position.x, z: this.position.z };
        if (this.contact.sink > 2.2 || this.contact.tilt > 28 || this.contact.horizontalSpeed > 3) this.crash('지면에 강하게 충돌했습니다. 하강 속도와 기울기를 줄여보세요.');
      }
      this.position.y = GROUND;
      this.velocity.y = Math.max(0, this.velocity.y);
      this.velocity.x *= Math.exp(-8 * dt); this.velocity.z *= Math.exp(-8 * dt);
      this.grounded = true;
    } else this.grounded = false;

    for (const obstacle of this.obstacles) {
      if (hitsObstacle(this.position, obstacle)) { this.crash(`${obstacle.label || '장애물'}에 부딪혔습니다. 이동 방향과 정지 거리를 확인하세요.`); break; }
    }
    if (Math.hypot(this.position.x, this.position.z) > 75 || this.altitude > 50) this.crash('훈련 구역을 벗어났습니다. 반경 75m · 고도 50m 안에서 연습하세요.');
  }

  crash(reason) { this.crashed = true; this.armed = false; this.crashReason = reason; this.motors.fill(0); }
}
