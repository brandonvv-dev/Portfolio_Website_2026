/**
 * Everything written in the world: the eight pitch hoardings, and every decal on the ground (district
 * and toy names, Career Road, the label of every pad, chevrons, lane dashes). Built once before
 * the warm-up: three draw calls (faces, structure, decals) and two atlas textures.
 */
import {
  BoxGeometry,
  CanvasTexture,
  ImageBitmapLoader,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GROUND_TEXT, HOARDINGS, HUB, PITCHES, ROADS, ROUTE, SURFACES, type XZ } from '../layout';
import { FACE, type GameContext, type GameModule, type ModuleFactory, type Pad } from '../types';

const SANS = 'Inter, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const ACCENT = '#2997ff';
const PAPER = '#e9e6df';
const INK = '#141a22';

/* -------------------------------------------------------------- hoardings */

type SignStyle = 'plate' | 'neon' | 'paper' | 'blueprint' | 'terminal' | 'sticker';
const SIGN_STYLES: readonly SignStyle[] = [
  'plate',
  'neon',
  'paper',
  'blueprint',
  'terminal',
  'sticker',
];

const CELL_W = 1024;
const CELL_H = 384;
const FACE_W = 10;
const FACE_H = 3.75;
const FACE_BOTTOM = 0.5;

/** A font string whose size is shrunk (never squeezed) until the text fits. `#` stands for the size. */
function fitFont(
  g: CanvasRenderingContext2D,
  text: string,
  font: string,
  size: number,
  maxW: number,
): string {
  g.font = font.replace('#', String(size));
  const wide = g.measureText(text).width;
  return font.replace('#', String(wide > maxW ? Math.floor((size * maxW) / wide) : size));
}

/**
 * One hoarding's artwork in the cell the caller has translated to. `left` is where the text
 * region starts: the first hoarding keeps its left third for the portrait.
 */
function paintSign(
  g: CanvasRenderingContext2D,
  title: string,
  sub: string,
  style: SignStyle,
  left: number,
): void {
  const W = CELL_W;
  const H = CELL_H;
  const mid = left + (W - left) / 2;
  const room = W - left - 80;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  const line = (text: string, weight: number, size: number, color: string, y: number) => {
    g.font = fitFont(g, text, `${weight} #px ${SANS}`, size, room);
    g.fillStyle = color;
    g.fillText(text, mid, y);
  };

  switch (style) {
    case 'neon':
      g.fillStyle = '#05060a';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = ACCENT;
      g.lineWidth = 8;
      g.shadowColor = ACCENT;
      g.shadowBlur = 34;
      g.strokeRect(24, 24, W - 48, H - 48);
      line(title, 800, 104, '#ffffff', 186);
      g.shadowBlur = 18;
      line(sub, 600, 54, ACCENT, 268);
      g.shadowBlur = 0;
      break;
    case 'paper':
      g.fillStyle = '#f4f1ea';
      g.fillRect(0, 0, W, H);
      line(title, 800, 104, '#14161a', 172);
      g.fillStyle = ACCENT;
      g.fillRect(mid - 70, 204, 140, 6);
      line(sub, 600, 50, '#5a5f68', 284);
      break;
    case 'blueprint':
      g.fillStyle = '#0b2a4a';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.13)';
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x < W; x += 48) {
        g.moveTo(x, 0);
        g.lineTo(x, H);
      }
      for (let y = 0; y < H; y += 48) {
        g.moveTo(0, y);
        g.lineTo(W, y);
      }
      g.stroke();
      line(title, 800, 96, '#eaf3ff', 178);
      line(sub, 600, 48, '#8ec5ff', 264);
      break;
    case 'terminal': {
      g.fillStyle = '#0a0d0b';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#1d241f';
      g.fillRect(0, 0, W, 62);
      g.textAlign = 'left';
      const x = left + 40;
      g.fillStyle = '#4ade80';
      g.font = `700 40px ${MONO}`;
      g.fillText('~ $ whoami', x, 44);
      g.font = fitFont(g, title, `700 #px ${MONO}`, 82, room);
      g.fillText(title, x, 196);
      g.fillStyle = '#9aa5b1';
      g.font = fitFont(g, sub, `500 #px ${MONO}`, 44, room);
      g.fillText(sub, x, 272);
      g.fillStyle = '#4ade80';
      g.fillRect(x, 304, 26, 44);
      break;
    }
    case 'sticker':
      g.fillStyle = ACCENT;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.lineWidth = 10;
      g.setLineDash([26, 18]);
      g.strokeRect(22, 22, W - 44, H - 44);
      g.setLineDash([]);
      line(title, 800, 112, '#0b0d10', 188);
      line(sub, 600, 52, 'rgba(11,13,16,0.75)', 272);
      break;
    case 'plate':
      g.fillStyle = '#0e1116';
      g.fillRect(0, 0, W, H);
      g.fillStyle = ACCENT;
      g.fillRect(0, 0, W, 14);
      g.fillRect(0, H - 14, W, 14);
      line(title, 800, 108, '#ffffff', 178);
      line(sub, 600, 58, ACCENT, 268);
      break;
  }
}

