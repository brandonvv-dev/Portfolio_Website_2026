/**
 * The flat bench the car is tuned and gated on: one fixture per test on a bare plane, each far
 * enough from the next that no run meets another's. No content module loads with it, so its
 * numbers stay put while the world fills up, and no visitor downloads it: main.ts imports this
 * file only under ?ground=test with debug on.
 */
import {
  BoxGeometry,
  DataTexture,
  Mesh,
  PlaneGeometry,
  RingGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brickStack, defineBlocks, wedge } from './kit';
import { TEST_GROUND, type Box } from './layout';
import type { GroundFactory } from './types';

/** Metres across the visible plane. The collider under it has no edge. */
const SIZE = 1200;

const createTestGround: GroundFactory = async (ctx) => {
  const { rapier, physics, props, scene, look } = ctx;

  physics.fixed(new rapier.ColliderDesc(new rapier.HalfSpace({ x: 0, y: 1, z: 0 })));
  // Two greens in 10 m squares: on a plane with nothing else on it, the only thing that shows
  // speed and drift.
  const ground = new Mesh(
    new PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2),
    look.lit(
      { color: '#86cf62' },
      {
        patch: {
          key: 'testground:checker',
          albedo: /* glsl */ `
            diffuseColor.rgb *=
              1.0 - 0.1 * mod( floor( vDrive.x / 10.0 ) + floor( vDrive.z / 10.0 ), 2.0 );
          `,
        },
      },
    ),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  /** A fixed box: its collider, and the same box in place for the mesh. */
  const block = ([x, y, z, sizeX, sizeY, sizeZ]: Box): BufferGeometry => {
    physics.fixed(
      rapier.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2).setTranslation(x, y, z),
    );
    return new BoxGeometry(sizeX, sizeY, sizeZ).translate(x, y, z);
  };

  /** Everything of one material as one mesh, as the world's structures are drawn. */
  const solid = (geometries: BufferGeometry[], material: Material) => {
    const mesh = new Mesh(mergeGeometries(geometries), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  };

  const { ramp10, ramp17, roofRamp, kerb, roof, posts } = TEST_GROUND;
  solid(
    [wedge(ctx, ...ramp10), wedge(ctx, ...ramp17), wedge(ctx, ...roofRamp), block(kerb)],
    look.lit({ color: '#3f4756' }),
  );
  // The roof opens round a car underneath it and stays whole under a car on top, as the
  // tunnel's will.
  solid([block(roof), ...posts.map(block)], look.lit({ color: '#b9bec8' }, { cutout: true }));

  await defineBlocks(ctx, { brick: 51, crate: 27, cone: 12 });
  for (const [x, z] of TEST_GROUND.walls) brickStack(props, x, z, 0);
  // A prop is placed by its middle: half a crate above the ground, and half a cone.
  const [crateX, crateZ] = TEST_GROUND.crates;
  for (const level of [0, 1, 2]) {
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        props.add('crate', crateX + 1.2 * i, 0.6 + 1.2 * level, crateZ + 1.2 * j, 0);
      }
    }
  }
  for (const [x, z] of TEST_GROUND.cones) props.add('cone', x, 0.4665, z, 0);

  for (const pad of ctx.places.pads) {
    const ring = new Mesh(
      new RingGeometry(pad.radius - 0.3, pad.radius, 64).rotateX(-Math.PI / 2),
      look.glow(pad.accent, 2.2),
    );
    ring.position.set(pad.x, 0.02, pad.z);
    scene.add(ring);
  }

  // The colour card: unlit, so each square should reach the screen as the very colour it was
  // given. If one does not, something between the material and the canvas is shifting colours.
  const square = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  for (const [colour, x, z] of TEST_GROUND.card) {
    const swatch = new Mesh(square, look.unlit({ color: colour }));
    swatch.position.set(x, 0.02, z);
    scene.add(swatch);
  }

  // One texel says it all: paved and flat everywhere, and no grass. The heights keep the look's
  // own stand-in pixel, which reads as 0 m.
  const masks = new DataTexture(new Uint8Array([255, 0, 255, 255]), 1, 1);
  masks.needsUpdate = true;
  look.uniforms.uMasks.value = masks;
  look.uniforms.uWorld.value = SIZE;

  return {
    heightAt: () => 0,
    mask: (_x, _z, channel) => (channel === 1 ? 0 : 1),
  };
};

export default createTestGround;
