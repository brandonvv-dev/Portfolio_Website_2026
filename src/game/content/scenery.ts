/**
 * Trees, rocks, stumps, logs and bushes from the Kenney nature kit, placed by the painted masks so
 * that none of them stands on anything authored or hides it from the camera. Everything is built
 * once: nothing here runs per frame, the sway is in the shader.
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util';
import type { GameContext, ModuleFactory, ShaderPatch } from '../types';

const TREES = ['tree_default', 'tree_oak', 'tree_cone', 'tree_pineRoundA'];
// Repeats weight the pick: small things are the most common at the foot of a grove.
const FEET = [
  'rock_largeA',
  'rock_largeB',
  'rock_smallA',
  'rock_smallB',
  'stump_round',
  'log_stack',
  'plant_bush',
  'plant_bushLarge',
  'plant_bush',
  'plant_bushLarge',
];

/** Kenney's kit scale for everything here. */
const SCALE = 4.5;
const GROVES = 24;
const RIM_TREES = 160;

/**
 * The kit's leaves are teal (blue 0.67 of green 0.79): a multiplier cannot warm them without
 * crushing red too. Foliage therefore takes this hue and keeps only the kit's own light or dark.
 */
const FOLIAGE = new Color('#6fb74a');
const LEAF_LIGHT = 0.454; // luminance of leafsGreen once converted: the kit's mid foliage
const ROCK = new Color('#b4aca0');
/** The brightest linear channel a lit albedo may have, so albedo x 1.2 never clips. */
const CEILING = 0.83;

/**
 * Canopies lean with the wind, more the higher the vertex, out of step from tree to tree by their
 * root. The offset is built in the world and brought back into the instance's own frame, so the
 * crown moves 0.17 to 0.23 m whichever way the tree faces.
 */
const SWAY: ShaderPatch = {
  key: 'scenery:sway',
  position: /* glsl */ `
    vec3 sceneryRoot = instanceMatrix[3].xyz;
    float scenerySway = sin( uTime * 1.7 + sceneryRoot.x * 0.35 + sceneryRoot.z * 0.27 )
      * 0.03 * max( transformed.y, 0.0 );
    mat3 sceneryBasis = mat3( instanceMatrix );
    transformed += scenerySway * ( transpose( sceneryBasis ) * vec3( uWind.x, 0.0, uWind.y ) )
      / length( sceneryBasis[0] );
  `,
};

interface Part {
  geometry: BufferGeometry;
  color: Color;
  leaf: boolean;
}

interface Model {
  parts: Part[];
  height: number;
}

interface Spot {
  model: string;
  x: number;
  z: number;
  scale: number;
  yaw: number;
}

const matrix = new Matrix4();
const quaternion = new Quaternion();
const position = new Vector3();
const scale = new Vector3();
const UP = new Vector3(0, 1, 0);

