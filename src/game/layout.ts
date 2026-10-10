/**
 * The world as data: every coordinate and every string a module places, and nothing that draws.
 * It imports no three value, so it adds only its own numbers to the page.
 *
 * x is east and z is south. The fixed camera looks from the south-east, so the screen's axes are
 * the world's diagonals: up-screen is (-x, -z), screen-right is (+x, -z). The Avenue runs along
 * x = z, straight up the screen, and driving it from the bottom to the top is reading the CV.
 */
import { moreSiteCategories, moreSites } from '../data/more-sites';
import { siteLinks } from '../data/site-links';
import { sites, type Site } from '../data/sites';
import { profiles, ventures } from '../data/ventures';
import { FACE, type Pad, type Places, type Respawn } from './types';

export type XZ = readonly [x: number, z: number];
export type XYZ = readonly [x: number, y: number, z: number];

/** A cuboid: its centre, then its full size. */
export type Box = readonly [
  x: number,
  y: number,
  z: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
];

/**
 * What kit.ts's wedge() takes after ctx: the centre of the footprint, its width, its length on the
 * ground, the height of the far edge, and the yaw it rises towards.
 */
export type Wedge = readonly [
  x: number,
  z: number,
  width: number,
  run: number,
  rise: number,
  yaw: number,
];

/** A quarter pipe: the middle of the line where the curve leaves the floor, then its shape. */
export type Pipe = readonly [
  x: number,
  z: number,
  radius: number,
  sweep: number,
  width: number,
  segments: number,
  yaw: number,
];

const RAD = Math.PI / 180;
const NORTH = Math.PI;
const WEST = -Math.PI / 2;

/** s metres screen-right of the spine and t metres up-screen of the hub. */
export function st(s: number, t: number): [number, number] {
  return [0.70711 * (s - t), -0.70711 * (s + t)];
}

/** a metres up the Avenue from the spawn and l metres to its right. The spawn is at t = -155. */
const spine = (a: number, l = 0): XZ => st(l, a - 155);

/** d metres up-screen of a point: where a pad's camera focus sits. */
const upScreen = (x: number, z: number, d: number): XZ => [x - 0.70711 * d, z - 0.70711 * d];

/** A wedge given by its slope in degrees, as the benches name them. */
const ramp = (
  x: number,
  z: number,
  width: number,
  degrees: number,
  rise: number,
  yaw: number,
): Wedge => [x, z, width, rise / Math.tan(degrees * RAD), rise, yaw];

/** ventures.ts is kept by hand and shared with the site: a missing entry is a mistake there. */
function byId<T extends { id: string }>(list: readonly T[], id: string): T {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`layout: ventures.ts has no '${id}'`);
  return found;
}

/* ------------------------------------------------------------------ roads */

export interface Road {
  width: number;
  /** The centre line. */
  points: readonly XZ[];
}

const L = 104;

export const ROADS: readonly Road[] = [
  // The Avenue: the hold-W spine, start to finish through the hub.
  { width: 14, points: [[113.1, 113.1], [0, 0], [-103.9, -103.9]] },
  // The client street, legs A to D: Beauty Row, Salon Mile, High Street, Motor Mile.
  { width: 12, points: [[L, L], [L, 0]] },
  { width: 12, points: [[L, 0], [0, 0]] },
  { width: 12, points: [[0, 0], [0, -L]] },
  { width: 12, points: [[0, -L], [-L, -L]] },
  // South Street and West Street round the Meadow.
  { width: 12, points: [[L, L], [0, L]] },
  { width: 12, points: [[0, L], [0, 0]] },
  // Playground Road and Yard Lane.
  { width: 12, points: [[0, 0], [-L, 0]] },
  { width: 12, points: [[-L, 0], [-L, -L]] },
  // East Loop, past the maze and through the tunnel.
  { width: 12, points: [[L, 0], [L, -L], [0, -L]] },
  // The spur from East Loop to the way into the maze.
  { width: 10, points: [[98, -55], [80, -55]] },
];

