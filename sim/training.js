import { GROUND, DEG, wrap, clamp } from './physics.js';

export const LESSONS = {
  hover: { number: '01', title: '이륙과 호버링', en: 'TAKEOFF & HOVER', description: '천천히 떠오르고, 한 지점에 머무르세요.', objective: '고도 5m · 반경 1.5m 안에서 10초간 안정적으로 유지', skill: '고도와 위치 유지', startAltitude: GROUND },
  attitude: { number: '02', title: '자세와 방향 제어', en: 'ATTITUDE CONTROL', description: '기울이고, 멈추고, 기수를 돌려보세요.', objective: '롤 → 정지 → 피치 → 정지 → 요 회전을 순서대로 연습', skill: '롤 · 피치 · 요', startAltitude: 5 + GROUND },
  square: { number: '03', title: '사각 경로 비행', en: 'BOX PATTERN', description: '기수는 정면으로, 이동은 네 방향으로.', objective: '고도 5m에서 각 꼭짓점에 2초 정지 · 총 4개 지점', skill: '방향 감각과 제동', startAltitude: 5 + GROUND },
  landing: { number: '04', title: '정밀 착륙', en: 'PRECISION LANDING', description: '마지막 1미터까지, 부드럽고 정확하게.', objective: '8m 상공에서 출발 · H 패드에 0.8m/s 이하로 착지', skill: '하강 속도와 착지', startAltitude: 8 + GROUND },
  free: { number: '∞', title: '자유 연습', en: 'OPEN PRACTICE', description: '보조 모드와 바람을 바꾸며 차이를 느껴보세요.', objective: '반경 75m · 고도 50m의 훈련장에서 자유롭게 비행', skill: '자유로운 반복 연습', startAltitude: GROUND }
};
export const WAYPOINTS = [[0, 5, -12], [12, 5, -12], [12, 5, 0], [0, 5, 0]];

export class TrainingSession {
  constructor(lesson, mode, wind, gusts = false) {
    this.lesson = lesson; this.mode = mode; this.wind = wind; this.gusts = gusts;
    this.elapsed = 0; this.stage = 0; this.hold = 0; this.progress = 0;
    this.finished = false; this.passed = false; this.reason = '';
    this.assistance = 0; this.assistedSeconds = 0; this.wasRescue = false;
    this.samples = []; this.sampleTimer = 0; this.maxSpeed = 0;
    this.altitudeErrorSquared = 0; this.errorSamples = 0; this.stableSeconds = 0;
    this.target = [0, 5, 0]; this.hint = ''; this.updateHint();
  }

  updateHint() {
    if (this.lesson === 'hover') this.hint = this.hold > 0 ? `좋아요. 작은 입력으로 흔들림을 줄여보세요. ${this.hold.toFixed(1)} / 10초 유지 중` : 'W로 5m까지 상승하세요. 목표 근처에서 먼저 키를 놓으세요.';
    if (this.lesson === 'attitude') this.hint = ['→로 오른쪽 롤 8~30°를 0.6초 유지하세요.', '수평으로 돌아와 속도 0.7m/s 이하로 1.5초 정지하세요.', '↑로 전방 피치 8~30°를 0.6초 유지하세요.', '반대 입력으로 관성을 상쇄하고 1.5초 정지하세요.', 'D로 기수를 동쪽 90°에 맞추고 2초 유지하세요.'][this.stage] || '자세 제어 완료';
    if (this.lesson === 'square') this.hint = `${this.stage + 1}번 목표로 이동하세요. 기수는 북쪽(000°), 도착 후 2초 정지.`;
    if (this.lesson === 'landing') this.hint = 'S로 하강하세요. 지면 근처에서는 Shift + S로 천천히 접근하세요.';
    if (this.lesson === 'free') this.hint = '방향키는 기체 기준입니다. 기수를 돌린 뒤 이동 방향의 변화를 느껴보세요.';
  }

