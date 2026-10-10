/**
 * The camera rig. The default view is a long lens at a fixed three-quarter angle that never
 * turns: the world is laid out for it, and all it does is follow the car, aim a little ahead of
 * it and back off with speed. The chase view is the same follow, from behind the car.
 *
 * It also measures the footprint, the circle of ground the default view can show. The shadow box
 * and the fog range are sized from it, so it changes only when the screen does.
 */
import { MathUtils, Vector2, Vector3 } from 'three';
import { FACE, type ModuleFactory } from './types';
import { springTo } from './util';

/** Degrees. A lens this long flattens the scene into a miniature. Zoom moves the camera instead. */
const FOV = 25;

/**
 * Angle from straight overhead. A portrait screen is narrow and tall, so there the view tips
 * further towards the horizon and spends its height on the road ahead.
 */
const POLAR = 0.27 * Math.PI;
const POLAR_PORTRAIT = 0.31 * Math.PI;

/**
 * Metres from the focus. REST is where the camera sits over a parked car on a 16:9 screen, which
 * makes the 4 m car a fifth of the view's height, and NEAREST is where a zoom of 1 would put it.
 * On a narrower screen it backs off by SPILL times (16:9 / aspect - 1), which keeps a useful
 * width of ground in view.
 */
const NEAREST = 22;
const REST = 43.5;
const SPILL = 13;

/**
 * The footprint is measured with the camera at this many times its rest distance. No speed zoom
 * gets that far out (1.2 times, on 16:9): it is the circle the softness of the shadow and the fog
 * range were tuned on, 38.8 m on 16:9. It never follows the zoom, because a shadow box that
 * changes size changes its texel size, and then every shadow edge crawls.
 */
const REACH = 1.4;

/**
 * Per second. The view closes on its target at this rate, so at a steady speed the car rides
 * speed / FOLLOW metres behind the point the view is aimed at.
 */
const FOLLOW = 10.9;

/** Where the zoom sits behind the intro, on the scale where 0 is REST and 1 is NEAREST. */
const INTRO_ZOOM = 0.3;

/**
 * A snap is an ordinary update taken with a step this long, seconds: by the end of it every
 * spring and every follow has landed on its target and come to rest, so there is no second code
 * path to keep in step with the first.
 */
const SETTLE = 1e3;

const goal = new Vector2();
const point = new Vector3();
const forward = new Vector3();

/** The same angle, within half a turn of zero. */
const wrap = (angle: number) => MathUtils.euclideanModulo(angle + Math.PI, 2 * Math.PI) - Math.PI;

