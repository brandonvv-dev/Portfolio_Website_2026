import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface CarInput {
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  /** -1 (right) .. 1 (left) */
  steer: number;
  brake: boolean;
  /** Rear-axle lock. Optional so the plain keyboard input still satisfies this. */
  handbrake?: boolean;
}

const MAX_FORCE = 1500;
const MAX_STEER = 0.52;
const BRAKE_FORCE = 30;
/**
 * Handbrake: locks the rear pair only, which is what lets the back step out.
 * Full-axle braking just stops the car in a straight line.
 */
const HANDBRAKE_FORCE = 110;
/** Speed limiter (km/h). Uncapped this thing reaches 150+ and is undriveable. */
const MAX_KMH = 78;
/** Every model is rescaled to this nose-to-tail length, so swaps stay drivable. */
const TARGET_LENGTH = 4;

/**
 * Two cannon-es conventions disagree, and both bite:
 *
 *   - positive engine force pushes the chassis along its local -Z;
 *   - `currentVehicleSpeedKmHour` is signed against its local +Z.
 *
 * So the model is oriented nose-forward along +Z and the throttle is negated:
 * W gives a negative force (driving nose-first) and reads back a positive
 * speed. Leave the signs disagreeing and the car reverses under throttle while
 * the "opposite direction means brake" rule below fires on every frame of
 * acceleration, pinning it to a ~3 km/h crawl.
 *
 * The car spawns yawed 180 degrees so its nose points down the avenue.
 */
const SPAWN_YAW = Math.PI;
const UP = new CANNON.Vec3(0, 1, 0);

export interface CarModel {
  /** Hull, already rotated nose-to-+Z, scaled, and centred on the axle plane. */
  body: THREE.Object3D;
  /** Front-left, front-right, back-left, back-right. */
  wheels: THREE.Object3D[];
  /** Matching suspension mounts, in car-local space with y = 0 at the axles. */
  mounts: THREE.Vector3[];
  wheelRadius: number;
  half: { w: number; l: number };
}

/**
 * Normalises a Kenney-style car GLB into something a RaycastVehicle can drive:
 * the hull and the four wheels are separated (cannon reports wheel transforms
 * in world space, so wheels cannot stay parented to the body), and everything
 * is rotated, scaled and re-centred from what the model actually measures
 * rather than from numbers guessed up front.
 */
export async function loadCarModel(url: string, loader: GLTFLoader): Promise<CarModel> {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  const find = (re: RegExp) => {
    let hit: THREE.Object3D | undefined;
    root.traverse((o) => {
      if (!hit && re.test(o.name)) hit = o;
    });
    return hit;
  };

  const wheelNodes = [
    find(/front[-_ ]?left/i),
    find(/front[-_ ]?right/i),
    find(/(back|rear)[-_ ]?left/i),
    find(/(back|rear)[-_ ]?right/i),
  ];
  if (wheelNodes.some((w) => !w)) {
    throw new Error(`Car model ${url} is missing named wheel nodes`);
  }
  const found = wheelNodes as THREE.Object3D[];

  const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

  // Which way does this model face? Front axle minus rear axle says so.
  root.updateMatrixWorld(true);
  const front = worldPos(found[0]).add(worldPos(found[1])).multiplyScalar(0.5);
  const back = worldPos(found[2]).add(worldPos(found[3])).multiplyScalar(0.5);
  const yaw = Math.atan2(front.x - back.x, front.z - back.z);

  // Swing the nose onto +Z, then scale to a known length.
  root.rotation.y = -yaw;
  root.updateMatrixWorld(true);
  const span = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  root.scale.setScalar(TARGET_LENGTH / span.z);
  root.updateMatrixWorld(true);

  // Wheel radius from the model, so the suspension matches what you can see.
  const wheelSize = new THREE.Box3().setFromObject(found[0]).getSize(new THREE.Vector3());
  const wheelRadius = Math.max(wheelSize.y, wheelSize.z) / 2;

  // Origin: centred between the wheels, at axle height.
  const hubs = found.map(worldPos);
  const origin = hubs
    .reduce((a, p) => a.add(p), new THREE.Vector3())
    .multiplyScalar(1 / hubs.length);
  const mounts = hubs.map((p) => new THREE.Vector3(p.x - origin.x, 0, p.z - origin.z));

  // Detach each wheel and bake its world transform, re-centred on its own hub,
  // so the holder can be driven straight from the physics transform.
  const wheels = found.map((node, i) => {
    const matrix = node.matrixWorld.clone();
    node.removeFromParent();

    const holder = new THREE.Group();
    holder.add(node);
    node.matrixAutoUpdate = false;
    node.matrix
      .copy(matrix)
      .premultiply(new THREE.Matrix4().makeTranslation(-hubs[i].x, -hubs[i].y, -hubs[i].z));
    return holder;
  });

  // What is left of the scene is the hull; drop it onto the axle plane.
  const body = new THREE.Group();
  root.position.sub(origin);
  body.add(root);

  body.updateMatrixWorld(true);
  const hull = new THREE.Box3().setFromObject(body);
  const hullSize = hull.getSize(new THREE.Vector3());

  for (const o of [body, ...wheels]) {
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
  }

  return {
    body,
    wheels,
    mounts,
    wheelRadius,
    half: { w: (hullSize.x / 2) * 0.92, l: (hullSize.z / 2) * 0.95 },
  };
}

