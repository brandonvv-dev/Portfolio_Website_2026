import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export interface CarInput {
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  /** -1 (right) .. 1 (left) */
  steer: number;
  brake: boolean;
}

const MAX_FORCE = 1400;
const MAX_STEER = 0.52;
const BRAKE_FORCE = 28;
/** Speed limiter (km/h). Uncapped this thing reaches 150+ and is undriveable. */
const MAX_KMH = 72;
const CHASSIS = { w: 0.95, h: 0.3, l: 1.9 }; // half-extents
const WHEEL_R = 0.34;

/**
 * Two cannon-es conventions disagree, and both bite:
 *
 *   - positive engine force pushes the chassis along its local -Z;
 *   - `currentVehicleSpeedKmHour` is signed against its local +Z.
 *
 * So the model is built nose-forward along +Z and the throttle is negated: W
 * gives a negative force (driving nose-first) and reads back a positive speed.
 * Leave the signs disagreeing and the car reverses under throttle while the
 * "opposite direction means brake" rule below fires on every frame of
 * acceleration, pinning it to a ~3 km/h crawl.
 *
 * The car spawns yawed 180 degrees so its nose points down the avenue.
 */
const SPAWN_YAW = Math.PI;
const UP = new CANNON.Vec3(0, 1, 0);

/** A low-poly car driven by a cannon-es RaycastVehicle. */
export class Car {
  readonly object = new THREE.Group();
  readonly vehicle: CANNON.RaycastVehicle;
  readonly body: CANNON.Body;

  private wheels: THREE.Object3D[] = [];
  private brakeLights: THREE.MeshStandardMaterial;
  private steerValue = 0;
  private spawn: CANNON.Vec3;

