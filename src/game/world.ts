import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sites, type Site } from '../data/sites';
import type { PropLibrary } from './props';
import { dressWorld, labelBlock, type Spot } from './dressing';
import { createSky, DAY, NIGHT } from './sky';
import { stabilise } from './solver';

export type { Spot };

export interface Board {
  site: Site;
  position: THREE.Vector3;
  /** Yaw of the pad. Local +Z is the side you drive in from. */
  yaw: number;
  /** Half-extents in pad-local X and Z. */
  half: { x: number; z: number };
}

/**
 * A knockable prop. `home` is latched the moment this prop first falls asleep,
 * which is the only reliable definition of "where it ended up": the drop-in
 * scatters stacks, so the authored mark is not where things actually rest.
 */
interface Prop {
  mesh: THREE.Object3D;
  body: CANNON.Body;
  home: CANNON.Vec3;
  woken: boolean;
  settled: boolean;
  knocked: boolean;
}

/** Something hidden that the player can find by exploring. */
export interface Secret {
  id: string;
  label: string;
  position: THREE.Vector3;
  radius: number;
  found: boolean;
}

export interface WorldBits {
  boards: Board[];
  /** Drive-on pads that link out: Axiom, LinkedIn, GitHub, email. */
  spots: Spot[];
  /** Kicks off the Axiom demo reel; needs a user gesture. */
  playVideo: () => void;
  sun: THREE.DirectionalLight;
  /**
   * Unit vector towards the sun. The shadow frustum has to be re-hung over
   * the car every frame, and it must be hung along this or the shadows stop
   * agreeing with the sky they came from.
   */
  sunDir: THREE.Vector3;
  /** Solid things the chase camera must not end up behind. */
  blockers: THREE.Object3D[];
  cv: { position: THREE.Vector3; radius: number };
  /** Named places the car can be put back to, nearest-first on reset. */
  respawns: { name: string; position: THREE.Vector3; yaw: number }[];
  /** Tucked-away spots that only turn up if you go looking. */
  secrets: Secret[];
  /** How many props have been shoved off their mark, and how many exist. */
  score: () => { knocked: number; total: number };
  /** Day to night: sun, sky, fog and the lit signage all move together. */
  setNight: (on: boolean) => void;
  /** Lower-cost mode for phones and weak GPUs. */
  setQuality: (level: 'high' | 'low') => void;
  update: (elapsed: number, carPos?: THREE.Vector3) => void;
  /** Rains the props in from the sky, staggered, once the player starts. */
  start: () => void;
}

/** Square arena with room to keep driving past every zone. */
const ARENA = { hx: 130, hz: 150, cz: -20 };
const PAD = { w: 14, d: 9 };
const POSTER_W = 11;

/**
 * Props are authored at their resting height and spawned this far above it.
 * Kept small on purpose: dropped from any real height a stacked wall or
 * pyramid detonates on landing and there is nothing left to knock over.
 */
const DROP = 3.5;

/**
 * Fog per metre. At this arena's 260x300 the far wall sits at roughly 0.45
 * haze, so distance reads without the near zones going milky.
 */
const FOG_DENSITY = 0.0022;
/** Weak hardware draws less, and thicker haze covers the shorter draw. */
const FOG_DENSITY_LOW = 0.0042;

/**
 * Where each zone sits. The avenue runs -Z from the start plaza.
 *
 * Mind the spacing: avenue pads are yawed 90 degrees, so a pad's *width*
 * (PAD.w) runs along the road, not its depth. Rows closer together than
 * PAD.w overlap into each other and the painted names run together.
 */
const AVENUE = { x: 20, z0: 92, gap: 20, rows: 5 };
const ROUNDABOUT = { x: 0, z: -60, r: 50, pad: 62 };
const COURTYARD = { x: 86, z: 26, r: 28 };
const PLAY = { x: -82, z: 30 };
const CV_Z = -140;

/* ------------------------------------------------------------------ helpers */

/** Crisp label plate drawn on a 2D canvas. */
function labelTexture(title: string, sub: string) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = 'rgba(14,16,20,0.9)';
  ctx.roundRect(0, 0, c.width, c.height, 34);
  ctx.fill();
  ctx.strokeStyle = '#2997ff';
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 78px Inter, system-ui, sans-serif';
  ctx.fillText(title, c.width / 2, 112, c.width - 90);

  ctx.fillStyle = '#6cc0ff';
  ctx.font = '600 46px Inter, system-ui, sans-serif';
  ctx.fillText(sub, c.width / 2, 186, c.width - 90);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Text painted onto the tarmac. Instructions on the floor are most of what
 * makes a driving playground feel authored rather than generated.
 */
function decal(text: string, width: number, height: number, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round((height / width) * 1024);
  const ctx = c.getContext('2d')!;

  ctx.translate(c.width / 2, c.height / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.font = `800 ${Math.round(c.height * 0.62)}px Inter, system-ui, sans-serif`;
  ctx.globalAlpha = 0.82;
  ctx.fillText(text, 0, 0, c.width * 0.94);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * Light tarmac with a faint grid, generated rather than downloaded.
 *
 * The mottling matters more than it looks like it should: a perfectly flat
 * colour under a single directional light reads as untextured plastic, and no
 * amount of shadow map resolution fixes that. Dirtying it a little is what
 * makes the ground look painted.
 */
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9aa0ab';
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 2 + Math.random() * 11;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(40,46,56,0.05)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 256, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ARENA.hx / 2, ARENA.hz / 2);
  return tex;
}

/* -------------------------------------------------------------------- build */

