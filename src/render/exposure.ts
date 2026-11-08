import * as THREE from 'three';
import type { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Exposure that follows the view's brightness, as an eye or a camera does: looking down on a
 * sunlit cloud field (or flying through one) it comes down, so the clouds keep their shading
 * instead of all going the same flat white, and the ground under them is darker, as in photos
 * from high up. It only ever comes down (never over 1): the ground-level scenes, dusk and night
 * look as they always have.
 *
 * All on the GPU (no read-back, no stall): the image's log-luminance drawn small, its mipmaps'
 * top level the average; a 1x1 target keeps the exposure, eased toward its new value each frame.
 */
const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const lumFragment = /* glsl */ `
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Its log (for the average), and its 4th power (a highlight-weighted average: how bright
    // the bright parts are, the sunlit cloud). (Clamped just over the brightest sunlit cloud:
    // the sun's disk or an engine's flame doesn't set it.)
    float lc = clamp(l, 1e-3, 1.6);
    gl_FragColor = vec4(log(lc), lc * lc * lc * lc, 0.0, 1.0);
  }
`;

const adaptFragment = /* glsl */ `
  uniform sampler2D tLum;
  uniform sampler2D tPrev;
  uniform float uLevel;   // the luminance target's top mip level
  uniform float uKey;     // the average luminance the exposure brings the view to
  uniform float uHiKey;   // and the bright parts' (so a sunlit cloud field keeps its shading)
  uniform float uMin;     // the lowest exposure
  uniform float uBlend;   // how far toward the new value this frame (1: at once)
  varying vec2 vUv;
  void main() {
    vec2 m = textureLod(tLum, vec2(0.5), uLevel).rg;
    float target = clamp(min(uKey / exp(m.x), uHiKey / pow(max(m.y, 1e-8), 0.25)), uMin, 1.0);
    float prev = texture2D(tPrev, vec2(0.5)).r;
    gl_FragColor = vec4(mix(prev, target, uBlend), 0.0, 0.0, 1.0);
  }
`;

const applyFragment = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tExposure;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tDiffuse, vUv);
    gl_FragColor = vec4(c.rgb * texture2D(tExposure, vec2(0.5)).r, c.a);
  }
`;

const LUM_W = 128;
const LUM_H = 64;

export class AutoExposurePass extends Pass {
  /** The average (log) luminance the view is brought down to, and the lowest exposure. */
  readonly settings = { key: 0.55, hiKey: 0.9, min: 0.45, seconds: 1.2 };
  private lum = new THREE.WebGLRenderTarget(LUM_W, LUM_H, {
    type: THREE.HalfFloatType,
    format: THREE.RGFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  private exposure = [0, 1].map(
    () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false }),
  );
  private lumQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: lumFragment, uniforms: { tDiffuse: { value: null } }, depthTest: false, depthWrite: false }),
  );
  private adaptUniforms = {
    tLum: { value: this.lum.texture as THREE.Texture },
    tPrev: { value: null as THREE.Texture | null },
    uLevel: { value: Math.log2(Math.max(LUM_W, LUM_H)) },
    uKey: { value: 0.55 },
    uHiKey: { value: 0.9 },
    uMin: { value: 0.45 },
    uBlend: { value: 1 },
  };
  private adaptQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: adaptFragment, uniforms: this.adaptUniforms, depthTest: false, depthWrite: false }),
  );
  private applyUniforms = { tDiffuse: { value: null as THREE.Texture | null }, tExposure: { value: null as THREE.Texture | null } };
  private applyQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: applyFragment, uniforms: this.applyUniforms, depthTest: false, depthWrite: false }),
  );
  private frame = 0;
  private last = -1;
  private fresh = true;
  /** Applied by the output pass (attachTo): no full-screen copy of its own. */
  private attached = false;
  private outputUniforms: { tExposure: { value: THREE.Texture | null } } | null = null;

  constructor() {
    super();
    this.needsSwap = true;
  }

  /**
   * Have the output pass (tone mapping) apply the exposure as it reads the image, instead of a
   * pass of its own copying the whole screen (~2 ms a frame at 2x pixel density).
   */
  attachTo(output: OutputPass): void {
    const m = output.material;
    const read = 'gl_FragColor = texture2D( tDiffuse, vUv );';
    if (!m.fragmentShader.includes(read)) return;
    m.fragmentShader = m.fragmentShader
      .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform sampler2D tExposure;')
      .replace(read, read + '\ngl_FragColor.rgb *= texture2D( tExposure, vec2( 0.5 ) ).r;');
    const u = { tExposure: { value: null as THREE.Texture | null } };
    Object.assign(output.uniforms, u);
    this.outputUniforms = output.uniforms as unknown as typeof u;
    m.needsUpdate = true;
    this.attached = true;
    this.needsSwap = false;
  }

  /** Start over (a new scene, not one the eye adapts to from the last). */
  reset(): void {
    this.fresh = true;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const now = performance.now() / 1000;
    const dt = this.last < 0 ? 0 : Math.min(now - this.last, 0.25);
    this.last = now;
    // 1. The view's log-luminance, small (mipmapped as it's drawn).
    (this.lumQuad.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.lum);
    this.lumQuad.render(renderer);
    // 2. The exposure, eased toward what this view wants.
    const [prev, next] = this.frame++ % 2 ? [this.exposure[0], this.exposure[1]] : [this.exposure[1], this.exposure[0]];
    const a = this.adaptUniforms;
    a.tPrev.value = prev.texture;
    a.uKey.value = this.settings.key;
    a.uHiKey.value = this.settings.hiKey;
    a.uMin.value = this.settings.min;
    a.uBlend.value = this.fresh ? 1 : 1 - Math.exp(-dt / this.settings.seconds);
    this.fresh = false;
    renderer.setRenderTarget(next);
    this.adaptQuad.render(renderer);
    // 3. The image at that exposure.
    if (this.attached && this.outputUniforms) {
      this.outputUniforms.tExposure.value = next.texture;
      return;
    }
    this.applyUniforms.tDiffuse.value = readBuffer.texture;
    this.applyUniforms.tExposure.value = next.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.applyQuad.render(renderer);
  }

  dispose(): void {
    this.lum.dispose();
    for (const t of this.exposure) t.dispose();
    this.lumQuad.dispose();
    this.adaptQuad.dispose();
    this.applyQuad.dispose();
  }
}
