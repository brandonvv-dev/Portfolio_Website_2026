import type * as CANNON from 'cannon-es';

/**
 * Engine, gearbox and tyre behaviour.
 *
 * Kept apart from the car so the two hard parts stay readable: this file is
 * where "feels like a car" lives, car.ts is where "is wired to cannon" lives.
 */

export interface DriveState {
  /** Engine force per driven wheel, already signed for cannon's convention. */
  force: number;
  /** 0..1 across the rev range, for the audio and any gauge. */
  rev: number;
  rpm: number;
  /** 1..N forward, 0 neutral/shifting, -1 reverse. */
  gear: number;
  shifting: boolean;
  /** How hard the engine is working, 0..1. Drives timbre, not pitch. */
  load: number;
}

const IDLE_RPM = 900;
const MAX_RPM = 7200;
const SHIFT_UP = 6600;
const SHIFT_DOWN = 2900;
/** Torque is cut for this long on a change, which is what you hear. */
const SHIFT_TIME = 0.22;

/**
 * Ratios chosen so all five gears land inside the speed range you actually
 * drive at: roughly 22, 40, 58, 76 km/h and then top. Geared any taller and
 * first alone covers most of the car's range, which leaves two audible shifts
 * in the whole world and defeats the point of having a gearbox.
 */
const GEARS = [10.4, 5.75, 3.96, 3.02, 2.42];
const REVERSE = 9;
const FINAL_DRIVE = 3.9;
/** Nm at the crank, before gearing. Scaled to the ratios above. */
const PEAK_TORQUE = 68;
/** Torque fades out between these road speeds (km/h). */
const LIMIT_FROM = 84;
const LIMIT_TO = 96;

/**
 * Normalised torque curve: soft off idle, peak around two thirds, falling
 * away to the limiter. The fall-off is the point — a flat curve gives you a
 * milk float that accelerates identically at every speed.
 */
function torqueAt(rpm: number) {
  const x = Math.min(Math.max(rpm, IDLE_RPM), MAX_RPM) / MAX_RPM;
  // Skewed hump peaking near x = 0.62
  const curve = Math.sin(Math.pow(x, 0.85) * Math.PI) * 0.82 + 0.3 * x;
  return Math.max(0.15, Math.min(1, curve));
}

export class Drivetrain {
  private gearIndex = 0;
  private shiftFor = 0;
  private revs = IDLE_RPM;
  private reversing = false;

  constructor(private wheelRadius: number) {}

  get gearLabel() {
    if (this.reversing) return 'R';
    return this.shiftFor > 0 ? '–' : String(this.gearIndex + 1);
  }

