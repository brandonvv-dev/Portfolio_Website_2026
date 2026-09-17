import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Car, loadCarModel } from './car';
import { buildWorld, type Board, type Spot } from './world';
import { loadPropLibrary } from './props';
import { createInput } from './input';
import { createEffects } from './effects';
import { GameAudio } from './audio';
import { PostFX } from './postfx';
import { BodyDamage } from './damage';
import { tuneSolver, SweptGuard, FIXED_STEP, MAX_SUBSTEPS } from './solver';

/** Swap for any other model in /public/models — it is measured, not assumed. */
const CAR_MODEL = '/models/sedan-sports.glb';

const SCENERY = [
  'tree_default', 'tree_detailed', 'tree_oak', 'tree_blocks', 'tree_cone',
  'tree_fat', 'tree_pineDefaultA', 'tree_pineRoundA', 'rock_largeA',
  'rock_largeB', 'rock_smallA', 'rock_smallB', 'plant_bush', 'plant_bushLarge',
  'grass', 'grass_large', 'flower_redA', 'flower_yellowA', 'flower_purpleA',
  'log', 'log_stack', 'stump_round', 'stump_old', 'statue_obelisk',
  'televisionModern',
].map((n) => `/models/props/${n}.glb`);

// These carry the car kit's colour atlas, so they load from beside the cars.
const LITTER = ['cone', 'box', 'debris-tire'].map((n) => `/models/${n}.glb`);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $opt = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const canvas = $<HTMLCanvasElement>('[data-canvas]');
const loading = $('[data-loading]');
const progressBar = $('[data-progress]');
const intro = $('[data-intro]');
const startBtn = $<HTMLButtonElement>('[data-start]');
const fallback = $('[data-fallback]');
const hud = $('[data-hud]');
const speedEl = $('[data-speed]');
const scoreEl = $('[data-score]');
const foundEl = $('[data-found]');
const secretEl = $('[data-secrets]');
const panel = $('[data-panel]');
const stick = $('[data-stick]');
const pedals = $('[data-pedals]');
const soundBtn = $<HTMLButtonElement>('[data-sound]');
const resetBtn = $<HTMLButtonElement>('[data-reset]');
const nightBtn = $<HTMLButtonElement>('[data-night]');
const tiltBtn = $<HTMLButtonElement>('[data-tilt]');
const toastEl = $('[data-toast]');
const recapEl = $('[data-recap]');

/* ------------------------------------------------------------ saved run */

const SAVE_KEY = 'drive-my-cv:v1';

interface Save {
  sites: string[];
  secrets: string[];
  knocked: number;
  bestAir: number;
  night: boolean;
  runs: number;
}

const blankSave = (): Save => ({
  sites: [],
  secrets: [],
  knocked: 0,
  bestAir: 0,
  night: false,
  runs: 0,
});

/**
 * Progress survives the visit. Wrapped in try/catch throughout: private
 * windows and blocked site data both throw on access rather than returning
 * empty, and none of this is worth failing the game over.
 */
function loadSave(): Save {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return blankSave();
    return { ...blankSave(), ...(JSON.parse(raw) as Partial<Save>) };
  } catch {
    return blankSave();
  }
}

const save = loadSave();

const persist = () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* Storage unavailable: the run just does not carry over. */
  }
};

/* ---------------------------------------------------------------- guard */
if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
  loading.hidden = true;
  intro.hidden = true;
  fallback.hidden = false;
  throw new Error('WebGL unavailable');
}

const IMPACT_AT = new THREE.Vector3();
const BLOCKER_POS = new THREE.Vector3();

