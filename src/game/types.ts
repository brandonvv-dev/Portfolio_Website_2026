/**
 * The contract every game module is written against. Frozen when the core wave is accepted.
 * Content modules (src/game/content/*.ts) import this file, layout.ts, util.ts and kit.ts, and
 * never each other.
 *
 * Units are metres, seconds, radians and kilograms. +Y is up and the car's nose is +Z, so a yaw
 * of 0 faces +Z. The camera sits south-east of what it frames (azimuth PI / 4): up-screen is
 * (-x, -z), screen-right is (+x, -z), and anything meant to be read is authored at yaw FACE.
 */
import type {
  BufferGeometry,
  ColorRepresentation,
  IUniform,
  LoadingManager,
  Material,
  MeshBasicMaterial,
  MeshBasicMaterialParameters,
  MeshLambertMaterial,
  MeshLambertMaterialParameters,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import type { Collider, ColliderDesc, World } from '@dimforge/rapier3d-compat';

/** The Rapier module namespace, as the dynamic import returns it. */
export type Rapier = typeof import('@dimforge/rapier3d-compat');

/** Yaw that turns a poster, a sign or a letter to face the camera. */
export const FACE = Math.PI / 4;

/** World gravity. The car's springs, engine and brakes were benched at exactly this value. */
export const GRAVITY = -25.11;

/* ---------------------------------------------------------------- physics */

const WORLD = 1;
const PROP = 2;
const CHASSIS = 4;
const BUMPER = 8;

/** Rapier interaction groups: (membership << 16) | filter. */
export const GROUPS = {
  /** The static level, plus anything dynamic the car drives on (the seesaw plank). */
  world: (WORLD << 16) | WORLD | PROP | CHASSIS,
  prop: (PROP << 16) | WORLD | PROP | CHASSIS | BUMPER,
  chassis: (CHASSIS << 16) | WORLD | PROP,
  /** Sweeps props aside so they cannot wedge under the hull. Never touches the level. */
  bumper: (BUMPER << 16) | PROP,
} as const;

/** One hit on the car this frame. */
export interface Impact {
  /**
   * Closing speed, m/s: the contact impulse over the reduced mass of the pair. The same hit reads
   * the same at every refresh rate, a cone reads like a wall, and leaning on something reads 0.
   */
  speed: number;
  x: number;
  y: number;
  z: number;
}

export interface Physics {
  /** Adds a fixed collider to the level: world group, friction 1. */
  fixed(desc: ColliderDesc): Collider;
  /** Hits on the car this frame, hardest first. Entries from impactCount onwards are stale. */
  readonly impacts: readonly Impact[];
  readonly impactCount: number;
}

/** A class of knockable prop: one InstancedMesh, one rigid body per instance. */
export interface PropSpec {
  geometry: BufferGeometry;
  material: Material;
  /** Shared by every instance. The engine sets the group, the mass and the damping. */
  collider: ColliderDesc;
  capacity: number;
  /** Kilograms. Omitted: 15 kg per cubic metre, never under 10 kg. */
  mass?: number;
  /** Per second. Omitted: 0.1. Balls want 0.4 or they roll for ever. */
  angularDamping?: number;
  /** Adds the per-instance attribute aUv that a material made with LookOptions.atlas reads. */
  atlas?: boolean;
}

export interface Props {
  /** Call while the world is being built, before the loading settle. */
  define(kind: string, spec: PropSpec): void;
  /** Stands one instance at rest. uv is its atlas cell: offset in xy, scale in zw. */
  add(kind: string, x: number, y: number, z: number, yaw: number, uv?: Vector4): void;
  /** Props knocked since the page loaded. A prop that was rebuilt can count again. */
  readonly knocked: number;
  readonly total: number;
}

/* ------------------------------------------------------------------- look */

/**
 * GLSL spliced into the shared material patch at fixed anchors, so custom geometry (ground,
 * grass, swaying trees) keeps the two-tone light, the tinted shadow and the fog.
 *
 * The shared patch already declares every member of Uniforms in both stages, and the varying
 * vDrive (world position in xyz, view depth in w), which it writes after <project_vertex>.
 * A patch declares only its own attributes and varyings.
 */
export interface ShaderPatch {
  /** Program cache key: starts with the owning module's name, and equal keys mean equal GLSL. */
  key: string;
  /** Vertex declarations, after <common>. */
  vertexPars?: string;
  /** After <uv_vertex>: may rewrite vMapUv. */
  uv?: string;
  /** After <beginnormal_vertex>: may rewrite objectNormal. */
  normal?: string;
  /** After <begin_vertex>: may rewrite transformed. */
  position?: string;
  /** Fragment declarations, after <common>. */
  fragmentPars?: string;
  /** After <map_fragment>: may rewrite diffuseColor. */
  albedo?: string;
}

export interface LookOptions {
  patch?: ShaderPatch;
  /** Dithers the surface away where it would hide the car from the camera. */
  cutout?: boolean;
  /**
   * Reads map and emissiveMap through the per-instance attribute aUv (vec4: offset in xy, scale
   * in zw), so one atlas texture labels every instance.
   */
  atlas?: boolean;
}

/**
 * Uniforms shared by reference with every patched material. The object also carries the light,
 * sky and fog uniforms that the fragment chunk drive_common declares: hand the whole object to
 * a ShaderMaterial that includes that chunk and writes vDrive.
 */
export type Uniforms = {
  /** Seconds of simulation. */
  uTime: IUniform<number>;
  /** Wind on the ground: a fixed direction scaled by a gust strength of 0.2 to 1. */
  uWind: IUniform<Vector2>;
  /** The ground point the camera frames. Grass and leaves wrap around it. */
  uFocus: IUniform<Vector3>;
  /** Wheel tracks in the red channel, and the square they cover: centre x, centre z, side, 0. */
  uTracks: IUniform<Texture>;
  uTracksRect: IUniform<Vector4>;
  /** The painted world map: R paved, G grass, B flat. */
  uMasks: IUniform<Texture>;
  /** Ground height in metres, red channel. */
  uHeights: IUniform<Texture>;
  /** Side of the square both maps cover, centred on the origin. */
  uWorld: IUniform<number>;
};

export interface Look {
  readonly uniforms: Uniforms;
  /** Everything the sun lights: warm where lit, albedo times the violet tint in form and cast shadow. */
  lit(parameters?: MeshLambertMaterialParameters, options?: LookOptions): MeshLambertMaterial;
  /** Exact colour at 1.0, fogged: posters, the video, sign faces. */
  unlit(parameters?: MeshBasicMaterialParameters, options?: LookOptions): MeshBasicMaterial;
  /**
   * An emitter. With the HDR chain the colour is scaled to the given luminance, so every hue
   * blooms alike. Without it the colour is scaled until its brightest channel is 1, which keeps
   * the hue on a canvas that clips. Nothing else may exceed 1.2.
   */
  glow(color: ColorRepresentation, luminance: number): MeshBasicMaterial;
}

/* ---------------------------------------------------------------- quality */

/** Chosen once, before the renderer exists. Nothing switches tier afterwards. */
export type Tier = 'high' | 'low';

export interface Quality {
  /** Half-float output chain with bloom and tilt-shift. False renders straight to the canvas. */
  hdr: boolean;
  shadowSize: number;
  /** Penumbra, in shadow texels. */
  shadowRadius: number;
  /** Caps on the drawing buffer: device pixel ratio, and megapixels. */
  pixelRatio: number;
  megapixels: number;
  /** Blades along one side of the grass patch. */
  grass: number;
  /** Side of the wheel-track target, pixels. */
  tracks: number;
  leaves: number;
  particles: number;
  /** Width the 1024 x 640 board images are uploaded at. */
  boardWidth: number;
  anisotropy: number;
}

export const QUALITY: Record<Tier, Quality> = {
  high: {
    hdr: true,
    shadowSize: 2048,
    shadowRadius: 3,
    pixelRatio: 2,
    megapixels: 3.7,
    grass: 280,
    tracks: 512,
    leaves: 1024,
    particles: 800,
    boardWidth: 1024,
    anisotropy: 8,
  },
  low: {
    hdr: false,
    shadowSize: 1024,
    shadowRadius: 2,
    pixelRatio: 1.5,
    megapixels: 2.1,
    grass: 140,
    tracks: 256,
    leaves: 256,
    particles: 150,
    boardWidth: 512,
    anisotropy: 4,
  },
};

/* ----------------------------------------------------------------- places */

export interface Respawn {
  name: string;
  x: number;
  z: number;
  yaw: number;
}

export interface PadLink {
  label: string;
  href: string;
  /** Drawn as the button rather than as a text link. */
  primary: boolean;
  /** Saves the file instead of navigating, so it keeps its place in the page. */
  download: boolean;
}

export type PadKind = 'site' | 'link' | 'cv';

/** A disc on the ground that shows a panel while the car is on it. */
export interface Pad {
  /** 'site:<slug>', 'axiom', 'linkedin', 'github', 'email', 'cv' or 'directory'. */
  id: string;
  kind: PadKind;
  x: number;
  z: number;
  radius: number;
  /** The ground point the camera frames while the car is parked here. */
  focusX: number;
  focusZ: number;
  /** Painted on the pad: the site's number and name, or the pad's own name. */
  label: string;
  kicker: string;
  title: string;
  body: string;
  tags: readonly string[];
  image: string | null;
  links: readonly PadLink[];
  /** What E opens. Null when the pad has no live link: no prompt, and E does nothing. */
  open: string | null;
  accent: string;
}

/** Somewhere to find. minY keeps a rooftop secret from firing in the tunnel underneath it. */
export interface Zone {
  id: string;
  label: string;
  x: number;
  z: number;
  radius: number;
  minY: number;
}

export interface Places {
  spawn: Respawn;
  respawns: readonly Respawn[];
  pads: readonly Pad[];
  secrets: readonly Zone[];
}

/** Ground queries. The textures behind them travel in Uniforms. */
export interface Terrain {
  /** Height of the ground at a point, on the same triangles the mesh and the collider use. */
  heightAt(x: number, z: number): number;
  /** One painted channel at a point, 0 to 1. Channel 0 is paved, 1 grass, 2 flat. */
  mask(x: number, z: number, channel: 0 | 1 | 2): number;
}

/* ------------------------------------------------------------------ state */

/** What the driver is asking for, sampled once per frame. */
export interface InputState {
  /** -1 full reverse to 1 full throttle. */
  throttle: number;
  /** -1 full right to 1 full left. Exactly 0 when the driver is not steering. */
  steer: number;
  brake: boolean;
  boost: boolean;
}

export interface Input {
  readonly state: InputState;
  /**
   * What E does. The input module calls it inside the E keydown; the panels module assigns it
   * and calls the same function from its own Open button's click. Never call it from the frame,
   * the event bus or a timer: a tab opened outside a user gesture is a popup and gets blocked.
   */
  onInteract: () => void;
}

export interface WheelState {
  contact: boolean;
  /** World contact point. Stale while contact is false. */
  point: Vector3;
  /** Suspension length, metres. */
  length: number;
  /** Rolling angle, radians. */
  spin: number;
  steer: number;
}

/** The car as the last physics step left it. Written by the car module, read by everyone. */
export interface CarState {
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  /** Horizontal speed, m/s. Vertical velocity is never zero on a ray-cast car, even parked. */
  speed: number;
  /** Signed along the nose, m/s. */
  forwardSpeed: number;
  yaw: number;
  /** World Y of the car's up axis: 1 upright, -1 on the roof. */
  upY: number;
  /** Front-left, front-right, rear-left, rear-right. */
  wheels: readonly [WheelState, WheelState, WheelState, WheelState];
  wheelsDown: number;
  /** Seconds since any wheel last touched. 0 on the ground. */
  airTime: number;
  /** Height of the last wheel contact: the tunnel roof, not the road under it. */
  groundY: number;
  /**
   * How far the car is sliding sideways, radians: atan2(|speed across the nose|, |speed along
   * it|). 0 when rolling straight in either direction, and 0 below 0.5 m/s.
   */
  slip: number;
  braking: boolean;
  reversing: boolean;
  boosting: boolean;
}

export type ViewMode = 'iso' | 'chase';

/** What the camera frames. Written by the camera module. */
export interface ViewState {
  mode: ViewMode;
  focus: Vector3;
  /**
   * Centre and radius of the circle of ground on screen at the widest zoom. The radius changes
   * only on a resize or a view switch, never with the zoom: the shadow box is sized from it.
   */
  centre: Vector3;
  radius: number;
  /** Distance from the camera to the nearest and farthest ground on screen. */
  near: number;
  far: number;
  /** Half the width of ground on screen at the focus. */
  halfWidth: number;
}

export type Phase = 'loading' | 'intro' | 'driving';

export interface GameState {
  phase: Phase;
  /** Seconds of simulation since the loop began. Advances by exactly each frame's dt. */
  time: number;
  /** The pad whose panel is up: the one under the car, or the last one for 3 s after leaving it. */
  pad: Pad | null;
  /** True only while the car is physically on a pad. */
  onPad: boolean;
  /** Rung of the quality ladder, 0 best. Only pixel ratio and grass density follow it. */
  level: number;
}

/** Survives a reload. Mutate, then call save. */
export interface Saved {
  muted: boolean;
  chase: boolean;
  /** Slugs of the sites whose pad has been visited. */
  sites: string[];
  /** Ids of the secrets found. */
  secrets: string[];
  /** Best Handover Run, milliseconds. 0 until one is finished. */
  lapMs: number;
}

export interface Store {
  readonly saved: Saved;
  save(): void;
}

/* ----------------------------------------------------------------- events */

export type SoundId = 'horn' | 'chime' | 'award';

/** Discrete facts, delivered synchronously. Per-frame data lives in the state structs instead. */
export interface GameEvents {
  /** Inside the Start click: the one gesture that may start audio and video. */
  start: [];
  /** Asks for the car to be put back on a named respawn, or on the nearest when null. */
  reset: [respawn: string | null];
  /** Puts the car down at once, no fade: y is metres above the ground. The debug hook only. */
  place: [x: number, y: number, z: number, yaw: number, roll: number];
  /** The car was moved by reset or place: snap whatever was following it. */
  respawn: [at: Respawn];
  /** GameState.pad changed. */
  pad: [pad: Pad | null];
  /** A prop left its rest pose. */
  knock: [kind: string];
  /** Wheels back on the ground after airTime seconds. */
  land: [airTime: number];
  toast: [id: string, title: string, body: string];
  sound: [id: SoundId];
  /** Asks the camera to switch between its two views. */
  camera: [];
}

export interface Events {
  on<K extends keyof GameEvents>(type: K, listener: (...args: GameEvents[K]) => void): void;
  emit<K extends keyof GameEvents>(type: K, ...args: GameEvents[K]): void;
}

/* -------------------------------------------------------------- lifecycle */

/** Everything except the ground, which is built from it. */
export interface BaseContext {
  readonly rapier: Rapier;
  readonly world: World;
  readonly physics: Physics;
  readonly props: Props;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly look: Look;
  readonly tier: Tier;
  readonly quality: Quality;
  /** Feeds the loading bar: build every loader on it. */
  readonly loading: LoadingManager;
  readonly places: Places;
  readonly input: Input;
  readonly car: CarState;
  readonly view: ViewState;
  readonly state: GameState;
  readonly events: Events;
  readonly store: Store;
}

export interface GameContext extends BaseContext {
  readonly terrain: Terrain;
}

/**
 * What a module's factory hands back. Both hooks are optional, and main.ts calls them in the
 * order of its module list, which is the frame order.
 *
 * There is no dispose: /drive is a whole page, leaving it unloads everything, and tearing down on
 * pagehide would hand a dead canvas to a back-forward cache restore.
 */
export interface GameModule {
  /** Once per physics substep, before the world steps. h is the substep, 4 to 10 ms. */
  substep?(h: number): void;
  /** Once per rendered frame, after physics. dt is the frame's clamped delta. */
  update?(dt: number): void;
}

/** Builds the ground and fills uMasks, uHeights and uWorld. Runs before any module exists. */
export type GroundFactory = (ctx: BaseContext) => Terrain | Promise<Terrain>;

/** Every file in src/game/content default-exports one of these. */
export type ModuleFactory = (ctx: GameContext) => GameModule | Promise<GameModule>;
