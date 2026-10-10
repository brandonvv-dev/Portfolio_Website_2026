/**
 * The world painted from above, once, while the page loads: what is paved, where grass may grow,
 * where the land has to lie flat, what colour the paint is and how high the ground stands.
 *
 * Painting replaces a search. "How far is this point from the nearest of sixty shapes" is a loop
 * for every question; a blurred picture of the shapes answers it for a million points at once,
 * and a canvas draws that picture in a few milliseconds.
 */
import { MathUtils } from 'three';
import { FOOTPRINTS, SURFACES, type Surface } from './layout';
import { mulberry32 } from './util';

/** Metres along one side of the world, a square centred on the origin. */
export const SIZE = 320;
/** Cells of the height grid along one side, 1.25 m each, and the vertices that bound them. */
export const CELLS = 256;
export const ROW = CELLS + 1;
/** Pixels of the painted map along one side: 3.2 to the metre. */
export const MAP = 1024;
/** What every road is made of. The ground's shader lays it from a mask; it is never painted. */
export const TARMAC = '#5f6680';

/**
 * The Avenue goes on past the finish plaza into the corner of the world. A car let go there at
 * 85 km/h needs 20 m to brake to a halt, and the bank, which starts 144 m out, stopped it tipped
 * to 30 degrees. The bank leaves this strip level for those 20 m, and hills and trees keep off it
 * as off a solid. Its end is round, so the bank is back at full height in the corner, where it
 * still holds the car in.
 */
const RUNOUT = {
  kind: 'line',
  colour: '#fff',
  points: [[-136, -136], [-153, -153]],
  width: 14,
} as const satisfies Surface;

const px = (metres: number): number => (metres * MAP) / SIZE;

/** A world coordinate on the map. Row 0 is the north edge, z = -160. */
const at = (v: number): number => px(v + SIZE / 2);

function sheet(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAP;
  // Never shown, only read back or uploaded: kept in memory, where every machine rasterises it
  // alike.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('map: this browser has no 2D canvas');
  ctx.lineCap = ctx.lineJoin = 'round';
  return ctx;
}

