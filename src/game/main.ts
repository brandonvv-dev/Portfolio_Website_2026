import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Car } from './car';
import { buildWorld, type Board } from './world';
import { createInput } from './input';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('[data-canvas]');
const loading = $('[data-loading]');
const progressBar = $('[data-progress]');
const intro = $('[data-intro]');
const startBtn = $<HTMLButtonElement>('[data-start]');
const fallback = $('[data-fallback]');
const hud = $('[data-hud]');
const speedEl = $('[data-speed]');
const panel = $('[data-panel]');
const stick = $('[data-stick]');
const soundBtn = $<HTMLButtonElement>('[data-sound]');

/* ---------------------------------------------------------------- guard */
if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
  loading.hidden = true;
  intro.hidden = true;
  fallback.hidden = false;
  throw new Error('WebGL unavailable');
}

/* --------------------------------------------------------------- render */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050a);
scene.fog = new THREE.Fog(0x05050a, 55, 165);

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
camera.position.set(0, 8, 26);

/* -------------------------------------------------------------- physics */
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -22, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.defaultContactMaterial.friction = 0.25;

const groundMaterial = new CANNON.Material('ground');
const carMaterial = new CANNON.Material('car');
// Only matters when the chassis itself scrapes the floor: let it slide, not stick.
world.addContactMaterial(
  new CANNON.ContactMaterial(carMaterial, groundMaterial, {
    friction: 0.12,
    restitution: 0.08,
  })
);

/* ---------------------------------------------------------------- build */
const manager = new THREE.LoadingManager();
manager.onProgress = (_url: string, loaded: number, total: number) => {
  progressBar.style.transform = `scaleX(${total ? loaded / total : 0})`;
};
manager.onLoad = () => {
  loading.hidden = true;
  intro.hidden = false;
};
// Nothing to load (all textures cached) still needs the intro to appear.
setTimeout(() => {
  if (!loading.hidden) {
    loading.hidden = true;
    intro.hidden = false;
  }
}, 4000);

const textures = new THREE.TextureLoader(manager);
const bits = buildWorld(scene, world, groundMaterial, textures);
const car = new Car(world, carMaterial);
car.addTo(scene);

const input = createInput(stick);

/* ----------------------------------------------------------------- audio */
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
  filter.frequency.value = 420;
  engineOsc.connect(filter).connect(engineGain).connect(audio.destination);
  engineOsc.start();
}

function honk() {
  if (!audio || !soundOn) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = 340;
  gain.gain.setValueAtTime(0.09, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.32);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.35);
}

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

/* ----------------------------------------------------------------- panel */
let activeBoard: Board | null = null;
let cvShown = false;

function showProject(board: Board | null) {
  if (board === activeBoard) return;
  activeBoard = board;

  if (!board) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const p = board.project;
  panel.hidden = false;
  panel.innerHTML = `
    <p class="panel-kicker">Project</p>
    <h2>${p.title}</h2>
    <p class="panel-desc">${p.longDescription}</p>
    <ul class="panel-tech">${p.tech.map((t) => `<li>${t}</li>`).join('')}</ul>
    <div class="panel-links">
      ${p.github ? `<a href="${p.github}" target="_blank" rel="noopener">View source ›</a>` : ''}
      ${p.live ? `<a href="${p.live}" target="_blank" rel="noopener">Live site ›</a>` : ''}
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
    <h2>Brandon van Vuuren — CV</h2>
    <p class="panel-desc">The whole thing in PDF form: experience, education, stack.</p>
    <div class="panel-links">
      <a href="/assets/CV Brandon van Vuuren.pdf" target="_blank" rel="noopener">Open the PDF ›</a>
      <a href="/assets/CV Brandon van Vuuren.pdf" download>Download ›</a>
    </div>`;
}

/* ------------------------------------------------------------------ loop */
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

    // Auto-righting: if you land on the roof, you get put back after a beat
    flippedFor = car.isFlipped ? flippedFor + dt : 0;
    if (flippedFor > 1.6) {
      car.reset(car.body.position.clone());
      car.body.position.y += 1.5;
      flippedFor = 0;
    }

    const pos = car.object.position;

    // Chase camera — follows heading only, so bumps don't roll the view
    yawEuler.setFromQuaternion(car.object.quaternion);
    yawQuat.setFromEuler(new THREE.Euler(0, yawEuler.y, 0));
    offset.set(0, 4.4, -10).applyQuaternion(yawQuat).add(pos);

    // Frame-rate independent smoothing
    const k = 1 - Math.pow(0.0015, dt);
    camTarget.lerp(offset, k);
    camera.position.copy(camTarget);

    camLook.lerp(lookAt.copy(pos).setY(pos.y + 1.1), k * 1.4);
    camera.lookAt(camLook);

    // Keep the shadow frustum on the car
    bits.sun.position.set(pos.x + 28, 44, pos.z + 18);
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
      Math.hypot(pos.x - bits.cv.position.x, pos.z - bits.cv.position.z) < bits.cv.radius + 2;

    showCv(onCv);
    if (!onCv) showProject(near);

    speedEl.textContent = String(Math.round(car.speedKmh));

    if (soundOn && audio && engineGain && engineOsc) {
      const load = Math.min(car.speedKmh / 70, 1);
      engineOsc.frequency.setTargetAtTime(58 + load * 150, audio.currentTime, 0.08);
      engineGain.gain.setTargetAtTime(0.018 + load * 0.035, audio.currentTime, 0.1);
    }
  }

  bits.update(elapsed);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(frame);

/* ------------------------------------------------------------------ start */
startBtn.addEventListener('click', () => {
  intro.hidden = true;
  hud.hidden = false;
  stick.hidden = false;
  running = true;
  resetClock(); // drop the idle time so the first frame isn't a huge step
  camTarget.copy(camera.position);
  canvas.focus();
});

// Pause physics when the tab is hidden; resuming with a giant dt launches the car.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resetClock();
});

addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  input.dispose();
  renderer.dispose();
});