  constructor(
    world: CANNON.World,
    bodyMaterial: CANNON.Material,
    spawn = new CANNON.Vec3(0, 1.4, 14)
  ) {
    this.spawn = spawn;

    // --- Physics chassis -------------------------------------------------
    const shape = new CANNON.Box(new CANNON.Vec3(CHASSIS.w, CHASSIS.h, CHASSIS.l));
    this.body = new CANNON.Body({ mass: 160, material: bodyMaterial });
    this.body.addShape(shape, new CANNON.Vec3(0, 0.1, 0));
    this.body.position.copy(spawn);
    this.body.quaternion.setFromAxisAngle(UP, SPAWN_YAW);
    // Keeps the car from tipping onto its roof at the first hard corner
    this.body.angularDamping = 0.35;
    // The world allows sleeping (cheap for the props), but a sleeping chassis
    // ignores applyEngineForce, so the car would never pull away.
    this.body.allowSleep = false;

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const wheelOptions: CANNON.WheelInfoOptions = {
      radius: WHEEL_R,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      suspensionStiffness: 34,
      suspensionRestLength: 0.36,
      frictionSlip: 2.2,
      dampingRelaxation: 2.4,
      dampingCompression: 4.4,
      maxSuspensionForce: 100000,
      rollInfluence: 0.02,
      maxSuspensionTravel: 0.3,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    // Track wider than the hull, so the wheels read as wheels and not as trim.
    // Front pair first (+Z): applyInput steers wheels 0 and 1.
    const x = CHASSIS.w + 0.22;
    const z = CHASSIS.l - 0.55;
    for (const [px, pz] of [
      [x, z],
      [-x, z],
      [x, -z],
      [-x, -z],
    ]) {
      this.vehicle.addWheel({
        ...wheelOptions,
        chassisConnectionPointLocal: new CANNON.Vec3(px, 0, pz),
      });
    }

    // Wheel grip comes from frictionSlip above, not from contact materials:
    // RaycastVehicle wheels are raycasts, not bodies.
    this.vehicle.addToWorld(world);

    // --- Visuals (nose at +Z) --------------------------------------------
    const paint = new THREE.MeshStandardMaterial({
      color: 0x2997ff,
      metalness: 0.35,
      roughness: 0.38,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x121216,
      metalness: 0.2,
      roughness: 0.7,
    });

    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.w * 2, CHASSIS.h * 2, CHASSIS.l * 2),
      paint
    );
    hull.position.y = 0.1;
    hull.castShadow = true;

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.w * 1.55, 0.42, CHASSIS.l * 0.95),
      dark
    );
    cabin.position.set(0, 0.52, -0.15);
    cabin.castShadow = true;

    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.w * 1.85, 0.22, 0.5),
      paint
    );
    nose.position.set(0, 0.02, CHASSIS.l + 0.12);
    nose.castShadow = true;

    // Headlights + a cheap fake beam (cones beat two shadowed spotlights)
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xfff2d0,
      emissiveIntensity: 3,
    });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0cc,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.1), lampMat);
      lamp.position.set(side * 0.55, 0.1, CHASSIS.l + 0.3);

      // Cone apex sits back at the lamp, base flares out ahead of the car
      const beam = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6, 16, 1, true), beamMat);
      beam.rotation.x = -Math.PI / 2;
      beam.position.set(side * 0.55, 0.05, CHASSIS.l + 3.3);

      this.object.add(lamp, beam);
    }

    this.brakeLights = new THREE.MeshStandardMaterial({
      color: 0x330000,
      emissive: 0xff2200,
      emissiveIntensity: 0.4,
    });
    for (const side of [-1, 1]) {
      const tail = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.12, 0.08),
        this.brakeLights
      );
      tail.position.set(side * 0.6, 0.18, -CHASSIS.l - 0.02);
      this.object.add(tail);
    }

    this.object.add(hull, cabin, nose);

    // Wheels live on the scene root: RaycastVehicle gives world transforms.
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 20);
    wheelGeo.rotateZ(Math.PI / 2);
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1d, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({
      color: 0xd0d0d6,
      metalness: 0.9,
      roughness: 0.25,
    });

    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Mesh(wheelGeo, rubber);
      wheel.castShadow = true;
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_R * 0.48, WHEEL_R * 0.48, 0.32, 12),
        rim
      );
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      this.wheels.push(wheel);
    }
  }

  /** Wheels are separate roots: add them alongside the body group. */
  addTo(scene: THREE.Scene) {
    scene.add(this.object, ...this.wheels);
  }

  get speedKmh() {
    return Math.abs(this.vehicle.currentVehicleSpeedKmHour);
  }

  applyInput(input: CarInput, dt: number) {
    // Ease steering in/out so keyboard input doesn't feel binary.
    const target = input.steer * MAX_STEER;
    const rate = Math.abs(target) > 0.001 ? 4.5 : 8;
    this.steerValue += (target - this.steerValue) * Math.min(1, rate * dt);

    this.vehicle.setSteeringValue(this.steerValue, 0);
    this.vehicle.setSteeringValue(this.steerValue, 1);

    const speed = this.vehicle.currentVehicleSpeedKmHour;
    // Pressing the opposite direction while rolling = brakes, not instant reverse
    const braking =
      input.brake ||
      (input.throttle < -0.05 && speed > 2) ||
      (input.throttle > 0.05 && speed < -2);

    const capped = Math.abs(speed) >= MAX_KMH;
    const force = braking || capped ? 0 : -input.throttle * MAX_FORCE;

    for (let i = 0; i < 4; i++) {
      this.vehicle.setBrake(braking ? BRAKE_FORCE : 0, i);
      // All-wheel drive: far more forgiving to drive than rear-only
      this.vehicle.applyEngineForce(force, i);
    }

    this.brakeLights.emissiveIntensity = braking ? 4 : 0.4;
  }

  /** Sync meshes to physics. Call after world.step(). */
  sync() {
    this.object.position.copy(this.body.position as unknown as THREE.Vector3);
    this.object.quaternion.copy(this.body.quaternion as unknown as THREE.Quaternion);

    for (let i = 0; i < this.wheels.length; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;
      this.wheels[i].position.copy(t.position as unknown as THREE.Vector3);
      this.wheels[i].quaternion.copy(t.quaternion as unknown as THREE.Quaternion);
    }
  }

  /** Flip-recovery / respawn. Keeps the spawn heading. */
  reset(at?: CANNON.Vec3) {
    const p = at ?? this.spawn;
    this.body.position.set(p.x, p.y, p.z);
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.quaternion.setFromAxisAngle(UP, SPAWN_YAW);
    this.steerValue = 0;
  }

  /** True when the car is on its roof or side and stuck. */
  get isFlipped() {
    const up = new CANNON.Vec3(0, 1, 0);
    this.body.quaternion.vmult(up, up);
    return up.y < 0.25 && this.speedKmh < 3;
  }
}
