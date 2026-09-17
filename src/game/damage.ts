import * as THREE from 'three';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';

/**
 * Panel damage.
 *
 * The hull is a 712-triangle lump sharing one baked colour atlas. Pushing its
 * vertices around directly gives you spikes, not dents: there is simply
 * nowhere for a dent to *be* between one corner of a panel and the next. So
 * the mesh is tessellated once on load, and impacts displace the new vertices
 * inward with a falloff.
 *
 * Two rules keep it looking like damage rather than corruption:
 *
 *   - displacement accumulates but is clamped per vertex, so repeatedly
 *     reversing into the same wall creases the panel instead of turning it
 *     inside out;
 *   - the collision box is never touched, so a battered car handles exactly
 *     like a clean one. Damage that quietly changed the physics would be a
 *     bug report nobody could describe.
 */

interface Panel {
  mesh: THREE.Mesh;
  /** Pristine positions, so a reset is exact rather than approximate. */
  base: Float32Array;
  /** Accumulated inward displacement per vertex, in local units. */
  dents: Float32Array;
}

/** World-space target edge length after tessellation. */
const EDGE = 0.13;
const MAX_ITERATIONS = 4;
/** Hardest a single panel vertex can ever be pushed in, in local units. */
const MAX_DENT = 0.42;

export class BodyDamage {
  private panels: Panel[] = [];
  private worldToLocal = new THREE.Matrix4();
  private localPoint = new THREE.Vector3();
  private localDir = new THREE.Vector3();
  private vertex = new THREE.Vector3();
  private total = 0;

  /**
   * @param body the car's visual group, straight from loadCarModel
   */
  constructor(body: THREE.Object3D) {
    body.updateMatrixWorld(true);

    const candidates: THREE.Mesh[] = [];
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      // Skip trim: a 48-triangle spoiler tessellates into noise and nobody
      // looks at it. Panels worth denting are the big ones.
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      if (count > 200) candidates.push(mesh);
    });

    for (const mesh of candidates) {
      // Edge length is specified in world units but applied in local ones.
      const scale = mesh.getWorldScale(SCALE).x || 1;
      const geometry = mesh.geometry.index
        ? mesh.geometry.toNonIndexed()
        : mesh.geometry.clone();

      let dense: THREE.BufferGeometry;
      try {
        dense = new TessellateModifier(EDGE / scale, MAX_ITERATIONS).modify(geometry);
      } catch {
        // A modifier failure must not cost us the car.
        dense = geometry;
      }

      dense.computeVertexNormals();
      mesh.geometry = dense;

      const pos = dense.getAttribute('position') as THREE.BufferAttribute;
      this.panels.push({
        mesh,
        base: Float32Array.from(pos.array as Float32Array),
        dents: new Float32Array(pos.count),
      });
    }
  }

  /** Vertices carried by the deformable panels. Useful for a sanity check. */
  get vertexCount() {
    return this.panels.reduce((n, p) => n + p.dents.length, 0);
  }

  /** 0..1, how beaten up the car is overall. */
  get wear() {
    return Math.min(1, this.total / 26);
  }

  /**
   * Push the panels in around a world-space contact.
   *
   * @param strength 0..1, scaled from impact velocity by the caller
   */
  dent(worldPoint: THREE.Vector3, strength: number) {
    const hit = Math.min(1, Math.max(0, strength));
    if (hit < 0.06) return;

    // Radius and depth both grow with the hit, so a nudge creases one panel
    // and a proper shunt caves in a whole corner.
    const radius = 0.5 + hit * 0.95;
    const depth = 0.05 + hit * 0.3;
    let moved = 0;

    for (const panel of this.panels) {
      const { mesh, base, dents } = panel;
      this.worldToLocal.copy(mesh.matrixWorld).invert();
      this.localPoint.copy(worldPoint).applyMatrix4(this.worldToLocal);

      const scale = mesh.getWorldScale(SCALE).x || 1;
      const localRadius = radius / scale;
      const localDepth = depth / scale;

      const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = attr.array as Float32Array;
      let touched = false;

      for (let i = 0; i < dents.length; i++) {
        const o = i * 3;
        this.vertex.set(base[o], base[o + 1], base[o + 2]);
        const distance = this.vertex.distanceTo(this.localPoint);
        if (distance > localRadius) continue;

        // Smooth falloff; a linear one leaves a visible ring at the edge.
        const t = 1 - distance / localRadius;
        const falloff = t * t * (3 - 2 * t);

        const next = Math.min(MAX_DENT / scale, dents[i] + localDepth * falloff);
        if (next <= dents[i]) continue;
        moved += next - dents[i];
        dents[i] = next;

        // Push toward the impact, which is what makes it read as a dent
        // rather than a bulge, and keeps coincident vertices together.
        this.localDir.copy(this.localPoint).sub(this.vertex);
        const length = this.localDir.length();
        if (length < 1e-5) continue;
        this.localDir.multiplyScalar(dents[i] / length);

        array[o] = base[o] + this.localDir.x;
        array[o + 1] = base[o + 1] + this.localDir.y;
        array[o + 2] = base[o + 2] + this.localDir.z;
        touched = true;
      }

      if (touched) {
        attr.needsUpdate = true;
        // Flat-shaded model, so recomputing normals keeps the facets reading
        // correctly instead of smearing light across a crease.
        mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingSphere();
      }
    }

    this.total += moved;
  }

  /** Straighten every panel. Called on respawn. */
  reset() {
    for (const { mesh, base, dents } of this.panels) {
      const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      (attr.array as Float32Array).set(base);
      attr.needsUpdate = true;
      dents.fill(0);
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
    this.total = 0;
  }
}

const SCALE = new THREE.Vector3();