async function boot() {
  /* ------------------------------------------------------------- render */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  let pixelCap = 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  // near = 0.5, not 0.1: the chase camera never gets closer than the 6m
  // collision clamp, and a 0.1 near plane throws away so much depth precision
  // that the road planes (y = 0.01) z-fight against the ground (y = 0) across
  // the far half of the arena — a shimmer that strobes as the camera moves.
  const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 600);
  camera.position.set(0, 10, 50);

  /* ------------------------------------------------------------ physics */
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.25;

  const groundMaterial = new CANNON.Material('ground');
  const carMaterial = new CANNON.Material('car');
  // Only matters when the chassis itself scrapes: let it slide, not stick.
  world.addContactMaterial(
    new CANNON.ContactMaterial(carMaterial, groundMaterial, {
      friction: 0.12,
      restitution: 0.1,
    })
  );

  // Iterations, contact stiffness and sleep thresholds. Defaults leave
  // stacks shivering and let fast bodies sink into each other.
  tuneSolver(world);

  /* -------------------------------------------------------------- build */
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url: string, loaded: number, total: number) => {
    progressBar.style.transform = `scaleX(${total ? loaded / total : 0})`;
  };

  const textures = new THREE.TextureLoader(manager);
  const gltf = new GLTFLoader(manager);

  const lib = await loadPropLibrary([...SCENERY, ...LITTER], gltf);
  const bits = buildWorld(
    scene,
    world,
    groundMaterial,
    textures,
    lib,
    renderer,
    renderer.capabilities.getMaxAnisotropy()
  );
  const model = await loadCarModel(CAR_MODEL, gltf);
  const car = new Car(world, carMaterial, model);
  car.addTo(scene);

  // Tessellates the hull once so there is somewhere for a dent to go.
  const damage = new BodyDamage(model.body);
  // cannon is a discrete solver; this walks the line the chassis actually
  // took each step so it cannot step over thin geometry at speed.
  const guard = new SweptGuard(car.body, world);

  const fx = createEffects(scene);
  const input = createInput({
    stick,
    gas: $opt('[data-gas]'),
    reverse: $opt('[data-reverse]'),
    brake: $opt('[data-brake]'),
  });

  /* ------------------------------------------------------------- recap */

  if (save.runs > 0) {
    const bits_ = [
      `${save.sites.length}/20 sites found`,
      `${save.secrets.length}/${bits.secrets.length} secrets`,
      save.bestAir > 0.4 ? `${save.bestAir.toFixed(1)}s best air` : '',
    ].filter(Boolean);
    recapEl.textContent = `Last time: ${bits_.join(' · ')}.`;
    recapEl.hidden = false;
  }

  save.runs++;
  persist();

  loading.hidden = true;
  intro.hidden = false;

  /* --------------------------------------------------------------- audio */

  // Engine note, tyres, wind, impacts and a room, all synthesised. See
  // audio.ts for why pitch follows revs rather than road speed.
  const sound = new GameAudio();
  let soundOn = false;

  const honk = () => sound.horn();

  /**
   * How enclosed the car is, 0..1, used as the reverb send. Measured against
   * the big flat boards the world already tracks for camera collision, which
   * is a decent stand-in for early reflections without casting a single ray.
   */
  let enclosure = 0;
  let enclosureTick = 0;
  const measureEnclosure = (x: number, z: number) => {
    let nearest = Infinity;
    for (const b of bits.blockers) {
      const p = b.getWorldPosition(BLOCKER_POS);
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < nearest) nearest = d;
    }
    // Right up against a hoarding is wet; 30m away is open air.
    return Math.min(1, Math.max(0, 1 - (nearest - 4) / 26));
  };

  /**
   * Photosensitivity. Impact shake is random, full-frame and per-frame, which
   * is the one thing in here a reduced-motion preference most clearly rules
   * out. PostFX gates the blur and the fringing on the same query.
   */
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const shake = { amount: 0 };

  // Impacts: heard, felt, seen, and now kept. One contact drives the audio
  // voice, the camera shake, the sparks and the panel damage.
  car.body.addEventListener('collide', (e: { contact: CANNON.ContactEquation }) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v < 3) return;
    const t = Math.min(v / 18, 1);

    const p = e.contact.bi === car.body ? e.contact.ri : e.contact.rj;
    IMPACT_AT.set(
      car.body.position.x + p.x,
      car.body.position.y + p.y,
      car.body.position.z + p.z
    );

    // A contact whose normal points mostly up is a landing, not a crash.
    const n = e.contact.ni;
    const landing = Math.abs(n.y) > 0.7;
    if (landing) sound.land(t);
    else sound.impact(IMPACT_AT, t, e.contact.bj.mass === 0 || e.contact.bi.mass === 0);

    shake.amount = Math.min(1, shake.amount + t * 0.9);

    // Panels only crease on a real hit, and never from simply landing.
    if (!landing && v > 5) damage.dent(IMPACT_AT, (v - 5) / 16);

    if (v > 7) {
      for (let i = 0; i < 4 + Math.round(t * 10); i++)
        fx.sparks(IMPACT_AT.x, IMPACT_AT.y, IMPACT_AT.z, t);
    }
  });

  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off';
    void sound.setEnabled(soundOn);
  });

  /* ---------------------------------------------------------- day/night */

  let night = save.night;
  const setNight = (on: boolean) => {
    night = on;
    bits.setNight(on);
    car.setLights(on);
    renderer.toneMappingExposure = on ? 1.15 : 1;
    nightBtn.setAttribute('aria-pressed', String(on));
    nightBtn.textContent = on ? 'Night' : 'Day';
    save.night = on;
    persist();
  };
  setNight(night);
  nightBtn.addEventListener('click', () => setNight(!night));

  /* ------------------------------------------------------ tilt steering */

  let tiltOn = false;
  tiltBtn.addEventListener('click', async () => {
    tiltOn = await input.enableTilt(!tiltOn);
    tiltBtn.setAttribute('aria-pressed', String(tiltOn));
    tiltBtn.textContent = tiltOn ? 'Tilt on' : 'Tilt';
    if (!tiltOn) toast('Tilt steering is not available here');
  });

  /* --------------------------------------------------------------- toast */

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 1900);
  };

  /* ------------------------------------------------------------- respawn */

  /**
   * Put the car back where the player actually is, not at the start line.
   * A reset that sends you 200m back up the road after one bad landing is
   * how people leave.
   */
  const respawn = () => {
    const p = car.body.position;
    let best = bits.respawns[0];
    let bestDist = Infinity;
    for (const r of bits.respawns) {
      const d = (r.position.x - p.x) ** 2 + (r.position.z - p.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    car.reset(new CANNON.Vec3(best.position.x, best.position.y, best.position.z));
    car.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), best.yaw);
    damage.reset();
    toast(`Back at ${best.name}`);
  };

  resetBtn.addEventListener('click', respawn);

  /* --------------------------------------------------------------- panel */
  // One renderer for every kind of pad. Keyed, so a panel is only rebuilt
  // when what you are standing on actually changes.
  let panelKey = '';

  const setPanel = (key: string, html: string) => {
    if (key === panelKey) return;
    panelKey = key;
    if (!key) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    panel.hidden = false;
    panel.innerHTML = html;
  };

  // The screenshot is on the board in front of you and the name is on the
  // pylon above it, so the panel is only the thing you cannot do in 3D: the
  // link.
  const boardPanel = (b: Board) => `
    <p class="panel-kicker">Site ${String(b.site.num).padStart(2, '0')} of 20</p>
    <h2>${b.site.name}</h2>
    <div class="panel-links">
      <a href="/#site-${b.site.slug}">See all ${b.site.images.length} screens &rsaquo;</a>
    </div>`;

  const spotPanel = (s: Spot) => `
    <p class="panel-kicker" style="color:${s.accent}">${s.sub}</p>
    <h2>${s.title}</h2>
    <div class="panel-links">
      <a href="${s.url}"${
        /^https?:/.test(s.url) ? ' target="_blank" rel="noopener"' : ''
      }>${s.cta} &rsaquo;</a>
    </div>`;

  const cvPanel = () => `
    <p class="panel-kicker">Finish line</p>
    <h2>Brandon van Vuuren &mdash; CV</h2>
    <div class="panel-links">
      <a href="/assets/CV Brandon van Vuuren.pdf" target="_blank" rel="noopener">Open the PDF &rsaquo;</a>
      <a href="/assets/CV Brandon van Vuuren.pdf" download>Download &rsaquo;</a>
    </div>`;

  /** Is the car standing on this yawed pad? */
  const onPad = (
    px: number,
    pz: number,
    at: { position: THREE.Vector3; yaw: number; half: { x: number; z: number } }
  ) => {
    const dx = px - at.position.x;
    const dz = pz - at.position.z;
    const c = Math.cos(at.yaw);
    const sn = Math.sin(at.yaw);
    return Math.abs(dx * c - dz * sn) < at.half.x && Math.abs(dx * sn + dz * c) < at.half.z;
  };

  /* ---------------------------------------------------------------- loop */
  const camTarget = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const yawEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const yawQuat = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const camFrom = new THREE.Vector3();
  const caster = new THREE.Raycaster();
  const wheelHit = new THREE.Vector3();
  const flatVel = new THREE.Vector3();

  // Manual clock: THREE.Clock is deprecated in r186.
  let last = performance.now();
  let elapsed = 0;
  const tick = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    elapsed += dt;
    return Math.min(dt, 1 / 20);
  };
  const resetClock = () => {
    last = performance.now();
  };

  let running = false;
  let flippedFor = 0;
  let fov = 58;
  let shownKnocked = -1;
  let shownFound = -1;
  /** Eases the camera in from the intro orbit instead of snapping to it. */
  let settle = 0;
  let skidTimer = 0;
  let dustTimer = 0;
  let airFor = 0;
  let idleSpin = 0;
  /** Height of the last surface the wheels found. */
  let groundY = 0;

  /* --------------------------------------------------------- auto quality */

  // Two seconds of honest measurement, then one downgrade. Sampling forever
  // means the quality flips back and forth every time the world gets busy.
  let quality: 'high' | 'low' = 'high';
  let frames = 0;
  let sampled = 0;

  const sampleQuality = (dt: number) => {
    if (quality === 'low' || !running) return;
    frames++;
    sampled += dt;
    if (sampled < 2) return;
    const fps = frames / sampled;
    frames = 0;
    sampled = 0;
    if (fps >= 40) return;
    quality = 'low';
    pixelCap = 1;
    renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap));
    renderer.shadowMap.enabled = false;
    bits.setQuality('low');
    // Drops ambient occlusion and the edge pass; motion blur stays, because
    // it is the one that actually conveys speed.
    post.setQuality('low');
    toast('Lowered detail to keep it smooth');
  };

  // Ambient occlusion, camera-reprojection motion blur, speed fringing and
  // edge cleanup. Built after the first resize so it starts at the right size.
  const post = new PostFX(renderer, scene, camera);

  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
  }
  addEventListener('resize', resize);
  resize();

  function frame() {
    const dt = tick();
    sampleQuality(dt);

    if (!running) {
      /* Intro flyover: a slow orbit of the start plaza, so the world is
       * already moving before anyone has touched a key. */
      const a = elapsed * 0.16;
      camera.position.set(Math.sin(a) * 52, 20 + Math.sin(a * 0.7) * 4, 112 + Math.cos(a) * 52);
      camera.lookAt(0, 3, 110);
      camTarget.copy(camera.position);
      camLook.set(0, 3, 110);
    }

    if (running) {
      car.applyInput(input, dt);
      // Half-size fixed step: at 80 km/h a 60Hz tick moves the car about a
      // wheel radius, which is enough to step straight over thin geometry.
      guard.record();
      world.step(FIXED_STEP, dt, MAX_SUBSTEPS);
      guard.resolve();
      car.sync();

      if (input.consumeReset()) respawn();
      if (input.consumeHorn()) honk();
      if (input.consumeLights()) car.setLights(!car.hasLights);

      // Auto-righting: if you land on the roof you get put back after a beat
      flippedFor = car.isFlipped ? flippedFor + dt : 0;
      if (flippedFor > 1.6) {
        car.reset(car.body.position.clone());
        car.body.position.y += 1.6;
        flippedFor = 0;
      }

      const pos = car.object.position;
      const rush = Math.min(car.speedKmh / 80, 1);
      const yaw = car.yaw;

      /* ----------------------------------------------------------- effects */

      const slip = car.slip;

      // Last known ground height, so the shadow and the airtime gate still
      // work over the tunnel roof rather than measuring from y = 0.
      const under = car.groundY;
      if (!Number.isNaN(under)) groundY = under;
      const lift = Math.max(0, pos.y - groundY - 0.6);
      fx.shadow(pos.x, groundY, pos.z, yaw, lift);

      // Marks are laid densely so the line is continuous; dust is emitted at
      // a fifth of that rate. Matched, the puffs pile into an opaque cloud
      // that hides the very marks they are meant to sell.
      dustTimer -= dt;
      const puffing = slip > 0.4 && dustTimer <= 0;
      if (puffing) dustTimer = 0.085;

      skidTimer -= dt;
      if (slip > 0.22 && car.speedKmh > 10 && skidTimer <= 0) {
        skidTimer = 0.022;
        // Rear wheels only. Fronts leave marks too in reality, and four
        // overlapping trails read as a smear rather than a pair of lines.
        for (const i of [2, 3]) {
          if (!car.wheelDown(i)) continue;
          car.contactPoint(i, wheelHit);
          fx.skid(wheelHit.x, wheelHit.z, yaw, 0.42 + slip * 0.3);
          if (puffing) fx.dust(wheelHit.x, wheelHit.y + 0.2, wheelHit.z, slip);
        }
      }

      /* ------------------------------------------------------------ air */

      if (car.airborne && lift > 0.5) {
        airFor += dt;
      } else if (airFor > 0) {
        if (airFor > 0.55) {
          toast(airFor > 1.5 ? `BIG AIR — ${airFor.toFixed(1)}s` : `Air ${airFor.toFixed(1)}s`);
          // Landing kicks up whatever the tyres find.
          for (let i = 0; i < 8; i++) fx.dust(pos.x, 0.3, pos.z, 0.6);
          shake.amount = Math.min(1, shake.amount + 0.4);
          if (airFor > save.bestAir) {
            save.bestAir = airFor;
            persist();
          }
        }
        airFor = 0;
      }

      /* --------------------------------------------------------- camera */

      // Chase camera — follows heading only, so bumps don't roll the view,
      // and pulls back as you gather speed.
      yawEuler.setFromQuaternion(car.object.quaternion);
      // Nobody is driving: drift the view round the car rather than sitting
      // dead still behind it.
      idleSpin = input.idle && car.speedKmh < 2 ? idleSpin + dt * 0.25 : idleSpin * 0.94;
      yawQuat.setFromEuler(new THREE.Euler(0, yawEuler.y + idleSpin, 0));
      offset
        .set(0, 4.3 + rush * 1.1, -(9.5 + rush * 4))
        .applyQuaternion(yawQuat)
        .add(pos);

      // Camera collision: without it, backing into a billboard puts the view
      // inside its frame and the screen fills with the back of a board.
      camFrom.copy(pos).setY(pos.y + 1.2);
      camDir.copy(offset).sub(camFrom);
      const reach = camDir.length();
      camDir.divideScalar(reach);
      caster.set(camFrom, camDir);
      caster.far = reach;
      const blocked = caster.intersectObjects(bits.blockers, false)[0];
      if (blocked) {
        // Never closer than a car length and a half. Clamped to 3m the view
        // ends up inside the boot looking at the roof, which is worse than
        // the clipping it was avoiding.
        offset.copy(camFrom).addScaledVector(camDir, Math.max(6, blocked.distance - 0.8));
        // Climb as it closes in, so a hard stop against a hoarding looks
        // down at the car rather than through it.
        offset.y += 2.2;
      }

      // Slower for the first moment after Start, so the handover from the
      // intro orbit is a move rather than a cut.
      settle = Math.min(1, settle + dt / 1.2);
      const k = 1 - Math.pow(0.0015 + (1 - settle) * 0.35, dt);
      camTarget.lerp(offset, k);
      camera.position.copy(camTarget);

      // Look where the car is going, not at where it is. Aiming the view a
      // little down the velocity vector is what makes a corner read as a
      // corner instead of the world rotating around you.
      flatVel.set(car.body.velocity.x, 0, car.body.velocity.z).multiplyScalar(0.28 * settle);
      camLook.lerp(lookAt.copy(pos).setY(pos.y + 1.2).add(flatVel), k * 1.4);
      camera.lookAt(camLook);

      // Impact shake, decaying. Applied after lookAt so it survives it.
      if (shake.amount > 0.002) {
        shake.amount *= Math.pow(0.05, dt);
        // Decays either way, or a calm run leaves it latched on the last impact.
        const s = calm ? 0 : shake.amount * 0.4;
        camera.position.x += (Math.random() * 2 - 1) * s;
        camera.position.y += (Math.random() * 2 - 1) * s;
        camera.position.z += (Math.random() * 2 - 1) * s;
        camera.rotateZ(calm ? 0 : (Math.random() * 2 - 1) * shake.amount * 0.02);
      }

      const wantFov = 58 + rush * 7;
      if (Math.abs(wantFov - fov) > 0.08) {
        fov = wantFov;
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // Keep the shadow frustum on the car, hung along the sky's own sun
      // direction so the shadows point away from the bright part of the sky.
      bits.sun.position.copy(pos).addScaledVector(bits.sunDir, 90);
      bits.sun.target.position.copy(pos);
      bits.sun.target.updateMatrixWorld();

      /* -------------------------------------------------------- secrets */

      for (const secret of bits.secrets) {
        if (secret.found) continue;
        if (Math.hypot(pos.x - secret.position.x, pos.z - secret.position.z) > secret.radius)
          continue;
        if (Math.abs(pos.y - secret.position.y) > 4) continue;
        secret.found = true;
        if (!save.secrets.includes(secret.id)) {
          save.secrets.push(secret.id);
          persist();
        }
        toast(`Found: ${secret.label}`);
        sound.chime();
      }

      // Whichever pad the car is standing on wins, finish line first.
      if (Math.hypot(pos.x - bits.cv.position.x, pos.z - bits.cv.position.z) < bits.cv.radius) {
        setPanel('cv', cvPanel());
      } else {
        const spot = bits.spots.find((sp) => onPad(pos.x, pos.z, sp));
        if (spot) {
          setPanel(`spot:${spot.id}`, spotPanel(spot));
        } else {
          const board = bits.boards.find((bd) => onPad(pos.x, pos.z, bd));
          setPanel(board ? `board:${board.site.slug}` : '', board ? boardPanel(board) : '');
          if (board && !save.sites.includes(board.site.slug)) {
            save.sites.push(board.site.slug);
            persist();
          }
        }
      }

      if (soundOn) {
        // Re-measuring every frame is wasted work; the room does not change
        // that fast, and the send is ramped anyway.
        if (--enclosureTick <= 0) {
          enclosureTick = 8;
          enclosure = measureEnclosure(pos.x, pos.z);
        }
        sound.place(camera);
        sound.update(
          {
            rpm: car.drive.rpm,
            rev: car.drive.rev,
            load: car.drive.load,
            shifting: car.drive.shifting,
            speedKmh: car.speedKmh,
            slip,
            grounded: !car.airborne,
          },
          enclosure
        );
      }

      speedEl.textContent = String(Math.round(car.speedKmh));

      const { knocked, total } = bits.score();
      if (knocked !== shownKnocked) {
        shownKnocked = knocked;
        scoreEl.textContent = `${knocked}/${total}`;
        if (knocked > save.knocked) {
          save.knocked = knocked;
          persist();
        }
      }

      const found = save.sites.length + save.secrets.length;
      if (found !== shownFound) {
        shownFound = found;
        foundEl.textContent = `${save.sites.length}/20`;
        secretEl.textContent = `${save.secrets.length}/${bits.secrets.length}`;
      }

    }

    fx.update(dt);
    bits.update(elapsed, running ? car.object.position : undefined);
    post.render(running ? Math.min(car.speedKmh / 85, 1) : 0);
  }

  renderer.setAnimationLoop(frame);

  /* --------------------------------------------------------------- start */
  startBtn.addEventListener('click', () => {
    intro.hidden = true;
    hud.hidden = false;
    stick.hidden = false;
    pedals.hidden = false;
    running = true;
    settle = 0;
    resetClock(); // drop the idle time so the first frame isn't a huge step
    bits.start();
    bits.playVideo(); // browsers only allow this off a user gesture
    canvas.focus();
  });

  // Resuming a hidden tab with a giant dt launches the car into orbit.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetClock();
  });

  // Dev-only driving aids. Stripped from the production bundle, so the built
  // page has no debug surface at all.
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __car: car,
      __tp: (x: number, z: number, yaw = Math.PI, y = 2) => {
        car.reset(new CANNON.Vec3(x, y, z));
        car.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
      },
      __state: () => ({
        pos: car.body.position.toArray().map((n: number) => +n.toFixed(1)),
        kmh: Math.round(car.speedKmh),
        slip: +car.slip.toFixed(2),
        air: car.airborne,
        score: bits.score(),
        secrets: bits.secrets.filter((s) => s.found).map((s) => s.id),
        sites: save.sites.length,
      }),
    });
  }

  addEventListener('pagehide', () => {
    persist();
    renderer.setAnimationLoop(null);
    input.dispose();
    sound.dispose();
    post.dispose();
    renderer.dispose();
  });
}

boot().catch((err) => {
  console.error(err);
  loading.hidden = true;
  intro.hidden = true;
  fallback.hidden = false;
});
