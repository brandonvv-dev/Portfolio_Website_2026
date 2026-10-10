/**
 * What the car stirs up: tyre marks on tarmac, dust off the wheels, sparks off hard hits and the
 * leaves it pushes aside. Four meshes, all built before the warm-up and drawn at full count every
 * frame (an unused instance is a zero-scale quad, an unused particle has no alpha), so nothing
 * compiles or uploads for the first time while someone is driving.
 *
 * The old blob shadow is gone: the shadow map does that job on both tiers.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  NormalBlending,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  type Blending,
  type Texture,
} from 'three';
import type { GameContext, ModuleFactory, Uniforms } from '../types';
import { mulberry32 } from '../util';

const MARKS = 420;
/** Metres of travel between two tyre marks. */
const MARK_PITCH = 0.3;
const MARK_WIDTH = 0.3;
const MARK_LENGTH = 0.34;

const LEAF_BOX = 60;
const LEAF_PUSH_RADIUS = 3;
/** Leaves whose height and paving are looked up again each frame, besides the ones that move. */
const LEAF_REFRESH = 32;
const LEAF_WIDTH = 0.26;
const LEAF_LENGTH = 0.18;
/** Index of the first rear wheel in CarState.wheels. */
const REAR = 2;

const DUST_PER_SECOND = 12;
const PAVED_DUST = new Color('#b8b3aa');
const GRASS_DUST = new Color('#7fbf5a');
const LEAF_COLOURS = [new Color('#d9a441'), new Color('#c96f2e'), new Color('#a6e070')];

