import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Drivetrain, applyTyreModel, type DriveState } from './drivetrain';

export interface CarInput {
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  /** -1 (right) .. 1 (left) */
  steer: number;
  brake: boolean;
  /** Rear-axle lock. Optional so the plain keyboard input still satisfies this. */
  handbrake?: boolean;
}

const MAX_STEER = 0.52;
const BRAKE_FORCE = 30;
/**
 * Handbrake: locks the rear pair only, which is what lets the back step out.
 * Full-axle braking just stops the car in a straight line.
 */
const HANDBRAKE_FORCE = 110;
/**
 * What is left of the rear tyres' grip while the handbrake is pulled. Locking
 * the rear wheels alone only slows the car; taking their lateral grip away at
 * the same time is what actually lets the back swing out.
 */
const HANDBRAKE_GRIP = 0.3;

/**
 * Anti-roll bars, in newtons per unit of left-right suspension difference.
 *
 * This is the fix for a RaycastVehicle that tips over. Four independent
 * springs have nothing tying one side of the car to the other, so in a
 * corner the outer pair compresses, the inner pair extends, and nothing
 * resists the body rolling until a wheel lifts and it goes over. A real car
 * has a bar across each axle doing exactly this sum.
 *
 * Front is stiffer than rear on purpose: it pushes the balance towards
 * understeer at the limit, which is the forgiving end to be on.
 */
const ROLL_BAR_FRONT = 2600;
const ROLL_BAR_REAR = 1900;

/**
 * Damping on roll rate specifically, rather than on all rotation.
 * `angularDamping` would bleed off yaw too, and yaw is the drift.
 */
const ROLL_DAMP = 240;
/**
 * Aerodynamic drag and rolling resistance. Together these give the car a top
 * speed that arrives gradually and a coast-down that feels like mass, rather
 * than the old hard clamp at a magic number.
 */
const DRAG = 2.2;
const ROLLING = 14;
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
const DRAG_F = new CANNON.Vec3();
const UP = new CANNON.Vec3(0, 1, 0);

