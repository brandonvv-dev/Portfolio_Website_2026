import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Atmosphere, the light that comes off it, and the haze colour that matches it.
 *
 * The three jobs are one module because they are one physical thing: get the
 * scattering right and the environment light and the fog colour both fall out
 * of it for free. Split them up and they drift apart, which is exactly what a
 * hand-picked sky gradient plus a hand-picked fog constant looks like.
 */

export interface SkyPreset {
  /** Degrees above the horizon. Negative is below it, i.e. night. */
  elevation: number;
  /** Degrees around, measured the same way as the Sky shader wants. */
  azimuth: number;
  /** Haze. Low is a clean alpine sky, high is a hot city afternoon. */
  turbidity: number;
  /** Blue-sky scattering. Drop it and the sky goes grey and lifeless. */
  rayleigh: number;
  mie: number;
  mieG: number;
  /** How bright the stars are over the top of it. */
  stars: number;
  /** Multiplier on the sky's own contribution as ambient light. */
  env: number;
  /**
   * Tone-mapping exposure to view this sky at. The scattering model returns
   * real radiance, which is far brighter than the painted gradient it
   * replaced, so exposure belongs with the preset rather than being a
   * renderer default someone tuned once against a different sky.
   */
  exposure: number;
}

/**
 * Sun sits behind and to one side, high enough for short shadows but off the
 * zenith so the scene has a light direction at all.
 */
export const DAY: SkyPreset = {
  elevation: 31,
  azimuth: 148,
  turbidity: 3.2,
  rayleigh: 2.1,
  mie: 0.005,
  mieG: 0.8,
  stars: 0,
  env: 0.55,
  exposure: 0.45,
};

/**
 * Just under the horizon: the shader still lights the sky band where the sun
 * went down, which is what stops a night scene reading as a black void.
 */
export const NIGHT: SkyPreset = {
  elevation: -6.5,
  azimuth: 148,
  turbidity: 6,
  rayleigh: 1.1,
  mie: 0.004,
  mieG: 0.88,
  stars: 1,
  env: 0.5,
  exposure: 0.85,
};

function starTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 1024;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, c.width, c.height);

  // Thinned towards the bottom of the map, which is the horizon: real haze
  // washes low stars out, and a sky that is evenly speckled to the ground
  // reads as wallpaper.
  for (let i = 0; i < 1400; i++) {
    const y = Math.pow(Math.random(), 1.6) * c.height * 0.62;
    const r = Math.random() < 0.06 ? 1.9 : 0.9;
    const a = 0.3 + Math.random() * 0.7;
    // A touch of colour: real starfields are not uniformly white.
    const warm = Math.random();
    ctx.fillStyle = `rgba(${255},${Math.round(238 + warm * 17)},${Math.round(
      225 + warm * 30
    )},${a})`;
    ctx.beginPath();
    ctx.arc(Math.random() * c.width, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

export interface SkyRig {
  /** Unit vector pointing at the sun, for aiming the directional light. */
  readonly sunDirection: THREE.Vector3;
  /** Sky colour at the horizon, away from the sun. Feed this to the fog. */
  readonly horizon: THREE.Color;
  /** Swaps preset and rebuilds the environment light and horizon colour. */
  apply(preset: SkyPreset): void;
  dispose(): void;
}

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): SkyRig {
  const sky = new Sky();
  sky.scale.setScalar(10000);
  // The Sky shader pins its output to the far plane, so it is never clipped
  // and never occludes anything; it just has to be drawn first.
  sky.renderOrder = -1000;
  scene.add(sky);

  const stars = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 20),
    new THREE.MeshBasicMaterial({
      map: starTexture(),
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    })
  );
  stars.renderOrder = -999;
  scene.add(stars);

  /**
   * A second sky on the same material, living in a scene of its own. The
   * environment map and the horizon probe both need to render the sky alone,
   * and sharing the material means one uniform update drives all three.
   */
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(10000);
  envSky.material = sky.material;
  envScene.add(envSky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let envTarget: THREE.WebGLRenderTarget | null = null;

  /* ------------------------------------------------------------- horizon */

  // Sampled off the GPU rather than guessed. Change turbidity or the sun
  // angle and the fog follows on its own, which is the whole point.
  // Half-float, not bytes. A midday horizon is brighter than 1.0 in linear
  // light, so an 8-bit read pins green and blue at 255 and hands back white
  // no matter what the sky is actually doing.
  const probeTarget = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.HalfFloatType,
  });
  const probeCam = new THREE.PerspectiveCamera(50, 1, 0.1, 40000);
  const probePixels = new Uint16Array(16 * 16 * 4);
  const probeLook = new THREE.Vector3();

  const sunDirection = new THREE.Vector3();
  const horizon = new THREE.Color(0xcfe0f2);

  const sampleHorizon = () => {
    // Look at the horizon on the opposite side from the sun: that is the
    // colour most of the distant scenery is actually seen against.
    probeLook.set(-sunDirection.x, 0, -sunDirection.z);
    if (probeLook.lengthSq() < 1e-6) probeLook.set(0, 0, -1);
    probeLook.normalize();

    probeCam.position.set(0, 0, 0);
    probeCam.lookAt(probeLook);

    // Tone mapping off for the read: fog colour is consumed in linear space
    // and gets tone-mapped later with everything else. Leave it on and the
    // curve is applied twice, which reads as washed-out, flat haze.
    const tone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(probeTarget);
    renderer.render(envScene, probeCam);
    renderer.readRenderTargetPixels(probeTarget, 0, 0, 16, 16, probePixels);
    renderer.setRenderTarget(previous);
    renderer.toneMapping = tone;

    let r = 0;
    let g = 0;
    let b = 0;
    const half = THREE.DataUtils.fromHalfFloat;
    for (let i = 0; i < probePixels.length; i += 4) {
      r += half(probePixels[i]);
      g += half(probePixels[i + 1]);
      b += half(probePixels[i + 2]);
    }
    const n = probePixels.length / 4;
    // Left in linear light and deliberately not clamped: fog brighter than
    // white is physically what a hazy horizon is, and ACES rolls it off.
    horizon.setRGB(r / n, g / n, b / n, THREE.LinearSRGBColorSpace);
  };

  /* --------------------------------------------------------------- apply */

  const apply = (preset: SkyPreset) => {
    const u = sky.material.uniforms;
    u.turbidity.value = preset.turbidity;
    u.rayleigh.value = preset.rayleigh;
    u.mieCoefficient.value = preset.mie;
    u.mieDirectionalG.value = preset.mieG;

    // Spherical -> cartesian, in the convention the Sky shader expects.
    const phi = THREE.MathUtils.degToRad(90 - preset.elevation);
    const theta = THREE.MathUtils.degToRad(preset.azimuth);
    sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunDirection);

    (stars.material as THREE.MeshBasicMaterial).opacity = preset.stars;
    stars.visible = preset.stars > 0.01;

    // Rebuild the environment from the sky that is actually in the sky.
    envTarget?.dispose();
    envTarget = pmrem.fromScene(envScene);
    scene.environment = envTarget.texture;
    // The sky is the ambient light now, so it needs a level of its own; the
    // old hemisphere-light numbers were tuned for a scene with no environment.
    scene.environmentIntensity = preset.env;

    sampleHorizon();
  };

  apply(DAY);

  return {
    sunDirection,
    horizon,
    apply,
    dispose() {
      envTarget?.dispose();
      pmrem.dispose();
      probeTarget.dispose();
      sky.material.dispose();
      sky.geometry.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
    },
  };
}
