import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { PropLibrary } from './props';
import { ventures, profiles } from '../data/ventures';

/** A drive-on pad that offers an outbound link rather than a screenshot. */
export interface Spot {
  id: string;
  title: string;
  sub: string;
  body: string;
  url: string;
  cta: string;
  external: boolean;
  accent: string;
  tags: string[];
  position: THREE.Vector3;
  yaw: number;
  half: { x: number; z: number };
}

export interface DressContext {
  scene: THREE.Scene;
  world: CANNON.World;
  groundMaterial: CANNON.Material;
  lib: PropLibrary;
  decal: (text: string, w: number, h: number, color?: string) => THREE.Mesh;
  addProp: (
    mesh: THREE.Object3D,
    shape: CANNON.Shape,
    rest: [number, number, number],
    mass: number
  ) => void;
  blockers: THREE.Object3D[];
}

export interface Dressing {
  spots: Spot[];
  /** Starts the demo reel. Browsers only allow this off a user gesture. */
  playVideo: () => void;
}

/* ------------------------------------------------------------ placement */

type Rect = { x0: number; x1: number; z0: number; z1: number };
type Disc = { x: number; z: number; r: number };

/**
 * Everywhere scenery must not go: roads, pads, plazas. Scatter picks random
 * points and rejects anything landing here, which keeps the driving surfaces
 * clear without hand-placing a hundred and forty trees.
 */
const NO_GO: Rect[] = [
  { x0: -13, x1: 13, z0: -86, z1: 136 }, // the avenue
  { x0: -13, x1: 13, z0: -178, z1: -100 }, // road to the finish
  { x0: -102, x1: -14, z0: 14, z1: 42 }, // west spur
  { x0: 14, x1: 106, z0: 14, z1: 42 }, // east spur
  { x0: -30, x1: -10, z0: 4, z1: 100 }, // avenue pads, west column
  { x0: 10, x1: 30, z0: 4, z1: 100 }, // avenue pads, east column
  { x0: -20, x1: 20, z0: 98, z1: 134 }, // start plaza
  { x0: -124, x1: -40, z0: -26, z1: 70 }, // playground, ramps and the toys
  { x0: -112, x1: -68, z0: -110, z1: -30 }, // tunnel and its roof ramp
  { x0: 68, x1: 112, z0: -110, z1: -46 }, // maze
  { x0: 52, x1: 120, z0: 64, z1: 124 }, // skate park
];

const NO_GO_DISCS: Disc[] = [
  { x: 0, z: -60, r: 70 }, // roundabout and its pads
  { x: 86, z: 26, r: 36 }, // courtyard
  { x: 0, z: -140, r: 18 }, // finish
];

/** Deterministic, so the world looks the same on every visit. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- signs */

/**
 * Hoardings come in several designs. One house style repeated a dozen times
 * down the same road reads as wallpaper; mixing them makes the roadside look
 * like somewhere that actually sells advertising space.
 */
export type SignStyle = 'plate' | 'neon' | 'paper' | 'blueprint' | 'terminal' | 'sticker';

/**
 * Extra yaw applied to the television model so its screen faces the way it is
 * placed. Measured by looking at it, not derivable from the GLB.
 */
const TV_FACE_YAW = 0;

const SIGN_STYLES: SignStyle[] = [
  'plate',
  'neon',
  'paper',
  'blueprint',
  'terminal',
  'sticker',
];