// Scratch values for the per-frame getters below. Allocating a Vec3 inside a
// getter that four systems read every frame is the cheapest garbage there is
// to avoid making.
const LOCAL_VEL = new CANNON.Vec3();
const INV_QUAT = new CANNON.Quaternion();
const YAW_EULER = new THREE.Euler(0, 0, 0, 'YXZ');
const ROLL_FORCE = new CANNON.Vec3();
const ROLL_POINT = new CANNON.Vec3();
const ROLL_AXIS = new CANNON.Vec3();
const ROLL_TORQUE = new CANNON.Vec3();
/** The car's own forward axis, for isolating roll from yaw and pitch. */
const FORWARD = new CANNON.Vec3(0, 0, 1);

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
  private headlightMat!: THREE.MeshStandardMaterial;
  private beams: THREE.SpotLight[] = [];
  private lightsOn = false;
  private drivetrain!: Drivetrain;
  private baseSlip = 1.6;
  private lastDrive: DriveState = {
    force: 0,
    rev: 0,
    rpm: 900,
    gear: 1,
    shifting: false,
    load: 0,
  };
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
    // Light on purpose. At 170kg with stiff springs the car railed like a
    // simulator; at 110 it leans into a corner, slides when provoked and can
    // be shoved around by the props, which is the whole point of the place.
    this.body = new CANNON.Body({ mass: 110, material: bodyMaterial });
    this.body.addShape(shape, new CANNON.Vec3(0, 0.22, 0));
    this.body.position.copy(spawn);
    this.body.quaternion.setFromAxisAngle(UP, SPAWN_YAW);
    // Deliberately light, because roll is damped on its own axis in
    // dampRoll(). Damping everything equally is what makes a car feel like it
    // is turning in treacle: the yaw has to stay free for a drift to rotate.
    this.body.angularDamping = 0.14;
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
      // Soft and long-travel: visible body bounce over a kerb is most of what
      // separates a toy car from a physics demo.
      // Firmer than the soft setup that preceded it. Long, soft travel looked
      // great over a kerb but let the body keep rolling well past the point
      // the tyres had given up, which is where it went over.
      suspensionStiffness: 34,
      suspensionRestLength: 0.33,
      // Grip low enough to break traction under power or a flick of the wheel.
      frictionSlip: 1.6,
      dampingRelaxation: 2.6,
      dampingCompression: 4.2,
      maxSuspensionForce: 100000,
      // cannon applies the tyre's lateral force this far up towards the roll
      // axis. It is the single most direct tipping control there is, and 0.06
      // was enough to lever the car over on a hard direction change.
      rollInfluence: 0.015,
      maxSuspensionTravel: 0.36,
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
    // RaycastVehicle wheels are raycasts, not bodies. applyTyreModel rewrites
    // it per wheel per frame from this as the nominal value.
    this.baseSlip = wheelOptions.frictionSlip ?? 1.6;
    this.drivetrain = new Drivetrain(model.wheelRadius);
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

    // --- Headlights --------------------------------------------------------
    // Parented to the car, so they sweep with the steering. Shadows are off:
    // two shadow-casting spotlights on a moving car costs more than the sun
    // and buys nothing you can see at this camera distance.
    this.headlightMat = new THREE.MeshStandardMaterial({
      color: 0xfff6e0,
      emissive: 0xfff0d0,
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.14, 0.06),
        this.headlightMat
      );
      lens.position.set(side * model.half.w * 0.58, 0.46, model.half.l + 0.02);
      this.object.add(lens);

      const beam = new THREE.SpotLight(0xffeccc, 0, 46, 0.5, 0.45, 1.2);
      beam.position.copy(lens.position);
      beam.target.position.set(side * 0.6, -0.4, model.half.l + 14);
      this.object.add(beam, beam.target);
      this.beams.push(beam);
    }
  }

  /** Headlights on/off. Night mode is the world's business, not the car's. */
  setLights(on: boolean) {
    this.lightsOn = on;
    this.headlightMat.emissiveIntensity = on ? 4 : 0;
    for (const beam of this.beams) beam.intensity = on ? 170 : 0;
  }

  get hasLights() {
    return this.lightsOn;
  }

  /**
   * How hard the tyres are sliding, 0..1.
   *
   * Two sources, whichever is angrier. `skidInfo` is cannon's own verdict
   * (1 = gripping, 0 = the friction impulse was clipped) and it catches a
   * handbrake slide instantly; chassis lateral velocity catches the slower
   * four-wheel drift that never clips an impulse. Neither alone is enough.
   */
  get slip() {
    LOCAL_VEL.copy(this.body.velocity);
    this.body.quaternion.conjugate(INV_QUAT);
    INV_QUAT.vmult(LOCAL_VEL, LOCAL_VEL);
    const lateral = Math.abs(LOCAL_VEL.x);
    const forward = Math.abs(LOCAL_VEL.z);
    if (forward + lateral < 2) return 0;

    let grip = 1;
    for (const w of this.vehicle.wheelInfos) {
      // A wheel in the air keeps its last skidInfo, so only loaded ones vote.
      if (w.raycastResult.hasHit) grip = Math.min(grip, w.skidInfo);
    }
    return Math.min(1, Math.max(lateral / 6, 1 - grip));
  }

  /**
   * Height of whatever the wheels are standing on, or NaN in mid-air.
   *
   * Note this reads `raycastResult.hasHit`, not `isInContact`: cannon-es
   * leaves `isInContact` false even with all four wheels planted, so trusting
   * it reports the car permanently airborne.
   */
  get groundY() {
    let y = -Infinity;
    for (const w of this.vehicle.wheelInfos) {
      if (w.raycastResult.hasHit) y = Math.max(y, w.raycastResult.hitPointWorld.y);
    }
    return y === -Infinity ? NaN : y;
  }

  /** True when no wheel can find the ground. */
  get airborne() {
    return this.vehicle.wheelInfos.every((w) => !w.raycastResult.hasHit);
  }

  /** Is this wheel carrying any load? */
  wheelDown(i: number) {
    return this.vehicle.wheelInfos[i].raycastResult.hasHit;
  }

  /** World-space contact point under a wheel, for dropping tyre marks. */
  contactPoint(i: number, out: THREE.Vector3) {
    const r = this.vehicle.wheelInfos[i].raycastResult;
    return out.set(r.hitPointWorld.x, r.hitPointWorld.y, r.hitPointWorld.z);
  }

  get yaw() {
    YAW_EULER.setFromQuaternion(this.object.quaternion as unknown as THREE.Quaternion);
    return YAW_EULER.y;
  }

  /** Wheels are separate roots: add them alongside the body group. */
  addTo(scene: THREE.Scene) {
    scene.add(this.object, ...this.wheels);
  }

  get speedKmh() {
    return Math.abs(this.vehicle.currentVehicleSpeedKmHour);
  }

  /** How far this wheel's spring is squashed, 0 (hanging) .. 1 (bottomed). */
  private compression(w: CANNON.WheelInfo) {
    if (!w.raycastResult.hasHit) return 0;
    const rest = w.suspensionRestLength;
    return Math.min(1, Math.max(0, (rest - w.suspensionLength) / rest));
  }

  /**
   * One anti-roll bar. Ties the two wheels of an axle together so that the
   * difference in how far each spring is squashed produces a couple opposing
   * the roll: the loaded side is held up, the unloaded side pulled down.
   */
  private antiRoll(left: number, right: number, strength: number) {
    const wl = this.vehicle.wheelInfos[left];
    const wr = this.vehicle.wheelInfos[right];

    // With a wheel off the ground there is nothing to react against, and
    // applying the couple anyway is what flicks an airborne car over.
    if (!wl.raycastResult.hasHit || !wr.raycastResult.hasHit) return;

    const diff = this.compression(wl) - this.compression(wr);
    if (Math.abs(diff) < 1e-4) return;
    const magnitude = diff * strength;

    // Hold the more compressed side up...
    ROLL_FORCE.set(0, magnitude, 0);
    this.body.quaternion.vmult(wl.chassisConnectionPointLocal, ROLL_POINT);
    this.body.applyForce(ROLL_FORCE, ROLL_POINT);

    // ...and pull the extended side down by the same amount.
    ROLL_FORCE.set(0, -magnitude, 0);
    this.body.quaternion.vmult(wr.chassisConnectionPointLocal, ROLL_POINT);
    this.body.applyForce(ROLL_FORCE, ROLL_POINT);
  }

  /**
   * Bleeds off rotation about the car's own forward axis only. Raising
   * `angularDamping` would do this too, but it would damp yaw with it, and
   * yaw is the entire drift.
   */
  private dampRoll() {
    this.body.quaternion.vmult(FORWARD, ROLL_AXIS);
    const rate = this.body.angularVelocity.dot(ROLL_AXIS);
    if (Math.abs(rate) < 1e-3) return;
    ROLL_AXIS.scale(-rate * ROLL_DAMP, ROLL_TORQUE);
    this.body.torque.vadd(ROLL_TORQUE, this.body.torque);
  }

  applyInput(input: CarInput, dt: number) {
    // Steering lock falls away with speed. Full lock at 80 is how you spin a
    // car by breathing on the keyboard.
    const speed = this.vehicle.currentVehicleSpeedKmHour;
    const lockScale = 1 - 0.45 * Math.min(1, Math.abs(speed) / 70);
    const target = input.steer * MAX_STEER * lockScale;
    const rate = Math.abs(target) > 0.001 ? 4.5 : 8;
    this.steerValue += (target - this.steerValue) * Math.min(1, rate * dt);

    this.vehicle.setSteeringValue(this.steerValue, 0);
    this.vehicle.setSteeringValue(this.steerValue, 1);

    // Pressing the opposite direction while rolling = brakes, not instant reverse
    const braking =
      input.brake ||
      (input.throttle < -0.05 && speed > 2) ||
      (input.throttle > 0.05 && speed < -2);
    const hand = input.handbrake === true;

    const drive = this.drivetrain.update(braking ? 0 : input.throttle, speed, dt);
    this.lastDrive = drive;

    // Lateral velocity in the car's own frame tells the tyre model how far
    // past the grip peak the whole car is.
    LOCAL_VEL.copy(this.body.velocity);
    this.body.quaternion.conjugate(INV_QUAT);
    INV_QUAT.vmult(LOCAL_VEL, LOCAL_VEL);
    applyTyreModel(this.vehicle, this.baseSlip, LOCAL_VEL.x);

    // Handbrake: take most of the rear tyres' grip away, after the tyre model
    // has had its say. Locking them alone just scrubs speed off in a straight
    // line; it is losing the lateral grip that swings the back round.
    if (hand) {
      this.vehicle.wheelInfos[2].frictionSlip *= HANDBRAKE_GRIP;
      this.vehicle.wheelInfos[3].frictionSlip *= HANDBRAKE_GRIP;
    }

    // Keep it on its wheels. Both of these run every frame, grounded or not,
    // and they are what stopped it falling over in a corner.
    this.antiRoll(0, 1, ROLL_BAR_FRONT);
    this.antiRoll(2, 3, ROLL_BAR_REAR);
    this.dampRoll();

    // Torque is split across the driven wheels, not handed to each of them.
    const perWheel = drive.force / 4;

    for (let i = 0; i < 4; i++) {
      // Rear pair (2, 3) takes the handbrake; the fronts keep steering.
      const rear = i >= 2;
      this.vehicle.setBrake(
        hand && rear ? HANDBRAKE_FORCE : braking ? BRAKE_FORCE : 0,
        i
      );
      // All-wheel drive: far more forgiving to drive than rear-only
      this.vehicle.applyEngineForce(braking ? 0 : perWheel, i);
    }

    // Drag and rolling resistance, opposing travel. Without these the car
    // coasts forever and the gearbox has nothing to pull against.
    const v = this.body.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0.05) {
      const mag = DRAG * sp * sp + ROLLING;
      DRAG_F.set((-v.x / sp) * mag, 0, (-v.z / sp) * mag);
      this.body.applyForce(DRAG_F, this.body.position);
    }

    this.brakeLights.emissiveIntensity = braking || hand ? 5 : 0.5;
  }

  /** Engine state, for the audio and anything that wants a gauge. */
  get drive() {
    return this.lastDrive;
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
    this.drivetrain.reset();
  }

  /** True when the car is on its roof or side and stuck. */
  get isFlipped() {
    const up = new CANNON.Vec3(0, 1, 0);
    this.body.quaternion.vmult(up, up);
    return up.y < 0.25 && this.speedKmh < 3;
  }
}
