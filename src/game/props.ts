import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

interface Entry {
  scene: THREE.Object3D;
  size: THREE.Vector3;
}

export interface PropLibrary {
  /**
   * A fresh clone scaled to `height` units tall and sitting on y = 0.
   * Clones share geometry and materials, so a forest costs draw calls, not
   * memory.
   */
  make(name: string, height: number): THREE.Object3D;
  /** Footprint radius at that height, for deciding collider sizes. */
  radius(name: string, height: number): number;
  has(name: string): boolean;
}

/**
 * Loads a set of GLBs once and hands out scaled clones. Every model is
 * measured rather than assumed, so kits with different unit scales (a Kenney
 * nature tree and a furniture-scale television) can be mixed by asking for a
 * height in world units.
 */
export async function loadPropLibrary(
  urls: string[],
  loader: GLTFLoader
): Promise<PropLibrary> {
  const entries = new Map<string, Entry>();

  await Promise.all(
    urls.map(async (url) => {
      const name = url.replace(/^.*\//, '').replace(/\.glb$/i, '');
      const gltf = await loader.loadAsync(url);
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(scene);
      const size = box.getSize(new THREE.Vector3());

      // Re-origin to the middle of the footprint, feet on the floor, so
      // placement is just a position and a scale.
      const centre = box.getCenter(new THREE.Vector3());
      scene.position.set(-centre.x, -box.min.y, -centre.z);

      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });

      const holder = new THREE.Group();
      holder.add(scene);
      entries.set(name, { scene: holder, size });
    })
  );

  const get = (name: string) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Prop "${name}" was not loaded`);
    return entry;
  };

  return {
    has: (name) => entries.has(name),

    make(name, height) {
      const entry = get(name);
      const clone = entry.scene.clone(true);
      clone.scale.setScalar(height / Math.max(entry.size.y, 0.0001));
      return clone;
    },

    radius(name, height) {
      const entry = get(name);
      const s = height / Math.max(entry.size.y, 0.0001);
      return (Math.max(entry.size.x, entry.size.z) / 2) * s;
    },
  };
}