/** Where the roads meet: a paved disc, the radius of its painted island, and nothing solid. */
export const HUB = { x: 0, z: 0, radius: 16, island: 5 };

/** The blue chevrons: the lane beside the bays, start to finish. */
export const ROUTE: readonly XZ[] = [
  [101, 96],
  [101, 3],
  [97, -3],
  [8, -3],
  [-3, -8],
  [-3, -97],
  [-8, -107],
  [-92, -107],
];

/* ------------------------------------------------------- the client street */

/** One lay-by of the client street. */
export interface Bay {
  site: Site;
  /** Centre of the pad, 11.5 m up-screen of the road's centre line. */
  x: number;
  z: number;
  /** Unit step from the pad towards its road: east on the Z roads, south on the X roads. */
  roadX: number;
  roadZ: number;
}

/**
 * One leg: a road along the given axis at x or z = line, with a bay at each [slug, metres along].
 * sites.ts is generated, so the join is by slug: a slug it no longer has gets no bay, and
 * assertLayout() reports a site left without one.
 */
const leg = (
  axis: 'x' | 'z',
  line: number,
  bays: readonly (readonly [slug: string, along: number])[],
): Bay[] =>
  bays.flatMap(([slug, along]): Bay[] => {
    const site = sites.find((candidate) => candidate.slug === slug);
    if (!site) return [];
    return axis === 'z'
      ? [{ site, x: line - 11.5, z: along, roadX: 1, roadZ: 0 }]
      : [{ site, x: along, z: line - 11.5, roadX: 0, roadZ: 1 }];
  });

/**
 * Twenty bays in street order, which is a choice and not the sites' numbering: every site on the
 * first leg has a live link, so the first E a visitor presses opens a real site.
 */
export const BAYS: readonly Bay[] = [
  // Leg A, Beauty Row.
  ...leg('z', L, [
    ['makeup-by-thelma', 72],
    ['the-barber-at-rafters-hairstyles', 58],
    ['cutting-crew-hair-studio', 44],
    ['shara-hair-and-beauty-unisex-salon', 30],
    ['la-mich-hair-and-beauty-salon', 16],
  ]),
  // Leg B, Salon Mile.
  ...leg('x', 0, [
    ['beauty-by-bb-salon', 88],
    ['narcisse-barber-shop', 71],
    ['rocher-hair-studio', 54],
    ['mellow-spa-sandton', 37],
    ['studio-29-hair-beauty-and-nail-salon', 20],
  ]),
  // Leg C, High Street.
  ...leg('z', 0, [
    ['opulent-dental-studio', -32],
    ['jansens-meat-market', -46],
    ['state-attorney-johannesburg', -60],
    ['eden-barbershop', -74],
    ['azania-hair-boutique', -88],
  ]),
  // Leg D, Motor Mile.
  ...leg('x', -L, [
    ['mavunela-plumbers', -8],
    ['se-mechanical-repairs-and-fitment', -25],
    ['jtrading-electrical-services', -42],
    ['gardean-auto-and-diagnostics', -59],
    ['ilan-motors-cc', -76],
  ]),
];

/** A site's board, measured from the centre of its bay's pad. It stands at yaw FACE. */
export const BOARD = {
  /** To the middle of its foot: 7 m up-screen. */
  x: -4.95,
  z: -4.95,
  /** The poster, and the height of its bottom edge. */
  width: 9,
  height: 5.625,
  bottom: 0.5,
  /** What the car hits, standing on the ground. */
  solid: { width: 9.5, height: 6.25, depth: 0.4 },
};

/* ------------------------------------------------------------------- pads */

const BLUE = '#2997ff';
const CV_PDF = '/assets/CV Brandon van Vuuren.pdf';

