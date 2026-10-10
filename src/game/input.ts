/**
 * Keyboard, the touch stick and a gamepad, mixed into one InputState per frame.
 *
 * What is held is sampled once a frame, so every substep of that frame sees the same driver. What
 * is pressed acts inside its own keydown instead: only there is the event still a user gesture,
 * and E has to open a tab.
 */
import { MathUtils, type PerspectiveCamera } from 'three';
import type { CarState, Events, GameState, Input, InputState } from './types';

type Hold = 'up' | 'down' | 'left' | 'right' | 'brake' | 'boost';

/**
 * By KeyboardEvent.code, so W is the same physical key on every layout. Control and Alt are left
 * out on purpose: Ctrl+W would close the tab mid-drive.
 */
const KEYS: Partial<Record<string, Hold>> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'brake',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
};

/** How far the knob travels from the middle of the stick, pixels. */
const STICK_RADIUS = 52;
/** Under this a thumb is only resting, and the car must not creep. */
const STICK_DEAD_ZONE = 0.18;
/** The heading error that asks for full lock. */
const FULL_LOCK = Math.PI / 4;
/** Past this error backing up is shorter than turning round. */
const ABOUT_TURN = (3 * Math.PI) / 4;
/** A worn gamepad stick rests this far off centre. */
const PAD_DEAD_ZONE = 0.2;

/** The same angle, within half a turn of zero. */
const wrap = (angle: number) => MathUtils.euclideanModulo(angle + Math.PI, 2 * Math.PI) - Math.PI;

