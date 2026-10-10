/**
 * The car: a Rapier ray-cast vehicle, the driver's input turned into forces on it, and the ways
 * back when it ends up where it cannot drive away from.
 *
 * It is a 1,000 kg toy. Each wheel is a ray with a spring on it, so the hull only ever touches
 * what the car crashes into. The numbers below were benched as one set from 30 to 1000 frames a
 * second, where launch, braking, cornering and jumps agree within 3 %: none is tuned on its own.
 *
 * This module fills CarState and draws nothing. The car on screen is carBody.ts.
 */
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { GROUPS, type ModuleFactory, type Respawn } from './types';

/** Kilograms. physics.ts takes the same figure for the car's side of an impact. */
const MASS = 1000;

/**
 * Resistance to pitch, yaw and roll. It and the mass are set on the body, on the axle plane, and
 * the hull's boxes carry none. Left to them the centre of mass would sit 0.37 m higher, and a
 * full brake from top speed lifts the rear wheels off the road for a third of a second.
 */
const INERTIA = new Vector3(1300, 1500, 450);

/**
 * What the car hits with: half extents, then how far the centre is above and ahead of the origin.
 * Boxes, because on the handling bench a single convex hull in the car's shape took normals from
 * flat ground and ramps that spun the car on one hard landing in fifty.
 */
const HULL: readonly (readonly [
  x: number,
  y: number,
  z: number,
  above: number,
  ahead: number,
  groups: number,
])[] = [
  // The belly between the axles, the body from bumper to bumper, and the cabin.
  [0.94, 0.15, 1.25, -0.05, -0.025, GROUPS.chassis],
  [0.94, 0.225, 1.96, 0.325, -0.04, GROUPS.chassis],
  [0.75, 0.325, 0.75, 0.875, -0.25, GROUPS.chassis],
  // The bumper hangs 5 cm off the road, lower than the belly, and sweeps props ahead of the car
  // before they can wedge under it. It meets props only: a kerb 15 cm high would stop it dead.
  [1.0, 0.33, 2.0, -0.09, -0.04, GROUPS.bumper],
];

/** Metres. The origin is the centre of the axle plane, so at rest it rides this high to 8 mm. */
const WHEEL_RADIUS = 0.4706;

/**
 * Where a spring is mounted: half the track, half the wheelbase, and above the origin by the
 * spring's free length less the 7 cm it sags under the car's weight.
 */
const HALF_TRACK = 0.6667;
const HALF_BASE = 1.0353;
const MOUNT_HEIGHT = 0.2799;
const SPRING_LENGTH = 0.35;

/** Newtons: the most one spring pushes, on the car and on whatever the wheel stands on. */
const SPRING_LIMIT = 38400;

/**
 * Newtons from a standstill, shared by the four wheels, and the speed in m/s where the push has
 * faded to nothing: 85 km/h, 130 with the boost, 35 backwards.
 *
 * ENGINE and IDLE_BRAKE are the two knobs for the feel. From 14 to 20 kN the engine takes the car
 * to 60 km/h in 1.5 to 1.0 s, and from 8 to 14 kN the idle brake stops it from 50 km/h in 12 to
 * 7 m. Across both ranges the jumps, the corners and the recovery stay as benched.
 */
const ENGINE = 17400;
const TOP_SPEED = 23.61;
const BOOST = 25600;
const BOOST_SPEED = 36.11;
const REVERSE_SPEED = 9.72;

/** Newtons: the pedal, and what slows the car when the driver only lifts off. */
const BRAKE = 38400;
const IDLE_BRAKE = 12000;

/** The front wheels' share of the pedal: under braking the weight is on them. */
const FRONT_SHARE = 0.65;

/** Radians at a standstill, and the speed in m/s at which half of it is left. */
const LOCK = 0.5;
const LOCK_FADE = 16;

/**
 * Per second, on the car's spin: light with a wheel down and heavy with none. Over the 10 degree
 * ramp the car then tips 14 degrees at most, where the light one alone lets it reach 24.
 */
const SPIN_DAMPING = 0.32;
const AIR_DAMPING = 2;

/** World y of the car's up axis below which it will not get up by itself: 53 degrees over. */
const TIPPED = 0.6;

/** Newton seconds: a hop leaves the ground at 8 m/s. */
const HOP = { x: 0, y: 8 * MASS, z: 0 };

/**
 * A hop lasts 2 x 8 / 25.11 = 0.637 s, and through it the spin decays at AIR_DAMPING a second.
 * The spin that turns the car through an angle in exactly that time is the angle times this.
 */
const HOP_SPIN = AIR_DAMPING / (1 - Math.exp(-1.274));