/** One surface in the colours the context holds, grown by so many metres on every side. */
function trace(ctx: CanvasRenderingContext2D, surface: Surface, grow: number): void {
  ctx.beginPath();
  if (surface.kind === 'disc') {
    ctx.arc(at(surface.x), at(surface.z), px(surface.radius + grow), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (const [x, z] of surface.points) ctx.lineTo(at(x), at(z));
  if (surface.kind === 'line') {
    ctx.lineWidth = px(surface.width + 2 * grow);
    ctx.stroke();
    return;
  }
  ctx.closePath();
  ctx.fill();
  // A round-jointed stroke along the outline is what grows a polygon.
  ctx.lineWidth = px(2 * grow);
  if (grow > 0) ctx.stroke();
}

/**
 * Everything authored, in white, each shape grown by so many metres: the painted surfaces and,
 * when solids is set, the outline of whatever stands on grass. The maze, the tunnel's ramp, the
 * boards and the hoardings are up to 32 m from the nearest paint, and without them the hills
 * would rise through all four.
 *
 * With only set, paint of that colour is drawn and paint of any other rubs out what it covers,
 * in painting order: what is left is where that colour shows.
 */
function shapes(ctx: CanvasRenderingContext2D, grow: number, solids: boolean, only = ''): void {
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  for (const surface of SURFACES) {
    ctx.globalCompositeOperation =
      only && surface.colour !== only ? 'destination-out' : 'source-over';
    trace(ctx, surface, grow);
  }
  if (!solids) return;
  for (const [x, z, width, depth, yaw] of FOOTPRINTS) {
    ctx.save();
    ctx.translate(at(x), at(z));
    // Seen from above with z running down the canvas, a yaw turns the other way.
    ctx.rotate(-yaw);
    ctx.fillRect(
      px(-width / 2 - grow),
      px(-depth / 2 - grow),
      px(width + 2 * grow),
      px(depth + 2 * grow),
    );
    ctx.restore();
  }
  trace(ctx, RUNOUT, grow);
}

/**
 * One mask: 255 from `inner` metres outside the shapes inwards, 0 from `outer` metres outwards,
 * and a smooth ramp between the two, which is half way up midway.
 *
 * The shapes are drawn grown to that midway line and blurred across the ramp. The blur is a
 * canvas shadow, the one blur every browser has (Safari has no ctx.filter): the picture is drawn
 * beside the canvas and only its shadow lands on it. A shadow's sigma is half its shadowBlur, and
 * three sigma either side of the line span the ramp.
 */
function layer(inner: number, outer: number, solids: boolean, only?: string): Uint8ClampedArray {
  const sharp = sheet();
  shapes(sharp, (inner + outer) / 2, solids, only);
  const soft = sheet();
  soft.fillStyle = '#000';
  soft.fillRect(0, 0, MAP, MAP);
  soft.shadowColor = '#fff';
  soft.shadowBlur = px(outer - inner) / 3;
  soft.shadowOffsetX = 2 * MAP;
  soft.drawImage(sharp.canvas, -2 * MAP, 0);
  return soft.getImageData(0, 0, MAP, MAP).data;
}

/** Value noise over the world: random heights on a lattice one wavelength apart, eased between. */
function noise(random: () => number, wavelength: number): (x: number, z: number) => number {
  const side = Math.floor(SIZE / wavelength) + 2;
  const lattice = Float32Array.from({ length: side * side }, random);
  return (x, z) => {
    const fx = (x + SIZE / 2) / wavelength;
    const fz = (z + SIZE / 2) / wavelength;
    const i = Math.floor(fz) * side + Math.floor(fx);
    const tx = MathUtils.smoothstep(fx % 1, 0, 1);
    const tz = MathUtils.smoothstep(fz % 1, 0, 1);
    const north = lattice[i] + (lattice[i + 1] - lattice[i]) * tx;
    const south = lattice[i + side] + (lattice[i + side + 1] - lattice[i + side]) * tx;
    return north + (south - north) * tz;
  };
}

export function paintMap(): {
  /** MAP x MAP pixels of four bytes: paved, grass, flat, and the tarmac that shows. */
  masks: Uint8Array;
  /** Every paint but tarmac, MAP pixels square. Where none lies it is the colour of tarmac. */
  albedo: HTMLCanvasElement;
  /** Metres at every vertex of the grid: heights[iz * ROW + ix]. */
  heights: Float32Array;
} {
  // Paved is half way up on the true outline and a pixel soft. A pixel is 31 cm and the camera
  // shows 2 cm of ground to a screen pixel, so a painted edge would be a smear fifteen pixels
  // wide; a threshold on a mask this soft is a clean curve at any magnification. The same goes
  // for the tarmac, which is why the roads are a mask and not paint. The ramp cannot be any
  // shorter: Chromium blurs with whole-pixel boxes, and under 1.5 m it does not blur at all.
  const paved = layer(-0.9, 0.9, false);
  const tarmac = layer(-0.9, 0.9, false, TARMAC);
  // Nothing grows within 1.5 m of a shape, and everything does from 6.5 m.
  const clear = layer(1.5, 6.5, true);
  // The land lies flat to 4 m from a shape and is free of it from 18 m.
  const flat = layer(4, 18, true);
  const masks = new Uint8Array(MAP * MAP * 4);
  for (let i = 0; i < masks.length; i += 4) {
    masks[i] = paved[i];
    masks[i + 1] = 255 - clear[i];
    masks[i + 2] = flat[i];
    masks[i + 3] = tarmac[i];
  }

  // The other paints go on twice: every surface a metre too large, then every surface at its
  // size. The first coat leaves a rim of each surface's own colour around it, under the tarmac
  // and the grass that the shader lays up to the outline, so neither bleeds into the paint's
  // edge when the texture is magnified.
  const albedo = sheet();
  albedo.fillStyle = TARMAC;
  albedo.fillRect(0, 0, MAP, MAP);
  for (const grow of [1, 0]) {
    for (const surface of SURFACES) {
      if (surface.colour === TARMAC) continue;
      albedo.fillStyle = albedo.strokeStyle = surface.colour;
      trace(albedo, surface, grow);
    }
  }

  const random = mulberry32(0x5eed);
  const broad = noise(random, 48);
  const fine = noise(random, 17);
  const heights = new Float32Array(ROW * ROW);
  const [[ax, az], [bx, bz]] = RUNOUT.points;
  const dx = bx - ax;
  const dz = bz - az;
  for (let iz = 0; iz < ROW; iz++) {
    for (let ix = 0; ix < ROW; ix++) {
      const x = (ix / CELLS - 0.5) * SIZE;
      const z = (iz / CELLS - 0.5) * SIZE;
      // A vertex sits on the corner four pixels share, and the mask is far too soft for the
      // choice among them to show.
      const column = Math.min(ix * (MAP / CELLS), MAP - 1);
      const row = Math.min(iz * (MAP / CELLS), MAP - 1);
      const wild = 1 - masks[(row * MAP + column) * 4 + 2] / 255;
      const hills = 2.5 * (0.7 * broad(x, z) + 0.3 * fine(x, z));
      // The world ends in a bank 16 m high, with the forest on it.
      const rim = 16 * MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), 144, 160);
      // The metres to the run-out's centre line, which the bank gives way to over 3 m.
      const along = MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      const reach = Math.hypot(x - ax - along * dx, z - az - along * dz);
      const lane = MathUtils.smoothstep(reach, RUNOUT.width / 2, RUNOUT.width / 2 + 3);
      heights[iz * ROW + ix] = wild * wild * hills + rim * lane;
    }
  }

  return { masks, albedo: albedo.canvas, heights };
}
