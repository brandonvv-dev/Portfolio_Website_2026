import * as THREE from 'three';

/**
 * Matcap shading: the whole art direction, in one 256px canvas.
 *
 * A matcap is a photograph of a lit sphere. Shading is looked up by the
 * surface normal alone, so there are no lights to get wrong, no roughness to
 * tune per material, and nothing per-light to pay for. It is why the flat,
 * illustrated driving worlds hold up on a phone while a physically-based one
 * of the same scene does not.
 *
 * Generated rather than shipped: one canvas beats a texture download, and the
 * look is re-tuned by editing the numbers below rather than by finding a new
 * image.
 */

/** Key light, bounce and rim, as fractions of the sphere. */
const KEY = { x: 0.36, y: 0.3, r: 0.8 };
const BOUNCE = { x: 0.7, y: 0.82, r: 0.45 };

let cached: THREE.Texture | null = null;

export function matcapTexture() {
  if (cached) return cached;

  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;

  // Outside the sphere is never sampled, but a bright corner bleeds in through
  // mipmaps at grazing angles, so the whole canvas starts at the dark side.
  ctx.fillStyle = '#4e545c';
  ctx.fillRect(0, 0, S, S);

  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  ctx.clip();

  const key = ctx.createRadialGradient(
    KEY.x * S,
    KEY.y * S,
    0,
    KEY.x * S,
    KEY.y * S,
    KEY.r * S
  );
  key.addColorStop(0, '#ffffff');
  key.addColorStop(0.42, '#dfe3e8');
  key.addColorStop(0.75, '#9aa1aa');
  key.addColorStop(1, '#5b626b');
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, S, S);

  // Cool bounce off the ground on the shadow side. Without it the dark half
  // goes dead and every object reads as a sticker.
  const bounce = ctx.createRadialGradient(
    BOUNCE.x * S,
    BOUNCE.y * S,
    0,
    BOUNCE.x * S,
    BOUNCE.y * S,
    BOUNCE.r * S
  );
  bounce.addColorStop(0, 'rgba(150,175,205,0.5)');
  bounce.addColorStop(1, 'rgba(150,175,205,0)');
  ctx.fillStyle = bounce;
  ctx.fillRect(0, 0, S, S);

  // Rim along the top edge: the sky, catching the silhouette.
  const rim = ctx.createRadialGradient(S * 0.5, -S * 0.12, 0, S * 0.5, -S * 0.12, S * 0.55);
  rim.addColorStop(0, 'rgba(255,255,255,0.45)');
  rim.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, S, S);

  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cached = tex;
  return tex;
}

const BLACK = new THREE.Color(0x000000);

/**
 * Swaps every lit material under `root` for its matcap equivalent, keeping the
 * colour, texture and transparency it already had.
 *
 * Done as one pass over the finished scene rather than at each of the forty-odd
 * places a material is built: the swap is mechanical, and spreading it out
 * means every new mesh has to remember to opt in.
 *
 * Two opt-outs:
 *   - `userData.lit` keeps a mesh on the lit path. The ground wants it, because
 *     a matcap surface cannot receive a shadow map and the car's shadow falling
 *     on the tarmac is the one shadow that matters.
 *   - anything genuinely emitting (signage, lamps) becomes unlit basic colour
 *     instead, or it would lose its glow and read as painted-on.
 */
export function matcapify(root: THREE.Object3D, matcap = matcapTexture()) {
  const cache = new Map<THREE.Material, THREE.Material>();

  const convert = (m: THREE.Material) => {
    const s = m as THREE.MeshStandardMaterial;
    if (!s.isMeshStandardMaterial) return m;

    const done = cache.get(m);
    if (done) return done;

    const common = {
      map: s.map,
      transparent: s.transparent,
      opacity: s.opacity,
      depthWrite: s.depthWrite,
      alphaTest: s.alphaTest,
      side: s.side,
    };
    // Half intensity and up is something that is meant to be a light source.
    const glowing = s.emissiveIntensity >= 0.5 && !s.emissive.equals(BLACK);
    const next = glowing
      ? new THREE.MeshBasicMaterial({ ...common, color: s.emissive })
      : new THREE.MeshMatcapMaterial({ ...common, color: s.color, matcap });

    cache.set(m, next);
    return next;
  };

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.material || o.userData.lit) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material);
  });
}
