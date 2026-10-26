export class ArcadeInput {
  constructor({ canvas, active, look, pause, notify }) {
    this.canvas = canvas; this.active = active; this.notify = notify;
    this.buttons = new Set(); this.move = { x: 0, y: 0 }; this.aim = { x: 0, y: 0 };
    this.firing = false; this.focused = false; this.locked = false; this.drag = null;
    canvas.addEventListener('contextmenu', event => { if (active()) event.preventDefault(); });
    canvas.addEventListener('pointerdown', event => {
      if (!active() || event.pointerType === 'touch' || ![0, 2].includes(event.button)) return;
      event.preventDefault();
      if (event.button === 0) this.firing = true;
      if (event.button === 2) this.focused = true;
      if (document.pointerLockElement === canvas) return;
      this.drag = { x: event.clientX, y: event.clientY };
      // Drag-to-look remains available when pointer lock is unavailable.
      this.capture();
    });
    document.addEventListener('pointermove', event => {
      if (!active()) return;
      if (document.pointerLockElement === canvas) look(event.movementX, event.movementY);
      else if (this.drag) {
        look(event.clientX - this.drag.x, event.clientY - this.drag.y);
        this.drag = { x: event.clientX, y: event.clientY };
      }
    });
    window.addEventListener('pointerup', event => {
      if (event.pointerType === 'touch') return;
      if (event.button === 0) this.firing = false;
      if (event.button === 2) this.focused = false;
      if (!this.firing && !this.focused) this.drag = null;
    });
    window.addEventListener('pointercancel', () => { this.firing = false; this.focused = false; this.drag = null; });
    document.addEventListener('pointerlockchange', () => {
      const wasLocked = this.locked;
      this.locked = document.pointerLockElement === canvas;
      document.body.classList.toggle('mouse-locked', this.locked);
      if (this.locked && !active()) { document.exitPointerLock(); return; }
      if (wasLocked && !this.locked && active()) pause();
    });
    for (const pad of document.querySelectorAll('[data-stick]')) {
      let pointer = null;
      const axis = pad.dataset.stick === 'move' ? this.move : this.aim;
      const update = event => {
        const bounds = pad.getBoundingClientRect();
        const dx = (event.clientX - bounds.left - bounds.width / 2) / (bounds.width * .35);
        const dy = (event.clientY - bounds.top - bounds.height / 2) / (bounds.height * .35);
        const length = Math.max(1, Math.hypot(dx, dy));
        axis.x = dx / length; axis.y = dy / length;
        pad.firstElementChild.style.transform = `translate(${axis.x * 24}px, ${axis.y * 24}px)`;
      };
      pad.addEventListener('pointerdown', event => {
        if (!active() || pointer !== null) return;
        event.preventDefault(); pointer = event.pointerId; pad.setPointerCapture(pointer); update(event);
      });
      pad.addEventListener('pointermove', event => { if (active() && event.pointerId === pointer) update(event); });
      const release = event => { if (event.pointerId === pointer) { pointer = null; axis.x = axis.y = 0; pad.firstElementChild.style.transform = ''; } };
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(name, release);
    }
    for (const button of document.querySelectorAll('[data-flight-button]')) {
      button.addEventListener('pointerdown', event => {
        if (!active()) return;
        event.preventDefault(); button.setPointerCapture(event.pointerId);
        this.buttons.add(button.dataset.flightButton); button.classList.add('pressed');
      });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => {
        this.buttons.delete(button.dataset.flightButton); button.classList.remove('pressed');
      });
    }
  }

  capture() {
    if (!this.active() || document.pointerLockElement === this.canvas || !matchMedia('(pointer:fine)').matches) return;
    const fallback = () => this.notify('마우스를 누른 채 드래그해 조준할 수 있어요. 좌클릭 / F 발사 · 우클릭 정밀 조준');
    try {
      if (!this.canvas.requestPointerLock) { fallback(); return; }
      const request = this.canvas.requestPointerLock();
      request?.catch(fallback);
    } catch { fallback(); }
  }

  reset() {
    this.firing = false; this.focused = false; this.drag = null; this.buttons.clear();
    this.move.x = this.move.y = this.aim.x = this.aim.y = 0;
    document.querySelectorAll('[data-stick] > i').forEach(knob => { knob.style.transform = ''; });
    document.querySelectorAll('[data-flight-button]').forEach(button => button.classList.remove('pressed'));
  }
}
