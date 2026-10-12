/**
 * The page entry: it builds the game behind the loading screen, runs the one frame function, and
 * takes a visit through its three phases.
 *
 * Every rendered frame advances the physics by exactly that frame's time, cut into equal steps of
 * at most 10 ms: one step a frame at 120 Hz and above, two at 60. Physics time is render time, so
 * nothing is interpolated and nothing judders, and the car handles alike on every display.
 *
 * Whatever goes wrong, at any point, ends on the fallback screen with the CV as a PDF: a chunk
 * that did not arrive, a throw in a frame, a GPU that took the context away.
 */
import { LoadingManager, Quaternion, Vector3 } from 'three';
import { createCamera } from './camera';
import { createCar } from './car';
import { createCarBody } from './carBody';
import { createTerrain } from './ground';
import { createHud } from './hud';
import { createInput } from './input';
import { TEST, WORLD, assertLayout } from './layout';
import { createPhysics } from './physics';
import { createProps } from './props';
import { createRender } from './render';
import type {
  BaseContext,
  CarState,
  GameContext,
  GameModule,
  GameState,
  ModuleFactory,
  Pad,
  Tier,
  ViewState,
  WheelState,
} from './types';
import { createEvents, createStore } from './util';

/**
 * The content of the world, in frame order. Each name is a file in ./content that default-exports
 * a ModuleFactory, and a name with no file is skipped: a module runs from the day it is written.
 */
const CONTENT = [
  'scenery',
  'signs',
  'boards',
  'structures',
  'playground',
  'grass',
  'effects',
  'confetti',
  'audio',
  'panels',
  'directory',
  'telemetry',
  'trial',
  'chart',
  'awards',
];

/**
 * Lazy, so a file is fetched only when it is going to run: the test ground asks for none of them,
 * and a half-saved module cannot break a page that left it out.
 */
const files = import.meta.glob<{ default: ModuleFactory }>('./content/*.ts');

/**
 * Where a slow device is remembered as low. The tab's storage and not the store: one slow moment
 * must not downgrade a machine for ever.
 */
const TIER_KEY = 'drive:tier';

/** Seconds a pad's panel stays up after the car has left the pad. */
const DWELL = 3;

/** The markup is drive.astro's, so an element that is missing is a mistake there. */
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const canvas = $<HTMLCanvasElement>('[data-canvas]');
const loading = $('[data-loading]');
const bar = $('[data-progress]');
const intro = $('[data-intro]');
const startButton = $('[data-start]');
const fallback = $('[data-fallback]');
const hud = $('[data-hud]');

const nextFrame = () => new Promise(requestAnimationFrame);

function fail(reason: unknown): void {
  console.error(reason);
  loading.hidden = intro.hidden = hud.hidden = true;
  fallback.hidden = false;
}

function rememberedTier(): Tier | null {
  try {
    return sessionStorage.getItem(TIER_KEY) === 'low' ? 'low' : null;
  } catch {
    return null;
  }
}

/**
 * Notes that this device is to start as low, and says whether the note will be there after a
 * reload. Where the tab has no storage a reload would measure the same device, find it slow and
 * reload again, for ever.
 */
