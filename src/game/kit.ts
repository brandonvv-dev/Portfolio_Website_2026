/**
 * What the test ground and the world both build from: the ramp, the three kinds of block, and the
 * brick wall section. The car is benched against these on the flat, so they are made here and
 * nowhere else, and what the bench measured is what the world gets.
 */
import {
  BoxGeometry,
  Color,
  Euler,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { BaseContext, Props, ShaderPatch } from './types';

/**
 * A ramp: a box tilted until its top face climbs from the ground, along the near edge of the
 * footprint, to `rise` above the far edge. The face meets the floor in a line, so a wheel rolls
 * on with no step to climb.
 *
 * The box is as thick as it takes to reach the ground under its far edge. That puts its middle at
 * ground level with the lower half buried, and what stands is a solid wedge with a steep back. A
 * thinner box is a plank in the air, and a car that drives in under its high end is squeezed
 * 29 cm into the ground.
 *
 * The footprint is centred on (x, z) and rises the way `yaw` faces. This adds the collider and
 * returns the same box in world space, for the caller to merge or to draw.
 *
 * ponytail: the back leans as far from upright as the ramp does from level. Driven into from
 * behind with the boost, the back of a 17 degree ramp is climbed until the car's recovery hop
 * puts it down again. A second, upright box under the high edge would stop that.
 */
export function wedge(
  ctx: BaseContext,
  x: number,
  z: number,
  width: number,
  run: number,
  rise: number,
  yaw: number,
): BufferGeometry {
  const length = Math.hypot(run, rise);
  const thickness = (rise * length) / run;
  // The top face is centred over the footprint. Half the thickness down its normal from there is
  // the middle of the box: at ground level, and this far past the middle of the footprint.
  const past = (rise * rise) / (2 * run);
  const centreX = x + past * Math.sin(yaw);
  const centreZ = z + past * Math.cos(yaw);
  const tilt = new Quaternion().setFromEuler(new Euler(-Math.atan2(rise, run), yaw, 0, 'YXZ'));
  ctx.physics.fixed(
    ctx.rapier.ColliderDesc.cuboid(width / 2, thickness / 2, length / 2)
      .setTranslation(centreX, 0, centreZ)
      .setRotation(tilt),
  );
  return new BoxGeometry(width, thickness, length)
    .applyQuaternion(tilt)
    .translate(centreX, 0, centreZ);
}

/**
 * Bricks and crates stand flush, and flush faces of one colour read as a single slab: the crate
 * cube was one block, and the wall had no bricks in it until the car went through. So each
 * instance takes a tone of its own, up to 12 % either side of its colour. Consecutive instances
 * are neighbours in a stack, and steps of the golden ratio land them far apart.
 */
const TONE: ShaderPatch = {
  key: 'kit:tone',
  vertexPars: 'varying float vKitTone;',
  position: 'vKitTone = fract( 0.618034 * float( gl_InstanceID ) );',
  fragmentPars: 'varying float vKitTone;',
  albedo: 'diffuseColor.rgb *= 0.88 + 0.24 * vKitTone;',
};

/** Kenney's kit scale: the sedan comes out 4 m long, and the cone 0.93 m tall. */
const KIT = 4 / 2.55;

/**
 * Defines the brick, the crate and the cone. The capacities are the caller's: the world stands
 * four times the cones the bench does.
 *
 * Bricks and crates are plain boxes. With no specular term a bevel has no highlight to catch, and
 * a rounded box is 300 triangles where this is 12.
 *
 * A prop's origin is the middle of its collider, so a cone stands on the ground at y = 0.4665
 * and a crate at y = 0.6.
 */
export async function defineBlocks(
  ctx: BaseContext,
  capacity: { brick: number; crate: number; cone: number },
): Promise<void> {
  const { rapier, props, look } = ctx;
  props.define('brick', {
    geometry: new BoxGeometry(1.6, 0.7, 0.8),
    material: look.lit({ color: '#c4543a' }, { patch: TONE }),
    collider: rapier.ColliderDesc.cuboid(0.8, 0.35, 0.4),
    capacity: capacity.brick,
  });
  props.define('crate', {
    geometry: new BoxGeometry(1.2, 1.2, 1.2),
    material: look.lit({ color: '#c89a5b' }, { patch: TONE }),
    collider: rapier.ColliderDesc.cuboid(0.6, 0.6, 0.6),
    capacity: capacity.crate,
  });

  const { scene } = await new GLTFLoader(ctx.loading).loadAsync('/models/cone.glb');
  // The file is one mesh. It cannot be asked for by name: the scene is called 'cone' as well, and
  // the loader renames whatever comes second.
  const [cone] = scene.children;
  if (!(cone instanceof Mesh) || !(cone.material instanceof MeshStandardMaterial)) {
    throw new Error('kit: /models/cone.glb is not one mesh with one material');
  }
  // instanceof leaves the type parameters of Mesh open: this gives the geometry its type back.
  const geometry: BufferGeometry = cone.geometry;
  props.define('cone', {
    // The model stands on its origin, and the collider is centred on its own.
    geometry: geometry.scale(KIT, KIT, KIT).translate(0, -0.4665, 0),
    // Kenney's atlas at 0.83: its brightest paint times the sun's 1.2 stays short of white.
    material: look.lit({ map: cone.material.map, color: new Color().setScalar(0.83) }),
    // 0.93 m tall and 0.37 m across the foot, with a top as blunt as the model's. A pointed cone
    // on its side is a wedge whose tip has no height: it slid in under the bumper, and now and
    // then lifted the car or turned it off its line.
    collider: rapier.ColliderDesc.roundCone(0.3665, 0.273, 0.1),
    capacity: capacity.cone,
    mass: 10,
    // A cone on its side rolls like a wheel, and little else slows a roll: at the engine's 0.1
    // it was still doing 10 m/s ten seconds after the car hit it, 60 m away. Much more than
    // this and the cones no longer roll clear: they ride the bumper and can pull the car off
    // its line.
    angularDamping: 2,
  });
}

/** Bricks in each row of a wall section, from the ground up. */
const ROWS = [3, 2, 3, 2, 3, 2, 2];

/**
 * One free-standing section of brick wall, centred on (x, z), its rows along the local x axis.
 * It is this narrow on purpose: three of them in a row fall to the last brick when the car goes
 * through, at every refresh rate, where one wall nine bricks wide kept its top rows up as a
 * lintel over the gap.
 */
export function brickStack(props: Props, x: number, z: number, yaw: number): void {
  const rowX = Math.cos(yaw);
  const rowZ = -Math.sin(yaw);
  ROWS.forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      const along = 1.6 * (i - (count - 1) / 2);
      props.add('brick', x + along * rowX, 0.35 + 0.7 * row, z + along * rowZ, yaw);
    }
  });
}
