/**
 * The car you see: the Kenney sedan on the physics body's pose, its wheels riding in their arches,
 * lamps that answer the pedals, and a lean the physics does not have.
 *
 * It reads ctx.car and writes nothing back, so nothing here can change how the car drives.
 */
import {
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  ImageLoader,
  Mesh,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GRAVITY, type ModuleFactory } from './types';
import { springTo } from './util';

/** The sedan is 2.55 units long and the car is 4 m. */
const SCALE = 4 / 2.55;

/** Height of the axles in the model. Lowered by it, the model's origin is the physics body's. */
const AXLE = 0.3;

/** Height of the suspension's mount above that origin, metres: a wheel hangs its length below. */
const MOUNT = 0.2799;

/**
 * Metres a wheel may rise above where it is drawn at rest. A hard landing pushes the springs to
 * 0.27, and from here on the tyre would come up through the wing over its arch.
 */
const ARCH = 0.12;

/** The body's lean on its wheels at one g across the car and along it, radians. */
const ROLL = (5 * Math.PI) / 180;
const PITCH = (2.5 * Math.PI) / 180;

/**
 * A byte texture stops at 1.0, which is where the bloom starts, so the lamps' levels ride on the
 * material's emissive intensity and their texels hold the rest. 14 is what the brake lamps take:
 * the bloom goes by luminance, and a red needs 13.3 in its red channel to have one of 3.
 */
const EMISSIVE = 14;

/**
 * A lamp's texel, as bytes: its colour scaled to a luminance, the way look.glow scales a ring.
 * Without bloom the canvas clips each channel on its own, so a red pushed to luminance 3 loses its
 * hue and reads salmon, and idle and braking both read full red. There a lamp stops where its
 * brightest channel reaches 1, and the levels below the lit ones (1.6) are shares of that.
 */
function lamp(hex: number, luminance: number, hdr: boolean): number[] {
  const c = new Color(hex);
  let scale = luminance / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  if (!hdr) scale = Math.min(scale, 1 / Math.max(c.r, c.g, c.b)) * Math.min(1, luminance / 1.6);
  c.multiplyScalar((255 * scale) / EMISSIVE);
  // A byte step is 14 / 255 of a level. A lamp at its cap rounds up its brightest channel, or a
  // full red reads 254.
  if (!hdr && luminance >= 1.6) {
    const top = Math.max(c.r, c.g, c.b);
    c.multiplyScalar(Math.ceil(top) / top);
  }
  return c.toArray();
}

/**
 * The emissive map has one texel for each of the atlas's 8 x 4 swatches. Two swatches on the last
 * row are the lamps: these are where their texels start.
 */
/** Warm white ahead, always on. Red behind: dim, in full under the brake, and white in reverse. */
const HEAD_TEXEL = (3 * 8 + 1) * 4;
const TAIL_TEXEL = (3 * 8 + 2) * 4;

const acceleration = new Vector3();
const toCar = new Quaternion();

