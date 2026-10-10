/**
 * The directory pad's sign: a hoarding facing the camera, 7 m up-screen of the pad like a bay's
 * board. The pad's name is already painted on its slab by signs.ts. Built once; nothing runs per
 * frame.
 *
 * The panel has no place for a heading between its links, so the first visit to the pad sets the
 * category headings into the list (panels.ts builds it, from the pad's links, before any visit).
 */
import {
  BoxGeometry,
  CanvasTexture,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD, DIRECTORY, DIRECTORY_GROUPS, SHIPPED } from '../layout';
import { FACE, type GameModule, type ModuleFactory } from '../types';

const BLUE = '#2997ff';
const SANS = 'Inter, system-ui, sans-serif';

/** The hoardings' size, and their cell in signs.ts: 1024 x 384 px for 10 x 3.75 m. */
const W = 1024;
const H = 384;
const FACE_W = 10;
const FACE_H = 3.75;
const BOTTOM = 0.5;
const MIDDLE = BOTTOM + FACE_H / 2;

const YAW = { x: 0, y: Math.sin(FACE / 2), z: 0, w: Math.cos(FACE / 2) };

const createDirectory: ModuleFactory = (ctx): GameModule => {
  const { scene, look, renderer, physics, rapier, quality, events } = ctx;
  const x = DIRECTORY.x + BOARD.x;
  const z = DIRECTORY.z + BOARD.z;

  /* ------------------------------------------------------------------ art */

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('directory: no 2D canvas');
  g.fillStyle = '#0e1116';
  g.fillRect(0, 0, W, H);
  g.fillStyle = BLUE;
  g.fillRect(0, 0, W, 14);
  g.fillRect(0, H - 14, W, 14);
  g.textAlign = 'center';
  // A line is shrunk, never squeezed, until it fits between the margins.
  const line = (text: string, weight: number, size: number, colour: string, y: number) => {
    g.font = `${weight} ${size}px ${SANS}`;
    const fit = Math.min(1, (W - 80) / g.measureText(text).width);
    g.font = `${weight} ${Math.floor(size * fit)}px ${SANS}`;
    g.fillStyle = colour;
    g.fillText(text, W / 2, y);
  };
  line(`${SHIPPED} SITES SHIPPED`, 800, 108, '#ffffff', 178);
  line(`${DIRECTORY.links.length} more in the directory`, 600, 58, BLUE, 268);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = quality.anisotropy;
  renderer.initTexture(texture);

  /* ---------------------------------------------------------------- sign */

  // Authored facing +Z, then turned and set down: the geometry carries its own transform.
  const place = (geometry: BufferGeometry) => geometry.rotateY(FACE).translate(x, 0, z);
  const frameParts = [
    new BoxGeometry(FACE_W + 0.4, FACE_H + 0.4, 0.25).translate(0, MIDDLE, -0.16),
    // Thin and set back, so their fronts stay behind the face.
    ...[-1, 1].map((end) =>
      new BoxGeometry(0.4, 2.6, 0.2).translate(end * (FACE_W / 2 - 1.2), 1.3, -0.2),
    ),
  ].map(place);
  const structure = mergeGeometries(frameParts);
  if (!structure) throw new Error('directory: the frame parts cannot merge');

  const board = new Mesh(
    place(new PlaneGeometry(FACE_W, FACE_H).translate(0, MIDDLE, 0)),
    look.unlit({ map: texture }, { cutout: true }),
  );
  const frame = new Mesh(structure, look.lit({ color: '#3c424e' }, { cutout: true }));
  frame.castShadow = true;
  frame.receiveShadow = true;
  for (const mesh of [board, frame]) {
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }

  physics.fixed(
    rapier.ColliderDesc.cuboid(5.2, 2.2, 0.2).setTranslation(x, 2.2, z).setRotation(YAW),
  );

  /* -------------------------------------------------------------- headings */

  let headed = false;
  events.on('pad', (pad) => {
    if (pad !== DIRECTORY || headed) return;
    const list = document.querySelector(`[data-panel] a[href="${DIRECTORY.links[0].href}"]`)
      ?.parentElement;
    // No panels module (?only=directory): the pad is a sign and a disc.
    if (!list) return;
    headed = true;
    list.classList.add('is-index');
    const links = [...list.children];
    let first = 0;
    for (const [category, group] of DIRECTORY_GROUPS) {
      const heading = document.createElement('h3');
      heading.className = 'panel-group';
      heading.textContent = category;
      list.insertBefore(heading, links[first]);
      first += group.length;
    }
  });

  return {};
};

export default createDirectory;
