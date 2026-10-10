/**
 * The renderer and what the whole picture shares: the quality tier, the sun's shadow, the high
 * tier's post chain, the scene uniforms that move every frame, the warm-up behind the loading
 * screen, and the governor that measures the display and the device.
 *
 * Both tiers draw the same scene with the same shaders through the same camera, so the same pose
 * gives the same picture. The low tier draws straight to the canvas. The high tier draws into a
 * half-float buffer, where a pad ring at 2.2 is still 2.2 when the bloom looks for it, and three's
 * own output chain blurs the foreground, blooms and encodes for the canvas. Neither tone-maps:
 * that is three's default, and it is what keeps a client's screenshot the colour it was shot in.
 */
import {
  DirectionalLight,
  HalfFloatType,
  InstancedMesh,
  MathUtils,
  MeshDepthMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type IUniform,
  type Material,
  type Object3D,
} from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createBackdrop, createLook } from './shading';
import {
  QUALITY,
  type GameContext,
  type GameModule,
  type GameState,
  type Look,
  type Quality,
  type Tier,
} from './types';

export interface Render {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  look: Look;
  tier: Tier;
  quality: Quality;
  /** Fits the drawing buffer and the camera's aspect to the canvas, at the ladder's rung. */
  resize(): void;
  /** The per-frame half, once the game exists: it runs after the camera and before the content. */
  attach(ctx: GameContext): GameModule;
  /**
   * Compiles every program and uploads every buffer and texture the scene holds, so that nothing
   * is left to do on the first frame that needs it. Call it once everything that will ever be
   * drawn is in the scene, and start the loop when it resolves: it also times the display for
   * the governor, which it can only do while nothing is being drawn.
   */
  warmUp(): Promise<void>;
  /** Once a frame, after the render: dt is the frame's, cpuMs is how long its callback took. */
  govern(dt: number, cpuMs: number, state: GameState): void;
  /** Milliseconds between two frames of the display. 0 until the first 45 frames have been seen. */
  readonly refreshMs: number;
  /** True when this device drew those 45 frames at under 50 a second. */
  readonly slow: boolean;
}

/** Share of the tier's pixel ratio at each rung of the quality ladder. */
const LADDER = [1, 0.85, 0.7];

/** How far the foreground blur reaches at the bottom edge, as a fraction of the screen. */
const TILT = 0.003;

/** Frame gaps the warm-up times with nothing drawn, to find the display's period. */
const IDLE = 10;

/** Frames the governor watches before it calls the device fast or slow. */
const CALIBRATION = 45;

/** Milliseconds the governor looks away for after Start, a resume and a resize. */
const SETTLE = 2000;

/**
 * The blur of a lens focused on a miniature, on the foreground band only: the top of the frame
 * is where the boards stand, and they have to be read. Sixteen taps on a circle whose radius is
 * shuffled from pixel to pixel, which trades the rings of a regular kernel for a fine grain.
 */
