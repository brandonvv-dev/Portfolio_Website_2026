/**
 * The knockable props. A kind is one InstancedMesh, so a wall of bricks is one draw call, and
 * every instance is a rigid body that carries its place in the list below as its userData.
 *
 * Props are authored standing and stepped behind the loading screen until Rapier lets them
 * sleep; where a prop falls asleep is its home. From then on a prop costs one question a frame,
 * whether it is awake, and only those that are have their instance moved and their distance from
 * home checked. Nothing here puts a moving body to sleep, because a domino run takes four
 * seconds to finish and by then the car is long gone. Rapier sleeps what rests, half a second
 * after it stops.
 *
 * What was wrecked goes home once the car cannot see it, and it goes as a whole. Rapier wakes
 * whatever a moved body was touching, so a wall put back with one brick still missing, or with a
 * stray one lying where a brick belongs, wakes up and falls again, and every fall counts: 51
 * bricks scored 293 that way before the rule below, and the wall never stood.
 */
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  GROUPS,
  type CarState,
  type Events,
  type PropSpec,
  type Props,
  type Rapier,
} from './types';

export interface PropsEngine extends Props {
  /**
   * One step of 1/120 s behind the loading screen. True while anything but the car still moves;
   * the call that finds everything asleep makes each prop's pose its home.
   */
  settle(): boolean;
  /**
   * Once a frame, after the physics: instances follow their bodies, knocks are counted, and what
   * was wrecked out of sight is rebuilt.
   */
  sync(): void;
  /** Dynamic bodies awake at the last sync, apart from the car. */
  readonly awake: number;
}

interface Kind {
  name: string;
  spec: PropSpec;
  mesh: InstancedMesh;
  /** The atlas cell of every instance, when the kind is labelled from an atlas. */
  cells: InstancedBufferAttribute | null;
  /** Instances standing so far. */
  count: number;
  /**
   * The floats of the instance matrices that changed since three last uploaded them, as the one
   * entry its updateRanges holds. An entry per instance would be sorted on every upload, and the
   * sort allocates.
   */
  range: { start: number; count: number };
}

interface Prop {
  kind: Kind;
  /** Its instance in the kind's mesh. */
  slot: number;
  body: RigidBody;
  home: Vector3;
  homeRotation: Quaternion;
  knocked: boolean;
  /** Where the last rebuild pass found it, and what that pass decided. */
  at: Vector3;
  fate: 'home' | 'stay' | 'go';
}

/** Squared metres: a prop more than half a metre from home is knocked. */
const MOVED = 0.5 ** 2;

/**
 * So is one turned more than 30 degrees. The dot of two rotations is the cosine of half the
 * angle between them, and its sign means nothing.
 */
const TURNED = Math.cos(Math.PI / 12);

/** Squared metres: a prop within a centimetre of home was woken, not moved. */
const NUDGED = 0.01 ** 2;

/** Squared metres from the car: well outside the three-quarter view, which shows 39 m of ground. */
const UNSEEN = 70 ** 2;

/** Squared metres between centres: farther apart, no two props touch or carry each other. */
const APART = 4 ** 2;

/** A prop below this height went through the ground or over the edge. */
const LOST = -5;

/**
 * three draws every shadow caster that has no depth material of its own with one it shares, and
 * derives that material's program again each time an instanced mesh follows a plain one or a
 * plain one an instanced: 4 KB of garbage a switch, every frame. The props bring their own, so
 * the shared one never meets an instanced mesh from here.
 */
const DEPTH = new MeshDepthMaterial();

const ONE = new Vector3(1, 1, 1);
const STILL = new Vector3();

