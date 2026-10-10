/**
 * Every knockable thing: the brick wall, cones, bowling, crates, dominoes, the letters and the
 * tech stack, plus the two toys that hang on joints, the seesaw and the wrecking ball. All of it
 * stands where layout.ts says, authored at rest under gravity; the loading settle records the
 * homes the props are rebuilt to.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  Vector4,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { brickStack, defineBlocks } from '../kit';
import { CONES, CRATES, LETTERS, STACK, STACKS, TOYS, WALL } from '../layout';
import { FACE, GROUPS, type ModuleFactory } from '../types';

/* ------------------------------------------------------------------ atlas */

const CELL = 256;
const COLUMNS = 8;
const ROWS = 4;
/** Texels kept clear round a cell, so a mip level never mixes in the next block's colour. */
const PAD = 4;

/** Faces of the 1.9 x 2.8 letters are 1.47 times taller than the square cell they show. */
const TALL = 1.9 / 2.8;

/** Dark ink on light blocks, light on dark: the label has to survive either. */
function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0b0d10' : '#ffffff';
}

/** A block with its label on the four upright faces, and its top and bottom on one flat texel. */
function labelBox(width: number, height: number, depth: number): BufferGeometry {
  const box = new BoxGeometry(width, height, depth);
  const uv = box.getAttribute('uv');
  // Faces are four vertices each, in the order +x -x +y -y +z -z. A face whose four corners
  // share one point has no derivative, so it reads mip 0 of the cell's plain corner.
  for (let i = 8; i < 16; i++) uv.setXY(i, 0.01, 0.01);
  return box;
}

/** Flat vertex colour, linear, for geometry that is merged from several colours. */
function paint(geometry: BufferGeometry, hex: string): BufferGeometry {
  const colour = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const values = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colour.toArray(values, i * 3);
  return geometry.setAttribute('color', new BufferAttribute(values, 3));
}

