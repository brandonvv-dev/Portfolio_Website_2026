import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sites, type Site } from '../data/sites';

export interface Board {
  site: Site;
  position: THREE.Vector3;
  /** Half-extents on X and Z: the panel opens when you are standing on it. */
  half: { x: number; z: number };
}

/** A knockable prop. `home` is where it comes to rest, used to score hits. */
interface Prop {
  mesh: THREE.Object3D;
  body: CANNON.Body;
  home: CANNON.Vec3;
  knocked: boolean;
}

export interface WorldBits {
  boards: Board[];
  sun: THREE.DirectionalLight;
  cv: { position: THREE.Vector3; radius: number };
  /** How many props have been shoved off their mark, and how many exist. */
  score: () => { knocked: number; total: number };
  update: (elapsed: number) => void;
  /** Rains the props in from the sky, staggered, once the player starts. */
  start: () => void;
}

/** Rectangular arena, pushed back so the long avenue fits inside it. */
const ARENA = { hx: 105, hz: 112, cz: -40 };
const BOARD = { w: 16, d: 10, gapZ: 14, x: 15, z0: 10 };
/**
 * Props are authored at their resting height and spawned this far above it.
 * Kept small on purpose: dropped from any real height a stacked wall or
 * pyramid detonates on landing and there is nothing left to knock over.
 */
const DROP = 3.5;
const SKY = 0xcfe0f2;

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
  mesh.renderOrder = 1;
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
    new THREE.SphereGeometry(420, 24, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);
}

/* -------------------------------------------------------------------- build */