function sitePad({ site, x, z }: Bay): Pad {
  const nn = String(site.num).padStart(2, '0');
  // A slug without a live site still gets its pad: the gallery link stays, and E does nothing.
  const live: string | undefined = siteLinks[site.slug];
  const [focusX, focusZ] = upScreen(x, z, 3);
  return {
    id: `site:${site.slug}`,
    kind: 'site',
    x,
    z,
    radius: 5.5,
    focusX,
    focusZ,
    label: `${nn}  ${site.name}`,
    kicker: `Site ${nn} of ${sites.length}`,
    title: site.name,
    body: '',
    tags: [],
    image: site.card,
    links: [
      ...(live ? [{ label: 'View website', href: live, primary: true, download: false }] : []),
      {
        label: `All ${site.images.length} screens`,
        href: `/#site-${site.slug}`,
        primary: false,
        download: false,
      },
    ],
    open: live ?? null,
    accent: BLUE,
  };
}

/** A pad that is one link out: Axiom, and the three ways to reach Brandon. */
const linkPad = (
  source: { name: string; cta: string; url: string; accent: string },
  rest: Pick<Pad, 'id' | 'x' | 'z' | 'radius' | 'focusX' | 'focusZ' | 'kicker' | 'body' | 'tags'>,
): Pad => ({
  ...rest,
  kind: 'link',
  label: source.name,
  title: source.name,
  image: null,
  links: [{ label: source.cta, href: source.url, primary: true, download: false }],
  open: source.url,
  accent: source.accent,
});

/** A contact pad on the finish plaza, framed 2 m up-screen of its centre. */
const contactPad = (id: string, x: number, z: number, body: string): Pad => {
  const profile = byId(profiles, id);
  const [focusX, focusZ] = upScreen(x, z, 2);
  return linkPad(profile, {
    id,
    x,
    z,
    radius: 4.5,
    focusX,
    focusZ,
    kicker: profile.handle,
    body,
    tags: [],
  });
};

/** Every client site shipped: the twenty with a bay, and the rest in the directory. */
export const SHIPPED = sites.length + moreSites.length;

/** The directory's sites in category order: the panel puts a heading where each group starts. */
export const DIRECTORY_GROUPS = moreSiteCategories.map(
  (category) => [category, moreSites.filter((site) => site.category === category)] as const,
);

/**
 * The sites without a bay, as one pad beside the Axiom forecourt on a slab of its own. Nothing
 * single to open, so no E: the panel is the list.
 */
const directoryPad = (x: number, z: number): Pad => {
  const [focusX, focusZ] = upScreen(x, z, 3);
  return {
    id: 'directory',
    kind: 'link',
    x,
    z,
    radius: 5.5,
    focusX,
    focusZ,
    label: 'DIRECTORY',
    kicker: `${moreSites.length} more live sites`,
    title: 'The rest of the street',
    body: 'Every other site that went live, grouped by kind. Pick one and it opens in a new tab.',
    tags: moreSiteCategories,
    image: null,
    links: DIRECTORY_GROUPS.flatMap(([, group]) =>
      group.map(({ name, url }) => ({ label: name, href: url, primary: false, download: false })),
    ),
    open: null,
    accent: BLUE,
  };
};

/** 2.5 m clear of the forecourt and of the Avenue's verge, with the board 7 m up-screen of it. */
export const DIRECTORY = directoryPad(50.2, 27.6);

const venture = byId(ventures, 'axiom');