export function buildWorld(
  scene: THREE.Scene,
  world: CANNON.World,
  groundMaterial: CANNON.Material,
  loader: THREE.TextureLoader,
  lib: PropLibrary,
  // The sky bakes an environment map and samples its own horizon, both of
  // which are GPU work, so the world needs the renderer now.
  renderer: THREE.WebGLRenderer,
  maxAnisotropy = 8
): WorldBits {
  const props: Prop[] = [];
  const spinners: { mesh: THREE.Object3D; speed: number; bob: number }[] = [];
  const blockers: THREE.Object3D[] = [];
  const secrets: Secret[] = [];
  const respawns: { name: string; position: THREE.Vector3; yaw: number }[] = [];
  /** Constraint-driven bodies: the seesaw and the wrecking ball. */
  const dynamics: { mesh: THREE.Object3D; body: CANNON.Body }[] = [];

  /**
   * Objects that fade in as the car approaches.
   *
   * Showing everything at full strength from anywhere turns the arena into a
   * wall of competing signage; revealing a board's detail only once you are
   * near it is what makes the place read as somewhere you move through rather
   * than a menu laid out flat.
   */
  const fades: {
    obj: THREE.Object3D;
    mats: THREE.Material[];
    near: number;
    far: number;
    /** Scale up on approach as well as fade in. */
    pop: boolean;
    /** Authored scale, kept whole: sprites here are not square. */
    base: THREE.Vector3;
    shown: number;
  }[] = [];

  const registerFade = (obj: THREE.Object3D, near: number, far: number, pop = false) => {
    const mats: THREE.Material[] = [];
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        mat.transparent = true;
        // Fading geometry cannot claim the depth buffer, or whatever is behind
        // it disappears for the frames where it is half-there.
        mat.depthWrite = false;
        mats.push(mat);
      }
    });
    if (!mats.length) return;
    obj.visible = false;
    fades.push({ obj, mats, near, far, pop, base: obj.scale.clone(), shown: 0 });
  };

  /**
   * Adds a prop parked in the sky above `rest`, held asleep until start().
   * A sleeping body does not integrate, so it hangs there rather than falling.
   */
  const addProp = (
    mesh: THREE.Object3D,
    shape: CANNON.Shape,
    rest: [number, number, number],
    mass: number
  ) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Positioned at construction, like the static bodies: a body parked asleep
    // never integrates, so it would keep the origin-centred AABB it was built
    // with right up until something woke it.
    const body = new CANNON.Body({
      mass,
      shape,
      material: groundMaterial,
      position: new CANNON.Vec3(rest[0], rest[1] + DROP, rest[2]),
    });
    body.updateAABB();
    // Sleep thresholds tuned for stacking: cannon's defaults let a pyramid
    // creep for a full second before settling, and it unstacks itself.
    stabilise(body);
    body.sleep();
    world.addBody(body);

    props.push({
      mesh,
      body,
      home: new CANNON.Vec3(rest[0], rest[1], rest[2]),
      woken: false,
      settled: false,
      knocked: false,
    });
  };

  /**
   * Static bodies must be told where they are *before* their bounding box is
   * worked out. Constructing one and then moving it leaves the AABB sitting at
   * the origin with `aabbNeedsUpdate` already cleared, so the broadphase never
   * returns it — the body is solid in principle and transparent in practice,
   * and the car drives straight through it.
   */
  const addStatic = (mesh: THREE.Mesh, shape: CANNON.Shape, quat?: CANNON.Quaternion) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const body = new CANNON.Body({
      mass: 0,
      shape,
      material: groundMaterial,
      position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
      quaternion: quat,
    });
    body.updateAABB();
    world.addBody(body);
  };

  // --- Sky, light, fog ---------------------------------------------------

  // Scattering model, the environment light baked off it, and the horizon
  // colour sampled from it. See sky.ts for why those three travel together.
  const sky = createSky(scene, renderer);

  /**
   * Exponential fog, not linear.
   *
   * Real distance haze accumulates per metre, so contrast falls away smoothly
   * from the very first metre; linear near/far switches the effect on at a
   * plane, which is why the far side of the arena used to look like it had
   * weather rather than distance. The colour comes off the sky itself, so
   * distant trees dissolve into the horizon instead of standing against it.
   */
  scene.fog = new THREE.FogExp2(sky.horizon.getHex(), FOG_DENSITY);

  // Deliberately small. With `scene.environment` carrying the sky, a
  // hemisphere light at its old 2.2 is counting the same bounce twice and
  // flattens everything it touches. This is a nudge in the shadows, no more.
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x6b7280, 0.3);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
  // Aimed from wherever the sky says the sun is, so the shadows and the bright
  // patch of sky finally agree with each other.
  sun.position.copy(sky.sunDirection).multiplyScalar(90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  // Tight frustum for crisp shadows: main.ts keeps it centred on the car,
  // otherwise anything past its edge renders unlit.
  const s = 55;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // --- Ground ------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA.hx * 2, ARENA.hz * 2),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = ARENA.cz;
  ground.receiveShadow = true;
  scene.add(ground);

  // A slab, not an infinite CANNON.Plane: a rotated Plane's world AABB comes
  // out wrong, so the broadphase never returns it to a raycast and the
  // vehicle's wheels find no ground at all.
  const groundBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(ARENA.hx, 1, ARENA.hz)),
    material: groundMaterial,
  });
  groundBody.position.set(0, -1, ARENA.cz); // top face sits exactly at y = 0
  world.addBody(groundBody);

  // --- Painted roads -----------------------------------------------------
  const tarmac = new THREE.MeshStandardMaterial({ color: 0x8b919c, roughness: 0.95 });

  const road = (x: number, z: number, w: number, l: number, yaw = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, l), tarmac);
    mesh.rotation.set(-Math.PI / 2, 0, 0);
    mesh.rotateZ(-yaw);
    mesh.position.set(x, 0.01, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };

  road(0, 30, 20, 220); // the avenue, start plaza down to the roundabout
  road(COURTYARD.x / 2, 26, 110, 18, Math.PI / 2); // spur east to the courtyard
  road(PLAY.x / 2, 30, 110, 18, Math.PI / 2); // spur west to the playground
  road(0, CV_Z + 24, 20, 70); // roundabout down to the finish

  // Ring road around the roundabout island
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(ROUNDABOUT.r - 13, ROUNDABOUT.r + 9, 48),
    tarmac
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(ROUNDABOUT.x, 0.011, ROUNDABOUT.z);
  ring.receiveShadow = true;
  scene.add(ring);

  // Centre lines down the avenue
  for (let i = 0; i < 30; i++) {
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 3),
      new THREE.MeshBasicMaterial({ color: 0xf2f4f7 })
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.02, 124 - i * 5.5);
    scene.add(dash);
  }

  // Grass island in the middle of the roundabout
  const island = new THREE.Mesh(
    new THREE.CircleGeometry(ROUNDABOUT.r - 14, 40),
    new THREE.MeshStandardMaterial({ color: 0x74996a, roughness: 0.95 })
  );
  island.rotation.x = -Math.PI / 2;
  island.position.set(ROUNDABOUT.x, 0.012, ROUNDABOUT.z);
  island.receiveShadow = true;
  scene.add(island);

  // Nothing solid in the middle of the island. Static, it is a dead stop on
  // the centre line; knockable, the car climbs the toppled cylinder and
  // beaches on it. Paint the centrepiece on the grass instead.
  const crest = decal('BvV', 26, 14, '#e8f0e6');
  crest.position.set(ROUNDABOUT.x, 0.02, ROUNDABOUT.z);
  scene.add(crest);

  // --- Perimeter walls ---------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8ebf0, roughness: 0.8 });
  const barrier = (half: number, x: number, z: number, yaw: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 3, 1), wallMat);
    mesh.position.set(x, 1.5, z);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const quat = new CANNON.Quaternion();
    quat.setFromEuler(0, yaw, 0);
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(half, 1.5, 0.5)),
      material: groundMaterial,
      position: new CANNON.Vec3(x, 1.5, z),
      quaternion: quat,
    });
    body.updateAABB();
    world.addBody(body);
    blockers.push(mesh);
  };
  barrier(ARENA.hx, 0, ARENA.cz - ARENA.hz, 0);
  barrier(ARENA.hx, 0, ARENA.cz + ARENA.hz, 0);
  barrier(ARENA.hz, -ARENA.hx, ARENA.cz, Math.PI / 2);
  barrier(ARENA.hz, ARENA.hx, ARENA.cz, Math.PI / 2);

  // --- Signposting painted on the floor ----------------------------------
  const plaza = new THREE.Group();
  plaza.add(decal('DRIVE MY CV', 30, 5));
  const sub = decal('WASD / ARROWS', 18, 2.6, '#1d2430');
  sub.position.set(0, 0.01, 6);
  plaza.add(sub);
  for (let i = 0; i < 3; i++) {
    const arrow = decal('▲', 3.4, 3.4, '#2997ff');
    arrow.position.set(0, 0.01, -7 - i * 5);
    plaza.add(arrow);
  }
  plaza.position.set(0, 0.03, 118);
  scene.add(plaza);

  const sign = (text: string, w: number, x: number, z: number, yaw = 0) => {
    const d = decal(text, w, w * 0.16, '#1d2430');
    d.position.set(x, 0.04, z);
    d.rotateZ(-yaw);
    scene.add(d);
  };
  sign('◀  PLAYGROUND', 34, -36, 26);
  sign('COURTYARD  ▶', 34, 36, 26);
  sign('ROUNDABOUT  ▲', 30, 0, -4);
  sign('FINISH  ▲', 22, 0, CV_Z + 34);

  /* ------------------------------------------------------------- boards */

  const boards: Board[] = [];
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f9, roughness: 0.7 });
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x2997ff,
    roughness: 0.4,
    metalness: 0.3,
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a5261, roughness: 0.8 });

  /**
   * One site pad: the screenshot on the tarmac, a kerb around it, the name
   * painted at the near edge, and the billboard standing at the far edge.
   * Local +Z is the approach side, so the whole thing just gets yawed.
   */
  const placeBoard = (site: Site, x: number, z: number, yaw: number) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;

    const tex = loader.load(site.board);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Without this the poster is read at an angle and smears; it is the single
    // biggest difference between a crisp billboard and a blurry one.
    tex.anisotropy = maxAnisotropy;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(PAD.w, PAD.d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0 })
    );
    panel.rotation.x = -Math.PI / 2;
    panel.position.y = 0.04;
    panel.receiveShadow = true;
    group.add(panel);

    for (const [kw, kd, kx, kz] of [
      [PAD.w + 1, 0.5, 0, PAD.d / 2 + 0.25],
      [PAD.w + 1, 0.5, 0, -PAD.d / 2 - 0.25],
      [0.5, PAD.d, PAD.w / 2 + 0.25, 0],
      [0.5, PAD.d, -PAD.w / 2 - 0.25, 0],
    ]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(kw, 0.22, kd), kerbMat);
      kerb.position.set(kx, 0.11, kz);
      kerb.receiveShadow = true;
      group.add(kerb);
    }

    // Painted on the floor rather than floating above it: twenty billboards
    // stacked down one road overlap into an unreadable wall from any distance.
    const name = decal(
      `${String(site.num).padStart(2, '0')}  ${site.name.toUpperCase()}`,
      PAD.w,
      1.9,
      '#141a22'
    );
    name.position.set(0, 0.06, PAD.d / 2 + 1.6);
    group.add(name);

    // Upright poster on the far edge, facing the way you drive in. Flat on the
    // tarmac a screenshot is seen at a grazing angle and reads as a smear.
    const PH = POSTER_W * 0.625;
    const back = -PAD.d / 2 - 1.2;

    const poster = new THREE.Mesh(
      new THREE.PlaneGeometry(POSTER_W, PH),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.6,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    );
    poster.position.set(0, 1.4 + PH / 2, back);
    poster.castShadow = true;
    group.add(poster);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(POSTER_W + 0.5, PH + 0.5, 0.3),
      frameMat
    );
    frame.position.set(0, 1.4 + PH / 2, back - 0.18);
    frame.castShadow = true;
    group.add(frame);
    blockers.push(frame);

    for (const end of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 10), postMat);
      leg.position.set(end * (POSTER_W / 2 - 1), 0.75, back - 0.18);
      leg.castShadow = true;
      group.add(leg);
    }

    // The content itself, standing in the world rather than in a DOM panel:
    // a plate that only appears once you are close enough for it to be about
    // the thing you are standing on.
    const pylon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture(site.name, `Site ${String(site.num).padStart(2, '0')} of 20`),
        transparent: true,
        depthTest: false,
      })
    );
    pylon.scale.set(10, 2.5, 1);
    pylon.position.set(0, 1.4 + POSTER_W * 0.625 + 2.4, back);
    group.add(pylon);
    registerFade(pylon, 30, 62, true);

    scene.add(group);
    boards.push({
      site,
      position: new THREE.Vector3(x, 0, z),
      yaw,
      half: { x: PAD.w / 2, z: PAD.d / 2 },
    });
  };

  // Zone 1 - the avenue: five rows either side of the start road.
  sites.slice(0, 10).forEach((site, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    // You arrive from the road, so local +Z points back at the centre line.
    placeBoard(
      site,
      side * AVENUE.x,
      AVENUE.z0 - row * AVENUE.gap,
      side === -1 ? Math.PI / 2 : -Math.PI / 2
    );
  });

  // Zone 2 - the roundabout: six pads facing the island.
  sites.slice(10, 16).forEach((site, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = ROUNDABOUT.x + Math.sin(a) * ROUNDABOUT.pad;
    const z = ROUNDABOUT.z + Math.cos(a) * ROUNDABOUT.pad;
    placeBoard(site, x, z, a + Math.PI); // +Z faces the island
  });

  // Zone 3 - the courtyard: four pads around a square off the east spur.
  sites.slice(16, 20).forEach((site, i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = COURTYARD.x + Math.sin(a) * COURTYARD.r;
    const z = COURTYARD.z + Math.cos(a) * COURTYARD.r;
    placeBoard(site, x, z, a + Math.PI);
  });

  const courtyardFloor = new THREE.Mesh(
    new THREE.CircleGeometry(COURTYARD.r - 12, 32),
    new THREE.MeshStandardMaterial({ color: 0x74996a, roughness: 0.95 })
  );
  courtyardFloor.rotation.x = -Math.PI / 2;
  courtyardFloor.position.set(COURTYARD.x, 0.012, COURTYARD.z);
  courtyardFloor.receiveShadow = true;
  scene.add(courtyardFloor);

  // --- CV podium, with room to keep driving past it ----------------------
  const cvPos = new THREE.Vector3(0, 0, CV_Z);
  const cvGroup = new THREE.Group();
  cvGroup.position.copy(cvPos);

  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(6, 7, 0.3, 32),
    new THREE.MeshStandardMaterial({ color: 0xe9ecf1, roughness: 0.7 })
  );
  podium.position.y = 0.15;
  podium.receiveShadow = true;
  cvGroup.add(podium);

  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 3.6, 0.18),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x2997ff,
      emissiveIntensity: 0.3,
      roughness: 0.35,
    })
  );
  sheet.position.y = 3.2;
  sheet.castShadow = true;
  cvGroup.add(sheet);
  spinners.push({ mesh: sheet, speed: 0.8, bob: 3.2 });

  const cvLabel = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: labelTexture('Download the CV', 'drive onto the podium'),
      transparent: true,
    })
  );
  cvLabel.scale.set(9, 2.25, 1);
  cvLabel.position.y = 6.6;
  cvGroup.add(cvLabel);
  scene.add(cvGroup);

  /* --------------------------------------------------------- playground */

  // A wall to smash
  const brickMat = new THREE.MeshStandardMaterial({ color: 0xc4543a, roughness: 0.85 });
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 9; col++) {
      const bw = 1.6;
      const bh = 0.7;
      addProp(
        new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.8), brickMat),
        new CANNON.Box(new CANNON.Vec3(bw / 2, bh / 2, 0.4)),
        [PLAY.x - 6 + col * bw + (row % 2 ? bw / 2 : 0), bh / 2 + row * bh, PLAY.z - 16],
        1.1
      );
    }
  }

  // Bowling: ten pins and a heavy ball
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f9, roughness: 0.45 });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      addProp(
        new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.38, 1.5, 12), pinMat),
        new CANNON.Cylinder(0.24, 0.38, 1.5, 12),
        [PLAY.x + 4 + col * 1.6 - row * 0.8, 0.75, PLAY.z + 12 + row * 1.6],
        1.2
      );
    }
  }
  addProp(
    new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.25, metalness: 0.4 })
    ),
    new CANNON.Sphere(1.1),
    [PLAY.x + 4, 1.1, PLAY.z + 2],
    9
  );

  // Traffic cones in a ring
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xf06a25, roughness: 0.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    addProp(
      new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.1, 12), coneMat),
      new CANNON.Cylinder(0.1, 0.42, 1.1, 10),
      [PLAY.x + Math.cos(a) * 15, 0.55, PLAY.z + Math.sin(a) * 15],
      0.6
    );
  }

  // Crate pyramid
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xc89a5b, roughness: 0.8 });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      addProp(
        new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), crateMat),
        new CANNON.Box(new CANNON.Vec3(0.6, 0.6, 0.6)),
        [PLAY.x + 18 + col * 1.25 - row * 0.62, 0.6 + (3 - row) * 1.25, PLAY.z - 4],
        2
      );
    }
  }

  // A ramp, because everyone tries to jump something. Two things have to be
  // right or it is just a wall:
  //
  //   1. It rises towards -Z, because that is the way you approach it.
  //   2. Its *top* face meets the floor at the leading edge. Line the bottom
  //      edge up instead and the surface you actually drive on still starts
  //      0.8m in the air, which a 0.36m wheel cannot climb. The nose of the
  //      wedge ends up buried, which is exactly how a ramp should sit.
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x3f4756, roughness: 0.75 });
  const HALF_Y = 0.4;

  /**
   * A wedge you can actually drive up, rising towards -Z from a leading edge
   * that sits flush with the floor at +Z. `rise` is how high the far end ends
   * up, which is the only number worth thinking in.
   */
  const wedge = (x: number, z: number, width: number, run: number, rise: number) => {
    const halfZ = run / 2;
    const tilt = Math.asin(Math.min(0.6, rise / run));
    const y = 0.02 - (HALF_Y * Math.cos(tilt) - halfZ * Math.sin(tilt));

    const quat = new CANNON.Quaternion();
    quat.setFromEuler(tilt, 0, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, HALF_Y * 2, run), rampMat);
    mesh.position.set(x, y, z);
    mesh.rotation.x = tilt;
    addStatic(mesh, new CANNON.Box(new CANNON.Vec3(width / 2, HALF_Y, halfZ)), quat);
    return mesh;
  };

  /**
   * A curved take-off, approximated by tilted slabs along an arc. A wedge
   * throws the car at a fixed angle whatever the entry speed; a curve loads
   * it progressively, so slow is a roll-over and fast is a launch.
   *
   * Segment `t` sits on the arc with its top face on the curve and its local
   * +Z along the tangent, which a rotation of exactly `t` about X gives.
   */
  const quarterPipe = (
    x: number,
    z0: number,
    radius: number,
    sweep: number,
    width: number,
    segments = 7
  ) => {
    const step = sweep / segments;
    const len = radius * step * 1.06; // overlap slightly, or the seams catch a wheel
    for (let i = 0; i < segments; i++) {
      const t = (i + 0.5) * step;
      const py = radius - radius * Math.cos(t) - (HALF_Y * Math.cos(t));
      const pz = z0 - radius * Math.sin(t) - HALF_Y * Math.sin(t);

      const quat = new CANNON.Quaternion();
      quat.setFromEuler(t, 0, 0);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, HALF_Y * 2, len), rampMat);
      mesh.position.set(x, py, pz);
      mesh.rotation.x = t;
      addStatic(mesh, new CANNON.Box(new CANNON.Vec3(width / 2, HALF_Y, len / 2)), quat);
    }
  };

  /** A plain static block: walls, roofs, gantries, maze. */
  const slab = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    material: THREE.Material,
    block = false
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    addStatic(mesh, new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    if (block) blockers.push(mesh);
    return mesh;
  };

  wedge(PLAY.x, PLAY.z + 30, 12, 18, 2.9);
  // A short steep kicker beside it: same approach, very different landing.
  wedge(PLAY.x + 20, PLAY.z + 30, 8, 9, 2.6);
  // And a curved one, for the big air.
  quarterPipe(PLAY.x - 22, PLAY.z + 34, 15, 0.95, 12);

  sign('JUMP', 10, PLAY.x, PLAY.z + 46);
  sign('KICKER', 9, PLAY.x + 20, PLAY.z + 42);
  sign('THE CURVE', 12, PLAY.x - 22, PLAY.z + 48);
  sign('PLAYGROUND', 26, PLAY.x, PLAY.z + 58);

  /* -------------------------------------------------------- moving toys */

  // A domino run, curving so the fall is worth watching to the end.
  const dominoMat = new THREE.MeshStandardMaterial({ color: 0xe8eaef, roughness: 0.5 });
  for (let i = 0; i < 20; i++) {
    const a = (i / 19) * Math.PI * 0.9;
    const dx = PLAY.x - 26 + Math.cos(a) * 13;
    const dz = PLAY.z - 2 + Math.sin(a) * 13;
    const tile = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.6, 0.3), dominoMat);
    tile.rotation.y = -a;
    addProp(tile, new CANNON.Box(new CANNON.Vec3(0.75, 1.3, 0.15)), [dx, 1.3, dz], 1.3);
  }

  // Seesaw: a plank on a hinge. Drive up one end, the other comes down.
  const fulcrumMat = new THREE.MeshStandardMaterial({ color: 0x5b6474, roughness: 0.7 });
  // North of the west spur on purpose: the plank is 15m long, and centred on
  // the road it reaches across the lane you arrive down.
  const SEE = { x: PLAY.x + 34, z: PLAY.z + 20 };
  slab(SEE.x, 0.5, SEE.z, 5.4, 1, 1.6, fulcrumMat);

  const fulcrum = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(2.7, 0.5, 0.8)),
    material: groundMaterial,
    position: new CANNON.Vec3(SEE.x, 0.5, SEE.z),
  });
  fulcrum.updateAABB();
  world.addBody(fulcrum);

  const plankMesh = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.3, 15),
    new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.8 })
  );
  plankMesh.castShadow = true;
  plankMesh.receiveShadow = true;
  scene.add(plankMesh);

  const plank = new CANNON.Body({
    mass: 45,
    shape: new CANNON.Box(new CANNON.Vec3(2.5, 0.15, 7.5)),
    material: groundMaterial,
    position: new CANNON.Vec3(SEE.x, 1.15, SEE.z),
  });
  plank.updateAABB();
  plank.allowSleep = false;
  world.addBody(plank);
  world.addConstraint(
    new CANNON.HingeConstraint(plank, fulcrum, {
      pivotA: new CANNON.Vec3(0, 0, 0),
      axisA: new CANNON.Vec3(1, 0, 0),
      pivotB: new CANNON.Vec3(0, 0.65, 0),
      axisB: new CANNON.Vec3(1, 0, 0),
    })
  );
  dynamics.push({ mesh: plankMesh, body: plank });
  sign('SEESAW', 10, SEE.x, SEE.z + 13);

  // Wrecking ball. Hung from a gantry on a point constraint, which is the
  // whole rope: one rigid link swings exactly like a pendulum.
  const BALL = { x: PLAY.x + 34, z: PLAY.z - 22 };
  const gantryMat = new THREE.MeshStandardMaterial({
    color: 0x8a94a6,
    metalness: 0.5,
    roughness: 0.45,
  });
  for (const side of [-1, 1]) {
    slab(BALL.x + side * 7, 6, BALL.z, 1.2, 12, 1.2, gantryMat, true);
  }
  slab(BALL.x, 12.4, BALL.z, 15.2, 0.8, 1.2, gantryMat, true);

  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.7, 22, 16),
    new THREE.MeshStandardMaterial({ color: 0x2b313c, metalness: 0.6, roughness: 0.35 })
  );
  ballMesh.castShadow = true;
  scene.add(ballMesh);

  const ball = new CANNON.Body({
    mass: 55,
    shape: new CANNON.Sphere(1.7),
    material: groundMaterial,
    position: new CANNON.Vec3(BALL.x, 4.4, BALL.z),
  });
  ball.updateAABB();
  ball.allowSleep = false;
  ball.linearDamping = 0.06;
  world.addBody(ball);

  const anchor = new CANNON.Body({
    mass: 0,
    position: new CANNON.Vec3(BALL.x, 12, BALL.z),
  });
  world.addBody(anchor);
  world.addConstraint(
    new CANNON.PointToPointConstraint(
      ball,
      new CANNON.Vec3(0, 7.6, 0),
      anchor,
      new CANNON.Vec3(0, 0, 0)
    )
  );

  const rope = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(BALL.x, 12, BALL.z),
      new THREE.Vector3(BALL.x, 4.4, BALL.z),
    ]),
    new THREE.LineBasicMaterial({ color: 0x1d2230 })
  );
  scene.add(rope);
  sign('WRECKING BALL', 16, BALL.x, BALL.z + 12);

  /* ------------------------------------------------ letters you can flatten */

  /**
   * Word-sized physics blocks. One body per letter, with the glyph painted on
   * the faces: a letter built out of little cubes looks better standing up and
   * costs forty bodies to knock down.
   */
  const word = (
    text: string,
    cx: number,
    z: number,
    colour: string,
    size = { w: 3, h: 4.2, d: 1.4 }
  ) => {
    const gap = size.w + 0.5;
    const start = cx - ((text.length - 1) * gap) / 2;
    [...text].forEach((ch, i) => {
      if (ch === ' ') return;
      addProp(
        labelBlock(ch, colour, size.w, size.h, size.d),
        new CANNON.Box(new CANNON.Vec3(size.w / 2, size.h / 2, size.d / 2)),
        [start + i * gap, size.h / 2, z],
        3
      );
    });
  };

  word('BRANDON', 0, 127, '#2997ff');
  word('HIRE ME', 0, CV_Z - 15, '#f0b429');

  /* --------------------------------------------------- tunnel and rooftop */

  // A drive-through with a drivable roof. The ramp up is round the back, so
  // the roof is only reachable if you go looking for it.
  const TUN = { x: -90, z: -70 };
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9bec8, roughness: 0.9 });

  for (const side of [-1, 1]) {
    slab(TUN.x + side * 8, 2.5, TUN.z, 2, 5, 34, concrete, true);
  }
  slab(TUN.x, 5.3, TUN.z, 18, 0.6, 34, concrete);
  // Up onto the roof from the +Z end. The wedge rises towards -Z, so its high
  // edge lands at centre minus half the run: that has to equal the roof edge,
  // or you arrive at roof height with a gap still to clear.
  wedge(TUN.x, TUN.z + 28, 10, 22, 5.6);
  sign('TUNNEL', 14, TUN.x, TUN.z + 26);

  const lookout = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.36, 10, 26),
    new THREE.MeshStandardMaterial({
      color: 0xf0b429,
      emissive: 0xf0b429,
      emissiveIntensity: 0.7,
      roughness: 0.3,
    })
  );
  lookout.position.set(TUN.x, 7.4, TUN.z - 8);
  scene.add(lookout);
  spinners.push({ mesh: lookout, speed: 1.4, bob: 7.4 });
  secrets.push({
    id: 'rooftop',
    label: 'The roof of the tunnel',
    position: new THREE.Vector3(TUN.x, 5.6, TUN.z - 8),
    radius: 7,
    found: false,
  });

  /* ------------------------------------------------------------- the maze */

  // Deliberately short. A maze you can see over is a detour, which is what
  // this wants to be; a maze you get lost in is somewhere people quit.
  const MAZE = { x: 90, z: -80 };
  const hedge = new THREE.MeshStandardMaterial({ color: 0x6f9464, roughness: 0.95 });
  /**
   * A spiral, not a puzzle: one gap in the outer wall, one gap in the inner
   * ring, offset from each other, and a baffle in the middle. Every gap is
   * wider than the car, and there is exactly one route in, so nobody gets
   * stuck in here and gives up on the rest of the world.
   */
  const walls: [number, number, number, number][] = [
    // [offset x, offset z, width, depth]
    [-10.5, 18, 15, 1.4], // south wall, west half
    [13.5, 18, 9, 1.4], //  south wall, east half — the way in is between them
    [0, -18, 36, 1.4],
    [-18, 0, 1.4, 36],
    [18, 0, 1.4, 36],
    [-4, 10, 12, 1.4], // inner ring, south side, open at its east end
    [10, 0, 1.4, 22],
    [0, -10, 22, 1.4],
    [-10, 0, 1.4, 22],
    [0, 4, 12, 1.4], // baffle, so the last stretch is not a straight run
  ];
  for (const [ox, oz, w, d] of walls) {
    slab(MAZE.x + ox, 1.6, MAZE.z + oz, w, 3.2, d, hedge, true);
  }
  sign('MAZE  ▲', 14, MAZE.x + 3, MAZE.z + 24);

  const trophy = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.5),
    new THREE.MeshStandardMaterial({
      color: 0x2997ff,
      emissive: 0x2997ff,
      emissiveIntensity: 0.8,
      roughness: 0.25,
    })
  );
  trophy.position.set(MAZE.x, 2.4, MAZE.z - 3);
  scene.add(trophy);
  spinners.push({ mesh: trophy, speed: 1.1, bob: 2.4 });
  secrets.push({
    id: 'maze',
    label: 'The heart of the maze',
    position: new THREE.Vector3(MAZE.x, 0, MAZE.z - 3),
    radius: 5,
    found: false,
  });

  /* ---------------------------------------------------------- skate park */

  const SKATE = { x: 92, z: 96 };
  quarterPipe(SKATE.x, SKATE.z + 16, 16, 1.05, 22, 8);
  quarterPipe(SKATE.x - 30, SKATE.z + 16, 11, 1.15, 16, 7);
  wedge(SKATE.x + 26, SKATE.z + 14, 10, 14, 3.4);
  sign('SKATE PARK', 26, SKATE.x, SKATE.z + 34);

  const beacon = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.4),
    new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x34d399,
      emissiveIntensity: 0.8,
      roughness: 0.3,
    })
  );
  beacon.position.set(SKATE.x, 9, SKATE.z - 6);
  scene.add(beacon);
  spinners.push({ mesh: beacon, speed: 1.6, bob: 9 });
  secrets.push({
    id: 'skate',
    label: 'Over the big curve',
    position: new THREE.Vector3(SKATE.x, 0, SKATE.z - 6),
    radius: 8,
    found: false,
  });

  /* ------------------------------------------------- the trail to follow */

  /**
   * Chevrons dropped along a polyline. Without a painted route people drive
   * into the empty corners of the arena and conclude there is nothing here;
   * with one, every zone is on a path from the last.
   */
  const route = (points: [number, number][], colour = '#2997ff', spacing = 9) => {
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, z0] = points[i];
      const [x1, z1] = points[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.round(len / spacing));
      const yaw = Math.atan2(dx, dz);
      for (let s = 0; s < steps; s++) {
        const k = (s + 0.5) / steps;
        const chevron = decal('▲', 2.6, 2.6, colour);
        chevron.position.set(x0 + dx * k, 0.05, z0 + dz * k);
        // decal() lies in the XZ plane already; rotateZ steers it in place.
        chevron.rotateZ(-(yaw + Math.PI));
        scene.add(chevron);
        registerFade(chevron, 26, 58);
      }
    }
  };

  route([
    [6, 110],
    [6, 34],
    [6, -6],
    [ROUNDABOUT.x + 14, ROUNDABOUT.z + 34],
    [ROUNDABOUT.x + 8, ROUNDABOUT.z - 36],
    [0, CV_Z + 30],
  ]);
  route([[-8, 28], [-40, 28], [PLAY.x + 16, 30]], '#34d399');
  route([[8, 28], [40, 28], [COURTYARD.x - 14, 26]], '#f0b429');

  /* --------------------------------------------------- places to come back to */

  respawns.push(
    { name: 'the start', position: new THREE.Vector3(0, 1.6, 112), yaw: Math.PI },
    { name: 'the avenue', position: new THREE.Vector3(0, 1.6, 60), yaw: Math.PI },
    { name: 'the roundabout', position: new THREE.Vector3(0, 1.6, -6), yaw: Math.PI },
    { name: 'the courtyard', position: new THREE.Vector3(56, 1.6, 26), yaw: -Math.PI / 2 },
    { name: 'the playground', position: new THREE.Vector3(-56, 1.6, 30), yaw: Math.PI / 2 },
    { name: 'the skate park', position: new THREE.Vector3(SKATE.x, 1.6, SKATE.z + 30), yaw: Math.PI },
    { name: 'the tunnel', position: new THREE.Vector3(TUN.x, 1.6, TUN.z + 36), yaw: Math.PI },
    { name: 'the maze', position: new THREE.Vector3(MAZE.x + 3, 1.6, MAZE.z + 26), yaw: Math.PI },
    { name: 'the finish', position: new THREE.Vector3(0, 1.6, CV_Z + 22), yaw: Math.PI }
  );

  /* ----------------------------------------------------- signage & scenery */

  const dressing = dressWorld({
    scene,
    world,
    groundMaterial,
    lib,
    decal,
    addProp,
    blockers,
  });

  /* ----------------------------------------------------------- lifecycle */

  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    // Rain the props in, staggered, so the world assembles itself on entry.
    props.forEach((p, i) =>
      setTimeout(() => {
        p.body.wakeUp();
        p.woken = true;
      }, 300 + i * 24)
    );
  };

  /**
   * Scoring is per-prop, not on a global timer. A prop counts once it has
   * fallen asleep somewhere and later been shoved off that spot. Anything
   * global mis-fires: a body has zero velocity for the first frames after
   * wakeUp too, so a "has the world gone quiet" check can latch a prop's home
   * while it is still in mid-air.
   */
  const score = () => {
    let knocked = 0;
    for (const p of props) {
      if (!p.woken) continue;

      if (!p.settled) {
        if (p.body.sleepState === CANNON.Body.SLEEPING) {
          p.home.copy(p.body.position);
          p.settled = true;
        }
        continue;
      }

      if (!p.knocked && p.body.position.distanceTo(p.home) > 1.6) p.knocked = true;
      if (p.knocked) knocked++;
    }
    return { knocked, total: props.length };
  };

  /**
   * Day and night are the same scene with different light. Nothing is rebuilt:
   * the sky swaps texture, the two lights change colour and level, and the fog
   * pulls in, which is what actually sells a night drive.
   */
  // Fog density is the product of two independent decisions, so both are kept
  // rather than each overwriting the other: toggling night used to silently
  // undo an auto-quality downgrade.
  let isNight = false;
  let quality: 'high' | 'low' = 'high';
  const applyFog = () => {
    const fog = scene.fog as THREE.FogExp2;
    const base = quality === 'high' ? FOG_DENSITY : FOG_DENSITY_LOW;
    // Night air is clearer to look through but there is less to see: denser
    // haze keeps the arena edge from being a hard line against the stars.
    fog.density = base * (isNight ? 1.5 : 1);
  };

  const setNight = (on: boolean) => {
    isNight = on;
    // Moving the sun below the horizon does most of the work: the shader
    // re-scatters, the environment map is rebuilt off the darker sky and the
    // horizon is re-sampled, so the fog matches without being told a colour.
    const preset = on ? NIGHT : DAY;
    sky.apply(preset);
    renderer.toneMappingExposure = preset.exposure;

    sun.position.copy(sky.sunDirection).multiplyScalar(90);
    sun.intensity = on ? 0.32 : 2.6;
    sun.color.set(on ? 0xa8bede : 0xfff4e2);
    hemi.intensity = on ? 0.12 : 0.3;
    hemi.color.set(on ? 0x2d3c5e : 0xdfeaff);
    hemi.groundColor.set(on ? 0x0d1119 : 0x6b7280);

    (scene.fog as THREE.FogExp2).color.copy(sky.horizon);
    applyFog();
  };

  const setQuality = (level: 'high' | 'low') => {
    quality = level;
    sun.castShadow = level === 'high';
    applyFog();
  };

  const ropePoints = rope.geometry.attributes.position as THREE.BufferAttribute;
  const carToFade = new THREE.Vector3();

  const update = (elapsed: number, carPos?: THREE.Vector3) => {
    for (const sp of spinners) {
      sp.mesh.rotation.y = elapsed * sp.speed;
      sp.mesh.position.y = sp.bob + Math.sin(elapsed * 1.6) * 0.25;
    }
    for (const p of props) {
      p.mesh.position.copy(p.body.position as unknown as THREE.Vector3);
      p.mesh.quaternion.copy(p.body.quaternion as unknown as THREE.Quaternion);
    }
    for (const d of dynamics) {
      d.mesh.position.copy(d.body.position as unknown as THREE.Vector3);
      d.mesh.quaternion.copy(d.body.quaternion as unknown as THREE.Quaternion);
    }

    ropePoints.setXYZ(1, ball.position.x, ball.position.y + 1.7, ball.position.z);
    ropePoints.needsUpdate = true;

    if (!carPos) return;
    for (const f of fades) {
      f.obj.getWorldPosition(carToFade);
      const d = carToFade.distanceTo(carPos);
      const want = d <= f.near ? 1 : d >= f.far ? 0 : (f.far - d) / (f.far - f.near);
      // Ease rather than snap, so driving past an edge doesn't strobe.
      f.shown += (want - f.shown) * 0.12;
      const visible = f.shown > 0.01;
      f.obj.visible = visible;
      if (!visible) continue;
      for (const m of f.mats) m.opacity = f.shown;
      if (f.pop) f.obj.scale.copy(f.base).multiplyScalar(0.82 + f.shown * 0.18);
    }
  };

  setNight(false);

  return {
    boards,
    spots: dressing.spots,
    playVideo: dressing.playVideo,
    sun,
    sunDir: sky.sunDirection,
    blockers,
    cv: { position: cvPos, radius: 7 },
    respawns,
    secrets,
    score,
    setNight,
    setQuality,
    update,
    start,
  };
}