const playground: ModuleFactory = async (ctx) => {
  const { rapier, props, look, physics, scene, events, state, world, car } = ctx;
  await defineBlocks(ctx, { brick: 51, crate: 37, cone: 52 });

  /* ------------------------------------------------------------- the kinds */

  props.define('domino', {
    geometry: new BoxGeometry(1.5, 2.6, 0.3),
    material: look.lit({ color: '#e0e2e7' }),
    collider: rapier.ColliderDesc.cuboid(0.75, 1.3, 0.15),
    capacity: 20,
  });

  // An off-white skittle with a red band: two cylinders, the band a hair wider than the body.
  props.define('pin', {
    geometry: mergeGeometries([
      paint(new CylinderGeometry(0.24, 0.38, 1.5, 16), '#e9e4d8'),
      paint(new CylinderGeometry(0.278, 0.301, 0.25, 16).translate(0, 0.325, 0), '#c4392f'),
    ]),
    material: look.lit({ vertexColors: true }),
    collider: rapier.ColliderDesc.cylinder(0.75, 0.38),
    capacity: 10,
    mass: 10,
  });
  props.define('ball', {
    geometry: new SphereGeometry(1.1, 24, 16),
    material: look.lit({ color: '#2b2f3a' }),
    collider: rapier.ColliderDesc.ball(1.1),
    capacity: 1,
    angularDamping: 0.4,
  });

  // One atlas labels the letters and the stack: the 20 stack names first, then each distinct
  // letter in its colour.
  const cells: { text: string; colour: string; tall: boolean }[] = STACK.map(([text, colour]) => ({
    text,
    colour,
    tall: false,
  }));
  const letterCell = new Map<string, number>();
  for (const [char, colour] of LETTERS) {
    if (letterCell.has(char + colour)) continue;
    letterCell.set(char + colour, cells.length);
    cells.push({ text: char, colour, tall: true });
  }

  const canvas = document.createElement('canvas');
  canvas.width = CELL * COLUMNS;
  canvas.height = CELL * ROWS;
  const pen = canvas.getContext('2d');
  if (!pen) throw new Error('playground: no 2d canvas');
  cells.forEach(({ text, colour, tall }, i) => {
    pen.save();
    pen.translate((i % COLUMNS) * CELL, Math.floor(i / COLUMNS) * CELL);
    pen.fillStyle = colour;
    pen.fillRect(0, 0, CELL, CELL);
    const ink = inkFor(colour);
    pen.strokeStyle = ink;
    pen.globalAlpha = 0.25;
    pen.lineWidth = 5;
    pen.strokeRect(13, 13, CELL - 26, CELL - 26);
    pen.globalAlpha = 1;
    pen.fillStyle = ink;
    pen.textAlign = 'center';
    pen.textBaseline = 'middle';
    pen.translate(CELL / 2, CELL / 2);
    if (tall) pen.scale(1, TALL);
    const size = tall ? 300 : text.length > 8 ? 37 : text.length > 4 ? 50 : 74;
    pen.font = `800 ${size}px Inter, system-ui, sans-serif`;
    pen.fillText(text, 0, 0, CELL - 26);
    pen.restore();
  });
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = ctx.quality.anisotropy;

  // Sun on a face at 1.2 and the 0.4 of self-light add up to the atlas colour; a face in the
  // violet form shadow keeps the self-light, so JavaScript yellow stays yellow.
  const labelled = look.lit(
    {
      map,
      emissiveMap: map,
      color: new Color().setScalar(0.5),
      emissive: new Color().setScalar(0.4),
    },
    { atlas: true },
  );
  props.define('letter', {
    geometry: labelBox(1.9, 2.8, 1),
    material: labelled,
    collider: rapier.ColliderDesc.cuboid(0.95, 1.4, 0.5),
    capacity: LETTERS.length,
    atlas: true,
  });
  props.define('stack', {
    geometry: labelBox(1.5, 1.5, 1.5),
    material: labelled,
    collider: rapier.ColliderDesc.cuboid(0.75, 0.75, 0.75),
    capacity: STACK.length,
    atlas: true,
  });

  const cellUv = new Vector4();
  const uvOf = (i: number) =>
    cellUv.set(
      ((i % COLUMNS) * CELL + PAD) / canvas.width,
      1 - ((Math.floor(i / COLUMNS) + 1) * CELL - PAD) / canvas.height,
      (CELL - 2 * PAD) / canvas.width,
      (CELL - 2 * PAD) / canvas.height,
    );

  /* ------------------------------------------------------------- placement */

  WALL.forEach(([x, z]) => brickStack(props, x, z, FACE));
  CONES.forEach(([x, z]) => props.add('cone', x, 0.4665, z, 0));
  LETTERS.forEach(([char, colour, x, z]) =>
    props.add('letter', x, 1.4, z, FACE, uvOf(letterCell.get(char + colour) ?? 0)),
  );

  /** A 4-3-2-1 pyramid of cubes `size` metres wide, its bottom row centred on (x, z). */
  const pyramid = (
    size: number,
    x: number,
    z: number,
    alongZ: boolean,
    place: (x: number, y: number, z: number) => void,
  ) => {
    for (let row = 0; row < 4; row++) {
      const n = 4 - row;
      for (let i = 0; i < n; i++) {
        const along = size * (i - (n - 1) / 2);
        place(alongZ ? x : x + along, size * (row + 0.5), alongZ ? z + along : z);
      }
    }
  };

  let block = 0;
  for (const [x, z] of STACKS) {
    pyramid(1.5, x, z, false, (px, py, pz) => props.add('stack', px, py, pz, 0, uvOf(block++)));
  }
  pyramid(1.2, CRATES.pyramid[0], CRATES.pyramid[1], true, (x, y, z) =>
    props.add('crate', x, y, z, 0),
  );
  for (let ix = -1; ix <= 1; ix++)
    for (let iz = -1; iz <= 1; iz++)
      for (let k = 0; k < 3; k++)
        props.add('crate', CRATES.cube[0] + 1.2 * ix, 0.6 + 1.2 * k, CRATES.cube[1] + 1.2 * iz, 0);

  props.add('ball', TOYS.ball[0], 1.1, TOYS.ball[1], 0);
  TOYS.pins.forEach(([x, z]) => props.add('pin', x, 0.75, z, 0));
  TOYS.dominoes.forEach(([x, z, yaw]) => props.add('domino', x, 1.3, z, yaw));

  /* ---------------------------------------------------------------- strike */

  // Ten pins inside six seconds of the first one going down.
  let first = -Infinity;
  let down = 0;
  events.on('knock', (kind) => {
    if (kind !== 'pin') return;
    if (state.time - first > 6) {
      first = state.time;
      down = 0;
    }
    if (++down === 10) {
      events.emit('toast', 'strike', 'Strike!', 'Ten pins in one go.');
      events.emit('sound', 'award');
    }
  });

  /* ---------------------------------------------------------------- seesaw */

  const [seeX, seeY, seeZ] = TOYS.seesaw;
  // East end down, on the ground. A level plank is in neutral equilibrium and stays level, and
  // the car's reaction impulse is what tips it. 108 kg; the fulcrum is a mesh only, because a
  // collider there holds the plank level and uncrossable.
  const tilt = -0.184;
  const plank = world.createRigidBody(
    rapier.RigidBodyDesc.dynamic()
      .setTranslation(seeX, seeY, seeZ)
      .setRotation({ x: 0, y: 0, z: Math.sin(tilt / 2), w: Math.cos(tilt / 2) }),
  );
  world.createCollider(
    rapier.ColliderDesc.cuboid(6, 0.1, 1.5)
      .setDensity(15)
      .setFriction(1)
      .setCollisionGroups(GROUPS.world),
    plank,
  );
  const origin = { x: 0, y: 0, z: 0 };
  const hinge = rapier.JointData.revolute(origin, origin, { x: 0, y: 0, z: 1 });
  hinge.limitsEnabled = true;
  hinge.limits = [-0.2, 0.2];
  const joint = world.createImpulseJoint(
    hinge,
    world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(seeX, seeY, seeZ)),
    plank,
    true,
  );
  if (!(joint instanceof rapier.RevoluteImpulseJoint)) throw new Error('playground: no hinge');
  // Left tipped over by the last crossing, the east end would be up and the belly of the next car
  // would meet it. Once the car is clear a soft spring (acceleration based: 6 is the square of
  // a 2.4 rad/s swing) eases the plank back to where it was authored.
  let sprung = false;

  const plankMesh = new Mesh(new BoxGeometry(12, 0.2, 3), look.lit({ color: '#e9a23b' }));
  plankMesh.castShadow = true;
  plankMesh.receiveShadow = true;
  scene.add(plankMesh);

  /* --------------------------------------------------------- wrecking ball */

  const { posts, anchor, rope } = TOYS.wrecker;
  const [anchorX, anchorY, anchorZ] = anchor;
  const structure: BufferGeometry[] = [new BoxGeometry(0.8, 1.1, 2.4).translate(seeX, 0.55, seeZ)];
  const fixedBox = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    physics.fixed(rapier.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(x, y, z));
    return new BoxGeometry(w, h, d).translate(x, y, z);
  };
  // The posts stand to the beam's underside, which is where the rope is tied.
  for (const [x, z] of posts) structure.push(fixedBox(x, anchorY / 2, z, 0.8, anchorY, 0.8));
  structure.push(fixedBox(anchorX, anchorY + 0.25, anchorZ, 0.6, 0.5, 10.8));
  const gantry = new Mesh(
    mergeGeometries(structure),
    look.lit({ color: '#b9bec8' }, { cutout: true }),
  );
  gantry.castShadow = true;
  gantry.receiveShadow = true;
  scene.add(gantry);

  const swing = world.createRigidBody(
    rapier.RigidBodyDesc.dynamic()
      .setTranslation(anchorX, anchorY - rope, anchorZ)
      .setLinearDamping(0.06)
      .setAngularDamping(0.4),
  );
  world
    .createCollider(rapier.ColliderDesc.ball(1.5).setCollisionGroups(GROUPS.prop), swing)
    .setMass(1200);
  world.createImpulseJoint(
    rapier.JointData.rope(rope, origin, origin),
    world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(anchorX, anchorY, anchorZ)),
    swing,
    true,
  );

  const ballMesh = new Mesh(new SphereGeometry(1.5, 24, 16), look.lit({ color: '#2b2f3a' }));
  ballMesh.position.set(anchorX, anchorY - rope, anchorZ);
  ballMesh.castShadow = true;
  ballMesh.receiveShadow = true;
  scene.add(ballMesh);

  const cord = new Line(
    new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([anchorX, anchorY, anchorZ, anchorX, anchorY - rope, anchorZ]),
        3,
      ),
    ),
    new LineBasicMaterial({ color: 0x1d2230 }),
  );
  cord.frustumCulled = false;
  scene.add(cord);
  const cordEnd = cord.geometry.getAttribute('position');

  /* ------------------------------------------------------------ per frame */

  let calmed = false;
  const at = new Vector3();
  const turn = new Quaternion();
  /** A toy is drawn while it moves, and once more after it stops. */
  const toys: { body: RigidBody; mesh: Mesh; live: boolean }[] = [
    { body: plank, mesh: plankMesh, live: true },
    { body: swing, mesh: ballMesh, live: true },
  ];

  return {
    update() {
      const { x, z } = car.position;
      const clear = Math.abs(x - seeX) > 9 || Math.abs(z - seeZ) > 5;
      // A ball left swinging would meet the next car anywhere along its arc: with nobody near,
      // it is slowed until it hangs still under its anchor.
      const away = Math.hypot(x - anchorX, z - anchorZ) > 14;
      if (away !== calmed) {
        calmed = away;
        swing.setLinearDamping(away ? 1.5 : 0.06);
        if (away) swing.wakeUp();
      }
      if (clear !== sprung) {
        sprung = clear;
        joint.configureMotorPosition(tilt, clear ? 6 : 0, clear ? 5 : 0);
        if (clear) plank.wakeUp();
      }
      for (const toy of toys) {
        const asleep = toy.body.isSleeping();
        if (asleep && !toy.live) continue;
        toy.live = !asleep;
        toy.body.translation(at);
        toy.body.rotation(turn);
        toy.mesh.position.copy(at);
        toy.mesh.quaternion.copy(turn);
      }
      cordEnd.setXYZ(1, ballMesh.position.x, ballMesh.position.y, ballMesh.position.z);
      cordEnd.needsUpdate = true;
    },
  };
};

export default playground;