function signTexture(title: string, sub: string, accent: string, style: SignStyle = 'plate') {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 384;
  const ctx = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  ctx.textAlign = 'center';

  const MONO = 'ui-monospace, Menlo, Consolas, monospace';
  const SANS = 'Inter, system-ui, sans-serif';

  const heading = (size: number, color: string, y: number, font = SANS) => {
    ctx.fillStyle = color;
    ctx.font = '800 ' + size + 'px ' + font;
    ctx.fillText(title, W / 2, y, W - 100);
  };
  const strap = (size: number, color: string, y: number, font = SANS) => {
    ctx.fillStyle = color;
    ctx.font = '600 ' + size + 'px ' + font;
    ctx.fillText(sub, W / 2, y, W - 100);
  };

  switch (style) {
    case 'neon': {
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 8;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 34;
      ctx.strokeRect(24, 24, W - 48, H - 48);
      heading(104, '#ffffff', 186);
      ctx.shadowBlur = 18;
      strap(54, accent, 268);
      ctx.shadowBlur = 0;
      break;
    }

    case 'paper': {
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(0, 0, W, H);
      heading(104, '#14161a', 172);
      ctx.fillStyle = accent;
      ctx.fillRect(W / 2 - 70, 204, 140, 6);
      strap(50, '#5a5f68', 284);
      break;
    }

    case 'blueprint': {
      ctx.fillStyle = '#0b2a4a';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 2;
      for (let x = 0; x < W; x += 48) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y < H; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      heading(96, '#eaf3ff', 178);
      strap(48, '#8ec5ff', 264);
      break;
    }

    case 'terminal': {
      ctx.fillStyle = '#0a0d0b';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#1d241f';
      ctx.fillRect(0, 0, W, 62);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#4ade80';
      ctx.font = '700 40px ' + MONO;
      ctx.fillText('~ $ whoami', 40, 44, W - 80);
      ctx.font = '700 82px ' + MONO;
      ctx.fillText(title, 40, 196, W - 80);
      ctx.fillStyle = '#9aa5b1';
      ctx.font = '500 44px ' + MONO;
      ctx.fillText(sub, 40, 272, W - 80);
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(40, 304, 26, 44);
      ctx.textAlign = 'center';
      break;
    }

    case 'sticker': {
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 10;
      ctx.setLineDash([26, 18]);
      ctx.strokeRect(22, 22, W - 44, H - 44);
      ctx.setLineDash([]);
      heading(112, '#0b0d10', 188);
      strap(52, 'rgba(11,13,16,0.75)', 272);
      break;
    }

    default: {
      ctx.fillStyle = '#0e1116';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, W, 14);
      ctx.fillRect(0, H - 14, W, 14);
      heading(108, '#ffffff', 178);
      strap(58, accent, 268);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ------------------------------------------------------------ the stack */

/**
 * The tools, as blocks you can drive into. Exported because world.ts stands a
 * pair of them at the mouth of every site pad, so the stack and the client
 * work are met together rather than in two separate exhibits.
 */
export const STACK: [string, string][] = [
  ['C#', '#8b2be2'],
  ['.NET', '#512bd4'],
  ['React', '#61dafb'],
  ['Node.js', '#5fa04e'],
  ['JavaScript', '#f7df1e'],
  ['TypeScript', '#3178c6'],
  ['Python', '#3776ab'],
  ['C++', '#00599c'],
  ['Astro', '#ff5d01'],
  ['Next.js', '#d8dbe0'],
  ['PostgreSQL', '#4169e1'],
  ['Docker', '#2496ed'],
  ['Kafka', '#7c8694'],
  ['PyTorch', '#ee4c2c'],
  ['Tailwind', '#06b6d4'],
  ['Redis', '#dc382d'],
  ['FastAPI', '#009688'],
  ['three.js', '#c9ced6'],
  ['Git', '#f05032'],
  ['SQL', '#e38c00'],
];

/** Dark ink on light blocks, light on dark: the label has to survive either. */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0b0d10' : '#ffffff';
}

function stackTexture(name: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const ink = inkFor(color);

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 10;
  ctx.strokeRect(26, 26, 460, 460);
  ctx.globalAlpha = 1;

  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = name.length > 8 ? 74 : name.length > 4 ? 100 : 148;
  ctx.font = '800 ' + size + 'px Inter, system-ui, sans-serif';
  ctx.fillText(name, 256, 256, 430);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A box carrying `text` on all four upright faces and flat colour on the top
 * and bottom. Backs both the stack blocks and the knockable letters, which
 * want the same thing at different proportions.
 */
export function labelBlock(text: string, color: string, w: number, h = w, d = w) {
  const face = new THREE.MeshStandardMaterial({
    map: stackTexture(text, color),
    roughness: 0.45,
    metalness: 0.12,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.55,
  });
  // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [
    face,
    face,
    edge,
    edge,
    face,
    face,
  ]);
}

