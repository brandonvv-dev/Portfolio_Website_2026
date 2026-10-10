/**
 * The look every surface shares, as one patch over three's own Lambert and Basic shaders: a warm
 * sun, a single violet tone for form shadow and cast shadow so that the two merge, the grass
 * bounced into the foot of everything, and a fog that fades into the very gradient the backdrop
 * draws, so distance dissolves instead of ending.
 *
 * The built-in materials are patched rather than replaced: three keeps doing the instancing, the
 * maps, the alpha test and the shadow lookup, and equal materials keep sharing one program.
 */
import {
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  ShaderChunk,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Look, LookOptions, Uniforms } from './types';

/** The light, the backdrop, the fog and the cut-out: set up here, written only by render.ts. */
export type SceneUniforms = {
  /** Unit vector from the ground towards the sun. */
  uSunDir: IUniform<Vector3>;
  /** The sun's colour times its strength. */
  uLight: IUniform<Color>;
  /** Multiplies the albedo in form shadow and in cast shadow alike. */
  uShadowTint: IUniform<Color>;
  /** The grass, as the colour of the light from below. */
  uBounce: IUniform<Color>;
  /** The backdrop: uSkyA at uSkyOrigin, in screen UV, easing to uSkyB a whole screen away. */
  uSkyA: IUniform<Color>;
  uSkyB: IUniform<Color>;
  uSkyOrigin: IUniform<Vector2>;
  /** The drawing buffer, pixels. */
  uResolution: IUniform<Vector2>;
  /** View depths between which a surface dissolves into the backdrop, metres. */
  uFogNear: IUniform<number>;
  uFogFar: IUniform<number>;
  /**
   * The car, for the cut-out: x and y in buffer pixels as gl_FragCoord counts them (from the
   * bottom left), its view depth, and its world height plus 1 m.
   */
  uCut: IUniform<Vector4>;
  /** Radius of the hole a cut-out surface opens round the car, buffer pixels. 0 opens none. */
  uCutRadius: IUniform<number>;
};

/**
 * Fragment GLSL for whatever joins the look, patched material or ShaderMaterial: the scene
 * uniforms, the varying its vertex shader has to fill, and the backdrop's gradient, which is also
 * the colour the fog fades to.
 *
 * A ramp this slow bands on an 8-bit canvas, so the gradient is dithered by one byte step. The
 * canvas is sRGB-encoded, where a byte step is about 2.3 sqrt(c) / 255 of linear light: a flat
 * 1 / 255 moves the brightest channels by under half a step and leaves the bands in. The noise is
 * the shadow map's, under a name of its own: three defines its copy only in programs that sample
 * a PCF shadow.
 *
 * three types ShaderChunk as the closed set of its own chunks, hence the cast.
 */