const DOWN = { x: 0, y: -1, z: 0 };
/** Pointing right, which is what makes a wheel's angle grow as it rolls forwards. */
const AXLE = { x: -1, y: 0, z: 0 };

const mount = new Vector3();
const euler = new Euler();
const turn = new Quaternion();
const spin = new Vector3();
const forward = new Vector3();
const up = new Vector3();
const local = new Vector3();
const normal = new Vector3();
const point = new Vector3();

/** The same angle, within half a turn of zero. */
const wrap = (angle: number) => MathUtils.euclideanModulo(angle + Math.PI, 2 * Math.PI) - Math.PI;

/** Which way a rotation points the nose: 0 faces +z. The nose itself is left in `forward`. */
function heading(rotation: Quaternion): number {
  forward.set(0, 0, 1).applyQuaternion(rotation);
  return Math.atan2(forward.x, forward.z);
}

export const createCar: ModuleFactory = (ctx) => {
  const { rapier, world, places, terrain, car, state, events } = ctx;
  const input = ctx.input.state;

  const body = world.createRigidBody(
    rapier.RigidBodyDesc.dynamic()
      // The controller's springs push on a sleeping chassis all the same, and their impulses
      // pile up in its velocity: woken by the throttle, the car hops.
      .setCanSleep(false)
      .setAdditionalMassProperties(MASS, { x: 0, y: 0, z: 0 }, INERTIA, { x: 0, y: 0, z: 0, w: 1 }),
  );
  // What tells this body from a prop, for whoever walks the world's bodies.
  body.userData = 'car';

  for (const [x, y, z, above, ahead, groups] of HULL) {
    world.createCollider(
      rapier.ColliderDesc.cuboid(x, y, z)
        .setTranslation(0, above, ahead)
        // The body's mass is the whole of the car's.
        .setDensity(0)
        // The lower friction of a pair wins: the hull slides at 0.2 on a level that grips at 1.
        .setFriction(0.2)
        .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
        .setCollisionGroups(groups)
        // physics.ts turns these into closing speeds. Its light hits need the threshold this
        // low: a 10 kg cone at walking pace pushes back with little more.
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1000),
      body,
    );
  }

  const controller = world.createVehicleController(body);
  controller.setIndexForwardAxis = 2;
  // Front-left, front-right, rear-left, rear-right. Left is +x and the nose is +z.
  for (let i = 0; i < 4; i++) {
    mount.set(i % 2 ? -HALF_TRACK : HALF_TRACK, MOUNT_HEIGHT, i < 2 ? HALF_BASE : -HALF_BASE);
    controller.addWheel(mount, DOWN, AXLE, SPRING_LENGTH, WHEEL_RADIUS);
    controller.setWheelMaxSuspensionTravel(i, 0.34);
    // Dropped from 1 m on these, the car is back within 3 mm of rest a third of a second after
    // the tyres touch, with a single overshoot of a centimetre.
    controller.setWheelSuspensionStiffness(i, 89.6);
    controller.setWheelSuspensionCompression(i, 7.2);
    controller.setWheelSuspensionRelaxation(i, 5.6);
    controller.setWheelMaxSuspensionForce(i, SPRING_LIMIT);
    // More grip at the back than at the front. Swapped, a flick of the wheel at top speed
    // spins the car round; like this no flick or full lock slides it more than 15 degrees.
    controller.setWheelFrictionSlip(i, i < 2 ? 1 : 1.35);
  }

  /** The front wheels' angle, radians, left positive. */
  let steering = 0;
  /** The heading the car holds while nobody steers, or null while it holds none. */
  let lock: number | null = null;
  /** Seconds in the air since two wheels were last down: what a landing is judged by. */
  let flight = 0;
  /** Seconds lying tipped and all but still, and the hops tried since the car last stood. */
  let tipped = 0;
  let hops = 0;
  /** Seconds upright with the throttle held and no wheel to drive. */
  let stuck = 0;
  /** Seconds until a reset that was asked for happens, and where to. 0 while none is. */
  let resetIn = 0;
  let resetTo: string | null = null;

  /** Reads the body into CarState, and leaves its nose and its up axis in the scratch. */
  function pose(): void {
    body.translation(car.position);
    body.rotation(car.quaternion);
    body.linvel(car.velocity);
    car.speed = Math.sqrt(car.velocity.x ** 2 + car.velocity.z ** 2);
    // The velocity as the car feels it: x across the nose, z along it.
    local.copy(car.velocity).applyQuaternion(turn.copy(car.quaternion).conjugate());
    car.forwardSpeed = local.z;
    car.slip = car.speed < 0.5 ? 0 : Math.atan2(Math.abs(local.x), Math.abs(local.z));
    car.yaw = heading(car.quaternion);
    car.upY = up.set(0, 1, 0).applyQuaternion(car.quaternion).y;
  }

  /** Puts the car down at rest: lift metres of air under the tyres, rolled about its nose. */
  function put(x: number, lift: number, z: number, yaw: number, roll: number): void {
    const ground = terrain.heightAt(x, z);
    body.setTranslation(car.position.set(x, ground + WHEEL_RADIUS + lift, z), true);
    body.setRotation(car.quaternion.setFromEuler(euler.set(0, yaw, roll, 'YXZ')), true);
    body.setLinvel(car.velocity.set(0, 0, 0), true);
    body.setAngvel(car.velocity, true);
    steering = 0;
    lock = null;
    flight = tipped = hops = stuck = resetIn = 0;

    pose();
    // The controller keeps the contacts of where the car was until its next update.
    for (const wheel of car.wheels) wheel.contact = false;
    car.wheelsDown = 0;
    car.airTime = 0;
    // The camera rides at this height, and the wheels report none until they land.
    car.groundY = ground;
  }

  /** The respawn of that name, or else the one nearest the car. */
  function respawnFor(name: string | null): Respawn {
    let nearest = places.spawn;
    let least = Infinity;
    for (const respawn of places.respawns) {
      if (respawn.name === name) return respawn;
      const distance = (respawn.x - car.position.x) ** 2 + (respawn.z - car.position.z) ** 2;
      if (distance < least) {
        least = distance;
        nearest = respawn;
      }
    }
    return nearest;
  }

  /**
   * Throws the car up with the spin that lands it on its wheels: about the axis that swings its
   * up axis on to the world's by the shortest way. Flat on the roof every axis is as short, and
   * the car rolls over its side, where it is lightest.
   */
  function hop(): void {
    spin.set(-up.z, 0, up.x);
    if (spin.lengthSq() < 1e-6) spin.copy(forward);
    spin.setLength(Math.acos(Math.max(-1, car.upY)) * HOP_SPIN);
    // An impulse is the inertia times the spin, and the inertia is given in the car's own axes.
    turn.copy(car.quaternion).conjugate();
    spin.applyQuaternion(turn).multiply(INERTIA).applyQuaternion(car.quaternion);
    body.applyImpulse(HOP, true);
    body.applyTorqueImpulse(spin, true);
  }

  put(places.spawn.x, 0, places.spawn.z, places.spawn.yaw, 0);

  events.on('reset', (name) => {
    resetTo = name;
    // The HUD's fade is black 0.15 s from now, and the car moves behind it.
    resetIn = 0.15;
  });
  events.on('place', (x, y, z, yaw, roll) => {
    put(x, y, z, yaw, roll);
    events.emit('respawn', { name: '', x, z, yaw });
  });

  return {
    substep(h) {
      const { throttle } = input;
      let steer = input.steer;
      // The car's speed, negative while it travels tail first, and its wheels' contacts: both
      // as the controller's last update left them.
      const speed = controller.currentVehicleSpeed();
      const pace = Math.abs(speed);
      let grounded = false;
      for (let i = 0; i < 4; i++) grounded ||= controller.wheelIsInContact(i);

      // The heading hold. A prop the car hits bends its heading for good, and over the 300 m to
      // the CV pad a degree is 5 m: without this, two runs in three down the Avenue with only W
      // held end more than 1.5 m off its line. So while nobody steers, the car steers itself
      // back to the heading it had when the wheel was let go.
      if (steer !== 0 || pace <= 1) lock = null;
      else {
        body.rotation(turn);
        const yaw = heading(turn);
        const yawRate = body.angvel(spin).y;
        // Taken once the car has stopped turning: let go mid-corner, it keeps where it ends up.
        if (lock === null && grounded && Math.abs(yawRate) < 0.3) lock = yaw;
        if (lock !== null) {
          let error = wrap(lock - yaw);
          // This far off, a crash turned the car, and steering back would swerve across the road.
          if (Math.abs(error) > 0.35) {
            lock = yaw;
            error = 0;
          }
          // Going backwards the wheel works mirrored.
          steer = MathUtils.clamp((6 * error - 0.3 * yawRate) * Math.sign(speed), -1, 1);
        }
      }

      // The lock narrows with speed, so the same key turns tight in a bay and wide on a straight.
      // The wheels ease to it at 12 a second, and at 18 while it only shrinks on the same side.
      const target = (steer * LOCK) / (1 + (pace / LOCK_FADE) ** 2);
      const turningIn =
        Math.abs(target) > Math.abs(steering) || Math.sign(target) !== Math.sign(steering);
      steering += (target - steering) * (1 - Math.exp(-(turningIn ? 12 : 18) * h));
      controller.setWheelSteering(0, steering);
      controller.setWheelSteering(1, steering);

      // Throttle against the way the car rolls is the brake until it has all but stopped. And
      // on a pad letting go is the brake too: the car parks itself in front of the board.
      const against = (throttle < -0.05 && speed > 0.5) || (throttle > 0.05 && speed < -0.5);
      const braking = input.brake || against || (state.onPad && throttle === 0);
      const boosting = input.boost && throttle > 0;
      let force = 0;
      if (!braking && throttle !== 0) {
        const top = throttle < 0 ? REVERSE_SPEED : boosting ? BOOST_SPEED : TOP_SPEED;
        // The push fades with speed the way the throttle points, and with no other.
        const along = Math.sign(throttle) === Math.sign(speed) ? pace : 0;
        force = throttle * (boosting ? BOOST : ENGINE) * Math.max(0, 1 - (along / top) ** 2);
      }
      for (let i = 0; i < 4; i++) {
        // Exactly 0 while braking: any engine force at all switches that wheel's brake off.
        controller.setWheelEngineForce(i, force / 4);
        let brake = 0;
        if (braking) brake = (BRAKE * (i < 2 ? FRONT_SHARE : 1 - FRONT_SHARE)) / 2;
        else if (force === 0) brake = IDLE_BRAKE / 4;
        // The controller takes its brake as an impulse per update, not as a force.
        controller.setWheelBrake(i, brake * h);
      }
      car.braking = braking;
      car.reversing = !braking && throttle < 0;
      car.boosting = !braking && boosting;

      body.setAngularDamping(grounded ? SPIN_DAMPING : AIR_DAMPING);

      // A wheel is a ray: its spring lifts the car and presses on nothing. What the car stands
      // on is handed the spring's force here, so the seesaw tips and a crate feels the weight.
      for (let i = 0; i < 4; i++) {
        // Asked first: in the air the controller still names a collider, and not a right one.
        if (!controller.wheelIsInContact(i)) continue;
        const ground = controller.wheelGroundObject(i)?.parent();
        if (!ground?.isDynamic()) continue;
        const push = Math.min(controller.wheelSuspensionForce(i)!, SPRING_LIMIT) * h;
        controller.wheelContactNormal(i, normal);
        controller.wheelContactPoint(i, point);
        ground.applyImpulseAtPoint(normal.multiplyScalar(-push), point, true);
      }

      controller.updateVehicle(h, rapier.QueryFilterFlags.EXCLUDE_SENSORS);
    },

    update(dt) {
      if (resetIn > 0) {
        resetIn -= dt;
        if (resetIn <= 0) {
          const at = respawnFor(resetTo);
          // Dropped from 1.2 m: whatever lies wrecked on the spot is landed on, not stood in.
          put(at.x, 1.2, at.z, at.yaw, 0);
          events.emit('respawn', at);
          // Nothing more this frame: the controller still holds the wheels of the old place.
          return;
        }
      }

      pose();
      let down = 0;
      let height = 0;
      for (let i = 0; i < 4; i++) {
        const wheel = car.wheels[i];
        wheel.contact = controller.wheelIsInContact(i);
        wheel.length = controller.wheelSuspensionLength(i)!;
        wheel.spin = controller.wheelRotation(i)!;
        wheel.steer = i < 2 ? steering : 0;
        if (!wheel.contact) continue;
        controller.wheelContactPoint(i, wheel.point);
        down++;
        height += wheel.point.y;
      }
      car.wheelsDown = down;
      if (down > 0) car.groundY = height / down;

      if (down === 0) {
        car.airTime += dt;
        flight += dt;
      } else {
        car.airTime = 0;
        // One wheel clipping a crate in mid-air is not a landing; two are the car coming down.
        if (down > 1) {
          if (flight >= 0.25) events.emit('land', flight);
          flight = 0;
        }
      }

      if (car.upY < TIPPED) {
        stuck = 0;
        tipped = car.speed < 2 ? tipped + dt : 0;
        // A hop that failed gets a little longer to come to rest before the next one.
        if (tipped >= (hops === 0 ? 1.2 : 1.5)) {
          tipped = 0;
          // Three hops have not stood the car up: it is wedged, and only moving it will.
          if (hops === 3) events.emit('reset', null);
          else {
            hops++;
            hop();
          }
        }
      } else {
        tipped = 0;
        if (down > 1) hops = 0;
        // Beached: the hull rests on something and every wheel hangs clear of the ground.
        stuck = input.throttle !== 0 && down === 0 && car.speed < 0.5 ? stuck + dt : 0;
        if (stuck >= 2) {
          stuck = 0;
          events.emit('reset', null);
        }
      }

      // Through the ground or over the edge. Asked once: each reset would restart the wait.
      if (car.position.y < -5 && resetIn <= 0) events.emit('reset', null);
    },
  };
};