function canvasOf(size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('signs: no 2D canvas');
  return [canvas, g];
}

function atlasTexture(canvas: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Nothing here ever moves, and the geometry already carries its world transform. */
function freeze(mesh: Mesh): void {
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

async function buildHoardings(ctx: GameContext): Promise<void> {
  const { scene, look, renderer, physics, rapier, quality } = ctx;
  const portrait = await new ImageBitmapLoader(ctx.loading).loadAsync(
    '/images/profile/portrait.webp',
  );

  const [canvas, g] = canvasOf(2 * CELL_W, 4 * CELL_H);
  const faces: BufferGeometry[] = [];
  const structure: BufferGeometry[] = [];
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), FACE);

  PITCHES.forEach(([title, sub], i) => {
    const col = i % 2;
    const row = i >> 1;
    g.save();
    g.translate(col * CELL_W, row * CELL_H);
    g.beginPath();
    g.rect(0, 0, CELL_W, CELL_H);
    g.clip();
    paintSign(g, title, sub, SIGN_STYLES[(i * 5) % SIGN_STYLES.length], i === 0 ? CELL_W / 3 : 0);
    if (i === 0) {
      // Head and shoulders, cropped square from the top, in a ring.
      const side = Math.min(portrait.width, portrait.height);
      const cx = CELL_W / 6;
      const cy = CELL_H / 2;
      g.save();
      g.beginPath();
      g.arc(cx, cy, 140, 0, Math.PI * 2);
      g.clip();
      g.drawImage(portrait, (portrait.width - side) / 2, 0, side, side, cx - 140, cy - 140, 280, 280);
      g.restore();
      g.beginPath();
      g.arc(cx, cy, 140, 0, Math.PI * 2);
      g.strokeStyle = ACCENT;
      g.lineWidth = 8;
      g.stroke();
    }
    g.restore();

    const [x, z] = HOARDINGS[i];
    const face = new PlaneGeometry(FACE_W, FACE_H);
    const uv = face.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, (col + uv.getX(k)) / 2, 1 - (row + 1 - uv.getY(k)) / 4);
    }
    faces.push(face.applyQuaternion(yaw).translate(x, FACE_BOTTOM + FACE_H / 2, z));

    // Back board and two legs in the hoarding's own frame, then turned and set down.
    const part = (geometry: BufferGeometry, lx: number, ly: number) =>
      structure.push(geometry.translate(lx, ly, -0.16).applyQuaternion(yaw).translate(x, 0, z));
    part(new BoxGeometry(FACE_W + 0.4, FACE_H + 0.4, 0.25), 0, FACE_BOTTOM + FACE_H / 2);
    // Thin and set back, so their fronts stay behind the face and never show through it.
    for (const end of [-1, 1]) {
      part(new BoxGeometry(0.4, 2.6, 0.2).translate(0, 0, -0.04), end * (FACE_W / 2 - 1.2), 1.3);
    }

    physics.fixed(
      rapier.ColliderDesc.cuboid(5.2, 2.2, 0.2).setTranslation(x, 2.2, z).setRotation(yaw),
    );
  });

  const texture = atlasTexture(canvas, quality.anisotropy);
  const board = new Mesh(mergeGeometries(faces), look.unlit({ map: texture }));
  const frame = new Mesh(
    mergeGeometries(structure),
    look.lit({ color: '#3c424e' }, { cutout: true }),
  );
  frame.castShadow = true;
  frame.receiveShadow = true;
  for (const mesh of [board, frame]) {
    freeze(mesh);
    scene.add(mesh);
  }
  renderer.initTexture(texture);
}

/* ----------------------------------------------------------------- decals */

const SIZE = 2048;
/** 48 px per metre: the screen shows 47 at 1600 px wide. */
const PPM = 48;
/** Transparent border round every cell, so a mip level or a filter tap never reads its neighbour. */
const GUTTER = 6;
/** Down-screen, per axis: where a label sits from its pad's centre. */
const DOWN = Math.SQRT1_2;

interface Cell {
  w: number;
  h: number;
  x: number;
  y: number;
  draw: (g: CanvasRenderingContext2D, x: number, y: number) => void;
}

interface Decal {
  cell: Cell;
  x: number;
  z: number;
  yaw: number;
}

/** Ground that already reads, in the screen's own frame: half width and half height in metres. */
interface Claim {
  x: number;
  z: number;
  hw: number;
  hh: number;
}