  /**
   * @param throttle -1..1 as the player left it
   * @param speedKmh signed road speed
   */
  update(throttle: number, speedKmh: number, dt: number): DriveState {
    // Soft limiter. Drag sets the natural top speed, but gearing plus a torque
    // curve can still run away on a downhill or off the ramp, and a hard clamp
    // at the old MAX_KMH felt like hitting a wall.
    const over = (Math.abs(speedKmh) - LIMIT_FROM) / (LIMIT_TO - LIMIT_FROM);
    const limiter = 1 - Math.min(1, Math.max(0, over));

    const speed = Math.abs(speedKmh) / 3.6; // m/s
    this.reversing = speedKmh < -0.5 || (throttle < -0.05 && Math.abs(speedKmh) < 2);

    // Wheel revs -> engine revs through the current ratio. Below walking pace
    // the clutch is effectively slipping, so the engine sits near idle
    // instead of being dragged under it.
    const ratio = (this.reversing ? REVERSE : GEARS[this.gearIndex]) * FINAL_DRIVE;
    const wheelRps = speed / (2 * Math.PI * this.wheelRadius);
    const geared = wheelRps * ratio * 60;
    const clutch = Math.min(1, speed / 3.5);
    const target = Math.max(IDLE_RPM, geared * clutch + IDLE_RPM * (1 - clutch));

    // Revs chase the target rather than snapping, so a shift is audible.
    this.revs += (Math.min(target, MAX_RPM) - this.revs) * Math.min(1, dt * 9);

    if (this.shiftFor > 0) this.shiftFor -= dt;

    // Automatic box with hysteresis. Only shift under power: lifting off at
    // 6600 should not provoke an upshift you did not ask for.
    if (this.shiftFor <= 0 && !this.reversing) {
      if (this.revs > SHIFT_UP && this.gearIndex < GEARS.length - 1 && throttle > 0.1) {
        this.gearIndex++;
        this.shiftFor = SHIFT_TIME;
      } else if (this.revs < SHIFT_DOWN && this.gearIndex > 0) {
        this.gearIndex--;
        this.shiftFor = SHIFT_TIME * 0.6;
      }
    }

    const shifting = this.shiftFor > 0;
    const demand = Math.abs(throttle);
    const torque = shifting ? 0 : torqueAt(this.revs) * PEAK_TORQUE * demand * limiter;

    // Crank torque -> force at the contact patch.
    const wheelForce = (torque * ratio * 0.92) / this.wheelRadius;

    return {
      // cannon drives along local -Z for a positive force, and the model's
      // nose is +Z, so the sign flips here. See the note in car.ts.
      force: -Math.sign(throttle || 1) * wheelForce * (throttle === 0 ? 0 : 1),
      rev: (this.revs - IDLE_RPM) / (MAX_RPM - IDLE_RPM),
      rpm: this.revs,
      gear: this.reversing ? -1 : shifting ? 0 : this.gearIndex + 1,
      shifting,
      load: Math.min(1, demand * (0.35 + 0.65 * torqueAt(this.revs))),
    };
  }

  reset() {
    this.gearIndex = 0;
    this.shiftFor = 0;
    this.revs = IDLE_RPM;
  }
}

/* ----------------------------------------------------------------- tyres */

/**
 * cannon clips a wheel's friction impulse at `frictionSlip * suspensionForce`.
 * That is a flat ceiling: once you exceed grip the force stays at the limit,
 * so a slide never *goes away* from you and never comes back. Real tyres peak
 * and then fall off, which is the whole feel of a car at the limit.
 *
 * Rewriting frictionSlip per wheel per frame against measured slip emulates
 * that curve on top of the clipping solver:
 *
 *   - grip climbs slightly into the peak (a loaded tyre bites),
 *   - past the peak it falls away, so a slide develops progressively,
 *   - it recovers as the slide scrubs speed off, so it is catchable.
 *
 * Load sensitivity rides along with it: a lightly loaded wheel (inside of a
 * corner, front under acceleration) gets proportionally less, which is what
 * makes weight transfer readable from the driver's seat.
 */
export function applyTyreModel(
  vehicle: CANNON.RaycastVehicle,
  baseSlip: number,
  lateralSpeed: number
) {
  const wheels = vehicle.wheelInfos;
  let total = 0;
  let grounded = 0;

  for (const w of wheels) {
    if (!w.raycastResult.hasHit) continue;
    total += w.suspensionForce;
    grounded++;
  }
  if (!grounded) return;

  const average = total / grounded;
  // How far past the peak the car as a whole is, 0..1.
  const slide = Math.min(1, Math.max(0, (Math.abs(lateralSpeed) - 1.6) / 7));

  for (const w of wheels) {
    if (!w.raycastResult.hasHit) {
      w.frictionSlip = baseSlip;
      continue;
    }

    // Load share, 0 (unloaded) .. ~2 (double its share).
    const share = average > 0 ? w.suspensionForce / average : 1;
    // Sub-linear, because a tyre's coefficient drops as you press on it.
    const loadTerm = 0.58 + 0.42 * Math.pow(Math.min(share, 2), 0.65);

    // Peak just above nominal, then fall to ~62% once it is properly sliding.
    const curveTerm = 1.12 - 0.5 * slide - 0.22 * slide * slide;

    w.frictionSlip = Math.max(0.35, baseSlip * loadTerm * curveTerm);
  }
}