export function createProps(deps: {
  rapier: Rapier;
  world: World;
  scene: Scene;
  car: CarState;
  events: Events;
}): PropsEngine {
  const { rapier, world, scene, car, events } = deps;
  const kinds = new Map<string, Kind>();
  const props: Prop[] = [];
  let knocked = 0;
  let awake = 0;
  /** When the wrecked props were last looked over, in performance.now() milliseconds. */
  let swept = 0;

  /** The dynamic bodies that are neither props nor the car: the seesaw plank, the wrecking ball. */
  const others: RigidBody[] = [];

  const position = new Vector3();
  const rotation = new Quaternion();
  const matrix = new Matrix4();

  /** Moves a prop's instance and stretches the kind's pending upload over its 16 floats. */
  const draw = (prop: Prop, at: Vector3, turned: Quaternion) => {
    const { mesh, range } = prop.kind;
    mesh.setMatrixAt(prop.slot, matrix.compose(at, turned, ONE));
    const start = prop.slot * 16;
    const pending = mesh.instanceMatrix.updateRanges;
    // three empties the list when it uploads: an empty list means the range starts afresh.
    if (pending.length === 0) {
      range.start = start;
      range.count = 16;
      pending.push(range);
    } else {
      const end = Math.max(range.start + range.count, start + 16);
      range.start = Math.min(range.start, start);
      range.count = end - range.start;
    }
    mesh.instanceMatrix.needsUpdate = true;
  };

  /** Makes the pose a prop is in the one it is knocked from, and later rebuilt to. */
  const rest = (prop: Prop) => {
    prop.body.translation(prop.home);
    prop.body.rotation(prop.homeRotation);
    draw(prop, prop.home, prop.homeRotation);
  };

  /** One awake prop: its instance follows the body, and leaving home counts once. */
  const follow = (prop: Prop) => {
    awake++;
    prop.body.translation(position);
    prop.body.rotation(rotation);
    draw(prop, position, rotation);
    if (
      !prop.knocked &&
      (position.distanceToSquared(prop.home) > MOVED ||
        Math.abs(rotation.dot(prop.homeRotation)) < TURNED)
    ) {
      prop.knocked = true;
      knocked++;
      events.emit('knock', prop.kind.name);
    }
  };

  /**
   * Sends home every prop that is out of place, out of sight both where it lies and where it
   * belongs, and no longer in the middle of anything: knocked, or at rest. A prop that has to
   * stay keeps everything near it waiting, whether near where it lies or near where it belongs,
   * and what waits keeps its own neighbours waiting. So a wall goes back in one piece or not at
   * all, and a domino run that is still falling is left to finish.
   */
  const rebuild = () => {
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      const { body, home, at } = prop;
      body.translation(at);
      if (!prop.knocked && at.distanceToSquared(home) < NUDGED) prop.fate = 'home';
      else if (at.y < LOST) prop.fate = 'go';
      else
        prop.fate =
          (prop.knocked || body.isSleeping()) &&
          at.distanceToSquared(car.position) > UNSEEN &&
          home.distanceToSquared(car.position) > UNSEEN
            ? 'go'
            : 'stay';
    }

    for (let held = true; held; ) {
      held = false;
      for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        // What fell through the ground comes back wherever the car is.
        if (prop.fate !== 'go' || prop.at.y < LOST) continue;
        for (let j = 0; j < props.length; j++) {
          const other = props[j];
          if (
            other.fate === 'stay' &&
            (other.at.distanceToSquared(prop.home) < APART ||
              other.home.distanceToSquared(prop.home) < APART)
          ) {
            prop.fate = 'stay';
            held = true;
            break;
          }
        }
      }
    }

    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      if (prop.fate !== 'go') continue;
      const { body, home, homeRotation } = prop;
      body.setTranslation(home, false);
      body.setRotation(homeRotation, false);
      body.setLinvel(STILL, false);
      body.setAngvel(STILL, false);
      body.sleep();
      prop.knocked = false;
      draw(prop, home, homeRotation);
    }
  };

  return {
    define(kind, spec) {
      // The count stays at the capacity. A slot nothing stands in holds a zero matrix, which
      // draws nothing, so the draw call is the same before and after the world is filled.
      const mesh = new InstancedMesh(spec.geometry, spec.material, spec.capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Instances travel, and the bounds of the mesh would not follow them.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = DEPTH;
      let cells: InstancedBufferAttribute | null = null;
      if (spec.atlas) {
        cells = new InstancedBufferAttribute(new Float32Array(spec.capacity * 4), 4);
        spec.geometry.setAttribute('aUv', cells);
      }
      scene.add(mesh);
      spec.collider.setCollisionGroups(GROUPS.prop);
      kinds.set(kind, { name: kind, spec, mesh, cells, count: 0, range: { start: 0, count: 0 } });
    },

    add(kind, x, y, z, yaw, uv) {
      const entry = kinds.get(kind);
      if (!entry) throw new Error(`props: kind '${kind}' is not defined`);
      const { spec } = entry;
      if (entry.count === spec.capacity) throw new Error(`props: kind '${kind}' is full`);
      const slot = entry.count++;

      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
          .setLinearDamping(0.1)
          .setAngularDamping(spec.angularDamping ?? 0.1),
      );
      const collider = world.createCollider(spec.collider, body);
      // Light enough that the car goes through a stack of them, heavy enough that the solver
      // does not squeeze one flat between the car and a wall.
      collider.setMass(spec.mass ?? Math.max(10, 15 * collider.volume()));
      body.userData = props.length;
      if (uv) entry.cells?.setXYZW(slot, uv.x, uv.y, uv.z, uv.w);

      const prop: Prop = {
        kind: entry,
        slot,
        body,
        home: new Vector3(),
        homeRotation: new Quaternion(),
        knocked: false,
        at: new Vector3(),
        fate: 'home',
      };
      props.push(prop);
      // Until the settle says otherwise, home is where the prop was put.
      rest(prop);
    },

    settle() {
      world.timestep = 1 / 120;
      world.step();
      others.length = 0;
      let moving = false;
      world.forEachRigidBody((body) => {
        if (body.userData === 'car' || !body.isDynamic()) return;
        moving ||= !body.isSleeping();
        if (typeof body.userData !== 'number') others.push(body);
      });
      if (!moving) props.forEach(rest);
      return moving;
    },

    sync() {
      awake = 0;
      // Asked one by one: Rapier's own walk over the awake bodies goes through a wasm callback,
      // which leaves 100 bytes of garbage for every body it visits.
      for (let i = 0; i < props.length; i++) if (!props[i].body.isSleeping()) follow(props[i]);
      for (let i = 0; i < others.length; i++) if (!others[i].isSleeping()) awake++;
      const now = performance.now();
      if (now - swept < 1000) return;
      swept = now;
      rebuild();
    },

    get knocked() {
      return knocked;
    },
    get total() {
      return props.length;
    },
    get awake() {
      return awake;
    },
  };
}
