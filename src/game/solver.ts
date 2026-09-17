import * as CANNON from 'cannon-es';

/**
 * Solver quality: the difference between a world that feels solid and one
 * that feels like wet cardboard.
 *
 * Three separate problems live here:
 *
 *   1. Stacks that never settle. Too few solver iterations and a brick wall
 *      micro-jitters forever, which reads as "everything is slightly alive".
 *   2. Tunnelling. At 80 km/h the car covers ~0.37m per 60Hz tick, which is
 *      about a wheel radius, so thin geometry gets stepped straight over.
 *   3. Soft contacts. Default stiffness lets things visibly sink into each
 *      other before pushing back.
 */

/** Physics ticks per second. Halving the step is the cheapest accuracy win. */
export const FIXED_STEP = 1 / 120;
/** Ceiling on catch-up ticks, so a slow frame cannot spiral. */
export const MAX_SUBSTEPS = 6;

export function tuneSolver(world: CANNON.World) {
  const solver = world.solver as CANNON.GSSolver;
  // 10 is about where a six-row brick wall stops shivering. Beyond ~16 the
  // cost climbs and nothing visibly improves.
  solver.iterations = 12;
  solver.tolerance = 0.002;

  const contact = world.defaultContactMaterial;
  contact.contactEquationStiffness = 1e7;
  contact.contactEquationRelaxation = 3;
  contact.frictionEquationStiffness = 1e7;
  contact.frictionEquationRelaxation = 3;

  return world;
}

/**
 * Props settle and then stay settled.
 *
 * cannon's defaults let a body creep for a full second below 0.1 m/s before
 * sleeping, which is long enough for a pyramid to slowly unstack itself while
 * you are looking the other way.
 */
export function stabilise(body: CANNON.Body) {
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.14;
  body.sleepTimeLimit = 0.45;
  body.linearDamping = 0.04;
  body.angularDamping = 0.06;
}

/**
 * Continuous collision for one fast body.
 *
 * cannon-es is a discrete solver: it tests where things *are*, never where
 * they have *been*, so anything thinner than a tick's travel can be missed
 * entirely. This walks the line the body actually took each step and, if that
 * line crossed something solid, puts the body back on the near side of it and
 * kills the velocity heading into the surface.
 *
 * Only worth doing for the chassis. Running it over a hundred props costs more
 * than the tunnelling it would prevent.
 */
export class SweptGuard {
  private prev = new CANNON.Vec3();
  private result = new CANNON.RaycastResult();
  private from = new CANNON.Vec3();
  private to = new CANNON.Vec3();
  private armed = false;

  constructor(
    private body: CANNON.Body,
    private world: CANNON.World,
    /** Ignore hops shorter than this; below it the solver copes on its own. */
    private threshold = 0.3
  ) {}

  /** Call immediately before world.step(). */
  record() {
    this.prev.copy(this.body.position);
    this.armed = true;
  }

  /** Call immediately after world.step(). */
  resolve() {
    if (!this.armed) return false;
    this.armed = false;

    const p = this.body.position;
    const dx = p.x - this.prev.x;
    const dy = p.y - this.prev.y;
    const dz = p.z - this.prev.z;
    const travelled = Math.hypot(dx, dy, dz);
    if (travelled < this.threshold) return false;

    // Extend a little past the destination: the body has volume, and we are
    // testing its centre line.
    const over = 1 + 0.6 / travelled;
    this.from.copy(this.prev);
    this.to.set(this.prev.x + dx * over, this.prev.y + dy * over, this.prev.z + dz * over);

    this.result.reset();
    // Without this the ray hits the chassis it starts inside of.
    const was = this.body.collisionResponse;
    this.body.collisionResponse = false;
    this.world.rayTest(this.from, this.to, this.result);
    this.body.collisionResponse = was;

    if (!this.result.hasHit || !this.result.body) return false;
    // A body it is already resting on is not a tunnelling event.
    if (this.result.distance < 0.05) return false;

    const n = this.result.hitNormalWorld;
    const v = this.body.velocity;
    const into = v.x * n.x + v.y * n.y + v.z * n.z;
    // Moving away from the surface already: nothing to correct.
    if (into >= 0) return false;

    // Put it back just short of the surface it went through.
    const back = 0.45;
    p.set(
      this.result.hitPointWorld.x + n.x * back,
      this.result.hitPointWorld.y + n.y * back,
      this.result.hitPointWorld.z + n.z * back
    );

    // Remove the component heading into the surface; keep the slide along it.
    v.x -= n.x * into;
    v.y -= n.y * into;
    v.z -= n.z * into;

    return true;
  }
}
