import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { projects, type Project } from '../data/projects';

export interface Board {
  project: Project;
  position: THREE.Vector3;
  /** Half-extents on X and Z — the panel opens when you're standing on it. */
  half: { x: number; z: number };
}

export interface WorldBits {
  boards: Board[];
  /** The key light, moved with the car so its shadow camera stays tight. */
  sun: THREE.DirectionalLight;
  /** Drive into this to open the PDF CV. */
  cv: { position: THREE.Vector3; radius: number; object: THREE.Object3D };
  /** Per-frame cosmetic updates (spin, bob). */
  update: (elapsed: number) => void;
  /** Meshes whose transform is driven by a physics body. */
  dynamic: { mesh: THREE.Object3D; body: CANNON.Body }[];
}

const ARENA = 90; // half-extent of the floor

/** Crisp label texture drawn on a 2D canvas. */
function labelTexture(text: string, sub: string) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = 'rgba(8,8,10,0.88)';
  ctx.roundRect(0, 0, c.width, c.height, 32);
  ctx.fill();
  ctx.strokeStyle = 'rgba(41,151,255,0.55)';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f5f7';
  ctx.font = '600 76px Inter, system-ui, sans-serif';
  ctx.fillText(text, c.width / 2, 108, c.width - 80);

  ctx.fillStyle = '#2997ff';
  ctx.font = '500 44px Inter, system-ui, sans-serif';
  ctx.fillText(sub, c.width / 2, 182, c.width - 80);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Dark asphalt with a faint blue grid, generated rather than downloaded. */
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111116';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(41,151,255,0.2)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 512, 512);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ARENA, ARENA);
  return tex;
}