/** A real car model driven by a cannon-es RaycastVehicle. */
export class Car {
  readonly object = new THREE.Group();
  readonly vehicle: CANNON.RaycastVehicle;
  readonly body: CANNON.Body;

  private wheels: THREE.Object3D[];
  private brakeLights: THREE.MeshStandardMaterial;
  private steerValue = 0;
  private spawn: CANNON.Vec3;

  constructor(
    world: CANNON.World,
    bodyMaterial: CANNON.Material,
    model: CarModel,
    spawn = new CANNON.Vec3(0, 1.6, 112)
  ) {
    this.spawn = spawn;
    this.wheels = model.wheels;
    this.object.add(model.body);

    // --- Physics chassis -------------------------------------------------
    // Half-height and lift stay fixed: they are tuned so the hull clears the
    // floor without the belly grounding out, whichever model is loaded.
    const shape = new CANNON.Box(new CANNON.Vec3(model.half.w, 0.32, model.half.l));
    this.body = new CANNON.Body({ mass: 170, material: bodyMaterial });
    this.body.addShape(shape, new CANNON.Vec3(0, 0.22, 0));
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
      radius: model.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      suspensionStiffness: 34,
      suspensionRestLength: 0.32,
      frictionSlip: 2.4,
      dampingRelaxation: 2.4,
      dampingCompression: 4.4,
      maxSuspensionForce: 100000,
      rollInfluence: 0.02,
      maxSuspensionTravel: 0.3,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    // Mounts arrive front-first, so wheels 0 and 1 are the pair that steers.
    for (const m of model.mounts) {
      this.vehicle.addWheel({
        ...wheelOptions,
        chassisConnectionPointLocal: new CANNON.Vec3(m.x, 0, m.z),
      });
    }

    // Wheel grip comes from frictionSlip above, not from contact materials:
    // RaycastVehicle wheels are raycasts, not bodies.
    this.vehicle.addToWorld(world);

    // --- Brake lights ------------------------------------------------------
    // The model bakes its lights into one colour atlas, so there is nothing to
    // address per-lamp; these sit just proud of the tail instead.
    this.brakeLights = new THREE.MeshStandardMaterial({
      color: 0x3a0000,
      emissive: 0xff2a10,
      emissiveIntensity: 0.5,
      roughness: 0.4,
    });
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.06), this.brakeLights);
      lamp.position.set(side * model.half.w * 0.62, 0.42, -model.half.l - 0.03);
      this.object.add(lamp);
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

    this.brakeLights.emissiveIntensity = braking ? 5 : 0.5;
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
