/**
 * window.__drive: the instrument behind every number the QA monitor gates on, and the readout for
 * a run on a phone, which has no console.
 *
 * main.ts imports this file dynamically, and only when import.meta.env.DEV is true or the URL has
 * ?debug, so no visitor downloads it and window.__drive exists under the same condition. Under it
 * main.ts honours three more switches, and this file the fourth:
 *   ?tier=high|low   forces the tier before the renderer exists and switches the slow-device reload off
 *   ?ground=test     loads the flat test ground and no content module
 *   ?only=a,b        loads only the named content modules (src/game/content/<name>.ts)
 *   ?stats           adds a one-line on-screen readout, for runs on a real phone
 *
 * A frame is recorded into typed arrays made once, so recording adds nothing to what a frame
 * allocates; frames() copies them out. Every number is read from its source and none is worked
 * out from another: simTime is the h physics really stepped and frameTime the dt main.ts
 * consumed, which is what lets the two be seen to disagree.
 */
import { Vector2, Vector3 } from 'three';
import type { PropsEngine } from './props';
import type { Render } from './render';
import type { GameContext, Phase, Tier, ViewMode } from './types';

export interface DriveDebug {
  /** A fresh snapshot. */
  state(): DriveState;
  /** Every frame since the previous call (ring of 16,384), then clears. */
  frames(): DriveFrames;
  /** Car at rest on a named respawn, camera snapped, no fade. */
  teleport(respawn: string): void;
  /** Car dropped at a pose: y is metres above the ground (default 1.2), roll 180 is on its roof. */
  place(x: number, z: number, yawDeg: number, rollDeg?: number, y?: number): void;
  /** Every pad of the loaded world, for sweeps. */
  pads(): { id: string; x: number; z: number; radius: number; open: string | null }[];
}

export interface DriveState {
  phase: Phase;
  tier: Tier;
  /** Rung of the quality ladder, 0 best, and how often it moved. */
  level: number;
  levelChanges: number;
  /** 1000 over the refresh period the governor calibrated. 0 until it has. */
  refreshHz: number;
  pixelRatio: number;
  /** Seconds the physics world was stepped, and seconds of frame dt consumed. Must match. */
  simTime: number;
  frameTime: number;
  car: {
    position: [number, number, number];
    speedKmh: number;
    forwardKmh: number;
    yawDeg: number;
    upY: number;
    wheelsDown: number;
    airTime: number;
    slipDeg: number;
  };
  input: { throttle: number; steer: number; brake: boolean; boost: boolean };
  view: {
    mode: ViewMode;
    focus: [number, number, number];
    /** Radius of the circle of ground on screen: constant between resizes. */
    radius: number;
    /** Camera to focus, metres: what the speed zoom moves. */
    distance: number;
  };
  /** Id of the pad whose panel is up, and whether the car is on it. */
  pad: string | null;
  onPad: boolean;
  score: { knocked: number; total: number };
  saved: { sites: number; secrets: number; muted: boolean; chase: boolean; lapMs: number };
  /** Dynamic bodies apart from the car. */
  bodies: { total: number; awake: number };
  gpu: { programs: number; textures: number; geometries: number };
  /** [startMs, durationMs] of every task over 50 ms. */
  longTasks: [number, number][];
}

/** Parallel arrays, one entry per frame unless noted. */
export interface DriveFrames {
  /** rAF timestamp, ms. */
  time: number[];
  /** Clamped step fed to the simulation, ms. */
  dt: number[];
  substeps: number[];
  /** Whole frame callback, and the sum of its world steps, ms. */
  cpuMs: number[];
  physicsMs: number[];
  /** EXT_disjoint_timer_query_webgl2, -1 where unavailable. */
  gpuMs: number[];
  /** Draw calls and triangles over every pass. */
  calls: number[];
  triangles: number[];
  /** Awake dynamic bodies apart from the car. */
  awake: number[];
  /** Horizontal speed, m/s. */
  speed: number[];
  /** Sampled throttle, for latency checks. */
  throttle: number[];
  /** Index into pads() of the pad whose panel is up, -1 for none. */
  pad: number[];
  /** World Y of the car's up axis, and wheels on the ground: air time and tilt between samples. */
  upY: number[];
  wheelsDown: number[];
  /** Closing speed of the hardest hit on the car this frame, m/s. 0 for none. */
  impact: number[];
  /** x, y, z per frame, as rendered. */
  car: number[];
  /** x, y per frame, CSS pixels on screen. */
  carPx: number[];
  /** x, y, z per frame. */
  camera: number[];
}

