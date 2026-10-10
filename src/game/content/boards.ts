/**
 * What the car drives up to: the twenty client boards, the ring of every pad, the Axiom screen
 * with its demo reel, and the CV sheet that spins over the finish.
 *
 * Everything is built, textured and uploaded before the warm-up, so nothing compiles or uploads
 * once the car moves. The one thing that waits is the video itself, which is not even requested
 * until the Start click: it is the only gesture that may play it.
 */
import {
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  ImageBitmapLoader,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  VideoTexture,
  type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AXIOM, BAYS, BOARD, FINISH } from '../layout';
import { FACE, type GameContext, type GameModule, type Pad } from '../types';

const BLUE = '#2997ff';
const SHEET_SPIN = 0.8;
/** The active pad's ring, against its neighbours'. Size, not brightness: the low tier clips. */
const ACTIVE = 1.15;

const SIN = Math.sin(FACE);
const COS = Math.cos(FACE);
const YAW = { x: 0, y: Math.sin(FACE / 2), z: 0, w: Math.cos(FACE / 2) };

/** Paints every vertex one colour, so differently coloured parts can share one mesh. */
function tint(geometry: BufferGeometry, colour: Color): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colour.toArray(rgb, i * 3);
  return geometry.setAttribute('color', new Float32BufferAttribute(rgb, 3));
}

/** Puts a mesh in the world once and for all, facing the camera: its matrix is never redone. */
function fix(mesh: Mesh, x: number, y: number, z: number): Mesh {
  mesh.position.set(x, y, z);
  mesh.rotation.y = FACE;
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('boards: parts with different attributes cannot merge');
  return geometry;
}