  tick(dt, drone, input) {
    if (this.finished) return;
    this.elapsed += dt;
    if (input.rescue && !this.wasRescue) this.assistance++;
    if (input.rescue) this.assistedSeconds += dt;
    this.wasRescue = input.rescue;
    this.maxSpeed = Math.max(this.maxSpeed, drone.velocity.length());
    this.sampleTimer += dt;
    if (this.sampleTimer >= 0.2) {
      this.sampleTimer -= 0.2;
      this.samples.push({ t: this.elapsed, x: drone.position.x, y: drone.altitude, z: drone.position.z, pitch: drone.pitch, roll: drone.roll, speed: drone.velocity.length() });
      if (this.samples.length > 3600) this.samples.shift();
    }
    if (drone.crashed) { this.finish(false, drone.crashReason); return; }
    if (this.lesson !== 'free' && this.elapsed > 300) { this.finish(false, '5분 연습을 마쳤습니다. 기록을 확인하고 다시 시도해보세요.'); return; }
    if (['hover', 'attitude', 'square'].includes(this.lesson) && drone.altitude > 3) {
      this.altitudeErrorSquared += (drone.altitude - 5) ** 2 * dt;
      this.errorSamples += dt;
    }
    const heightValid = Math.abs(drone.altitude - 5) <= 0.5;
    const distance = Math.hypot(drone.position.x, drone.position.z);
    const stopped = drone.velocity.length() < 0.7 && drone.tilt < 8;
    let valid = false, required = 1;
    if (this.lesson === 'hover') {
      valid = heightValid && distance <= 1.5 && stopped;
      required = 10;
    } else if (this.lesson === 'attitude') {
      if (this.stage === 0) valid = drone.roll >= 8 && drone.roll <= 30;
      if (this.stage === 1 || this.stage === 3) valid = stopped;
      if (this.stage === 2) valid = drone.pitch <= -8 && drone.pitch >= -30;
      if (this.stage === 4) valid = Math.abs(wrap((drone.heading - 90) * DEG)) / DEG < 8 && stopped;
      valid = valid && Math.abs(drone.altitude - 5) < 1.5;
      required = [0.6, 1.5, 0.6, 1.5, 2][this.stage];
    } else if (this.lesson === 'square') {
      this.target = WAYPOINTS[Math.min(this.stage, 3)];
      const [x, y, z] = this.target;
      valid = Math.hypot(drone.position.x - x, drone.position.z - z) < 1.5 && Math.abs(drone.altitude - y) < 0.75 && drone.velocity.length() < 1 && Math.abs(wrap(drone.heading * DEG)) < 15 * DEG;
      required = 2;
    } else if (this.lesson === 'landing') {
      this.target = [0, 0, 0];
      this.progress = clamp((8 - drone.altitude) / 8, 0, 0.98);
      if (drone.contact) {
        const c = drone.contact;
        this.landing = c;
        const passed = Math.hypot(c.x, c.z) <= 1.2 && c.sink <= 0.8 && c.horizontalSpeed <= 0.6 && c.tilt <= 8;
        this.finish(passed, passed ? '패드 중심에 부드럽게 착륙했습니다.' : `착지 속도 ${c.sink.toFixed(2)}m/s · 중심 오차 ${Math.hypot(c.x,c.z).toFixed(2)}m. 하강 속도 0.8m/s, 반경 1.2m 안을 목표로 다시 연습하세요.`);
      }
    }
    if (['hover', 'attitude', 'square'].includes(this.lesson)) {
      this.hold = valid ? this.hold + dt : 0;
      if (valid) this.stableSeconds += dt;
      const totalStages = this.lesson === 'hover' ? 1 : this.lesson === 'attitude' ? 5 : 4;
      this.progress = clamp((this.stage + this.hold / required) / totalStages, 0, 1);
      if (this.hold >= required) {
        this.stage++; this.hold = 0;
        if (this.stage >= totalStages) this.finish(true, '모든 훈련 기준을 충족했습니다.');
        else if (this.lesson === 'square') this.target = WAYPOINTS[this.stage];
      }
    }
    this.updateHint();
  }

  finish(passed, reason) { this.finished = true; this.passed = passed; this.reason = reason; if (passed) this.progress = 1; }

  report() {
    return { id: Date.now(), lesson: this.lesson, mode: this.mode, wind: this.wind, gusts: this.gusts, passed: this.passed, reason: this.reason, elapsed: this.elapsed, assistance: this.assistance, assistedSeconds: this.assistedSeconds, maxSpeed: this.maxSpeed, altitudeRms: this.errorSamples > 0 ? Math.sqrt(this.altitudeErrorSquared / this.errorSamples) : null, stableSeconds: this.stableSeconds, landing: this.landing || null, samples: this.samples, date: new Date().toISOString() };
  }
}
