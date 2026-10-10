/**
 * The ground: one mesh over the whole world, shaped and coloured by the painted map, and the
 * heightfield the car drives on, built from the very same heights. What is seen is what is hit.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  SRGBColorSpace,
} from 'three';
import { FOOTPRINTS, ROADS } from './layout';
import { CELLS, MAP, ROW, SIZE, TARMAC, paintMap } from './map';
import type { GroundFactory, ShaderPatch, Terrain } from './types';
import { mulberry32 } from './util';

/** A palette colour as GLSL, in the linear light the shader works in. */
const glsl = (hex: string): string => `vec3( ${new Color(hex).toArray().join(', ')} )`;

/**
 * The albedo of the ground, as three thresholds on the painted masks. Outside the paved outline
 * lies grass, lightened where the wheels went; the band just outside the outline is the pale
 * line that edges every road, plaza and pad; inside it lies tarmac where the tarmac mask says
 * so and the painted texture everywhere else.
 *
 * Each threshold is one screen pixel wide whatever the distance, so an edge is as sharp as the
 * screen and does not crawl. The texture is left with what it can do at a pixel every 31 cm:
 * the colour of an area.
 *
 * Nothing is one flat colour. A tone 5 m across runs under everything, and a finer one over it:
 * mottle 1.4 m across on the grass, a speckle of 14 cm on the paint. It is one noise read at a
 * scale the paved threshold picks, because this shader fills the screen on every phone.
 *
 * The lattice hash has no sine in it: phones differ in how they round one.
 */
const GROUND: ShaderPatch = {
  key: 'terrain:ground',
  fragmentPars: /* glsl */ `
float terrainHash( vec2 cell ) {
  vec3 p = fract( cell.xyx * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
float terrainNoise( vec2 point ) {
  vec2 cell = floor( point );
  vec2 t = smoothstep( 0.0, 1.0, point - cell );
  return mix(
    mix( terrainHash( cell ), terrainHash( cell + vec2( 1.0, 0.0 ) ), t.x ),
    mix( terrainHash( cell + vec2( 0.0, 1.0 ) ), terrainHash( cell + 1.0 ), t.x ),
    t.y
  );
}
float terrainOver( float mask, float level ) {
  return saturate( ( mask - level ) / max( fwidth( mask ), 0.0001 ) + 0.5 );
}
`,
  albedo: /* glsl */ `
vec4 terrainMask = texture2D( uMasks, vDrive.xz / uWorld + 0.5 );
float terrainPaved = terrainOver( terrainMask.r, 0.5 );
float terrainTone = mix(
  terrainNoise( vDrive.xz * 0.2 ),
  terrainNoise( vDrive.xz * mix( 0.71, 7.0, terrainPaved ) ),
  0.4
);
float terrainTrack =
  texture2D( uTracks, ( vDrive.xz - uTracksRect.xy ) / uTracksRect.z + 0.5 ).r;
vec3 terrainGrass = ${glsl('#86cf62')} * ( 0.94 + 0.12 * terrainTone );
terrainGrass = mix( terrainGrass, ${glsl('#b9dc7a')}, terrainTrack * terrainMask.g );
vec3 terrainPaint = mix( diffuseColor.rgb, ${glsl(TARMAC)}, terrainOver( terrainMask.a, 0.5 ) );
terrainPaint *= 0.96 + 0.08 * terrainTone;
diffuseColor.rgb = mix(
  mix( terrainGrass, ${glsl('#e9e6df')}, terrainOver( terrainMask.r, 0.35 ) ),
  terrainPaint,
  terrainPaved
);
`,
};

/** Tiles per side; 32 cells each, which a camera footprint of 40 m touches four to nine of. */
const TILES = 8;