export function createInput(deps: {
  state: GameState;
  car: CarState;
  camera: PerspectiveCamera;
  events: Events;
}): Input & { sample(): void } {
  const { state, car, camera, events } = deps;
  // ponytail: one flag per action, not per key: letting go of W while ArrowUp is still down
  // lifts the throttle, as in the old game. Hold codes instead if anyone ever drives with both.
  const held = new Set<Hold>();
  const out: InputState = { throttle: 0, steer: 0, brake: false, boost: false };

  /* ------------------------------------------------------------- keyboard */

  addEventListener('keydown', (e) => {
    const key = KEYS[e.code];
    if (key) {
      held.add(key);
      // Mid-drive Space and the arrows must neither scroll the page nor press a focused HUD
      // button. Before Start they still have to: Space on the Start button is a way in.
      if (state.phase === 'driving') e.preventDefault();
      return;
    }
    // Before Start there is no panel to open, no audio graph for the horn and no car to reset.
    if (e.repeat || state.phase !== 'driving') return;
    // Called here and never from the frame: outside the gesture the browser blocks the new tab.
    if (e.code === 'KeyE') input.onInteract();
    else if (e.code === 'KeyR') events.emit('reset', null);
    else if (e.code === 'KeyH') events.emit('sound', 'horn');
    else if (e.code === 'KeyC') events.emit('camera');
  });

  addEventListener('keyup', (e) => {
    // macOS sends no keyup for a key let go while Command is down, so they all go with it.
    if (e.key === 'Meta') held.clear();
    const key = KEYS[e.code];
    if (!key) return;
    held.delete(key);
    if (state.phase === 'driving') e.preventDefault();
  });

  // A key let go while the page cannot hear it would stay down for ever.
  addEventListener('blur', () => held.clear());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) held.clear();
  });

  /* ---------------------------------------------------------------- touch */

  const stick = document.querySelector<HTMLElement>('[data-stick]')!;
  const knob = stick.querySelector<HTMLElement>('[data-knob]')!;
  // The thumb: how far it pushes, 0 to 1, and its angle from screen-right, turning up the screen.
  // Both are worked out in the handler, because sample() may allocate nothing and Math.hypot
  // does: V8 does not inline it, and boxes its result on every call.
  let stickReach = 0;
  let stickAngle = 0;
  let pointer: number | null = null;
  let centreX = 0;
  let centreY = 0;

  const drag = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    let x = e.clientX - centreX;
    let y = e.clientY - centreY;
    const reach = Math.hypot(x, y) / STICK_RADIUS;
    if (reach > 1) {
      x /= reach;
      y /= reach;
    }
    stickReach = Math.min(reach, 1);
    stickAngle = Math.atan2(-y, x);
    knob.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const letGo = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    stickReach = 0;
    knob.style.transform = '';
    delete stick.dataset.active;
  };

  stick.addEventListener('pointerdown', (e) => {
    pointer = e.pointerId;
    const box = stick.getBoundingClientRect();
    centreX = box.left + box.width / 2;
    centreY = box.top + box.height / 2;
    stick.dataset.active = '';
    drag(e);
    // Keeps the moves coming when the thumb slides off the stick.
    stick.setPointerCapture(e.pointerId);
  });
  stick.addEventListener('pointermove', drag);
  stick.addEventListener('pointerup', letGo);
  stick.addEventListener('pointercancel', letGo);

  // On a phone Brake and Boost are the same two holds as Space and Shift.
  for (const key of ['brake', 'boost'] as const) {
    const button = document.querySelector<HTMLElement>(`[data-${key}]`)!;
    button.addEventListener('pointerdown', () => held.add(key));
    button.addEventListener('pointerup', () => held.delete(key));
    button.addEventListener('pointercancel', () => held.delete(key));
  }

  /* -------------------------------------------------------------- gamepad */

  // getGamepads() builds a new array on every call, so nobody asks until a pad has shown up.
  let pads = 0;
  addEventListener('gamepadconnected', () => (pads += 1));
  addEventListener('gamepaddisconnected', () => (pads -= 1));

  const input = {
    state: out,
    // Nothing to open until the panels module assigns it.
    onInteract: () => {},

    sample() {
      let throttle = 0;
      let steer = 0;
      let brake = false;
      let boost = false;

      // The loop already runs behind the loading screen and the intro: the car stays parked.
      if (state.phase === 'driving') {
        throttle = Number(held.has('up')) - Number(held.has('down'));
        steer = Number(held.has('left')) - Number(held.has('right'));
        brake = held.has('brake');
        boost = held.has('boost');

        if (stickReach > STICK_DEAD_ZONE) {
          // The thumb points where to go on screen, since left and right of the car mean nothing
          // under a camera that does not turn with it. The camera never rolls, so its right axis
          // lies on the ground: that heading plus the stick's angle from screen-right is the
          // heading wanted. It is read every frame, so the chase view needs no code of its own.
          const m = camera.matrixWorld.elements;
          const error = wrap(Math.atan2(m[0], m[2]) + stickAngle - car.yaw);
          const power = stickReach ** 3;
          if (Math.abs(error) > ABOUT_TURN) {
            // Back up, steering the tail on to the heading: in reverse the wheel works mirrored.
            throttle -= power;
            steer -= MathUtils.clamp(wrap(error - Math.PI) / FULL_LOCK, -1, 1);
          } else {
            throttle += power;
            steer += MathUtils.clamp(error / FULL_LOCK, -1, 1);
          }
        }

        // A pad button is no user gesture, so it never calls onInteract: the tab would be blocked.
        if (pads > 0) {
          for (const pad of navigator.getGamepads()) {
            // Only the standard mapping says which buttons are the triggers.
            if (pad?.mapping !== 'standard') continue;
            throttle += pad.buttons[7].value - pad.buttons[6].value;
            const tilt = Math.abs(pad.axes[0]) - PAD_DEAD_ZONE;
            if (tilt > 0) steer -= (Math.sign(pad.axes[0]) * tilt) / (1 - PAD_DEAD_ZONE);
            brake ||= pad.buttons[0].pressed;
            boost ||= pad.buttons[5].pressed;
          }
        }
      }

      // Steer stays exactly 0 when nothing steers: the car's heading hold keys on that.
      out.throttle = MathUtils.clamp(throttle, -1, 1);
      out.steer = MathUtils.clamp(steer, -1, 1);
      out.brake = brake;
      out.boost = boost;
    },
  };
  return input;
}
