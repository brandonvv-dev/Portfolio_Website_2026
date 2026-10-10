/**
 * The Rapier world, its step, and what the car hit.
 *
 * A hit is reported as a closing speed. Rapier's contact force is the impulse of one step divided
 * by the length of that step, so the raw number doubles between a 72 Hz display and a 144 Hz one,
 * and against a light prop it is capped by the prop's own momentum. The impulse over the reduced
 * mass of the pair is the speed the contact took out of it: the same for a brick and for a wall,
 * at every refresh rate, and next to nothing while the car only leans on something.
 *
 * Nothing is ever removed from this world. One read of a removed body or collider panics the
 * wasm module, and a panicked world stays dead for the session.
 */
import type { RigidBody, TempContactForceEvent, World } from '@dimforge/rapier3d-compat';
import { GRAVITY, GROUPS, type Impact, type Physics, type Rapier } from './types';

/** Kilograms: the car's side of every pair. */
const CAR_MASS = 1000;

/** Membership bits of the hull and the bumper: what tells the car's collider from the other one. */
const CAR = (GROUPS.chassis | GROUPS.bumper) >>> 16;

/** Metres per second. Under this the car pushes or scrapes: full throttle on a wall reads 0.1. */
const SLOWEST = 1.5;

/**
 * A hit cannot close faster than the car was going, give or take the prop's own motion. A stack
 * pins the touched body to its neighbours, so the impulse over that one body's mass reads high:
 * 27 crates read 3 times the car's speed. This caps the reading at what the car could have lost.
 */
const MOST = 1.5;

/** What one substep's events against one collider add up to. */
interface Hit {
  /** Handle of the collider the car touched. */
  collider: number;
  /**
   * Newtons on that collider, away from the car, summed as a vector. The hull and the bumper
   * report the same brick separately, and where the bumper wedges under a brick that the hull is
   * pushing, the two forces are at right angles: their magnitudes added up read 1.4 times the
   * speed of the car, and only in the steps where both happen to land together.
   */
  fx: number;
  fy: number;
  fz: number;
  /** One over the reduced mass of the pair. */
  perMass: number;
  /** How far along the force the hit lies from the point below, metres. */
  reach: number;
  x: number;
  y: number;
  z: number;
}

/**
 * The first box to hit a box costs 3 to 4 ms in the wasm module, however light the scene, and
 * three times what any later contact does: the narrow phase code for it has not run yet. Left to
 * the first letter of BRANDON that is a dropped frame at 1.5 s. A scratch world sheds it behind
 * the loading screen: a stack toppling onto a floor, with the contact force events the car's
 * hits raise, then freed. It is never the game's world, so the rule about removing bodies holds.
 */
function warmUp(rapier: Rapier) {
  const scratch = new rapier.World({ x: 0, y: GRAVITY, z: 0 });
  const events = new rapier.EventQueue(true);
  scratch.createCollider(rapier.ColliderDesc.cuboid(10, 0.5, 10));
  for (let i = 0; i < 12; i++) {
    const body = scratch.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.3 * (i % 3), 1.5 + i, 0).setRotation({ x: 0, y: 0.2 * i, z: 0, w: 1 }),
    );
    scratch.createCollider(
      rapier.ColliderDesc.cuboid(0.9, 0.5, 0.5)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body,
    );
  }
  scratch.timestep = 1 / 120;
  for (let i = 0; i < 90; i++) scratch.step(events);
  events.free();
  scratch.free();
}

