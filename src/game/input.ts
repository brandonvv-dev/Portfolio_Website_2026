import type { CarInput } from './car';

export interface Input extends CarInput {
  /** Edge-triggered: true for one frame after the key is pressed. */
  consumeReset(): boolean;
  consumeHorn(): boolean;
  consumeLights(): boolean;
  /** True while nobody is touching anything, for the idle orbit camera. */
  readonly idle: boolean;
  /**
   * Steer by tilting the phone. Returns false if the device has no
   * orientation sensor or the user declined the iOS permission prompt.
   */
  enableTilt(on: boolean): Promise<boolean>;
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
  // Space is the handbrake, not the foot brake: holding it with the throttle
  // is the drift. Slowing down is what lifting off and pressing S are for.
  Space: 'hand',
  ShiftLeft: 'hand',
  ShiftRight: 'hand',
};

const held = { up: false, down: false, left: false, right: false, brake: false, hand: false };

/** Phone tilt past this many degrees is full lock. */
const TILT_RANGE = 26;

export interface InputTargets {
  stick: HTMLElement;
  /** Optional touch pedals. Bigger targets than a stick axis on a phone. */
  gas?: HTMLElement | null;
  reverse?: HTMLElement | null;
  brake?: HTMLElement | null;
}

/**
 * Keyboard, a single-thumb joystick, optional touch pedals and optional tilt
 * steering. Every source is additive and clamped, so a thumb on the stick and
 * a hand on the keyboard do not fight each other.
 */
export function createInput(targets: InputTargets): Input {
  const { stick } = targets;
  let resetQueued = false;
  let hornQueued = false;
  let lightsQueued = false;
  let touch = { x: 0, y: 0 };
  let lastActivity = performance.now();
  const bump = () => (lastActivity = performance.now());

  const onKey = (e: KeyboardEvent, down: boolean) => {
    const key = KEYS[e.code];
    if (down) bump();
    if (key) {
      held[key] = down;
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'KeyR') resetQueued = true;
    if (e.code === 'KeyH') hornQueued = true;
    if (e.code === 'KeyL') lightsQueued = true;
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
    bump();
    pointerId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    const r = stick.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    stick.dataset.active = '';
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    bump();
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

  // --- Touch pedals ------------------------------------------------------
  // A held pedal must survive the finger sliding off it, so release is bound
  // to pointerup/cancel rather than pointerleave.
  const pedals: { el: HTMLElement; set: (on: boolean) => void }[] = [];
  const pedal = (el: HTMLElement | null | undefined, set: (on: boolean) => void) => {
    if (!el) return;
    const press = (e: PointerEvent) => {
      bump();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.dataset.active = '';
      set(true);
    };
    const release = () => {
      delete el.dataset.active;
      set(false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    pedals.push({ el, set });
  };

  let pedalGas = false;
  let pedalReverse = false;
  let pedalBrake = false;
  pedal(targets.gas, (on) => (pedalGas = on));
  pedal(targets.reverse, (on) => (pedalReverse = on));
  pedal(targets.brake, (on) => (pedalBrake = on));

  // --- Tilt steering -----------------------------------------------------
  let tilt = 0;
  let tiltOn = false;

  const onTilt = (e: DeviceOrientationEvent) => {
    // gamma is the left/right roll in degrees; null on desktop.
    if (e.gamma === null) return;
    bump();
    tilt = Math.max(-1, Math.min(1, -e.gamma / TILT_RANGE));
  };

  const enableTilt = async (on: boolean) => {
    if (!on) {
      removeEventListener('deviceorientation', onTilt);
      tiltOn = false;
      tilt = 0;
      return false;
    }
    if (typeof DeviceOrientationEvent === 'undefined') return false;

    // iOS gates the sensor behind a permission prompt that must be requested
    // from a user gesture; everywhere else the listener just works.
    const ask = (DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    }).requestPermission;
    if (typeof ask === 'function') {
      try {
        if ((await ask()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    addEventListener('deviceorientation', onTilt);
    tiltOn = true;
    return true;
  };

  const clamp = (n: number) => Math.max(-1, Math.min(1, n));

  return {
    get throttle() {
      const keyboard = (held.up ? 1 : 0) - (held.down ? 1 : 0);
      const buttons = (pedalGas ? 1 : 0) - (pedalReverse ? 1 : 0);
      // Deadzone stops a resting thumb from creeping the car forward
      const stickY = Math.abs(touch.y) > 0.18 ? touch.y : 0;
      return clamp(keyboard + buttons + stickY);
    },
    get steer() {
      const keyboard = (held.left ? 1 : 0) - (held.right ? 1 : 0);
      const stickX = Math.abs(touch.x) > 0.15 ? -touch.x : 0;
      const tiltX = tiltOn && Math.abs(tilt) > 0.12 ? -tilt : 0;
      return clamp(keyboard + stickX + tiltX);
    },
    get brake() {
      return held.brake || pedalBrake;
    },
    get handbrake() {
      return held.hand;
    },
    get idle() {
      return performance.now() - lastActivity > 4000;
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
    consumeLights() {
      const v = lightsQueued;
      lightsQueued = false;
      return v;
    },
    enableTilt,
    dispose() {
      removeEventListener('keydown', keyDown);
      removeEventListener('keyup', keyUp);
      removeEventListener('blur', blur);
      removeEventListener('deviceorientation', onTilt);
    },
  };
}
