/**
 * The grass and the marks the wheels leave in it.
 *
 * The blades are one draw call over a lattice that is fixed in the world and wraps round the
 * focus, so the buffer is written once and never touched: a blade that falls off one edge of the
 * patch reappears on the opposite one, where the camera cannot see it. The vertex shader works out
 * where the blade stands, how tall it is and which way it faces; nothing is done on the CPU.
 *
 * The wheel tracks are a top-down render of four ribbons into a small target that follows the car.
 * The blades read it to lie flat, and the ground (ground.ts) reads the same texture to lighten,
 * so the two always agree.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  DoubleSide,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  DynamicDrawUsage,
  Mesh,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
} from 'three';
import { mulberry32 } from '../util';
import type { ModuleFactory, ShaderPatch } from '../types';

/**
 * Side of the lattice, metres. The patch is axis-aligned and the camera is turned 45 degrees, so
 * the far screen corners (about 26 m right, 33 m up at speed) reach 42 m along a world axis; 64 m
 * showed a straight edge there. Past that, fog dissolves the rest and wider only wastes vertex work.
 */
const PATCH = 80;
/** Patch the quality tiers' blade counts are quoted for: density per m2 is kept when PATCH shrinks. */
const TIER_PATCH = 96;
/** Blades kept at each rung of the quality ladder. The order is shuffled, so it thins evenly. */
const LADDER = [1, 0.6, 0.35];
/** Side of the ground the track target covers, metres. */
const WINDOW = 64;
/** Points per wheel, and metres between them: 38 m of history. */
const POINTS = 128;
const SPACING = 0.3;
/** Half the ribbon's width. */
const HALF = 0.25;

const vec3 = (hex: string): string => {
  const { r, g, b } = new Color(hex);
  return `vec3( ${r}, ${g}, ${b} )`;
};

/**
 * Three vertices per blade: the tip, then the left and the right of the root, which is the order
 * that faces the camera. The low tier has fewer blades, so each is larger.
 */
const blade = (scale: number): ShaderPatch => ({
  key: 'grass:blade',
  vertexPars: /* glsl */ `
attribute vec3 aBlade;
varying float vGrassTip;
`,
  normal: /* glsl */ `
objectNormal = vec3( 0.0, 1.0, 0.0 );
`,
  position: /* glsl */ `
int grassCorner = gl_VertexID % 3;
vGrassTip = grassCorner == 0 ? 1.0 : 0.0;
float grassSide = grassCorner == 1 ? -1.0 : ( grassCorner == 2 ? 1.0 : 0.0 );
vec2 grassAt = uFocus.xz + mod( aBlade.xy - uFocus.xz + ${PATCH / 2}.0, ${PATCH}.0 ) - ${PATCH / 2}.0;

// A height texel sits on every vertex of the ground, so the outer texels are at the world's edge.
vec2 grassUv = grassAt / uWorld + 0.5;
float grassCells = float( textureSize( uHeights, 0 ).x - 1 );
float grassY = texture2D( uHeights, ( grassUv * grassCells + 0.5 ) / ( grassCells + 1.0 ) ).r;
float grassMask = texture2D( uMasks, grassUv ).g;
float grassTrack = texture2D( uTracks, ( grassAt - uTracksRect.xy ) / uTracksRect.z + 0.5 ).r;

if ( grassMask < 0.3 ) {
  // Roads, pads, plazas and every footprint: a blade with no area.
  transformed = vec3( 0.0 );
} else {
  float grassHeight = mix( 0.45, 0.87, aBlade.z ) * ${scale.toFixed(1)} * grassMask * ( 1.0 - grassTrack );
  vec2 grassToCamera = normalize( cameraPosition.xz - grassAt );
  vec2 grassRight = vec2( grassToCamera.y, - grassToCamera.x );
  vec2 grassFoot = grassAt + grassRight * grassSide * ${(0.145 * scale).toFixed(3)};
  float grassBend = 0.5 + 0.5 * sin( uTime * 1.8 + aBlade.z * 62.83 );
  transformed = vec3( grassFoot.x, grassY + grassHeight * vGrassTip, grassFoot.y );
  transformed.xz += uWind * grassBend * grassHeight * vGrassTip * 0.8;
}
`,
  fragmentPars: /* glsl */ `
varying float vGrassTip;
`,
  albedo: /* glsl */ `
diffuseColor.rgb = mix( ${vec3('#4f9a47')}, ${vec3('#a6e070')}, vGrassTip );
`,
});

/** Where a wheel has been: slot 0 is the wheel itself, the rest is history, newest first. */
interface Trail {
  x: Float32Array;
  z: Float32Array;
  /** 1 where the tyre was on the ground, 0 in the air. */
  a: Float32Array;
  contact: boolean;
}

const trails: Trail[] = Array.from({ length: 4 }, () => ({
  x: new Float32Array(POINTS),
  z: new Float32Array(POINTS),
  a: new Float32Array(POINTS),
  contact: false,
}));

/** x, z, alpha and the side of the ribbon: two vertices per point. */
const ribbon = new Float32Array(4 * POINTS * 2 * 4);

function shift(trail: Trail): void {
  trail.x.copyWithin(1, 0, POINTS - 1);
  trail.z.copyWithin(1, 0, POINTS - 1);
  trail.a.copyWithin(1, 0, POINTS - 1);
}

function put(trail: Trail, x: number, z: number, alpha: number): void {
  trail.x[0] = x;
  trail.z[0] = z;
  trail.a[0] = alpha;
}