/** A round blob, full alpha out to `core` of its radius: 0 is soft dust, 0.5 a spark. */
function blobTexture(core: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('effects: no 2d canvas');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(core, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A soft stripe across the mark, so a tyre print has no hard edge. */
function skidTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('effects: no 2d canvas');
  const g = c.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * One pooled point system. three has no per-particle size or alpha on PointsMaterial, so this
 * carries its own shader. The point size is in metres, scaled by the projection, so a puff keeps
 * its world size on every tier and pixel ratio. The fragment end is the look's: the same fade to
 * the backdrop with distance, and the output encoding the half-float chain expects.
 */
function particleSystem(
  uniforms: Uniforms,
  map: Texture,
  count: number,
  blending: Blending,
  rng: () => number,
) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const span = new Float32Array(count);
  const grow = new Float32Array(count);

  const positions = new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
  const colours = new BufferAttribute(col, 3).setUsage(DynamicDrawUsage);
  const sizes = new BufferAttribute(size, 1).setUsage(DynamicDrawUsage);
  const alphas = new BufferAttribute(alpha, 1).setUsage(DynamicDrawUsage);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positions);
  geometry.setAttribute('pcolor', colours);
  geometry.setAttribute('size', sizes);
  geometry.setAttribute('alpha', alphas);

  const material = new ShaderMaterial({
    uniforms: { ...uniforms, map: { value: map } },
    vertexShader: /* glsl */ `
      uniform vec2 uResolution;
      attribute vec3 pcolor;
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      varying vec4 vDrive;
      void main() {
        vColor = pcolor;
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        float depth = max( - mv.z, 0.001 );
        vDrive = vec4( ( modelMatrix * vec4( position, 1.0 ) ).xyz, depth );
        // projectionMatrix[1][1] is 1 / tan( fov / 2 ).
        gl_PointSize = size * uResolution.y * projectionMatrix[1][1] / ( 2.0 * depth );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      #include <drive_common>
      uniform sampler2D map;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float a = texture2D( map, gl_PointCoord ).a * vAlpha;
        if ( a < 0.01 ) discard;
        vec3 c = mix( vColor, driveSky(), smoothstep( uFogNear, uFogFar, vDrive.w ) );
        gl_FragColor = vec4( c, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;

  let cursor = 0;

  /** Takes numbers, not an options object: a burst of sparks builds nothing. */
  function emit(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    spread: number,
    rise: number,
    puff: number,
    seconds: number,
    growth: number,
  ): void {
    const i = cursor;
    cursor = (cursor + 1) % count;
    const k = i * 3;
    pos[k] = x;
    pos[k + 1] = y;
    pos[k + 2] = z;
    vel[k] = (rng() * 2 - 1) * spread;
    vel[k + 1] = rise * (0.5 + rng());
    vel[k + 2] = (rng() * 2 - 1) * spread;
    col[k] = r;
    col[k + 1] = g;
    col[k + 2] = b;
    size[i] = puff;
    grow[i] = growth;
    alpha[i] = 1;
    span[i] = seconds;
    life[i] = seconds;
    colours.needsUpdate = true;
  }

  function update(dt: number): void {
    let live = false;
    // Air drag, so a puff stalls instead of sailing off across the map.
    const drag = Math.max(0, 1 - 1.8 * dt);
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      live = true;
      life[i] -= dt;
      if (life[i] <= 0) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      const k = i * 3;
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
      vel[k] *= drag;
      vel[k + 1] = vel[k + 1] * drag - 1.4 * dt;
      vel[k + 2] *= drag;
      size[i] += grow[i] * dt;
      alpha[i] = Math.max(0, life[i] / span[i]);
    }
    if (!live) return;
    positions.needsUpdate = true;
    sizes.needsUpdate = true;
    alphas.needsUpdate = true;
  }

  return { points, emit, update };
}

const createEffects: ModuleFactory = (ctx: GameContext) => {
  const { scene, look, car, terrain, quality, physics, events } = ctx;
  const uniforms = look.uniforms;
  const rng = mulberry32(0xd57);

  /* --- Tyre marks: a ring of instanced quads, the oldest overwritten first. ---------------- */
  const markMesh = new InstancedMesh(
    new PlaneGeometry(1, 1),
    look.unlit({
      map: skidTexture(),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    MARKS,
  );
  markMesh.frustumCulled = false;
  markMesh.renderOrder = 3;
  markMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const markArray = markMesh.instanceMatrix.array;
  scene.add(markMesh);

  // The one range an upload covers, stretched over every mark written this frame. It is a single
  // object that is pushed again each time, because three clears the list after each upload and
  // addUpdateRange would build a new one.
  const markRange = { start: 0, count: 0 };
  let markCursor = 0;
  let markLow = MARKS;
  let markHigh = -1;
  /** Where the last mark of each rear wheel lies, and whether that is still a continuous trail. */
  const trailX = [0, 0];
  const trailZ = [0, 0];
  const trailing = [false, false];

  function layMark(x: number, y: number, z: number): void {
    const c = Math.cos(car.yaw);
    const s = Math.sin(car.yaw);
    const o = markCursor * 16;
    // Local x across the tyre, local y along the car, local z up: the quad faces the sky.
    markArray[o] = c * MARK_WIDTH;
    markArray[o + 1] = 0;
    markArray[o + 2] = -s * MARK_WIDTH;
    markArray[o + 3] = 0;
    markArray[o + 4] = -s * MARK_LENGTH;
    markArray[o + 5] = 0;
    markArray[o + 6] = -c * MARK_LENGTH;
    markArray[o + 7] = 0;
    markArray[o + 8] = 0;
    markArray[o + 9] = 1;
    markArray[o + 10] = 0;
    markArray[o + 11] = 0;
    markArray[o + 12] = x;
    markArray[o + 13] = y;
    markArray[o + 14] = z;
    markArray[o + 15] = 1;
    if (markCursor < markLow) markLow = markCursor;
    if (markCursor > markHigh) markHigh = markCursor;
    markCursor = (markCursor + 1) % MARKS;
  }

  /* --- Dust and sparks: two pools sharing quality.particles, 60 to 40. ---------------------- */
  const dustCount = Math.round(quality.particles * 0.6);
  const dust = particleSystem(uniforms, blobTexture(0), dustCount, NormalBlending, rng);
  const sparks = particleSystem(
    uniforms,
    blobTexture(0.5),
    quality.particles - dustCount,
    AdditiveBlending,
    rng,
  );
  scene.add(dust.points, sparks.points);
  let dustBudget = 0;
  let firstWheel = 0;

  function puffAt(x: number, y: number, z: number, hard: number): void {
    const grass = terrain.mask(x, z, 1) > 0.5 && rng() < 0.85;
    const c = grass ? GRASS_DUST : PAVED_DUST;
    dust.emit(
      x,
      y,
      z,
      c.r,
      c.g,
      c.b,
      0.8 + hard * 1.6,
      0.9 + hard * 1.4,
      0.55 + hard * 0.5,
      0.5 + hard * 0.5,
      1.2,
    );
  }

  events.on('land', (airTime) => {
    // Four puffs from each wheel, harder the longer the fall.
    const hard = Math.min(airTime / 0.6, 1);
    for (let w = 0; w < 4; w++) {
      const p = car.wheels[w].point;
      for (let n = 0; n < 4; n++) puffAt(p.x, p.y + 0.1, p.z, hard);
    }
  });

  /* --- Leaves: simulated here, drawn as one instanced mesh that wraps round the focus. ------- */
  const leafCount = quality.leaves;
  const leafMesh = new InstancedMesh(
    new PlaneGeometry(1, 1),
    look.lit({ side: DoubleSide }),
    leafCount,
  );
  leafMesh.frustumCulled = false;
  leafMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const leafArray = leafMesh.instanceMatrix.array;
  scene.add(leafMesh);

  const leafX = new Float32Array(leafCount);
  const leafZ = new Float32Array(leafCount);
  const leafVX = new Float32Array(leafCount);
  const leafVZ = new Float32Array(leafCount);
  const leafGround = new Float32Array(leafCount);
  /** 1 on soil, 0 where the leaf is parked because it lies on tarmac. */
  const leafShown = new Float32Array(leafCount);
  const half = LEAF_BOX / 2;

  function refreshLeaf(i: number): void {
    leafGround[i] = terrain.heightAt(leafX[i], leafZ[i]);
    leafShown[i] = terrain.mask(leafX[i], leafZ[i], 0) > 0.3 ? 0 : 1;
  }

  for (let i = 0; i < leafCount; i++) {
    leafX[i] = (rng() - 0.5) * LEAF_BOX;
    leafZ[i] = (rng() - 0.5) * LEAF_BOX;
    leafMesh.setColorAt(i, LEAF_COLOURS[Math.floor(rng() * LEAF_COLOURS.length)]);
    refreshLeaf(i);
  }
  let leafWindow = 0;

  function stepLeaves(dt: number): void {
    const focus = uniforms.uFocus.value;
    const wind = uniforms.uWind.value;
    const windX = wind.x * 0.25;
    const windZ = wind.y * 0.25;
    const damp = Math.exp(-2 * dt);
    const pushing = car.speed > 0.5;
    const carX = car.position.x;
    const carZ = car.position.z;
    const windowStart = leafWindow;
    leafWindow = (leafWindow + LEAF_REFRESH) % leafCount;

    for (let i = 0; i < leafCount; i++) {
      let x = leafX[i];
      let z = leafZ[i];
      let vx = leafVX[i];
      let vz = leafVZ[i];

      // The box follows the focus, so leaves are always where the camera looks.
      const offX = x - focus.x;
      const offZ = z - focus.z;
      const wrapX = LEAF_BOX * Math.floor((offX + half) / LEAF_BOX);
      const wrapZ = LEAF_BOX * Math.floor((offZ + half) / LEAF_BOX);
      let refresh = false;
      if (wrapX !== 0 || wrapZ !== 0) {
        x -= wrapX;
        z -= wrapZ;
        vx = 0;
        vz = 0;
        refresh = true;
      }

      if (pushing) {
        const ex = x - carX;
        const ez = z - carZ;
        const d2 = ex * ex + ez * ez;
        if (d2 < LEAF_PUSH_RADIUS * LEAF_PUSH_RADIUS) {
          const d = Math.sqrt(d2) + 0.01;
          const f = ((1 - d / LEAF_PUSH_RADIUS) * car.speed * 6 * dt) / d;
          vx += ex * f;
          vz += ez * f;
        }
      }
      vx *= damp;
      vz *= damp;
      const planar = vx * vx + vz * vz;
      if (planar < 1e-6) {
        vx = 0;
        vz = 0;
      }
      x += (vx + windX) * dt;
      z += (vz + windZ) * dt;
      leafX[i] = x;
      leafZ[i] = z;
      leafVX[i] = vx;
      leafVZ[i] = vz;

      if (refresh || planar > 0.04 || (i - windowStart + leafCount) % leafCount < LEAF_REFRESH) {
        refreshLeaf(i);
      }

      // Tumble is a function of where the leaf lies, so a leaf in motion turns with no state.
      const lift = planar > 1e-4 ? Math.min(Math.sqrt(planar) * 0.08, 0.7) : 0;
      const hash = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      const b = (hash - Math.floor(hash)) * Math.PI * 2;
      const tilt = lift * 1.2 + Math.sin(x * 3.1 + z * 2.7) * 0.25;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      // Rx(tilt - PI/2) first, then Ry(b), scaled in the leaf's own x and y.
      const ca = Math.sin(tilt);
      const sa = -Math.cos(tilt);
      const w = LEAF_WIDTH * leafShown[i];
      const l = LEAF_LENGTH * leafShown[i];
      const o = i * 16;
      leafArray[o] = cb * w;
      leafArray[o + 1] = 0;
      leafArray[o + 2] = -sb * w;
      leafArray[o + 3] = 0;
      leafArray[o + 4] = sb * sa * l;
      leafArray[o + 5] = ca * l;
      leafArray[o + 6] = cb * sa * l;
      leafArray[o + 7] = 0;
      leafArray[o + 8] = sb * ca;
      leafArray[o + 9] = -sa;
      leafArray[o + 10] = cb * ca;
      leafArray[o + 11] = 0;
      leafArray[o + 12] = x;
      leafArray[o + 13] = leafGround[i] + 0.03 + lift;
      leafArray[o + 14] = z;
      leafArray[o + 15] = 1;
    }
    leafMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    update(dt) {
      /* Marks and dust come from the rear wheels. */
      const speed = car.speed;
      const sliding = car.slip > 0.14 || car.braking;
      const marking = sliding && speed > 3;
      for (let w = 0; w < 2; w++) {
        const wheel = car.wheels[REAR + w];
        const p = wheel.point;
        if (marking && wheel.contact && terrain.mask(p.x, p.z, 0) > 0.5) {
          if (!trailing[w]) {
            trailing[w] = true;
            trailX[w] = p.x;
            trailZ[w] = p.z;
            layMark(p.x, p.y + 0.025, p.z);
          } else {
            // Distance, not time: the marks lie evenly at any refresh rate. At most eight a frame
            // so a hitch cannot flood the ring.
            let dx = p.x - trailX[w];
            let dz = p.z - trailZ[w];
            let d = Math.sqrt(dx * dx + dz * dz);
            for (let n = 0; n < 8 && d >= MARK_PITCH; n++) {
              trailX[w] += (dx / d) * MARK_PITCH;
              trailZ[w] += (dz / d) * MARK_PITCH;
              layMark(trailX[w], p.y + 0.025, trailZ[w]);
              dx = p.x - trailX[w];
              dz = p.z - trailZ[w];
              d = Math.sqrt(dx * dx + dz * dz);
            }
            if (d >= MARK_PITCH) {
              trailX[w] = p.x;
              trailZ[w] = p.z;
            }
          }
        } else {
          trailing[w] = false;
        }
      }
      if (markHigh >= markLow) {
        markRange.start = markLow * 16;
        markRange.count = (markHigh - markLow + 1) * 16;
        markMesh.instanceMatrix.updateRanges.push(markRange);
        markMesh.instanceMatrix.needsUpdate = true;
        markLow = MARKS;
        markHigh = -1;
      }

      dustBudget = Math.min(dustBudget + dt * DUST_PER_SECOND, 2);
      const kicking = (sliding && speed > 2) || (ctx.input.state.throttle > 0.9 && speed < 8);
      if (kicking) {
        const hard = Math.min(speed / 20, 1);
        for (let k = 0; k < 2 && dustBudget >= 1; k++) {
          const wheel = car.wheels[REAR + ((k + firstWheel) & 1)];
          if (!wheel.contact) continue;
          puffAt(wheel.point.x, wheel.point.y + 0.1, wheel.point.z, hard);
          dustBudget -= 1;
        }
        firstWheel ^= 1;
      }

      for (let i = 0; i < physics.impactCount; i++) {
        const hit = physics.impacts[i];
        if (hit.speed <= 7) continue;
        const hard = Math.min(hit.speed / 18, 1);
        const n = 4 + Math.round(10 * hard);
        for (let k = 0; k < n; k++) {
          sparks.emit(
            hit.x,
            hit.y,
            hit.z,
            1,
            0.78 - hard * 0.3,
            0.35,
            2.4 + hard * 5,
            1.6 + hard * 3,
            0.3 + hard * 0.2,
            0.22 + hard * 0.3,
            -0.15,
          );
        }
      }
      dust.update(dt);
      sparks.update(dt);

      if (dt > 0) stepLeaves(dt);
    },
  };
};

export default createEffects;