const PADS: readonly Pad[] = [
  ...BAYS.map(sitePad),
  // The forecourt spans the Avenue, so holding W crosses it. The focus sits towards the screen.
  linkPad(venture, {
    id: 'axiom',
    x: 28.6,
    z: 35,
    radius: 11,
    focusX: 20.9,
    focusZ: 35.7,
    kicker: venture.tagline,
    body: venture.blurb,
    tags: venture.tags,
  }),
  DIRECTORY,
  contactPad(
    'linkedin',
    -115.3,
    -98.3,
    'Career history, recommendations and the long version of the CV.',
  ),
  contactPad(
    'github',
    -122.3,
    -105.4,
    'Source for the projects on this site, and whatever else is in flight.',
  ),
  contactPad(
    'email',
    -98.3,
    -115.3,
    'Got something that needs building? Straight answer on scope and timing.',
  ),
  {
    id: 'cv',
    kind: 'cv',
    x: -103.9,
    z: -103.9,
    radius: 7,
    focusX: -106.8,
    focusZ: -106.8,
    label: 'CV',
    kicker: 'Finish line',
    title: 'Brandon van Vuuren — CV',
    body: 'The whole thing in PDF form: experience, education, stack.',
    tags: [],
    image: null,
    links: [
      { label: 'Open the PDF', href: CV_PDF, primary: true, download: false },
      { label: 'Download', href: CV_PDF, primary: false, download: true },
    ],
    open: CV_PDF,
    accent: BLUE,
  },
];

/** The Axiom screen, up-screen of the forecourt at yaw FACE. */
export const AXIOM = {
  /** televisionModern.glb, its screen on +Z: the middle of its foot, and its size at that scale. */
  tv: { x: 14.7, z: 31.3, scale: 12, width: 8.22, height: 5.46, depth: 1.54 },
  /** The demo reel: its plane on that face, and the still that covers it until the first frame. */
  video: {
    src: venture.video ?? '',
    poster: venture.poster ?? '',
    width: 8.02,
    height: 4.42,
    y: 3.14,
  },
};

/** The CV sheet, spinning above the finish pad. */
export const FINISH: XYZ = [-103.9, 4.2, -103.9];

/* --------------------------------------------------------------- hoardings */

/** Brandon, on repeat, wherever the road goes: headline and strap line. */
export const PITCHES: readonly (readonly [string, string])[] = [
  ['BRANDON VAN VUUREN', 'Full-stack & AI engineer'],
  ['AVAILABLE FOR WORK', 'brandon.vanvuuren60@gmail.com'],
  [`${SHIPPED} SITES SHIPPED`, 'Design, build, handover'],
  ['REACT · .NET · PYTHON', 'Front to back, then deployed'],
  ['.NET 4 → .NET 8', 'Legacy migrations that stay migrated'],
  ['AI THAT SHIPS', 'Models wired into real features'],
  ['BUILT BY AXIOM', 'axiom-billing.vercel.app'],
  ['HIRE ME', 'Fast turnaround. Clean code.'],
];

/** Where each pitch stands at yaw FACE, in the order of PITCHES. The first carries the portrait. */
export const HOARDINGS: readonly XZ[] = [
  [70.7, 89.1],
  [-114.5, -84],
  [93, -30],
  [60, 91],
  [-11, 24],
  [-92, -11.5],
  [35.4, 15.6],
  [20, -116],
];

/* ------------------------------------------------------------ ground paint */

/** Lettering on the ground at yaw FACE, and where its middle goes. */
export type GroundText = readonly [text: string, x: number, z: number, fact?: string];

/**
 * District and toy names. An entry with a fact is a year on Career Road: painted larger, across
 * the tarmac, with the fact as one line under it.
 */
export const GROUND_TEXT: readonly GroundText[] = [
  ['DRIVE MY CV', 112.8, 112.8],
  ['CV ↑', 96.9, 96.9],
  ['CLIENT WORK', 104, 94],
  ['BEAUTY ROW', 104, 82],
  ['SALON MILE', 92, 0],
  ['HIGH STREET', 0, -22],
  ['MOTOR MILE', -14, -104],
  ['PLAYGROUND', -30, 0],
  ['KICKER', -31, -11],
  ['BOWLING', -74, -11],
  ['SEESAW', -48, -33],
  ['WRECKING BALL', -82, -24],
  ['CRATES', -88, -66],
  ['JUMP', -104, -26],
  ['SKATE PARK', 0, 62],
  ['TUNNEL', 84, -104],
  ['MAZE', 90, -55],
  ['2022', -22.6, -22.6, 'BSc IT, North-West University'],
  ['2024', -41, -41, 'Internship, NWU'],
  ['2025', -59.4, -59.4, 'Systems Engineer, BCMTrac'],
  ['NOW', -77.8, -77.8, `.NET 4 to .NET 8, ${SHIPPED} sites shipped`],
];