function padName(pad: Pad): string {
  return pad.id === 'email' ? 'HIRE ME' : pad.label.toUpperCase();
}

function buildDecals(ctx: GameContext): void {
  const { scene, look, renderer, quality } = ctx;
  const [canvas, g] = canvasOf(SIZE);
  const cells: Cell[] = [];
  const decals: Decal[] = [];
  const claims: Claim[] = [];

  const font = (em: number) => `800 ${Math.round(em * PPM)}px ${SANS}`;
  const measure = (text: string, em: number) => {
    g.font = font(em);
    return g.measureText(text).width;
  };
  const cell = (w: number, h: number, draw: Cell['draw']): Cell => {
    const made = { w: Math.ceil(w) + 2 * GUTTER, h: Math.ceil(h) + 2 * GUTTER, x: 0, y: 0, draw };
    cells.push(made);
    return made;
  };
  const put = (c: Cell, x: number, z: number, yaw: number, reads = false) => {
    decals.push({ cell: c, x, z, yaw });
    if (reads) claims.push({ x, z, hw: c.w / PPM / 2, hh: c.h / PPM / 2 });
  };
  /** One line in one colour, no wider than maxM metres. */
  const textCell = (text: string, em: number, colour: string, maxM = Infinity): Cell => {
    const size = Math.min(em, (em * maxM * PPM) / measure(text, em));
    const w = measure(text, size);
    const h = size * PPM * 1.2;
    return cell(w, h, (c, x, y) => {
      c.font = font(size);
      c.fillStyle = colour;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, x + GUTTER + w / 2, y + GUTTER + h / 2);
    });
  };

  /** A site's number, and its name beside it on the two lines that make the longer one shortest, as large as the label's width allows. */
  const siteLabel = (num: string, name: string, maxM: number): Cell => {
    const words = name.split(' ');
    let lines = [name];
    let widest = measure(name, 0.6);
    for (let k = 1; k < words.length; k++) {
      const pair = [words.slice(0, k).join(' '), words.slice(k).join(' ')];
      const w = Math.max(measure(pair[0], 0.6), measure(pair[1], 0.6));
      if (w < widest) [lines, widest] = [pair, w];
    }
    const numW = measure(num, 1.6);
    const gap = 0.4 * PPM;
    // 0.9 m where the name has room: the ground is seen at a slant, and 0.6 m reads as 14 px.
    const em = Math.min(0.9, (0.6 * (maxM * PPM - numW - gap)) / widest);
    const h = 1.6 * PPM * 1.2;
    return cell(numW + gap + (widest * em) / 0.6, h, (c, x, y) => {
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.fillStyle = INK;
      c.font = font(1.6);
      c.fillText(num, x + GUTTER, y + GUTTER + h / 2);
      c.font = font(em);
      lines.forEach((text, n) =>
        c.fillText(
          text,
          x + GUTTER + numW + gap,
          y + GUTTER + h / 2 + (n - (lines.length - 1) / 2) * em * PPM * 1.2,
        ),
      );
    });
  };

  // District and toy names, and the years of Career Road.
  for (const [text, x, z, fact] of GROUND_TEXT) {
    if (!fact) {
      put(textCell(text, 2.2, PAPER), x, z, FACE, true);
      continue;
    }
    // The numeral with its fact in one line under it, no wider than the tarmac it is painted on.
    const small = Math.min(1.1, (1.1 * 13 * PPM) / measure(fact, 1.1));
    const w = Math.max(measure(text, 3), measure(fact, small));
    const top = 3 * PPM * 1.2;
    const low = small * PPM * 1.3;
    const year = cell(w, top + low, (c, ox, oy) => {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = PAPER;
      c.font = font(3);
      c.fillText(text, ox + GUTTER + w / 2, oy + GUTTER + top / 2);
      c.font = font(small);
      c.fillText(fact, ox + GUTTER + w / 2, oy + GUTTER + top + low / 2);
    });
    put(year, x, z, FACE, true);
  }

  // One label per pad, half a radius down-screen of its centre and at most 0.8 of its width.
  for (const pad of ctx.places.pads) {
    const maxM = 1.6 * pad.radius;
    const x = pad.x + DOWN * pad.radius * 0.5;
    const z = pad.z + DOWN * pad.radius * 0.5;
    const site = pad.kind === 'site' ? /^(\d+)\s+(.*)$/.exec(pad.label) : null;
    const label = site
      ? siteLabel(site[1], site[2].toUpperCase(), maxM)
      : pad.id === 'axiom'
        ? textCell('AXIOM', 2.2, PAPER, maxM)
        : textCell(padName(pad), 1.1, INK, maxM);
    put(label, x, z, FACE, true);
  }

  const chevron = cell(2.2 * PPM, 2.2 * PPM, (c, x, y) => {
    const s = 2.2 * PPM;
    c.strokeStyle = ACCENT;
    c.lineWidth = s * 0.2;
    c.lineJoin = 'miter';
    c.beginPath();
    c.moveTo(x + GUTTER + s * 0.12, y + GUTTER + s * 0.78);
    c.lineTo(x + GUTTER + s * 0.5, y + GUTTER + s * 0.28);
    c.lineTo(x + GUTTER + s * 0.88, y + GUTTER + s * 0.78);
    c.stroke();
  });
  const dash = cell(3 * PPM, 0.3 * PPM, (c, x, y) => {
    c.fillStyle = PAPER;
    c.fillRect(x + GUTTER, y + GUTTER, 3 * PPM, 0.3 * PPM);
  });

  /** Every 9 m along a polyline: the middle of each equal share of each leg, with the leg's direction. */
  const along = (
    points: readonly XZ[],
    visit: (x: number, z: number, dx: number, dz: number) => void,
  ) => {
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1][0] - points[i][0];
      const dz = points[i + 1][1] - points[i][1];
      const steps = Math.max(1, Math.round(Math.hypot(dx, dz) / 9));
      for (let s = 0; s < steps; s++) {
        const k = (s + 0.5) / steps;
        visit(points[i][0] + dx * k, points[i][1] + dz * k, dx, dz);
      }
    }
  };
  const covered = (x: number, z: number, margin: number) =>
    claims.some((r) => {
      const dx = x - r.x;
      const dz = z - r.z;
      return (
        Math.abs((dx - dz) * Math.SQRT1_2) < r.hw + margin &&
        Math.abs((dx + dz) * Math.SQRT1_2) < r.hh + margin
      );
    });

  // A quad's local x is its length: yaw t turns it to (cos t, -sin t), and its up to (-sin t, -cos t).
  along(ROUTE, (x, z, dx, dz) => {
    if (!covered(x, z, 1.1)) put(chevron, x, z, Math.atan2(-dx, -dz));
  });

  // Lane dashes stay off the plazas (the first two surfaces), the hub, the forecourt and any text.
  const bare = [
    ...SURFACES.slice(0, 2).flatMap((s) => (s.kind === 'disc' ? [s] : [])),
    { x: HUB.x, z: HUB.z, radius: HUB.radius },
    ...ctx.places.pads.filter((p) => p.id === 'axiom'),
  ];
  for (const road of ROADS) {
    along(road.points, (x, z, dx, dz) => {
      if (bare.some((b) => Math.hypot(x - b.x, z - b.z) < b.radius + 1.5) || covered(x, z, 1.5)) {
        return;
      }
      put(dash, x, z, Math.atan2(-dz, dx));
    });
  }
  // The hub's island: a ring of dashes along the tangent.
  const ring = 8;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const yaw = Math.atan2(-Math.cos(a), -Math.sin(a));
    put(dash, HUB.x + HUB.island * Math.cos(a), HUB.z + HUB.island * Math.sin(a), yaw);
  }

  // Shelf packing, tallest first.
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const c of [...cells].sort((a, b) => b.h - a.h)) {
    if (x + c.w > SIZE) [x, y, shelf] = [0, y + shelf, 0];
    if (y + c.h > SIZE) throw new Error('signs: the decal atlas is full');
    [c.x, c.y] = [x, y];
    x += c.w;
    shelf = Math.max(shelf, c.h);
    c.draw(g, c.x, c.y);
  }

  const geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const uvs = new InstancedBufferAttribute(new Float32Array(decals.length * 4), 4);
  geometry.setAttribute('aUv', uvs);
  const texture = atlasTexture(canvas, quality.anisotropy);
  const mesh = new InstancedMesh(
    geometry,
    look.lit(
      {
        map: texture,
        alphaTest: 0.5,
        alphaToCoverage: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      },
      { atlas: true },
    ),
    decals.length,
  );
  const matrix = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const at = new Vector3();
  const size = new Vector3();
  decals.forEach(({ cell: c, x: px, z: pz, yaw }, i) => {
    mesh.setMatrixAt(
      i,
      matrix.compose(
        at.set(px, 0.02, pz),
        turn.setFromAxisAngle(up, yaw),
        size.set(c.w / PPM, 1, c.h / PPM),
      ),
    );
    uvs.setXYZW(i, c.x / SIZE, 1 - (c.y + c.h) / SIZE, c.w / SIZE, c.h / SIZE);
  });
  mesh.receiveShadow = true;
  freeze(mesh);
  scene.add(mesh);
  renderer.initTexture(texture);
}

const createSigns: ModuleFactory = async (ctx): Promise<GameModule> => {
  await buildHoardings(ctx);
  buildDecals(ctx);
  return {};
};

export default createSigns;