const createScenery: ModuleFactory = async (ctx: GameContext) => {
  const { terrain, look, rapier, physics, scene } = ctx;
  const loader = new GLTFLoader(ctx.loading);
  const names = [...TREES, ...new Set(FEET)];
  const models = new Map<string, Model>();

  await Promise.all(
    names.map(async (name) => {
      const gltf = await loader.loadAsync(`/models/props/${name}.glb`);
      const parts: Part[] = [];
      let height = 0;
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const source = object.material;
        if (!(source instanceof MeshStandardMaterial)) {
          throw new Error(`scenery: ${name} has an unexpected material`);
        }
        // A copy, converted once: the source material is never touched again.
        const color = source.color.clone().convertSRGBToLinear();
        const leaf = /^leafs/.test(source.name);
        if (leaf || source.name === 'grass') {
          color.copy(FOLIAGE).multiplyScalar(
            (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / LEAF_LIGHT,
          );
        } else if (source.name === 'dirt') color.copy(ROCK);
        color.multiplyScalar(Math.min(1, CEILING / Math.max(color.r, color.g, color.b)));
        object.geometry.computeBoundingBox();
        height = Math.max(height, object.geometry.boundingBox?.max.y ?? 0);
        parts.push({ geometry: object.geometry, color, leaf });
      });
      models.set(name, { parts, height });
    }),
  );
  const model = (name: string): Model => {
    const found = models.get(name);
    if (!found) throw new Error(`scenery: ${name} did not load`);
    return found;
  };

  const rng = mulberry32(0x5eed);
  const between = (a: number, b: number) => a + rng() * (b - a);

  /** Off everything authored, and not in front of anything the camera must see (R3). */
  const fits = (x: number, z: number, height: number) => {
    if (terrain.mask(x, z, 2) > 0.5) return false;
    for (let q = 2; q <= 1.47 * height; q += 2) {
      if (terrain.mask(x - 0.707 * q, z - 0.707 * q, 1) < 0.7) return false;
    }
    return true;
  };

  const trees: Spot[] = [];
  const feet: Spot[] = [];

  const grove = (cx: number, cz: number, radius: number, pool: readonly string[], into: Spot[]) => {
    for (let tries = 0; tries < 10; tries++) {
      const angle = between(0, Math.PI * 2);
      const reach = Math.sqrt(rng()) * radius;
      const x = cx + Math.cos(angle) * reach;
      const z = cz + Math.sin(angle) * reach;
      const name = pool[Math.floor(rng() * pool.length)];
      const spot = {
        model: name,
        x,
        z,
        scale: SCALE * between(0.85, 1.15),
        yaw: between(0, Math.PI * 2),
      };
      if (Math.abs(x) < 128 && Math.abs(z) < 128 && fits(x, z, model(name).height * spot.scale)) {
        into.push(spot);
        return;
      }
    }
  };

  for (let g = 0; g < GROVES; g++) {
    let cx = 0;
    let cz = 0;
    for (let tries = 0; tries < 100; tries++) {
      cx = between(-128, 128);
      cz = between(-128, 128);
      if (terrain.mask(cx, cz, 2) <= 0.5) break;
    }
    const count = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) grove(cx, cz, 6, TREES, trees);
    const extras = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < extras; i++) grove(cx, cz, 7, FEET, feet);
  }

  // The forest rim: a square ring, so the corners are as thick as the sides.
  for (let i = 0; i < RIM_TREES; i++) {
    for (let tries = 0; tries < 10; tries++) {
      const r = between(134, 156);
      const t = between(-r, r);
      const side = Math.floor(rng() * 4);
      const x = side < 2 ? (side ? r : -r) : t;
      const z = side < 2 ? t : side === 2 ? r : -r;
      const name = TREES[Math.floor(rng() * TREES.length)];
      const s = SCALE * between(0.85, 1.15);
      if (fits(x, z, model(name).height * s)) {
        trees.push({ model: name, x, z, scale: s, yaw: between(0, Math.PI * 2) });
        break;
      }
    }
  }

  const place = (spot: Spot) => {
    position.set(spot.x, terrain.heightAt(spot.x, spot.z), spot.z);
    quaternion.setFromAxisAngle(UP, spot.yaw);
    return matrix.compose(position, quaternion, scale.setScalar(spot.scale));
  };

  /* ------------------------------------------------------------ trees */

  for (const name of TREES) {
    const spots = trees.filter((t) => t.model === name);
    if (!spots.length) continue;
    const { parts, height } = model(name);
    for (const { geometry, color, leaf } of parts) {
      const material = leaf
        ? look.lit({ color }, { patch: SWAY, cutout: true })
        : look.lit({ color });
      const mesh = new InstancedMesh(geometry, material, spots.length);
      spots.forEach((spot, i) => mesh.setMatrixAt(i, place(spot)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
    }
    for (const spot of spots) {
      const half = (height * spot.scale) / 2;
      const y = terrain.heightAt(spot.x, spot.z);
      physics.fixed(
        rapier.ColliderDesc.cylinder(half, 0.13 * spot.scale).setTranslation(
          spot.x,
          y + half,
          spot.z,
        ),
      );
    }
  }

  /* ---------------------------------------- rocks, stumps, logs, bushes */

  const baked: BufferGeometry[] = [];
  for (const spot of feet) {
    const m = place(spot);
    for (const { geometry, color } of model(spot.model).parts) {
      const piece = geometry.clone();
      piece.deleteAttribute('uv');
      const colors: number[] = [];
      for (let i = 0; i < piece.getAttribute('position').count; i++) {
        colors.push(color.r, color.g, color.b);
      }
      piece.setAttribute('color', new Float32BufferAttribute(colors, 3));
      baked.push(piece.applyMatrix4(m));
    }
    if (spot.model.startsWith('rock_large')) {
      const k = spot.scale / SCALE;
      const y = terrain.heightAt(spot.x, spot.z) + 0.6 * k;
      physics.fixed(
        rapier.ColliderDesc.cuboid(1.45 * k, 0.6 * k, 1.9 * k)
          .setTranslation(spot.x, y, spot.z)
          .setRotation(quaternion.setFromAxisAngle(UP, spot.yaw)),
      );
    }
  }
  if (baked.length) {
    const merged = mergeGeometries(baked);
    if (!merged) throw new Error('scenery: the rocks and bushes do not share their attributes');
    const mesh = new Mesh(merged, look.lit({ vertexColors: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }

  return {};
};

export default createScenery;
