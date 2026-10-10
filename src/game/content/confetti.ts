/**
 * Paper for the moments that matter: every award sound and the first arrival at the CV. One
 * instanced mesh drawn from the first frame (unused quads have zero scale), so nothing compiles or
 * uploads after Start, and the instance buffer is re-sent only while something is alive.
 */
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { FINISH } from '../layout';
import type { GameContext, ModuleFactory } from '../types';
import { mulberry32 } from '../util';

const COUNT = 300;
const PER_BURST = 120;
const LIFE = 3;
const FADE = 0.5;
/** Paper, not bricks: the world's gravity would end the show in half a second. */
const GRAVITY = -9;
const DRAG = 1.2;
const FLUTTER = 0.8;
const CONE = Math.cos((35 * Math.PI) / 180);
const COLOURS = ['#2997ff', '#f0b429', '#34c759', '#ff5d73', '#ffffff'];

const pos = new Float32Array(COUNT * 3);
const vel = new Float32Array(COUNT * 3);
const axis = new Float32Array(COUNT * 3);
/** Radians per second of tumble, flutter phase, accumulated tumble angle, seconds lived. */
const spin = new Float32Array(COUNT);
const phase = new Float32Array(COUNT);
const angle = new Float32Array(COUNT);
const age = new Float32Array(COUNT).fill(LIFE);

const scratchPos = new Vector3();
const scratchAxis = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = new Matrix4();

const createConfetti: ModuleFactory = (ctx: GameContext) => {
  const { events, car, terrain } = ctx;
  const random = mulberry32(0xc0f3771);

  const mesh = new InstancedMesh(
    new PlaneGeometry(0.18, 0.12),
    ctx.look.unlit({ side: DoubleSide }),
    COUNT,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  // The colour buffer must exist before the warm-up: adding it later changes the program.
  const colour = new Color();
  for (let i = 0; i < COUNT; i++) {
    mesh.setColorAt(i, colour.set(COLOURS[i % COLOURS.length]));
    mesh.setMatrixAt(i, scratchMatrix.makeScale(0, 0, 0));
  }
  ctx.scene.add(mesh);

  let next = 0;
  let alive = 0;
  let dirty = false;
  let cvDone = false;

  function burst(x: number, y: number, z: number): void {
    for (let n = 0; n < PER_BURST; n++) {
      const i = next;
      next = (next + 1) % COUNT;
      const j = i * 3;
      const cosT = 1 - random() * (1 - CONE);
      const sinT = Math.sqrt(1 - cosT * cosT);
      const phi = random() * Math.PI * 2;
      const speed = 6 + random() * 8;
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
      vel[j] = sinT * Math.cos(phi) * speed;
      vel[j + 1] = cosT * speed;
      vel[j + 2] = sinT * Math.sin(phi) * speed;
      const az = random() * 2 - 1;
      const ar = Math.sqrt(1 - az * az);
      const ap = random() * Math.PI * 2;
      axis[j] = ar * Math.cos(ap);
      axis[j + 1] = az;
      axis[j + 2] = ar * Math.sin(ap);
      spin[i] = 4 + random() * 8;
      phase[i] = random() * Math.PI * 2;
      angle[i] = random() * Math.PI * 2;
      age[i] = 0;
    }
    dirty = true;
  }

  events.on('sound', (id) => {
    if (id === 'award') burst(car.position.x, car.position.y + 2, car.position.z);
  });
  events.on('pad', (pad) => {
    if (pad?.id !== 'cv' || cvDone) return;
    cvDone = true;
    burst(FINISH[0], FINISH[1], FINISH[2]);
  });

  return {
    update(dt) {
      if (alive === 0 && !dirty) return;
      const drag = Math.exp(-DRAG * dt);
      alive = 0;
      for (let i = 0; i < COUNT; i++) {
        if (age[i] >= LIFE) continue;
        const j = i * 3;
        age[i] += dt;
        if (age[i] >= LIFE) {
          mesh.setMatrixAt(i, scratchMatrix.makeScale(0, 0, 0));
          continue;
        }
        alive++;
        const a = age[i];
        const ground = terrain.heightAt(pos[j], pos[j + 2]) + 0.02;
        if (pos[j + 1] > ground) {
          vel[j + 1] += GRAVITY * dt;
          vel[j] *= drag;
          vel[j + 1] *= drag;
          vel[j + 2] *= drag;
          const flutter = Math.sin(a * 9 + phase[i]) * FLUTTER;
          pos[j] += (vel[j] + flutter) * dt;
          pos[j + 1] = Math.max(ground, pos[j + 1] + vel[j + 1] * dt);
          pos[j + 2] += (vel[j + 2] + Math.cos(a * 9 + phase[i]) * FLUTTER) * dt;
          angle[i] += spin[i] * dt;
        }
        scratchAxis.set(axis[j], axis[j + 1], axis[j + 2]);
        scratchQuat.setFromAxisAngle(scratchAxis, angle[i]);
        const s = Math.min(1, (LIFE - a) / FADE);
        scratchMatrix.compose(
          scratchPos.set(pos[j], pos[j + 1], pos[j + 2]),
          scratchQuat,
          scratchScale.set(s, s, s),
        );
        mesh.setMatrixAt(i, scratchMatrix);
      }
      // One more upload after the last quad dies, so it is not left hanging on screen.
      dirty = alive > 0;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
};

export default createConfetti;
