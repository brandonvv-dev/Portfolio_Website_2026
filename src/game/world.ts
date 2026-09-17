import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sites, type Site } from '../data/sites';

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

export interface WorldBits {
  boards: Board[];
  sun: THREE.DirectionalLight;
  /** Solid things the chase camera must not end up behind. */
  blockers: THREE.Object3D[];
  cv: { position: THREE.Vector3; radius: number };
  /** How many props have been shoved off their mark, and how many exist. */
  score: () => { knocked: number; total: number };
  update: (elapsed: number) => void;
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
const SKY = 0xcfe0f2;

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

/** Light tarmac with a faint grid, generated rather than downloaded. */
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9aa0ab';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 256, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ARENA.hx / 2, ARENA.hz / 2);
  return tex;
}

/** Vertical gradient sky on an inverted sphere. */
function addSky(scene: THREE.Scene) {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#4d7fb8');
  g.addColorStop(0.5, '#a8c6e4');
  g.addColorStop(1, '#dfe8f2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(520, 24, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);
}

/* -------------------------------------------------------------------- build */

export function buildWorld(
  scene: THREE.Scene,
  world: CANNON.World,
  groundMaterial: CANNON.Material,
  loader: THREE.TextureLoader,
  maxAnisotropy = 8
): WorldBits {
  const props: Prop[] = [];
  const spinners: { mesh: THREE.Object3D; speed: number; bob: number }[] = [];
  const blockers: THREE.Object3D[] = [];

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

    const body = new CANNON.Body({ mass, shape, material: groundMaterial });
    body.position.set(rest[0], rest[1] + DROP, rest[2]);
    body.allowSleep = true;
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

  const addStatic = (mesh: THREE.Mesh, shape: CANNON.Shape, quat?: CANNON.Quaternion) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 0, shape, material: groundMaterial });
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    if (quat) body.quaternion.copy(quat);
    world.addBody(body);
  };

  // --- Sky, light, fog ---------------------------------------------------
  addSky(scene);
  scene.fog = new THREE.Fog(SKY, 130, 420);
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x6b7280, 2.2));

  const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
  sun.position.set(40, 60, 30);
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

    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(half, 1.5, 0.5)),
      material: groundMaterial,
    });
    body.position.set(x, 1.5, z);
    body.quaternion.setFromEuler(0, yaw, 0);
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

  // A ramp, because everyone tries to jump something. Kept well clear of the
  // spawn: parked on top of it, the car beaches and the wheels lose the floor.
  const rampQuat = new CANNON.Quaternion();
  rampQuat.setFromEuler(-0.26, 0, 0);
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(12, 0.8, 16),
    new THREE.MeshStandardMaterial({ color: 0x3f4756, roughness: 0.75 })
  );
  ramp.position.set(PLAY.x, 1.9, PLAY.z + 30);
  ramp.rotation.x = -0.26;
  addStatic(ramp, new CANNON.Box(new CANNON.Vec3(6, 0.4, 8)), rampQuat);

  sign('JUMP', 10, PLAY.x, PLAY.z + 46);
  sign('PLAYGROUND', 26, PLAY.x, PLAY.z + 58);

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

  const update = (elapsed: number) => {
    for (const sp of spinners) {
      sp.mesh.rotation.y = elapsed * sp.speed;
      sp.mesh.position.y = sp.bob + Math.sin(elapsed * 1.6) * 0.25;
    }
    for (const p of props) {
      p.mesh.position.copy(p.body.position as unknown as THREE.Vector3);
      p.mesh.quaternion.copy(p.body.quaternion as unknown as THREE.Quaternion);
    }
  };

  return { boards, sun, blockers, cv: { position: cvPos, radius: 7 }, score, update, start };
}