function rememberLow(): boolean {
  try {
    sessionStorage.setItem(TIER_KEY, 'low');
    return sessionStorage.getItem(TIER_KEY) === 'low';
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // The switches below and the hook itself exist for the bench: no visitor's URL reaches them by
  // accident, and without ?debug a production page never downloads debug.ts or the test ground.
  const debug = import.meta.env.DEV || params.has('debug');
  const asked = debug ? params.get('tier') : null;
  const forced = asked === 'high' || asked === 'low' ? asked : null;
  const testGround = debug && params.get('ground') === 'test';
  const only = debug ? params.get('only')?.split(',') : undefined;

  const render = createRender(canvas, forced ?? rememberedTier());
  if (!render) throw new Error('drive: this browser has no WebGL 2');
  const { renderer, scene, camera } = render;

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    fail(new Error('drive: the WebGL context was lost'));
  });

  // The bar follows the loaders, and a loader that has just been handed more to fetch reports
  // less than it did: the bar keeps what it has shown. The last tenth is the settle and the
  // warm-up, which load nothing.
  let shown = 0;
  const progress = (share: number) => {
    if (share <= shown) return;
    shown = share;
    bar.style.transform = `scaleX(${share})`;
  };
  const manager = new LoadingManager();
  manager.onProgress = (_url, loaded, total) => progress((0.9 * loaded) / total);

  const [rapier, hook] = await Promise.all([
    // The game's only value import of Rapier, so the bundler gives its 2 MB a chunk of their own.
    import('@dimforge/rapier3d-compat').then(async (module) => {
      await module.init();
      return module;
    }),
    debug ? import('./debug') : null,
    // The weights the ground lettering and the signs are painted in. A canvas painted before its
    // face has arrived keeps the fallback face for the session. A face that cannot be fetched is
    // no reason to refuse the game.
    document.fonts.load('800 1em Inter').catch(() => []),
    document.fonts.load('600 1em Inter').catch(() => []),
  ]);

  const { world, physics, beginFrame, step, simTime, frameMs } = createPhysics(rapier);

  const wheel = (): WheelState => ({
    contact: false,
    point: new Vector3(),
    length: 0,
    spin: 0,
    steer: 0,
  });
  const car: CarState = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    speed: 0,
    forwardSpeed: 0,
    yaw: 0,
    upY: 1,
    wheels: [wheel(), wheel(), wheel(), wheel()],
    wheelsDown: 0,
    airTime: 0,
    groundY: 0,
    slip: 0,
    braking: false,
    reversing: false,
    boosting: false,
  };
  const view: ViewState = {
    mode: 'iso',
    focus: new Vector3(),
    centre: new Vector3(),
    radius: 0,
    near: 0,
    far: 0,
    halfWidth: 0,
  };
  const state: GameState = { phase: 'loading', time: 0, pad: null, onPad: false, level: 0 };
  const events = createEvents();
  const store = createStore();
  const input = createInput({ state, car, camera, events });
  const props = createProps({ rapier, world, scene, car, events });
  const places = testGround ? TEST : WORLD;
  if (import.meta.env.DEV) assertLayout();

  const base: BaseContext = {
    rapier,
    world,
    physics,
    props,
    renderer,
    scene,
    camera,
    look: render.look,
    tier: render.tier,
    quality: render.quality,
    loading: manager,
    places,
    input,
    car,
    view,
    state,
    events,
    store,
  };
  const ground = testGround ? (await import('./testground')).default : createTerrain;
  const ctx: GameContext = { ...base, terrain: await ground(base) };

  /** Seconds since the car was last on a pad. */
  let away = 0;
  const pads: GameModule = {
    update(dt) {
      let under: Pad | null = null;
      for (let i = 0; i < places.pads.length && !under; i++) {
        const { x, z, radius } = places.pads[i];
        if ((x - car.position.x) ** 2 + (z - car.position.z) ** 2 < radius ** 2) {
          under = places.pads[i];
        }
      }
      state.onPad = under !== null;

      // The panel outlives the pad, so a car that rolls off the edge can still be reading it.
      away = under ? 0 : away + dt;
      const pad = under ?? (away < DWELL ? state.pad : null);
      if (pad !== state.pad) {
        state.pad = pad;
        events.emit('pad', pad);
      }
    },
  };

  // The list is the frame order. A frame goes by after each build, so each is a task of its own
  // and the loading screen keeps painting between them.
  const modules: GameModule[] = [];
  const build = async (factory: ModuleFactory) => {
    modules.push(await factory(ctx));
    await nextFrame();
  };
  await build(createCar);
  await build(createCarBody);
  modules.push({ update: () => props.sync() }, pads);
  await build(createCamera);
  modules.push(render.attach(ctx));
  // Every import starts at once, and the builds follow in order.
  const names = testGround
    ? []
    : CONTENT.filter((name) => `./content/${name}.ts` in files && (only?.includes(name) ?? true));
  const content = await Promise.all(names.map((name) => files[`./content/${name}.ts`]()));
  for (const { default: factory } of content) await build(factory);
  await build(createHud);

  const instrument = hook?.installDebug(ctx, { render, props, simTime, frameMs });

  // Props are authored standing and stepped until they sleep, a slice of 8 ms to a frame: a step
  // to a frame would cost a phone four seconds.
  let steps = 0;
  let moving = true;
  while (moving && steps < 240) {
    const until = performance.now() + 8;
    while (moving && steps < 240 && performance.now() < until) {
      moving = props.settle();
      steps++;
    }
    await nextFrame();
  }
  await render.warmUp();
  // Lost while loading: the fallback is already up, and there is nothing to run behind it.
  if (renderer.getContext().isContextLost()) return;

  /** The 45 frames the governor measures the display and the device on are over. */
  const ready = () => {
    if (render.tier === 'high' && !forced && render.slow && rememberLow()) {
      renderer.setAnimationLoop(null);
      location.reload();
      return;
    }
    state.phase = 'intro';
    progress(1);
    loading.hidden = true;
    intro.hidden = false;
    // Enter and Space are a way in, too.
    startButton.focus();
  };

  // The game already runs behind the intro with no input, so Start only flips the phase. The
  // emit is inside the click: the one gesture that may start the audio and the video.
  startButton.addEventListener(
    'click',
    () => {
      state.phase = 'driving';
      events.emit('start');
      intro.hidden = true;
      hud.hidden = false;
      canvas.focus();
    },
    { once: true },
  );

  // Only noted: the frame fits the drawing buffer, once, before anything reads its size.
  let resized = false;
  addEventListener('resize', () => {
    resized = true;
  });

  /** The last frame's rAF timestamp, milliseconds. Negative until there has been one. */
  let last = -1;
  renderer.setAnimationLoop((time: number) => {
    // performance.now() only brackets the callback. The step is the display's own timestamp,
    // unsmoothed: any filter on it would make physics time drift from what is on screen.
    const begin = performance.now();
    try {
      const dt = last < 0 ? 0 : Math.min((time - last) / 1000, 0.05);
      last = time;
      state.time += dt;
      // Half a millisecond of slack keeps a 100 Hz frame that ran a hair long at one step.
      const n = Math.max(1, Math.ceil((dt * 1000 - 0.5) / 10));
      const h = dt / n;
      renderer.info.reset();
      beginFrame();

      if (resized) {
        resized = false;
        render.resize();
      }

      input.sample();

      if (dt > 0) {
        for (let i = 0; i < n; i++) {
          for (let m = 0; m < modules.length; m++) modules[m].substep?.(h);
          step(h);
        }
      }

      for (let m = 0; m < modules.length; m++) modules[m].update?.(dt);

      renderer.render(scene, camera);

      const cpuMs = performance.now() - begin;
      instrument?.record(time, dt, n, cpuMs);
      render.govern(dt, cpuMs, state);
      if (state.phase === 'loading' && render.refreshMs > 0) ready();
    } catch (error) {
      renderer.setAnimationLoop(null);
      fail(error);
    }
  });
}

boot().catch(fail);