export const createTerrain: GroundFactory = async (ctx) => {
  const { masks, albedo, heights } = paintMap();
  // The painting and the meshing are each a long task on a phone. A frame between them makes
  // them two, so the loading screen is not held for both together.
  await new Promise(requestAnimationFrame);

  // Rapier does not throw on a wrong length: the wasm module panics, and the world is dead.
  if (heights.length !== ROW * ROW) throw new Error('terrain: the height grid has the wrong size');

  const { uniforms } = ctx.look;
  // Bytes straight to the GPU: through a canvas the browser would premultiply them.
  const maskMap = new DataTexture(masks, MAP, MAP);
  maskMap.magFilter = LinearFilter;
  maskMap.minFilter = LinearMipmapLinearFilter;
  maskMap.generateMipmaps = true;
  maskMap.anisotropy = ctx.quality.anisotropy;
  maskMap.needsUpdate = true;
  uniforms.uMasks.value = maskMap;
  // One texel for every vertex. Half floats filter in plain WebGL2; full floats need an extension.
  const heightMap = new DataTexture(
    Uint16Array.from(heights, DataUtils.toHalfFloat),
    ROW,
    ROW,
    RedFormat,
    HalfFloatType,
  );
  heightMap.magFilter = heightMap.minFilter = LinearFilter;
  heightMap.needsUpdate = true;
  uniforms.uHeights.value = heightMap;
  uniforms.uWorld.value = SIZE;

  // One plane of 131k triangles has one bounding sphere the size of the world, so nothing of it
  // is ever culled. Cut into tiles, the camera's 40 m keeps a handful. Vertices and normals are
  // read from the whole plane so the seams stay invisible.
  const whole = new PlaneGeometry(SIZE, SIZE, CELLS, CELLS).rotateX(-Math.PI / 2);
  const wholePosition = whole.getAttribute('position');
  for (let i = 0; i < heights.length; i++) wholePosition.setY(i, heights[i]);
  whole.computeVertexNormals();
  const wholeNormal = whole.getAttribute('normal');
  const wholeUv = whole.getAttribute('uv');
  const span = CELLS / TILES;
  const side = span + 1;
  const indices: number[] = [];
  // The same two triangles per cell as PlaneGeometry, so the mesh keeps heightAt's diagonal.
  for (let z = 0; z < span; z++) {
    for (let x = 0; x < span; x++) {
      const a = z * side + x;
      const b = a + side;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const material = ctx.look.lit({ map: new CanvasTexture(albedo) }, { patch: GROUND });
  const map = material.map;
  if (map) {
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = ctx.quality.anisotropy;
  }
  for (let tz = 0; tz < TILES; tz++) {
    for (let tx = 0; tx < TILES; tx++) {
      const geometry = new BufferGeometry();
      const position = new Float32Array(side * side * 3);
      const normal = new Float32Array(side * side * 3);
      const uv = new Float32Array(side * side * 2);
      for (let z = 0; z < side; z++) {
        for (let x = 0; x < side; x++) {
          const from = (tz * span + z) * ROW + tx * span + x;
          const to = z * side + x;
          position.set([wholePosition.getX(from), wholePosition.getY(from), wholePosition.getZ(from)], to * 3);
          normal.set([wholeNormal.getX(from), wholeNormal.getY(from), wholeNormal.getZ(from)], to * 3);
          uv.set([wholeUv.getX(from), wholeUv.getY(from)], to * 2);
        }
      }
      geometry.setAttribute('position', new BufferAttribute(position, 3));
      geometry.setAttribute('normal', new BufferAttribute(normal, 3));
      geometry.setAttribute('uv', new BufferAttribute(uv, 2));
      geometry.setIndex(indices);
      const tile = new Mesh(geometry, material);
      tile.receiveShadow = true;
      tile.matrixAutoUpdate = false;
      ctx.scene.add(tile);
    }
  }
  whole.dispose();

  // Rapier wants the grid column by column, and splits each cell along the same diagonal as
  // PlaneGeometry does.
  const columns = new Float32Array(ROW * ROW);
  for (let iz = 0; iz < ROW; iz++) {
    for (let ix = 0; ix < ROW; ix++) columns[ix * ROW + iz] = heights[iz * ROW + ix];
  }
  const { ColliderDesc, HeightFieldFlags } = ctx.rapier;
  const collider = ctx.physics.fixed(
    ColliderDesc.heightfield(
      CELLS,
      CELLS,
      columns,
      { x: SIZE, y: 1, z: SIZE },
      // Without it a wheel or a brick catches on the edges between flat cells.
      HeightFieldFlags.FIX_INTERNAL_EDGES,
    ),
  );
  // Four walls nobody sees, just inside the edge and far taller than the bank they stand in.
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.physics.fixed(
      ColliderDesc.cuboid(x ? 1 : SIZE / 2, 20, z ? 1 : SIZE / 2).setTranslation(
        x * (SIZE / 2 - 1),
        20,
        z * (SIZE / 2 - 1),
      ),
    );
  }

  const terrain: Terrain = {
    heightAt(x, z) {
      const fx = Math.min(Math.max((x / SIZE + 0.5) * CELLS, 0), CELLS);
      const fz = Math.min(Math.max((z / SIZE + 0.5) * CELLS, 0), CELLS);
      const ix = Math.min(Math.floor(fx), CELLS - 1);
      const iz = Math.min(Math.floor(fz), CELLS - 1);
      const tx = fx - ix;
      const tz = fz - iz;
      const i = iz * ROW + ix;
      // The cell's two triangles meet along the diagonal from (ix, iz + 1) to (ix + 1, iz).
      // Blending all four corners instead is up to 4 cm off the mesh on the hills.
      if (tx + tz < 1) {
        const corner = heights[i];
        return corner + (heights[i + 1] - corner) * tx + (heights[i + ROW] - corner) * tz;
      }
      const corner = heights[i + ROW + 1];
      return (
        corner + (heights[i + ROW] - corner) * (1 - tx) + (heights[i + 1] - corner) * (1 - tz)
      );
    },
    mask(x, z, channel) {
      // Pixel centres sit half a pixel in from the pixel's corner.
      const fx = Math.min(Math.max((x / SIZE + 0.5) * MAP - 0.5, 0), MAP - 1);
      const fz = Math.min(Math.max((z / SIZE + 0.5) * MAP - 0.5, 0), MAP - 1);
      const ix = Math.min(Math.floor(fx), MAP - 2);
      const iz = Math.min(Math.floor(fz), MAP - 2);
      const tx = fx - ix;
      const i = (iz * MAP + ix) * 4 + channel;
      const j = i + MAP * 4;
      const north = masks[i] + (masks[i + 4] - masks[i]) * tx;
      const south = masks[j] + (masks[j + 4] - masks[j]) * tx;
      return (north + (south - north) * (fz - iz)) / 255;
    },
  };

  if (import.meta.env.DEV) {
    // Everything authored stands at y = 0: no hill may reach a road, a pad or a solid.
    const authored = [
      ...ROADS.flatMap((road) => road.points),
      ...ctx.places.pads.map((pad) => [pad.x, pad.z]),
      ...FOOTPRINTS.flatMap(([x, z, width, depth, yaw]) =>
        [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [
          x + (a * width * Math.cos(yaw) + b * depth * Math.sin(yaw)) / 2,
          z + (b * depth * Math.cos(yaw) - a * width * Math.sin(yaw)) / 2,
        ]),
      ),
    ];
    const hilly = authored.filter(([x, z]) => terrain.mask(x, z, 2) < 0.99);
    if (hilly.length) console.error('terrain: the ground is not flat at', hilly);

    // And the collider is the surface heightAt describes. The ray is cast at the collider and
    // not through the world, whose own rays see nothing until its first step.
    const random = mulberry32(1);
    const ray = new ctx.rapier.Ray({ x: 0, y: 64, z: 0 }, { x: 0, y: -1, z: 0 });
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      ray.origin.x = (random() - 0.5) * (SIZE - 1);
      ray.origin.z = (random() - 0.5) * (SIZE - 1);
      // A miss comes back as -1, which is as wrong as a hit can be.
      const hit = 64 - collider.castRay(ray, 128, true);
      worst = Math.max(worst, Math.abs(hit - terrain.heightAt(ray.origin.x, ray.origin.z)));
    }
    if (worst > 0.005) console.error(`terrain: the collider is ${worst} m off heightAt`);
  }

  return terrain;
};
