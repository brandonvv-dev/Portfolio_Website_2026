import * as THREE from 'three';

/**
 * Tyre marks, dust, sparks and the blob shadow under the car.
 *
 * Everything here is pooled and pre-allocated: these fire on collision and
 * slip events, which happen in bursts, and allocating a mesh per puff drops
 * frames exactly when the world is busiest.
 */

const SKIDS = 420;
const PARTICLES = 320;

/** Soft round blob, used for dust, sparks and the car's ground shadow. */
function blobTexture(hard = 0.0) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 64 * hard, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A long soft smear, so a mark reads as a tyre print and not a dot. */
function skidTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * One pooled point system. Three has no per-particle size or alpha on
 * PointsMaterial, and both are what make a puff look like a puff, so this
 * carries its own two-attribute shader rather than a stack of sprites.
 */
function particleSystem(scene: THREE.Scene, count: number, blending: THREE.Blending) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const span = new Float32Array(count);
  const grow = new Float32Array(count);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: blobTexture() } },
    vertexShader: `
      attribute vec3 pcolor;
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = pcolor;
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (320.0 / max(-mv.z, 0.001));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float a = texture2D(map, gl_PointCoord).a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  scene.add(points);

  let cursor = 0;

  const emit = (
    x: number,
    y: number,
    z: number,
    colour: THREE.Color,
    opts: { spread: number; rise: number; size: number; life: number; grow: number }
  ) => {
    const i = cursor;
    cursor = (cursor + 1) % count;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vel[i * 3] = (Math.random() * 2 - 1) * opts.spread;
    vel[i * 3 + 1] = opts.rise * (0.5 + Math.random());
    vel[i * 3 + 2] = (Math.random() * 2 - 1) * opts.spread;
    col[i * 3] = colour.r;
    col[i * 3 + 1] = colour.g;
    col[i * 3 + 2] = colour.b;
    size[i] = opts.size;
    grow[i] = opts.grow;
    alpha[i] = 1;
    span[i] = opts.life;
    life[i] = opts.life;
  };

  const update = (dt: number) => {
    let live = false;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      live = true;
      life[i] -= dt;
      if (life[i] <= 0) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      // Air drag, so a puff stalls instead of sailing off across the arena.
      const drag = Math.max(0, 1 - 1.8 * dt);
      vel[i * 3] *= drag;
      vel[i * 3 + 1] = vel[i * 3 + 1] * drag - 1.4 * dt;
      vel[i * 3 + 2] *= drag;
      size[i] += grow[i] * dt;
      alpha[i] = Math.max(0, life[i] / span[i]);
    }
    if (!live) return;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.pcolor.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
  };

  return { emit, update };
}

export interface Effects {
  /** Lays a tyre mark flat on the ground, aligned to the given heading. */
  skid(x: number, z: number, yaw: number, width: number): void;
  dust(x: number, y: number, z: number, hard: number): void;
  sparks(x: number, y: number, z: number, hard: number): void;
  /**
   * Moves the blob shadow under the car. `y` is the height of whatever is
   * below it, so it lands on the tunnel roof rather than through it, and
   * `lift` fades it out as the car leaves the ground.
   */
  shadow(x: number, y: number, z: number, yaw: number, lift: number): void;
  update(dt: number): void;
}

export function createEffects(scene: THREE.Scene): Effects {
  /* --- Tyre marks -------------------------------------------------------
   * A ring buffer of instances rather than fading meshes: marks that never
   * expire cost nothing per frame, and the oldest is simply overwritten.
   */
  const marks = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: skidTexture(),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }),
    SKIDS
  );
  marks.frustumCulled = false;
  marks.renderOrder = 3;
  marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Park every instance at zero scale, otherwise the pool shows as a stack of
  // unit quads at the origin until it is written over.
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SKIDS; i++) marks.setMatrixAt(i, hidden);
  marks.instanceMatrix.needsUpdate = true;
  scene.add(marks);

  let markCursor = 0;
  const markMatrix = new THREE.Matrix4();
  const markQuat = new THREE.Quaternion();
  const markPos = new THREE.Vector3();
  const markScale = new THREE.Vector3();

  /* --- Particles --------------------------------------------------------- */
  const dustSystem = particleSystem(scene, PARTICLES, THREE.NormalBlending);
  const sparkSystem = particleSystem(scene, PARTICLES, THREE.AdditiveBlending);
  const dustColour = new THREE.Color();
  const sparkColour = new THREE.Color();

  /* --- Blob shadow ------------------------------------------------------- */
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTexture(0.25),
    color: 0x0b0f16,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 6.4), blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.035;
  blob.renderOrder = 3;
  scene.add(blob);

  return {
    skid(x, z, yaw, width) {
      markPos.set(x, 0.03, z);
      markQuat.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -yaw, 'YXZ'));
      markScale.set(width, 1.5, 1);
      markMatrix.compose(markPos, markQuat, markScale);
      marks.setMatrixAt(markCursor, markMatrix);
      markCursor = (markCursor + 1) % SKIDS;
      marks.instanceMatrix.needsUpdate = true;
    },

    dust(x, y, z, hard) {
      // Warm grey, lightened with the impact so a hard slide reads as smoke.
      dustColour.setRGB(0.72 + hard * 0.2, 0.7 + hard * 0.2, 0.68 + hard * 0.2);
      dustSystem.emit(x, y, z, dustColour, {
        spread: 0.8 + hard * 1.6,
        rise: 0.9 + hard * 1.4,
        size: 0.5 + hard * 0.5,
        life: 0.5 + hard * 0.5,
        grow: 1.6,
      });
    },

    sparks(x, y, z, hard) {
      sparkColour.setRGB(1, 0.72 - hard * 0.25, 0.28);
      sparkSystem.emit(x, y, z, sparkColour, {
        spread: 2.4 + hard * 5,
        rise: 1.6 + hard * 3,
        size: 0.16 + hard * 0.16,
        life: 0.22 + hard * 0.3,
        grow: -0.15,
      });
    },

    shadow(x, y, z, yaw, lift) {
      blob.position.set(x, y + 0.035, z);
      blob.rotation.set(-Math.PI / 2, 0, -yaw);
      blobMat.opacity = Math.max(0, 0.34 - lift * 0.12);
    },

    update(dt) {
      dustSystem.update(dt);
      sparkSystem.update(dt);
    },
  };
}