export function dressWorld(ctx: DressContext): Dressing {
  const { scene, world, groundMaterial, lib, decal, addProp, blockers } = ctx;
  const rand = mulberry32(0x5eed);

  const postMat = new THREE.MeshStandardMaterial({
    color: 0x8a94a6,
    metalness: 0.6,
    roughness: 0.4,
  });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x3c424e, roughness: 0.85 });

  /** Positioned at construction: see the note on addStatic in world.ts. */
  const staticBody = (shape: CANNON.Shape, x: number, y: number, z: number) => {
    const body = new CANNON.Body({
      mass: 0,
      shape,
      material: groundMaterial,
      position: new CANNON.Vec3(x, y, z),
    });
    body.updateAABB();
    world.addBody(body);
  };

  /* ------------------------------------------------- roadside advertising */

  /** A double-sided hoarding on two legs, readable from either direction. */
  const hoarding = (
    title: string,
    sub: string,
    x: number,
    z: number,
    yaw: number,
    accent = '#2997ff',
    width = 13,
    style: SignStyle = 'plate'
  ) => {
    const h = width * 0.375;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(width, h),
      new THREE.MeshStandardMaterial({
        map: signTexture(title, sub, accent, style),
        roughness: 0.65,
        side: THREE.DoubleSide,
      })
    );
    face.position.y = 2.4 + h / 2;
    face.castShadow = true;
    group.add(face);

    const back = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, h + 0.4, 0.25), backMat);
    back.position.set(0, 2.4 + h / 2, -0.16);
    group.add(back);

    for (const end of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.6, 10), postMat);
      leg.position.set(end * (width / 2 - 1.2), 1.3, -0.16);
      leg.castShadow = true;
      group.add(leg);
    }

    scene.add(group);
    blockers.push(back);
    return group;
  };

  // Brandon, on repeat, wherever the road goes. The whole point of the world
  // is that every route ends up pointing at the same person.
  const pitches: [string, string][] = [
    ['BRANDON VAN VUUREN', 'Full-stack & AI engineer'],
    ['AVAILABLE FOR WORK', 'brandon.vanvuuren60@gmail.com'],
    ['20 SITES SHIPPED', 'Design, build, handover'],
    ['REACT · .NET · PYTHON', 'Front to back, then deployed'],
    ['.NET 4 → .NET 8', 'Legacy migrations that stay migrated'],
    ['AI THAT SHIPS', 'Models wired into real features'],
    ['BUILT BY AXIOM', 'axiom-billing.vercel.app'],
    ['HIRE ME', 'Fast turnaround. Clean code.'],
  ];

  const lanes: [number, number, number][] = [
    [-14.5, 104, Math.PI / 2],
    [14.5, 82, -Math.PI / 2],
    [-14.5, 62, Math.PI / 2],
    [14.5, 42, -Math.PI / 2],
    [-14.5, 22, Math.PI / 2],
    [14.5, 2, -Math.PI / 2],
    [-40, 28, 0],
    [40, 28, Math.PI],
    [-14.5, -108, Math.PI / 2],
    [14.5, -126, -Math.PI / 2],
    [-34, -96, Math.PI / 4],
    [34, -96, -Math.PI / 4],
  ];

  lanes.forEach(([x, z, yaw], i) => {
    const [title, sub] = pitches[i % pitches.length];
    // Step the style by a number coprime with the list length, so neighbours
    // never repeat a design even where the pitches wrap around.
    hoarding(title, sub, x, z, yaw, '#2997ff', 13, SIGN_STYLES[(i * 5) % SIGN_STYLES.length]);
  });

  /* ---------------------------------------------------------- link pads */

  const spots: Spot[] = [];

  const padMat = (accent: string) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), roughness: 0.55 });

  /**
   * A pad you drive onto that offers a link. Same contract as a site board:
   * local +Z is the side you approach from, and the sign stands at the back.
   */
  const linkPad = (
    spot: Omit<Spot, 'position' | 'yaw' | 'half'>,
    x: number,
    z: number,
    yaw: number,
    size = { w: 18, d: 12 }
  ) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;

    const slab = new THREE.Mesh(
      new THREE.PlaneGeometry(size.w, size.d),
      padMat(spot.accent)
    );
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = 0.05;
    slab.receiveShadow = true;
    group.add(slab);

    const kerb = new THREE.Mesh(
      new THREE.BoxGeometry(size.w + 1, 0.24, size.d + 1),
      new THREE.MeshStandardMaterial({ color: 0xf4f6f9, roughness: 0.7 })
    );
    kerb.position.y = 0.06;
    kerb.receiveShadow = true;
    group.add(kerb);

    const name = decal(spot.title.toUpperCase(), size.w * 0.9, 2.2, '#0d1218');
    name.position.set(0, 0.09, size.d / 2 - 2);
    group.add(name);

    const board = hoarding(
      spot.title.toUpperCase(),
      spot.sub,
      0,
      -size.d / 2 - 1.4,
      0,
      spot.accent,
      16
    );
    group.add(board);
    scene.add(group);

    spots.push({
      ...spot,
      position: new THREE.Vector3(x, 0, z),
      yaw,
      half: { x: size.w / 2, z: size.d / 2 },
    });
  };

  const axiom = ventures.find((v) => v.id === 'axiom')!;
  const linkedin = profiles.find((p) => p.id === 'linkedin')!;
  const github = profiles.find((p) => p.id === 'github')!;
  const email = profiles.find((p) => p.id === 'email')!;

  linkPad(
    {
      id: 'axiom',
      title: axiom.name,
      sub: axiom.tagline,
      body: axiom.blurb,
      url: axiom.url,
      cta: axiom.cta,
      external: true,
      accent: axiom.accent,
      tags: axiom.tags,
    },
    -50,
    84,
    Math.PI / 2,
    { w: 22, d: 14 }
  );

  linkPad(
    {
      id: 'linkedin',
      title: linkedin.name,
      sub: linkedin.handle,
      body: 'Career history, recommendations and the long version of the CV.',
      url: linkedin.url,
      cta: linkedin.cta,
      external: true,
      accent: linkedin.accent,
      tags: [],
    },
    50,
    84,
    -Math.PI / 2
  );

  linkPad(
    {
      id: 'github',
      title: github.name,
      sub: github.handle,
      body: 'Source for the projects on this site, and whatever else is in flight.',
      url: github.url,
      cta: github.cta,
      external: true,
      accent: github.accent,
      tags: [],
    },
    50,
    4,
    -Math.PI / 2
  );

  linkPad(
    {
      id: 'email',
      title: email.name,
      sub: email.handle,
      body: 'Got something that needs building? Straight answer on scope and timing.',
      url: email.url,
      cta: email.cta,
      external: true,
      accent: email.accent,
      tags: [],
    },
    -50,
    4,
    Math.PI / 2
  );

  // No pad for Drive My CV: parked on the run-in to the finish, its hoarding
  // stood directly in front of the CV podium. It lives on the site instead.

  /* ------------------------------------------------- the Axiom big screen */

  const video = document.createElement('video');
  video.src = axiom.video ?? '';
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  // Must be in the document: a detached <video> is not reliably decoded, and
  // some browsers refuse to start it at all. Parked at 1px, out of the way.
  Object.assign(video.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    left: '0',
    bottom: '0',
  });
  document.body.appendChild(video);

  const videoTex = new THREE.VideoTexture(video);
  videoTex.colorSpace = THREE.SRGBColorSpace;

  // Big enough to read from the far end of the avenue.
  const SCREEN_W = 40;
  const SCREEN_H = SCREEN_W * 0.5625;
  const screenGroup = new THREE.Group();
  screenGroup.position.set(-78, 0, 84);
  screenGroup.rotation.y = Math.PI / 2; // faces the avenue

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    // Emissive so the picture reads as a lit screen rather than a painted
    // board, and stays legible against a bright sky.
    new THREE.MeshStandardMaterial({
      map: videoTex,
      emissive: 0xffffff,
      emissiveMap: videoTex,
      emissiveIntensity: 1.1,
      roughness: 0.4,
    })
  );
  screen.position.y = 6 + SCREEN_H / 2;
  screenGroup.add(screen);

  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(SCREEN_W + 1.6, SCREEN_H + 1.6, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.7 })
  );
  bezel.position.set(0, 6 + SCREEN_H / 2, -0.45);
  bezel.castShadow = true;
  screenGroup.add(bezel);
  blockers.push(bezel);

  for (const end of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 6.4, 12), postMat);
    leg.position.set(end * (SCREEN_W / 2 - 3), 3.2, -0.45);
    leg.castShadow = true;
    screenGroup.add(leg);
    staticBody(new CANNON.Cylinder(0.6, 0.8, 6.4, 10), -78, 3.2, 84 - end * (SCREEN_W / 2 - 3));
  }

  const crown = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W, 3.6),
    new THREE.MeshStandardMaterial({
      map: signTexture('AXIOM', 'axiom-billing.vercel.app', axiom.accent),
      side: THREE.DoubleSide,
      roughness: 0.6,
    })
  );
  crown.position.y = 6 + SCREEN_H + 2.8;
  screenGroup.add(crown);

  scene.add(screenGroup);

  /** A cube carrying one tool's name on all four sides. */
  const stackBlock = (name: string, color: string, size: number) =>
    labelBlock(name, color, size);

  /* --------------------------------------------------------- the scenery */

  const blocked = (x: number, z: number, pad = 4) => {
    for (const r of NO_GO) {
      if (x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad) return true;
    }
    for (const d of NO_GO_DISCS) {
      if (Math.hypot(x - d.x, z - d.z) < d.r + pad) return true;
    }
    // Keep clear of the big screen and its pad
    if (Math.hypot(x + 60, z - 84) < 30) return true;
    if (Math.hypot(x - 50, z - 84) < 24) return true;
    if (Math.hypot(x - 50, z - 4) < 22) return true;
    if (Math.hypot(x + 50, z - 4) < 22) return true;
    return false;
  };

  /** Scatters n props across the arena, skipping the no-go areas. */
  const scatter = (
    n: number,
    pick: () => {
      name: string;
      height: number;
      collide: boolean;
      mass?: number;
      /** Build a labelled cube rather than pull a model from the library. */
      stack?: boolean;
      color?: string;
    }
  ) => {
    let placed = 0;
    let guard = 0;

    while (placed < n && guard < n * 60) {
      guard++;
      const x = (rand() * 2 - 1) * 124;
      const z = -20 + (rand() * 2 - 1) * 142;
      if (blocked(x, z)) continue;

      const { name, height, collide, mass, stack, color } = pick();
      const mesh = stack
        ? stackBlock(name, color ?? '#2997ff', height)
        : lib.make(name, height);
      mesh.position.set(x, stack ? height / 2 : 0, z);
      mesh.rotation.y = rand() * Math.PI * 2;

      if (stack) {
        addProp(
          mesh,
          new CANNON.Box(new CANNON.Vec3(height / 2, height / 2, height / 2)),
          [x, height / 2, z],
          mass ?? 4
        );
      } else if (mass) {
        const r = Math.max(0.35, lib.radius(name, height) * 0.8);
        addProp(mesh, new CANNON.Cylinder(r, r, height, 8), [x, height / 2, z], mass);
      } else {
        scene.add(mesh);
        if (collide) {
          const r = Math.max(0.3, lib.radius(name, height) * 0.28);
          staticBody(new CANNON.Cylinder(r, r, height, 8), x, height / 2, z);
        }
      }
      placed++;
    }
    return placed;
  };

  const TREES = [
    'tree_default',
    'tree_detailed',
    'tree_oak',
    'tree_blocks',
    'tree_cone',
    'tree_fat',
    'tree_pineDefaultA',
    'tree_pineRoundA',
  ];
  const SHRUBS = [
    'plant_bush',
    'plant_bushLarge',
    'grass',
    'grass_large',
    'flower_redA',
    'flower_yellowA',
    'flower_purpleA',
  ];
  const ROCKS = ['rock_largeA', 'rock_largeB', 'rock_smallA', 'rock_smallB', 'log', 'log_stack', 'stump_round', 'stump_old'];

  const one = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];

  let count = 0;
  count += scatter(62, () => ({
    name: one(TREES),
    height: 7 + rand() * 6,
    collide: true,
  }));
  count += scatter(26, () => ({
    name: one(ROCKS),
    height: 1.2 + rand() * 1.8,
    collide: true,
  }));
  count += scatter(34, () => ({
    name: one(SHRUBS),
    height: 0.9 + rand() * 1.4,
    collide: false,
  }));

  // Knockable litter from the car kit, so there is something to hit off-road
  count += scatter(18, () => ({
    name: one(['cone', 'box', 'debris-tire']),
    height: 1.1 + rand() * 0.5,
    collide: true,
    mass: 1.1,
  }));

  // Televisions out in the world, each playing the same reel. The model's own
  // screen is part of a baked colour atlas and cannot be addressed, so a video
  // plane is fitted to the front of its measured bounding box instead.
  for (const [tx, tz, ty] of [
    [-64, 58, Math.PI / 2],
    [-58, 108, Math.PI / 2],
    [64, 58, -Math.PI / 2],
    [30, -104, 0],
  ] as const) {
    const TV_H = 9;
    const tv = lib.make('televisionModern', TV_H);
    tv.position.set(tx, 0, tz);
    tv.rotation.y = ty + TV_FACE_YAW;
    scene.add(tv);

    const box = new THREE.Box3().setFromObject(tv);
    const size = box.getSize(new THREE.Vector3());
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(TV_H * 1.28, TV_H * 0.72),
      new THREE.MeshStandardMaterial({
        map: videoTex,
        emissive: 0xffffff,
        emissiveMap: videoTex,
        emissiveIntensity: 1.05,
        roughness: 0.35,
      })
    );
    panel.position.set(tx, TV_H * 0.56, tz);
    panel.rotation.y = ty;
    panel.translateZ(Math.max(size.x, size.z) / 2 + 0.06);
    scene.add(panel);

    staticBody(new CANNON.Box(new CANNON.Vec3(3.4, TV_H / 2, 1.6)), tx, TV_H / 2, tz);
    count++;
  }

  /* ------------------------------------------------------------ the stack */

  // The gauntlet down the east spur is gone: the tools now stand at the mouth
  // of every site pad (see world.ts), so you meet the stack and the work that
  // was built with it in the same place instead of in two separate exhibits.
  // What is left here is the scattering out in the open, as landmarks.
  count += scatter(16, () => {
    const [name, color] = one(STACK);
    return { name, color, height: 3.4 + rand() * 1.6, collide: true, mass: 4, stack: true };
  });

  // Obelisks marking the roundabout approach
  for (const [ox, oz] of [
    [-24, -6],
    [24, -6],
  ] as const) {
    const ob = lib.make('statue_obelisk', 9);
    ob.position.set(ox, 0, oz);
    scene.add(ob);
    staticBody(new CANNON.Cylinder(1, 1.4, 9, 8), ox, 4.5, oz);
    count++;
  }

  if (import.meta.env.DEV) console.info(`[world] ${count} scenery props placed`);

  return {
    spots,
    playVideo: () => {
      void video.play().catch(() => {
        /* Autoplay refused: the board simply stays on its last frame. */
      });
    },
  };
}