export const createCamera: ModuleFactory = ({ camera, car, view, state, events, store, look }) => {
  // The speed zoom is the one move here that takes the whole picture with it, so whoever asked
  // for less motion gets half of it.
  const speedZoom = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.2 : 0.4;

  // What measure() takes from the screen: its shape, the camera's distance at rest, the unit
  // vector from the focus to the camera, and the footprint's centre as seen from the focus.
  let aspect = 0;
  let rest = 0;
  const away = new Vector3();
  const offset = new Vector3();

  /** 0 at rest, towards 1 closer in, below 0 further out. */
  const zoom = { x: 0, v: 0 };
  /** Where the view is aimed, from the car: down the road at speed, at the board on a pad. */
  const aimX = { x: 0, v: 0 };
  const aimZ = { x: 0, v: 0 };
  /** Heading of the chase view. */
  let yaw = 0;

  /**
   * The follow: the point being chased, where that was a frame ago, and the point that follows.
   * In the default view the follower is the focus on the ground; in the chase view, the camera.
   */
  const target = new Vector3();
  const last = new Vector3();
  const anchor = new Vector3();

  /** Set by whatever moves the car or the view all at once. The first frame is such a move. */
  let snap = true;
  /** Seconds until a requested change of view happens. 0 while none is pending. */
  let switchIn = 0;

  /** Where the ray through a point of the screen, -1 to 1 on both axes, meets the plane y = 0. */
  function ground(x: number, y: number, out: Vector3): Vector3 {
    out.set(x, y, 0.5).unproject(camera).sub(camera.position);
    return out.multiplyScalar(-camera.position.y / out.y).add(camera.position);
  }

  /**
   * Fits the rig to the screen. The default view never turns, so the orientation left here is the
   * one every frame uses; only the chase view aims the camera again.
   */
  function measure(): void {
    aspect = camera.aspect;
    rest = REST + SPILL * Math.max(0, 16 / 9 / aspect - 1);
    camera.fov = FOV;
    camera.updateProjectionMatrix();
    camera.position.setFromSphericalCoords(REACH * rest, aspect < 1 ? POLAR_PORTRAIT : POLAR, FACE);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    away.copy(camera.position).normalize();

    // The screen's corners land on the ground as a trapezoid that is widest at its far edge, so
    // the circle round their mean that passes through a far corner holds all four.
    ground(-1, -1, offset).add(ground(1, -1, point)).add(ground(-1, 1, point));
    offset.add(ground(1, 1, point)).multiplyScalar(0.25);
    view.radius = offset.distanceTo(point);
    view.near = camera.position.distanceTo(ground(0, -1, point));
    view.far = camera.position.distanceTo(ground(0, 1, point));
    view.halfWidth = rest * Math.tan(MathUtils.degToRad(FOV / 2)) * aspect;

    if (view.mode === 'chase') {
      camera.fov = 55;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Moves the anchor after the target. This is the exact answer for a target that moved in a
   * straight line during the step, where the usual lerp towards it is only right for one that
   * stood still: the car keeps its place on screen at every refresh rate and through a hitch,
   * instead of twitching by a few pixels whenever a frame runs long.
   */
  function follow(step: number): void {
    // A frame with no time in it moves nothing, and would divide by that zero.
    if (step === 0) return;
    if (snap) last.copy(target);
    const decay = Math.exp(-FOLLOW * step);
    anchor.sub(last).multiplyScalar(decay).add(target);
    anchor.addScaledVector(last.sub(target), (1 - decay) / (FOLLOW * step));
    last.copy(target);
  }

  camera.near = 1;
  camera.far = 400;
  view.mode = store.saved.chase ? 'chase' : 'iso';
  measure();

  // Only noted here: the snap is taken in update, once CarState holds the car's new pose.
  events.on('respawn', () => {
    snap = true;
  });
  events.on('camera', () => {
    store.saved.chase = !store.saved.chase;
    store.save();
    // The HUD's fade is opaque 0.15 s from now, and the view changes behind it.
    switchIn = 0.15;
  });

  return {
    update(dt) {
      if (switchIn > 0) {
        switchIn -= dt;
        if (switchIn <= 0) {
          view.mode = store.saved.chase ? 'chase' : 'iso';
          snap = true;
          measure();
        }
      }
      if (camera.aspect !== aspect) measure();

      const step = snap ? SETTLE : dt;
      const { position, velocity } = car;
      // The view rides at the height of the last ground the wheels touched, so the tunnel's roof
      // lifts it with the car; and never more than 3 m under the car, so a big jump stays in frame.
      const height = MathUtils.damp(view.focus.y, Math.max(car.groundY, position.y - 3), 3, step);

      if (view.mode === 'chase') {
        // Along the car's yaw only, and that damped: a bump cannot roll the view or a spin whip it.
        yaw = MathUtils.damp(yaw, yaw + wrap(car.yaw - yaw), 6, step);
        forward.set(Math.sin(yaw), 0, Math.cos(yaw));
        target.copy(position).addScaledVector(forward, -8.5);
        target.y += 3.6;
        follow(step);
        camera.position.copy(anchor);
        camera.lookAt(point.copy(position).addScaledVector(forward, 4).setY(position.y + 1.2));
        // This lens looks down the road, so what is sized from the view sits ahead of the car.
        view.focus.copy(position).addScaledVector(forward, 25).setY(height);
        view.centre.copy(view.focus);
      } else {
        const base = state.phase === 'driving' ? 0 : INTRO_ZOOM;
        springTo(zoom, base - speedZoom * MathUtils.smoothstep(car.speed, 8, 30), 0.6, step);

        const pad = state.pad;
        const parking = pad !== null && state.onPad && car.speed < 6;
        if (parking) {
          // Towards the pad's board, but never so far that the car itself leaves the frame.
          goal.set(pad.focusX - position.x, pad.focusZ - position.z);
          goal.clampLength(0, 0.55 * view.halfWidth);
        } else {
          // A quarter of a second down the road. The camera is to the south-east and shows the
          // least ground on its own side, so the part of the velocity that points at it, which is
          // (x + z) / 2 on each axis, leads by a fifth of a second more.
          goal.set(velocity.x, velocity.z).multiplyScalar(0.25);
          goal.addScalar(0.1 * Math.max(0, velocity.x + velocity.z)).clampLength(0, 9);
        }
        // One pair of springs carries both aims, so going from the road to a pad, back, or
        // straight from one pad to the next is a single eased move with no step in it.
        springTo(aimX, goal.x, parking ? 0.6 : 0.5, step);
        springTo(aimZ, goal.y, parking ? 0.6 : 0.5, step);

        target.set(position.x + aimX.x, 0, position.z + aimZ.x);
        follow(step);
        view.focus.set(anchor.x, height, anchor.z);
        camera.position.copy(view.focus);
        camera.position.addScaledVector(away, MathUtils.lerp(NEAREST, rest, 1 - zoom.x));
        view.centre.copy(view.focus).add(offset);
      }

      // Whatever runs later in the frame projects through the camera, so its matrices are settled
      // here and not left to the renderer.
      camera.updateMatrixWorld();
      look.uniforms.uFocus.value.copy(view.focus);
      snap = false;
    },
  };
};