declare global {
  interface Window {
    __drive?: DriveDebug;
  }
}

/** Frames the ring holds: 114 s at 144 Hz, about half a minute with vsync off. */
const SIZE = 16_384;

/** Timer queries in flight at once: a result is ready a frame or two after its frame. */
const QUERIES = 8;

/** GL names from EXT_disjoint_timer_query_webgl2, which lib.dom has no types for. */
const TIME_ELAPSED = 0x88bf;
const GPU_DISJOINT = 0x8fbb;

/** In the place of a row number: the timer query is not waiting on a result. */
const FREE = -1;

/** Frames the on-screen line looks back over, at most: a second of them at any real frame rate. */
const WINDOW = 1024;

const DEG = 180 / Math.PI;

const point = new Vector3();
const size = new Vector2();

/** The q-quantile of the first n values, which are left sorted. */
const quantile = (values: Float32Array, n: number, q: number): number =>
  values.subarray(0, n).sort()[Math.min(n - 1, Math.floor(q * n))];

export function installDebug(
  ctx: GameContext,
  parts: { render: Render; props: PropsEngine; simTime(): number; frameMs(): number },
): {
  /**
   * Once a frame, after the render: the rAF timestamp in milliseconds, the frame's clamped step
   * in seconds, the substeps it was cut into, and the milliseconds the frame callback took.
   */
  record(time: number, dt: number, substeps: number, cpuMs: number): void;
} {
  const { renderer, scene, camera, world, physics, places, input, car, view, state, events } = ctx;
  const { render, props } = parts;
  const { info } = renderer;

  /** One row per frame, under the names frames() hands them out by. */
  const ring = {
    time: new Float64Array(SIZE),
    // Doubles: the substep count is a ceiling of this very number, and a float rounded across
    // one of its thresholds would show a count the frame did not take.
    dt: new Float64Array(SIZE),
    substeps: new Float32Array(SIZE),
    cpuMs: new Float32Array(SIZE),
    physicsMs: new Float32Array(SIZE),
    gpuMs: new Float32Array(SIZE),
    calls: new Float32Array(SIZE),
    triangles: new Float32Array(SIZE),
    awake: new Float32Array(SIZE),
    speed: new Float32Array(SIZE),
    throttle: new Float32Array(SIZE),
    pad: new Float32Array(SIZE),
    upY: new Float32Array(SIZE),
    wheelsDown: new Float32Array(SIZE),
    impact: new Float32Array(SIZE),
    car: new Float32Array(SIZE * 3),
    carPx: new Float32Array(SIZE * 2),
    camera: new Float32Array(SIZE * 3),
  };
  /** Frames recorded since the page loaded, and how many of them frames() has handed out. */
  let count = 0;
  let taken = 0;

  let level = state.level;
  let levelChanges = 0;

  /*
   * GPU time: one timer query round each render of the scene, from the shadow pass to the last
   * blit of the post chain. The scene's two render hooks are the only places on either side of
   * all of it, and the result is ready a frame or two later, so every query in flight remembers
   * the row it measured.
   */
  const context = renderer.getContext();
  const gl =
    context instanceof WebGL2RenderingContext &&
    context.getExtension('EXT_disjoint_timer_query_webgl2') !== null
      ? context
      : null;
  const queries = gl ? Array.from({ length: QUERIES }, () => gl.createQuery()) : [];
  /** The row each query's result belongs in, or FREE. */
  const rowOf = queries.map(() => FREE);
  /** The query round the render since the last record(), or -1. */
  let open = -1;
  if (gl) {
    scene.onBeforeRender = () => {
      // A second render before the row is written takes the same query over: the last one counts.
      if (open < 0) open = rowOf.indexOf(FREE);
      if (open >= 0) gl.beginQuery(TIME_ELAPSED, queries[open]);
    };
    scene.onAfterRender = () => {
      if (open >= 0) gl.endQuery(TIME_ELAPSED);
    };
  }

  const longTasks: [number, number][] = [];
  // Where the browser does not report them, the list stays empty.
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    // Buffered: the long tasks of the loading, from before this file arrived, are wanted too.
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) longTasks.push([task.startTime, task.duration]);
    }).observe({ type: 'longtask', buffered: true });
  }

  /*
   * DEV: from 2 s after Start nothing may compile or upload any more, which is what the warm-up
   * was for. state.time from which the counts are held, and what they were then.
   */
  let heldFrom = Infinity;
  let held: DriveState['gpu'] | null = null;
  if (import.meta.env.DEV) {
    events.on('start', () => {
      heldFrom = state.time + 2;
    });
  }

  /**
   * ?stats: one line under the HUD's rows, rewritten once a second from the frames of that second.
   * Tier, quality level, pixel ratio, median frame rate, late frames, cpuMs p95, physicsMs p99
   * and draw calls.
   */
  const readout = (): ((now: number) => void) => {
    const line = document.createElement('pre');
    line.style.cssText =
      'position:fixed;z-index:30;top:calc(env(safe-area-inset-top,0px) + 6.5rem);' +
      'left:env(safe-area-inset-left,0px);margin:0;padding:2px 6px;font:11px/1.4 monospace;' +
      'white-space:pre-wrap;color:#fff;background:rgba(0,0,0,.7);pointer-events:none';
    document.body.append(line);
    const intervals = new Float32Array(WINDOW);
    const cpu = new Float32Array(WINDOW);
    const steps = new Float32Array(WINDOW);
    let shown = 0;

    return (now) => {
      if (now - shown < 1000) return;
      shown = now;
      let n = 0;
      let late = 0;
      // Newest first. An interval needs the row before it, which has to be in the ring still.
      for (let row = count - 1; row > 0 && row > count - SIZE && n < WINDOW; row--) {
        const at = ring.time[row % SIZE];
        if (now - at >= 1000) break;
        // Not dt: that one is clamped at 50 ms, and would call 5 frames a second 20.
        intervals[n] = at - ring.time[(row - 1) % SIZE];
        if (render.refreshMs > 0 && intervals[n] > 1.5 * render.refreshMs) late++;
        cpu[n] = ring.cpuMs[row % SIZE];
        steps[n] = ring.physicsMs[row % SIZE];
        n++;
      }
      if (n === 0) return;
      line.textContent =
        `${ctx.tier} L${state.level} dpr ${renderer.getPixelRatio().toFixed(2)} ` +
        `${Math.round(1000 / quantile(intervals, n, 0.5))} fps late ${late} ` +
        `cpu ${quantile(cpu, n, 0.95).toFixed(1)} phys ${quantile(steps, n, 0.99).toFixed(2)} ` +
        `calls ${ring.calls[(count - 1) % SIZE]}`;
    };
  };
  const show = new URLSearchParams(location.search).has('stats') ? readout() : null;

  window.__drive = {
    state() {
      const { saved } = ctx.store;
      const bodies = { total: 0, awake: 0 };
      world.forEachRigidBody((body) => {
        if (!body.isDynamic() || body.userData === 'car') return;
        bodies.total++;
        if (!body.isSleeping()) bodies.awake++;
      });
      return {
        phase: state.phase,
        tier: ctx.tier,
        level: state.level,
        levelChanges,
        refreshHz: render.refreshMs > 0 ? 1000 / render.refreshMs : 0,
        pixelRatio: renderer.getPixelRatio(),
        simTime: parts.simTime(),
        frameTime: state.time,
        car: {
          position: [car.position.x, car.position.y, car.position.z],
          speedKmh: car.speed * 3.6,
          forwardKmh: car.forwardSpeed * 3.6,
          yawDeg: car.yaw * DEG,
          upY: car.upY,
          wheelsDown: car.wheelsDown,
          airTime: car.airTime,
          slipDeg: car.slip * DEG,
        },
        input: { ...input.state },
        view: {
          mode: view.mode,
          focus: [view.focus.x, view.focus.y, view.focus.z],
          radius: view.radius,
          distance: camera.position.distanceTo(view.focus),
        },
        pad: state.pad?.id ?? null,
        onPad: state.onPad,
        score: { knocked: props.knocked, total: props.total },
        saved: {
          sites: saved.sites.length,
          secrets: saved.secrets.length,
          muted: saved.muted,
          chase: saved.chase,
          lapMs: saved.lapMs,
        },
        bodies,
        gpu: {
          programs: info.programs?.length ?? 0,
          textures: info.memory.textures,
          geometries: info.memory.geometries,
        },
        longTasks: [...longTasks],
      };
    },

    frames() {
      // Frames the ring has since written over are gone: the newest SIZE are what is left.
      const first = Math.max(taken, count - SIZE);
      taken = count;
      /** One column, oldest row first, with as many numbers to a row as the column holds. */
      const copy = (column: Float32Array | Float64Array): number[] => {
        const width = column.length / SIZE;
        const out: number[] = [];
        for (let row = first; row < count; row++) {
          const at = (row % SIZE) * width;
          for (let i = 0; i < width; i++) out.push(column[at + i]);
        }
        return out;
      };
      return {
        time: copy(ring.time),
        dt: copy(ring.dt),
        substeps: copy(ring.substeps),
        cpuMs: copy(ring.cpuMs),
        physicsMs: copy(ring.physicsMs),
        gpuMs: copy(ring.gpuMs),
        calls: copy(ring.calls),
        triangles: copy(ring.triangles),
        awake: copy(ring.awake),
        speed: copy(ring.speed),
        throttle: copy(ring.throttle),
        pad: copy(ring.pad),
        upY: copy(ring.upY),
        wheelsDown: copy(ring.wheelsDown),
        impact: copy(ring.impact),
        car: copy(ring.car),
        carPx: copy(ring.carPx),
        camera: copy(ring.camera),
      };
    },

    teleport(name) {
      const at = places.respawns.find((respawn) => respawn.name === name);
      // Thrown, so that a misspelt name fails the monitor's step instead of leaving the car put.
      if (!at) throw new Error(`debug: no respawn is called '${name}'`);
      events.emit('place', at.x, 0, at.z, at.yaw, 0);
    },

    place(x, z, yawDeg, rollDeg = 0, y = 1.2) {
      events.emit('place', x, y, z, yawDeg / DEG, rollDeg / DEG);
    },

    pads: () => places.pads.map(({ id, x, z, radius, open }) => ({ id, x, z, radius, open })),
  };

  return {
    record(time, dt, substeps, cpuMs) {
      const i = count % SIZE;
      ring.time[i] = time;
      ring.dt[i] = dt * 1000;
      ring.substeps[i] = substeps;
      ring.cpuMs[i] = cpuMs;
      ring.physicsMs[i] = parts.frameMs();
      ring.gpuMs[i] = -1;
      ring.calls[i] = info.render.calls;
      ring.triangles[i] = info.render.triangles;
      ring.awake[i] = props.awake;
      ring.speed[i] = car.speed;
      ring.throttle[i] = input.state.throttle;
      ring.pad[i] = state.pad ? places.pads.indexOf(state.pad) : -1;
      ring.upY[i] = car.upY;
      ring.wheelsDown[i] = car.wheelsDown;
      ring.impact[i] = physics.impactCount > 0 ? physics.impacts[0].speed : 0;
      car.position.toArray(ring.car, i * 3);
      camera.position.toArray(ring.camera, i * 3);
      // Through the matrices the frame was drawn with. The size is the canvas's, in CSS pixels.
      point.copy(car.position).project(camera);
      renderer.getSize(size);
      ring.carPx[i * 2] = (0.5 + 0.5 * point.x) * size.x;
      ring.carPx[i * 2 + 1] = (0.5 - 0.5 * point.y) * size.y;

      if (gl) {
        if (open >= 0) {
          rowOf[open] = count;
          open = -1;
        }
        // Reading the flag clears it, so it is read once and counts against every query in flight.
        const disjoint: boolean = gl.getParameter(GPU_DISJOINT);
        for (let q = 0; q < QUERIES; q++) {
          const row = rowOf[q];
          if (row === FREE) continue;
          const ready: boolean = gl.getQueryParameter(queries[q], gl.QUERY_RESULT_AVAILABLE);
          if (!ready && !disjoint) continue;
          rowOf[q] = FREE;
          // Nanoseconds. A disjoint result measured something else as well, and the row keeps -1.
          if (!disjoint) {
            ring.gpuMs[row % SIZE] = gl.getQueryParameter(queries[q], gl.QUERY_RESULT) / 1e6;
          }
        }
      }

      if (state.level !== level) {
        level = state.level;
        levelChanges++;
      }

      if (import.meta.env.DEV && state.time >= heldFrom) {
        const programs = info.programs?.length ?? 0;
        const { textures, geometries } = info.memory;
        if (!held) held = { programs, textures, geometries };
        else if (
          programs !== held.programs ||
          textures !== held.textures ||
          geometries !== held.geometries
        ) {
          console.error(
            `debug: something compiled or uploaded after the warm-up: programs ${held.programs} ` +
              `to ${programs}, textures ${held.textures} to ${textures}, geometries ` +
              `${held.geometries} to ${geometries}`,
          );
          heldFrom = Infinity;
        }
      }

      count++;
      show?.(time);
    },
  };
}