/* ---------------------------------------------------------------- surfaces */

/** A painted area. A line is stroked that wide, with round caps and joins. */
export type Surface =
  | { kind: 'disc'; colour: string; x: number; z: number; radius: number }
  | { kind: 'polygon'; colour: string; points: readonly XZ[] }
  | { kind: 'line'; colour: string; points: readonly XZ[]; width: number };

const TARMAC = '#5f6680';
const PLAZA = '#cfc8ba';
const SLAB = '#e6dfd2';

/**
 * Everything painted over the grass, in painting order, with the roads, the hub and the pad slabs
 * in their places: the map, its masks and the chart are each one loop over this list.
 *
 * The order is what lays the roads across the plazas, the forecourt across the Avenue and the
 * cream slabs over both. Axiom gets no slab: the forecourt is its slab.
 */
export const SURFACES: readonly Surface[] = [
  { kind: 'disc', colour: PLAZA, x: 107.5, z: 107.5, radius: 18 },
  { kind: 'disc', colour: PLAZA, x: -108.9, z: -108.9, radius: 20 },
  // The playground's clay, in the corner between Playground Road, Yard Lane and the Avenue.
  { kind: 'polygon', colour: '#d9a066', points: [[-20, -8], [-96, -8], [-96, -84]] },
  // The skate park's concrete.
  { kind: 'polygon', colour: '#b9c2d6', points: [[-62, 40], [-6, 40], [-6, 84], [-62, 84]] },
  ...ROADS.map((road): Surface => ({ kind: 'line', colour: TARMAC, ...road })),
  { kind: 'disc', colour: TARMAC, x: HUB.x, z: HUB.z, radius: HUB.radius },
  // The Axiom forecourt.
  {
    kind: 'polygon',
    colour: '#3d4466',
    points: [[27.6, 53], [45.3, 35.4], [26.2, 16.3], [8.5, 33.9]],
  },
  ...PADS.filter((pad) => pad.id !== 'axiom').map(
    (pad): Surface => ({ kind: 'disc', colour: SLAB, x: pad.x, z: pad.z, radius: pad.radius + 1 }),
  ),
  // Each bay's slab runs on to its road as an apron 11 m wide. It laps the same metre over the
  // tarmac that the disc does, so the two overlap the road instead of meeting it along a seam.
  ...BAYS.map(({ x, z, roadX, roadZ }): Surface => {
    const corner = (across: number, along: number): XZ => [
      x + along * roadX + across * roadZ,
      z + along * roadZ + across * roadX,
    ];
    return {
      kind: 'polygon',
      colour: SLAB,
      points: [corner(-5.5, 0), corner(5.5, 0), corner(5.5, 6.5), corner(-5.5, 6.5)],
    };
  }),
];

/* ------------------------------------------------------------- knockables */

/** One knockable letter block, standing at yaw FACE. */
export type Letter = readonly [char: string, colour: string, x: number, z: number];

/** A word across the screen at 2.2 m pitch, its middle a metres up the spine and l to its right. */
const word = (text: string, colour: string, a: number, l: number): Letter[] =>
  [...text].flatMap((char, i): Letter[] => {
    if (char === ' ') return [];
    const [x, z] = spine(a, l + (i - (text.length - 1) / 2) * 2.2);
    return [[char, colour, x, z]];
  });

/** BRANDON 10 m ahead of the spawn, and HIRE ME across the spine beyond the CV pad. */
export const LETTERS: readonly Letter[] = [
  ...word('BRANDON', BLUE, 10, 0),
  ...word('HIRE ME', '#f0b429', 318.5, 4),
];