export function buildWorld(
  scene: THREE.Scene,
  world: CANNON.World,
  groundMaterial: CANNON.Material,
  loader: THREE.TextureLoader
): WorldBits {
  const props: Prop[] = [];
  const spinners: { mesh: THREE.Object3D; speed: number; bob: number }[] = [];

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
  scene.fog = new THREE.Fog(SKY, 110, 340);
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

  // Painted avenue down the middle
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(18, ARENA.hz * 1.85),
    new THREE.MeshStandardMaterial({ color: 0x8b919c, roughness: 0.95 })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0.01, ARENA.cz);
  lane.receiveShadow = true;
  scene.add(lane);

  for (let i = 0; i < 42; i++) {
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 3),
      new THREE.MeshBasicMaterial({ color: 0xf2f4f7 })
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.02, 44 - i * 5.5);
    scene.add(dash);
  }

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
  };
  barrier(ARENA.hx, 0, ARENA.cz - ARENA.hz, 0);
  barrier(ARENA.hx, 0, ARENA.cz + ARENA.hz, 0);
  barrier(ARENA.hz, -ARENA.hx, ARENA.cz, Math.PI / 2);
  barrier(ARENA.hz, ARENA.hx, ARENA.cz, Math.PI / 2);

  // --- Start plaza: instructions painted on the floor ---------------------
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
  plaza.position.set(0, 0.03, 42);
  scene.add(plaza);

  const toPlay = decal('◀ PLAYGROUND', 22, 3.4, '#1d2430');
  toPlay.position.set(-28, 0.04, 20);
  scene.add(toPlay);

  // --- The 20 boards -----------------------------------------------------
  const boards: Board[] = [];
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f9, roughness: 0.7 });
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x2997ff,
    roughness: 0.4,
    metalness: 0.3,
  });

  sites.forEach((site, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const pos = new THREE.Vector3(side * BOARD.x, 0, BOARD.z0 - row * BOARD.gapZ);

    const group = new THREE.Group();
    group.position.copy(pos);

    const tex = loader.load(site.board);
    tex.colorSpace = THREE.SRGBColorSpace;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD.w, BOARD.d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0 })
    );
    panel.rotation.x = -Math.PI / 2;
    panel.position.y = 0.04;
    panel.receiveShadow = true;
    group.add(panel);

    // Raised kerb, so a board is somewhere you drive into, not a sticker
    for (const [kw, kd, kx, kz] of [
      [BOARD.w + 1, 0.5, 0, BOARD.d / 2 + 0.25],
      [BOARD.w + 1, 0.5, 0, -BOARD.d / 2 - 0.25],
      [0.5, BOARD.d, BOARD.w / 2 + 0.25, 0],
      [0.5, BOARD.d, -BOARD.w / 2 - 0.25, 0],
    ]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(kw, 0.22, kd), kerbMat);
      kerb.position.set(kx, 0.11, kz);
      kerb.receiveShadow = true;
      group.add(kerb);
    }

    // Painted on the floor rather than floating above it: twenty billboards
    // down one avenue overlap into an unreadable wall from any distance.
    const name = decal(
      `${String(site.num).padStart(2, '0')}  ${site.name.toUpperCase()}`,
      BOARD.w,
      1.9,
      '#141a22'
    );
    name.position.set(0, 0.06, BOARD.d / 2 + 1.6);
    group.add(name);

    // An upright poster on the outer edge. Flat on the tarmac a screenshot is
    // viewed at a grazing angle and reads as a pale smear; standing up, the
    // avenue becomes twenty legible posters you drive between.
    const PW = 12;
    const PH = PW * 0.625;
    const facing = side * (BOARD.w / 2 + 1.2);

    const poster = new THREE.Mesh(
      new THREE.PlaneGeometry(PW, PH),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.6,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    );
    poster.position.set(facing, 1.4 + PH / 2, 0);
    poster.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
    poster.castShadow = true;
    group.add(poster);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, PH + 0.5, PW + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.7 })
    );
    frame.position.set(facing + side * 0.18, 1.4 + PH / 2, 0);
    frame.castShadow = true;
    group.add(frame);

    for (const end of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 10), postMat);
      leg.position.set(facing + side * 0.18, 0.75, end * (PW / 2 - 1));
      leg.castShadow = true;
      group.add(leg);
    }

    scene.add(group);
    boards.push({ site, position: pos, half: { x: BOARD.w / 2, z: BOARD.d / 2 } });
  });

  // --- CV podium at the head of the avenue -------------------------------
  const lastRow = Math.ceil(sites.length / 2) - 1;
  const cvPos = new THREE.Vector3(0, 0, BOARD.z0 - lastRow * BOARD.gapZ - 26);

  const cvGroup = new THREE.Group();
  cvGroup.position.copy(cvPos);

  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(6, 7, 0.6, 32),
    new THREE.MeshStandardMaterial({ color: 0xe9ecf1, roughness: 0.7 })
  );
  podium.position.y = 0.3;
  podium.receiveShadow = true;
  cvGroup.add(podium);

  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 4.4, 0.2),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x2997ff,
      emissiveIntensity: 0.3,
      roughness: 0.35,
    })
  );
  sheet.position.y = 3.4;
  sheet.castShadow = true;
  cvGroup.add(sheet);
  spinners.push({ mesh: sheet, speed: 0.8, bob: 3.4 });

  const cvLabel = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: labelTexture('Download the CV', 'drive onto the podium'),
      transparent: true,
    })
  );
  cvLabel.scale.set(13, 3.25, 1);
  cvLabel.position.y = 7.2;
  cvGroup.add(cvLabel);
  scene.add(cvGroup);

  const finish = decal('FINISH', 16, 4, '#1d2430');
  finish.position.set(0, 0.04, cvPos.z + 13);
  scene.add(finish);

  // --- Playground --------------------------------------------------------
  const PLAY = { x: -55, z: 6 };

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

  const jump = decal('JUMP', 10, 3, '#1d2430');
  jump.position.set(PLAY.x, 0.04, PLAY.z + 46);
  scene.add(jump);

  const playSign = decal('PLAYGROUND', 26, 4.4, '#1d2430');
  playSign.position.set(PLAY.x, 0.04, PLAY.z + 56);
  scene.add(playSign);

  /* ----------------------------------------------------------- lifecycle */

  let started = false;
  let scoring = false;

  const start = () => {
    if (started) return;
    started = true;
    // Rain the props in, staggered, so the world assembles itself on entry.
    props.forEach((p, i) => setTimeout(() => p.body.wakeUp(), 300 + i * 24));

    // Nothing counts until everything has landed: a prop is far from its mark
    // for the whole fall, so scoring early marks all of them knocked at once.
    // Latch each home to wherever it actually came to rest.
    setTimeout(() => {
      for (const p of props) p.home.copy(p.body.position);
      scoring = true;
    }, 300 + props.length * 24 + 1400);
  };

  const score = () => {
    let knocked = 0;
    for (const p of props) {
      if (scoring && !p.knocked && p.body.position.distanceTo(p.home) > 1.6) {
        p.knocked = true;
      }
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

  return { boards, sun, cv: { position: cvPos, radius: 7 }, score, update, start };
}
