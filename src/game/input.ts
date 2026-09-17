import type { CarInput } from './car';

export interface Input extends CarInput {
  /** Edge-triggered: true for one frame after the key is pressed. */
  consumeReset(): boolean;
  consumeHorn(): boolean;
  dispose(): void;
}

const KEYS: Record<string, keyof typeof held> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'brake',
};

const held = { up: false, down: false, left: false, right: false, brake: false };

/**
 * Keyboard + a single-thumb joystick. The stick's Y axis is throttle and its
 * X axis is steering, so one thumb drives the whole car.
 */
export function createInput(stick: HTMLElement): Input {
  let resetQueued = false;
  let hornQueued = false;
  let touch = { x: 0, y: 0 };

  const onKey = (e: KeyboardEvent, down: boolean) => {
    const key = KEYS[e.code];
    if (key) {
      held[key] = down;
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'KeyR') resetQueued = true;
    if (e.code === 'KeyH') hornQueued = true;
  };

  const keyDown = (e: KeyboardEvent) => onKey(e, true);
  const keyUp = (e: KeyboardEvent) => onKey(e, false);
  const blur = () => Object.keys(held).forEach((k) => (held[k as keyof typeof held] = false));

  addEventListener('keydown', keyDown);
  addEventListener('keyup', keyUp);
  addEventListener('blur', blur);

  // --- Joystick ---------------------------------------------------------
  const knob = stick.querySelector<HTMLElement>('[data-knob]')!;
  const RADIUS = 52;
  let pointerId: number | null = null;
  let origin = { x: 0, y: 0 };

  const setKnob = (x: number, y: number) => {
    knob.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const down = (e: PointerEvent) => {
    pointerId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    const r = stick.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    stick.dataset.active = '';
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    let dx = e.clientX - origin.x;
    let dy = e.clientY - origin.y;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setKnob(dx, dy);
    touch = { x: dx / RADIUS, y: -dy / RADIUS };
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    touch = { x: 0, y: 0 };
    setKnob(0, 0);
    delete stick.dataset.active;
  };

  stick.addEventListener('pointerdown', down);
  stick.addEventListener('pointermove', move);
  stick.addEventListener('pointerup', up);
  stick.addEventListener('pointercancel', up);

  return {
    get throttle() {
      const keyboard = (held.up ? 1 : 0) - (held.down ? 1 : 0);
      // Deadzone stops a resting thumb from creeping the car forward
      const stickY = Math.abs(touch.y) > 0.18 ? touch.y : 0;
      return Math.max(-1, Math.min(1, keyboard + stickY));
    },
    get steer() {
      const keyboard = (held.left ? 1 : 0) - (held.right ? 1 : 0);
      const stickX = Math.abs(touch.x) > 0.15 ? -touch.x : 0;
      return Math.max(-1, Math.min(1, keyboard + stickX));
    },
    get brake() {
      return held.brake;
    },
    consumeReset() {
      const v = resetQueued;
      resetQueued = false;
      return v;
    },
    consumeHorn() {
      const v = hornQueued;
      hornQueued = false;
      return v;
    },
    dispose() {
      removeEventListener('keydown', keyDown);
      removeEventListener('keyup', keyUp);
      removeEventListener('blur', blur);
    },
  };
}