/** The tools, as blocks you can drive into: name and brand colour. */
export const STACK: readonly (readonly [string, string])[] = [
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

/**
 * The middle of each stack pyramid's bottom row, at the plaza's shoulders: 4-3-2-1 with its rows
 * along world x. The first takes the first ten of STACK.
 */
export const STACKS: readonly XZ[] = [
  [99.7, 115.3],
  [115.3, 99.7],
];

/**
 * All 52 cones. Twelve zigzag half a metre either side of the spine, every 3 m from 20 m to
 * 53 m, so a car holding W takes each one. Then two flank the mouth of every bay, on its apron.
 */
export const CONES: readonly XZ[] = [
  ...Array.from({ length: 12 }, (_, i) => spine(20 + 3 * i, i % 2 ? 0.5 : -0.5)),
  ...BAYS.flatMap(({ x, z, roadX, roadZ }) =>
    [-5, 5].map((side): XZ => [x + 4.9 * roadX + side * roadZ, z + 4.9 * roadZ + side * roadX]),
  ),
];

/**
 * The brick wall: three free-standing sections one behind the other across the spine, at yaw
 * FACE. One wide wall kept its top rows standing as a lintel; sections this narrow fall whole.
 */
export const WALL: readonly XZ[] = [spine(58), spine(64), spine(70)];

/** The crate pyramid, 4-3-2-1 with its row along z, and the middle of the 3 x 3 x 3 cube. */
export const CRATES: { pyramid: XZ; cube: XZ } = { pyramid: [-58, -15], cube: [-90, -72] };

/** The playground's toys. Every one stands at least 9 m from the Avenue. */
export const TOYS: {
  /** Bowling: the ball, and ten pins in rows of 1 to 4 with the head pin towards it. */
  ball: XZ;
  pins: readonly XZ[];
  /** Twenty tiles on an arc, each turned to fall along it. */
  dominoes: readonly (readonly [x: number, z: number, yaw: number])[];
  /** The seesaw's pivot. The plank lies along x. */
  seesaw: XYZ;
  /** The wrecking ball: two posts, the rope's anchor on the beam between them, and its length. */
  wrecker: { posts: readonly XZ[]; anchor: XYZ; rope: number };
} = {
  ball: [-74, -16],
  pins: [0, 1, 2, 3].flatMap((row) =>
    Array.from({ length: row + 1 }, (_, i): XZ => [-74 + (i - row / 2) * 1.6, -40 - 1.6 * row]),
  ),
  dominoes: Array.from({ length: 20 }, (_, i) => {
    const angle = (i / 19) * 0.9 * Math.PI;
    return [-86 + 9 * Math.cos(angle), -58 + 9 * Math.sin(angle), -angle];
  }),
  seesaw: [-58, 1.2, -36],
  wrecker: { posts: [[-88, -25], [-88, -35]], anchor: [-88, 7.5, -30], rope: 5.5 },
};

/* -------------------------------------------------------------- structures */

/** The kicker in the playground, rising west, and the jump across Yard Lane, rising north. */
export const RAMPS = {
  kicker: ramp(-38, -15, 8, 17, 2, WEST),
  jump: ramp(-104, -40, 12, 17, 3, NORTH),
};

/**
 * The tunnel on East Loop. The camera side is a row of pillars, not a wall, so the near lane shows
 * under the roof; the ramp to the roof is behind it, where only someone looking will find it.
 */
export const TUNNEL: {
  roof: Box;
  wall: Box;
  pillars: readonly Box[];
  /** Joins the top of the ramp to the roof. */
  deck: Box;
  ramp: Wedge;
} = {
  roof: [53, 5.3, -104, 34, 0.6, 16],
  wall: [53, 2.5, -111, 34, 5, 2],
  pillars: [38, 45.5, 53, 60.5, 68].map((x): Box => [x, 2.5, -97, 2, 5, 2]),
  deck: [50, 5.3, -117, 8, 0.6, 10],
  ramp: [65, -118, 8, 22, 5.6, WEST],
};

/** Hedges low enough that the car's roof always shows. The way in is the gap in the east wall. */
export const MAZE: {
  height: number;
  walls: readonly (readonly [x: number, z: number, sizeX: number, sizeZ: number])[];
} = {
  height: 1.4,
  walls: [
    [80, -41.5, 1.4, 15],
    [80, -65.5, 1.4, 9],
    [44, -52, 1.4, 36],
    [62, -34, 36, 1.4],
    [62, -70, 36, 1.4],
    [72, -48, 1.4, 12],
    [62, -62, 22, 1.4],
    [52, -52, 1.4, 22],
    [62, -42, 22, 1.4],
    [66, -52, 1.4, 12],
  ],
};

/** The big quarter pipe and the small one, on the slab's east edge and rising west. */
export const SKATE: readonly Pipe[] = [
  [-34, 71, 16, 1.05, 22, 8, WEST],
  [-34, 50, 11, 1.15, 16, 7, WEST],
];

/** The beacon over each secret, by the secret's id. */
export const BEACONS: Record<'rooftop' | 'maze' | 'skate', XYZ> = {
  rooftop: [60, 7.4, -104],
  maze: [59, 2.4, -52],
  skate: [-50, 10, 71],
};

/**
 * A solid's outline on the ground: its centre, its width along local x and depth along local z,
 * and the yaw that turns them as Object3D.rotation.y does. At FACE the width runs screen-right.
 */
export type Footprint = readonly [x: number, z: number, width: number, depth: number, yaw: number];

/**
 * Every solid that stands on grass and not on a painted surface. The ground is flattened under
 * each and scenery keeps off it, or the hills would rise through the maze and the boards.
 */
export const FOOTPRINTS: readonly Footprint[] = [
  // The maze, out to the outside of its hedges.
  [62, -52, 37.4, 37.4, 0],
  // The tunnel's roof ramp with its deck, and the run-up at the ramp's foot.
  [61, -117, 30, 10, 0],
  [84, -118, 16, 8, 0],
  ...BAYS.map(
    ({ x, z }): Footprint => [x + BOARD.x, z + BOARD.z, BOARD.solid.width, BOARD.solid.depth, FACE],
  ),
  ...HOARDINGS.map(([x, z]): Footprint => [x, z, 10.4, 0.5, FACE]),
  // The directory's board is a hoarding, 7 m up-screen of its pad like a bay's.
  [DIRECTORY.x + BOARD.x, DIRECTORY.z + BOARD.z, 10.4, 0.5, FACE],
  [AXIOM.tv.x, AXIOM.tv.z, AXIOM.tv.width, AXIOM.tv.depth, FACE],
  // Nothing stands here: the car that drives on past the finish line has to coast to a stop on
  // level ground, and the hills at the plaza's edge tilted it to 18 degrees.
  [-136, -136, 24, 24, FACE],
];

/* ------------------------------------------------------------------ places */

const respawn = (name: string, x: number, z: number, degrees: number): Respawn => ({
  name,
  x,
  z,
  yaw: degrees * RAD,
});

const RESPAWNS: readonly Respawn[] = [
  respawn('the start', 109.6, 109.6, -135),
  respawn('beauty row', 104, 86, 180),
  respawn('salon mile', 96, 0, -90),
  respawn('axiom', 43.8, 43.8, -135),
  respawn('the hub', 9.9, 9.9, -135),
  respawn('high street', 0, -20, 180),
  respawn('motor mile', -4, -104, -90),
  respawn('career road', -14.1, -14.1, -135),
  respawn('the finish', -91.9, -91.9, -135),
  respawn('the playground', -26, 0, -90),
  respawn('the jump', -104, -12, 180),
  respawn('the skate park', -10, 71, -90),
  respawn('the tunnel', 86, -104, -90),
  respawn('the maze', 92, -55, -90),
];

export const WORLD: Places = {
  spawn: RESPAWNS[0],
  respawns: RESPAWNS,
  pads: PADS,
  secrets: [
    { id: 'rooftop', label: 'The roof of the tunnel', x: 60, z: -104, radius: 7, minY: 5.3 },
    { id: 'maze', label: 'The heart of the maze', x: 59, z: -52, radius: 5, minY: 0 },
    { id: 'skate', label: 'Over the big curve', x: -54, z: 71, radius: 8, minY: 6 },
  ],
};

/* ------------------------------------------------------------- test ground */

/**
 * The flat bench the car is tuned on: one fixture per test, each with a respawn that faces it,
 * far enough apart that no run meets another's.
 */
export const TEST_GROUND: {
  /** 3 m high and 12 m wide, rising north. */
  ramp10: Wedge;
  ramp17: Wedge;
  kerb: Box;
  /** A roof to drive under and on: the slab, its four posts, and the ramp to its south edge. */
  roof: Box;
  posts: readonly Box[];
  roofRamp: Wedge;
  /** Three wall sections at yaw 0, the middle of the 3 x 3 x 3 crate cube, and a line of cones. */
  walls: readonly XZ[];
  crates: XZ;
  cones: readonly XZ[];
  /** Unlit 2 m squares on the ground, to check that a colour reaches the screen unchanged. */
  card: readonly (readonly [colour: string, x: number, z: number])[];
} = {
  ramp10: ramp(40, -100, 12, 10, 3, NORTH),
  ramp17: ramp(70, -100, 12, 17, 3, NORTH),
  kerb: [100, 0.075, -60, 20, 0.15, 1],
  roof: [-40, 5.3, -66, 12, 0.6, 12],
  posts: [-45.7, -34.3].flatMap((x) => [-71.7, -60.3].map((z): Box => [x, 2.5, z, 0.6, 5, 0.6])),
  roofRamp: [-40, -49, 8, 22, 5.6, NORTH],
  walls: [[-80, -60], [-80, -66], [-80, -72]],
  crates: [-110, -60],
  cones: Array.from({ length: 12 }, (_, i): XZ => [-140, -20 - 4 * i]),
  card: [
    ['#f06a25', 8, -8],
    ['#ffffff', 10, -8],
    ['#101418', 12, -8],
  ],
};

const TEST_RESPAWNS: readonly Respawn[] = [
  respawn('start', 0, 0, 180),
  respawn('ramp10', 40, -20, 180),
  respawn('ramp17', 70, -20, 180),
  respawn('kerb', 100, -30, 180),
  respawn('roof', -40, -10, 180),
  respawn('wall', -80, 0, 180),
  respawn('crates', -110, 0, 180),
  respawn('cones', -140, 0, 180),
  respawn('pad', 150, -10, 180),
  // The pacing route starts here and stays inside x 0..460, z 294..513, clear of every fixture.
  respawn('open', 0, 300, 0),
];

export const TEST: Places = {
  spawn: TEST_RESPAWNS[0],
  respawns: TEST_RESPAWNS,
  pads: [
    {
      id: 'test',
      kind: 'link',
      x: 150,
      z: -40,
      radius: 6,
      focusX: 150,
      focusZ: -40,
      label: 'Test',
      kicker: 'Test ground',
      title: 'Test pad',
      body: '',
      tags: [],
      image: null,
      links: [],
      open: null,
      accent: BLUE,
    },
  ],
  secrets: [],
};

/**
 * sites.ts is generated from the screenshot folders, so it is the one layout fact that can
 * change behind the game's back: a new or renamed site has no bay until someone gives it one.
 */
export function assertLayout(): void {
  for (const site of sites) {
    const bays = BAYS.filter((bay) => bay.site === site).length;
    if (bays !== 1) throw new Error(`layout: ${site.slug} has ${bays} bays, and needs exactly one`);
  }
}