const TILT_SHIFT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uAmount;
varying vec2 vUv;
float hash( vec2 p ) {
  return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
}
void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float strength = smoothstep( 0.2, 0.5, 0.5 - vUv.y );
  if ( strength <= 0.0 ) {
    gl_FragColor = base;
    return;
  }
  float blur = strength * uAmount;
  vec4 sum = vec4( 0.0 );
  for ( int i = 0; i < 16; i ++ ) {
    float angle = float( i ) * 0.3926991;
    float reach = ( hash( vec2( float( i ), vUv.x + vUv.y ) ) + blur ) * blur;
    sum += textureLod( tDiffuse, vUv + vec2( cos( angle ), sin( angle ) ) * reach, 0.0 );
  }
  gl_FragColor = mix( base, sum / 16.0, strength );
}`;

/**
 * three draws every shadow caster that has no depth material of its own with one it shares, and
 * derives that material's program again each time an instanced mesh follows a plain one or a plain
 * one an instanced: 4 KB of garbage a switch, every frame. The warm-up hands this one to the
 * instanced casters, so the shared one only ever meets plain meshes.
 */
const DEPTH = new MeshDepthMaterial();

/**
 * Whether three would cast a mesh's shadow with its shared depth material as it stands. For a
 * surface with holes in it three makes a copy that carries the surface's own map, and a depth
 * material handed to such a mesh would take that away.
 */
const solid = (material: Material | Material[]): boolean =>
  !Array.isArray(material) && material.alphaTest === 0 && !material.alphaToCoverage;

/**
 * The median of the first n samples, which it leaves out of order. What lies past n is pushed
 * beyond the end of the sort rather than cut off into a view, so nothing is allocated.
 */
const median = (samples: Float32Array, n: number): number =>
  samples.fill(Infinity, n).sort()[n >> 1];

const point = new Vector3();

export function createRender(canvas: HTMLCanvasElement, forced: Tier | null): Render | null {
  // A small touch screen is taken for a phone. Everything else starts high, and is measured:
  // main.ts reloads it as low when the governor finds it slow.
  const tier =
    forced ??
    (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820
      ? 'low'
      : 'high');
  const quality = QUALITY[tier];

  // The context is made here and handed to three, so the question of whether WebGL 2 exists is
  // asked with the attributes the game will run on: a probe with none would get the default
  // context, and the canvas keeps the first one it gives out. On the high tier the canvas only
  // receives the finished picture, and the samples are on the buffer the scene is drawn into.
  const context = canvas.getContext('webgl2', {
    antialias: quality.hdr ? false : devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  if (!context) return null;

  const renderer = new WebGLRenderer({
    canvas,
    context,
    antialias: true,
    outputBufferType: quality.hdr ? HalfFloatType : UnsignedByteType,
  });
  renderer.shadowMap.enabled = true;
  // One reset a frame, by the loop: the counters then cover the shadow pass and the post chain.
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const look = createLook(quality.hdr);
  const { uniforms } = look;
  scene.add(createBackdrop(look));

  // The look does its own lighting. This light is here for its shadow map alone.
  const sun = new DirectionalLight();
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(quality.shadowSize);
  sun.shadow.radius = quality.shadowRadius;
  sun.shadow.bias = -0.001;
  sun.shadow.normalBias = 0.1;
  scene.add(sun, sun.target);

  // The shadow camera's own axes: three aims it from the light at the target with +Y up, and the
  // sun never moves. The light stands on that bearing from the start, so the warm-up's render
  // already leaves the shadow camera the way every later frame will.
  const toSun = uniforms.uSunDir.value;
  const right = new Vector3(0, 1, 0).cross(toSun).normalize();
  const up = toSun.clone().cross(right);
  sun.position.copy(toSun);
  /** The footprint the shadow box was last fitted to, and the ground one of its texels covers. */
  let radius = 0;
  let texel = 0;
  let crawled = false;

  const tilt: IUniform<number> = { value: TILT };
  if (quality.hdr) {
    const bloom = new UnrealBloomPass(uniforms.uResolution.value, 0.25, 0, 1);
    // Nothing below 1 blooms and everything from 2 up blooms in full: only real emitters glow.
    // three types the uniforms as a bare object, hence the cast.
    (bloom.highPassUniforms as { smoothWidth: IUniform<number> }).smoothWidth.value = 1;
    const blur = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uAmount: tilt },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }`,
      fragmentShader: TILT_SHIFT,
    });
    renderer.setEffects([new ShaderPass(blur), bloom]);
  }

  /** The game's state, once there is a game. Until then the ladder stands on its first rung. */
  let game: GameState | undefined;

  /** The display's period, from the warm-up, and what the governor makes of the first frames. */
  let period = 0;
  let refreshMs = 0;
  let slow = false;
  /** A frame that takes longer than this is late, milliseconds. */
  let lateMs = 0;

  /** The window being watched: each frame's dt and callback time, both in milliseconds. */
  const gaps = new Float32Array(512);
  const costs = new Float32Array(512);
  let count = 0;
  let late = 0;
  /** Bad windows in a row. */
  let strikes = 0;
  /**
   * When the window was opened, and the moment before which none is, in performance.now()
   * milliseconds. The wall's clock, not the game's: dt is capped at a twentieth of a second, so
   * on a device that takes half a second over a frame two seconds of game are twenty of the
   * driver's, and the slower the device, the longer it would wait for help.
   */
  let opened = 0;
  let wake = 0;

  /** Throws away what the governor was watching: what follows is not comparable with it. */
  const settle = () => {
    wake = performance.now() + SETTLE;
    count = late = strikes = 0;
  };
  document.addEventListener('visibilitychange', settle);

  /**
   * The display's own period, milliseconds, from frames in which nothing is drawn. It cannot be
   * read off the game's frames. A GPU that is too slow delivers every one of them late, and
   * their gaps then say how long the scene takes, not how often the screen refreshes: a slow
   * device would be its own measure of on time.
   *
   * The answer is the mean of the middle gaps. A missed frame and a late one fall off the ends,
   * and what is left averages out the rounding of the clock: browsers round these timestamps,
   * some of them to a whole millisecond.
   */
  const idle = () =>
    new Promise<number>((resolve) => {
      const times: number[] = [];
      const frame = (time: number) => {
        if (times.push(time) <= IDLE) {
          requestAnimationFrame(frame);
          return;
        }
        const middle = times
          .slice(1)
          .map((at, i) => at - times[i])
          .sort((a, b) => a - b)
          .slice(IDLE / 5, IDLE - IDLE / 5);
        resolve(middle.reduce((sum, gap) => sum + gap) / middle.length);
      };
      requestAnimationFrame(frame);
    });

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // Three caps: the screen's own density, the tier's, and the tier's budget of pixels, which is
    // what holds a 4K monitor to the cost of a 1440p one.
    renderer.setPixelRatio(
      Math.min(
        devicePixelRatio,
        quality.pixelRatio,
        Math.sqrt((quality.megapixels * 1e6) / (width * height)),
      ) * LADDER[game?.level ?? 0],
    );
    renderer.setSize(width, height, false);
    // The backdrop's gradient and the cut-out are laid out in buffer pixels.
    renderer.getDrawingBufferSize(uniforms.uResolution.value);
    // The camera module sees the aspect change and refits its lens and its footprint.
    camera.aspect = width / height;
    settle();
  }
  resize();

  return {
    renderer,
    scene,
    camera,
    look,
    tier,
    quality,
    resize,

    attach({ car, view, state }) {
      game = state;
      return {
        update(dt) {
          // The shadow box covers the circle of ground the camera can show. It is sized from the
          // widest view, never from the zoom: a box that changed size would change the size of
          // its texels, and every shadow edge would crawl.
          if (view.radius !== radius) {
            radius = view.radius;
            const box = sun.shadow.camera;
            box.left = box.bottom = -radius;
            box.right = box.top = radius;
            box.near = 1;
            box.far = 2 * radius + 1;
            box.updateProjectionMatrix();
            texel = (2 * radius) / quality.shadowSize;
          }
          // And it moves in whole texels across the light, so a caster lands on the same texels
          // in every frame and its shadow stands still while the car drives. Along the light it
          // moves freely: that only shifts every depth alike.
          const target = sun.target.position;
          target.copy(toSun).multiplyScalar(view.centre.dot(toSun));
          target.addScaledVector(right, Math.round(view.centre.dot(right) / texel) * texel);
          target.addScaledVector(up, Math.round(view.centre.dot(up) / texel) * texel);
          sun.position.copy(target).addScaledVector(toSun, radius + 1);
          // Checked against the axes three really gave the shadow camera in the last frame: if
          // those ever stop being the ones assumed above, the shadows crawl and nothing else says.
          if (import.meta.env.DEV && sun.shadow.map && !crawled) {
            const axes = sun.shadow.camera.matrixWorld;
            const x = target.dot(point.setFromMatrixColumn(axes, 0)) / texel;
            const y = target.dot(point.setFromMatrixColumn(axes, 1)) / texel;
            if (Math.abs(x - Math.round(x)) > 1e-3 || Math.abs(y - Math.round(y)) > 1e-3) {
              crawled = true;
              console.error(`render: the shadow box is off its texel grid at ${x}, ${y} texels`);
            }
          }

          const chase = view.mode === 'chase';
          // Distance dissolves over the far part of the footprint, wherever the screen's shape
          // puts that. The chase view looks down the road instead, and fades where the road does.
          const depth = view.far - view.near;
          uniforms.uFogNear.value = chase ? 60 : view.near + 0.315 * depth;
          uniforms.uFogFar.value = chase ? 260 : view.near + 1.25 * depth;

          uniforms.uTime.value = state.time;
          uniforms.uWind.value.set(0.8, 0.6).multiplyScalar(0.6 + 0.4 * Math.sin(0.4 * state.time));

          // The car on screen, for whatever stands between it and the camera. The hole is 3.2 m
          // of world wide at the car, so it is the same hole on a phone as on a monitor.
          point.copy(car.position).applyMatrix4(camera.matrixWorldInverse);
          const distance = -point.z;
          point.applyMatrix4(camera.projectionMatrix);
          const size = uniforms.uResolution.value;
          uniforms.uCut.value.set(
            (point.x * 0.5 + 0.5) * size.x,
            (point.y * 0.5 + 0.5) * size.y,
            distance,
            car.position.y + 1,
          );
          // The chase camera sits behind the car, and nothing it shows needs opening.
          uniforms.uCutRadius.value = chase
            ? 0
            : (3.2 * size.y) / (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2) * distance);

          // A parked car is there to read the board, and the chase view has no foreground.
          tilt.value = MathUtils.damp(tilt.value, chase || state.onPad ? 0 : TILT, 8, dt);
        },
      };
    },

    async warmUp() {
      period = await idle();

      // Everything is drawn once, wherever it is and whether or not it is shown yet. The shadow
      // pass honours both flags too, so this is also what builds the depth programs.
      const hidden: Object3D[] = [];
      const culled: Object3D[] = [];
      scene.traverse((object) => {
        if (!object.visible) hidden.push(object);
        if (object.frustumCulled) culled.push(object);
        object.visible = true;
        object.frustumCulled = false;
        if (object instanceof InstancedMesh && object.castShadow && solid(object.material)) {
          object.customDepthMaterial ??= DEPTH;
        }
      });

      // three keys a program on what it is drawn into. On the high tier that is the half-float
      // buffer, so the programs are built against one: built against the canvas, every one of
      // them would be built a second time on the first frame.
      const target = quality.hdr ? new WebGLRenderTarget(1, 1, { type: HalfFloatType }) : null;
      renderer.setRenderTarget(target);
      // A GPU that cannot say when a program is ready leaves nothing to wait for, and three
      // warns in the console when it is asked to wait on one.
      if (renderer.extensions.has('KHR_parallel_shader_compile')) {
        await renderer.compileAsync(scene, camera);
      } else {
        renderer.compile(scene, camera);
      }
      renderer.setRenderTarget(null);
      target?.dispose();
      // The one frame that uploads every buffer and texture, and builds what compile() leaves
      // out: the shadow pass and the post chain.
      renderer.render(scene, camera);

      for (const object of hidden) object.visible = false;
      for (const object of culled) object.frustumCulled = true;
    },

    govern(dt, cpuMs, state) {
      // The loop's first frame has no time in it, and the last rung has nowhere left to go.
      if (dt === 0 || state.level === LADDER.length - 1) return;
      const ms = dt * 1000;

      if (refreshMs === 0) {
        // The median of the frames is over 20 ms when more than half of them are.
        if (ms > 20) late++;
        if (++count < CALIBRATION) return;
        slow = late > CALIBRATION / 2;
        refreshMs = MathUtils.clamp(period, 4, 34);
        // Phones are asked for 60 frames a second, whatever their screens can do.
        lateMs = 1.5 * (tier === 'high' ? refreshMs : Math.max(refreshMs, 1000 / 60));
        count = late = 0;
        return;
      }

      const now = performance.now();
      if (state.phase !== 'driving') wake = now + SETTLE;
      if (now < wake) return;
      if (count === 0) opened = now;
      gaps[count] = ms;
      costs[count] = cpuMs;
      count++;
      if (ms > lateMs) late++;
      if (now - opened < 1000 && count < gaps.length) return;

      // Late frames whose callback was short were waiting for the GPU, and fewer pixels are the
      // cure. Late frames whose callback was long were not, and fewer pixels would cost the
      // picture and buy nothing.
      const bad = late > 0.1 * count && median(costs, count) < 0.5 * median(gaps, count);
      strikes = bad ? strikes + 1 : 0;
      count = late = 0;
      // It never climbs back: a device that needed the step once will need it again.
      if (strikes === 2) {
        state.level++;
        resize();
      }
    },

    get refreshMs() {
      return refreshMs;
    },
    get slow() {
      return slow;
    },
  };
}
