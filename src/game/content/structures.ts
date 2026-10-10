/**
 * The static set pieces: the tunnel with its drivable roof, the maze, the skate park, the kicker
 * and the jump, and the three secret beacons. Cuboids only: every piece is a box mesh and the
 * same box in the physics world, so what you see is what you hit. The car was benched on cuboid
 * ramps and kerbs, never on a trimesh.
 */
import {
  BoxGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Mesh,
  OctahedronGeometry,
  Quaternion,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { wedge } from '../kit';
import { BEACONS, MAZE, RAMPS, SKATE, TUNNEL, type Box, type Pipe } from '../layout';
import type { GameContext, GameModule, ModuleFactory } from '../types';

const CONCRETE = '#b9bec8';
const HEDGE = '#5fae58';
const RAMP = '#3f4756';
const SKATE_CONCRETE = '#b9c2d6';

/** Half the thickness of a pipe slab: 0.6 m, twice the thinnest a boosting car cannot skip. */
const SLAB = 0.3;
/** Each slab runs this much past its share of the arc, so the seams never catch a wheel. */
const OVERLAP = 1.06;

/** Radians per second of each beacon: slow enough to read as a lookout, not a warning light. */
const SPIN = { rooftop: 1.4, maze: 1.1, skate: 1.6 };

const quaternion = new Quaternion();
const euler = new Euler();

/**
 * A curved take-off made of tilted slabs along an arc: a wedge throws the car at one angle at any
 * speed, a curve loads it progressively. The arc leaves the floor at (x, z) and rises the way
 * `yaw` faces; each slab's top face is the tangent at the middle of its share of the arc.
 */
function quarterPipe(ctx: GameContext, pipe: Pipe): BufferGeometry[] {
  const [x, z, radius, sweep, width, segments, yaw] = pipe;
  const step = sweep / segments;
  const length = radius * step * OVERLAP;
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const slabs: BufferGeometry[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i + 0.5) * step;
    // The middle of the slab is the arc point, sunk half a thickness down the surface normal.
    const along = (radius + SLAB) * Math.sin(t);
    const y = radius - (radius + SLAB) * Math.cos(t);
    const centreX = x + forwardX * along;
    const centreZ = z + forwardZ * along;
    quaternion.setFromEuler(euler.set(-t, yaw, 0, 'YXZ'));
    ctx.physics.fixed(
      ctx.rapier.ColliderDesc.cuboid(width / 2, SLAB, length / 2)
        .setTranslation(centreX, y, centreZ)
        .setRotation(quaternion),
    );
    slabs.push(
      new BoxGeometry(width, SLAB * 2, length)
        .applyQuaternion(quaternion)
        .translate(centreX, y, centreZ),
    );
  }
  return slabs;
}

/** Paints a whole geometry one colour, so differently coloured pieces can share one mesh. */
function tint(geometries: BufferGeometry[], hex: string): BufferGeometry[] {
  const { r, g, b } = new Color(hex);
  for (const geometry of geometries) {
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colours.set([r, g, b], i * 3);
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  }
  return geometries;
}

const createStructures: ModuleFactory = (ctx): GameModule => {
  const { rapier, physics, scene, look } = ctx;

  /** A fixed box: its collider, and the same box in place for the mesh. */
  const block = ([x, y, z, sizeX, sizeY, sizeZ]: Box): BufferGeometry => {
    physics.fixed(
      rapier.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2).setTranslation(x, y, z),
    );
    return new BoxGeometry(sizeX, sizeY, sizeZ).translate(x, y, z);
  };

  const solid = (geometries: BufferGeometry[], cutout: boolean): void => {
    const mesh = new Mesh(
      mergeGeometries(geometries),
      look.lit({ vertexColors: true }, { cutout }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  };

  // The roof, the deck and the pillars are what could hide the car from the camera, so they are
  // the ones that open round it. The north wall is up-screen of everything under the roof.
  solid(
    tint([block(TUNNEL.roof), block(TUNNEL.deck), ...TUNNEL.pillars.map(block)], CONCRETE),
    true,
  );
  solid(
    [
      ...tint([block(TUNNEL.wall)], CONCRETE),
      ...tint(
        MAZE.walls.map(([x, z, sizeX, sizeZ]) =>
          block([x, MAZE.height / 2, z, sizeX, MAZE.height, sizeZ]),
        ),
        HEDGE,
      ),
      ...tint(
        SKATE.flatMap((pipe) => quarterPipe(ctx, pipe)),
        SKATE_CONCRETE,
      ),
      ...tint(
        [TUNNEL.ramp, RAMPS.kicker, RAMPS.jump].map((ramp) => wedge(ctx, ...ramp)),
        RAMP,
      ),
    ],
    false,
  );

  // The only things here that move. One material, so the three glow alike.
  const glow = look.glow('#ffb054', 3);
  const beacons = (
    [
      ['rooftop', new TorusGeometry(1.6, 0.36, 10, 26)],
      ['maze', new OctahedronGeometry(1.5)],
      ['skate', new IcosahedronGeometry(1.4)],
    ] as const
  ).map(([id, geometry]) => {
    const mesh = new Mesh(geometry, glow);
    mesh.position.set(...BEACONS[id]);
    scene.add(mesh);
    return { mesh, speed: SPIN[id] };
  });

  return {
    update() {
      for (const { mesh, speed } of beacons) mesh.rotation.y = ctx.state.time * speed;
    },
  };
};

export default createStructures;