export function createPhysics(rapier: Rapier): {
  world: World;
  physics: Physics;
  /** Forgets the last frame's impacts and step time. */
  beginFrame(): void;
  /** Advances the world by one substep of h seconds and collects what the car hit in it. */
  step(h: number): void;
  /** Seconds the world has been stepped, summed from the h it was given. */
  simTime(): number;
  /** Milliseconds this frame's world steps took, all substeps together. */
  frameMs(): number;
} {
  warmUp(rapier);
  const world = new rapier.World({ x: 0, y: GRAVITY, z: 0 });
  const queue = new rapier.EventQueue(true);

  const impacts: Impact[] = Array.from({ length: 8 }, () => ({ speed: 0, x: 0, y: 0, z: 0 }));
  let impactCount = 0;
  const hits: Hit[] = Array.from({ length: 16 }, () => ({
    collider: 0,
    fx: 0,
    fy: 0,
    fz: 0,
    perMass: 0,
    reach: 0,
    x: 0,
    y: 0,
    z: 0,
  }));
  let hitCount = 0;
  const force = { x: 0, y: 0, z: 0 };
  const velocity = { x: 0, y: 0, z: 0 };
  let car: RigidBody | null = null;
  let time = 0;
  let ms = 0;

  /** Only the car's colliders raise these events, so one side of every pair is the car. */
  const onForce = (event: TempContactForceEvent) => {
    const first = world.getCollider(event.collider1());
    const second = world.getCollider(event.collider2());
    const carFirst = ((first.collisionGroups() >>> 16) & CAR) !== 0;
    const other = carFirst ? second : first;
    car ??= (carFirst ? first : second).parent();

    let i = 0;
    while (i < hitCount && hits[i].collider !== other.handle) i++;
    // More than sixteen things against the car in one substep: the rest go unheard.
    if (i === hits.length) return;
    const hit = hits[i];
    if (i === hitCount) {
      hitCount++;
      hit.collider = other.handle;
      hit.fx = hit.fy = hit.fz = 0;
      const body = other.parent();
      if (body?.isDynamic()) {
        hit.perMass = 1 / CAR_MASS + 1 / body.mass();
        hit.reach = 0;
        body.translation(hit);
      } else {
        // The level has no centre worth pointing at: the hit is placed 2 m from the car's,
        // on the side the level pushed from.
        hit.perMass = 1 / CAR_MASS;
        hit.reach = 2;
        (carFirst ? first : second).parent()?.translation(hit);
      }
    }
    // The force runs from collider1 to collider2, whichever of them is the car's.
    event.totalForce(force);
    const away = carFirst ? 1 : -1;
    hit.fx += away * force.x;
    hit.fy += away * force.y;
    hit.fz += away * force.z;
  };

  /** Files a hit among the frame's eight hardest, reusing the entry it pushes out. */
  const keep = (speed: number, x: number, y: number, z: number) => {
    let i = impactCount;
    if (i < impacts.length) impactCount++;
    else if (speed <= impacts[--i].speed) return;
    const entry = impacts[i];
    for (; i > 0 && impacts[i - 1].speed < speed; i--) impacts[i] = impacts[i - 1];
    impacts[i] = entry;
    entry.speed = speed;
    entry.x = x;
    entry.y = y;
    entry.z = z;
  };

  return {
    world,
    physics: {
      fixed: (desc) => world.createCollider(desc.setCollisionGroups(GROUPS.world).setFriction(1)),
      impacts,
      get impactCount() {
        return impactCount;
      },
    },
    beginFrame() {
      impactCount = 0;
      ms = 0;
    },
    step(h) {
      world.timestep = h;
      const before = performance.now();
      // World.step() is this call followed by a walk over every body and collider through a wasm
      // callback, to wrap what a torn soft body left behind. In Chromium that is 100 bytes of
      // garbage for each one: with 200 props and 300 colliders, 50 KB a step and ten times
      // what the step itself takes while everything sleeps. Nothing here is soft, so the
      // pipeline is stepped as it is.
      world.physicsPipeline.step(
        world.gravity,
        world.integrationParameters,
        world.islands,
        world.broadPhase,
        world.narrowPhase,
        world.bodies,
        world.colliders,
        world.softBodies,
        world.impulseJoints,
        world.multibodyJoints,
        world.ccdSolver,
        queue,
      );
      ms += performance.now() - before;
      time += h;
      // Drained at once: the queue empties itself at the next step, and a 60 Hz frame has two.
      queue.drainContactForceEvents(onForce);
      for (let i = 0; i < hitCount; i++) {
        const hit = hits[i];
        const newtons = Math.hypot(hit.fx, hit.fy, hit.fz);
        let speed = newtons * h * hit.perMass;
        if (speed < SLOWEST) continue;
        // The car's speed before the step: what it has now plus what the contact took out of it.
        // hitCount > 0 means the car's body was found in onForce.
        if (car) {
          car.linvel(velocity);
          speed = Math.min(speed, MOST * (Math.hypot(velocity.x, velocity.y, velocity.z) + (newtons * h) / CAR_MASS));
        }
        const reach = hit.reach / newtons;
        keep(speed, hit.x + hit.fx * reach, hit.y + hit.fy * reach, hit.z + hit.fz * reach);
      }
      hitCount = 0;
    },
    simTime: () => time,
    frameMs: () => ms,
  };
}