export const createCarBody: ModuleFactory = async (ctx) => {
  const { car } = ctx;
  const { hdr } = ctx.quality;
  const HEAD = lamp(0xffd678, 1.6, hdr);
  const RUNNING = lamp(0xff2418, 0.6, hdr);
  const BRAKING = lamp(0xff2418, 3, hdr);
  const REVERSING = lamp(0xffffff, 1.5, hdr);
  const [{ scene: model }, atlas] = await Promise.all([
    new GLTFLoader(ctx.loading).loadAsync('/models/sedan-sports.glb'),
    new ImageLoader(ctx.loading).loadAsync('/models/Textures/colormap.png'),
  ]);

  // Kenney's glass is the palest swatch of the atlas: under this sun the windows read as paper.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const paint = canvas.getContext('2d');
  if (!paint) throw new Error('carBody: no 2D canvas to repaint the atlas on');
  paint.drawImage(atlas, 0, 0);
  paint.fillStyle = '#1b2330';
  paint.fillRect(0, 384, 64, 128);
  // The lamp swatches are orange and red paint: the emissive texel adds to it, so a lit lamp
  // read salmon and a braking one hardly differed from idle. Black underneath, the texel's hue is
  // all there is.
  paint.fillStyle = '#000000';
  paint.fillRect(64, 384, 128, 128);
  const map = new CanvasTexture(canvas);
  // As the loader hands out its own: a glTF's UVs count from the top of the image.
  map.flipY = false;
  map.colorSpace = SRGBColorSpace;

  // Clamped, so a texel written into it is rounded.
  const texels = new Uint8ClampedArray(8 * 4 * 4);
  texels.set(HEAD, HEAD_TEXEL);
  texels.set(RUNNING, TAIL_TEXEL);
  const lamps = new DataTexture(texels, 8, 4);
  lamps.needsUpdate = true;

  // 0.83, so the brightest paint times the sun stays short of white. Both sides, because the
  // body is a shell with open edges.
  const material = ctx.look.lit({
    map,
    color: new Color().setScalar(0.83),
    side: DoubleSide,
    emissive: 0xffffff,
    emissiveIntensity: EMISSIVE,
    emissiveMap: lamps,
  });
  model.traverse((node) => {
    if (node instanceof Mesh) {
      node.material = material;
      node.castShadow = node.receiveShadow = true;
    }
  });

  // By exact name: a prefix would also catch the spare wheel on the SUV's tailgate.
  const part = (name: string): Object3D => {
    const node = model.getObjectByName(name);
    if (!node) throw new Error(`carBody: sedan-sports.glb has no '${name}'`);
    return node;
  };
  const body = part('body');
  // In CarState's order.
  const wheels = ['front-left', 'front-right', 'back-left', 'back-right'].map((corner) =>
    part(`wheel-${corner}`),
  );

  model.scale.setScalar(SCALE);
  for (const child of model.children) child.position.y -= AXLE;
  // Steered about the car's up axis first, then rolled about the axle that steering turned.
  for (const wheel of wheels) wheel.rotation.order = 'YXZ';
  ctx.scene.add(model);

  /** The car's velocity a frame ago. */
  const last = new Vector3();
  const roll = { x: 0, v: 0 };
  const pitch = { x: 0, v: 0 };
  let tail = RUNNING;
  // The car was put down somewhere else: the wheels and the lean start again from there, and
  // do not ease across the jump. The first frame is such a move.
  let moved = true;
  ctx.events.on('respawn', () => {
    moved = true;
  });

  return {
    update(dt) {
      // Physics time is render time, so this is already the frame's pose: smoothing it would
      // only make the hull trail the ground its wheels stand on.
      model.position.copy(car.position);
      model.quaternion.copy(car.quaternion);

      // A ray takes a kerb, a brick or the lip of a ramp in a single step, and lets go of the
      // ground in one. A tyre rolls over them: the ease is the 20 ms that takes.
      const ease = moved ? 1 : 1 - Math.exp(-50 * dt);
      for (let i = 0; i < 4; i++) {
        const { length, spin, steer } = car.wheels[i];
        const { position, rotation } = wheels[i];
        position.y += (Math.min(MOUNT - length, ARCH) / SCALE - position.y) * ease;
        rotation.set(spin, steer, 0);
      }

      const next = car.braking ? BRAKING : car.reversing ? REVERSING : RUNNING;
      if (next !== tail) {
        tail = next;
        texels.set(tail, TAIL_TEXEL);
        lamps.needsUpdate = true;
      }

      // The lean is the body's alone, so the wheels stay planted. Physics rolls the car 0.45
      // degrees in a corner, which reads as none: this is the weight you see.
      if (moved) {
        roll.x = roll.v = pitch.x = pitch.v = 0;
      } else if (dt > 0) {
        // In g, in the car's own frame: x across it, z along it. In the air nothing pushes on
        // the tyres, and the body hangs level.
        if (car.wheelsDown > 0) {
          acceleration
            .copy(car.velocity)
            .sub(last)
            .divideScalar(-GRAVITY * dt)
            .applyQuaternion(toCar.copy(car.quaternion).invert())
            .clampScalar(-1, 1);
        } else {
          acceleration.set(0, 0, 0);
        }
        // Out of a left turn, and nose down under the brakes.
        springTo(roll, acceleration.x * ROLL, 0.12, dt);
        springTo(pitch, -acceleration.z * PITCH, 0.12, dt);
      }
      moved = false;
      last.copy(car.velocity);
      body.rotation.set(pitch.x, 0, roll.x);
    },
  };
};
