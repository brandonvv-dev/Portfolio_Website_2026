import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * The look pass.
 *
 * Rendering straight to the canvas left everything evenly sharp whether you
 * were parked or flat out, so speed did not *feel* like anything, and props
 * sat on the ground rather than in it.
 *
 * Motion blur here is camera reprojection, not a per-object velocity buffer.
 * Per-object means a second scene render plus a previous model matrix for
 * every object, and on a chase camera it buys almost nothing: the car moves
 * *with* the camera, so reprojection already leaves it sharp while the world
 * streaks past. That is exactly the effect wanted, for one extra full-screen
 * pass instead of a whole extra render.
 */

const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uStrength: { value: 0.6 },
    uSamples: { value: 8 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform float uStrength;
    uniform int uSamples;
    varying vec2 vUv;

    void main() {
      float depth = texture2D(tDepth, vUv).x;

      // Sky: nothing to reproject against, and smearing it looks wrong.
      if (depth >= 0.9999) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      // Screen position -> world -> where this pixel was last frame.
      vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 world = uInvViewProj * clip;
      world /= world.w;

      vec4 prevClip = uPrevViewProj * world;
      vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

      vec2 velocity = (vUv - prevUv) * uStrength;

      // Cap it: a hard camera cut would otherwise smear the whole screen.
      float len = length(velocity);
      if (len > 0.035) velocity *= 0.035 / len;
      if (len < 0.0006) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec4 sum = texture2D(tDiffuse, vUv);
      float count = 1.0;
      for (int i = 1; i < 16; i++) {
        if (i >= uSamples) break;
        float t = float(i) / float(uSamples - 1);
        vec2 uv = vUv - velocity * t;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
        sum += texture2D(tDiffuse, uv);
        count += 1.0;
      }

      gl_FragColor = sum / count;
    }
  `,
};

/** Radial chromatic aberration and a vignette, both scaled by speed. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAberration: { value: 0 },
    uVignette: { value: 0.22 },
  },
  vertexShader: MotionBlurShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform float uVignette;
    varying vec2 vUv;

    void main() {
      vec2 centred = vUv - 0.5;
      float r2 = dot(centred, centred);

      // Split the channels outward from the middle, so the edges of the
      // screen fringe at speed and the centre stays clean.
      vec2 offset = centred * r2 * uAberration;
      vec4 colour;
      colour.r = texture2D(tDiffuse, vUv - offset).r;
      colour.g = texture2D(tDiffuse, vUv).g;
      colour.b = texture2D(tDiffuse, vUv + offset).b;
      colour.a = 1.0;

      colour.rgb *= 1.0 - uVignette * r2 * 2.2;
      gl_FragColor = colour;
    }
  `,
};

export type Quality = 'high' | 'medium' | 'low';

export class PostFX {
  private composer: EffectComposer;
  /**
   * The scene is rendered here, not into the composer's ping-pong pair.
   *
   * EffectComposer swaps its read and write buffers after every pass and
   * never resets them between frames, so any target in that pair takes its
   * turn as the active framebuffer. The motion blur samples this target's
   * depth: attached to a ping-pong buffer, it was sampled on the very frames
   * it was being written to — an illegal feedback loop, undefined output, and
   * a full-screen flash alternating at half the frame rate. Out here it is
   * only ever read.
   */
  private sceneTarget: THREE.WebGLRenderTarget;
  private motion: ShaderPass;
  private grade: ShaderPass;
  private gtao: GTAOPass;
  private smaa: SMAAPass;
  private prevViewProj = new THREE.Matrix4();
  private hasPrev = false;
  /**
   * Its own clock, deliberately. The game loop clamps its delta to 1/20s so a
   * stalled tab cannot launch the car into orbit, but reprojection needs to
   * know how much time *really* passed: fed the clamped figure, a 2fps frame
   * is treated as a 20fps one and the blur comes out eleven times too long.
   */
  private lastRender = performance.now();
  private quality: Quality = 'high';
  /**
   * Both the reprojection smear and the speed fringing are full-screen,
   * high-contrast and driven by how fast you are going. That is precisely
   * what a reduced-motion preference is asking us not to do.
   */
  private readonly calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera
  ) {
    const size = renderer.getSize(new THREE.Vector2());
    const dpr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(size.x * dpr));
    const h = Math.max(1, Math.floor(size.y * dpr));

    // Half float, because the chain works in linear space and OutputPass does
    // the tone mapping at the end.
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(w, h),
      depthBuffer: true,
    });

    this.composer = new EffectComposer(renderer);
    // Hands the already-rendered scene to the chain. Like RenderPass it writes
    // into readBuffer and does not swap, so the pass order below is unchanged.
    this.composer.addPass(new TexturePass(this.sceneTarget.texture));

    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    // Small radius: this is contact shadowing under props, not a cathedral.
    this.gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.2, scale: 1.1, thickness: 1 });
    this.composer.addPass(this.gtao);

    this.motion = new ShaderPass(MotionBlurShader);
    this.motion.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.composer.addPass(this.motion);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.composer.addPass(new OutputPass());

    this.setQuality('high');
  }

  setSize(width: number, height: number) {
    this.composer.setSize(width, height);
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    // Resized alongside the composer, or the blur samples depth at the old
    // resolution and every reprojected pixel lands in the wrong place.
    this.sceneTarget.setSize(w, h);
    this.gtao.setSize(w, h);
  }

  /**
   * Drops the expensive passes first. GTAO is far and away the costliest, then
   * the edge pass; motion blur is kept longest because it is what actually
   * conveys speed — unless the visitor has asked for reduced motion, in which
   * case it never runs at all.
   */
  setQuality(q: Quality) {
    this.quality = q;
    this.gtao.enabled = q === 'high';
    this.smaa.enabled = q !== 'low';
    this.motion.enabled = !this.calm;
  }

  get level() {
    return this.quality;
  }

  /** @param speed01 0..1 road speed, drives blur strength and fringing. */
  render(speed01: number) {
    const cam = this.camera;
    const viewProj = VP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    this.motion.uniforms.uInvViewProj.value.copy(viewProj).invert();
    // First frame has no history; reprojecting against garbage smears once.
    this.motion.uniforms.uPrevViewProj.value.copy(this.hasPrev ? this.prevViewProj : viewProj);
    // Reprojection measures how far the camera moved *this frame*, so on a
    // slow frame it measures a huge jump and smears the whole screen. Scaling
    // against a 60Hz reference turns it into a fixed shutter time instead:
    // the look holds at 60fps and degrades to nothing on a struggling device,
    // rather than degrading to a blurred mess exactly when it can least
    // afford the samples.
    const now = performance.now();
    const real = Math.max((now - this.lastRender) / 1000, 1e-4);
    this.lastRender = now;
    const shutter = Math.min(1, 1 / 60 / real);
    this.motion.uniforms.uStrength.value = (0.35 + speed01 * 0.9) * shutter;
    this.motion.uniforms.uSamples.value = this.quality === 'low' ? 5 : 9;

    this.grade.uniforms.uAberration.value = this.calm ? 0 : speed01 * speed01 * 0.5;
    this.grade.uniforms.uVignette.value = 0.2 + speed01 * 0.16;

    // Scene first, into our own target, so its depth is readable by the blur
    // without ever being the framebuffer a later pass is writing to.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    this.composer.render();

    this.prevViewProj.copy(viewProj);
    this.hasPrev = true;
  }

  dispose() {
    this.composer.dispose();
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
  }
}

const VP = new THREE.Matrix4();