export function buildWorld(
  scene: THREE.Scene,
  world: CANNON.World,
  groundMaterial: CANNON.Material,
  loader: THREE.TextureLoader
): WorldBits {
  const dynamic: WorldBits['dynamic'] = [];

  // --- Lighting ---------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x4a5c80, 0x0b0b12, 1.7));

  const sun = new THREE.DirectionalLight(0xdce6ff, 2.4);
  sun.position.set(28, 44, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  // Tight frustum for crisp shadows — main.ts keeps it centred on the car,
  // otherwise anything past its edge renders unlit and the floor goes black.
  const s = 42;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // --- Ground -----------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // A slab, not an infinite CANNON.Plane: a rotated Plane's world AABB comes
  // out wrong, so the broadphase never returns it to a raycast and the
  // vehicle's wheels find no ground at all. The arena is walled in anyway.
  const groundBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(ARENA, 1, ARENA)),
    material: groundMaterial,
  });
  groundBody.position.set(0, -1, 0); // top face sits exactly at y = 0
  world.addBody(groundBody);

  // --- Perimeter walls ---------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x2997ff,
    transparent: true,
    opacity: 0.12,
    emissive: 0x2997ff,
    emissiveIntensity: 0.5,
    side: THREE.DoubleSide,
  });

  for (const [dx, dz, rot] of [
    [0, -ARENA, 0],
    [0, ARENA, 0],
    [-ARENA, 0, Math.PI / 2],
    [ARENA, 0, Math.PI / 2],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, 5), wallMat);
    wall.position.set(dx, 2.5, dz);
    wall.rotation.y = rot;
    scene.add(wall);

    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(ARENA, 2.5, 0.5)),
      material: groundMaterial,
    });
    body.position.set(dx, 2.5, dz);
    body.quaternion.setFromEuler(0, rot, 0);
    world.addBody(body);
  }

  // --- Project boards: the CV, laid out on the floor ----------------------
  const featured = projects.filter((p) => p.featured);
  const boards: Board[] = [];
  const BOARD_W = 14;
  const BOARD_H = 9;
  const GAP_Z = 17;

  featured.forEach((project, i) => {
    // Two columns flanking a central avenue running down -Z
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const pos = new THREE.Vector3(side * 13, 0, -6 - row * GAP_Z);

    const group = new THREE.Group();
    group.position.copy(pos);

    // Screenshot painted flat on the tarmac
    const tex = loader.load(project.image ?? project.images?.[0] ?? '');
    tex.colorSpace = THREE.SRGBColorSpace;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W, BOARD_H),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.05 })
    );
    panel.rotation.x = -Math.PI / 2;
    panel.position.y = 0.02;
    panel.receiveShadow = true;
    group.add(panel);

    // Glowing kerb around the panel
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(BOARD_W + 0.6, BOARD_H + 0.6)),
      new THREE.LineBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0.7 })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.03;
    group.add(edge);

    // Floating title board, always facing the camera
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture(project.title, project.tech.slice(0, 3).join(' · ')),
        transparent: true,
      })
    );
    label.scale.set(11, 2.75, 1);
    label.position.set(0, 4.2, 0);
    group.add(label);

    // A pillar of light so you can find it from across the map
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 9, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2997ff,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    beacon.position.set(side * (BOARD_W / 2 + 0.8), 4.5, 0);
    group.add(beacon);

    scene.add(group);
    boards.push({ project, position: pos, half: { x: BOARD_W / 2, z: BOARD_H / 2 } });
  });

  // --- The CV pickup at the head of the avenue ---------------------------
  const cvGroup = new THREE.Group();
  // One row past the last pair, with room to spare before the far wall
  const cvPos = new THREE.Vector3(0, 0, -6 - Math.ceil(featured.length / 2) * GAP_Z);
  cvGroup.position.copy(cvPos);

  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(3, 4.2, 0.18),
    new THREE.MeshStandardMaterial({
      color: 0xf5f5f7,
      emissive: 0x2997ff,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    })
  );
  sheet.position.y = 3;
  sheet.castShadow = true;
  cvGroup.add(sheet);

  const cvLabel = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: labelTexture('Download the CV', 'drive into it'),
      transparent: true,
    })
  );
  cvLabel.scale.set(11, 2.75, 1);
  cvLabel.position.y = 6.6;
  cvGroup.add(cvLabel);

  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(3.6, 4.2, 0.5, 32),
    new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.8 })
  );
  podium.position.y = 0.25;
  podium.receiveShadow = true;
  cvGroup.add(podium);

  scene.add(cvGroup);

  // --- Toys -------------------------------------------------------------
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xb0603a, roughness: 0.85 });
  const addBox = (x: number, y: number, z: number, size = 0.9, mass = 2) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), boxMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const body = new CANNON.Body({
      mass,
      shape: new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2)),
      material: groundMaterial,
    });
    body.position.set(x, y, z);
    world.addBody(body);
    dynamic.push({ mesh, body });
  };

  // Crate pyramid
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      addBox(-30 + col * 1 - row * 0.5, (3 - row) * 0.95 + 0.5, -18);
    }
  }

  // Bowling pins
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f4, roughness: 0.5 });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      const px = 30 + col * 1.4 - row * 0.7;
      const pz = -18 - row * 1.4;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 1.4, 12), pinMat);
      mesh.castShadow = true;
      scene.add(mesh);
      const body = new CANNON.Body({
        mass: 1.1,
        shape: new CANNON.Cylinder(0.22, 0.34, 1.4, 12),
        material: groundMaterial,
      });
      body.position.set(px, 0.8, pz);
      world.addBody(body);
      dynamic.push({ mesh, body });
    }
  }

  // A ramp, because everyone tries to jump something. Kept well clear of the
  // spawn point — parked on top of it, the car beaches and the wheels lose
  // contact with the floor entirely.
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.6, 12),
    new THREE.MeshStandardMaterial({ color: 0x1b1b21, roughness: 0.8 })
  );
  ramp.position.set(-32, 1.4, 6);
  ramp.rotation.x = -0.24;
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);

  const rampBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(5, 0.3, 6)),
    material: groundMaterial,
  });
  rampBody.position.set(-32, 1.4, 6);
  rampBody.quaternion.setFromEuler(-0.24, 0, 0);
  world.addBody(rampBody);

  const update = (elapsed: number) => {
    sheet.rotation.y = elapsed * 0.9;
    sheet.position.y = 3 + Math.sin(elapsed * 1.6) * 0.22;
    for (const bit of dynamic) {
      bit.mesh.position.copy(bit.body.position as unknown as THREE.Vector3);
      bit.mesh.quaternion.copy(bit.body.quaternion as unknown as THREE.Quaternion);
    }
  };

  return {
    boards,
    sun,
    cv: { position: cvPos, radius: 5, object: cvGroup },
    update,
    dynamic,
  };
}