(ShaderChunk as Record<string, string>).drive_common = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLight;
uniform vec3 uShadowTint;
uniform vec3 uBounce;
uniform vec3 uSkyA;
uniform vec3 uSkyB;
uniform vec2 uSkyOrigin;
uniform vec2 uResolution;
uniform float uFogNear;
uniform float uFogFar;
uniform vec4 uCut;
uniform float uCutRadius;
varying vec4 vDrive;
float driveNoise( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
vec3 driveSky() {
  float t = smoothstep( 0.0, 1.0, distance( gl_FragCoord.xy / uResolution, uSkyOrigin ) );
  vec3 sky = mix( uSkyA, uSkyB, t );
  return sky + ( driveNoise( gl_FragCoord.xy ) - 0.5 ) * sqrt( sky ) * 0.0089;
}
`;

/** Every member of Uniforms. The patch declares them in both stages so that no ShaderPatch does. */
const UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uFocus;
uniform sampler2D uTracks;
uniform vec4 uTracksRect;
uniform sampler2D uMasks;
uniform sampler2D uHeights;
uniform float uWorld;
`;

const VERTEX_PARS = /* glsl */ `${UNIFORMS}
varying vec4 vDrive;
#ifdef DRIVE_ATLAS
attribute vec4 aUv;
#endif
`;

/**
 * three reads the emissive map through a varying of its own, so both are moved to the instance's
 * cell: moving the colour map alone would light every block with the whole atlas.
 */
const ATLAS_UV = /* glsl */ `
#ifdef DRIVE_ATLAS
vMapUv = uv * aUv.zw + aUv.xy;
#ifdef USE_EMISSIVEMAP
vEmissiveMapUv = uv * aUv.zw + aUv.xy;
#endif
#endif
`;

/** World position and view depth: what the light, the fog and the cut-out all work from. */
const VERTEX_MAIN = /* glsl */ `
vec4 drivePosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
drivePosition = instanceMatrix * drivePosition;
#endif
vDrive = vec4( ( modelMatrix * drivePosition ).xyz, - mvPosition.z );
`;

const FRAGMENT_PARS = `${UNIFORMS}#include <drive_common>\n`;

/**
 * The two-tone light, in place of three's Lambert sum. Lit is the albedo times the sun, with the
 * grass mixed into whatever does not face up, within 2 m of the ground. Shadow is the albedo times
 * the tint. Form shadow and cast shadow take the deeper of the two, never their product, which is
 * what merges them into one shape.
 *
 * ponytail: the 2 m are world height, not height above the ground. Everything authored stands at
 * y = 0, so only scenery on the hills loses its bounce; sample uHeights here if that ever shows.
 */
const LIGHT = /* glsl */ `
vec3 driveNormal = transformDirectionByInverseViewMatrix( normal, viewMatrix );
float driveBounce =
  smoothstep( - 1.0, 1.0, - driveNormal.y ) * pow2( saturate( 1.0 - vDrive.y / 2.0 ) );
vec3 driveLit = mix( diffuseColor.rgb, uBounce, driveBounce ) * uLight;
float driveForm = 1.0 - smoothstep( - 0.25, 1.0, dot( driveNormal, uSunDir ) );
float driveShade = max( driveForm, 1.0 - getShadowMask() );
reflectedLight.directDiffuse = mix( driveLit, diffuseColor.rgb * uShadowTint, driveShade );
`;

/**
 * The cut-out, then the fog, straight after <opaque_fragment>: the colour is still linear there.
 * At <fog_fragment> the low tier has already encoded it for the canvas, and the tiers would differ.
 *
 * The cut-out opens a hole round the car in whatever stands between it and the camera: clear to
 * three quarters of the radius, with the surface dithering back in from there to the rim. The
 * height test is what keeps the roof the car is driving on whole. The discard comes after every
 * texture read: ahead of them it would leave the pixels beside the hole without derivatives, and
 * so with the wrong mip.
 */
const FRAGMENT_END = /* glsl */ `
#ifdef DRIVE_CUTOUT
if ( vDrive.w < uCut.z - 2.0 && vDrive.y > uCut.w ) {
  float driveRim = uCutRadius * mix( 0.75, 1.0, driveNoise( gl_FragCoord.xy ) );
  if ( distance( gl_FragCoord.xy, uCut.xy ) < driveRim ) discard;
}
#endif
gl_FragColor.rgb = mix( gl_FragColor.rgb, driveSky(), smoothstep( uFogNear, uFogFar, vDrive.w ) );
`;

type Kind = 'lit' | 'unlit';

type Hooks = Pick<Material, 'onBeforeCompile' | 'customProgramCacheKey'>;

/**
 * Swaps one #include for GLSL. A three upgrade that renames the chunk would turn the swap into a
 * silent no-op and the look into plain Lambert, so in DEV a missing one throws.
 */
function swap(source: string, chunk: string, glsl: string): string {
  const include = `#include <${chunk}>`;
  if (import.meta.env.DEV && !source.includes(include)) {
    throw new Error(`shading: three's shader has no ${include} left to patch`);
  }
  // A function, so that nothing in a module's GLSL is read as a replacement pattern.
  return source.replace(include, () => glsl);
}

const after = (source: string, chunk: string, glsl: string): string =>
  swap(source, chunk, `#include <${chunk}>\n${glsl}`);

/**
 * Splices the look into three's shader, and a module's patch at the contract's six anchors.
 * Every name the look adds starts with drive or DRIVE_, so a patch has nothing to collide with.
 */
function splice(
  shader: WebGLProgramParametersWithUniforms,
  kind: Kind,
  { patch, cutout, atlas }: LookOptions,
): void {
  let vertex = (atlas ? '#define DRIVE_ATLAS\n' : '') + shader.vertexShader;
  vertex = after(vertex, 'common', VERTEX_PARS + (patch?.vertexPars ?? ''));
  vertex = after(vertex, 'uv_vertex', ATLAS_UV + (patch?.uv ?? ''));
  vertex = after(vertex, 'beginnormal_vertex', patch?.normal ?? '');
  vertex = after(vertex, 'begin_vertex', patch?.position ?? '');
  shader.vertexShader = after(vertex, 'project_vertex', VERTEX_MAIN);

  let fragment = (cutout ? '#define DRIVE_CUTOUT\n' : '') + shader.fragmentShader;
  fragment = after(fragment, 'common', FRAGMENT_PARS + (patch?.fragmentPars ?? ''));
  fragment = after(fragment, 'map_fragment', patch?.albedo ?? '');
  fragment = after(fragment, 'opaque_fragment', FRAGMENT_END);
  if (kind === 'lit') {
    fragment = after(fragment, 'shadowmap_pars_fragment', '#include <shadowmask_pars_fragment>');
    fragment = swap(fragment, 'lights_lambert_fragment', '');
    fragment = swap(fragment, 'lights_fragment_begin', LIGHT);
    fragment = swap(fragment, 'lights_fragment_maps', '');
    fragment = swap(fragment, 'lights_fragment_end', '');
  }
  shader.fragmentShader = fragment;
}

export function createLook(hdr: boolean): Look & { uniforms: Uniforms & SceneUniforms } {
  // One black pixel stands in for all three maps until the ground and the grass publish theirs.
  const pixel = new DataTexture(new Uint8Array(4), 1, 1);
  pixel.needsUpdate = true;

  // The one object every material holds by reference: a value written here reaches them all.
  const uniforms: Uniforms & SceneUniforms = {
    uTime: { value: 0 },
    uWind: { value: new Vector2() },
    uFocus: { value: new Vector3() },
    uTracks: { value: pixel },
    uTracksRect: { value: new Vector4(0, 0, 1, 0) },
    uMasks: { value: pixel },
    uHeights: { value: pixel },
    uWorld: { value: 1 },
    uSunDir: { value: new Vector3(-0.545, 0.819, 0.184).normalize() },
    uLight: { value: new Color('#ffe3c4').multiplyScalar(1.2) },
    uShadowTint: { value: new Color('#8b86ff') },
    uBounce: { value: new Color('#86cf62') },
    uSkyA: { value: new Color('#8fdcff') },
    uSkyB: { value: new Color('#cdb9ff') },
    uSkyOrigin: { value: new Vector2(0.5, 1.1) },
    uResolution: { value: new Vector2(1, 1) },
    // Out of reach until render.ts fits the range to the camera's footprint. Far has to stay
    // above near: a smoothstep between equal edges is undefined.
    uFogNear: { value: 1e5 },
    uFogFar: { value: 2e5 },
    uCut: { value: new Vector4() },
    uCutRadius: { value: 0 },
  };

  const hooks = new Map<string, Hooks>();

  /**
   * One pair of hooks per kind, patch and option set, however many materials ask for it. three
   * keys its program cache on customProgramCacheKey, so equal materials share one program; left
   * alone it keys on the hook's source text, which is the same for every variant.
   */
  function patched<T extends Material>(material: T, kind: Kind, options: LookOptions = {}): T {
    const key = [kind, options.patch?.key, !!options.cutout, !!options.atlas].join();
    let hook = hooks.get(key);
    if (!hook) {
      hook = {
        onBeforeCompile(shader) {
          Object.assign(shader.uniforms, uniforms);
          splice(shader, kind, options);
        },
        customProgramCacheKey: () => key,
      };
      hooks.set(key, hook);
    }
    return Object.assign(material, hook);
  }

  return {
    uniforms,
    lit: (parameters, options) => patched(new MeshLambertMaterial(parameters), 'lit', options),
    unlit: (parameters, options) => patched(new MeshBasicMaterial(parameters), 'unlit', options),
    glow(color, luminance) {
      const c = new Color(color);
      const scale = luminance / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
      // A canvas clips each channel on its own, so a colour pushed past 1 loses its hue: at 2.2
      // the pad blue reads as cyan. Without the HDR chain it stops where its brightest channel
      // reaches 1.
      return new MeshBasicMaterial({
        color: c.multiplyScalar(hdr ? scale : Math.min(scale, 1 / Math.max(c.r, c.g, c.b))),
      });
    },
  };
}

/** The sky: one triangle over the whole screen, drawn first and behind everything. */
export function createBackdrop(look: Look): Mesh {
  const backdrop = new Mesh(
    new BufferGeometry().setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    ),
    new ShaderMaterial({
      uniforms: look.uniforms,
      vertexShader: /* glsl */ `
        varying vec4 vDrive;
        void main() {
          vDrive = vec4( 0.0 );
          gl_Position = vec4( position.xy, 1.0, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        #include <drive_common>
        void main() {
          gl_FragColor = vec4( driveSky(), 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1000;
  return backdrop;
}
