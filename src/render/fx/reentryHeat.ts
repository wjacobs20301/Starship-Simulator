// Reentry heating on the vehicle itself:
//  - the heat shield tiles glow where the flow meets them (windward, brightest square-on), from
//    a dull red through orange to yellow-white as the heating peaks, mottled tile to tile;
//  - bare stainless steel turned into the flow heats up over a few seconds (and cools slowly):
//    it glows red, then orange, then flickering white-hot as it nears burn-through;
//  - sparks: glowing bits streaming off the hot steel (and a few off the tiles at peak heating),
//    carried back along the flow.
// The glow is added to the materials' own emissive light (HDR, so the bloom picks it up).

import * as THREE from 'three';

/** Uniforms shared by one vehicle's heated materials. */
export interface HeatUniforms {
  /** Direction of travel through the air, world axes (the windward side faces it). */
  uHeatFlow: { value: THREE.Vector3 };
  /** Tile temperature 0..1 (1 = peak entry heating). */
  uTileHeat: { value: number };
  /** Bare steel temperature 0..1 (1 = about to burn through). */
  uSteelHeat: { value: number };
  uHeatTime: { value: number };
}

export function heatUniforms(): HeatUniforms {
  return {
    uHeatFlow: { value: new THREE.Vector3(0, -1, 0) },
    uTileHeat: { value: 0 },
    uSteelHeat: { value: 0 },
    uHeatTime: { value: 0 },
  };
}

/**
 * Make a material glow with the heat: `tiles` for the heat shield, else bare steel. The material
 * is changed in place (give each vehicle its own copies).
 */
export function heatMaterial(mat: THREE.MeshStandardMaterial, u: HeatUniforms, tiles: boolean): void {
  // (On top of any patch it already has, e.g. the tank frost.)
  const prev = Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile') ? mat.onBeforeCompile.bind(mat) : null;
  const prevKey = prev ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeatPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeatPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uHeatFlow;
uniform float uTileHeat;
uniform float uSteelHeat;
uniform float uHeatTime;
varying vec3 vHeatPos;
// Glowing hot material: dull red -> orange -> yellow -> white as it heats (roughly black-body).
vec3 heatColor(float t) {
  vec3 c = mix(vec3(0.55, 0.03, 0.0), vec3(1.0, 0.22, 0.02), smoothstep(0.0, 0.4, t));
  c = mix(c, vec3(1.0, 0.62, 0.25), smoothstep(0.4, 0.75, t));
  return mix(c, vec3(1.0, 0.92, 0.8), smoothstep(0.75, 1.0, t));
}
float heatHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  // How squarely this bit of surface faces the oncoming air.
  vec3 heatN = normalize(inverseTransformDirection(normal, viewMatrix));
  float wind = max(0.0, dot(heatN, uHeatFlow));
  ${
    tiles
      ? `// Tiles: brightest head-on; each tile a little different (they don't all heat alike).
  float t = uTileHeat * pow(wind, 0.8) * (0.8 + 0.35 * heatHash(floor(vHeatPos * 1.1)));
  totalEmissiveRadiance += heatColor(t) * (t * t * 3.5);`
      : `// Bare steel: glows where it faces the flow; near burn-through it shimmers and flares.
  float flick = 0.9 + 0.1 * sin(uHeatTime * 37.0 + heatHash(floor(vHeatPos * 2.0)) * 20.0) * smoothstep(0.6, 1.0, uSteelHeat);
  float t = uSteelHeat * pow(wind, 0.7) * flick;
  totalEmissiveRadiance += heatColor(t) * (t * t * 7.0);`
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey}|${tiles ? 'heat-tiles-v1' : 'heat-steel-v1'}`;
  mat.needsUpdate = true;
}

// --- Sparks ------------------------------------------------------------------------------

const sparkVertex = /* glsl */ `
  attribute vec4 aSeed; // angle, height (0..1), lateral jitter, phase
  uniform float uTime;
  uniform vec3 uFlow;     // direction of travel through the air, mesh-local
  uniform float uRate;    // 0..1
  uniform float uLength;  // how far back they stream, m
  uniform float uRadius;
  uniform vec2 uSpan;     // y range of the hull, mesh-local
  uniform float uPixelRatio;
  uniform float uScale;   // pixels per metre at 1 m distance
  varying float vHeat;
  varying float vAlpha;
  void main() {
    float period = 0.9 + 0.6 * fract(aSeed.w * 7.3);
    float t = fract(uTime / period + aSeed.w);
    // A point on the hull; only the windward side sheds.
    vec3 radial = vec3(cos(aSeed.x), 0.0, sin(aSeed.x));
    vec3 p0 = radial * uRadius + vec3(0.0, mix(uSpan.x, uSpan.y, aSeed.y), 0.0);
    vec3 flowPerp = uFlow - vec3(0.0, uFlow.y, 0.0);
    float windward = length(flowPerp) > 0.05 ? dot(radial, normalize(flowPerp)) : 1.0;
    // (Fewer at low rates: each spark has its own threshold.)
    float on = step(fract(aSeed.w * 13.1), uRate) * smoothstep(0.2, 0.6, windward);
    vec3 side = normalize(cross(uFlow, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    vec3 p = p0 - uFlow * (t * t * uLength) + side * (aSeed.z * t * 6.0) + cross(uFlow, side) * (fract(aSeed.w * 3.7) - 0.5) * t * 6.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    vHeat = 1.0 - t;
    vAlpha = on * (1.0 - t) * min(1.0, t * 12.0);
    // Glowing bits ~1-2 m across (motion-blurred), never smaller than a couple of pixels.
    gl_PointSize = clamp((0.8 + 1.4 * (1.0 - t)) * uScale / max(1.0, -mv.z), 2.0 * uPixelRatio, 18.0 * uPixelRatio);
  }
`;

const sparkFragment = /* glsl */ `
  varying float vHeat;
  varying float vAlpha;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    vec3 c = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.85, 0.6), vHeat);
    gl_FragColor = vec4(c * 3.0 * exp(-r2 * 3.0), vAlpha * exp(-r2 * 2.0));
  }
`;

/** Glowing bits shed from the hot hull, streaming back along the flow (mesh-local). */
export class Sparks {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(yLo: number, yHi: number, radius = 4.6, count = 700) {
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4] = Math.random() * Math.PI * 2;
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random() - 0.5;
      seed[i * 4 + 3] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: sparkVertex,
      fragmentShader: sparkFragment,
      uniforms: {
        uTime: { value: 0 },
        uFlow: { value: new THREE.Vector3(0, -1, 0) },
        uRate: { value: 0 },
        uLength: { value: 200 },
        uRadius: { value: radius },
        uSpan: { value: new THREE.Vector2(yLo, yHi) },
        uPixelRatio: { value: 1 },
        uScale: { value: 1000 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /**
   * rate: 0..1; flowLocal: unit direction of travel, mesh-local; speed, m/s; scale: screen pixels
   * per metre at 1 m (drawing-buffer height / 2 x the projection's y scale).
   */
  update(rate: number, flowLocal: THREE.Vector3, speed: number, time: number, pixelRatio: number, scale: number): void {
    this.points.visible = rate > 0.01;
    if (!this.points.visible) return;
    const u = this.mat.uniforms;
    u.uRate.value = Math.min(1, rate);
    u.uFlow.value.copy(flowLocal);
    u.uTime.value = time;
    // Bits shed into hypersonic air stop dead: a few hundred metres behind in a second.
    u.uLength.value = THREE.MathUtils.clamp(speed * 0.06, 40, 450);
    u.uPixelRatio.value = pixelRatio;
    u.uScale.value = scale;
  }
}