const grass: ModuleFactory = (ctx) => {
  const { look, quality, car, state, scene, renderer } = ctx;
  const { uniforms } = look;

  /* --------------------------------------------------------------- blades */

  const side = Math.round((quality.grass * PATCH) / TIER_PATCH);
  const count = side * side;
  const cell = PATCH / side;
  const random = mulberry32(0x6a55);
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lattice = new Float32Array(count * 9);
  for (let n = 0; n < count; n++) {
    const x = ((order[n] % side) + random()) * cell;
    const z = (Math.floor(order[n] / side) + random()) * cell;
    const r = random();
    for (let k = 0; k < 3; k++) lattice.set([x, z, r], n * 9 + k * 3);
  }
  const geometry = new BufferGeometry();
  // three shades a Lambert mesh flat, from screen derivatives, unless the geometry has a normal
  // attribute. The shader replaces the normal, so this one reads the same bytes and costs none.
  const buffer = new InterleavedBuffer(lattice, 3);
  geometry.setAttribute('aBlade', new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute('normal', new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setDrawRange(0, count * 3);

  const blades = new Mesh(
    geometry,
    look.lit({ side: DoubleSide }, { patch: blade(quality.hdr ? 1 : 1.6) }),
  );
  blades.receiveShadow = true;
  blades.castShadow = false;
  blades.frustumCulled = false;
  scene.add(blades);

  /* --------------------------------------------------------------- tracks */

  const target = new WebGLRenderTarget(quality.tracks, quality.tracks, { depthBuffer: false });
  const texel = WINDOW / quality.tracks;
  uniforms.uTracks.value = target.texture;
  uniforms.uTracksRect.value.set(0, 0, WINDOW, 0);

  const ribbonAttribute = new BufferAttribute(ribbon, 4).setUsage(DynamicDrawUsage);
  const ribbons = new BufferGeometry();
  ribbons.setAttribute('aRibbon', ribbonAttribute);
  const index: number[] = [];
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < POINTS - 1; i++) {
      const a = (w * POINTS + i) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  ribbons.setIndex(index);
  const marks = new Mesh(
    ribbons,
    new ShaderMaterial({
      uniforms: { uTracksRect: uniforms.uTracksRect },
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform vec4 uTracksRect;
        attribute vec4 aRibbon;
        varying float vAlpha;
        varying float vAcross;
        void main() {
          // Straight to clip space: the target is a top-down window on the world.
          vec2 ndc = ( aRibbon.xy - uTracksRect.xy ) / ( uTracksRect.z * 0.5 );
          vAcross = aRibbon.w;
          // Every mark fades out before the window's edge, so none is cut off.
          vAlpha = aRibbon.z * ( 1.0 - smoothstep( 0.7, 1.0, max( abs( ndc.x ), abs( ndc.y ) ) ) );
          gl_Position = vec4( ndc, 0.0, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vAcross;
        void main() {
          gl_FragColor = vec4( 1.0, 0.0, 0.0, vAlpha * ( 1.0 - abs( vAcross ) ) );
        }`,
    }),
  );
  marks.frustumCulled = false;
  const marksScene = new Scene();
  marksScene.add(marks);
  const marksCamera = new Camera();

  let fresh = true;
  ctx.events.on('respawn', () => {
    fresh = true;
  });

  function draw(): void {
    // Whole texels, or the tracks swim over the ground as the car moves.
    uniforms.uTracksRect.value.set(
      Math.round(car.position.x / texel) * texel,
      Math.round(car.position.z / texel) * texel,
      WINDOW,
      0,
    );
    let o = 0;
    for (const trail of trails) {
      for (let i = 0; i < POINTS; i++) {
        const before = Math.max(i - 1, 0);
        const after = Math.min(i + 1, POINTS - 1);
        let dx = trail.x[before] - trail.x[after];
        let dz = trail.z[before] - trail.z[after];
        const length = Math.sqrt(dx * dx + dz * dz) || 1;
        dx = (dx / length) * HALF;
        dz = (dz / length) * HALF;
        // Eases in behind the wheel, and fades out over the older half of the history.
        const u = i / (POINTS - 1);
        const alpha =
          trail.a[i] * Math.min(1, (i + 1) / 4) * (1 - Math.min(1, Math.max(0, 2 * u - 1)));
        ribbon[o++] = trail.x[i] - dz;
        ribbon[o++] = trail.z[i] + dx;
        ribbon[o++] = alpha;
        ribbon[o++] = -1;
        ribbon[o++] = trail.x[i] + dz;
        ribbon[o++] = trail.z[i] - dx;
        ribbon[o++] = alpha;
        ribbon[o++] = 1;
      }
    }
    ribbonAttribute.needsUpdate = true;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(marksScene, marksCamera);
    renderer.setRenderTarget(null);
  }

  // Compiled and uploaded here, before the warm-up, so nothing happens after Start.
  draw();

  let level = 0;

  return {
    update() {
      if (state.level !== level) {
        level = state.level;
        const kept = LADDER[Math.min(level, LADDER.length - 1)];
        geometry.setDrawRange(0, 3 * Math.floor(count * kept));
      }
      for (let w = 0; w < 4; w++) {
        const trail = trails[w];
        const wheel = car.wheels[w];
        const { x, z } = wheel.point;
        if (fresh) {
          trail.x.fill(x);
          trail.z.fill(z);
          trail.a.fill(0);
          trail.contact = false;
        }
        if (wheel.contact && !trail.contact) {
          // Landing: two points of zero alpha, so a jump is not joined to its landing by a streak.
          shift(trail);
          put(trail, x, z, 0);
          shift(trail);
        }
        trail.contact = wheel.contact;
        const dx = x - trail.x[1];
        const dz = z - trail.z[1];
        if (dx * dx + dz * dz > SPACING * SPACING) shift(trail);
        put(trail, x, z, wheel.contact ? 1 : 0);
      }
      fresh = false;
      draw();
    },
  };
};

export default grass;