export default async function createBoards(ctx: GameContext): Promise<GameModule> {
  const { look, scene, quality, renderer, rapier, physics } = ctx;
  // Lit albedo stays under 0.83, so the sun's 1.2 cannot clip it.
  const dim = new Color().setScalar(0.83);

  /* ------------------------------------------------------------ the boards */

  const bitmaps = new ImageBitmapLoader(ctx.loading).setOptions({
    imageOrientation: 'flipY',
    resizeWidth: quality.boardWidth,
    resizeHeight: quality.boardWidth * 0.625,
    resizeQuality: 'high',
  });
  const posterGeometry = new PlaneGeometry(BOARD.width, BOARD.height);
  const posterTextures = await Promise.all(
    BAYS.map(async ({ site }) => {
      const texture = new Texture(await bitmaps.loadAsync(site.board));
      texture.colorSpace = SRGBColorSpace;
      // The bitmap was flipped when it was decoded: an upload cannot flip an ImageBitmap.
      texture.flipY = false;
      texture.anisotropy = quality.anisotropy;
      texture.needsUpdate = true;
      // A first sight costs 0.6 ms here against a 4.4 ms upload in the middle of a frame.
      renderer.initTexture(texture);
      return texture;
    }),
  );

  const frameColour = new Color('#1c2230');
  const postColour = new Color(BLUE);
  const frameParts: BufferGeometry[] = [];
  BAYS.forEach((bay, i) => {
    const bx = bay.x + BOARD.x;
    const bz = bay.z + BOARD.z;
    scene.add(
      fix(
        new Mesh(posterGeometry, look.unlit({ map: posterTextures[i] }, { cutout: true })),
        bx,
        BOARD.bottom + BOARD.height / 2,
        bz,
      ),
    );

    // Parts are authored in the board's own frame (+Z is the face), then turned and moved.
    const part = (w: number, h: number, d: number, lx: number, ly: number, c: Color, lz = -0.17) =>
      frameParts.push(
        tint(new BoxGeometry(w, h, d).translate(lx, ly, lz).rotateY(FACE).translate(bx, 0, bz), c),
      );
    part(BOARD.width + 0.5, BOARD.height + 0.5, 0.3, 0, BOARD.bottom + BOARD.height / 2, frameColour);
    for (const side of [-1, 1]) part(0.4, 0.3, 0.3, side * 3.5, 0.15, postColour);

    physics.fixed(
      rapier.ColliderDesc.cuboid(BOARD.solid.width / 2, BOARD.solid.height / 2, BOARD.solid.depth / 2)
        .setTranslation(bx, BOARD.solid.height / 2, bz)
        .setRotation(YAW),
    );
  });
  const frames = new Mesh(
    merged(frameParts),
    look.lit({ vertexColors: true, color: dim }, { cutout: true }),
  );
  frames.castShadow = true;
  frames.matrixAutoUpdate = false;
  scene.add(frames);

  /* ------------------------------------------------------------- pad rings */

  // Flat on the ground and unit-sized: each instance is scaled to its pad's radius.
  const ringGeometry = new RingGeometry(0.955, 1, 64).rotateX(-Math.PI / 2);
  const pads = ctx.places.pads;
  const byAccent = new Map<string, number[]>();
  pads.forEach((pad, i) => {
    const group = byAccent.get(pad.accent);
    if (group) group.push(i);
    else byAccent.set(pad.accent, [i]);
  });
  const ringOf: InstancedMesh[] = [];
  const slotOf: number[] = [];
  for (const [accent, members] of byAccent) {
    const mesh = new InstancedMesh(ringGeometry, look.glow(accent, 2.2), members.length);
    // Instances sit all over the map and the active one swells: one stale sphere would lie.
    mesh.frustumCulled = false;
    members.forEach((padIndex, slot) => {
      ringOf[padIndex] = mesh;
      slotOf[padIndex] = slot;
    });
    scene.add(mesh);
  }
  const level = new Quaternion();
  const matrix = new Matrix4();
  const at = new Vector3();
  const size = new Vector3();
  const setRing = (padIndex: number, factor: number): void => {
    const pad = pads[padIndex];
    const mesh = ringOf[padIndex];
    matrix.compose(at.set(pad.x, 0.03, pad.z), level, size.setScalar(pad.radius * factor));
    mesh.setMatrixAt(slotOf[padIndex], matrix);
    mesh.instanceMatrix.needsUpdate = true;
  };
  pads.forEach((_, i) => setRing(i, 1));
  let active = -1;
  ctx.events.on('pad', (pad: Pad | null) => {
    if (active >= 0) setRing(active, 1);
    active = pad ? pads.indexOf(pad) : -1;
    if (active >= 0) setRing(active, ACTIVE);
  });

  /* ---------------------------------------------------------- Axiom screen */

  const { tv, video: reel } = AXIOM;
  const { scene: model } = await new GLTFLoader(ctx.loading).loadAsync(
    '/models/props/televisionModern.glb',
  );
  const tvParts: BufferGeometry[] = [];
  model.traverse((object) => {
    if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
    const geometry: BufferGeometry = object.geometry.clone();
    geometry.scale(tv.scale, tv.scale, tv.scale).rotateY(FACE).translate(tv.x, 0, tv.z);
    tvParts.push(tint(geometry, object.material.color));
  });
  const set = new Mesh(
    merged(tvParts),
    look.lit({ vertexColors: true, color: dim }, { cutout: true }),
  );
  set.castShadow = true;
  set.receiveShadow = true;
  set.matrixAutoUpdate = false;
  scene.add(set);
  physics.fixed(
    rapier.ColliderDesc.cuboid(tv.width / 2, tv.height / 2, tv.depth / 2)
      .setTranslation(tv.x, tv.height / 2, tv.z)
      .setRotation(YAW),
  );

  // A detached video is not reliably decoded: it lives in the page, 1 px and invisible.
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'none';
  video.crossOrigin = 'anonymous';
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
  const videoTexture = new VideoTexture(video);
  videoTexture.colorSpace = SRGBColorSpace;
  renderer.initTexture(videoTexture);

  const posterImage = await new TextureLoader(ctx.loading).loadAsync(reel.poster);
  posterImage.colorSpace = SRGBColorSpace;
  renderer.initTexture(posterImage);

  // Along the screen's face: 0.07 m proud of the glass, and the still a little in front of that.
  const onFace = (lift: number, map: Texture): Mesh => {
    const out = (tv.depth / 2) + lift;
    return fix(
      new Mesh(new PlaneGeometry(reel.width, reel.height), look.unlit({ map }, { cutout: true })),
      tv.x + out * SIN,
      reel.y,
      tv.z + out * COS,
    );
  };
  scene.add(onFace(0.07, videoTexture));
  const still = onFace(0.09, posterImage);
  scene.add(still);

  // Inside the Start click: the one gesture that may play it. The request goes out here too.
  ctx.events.on('start', () => {
    video.requestVideoFrameCallback(() => {
      // A video texture owns no GPU storage until it has a frame: allocate it now, not when the screen first scrolls into view.
      videoTexture.needsUpdate = true;
      renderer.initTexture(videoTexture);
      still.visible = false;
      // The still is never shown again: give its 3 MiB back.
      posterImage.dispose();
    });
    video.src = reel.src;
    // A play() refused or interrupted leaves the still up, which is the right fallback.
    video.play().catch(() => undefined);
  });

  /* --------------------------------------------------------------- CV sheet */

  const sheet = new Mesh(new BoxGeometry(2.6, 3.6, 0.18), look.glow(BLUE, 2.2));
  sheet.position.set(...FINISH);
  scene.add(sheet);

  return {
    update(dt) {
      sheet.rotation.y += SHEET_SPIN * dt;
    },
  };
}
