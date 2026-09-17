import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Car, loadCarModel } from './car';
import { buildWorld, type Board } from './world';
import { createInput } from './input';

/** Swap for any other model in /public/models — it is measured, not assumed. */
const CAR_MODEL = '/models/sedan-sports.glb';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('[data-canvas]');
const loading = $('[data-loading]');
const progressBar = $('[data-progress]');
const intro = $('[data-intro]');
const startBtn = $<HTMLButtonElement>('[data-start]');
const fallback = $('[data-fallback]');
const hud = $('[data-hud]');
const speedEl = $('[data-speed]');
const scoreEl = $('[data-score]');
const panel = $('[data-panel]');
const stick = $('[data-stick]');
const soundBtn = $<HTMLButtonElement>('[data-sound]');
const resetBtn = $<HTMLButtonElement>('[data-reset]');

/* ---------------------------------------------------------------- guard */
if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
  loading.hidden = true;
  intro.hidden = true;
  fallback.hidden = false;
  throw new Error('WebGL unavailable');
}

async function boot() {
  /* ------------------------------------------------------------- render */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 600);
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

  /* -------------------------------------------------------------- build */
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url: string, loaded: number, total: number) => {
    progressBar.style.transform = `scaleX(${total ? loaded / total : 0})`;
  };

  const textures = new THREE.TextureLoader(manager);
  const gltf = new GLTFLoader(manager);

  const bits = buildWorld(scene, world, groundMaterial, textures);
  const model = await loadCarModel(CAR_MODEL, gltf);
  const car = new Car(world, carMaterial, model);
  car.addTo(scene);

  const input = createInput(stick);

  loading.hidden = true;
  intro.hidden = false;

  /* --------------------------------------------------------------- audio */
  let audio: AudioContext | null = null;
  let engineGain: GainNode | null = null;
  let engineOsc: OscillatorNode | null = null;
  let soundOn = false;

  function initAudio() {
    if (audio) return;
    audio = new AudioContext();
    engineOsc = audio.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 60;
    engineGain = audio.createGain();
    engineGain.gain.value = 0;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 460;
    engineOsc.connect(filter).connect(engineGain).connect(audio.destination);
    engineOsc.start();
  }

  function blip(freq: number, gain: number, seconds: number, type: OscillatorType) {
    if (!audio || !soundOn) return;
    const osc = audio.createOscillator();
    const vol = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    vol.gain.setValueAtTime(gain, audio.currentTime);
    vol.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + seconds);
    osc.connect(vol).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + seconds + 0.02);
  }

  const honk = () => blip(340, 0.09, 0.32, 'square');

  // Impacts: pitch and level scale with how hard you hit the thing.
  car.body.addEventListener('collide', (e: { contact: CANNON.ContactEquation }) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v < 3) return;
    const t = Math.min(v / 18, 1);
    blip(90 + t * 150, 0.02 + t * 0.06, 0.09 + t * 0.08, 'triangle');
  });

  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off';
    if (soundOn) {
      initAudio();
      audio?.resume();
    } else if (engineGain && audio) {
      engineGain.gain.setTargetAtTime(0, audio.currentTime, 0.05);
    }
  });

  resetBtn.addEventListener('click', () => car.reset());

  /* --------------------------------------------------------------- panel */
  let activeBoard: Board | null = null;
  let cvShown = false;

  function showBoard(board: Board | null) {
    if (board === activeBoard) return;
    activeBoard = board;

    if (!board) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }

    const s = board.site;
    panel.hidden = false;
    panel.innerHTML = `
      <p class="panel-kicker">Site ${String(s.num).padStart(2, '0')} of 20</p>
      <h2>${s.name}</h2>
      <img class="panel-shot" src="${s.card}" alt="" loading="lazy" />
      <div class="panel-links">
        <a href="/#site-${s.slug}">See all ${s.images.length} screens &rsaquo;</a>
      </div>`;
  }

  function showCv(show: boolean) {
    if (show === cvShown) return;
    cvShown = show;
    if (!show) {
      if (!activeBoard) {
        panel.hidden = true;
        panel.innerHTML = '';
      }
      return;
    }
    activeBoard = null;
    panel.hidden = false;
    panel.innerHTML = `
      <p class="panel-kicker">Finish line</p>
      <h2>Brandon van Vuuren &mdash; CV</h2>
      <p class="panel-desc">The whole thing in PDF form: experience, education, stack.</p>
      <div class="panel-links">
        <a href="/assets/CV Brandon van Vuuren.pdf" target="_blank" rel="noopener">Open the PDF &rsaquo;</a>
        <a href="/assets/CV Brandon van Vuuren.pdf" download>Download &rsaquo;</a>
      </div>`;
  }

  /* ---------------------------------------------------------------- loop */
  const camTarget = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const yawEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const yawQuat = new THREE.Quaternion();
  const offset = new THREE.Vector3();

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

  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  function frame() {
    const dt = tick();

    if (running) {
      car.applyInput(input, dt);
      world.step(1 / 60, dt, 3);
      car.sync();

      if (input.consumeReset()) car.reset();
      if (input.consumeHorn()) honk();

      // Auto-righting: if you land on the roof you get put back after a beat
      flippedFor = car.isFlipped ? flippedFor + dt : 0;
      if (flippedFor > 1.6) {
        car.reset(car.body.position.clone());
        car.body.position.y += 1.6;
        flippedFor = 0;
      }

      const pos = car.object.position;
      const rush = Math.min(car.speedKmh / 80, 1);

      // Chase camera — follows heading only, so bumps don't roll the view,
      // and pulls back as you gather speed.
      yawEuler.setFromQuaternion(car.object.quaternion);
      yawQuat.setFromEuler(new THREE.Euler(0, yawEuler.y, 0));
      offset
        .set(0, 4.3 + rush * 1.1, -(9.5 + rush * 4))
        .applyQuaternion(yawQuat)
        .add(pos);

      const k = 1 - Math.pow(0.0015, dt);
      camTarget.lerp(offset, k);
      camera.position.copy(camTarget);

      camLook.lerp(lookAt.copy(pos).setY(pos.y + 1.2), k * 1.4);
      camera.lookAt(camLook);

      const wantFov = 58 + rush * 7;
      if (Math.abs(wantFov - fov) > 0.08) {
        fov = wantFov;
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // Keep the shadow frustum on the car
      bits.sun.position.set(pos.x + 40, 60, pos.z + 30);
      bits.sun.target.position.copy(pos);
      bits.sun.target.updateMatrixWorld();

      // Proximity: whichever board the car is standing on wins
      let near: Board | null = null;
      for (const board of bits.boards) {
        if (
          Math.abs(pos.x - board.position.x) < board.half.x &&
          Math.abs(pos.z - board.position.z) < board.half.z
        ) {
          near = board;
          break;
        }
      }
      const onCv =
        Math.hypot(pos.x - bits.cv.position.x, pos.z - bits.cv.position.z) < bits.cv.radius;

      showCv(onCv);
      if (!onCv) showBoard(near);

      speedEl.textContent = String(Math.round(car.speedKmh));

      const { knocked, total } = bits.score();
      if (knocked !== shownKnocked) {
        shownKnocked = knocked;
        scoreEl.textContent = `${knocked}/${total}`;
      }

      if (soundOn && audio && engineGain && engineOsc) {
        engineOsc.frequency.setTargetAtTime(58 + rush * 170, audio.currentTime, 0.08);
        engineGain.gain.setTargetAtTime(0.018 + rush * 0.04, audio.currentTime, 0.1);
      }
    }

    bits.update(elapsed);
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(frame);

  /* --------------------------------------------------------------- start */
  startBtn.addEventListener('click', () => {
    intro.hidden = true;
    hud.hidden = false;
    stick.hidden = false;
    running = true;
    resetClock(); // drop the idle time so the first frame isn't a huge step
    camTarget.copy(camera.position);
    bits.start();
    canvas.focus();
  });

  // Resuming a hidden tab with a giant dt launches the car into orbit.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetClock();
  });

  addEventListener('pagehide', () => {
    renderer.setAnimationLoop(null);
    input.dispose();
    renderer.dispose();
  });
}

boot().catch((err) => {
  console.error(err);
  loading.hidden = true;
  intro.hidden = true;
  fallback.hidden = false;
});
