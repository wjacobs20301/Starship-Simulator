// Earth's atmosphere: single-scattering Rayleigh (air molecules: blue sky, red sunsets) and
// Mie (haze: the bright glow around the sun and the whitish horizon), ray-marched per pixel.
// It draws the sky itself, black space above it, the thin blue limb seen from orbit, and the
// aerial perspective over everything solid (distant land fading into blue haze), using the
// scene's depth so the rocket beside the camera stays crisp.
//
// Render order within this pass: solid objects (layer 0) -> atmosphere over them -> glowing
// effects (FX_LAYER: exhaust, smoke, plasma) on top, still depth-tested against the solids. The
// effects are emissive and near the camera, so they shouldn't be dimmed as if far away.

import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { NOISE_SIZE } from './cloudNoise';
import { RE, RP } from '../sim/constants';

export const FX_LAYER = 1;

/**
 * Uniforms shared by the atmosphere pass and every glowing effect (smoke, plumes, sparks,
 * rain...): the effects fade behind clouds and into fog, per fragment (fxVisibility below).
 */
export const FX_SHARED = {
  tCloudTex: { value: null as THREE.Texture | null },
  tCloudDist: { value: null as THREE.Texture | null },
  uClouds: { value: 0 },
  uScreen: { value: new THREE.Vector2(1, 1) },
  uInvProj: { value: new THREE.Matrix4() },
  uCamWorld: { value: new THREE.Matrix4() },
  uCenter: { value: new THREE.Vector3() },
  uRg: { value: 6371e3 },
  uFog: { value: 0 },
};

/**
 * Ground fog where the camera is (uFog, from the weather there): extinction FOG_K (1/m) at the
 * ground, thinning with height (scale FOG_H). Optical depth along a ray from ro (relative to the
 * Earth's centre) over distance t (flat ground: fine over tens of km). Fog banks seen from afar
 * are drawn by the clouds (the weather map has them as cloud at the ground).
 */
const FOG_GLSL = /* glsl */ `
  float fogDepth(vec3 ro, vec3 rd, float t) {
    if (uFog <= 0.0) return 0.0;
    const float FOG_K = 2.4e-3;
    const float FOG_H = 140.0;
    vec3 up = normalize(ro);
    float hc = max(length(ro) - uRg, 0.0);
    float a = dot(rd, up);
    float hEnd = max(hc + a * t, 0.0);
    float od = abs(a) < 1e-4 ? t * exp(-hc / FOG_H) : FOG_H / a * (exp(-hc / FOG_H) - exp(-hEnd / FOG_H));
    return uFog * FOG_K * max(od, 0.0);
  }
`;

/** Added to every effect's shaders: how much of it shows past the clouds and fog. */
const FX_OCCLUSION_GLSL = /* glsl */ `
  uniform sampler2D tCloudTex;
  uniform sampler2D tCloudDist;
  uniform float uClouds;
  uniform vec2 uScreen;
  uniform mat4 uCamWorld;
  uniform vec3 uCenter;
  uniform float uRg;
  uniform float uFog;
  varying vec3 vFxView;
  ${FOG_GLSL}
  float fxVisibility(vec3 viewPos) {
    float d = length(viewPos);
    float v = 1.0;
    if (uClouds > 0.5) {
      vec2 uv = gl_FragCoord.xy / uScreen;
      if (d > texture2D(tCloudDist, uv).r * 1000.0) v *= texture2D(tCloudTex, uv).a;
    }
    vec3 rd = normalize((uCamWorld * vec4(viewPos / max(d, 1e-3), 0.0)).xyz);
    return v * exp(-fogDepth(-uCenter, rd, d));
  }
`;

/** Patch an effect's shader so it fades behind clouds and into fog (once). */
function occludeFx(m: THREE.ShaderMaterial): void {
  if (m.userData.fxOccluded) return;
  m.userData.fxOccluded = true;
  const lastBrace = (src: string) => src.lastIndexOf('}');
  const v = m.vertexShader;
  const vi = lastBrace(v);
  m.vertexShader =
    'uniform mat4 uInvProj;\nvarying vec3 vFxView;\n' + v.slice(0, vi) + '  { vec4 fxv = uInvProj * gl_Position; vFxView = fxv.xyz / fxv.w; }\n' + v.slice(vi);
  const f = m.fragmentShader;
  const fi = lastBrace(f);
  m.fragmentShader = FX_OCCLUSION_GLSL + f.slice(0, fi) + '  gl_FragColor.a *= fxVisibility(vFxView);\n' + f.slice(fi);
  Object.assign(m.uniforms, FX_SHARED);
  m.needsUpdate = true;
}

/** Put an object and all its descendants on the effects layer. */
export function toFxLayer(obj: THREE.Object3D): void {
  obj.traverse((o) => o.layers.set(FX_LAYER));
}

/** Top of the air above the ground, m, and the scale the sun-depth table stores at (half floats). */
const TOP = 100000;
const DEPTH_SCALE = 1000;
const LIGHT_STEPS = 6;

/**
 * The shader's light march, done once: Rayleigh / Mie optical depth from a point toward the sun
 * to the top of the air, by height (v = sqrt(h / top)) and the sun's cos-zenith there (u = 0.5 +
 * 0.5 sign(mu) sqrt|mu|, dense near the horizon). Same 6 midpoint samples the shader took per
 * point, so the sky comes out the same; one lookup instead of 6 samples x 24 points per pixel.
 */
function sunDepthTable(): THREE.DataTexture {
  const W = 256;
  const H = 128;
  const R = 6371e3;
  const RA = R + TOP;
  const data = new Uint16Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const v = j / (H - 1);
    const h = v * v * TOP;
    const r = R + h;
    for (let i = 0; i < W; i++) {
      const x = (i / (W - 1)) * 2 - 1;
      const mu = Math.sign(x) * x * x;
      const sinA = Math.sqrt(Math.max(0, 1 - mu * mu));
      // Far intersection with the top of the air (the shader's hitSphere(p, sun, Ra).y).
      const b = r * mu;
      const len = -b + Math.sqrt(Math.max(0, b * b - (r * r - RA * RA)));
      const segL = len / LIGHT_STEPS;
      let odR = 0;
      let odM = 0;
      for (let k = 0; k < LIGHT_STEPS; k++) {
        const t = segL * (k + 0.5);
        const hh = Math.max(Math.hypot(t * sinA, r + t * mu) - R, -500);
        odR += Math.exp(-hh / 8000) * segL;
        odM += Math.exp(-hh / 1200) * segL;
      }
      const k4 = (j * W + i) * 4;
      data[k4] = THREE.DataUtils.toHalfFloat(Math.min(65000, odR / DEPTH_SCALE));
      data[k4 + 1] = THREE.DataUtils.toHalfFloat(Math.min(65000, odM / DEPTH_SCALE));
      data[k4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The cloud layer's bounds above the ground (m): no cloud below or above (fog is cloud at the
 * ground; storm tops reach ~15 km). Within them the base and top vary with the weather map.
 */
export const CLOUD_SHELL_LO = 0;
export const CLOUD_SHELL_HI = 16000;
const CLOUD_DETAIL_SCALE = 2600;
/** The order the cloud pass visits each 2x2 block's pixels in, frame by frame. */
const SUBPIXELS: [number, number][] = [[0, 0], [1, 1], [1, 0], [0, 1]];
/** Cirrus: a thin sheet this high, m. */
const CIRRUS_ALT = 10000;

/**
 * Clouds over the whole planet, marched per pixel, from the weather map (weather.ts): where
 * there's cloud, its base and top, sheet or broken cells, cirrus and anvils above. The map
 * holds the weather systems and climate (weather/model.ts); the shader adds what it's too
 * coarse for: the fields' ragged edges, cells, towers and wisps. Lit by the sun through the air
 * (reddening at sunset, dark on the night side) and through the cloud above each point, plus
 * sky light.
 */
const CLOUD_GLSL = /* glsl */ `
  const float SHELL_LO = ${CLOUD_SHELL_LO}.0;
  const float SHELL_HI = ${CLOUD_SHELL_HI}.0;
  const float SIGMA = 0.02;

  // The weather map (weather.ts, baked from weather/model.ts) at n (unit, from the Earth's
  // centre, world axes): a = cover, top (/16 km), base (/4 km), broken; b = high cloud, rain, fog,
  // cell size. Two bakes, blended by time.
  void weatherMap(vec3 n, out vec4 a, out vec4 b) {
    vec3 e = uWorldToEcef * n;
    vec2 uv = vec2(atan(e.y, e.x) * 0.15915494 + 0.5, asin(clamp(e.z, -1.0, 1.0)) * 0.31830989 + 0.5);
    a = mix(textureLod(tWxA0, uv, 0.0), textureLod(tWxA1, uv, 0.0), uWxBlend);
    b = mix(textureLod(tWxB0, uv, 0.0), textureLod(tWxB1, uv, 0.0), uWxBlend);
  }

  // Mip level for noise of period "scale" (m) seen from distance t: about one texel per pixel.
  float noiseLod(float t, float scale) {
    return max(0.0, log2(max(t, 1.0) * uPixAng * ${NOISE_SIZE}.0 / scale));
  }

  // The spread of the noise's R channel at mip level l (measured: its mips average it smoother).
  float noiseSd(float l) {
    float f = clamp(l, 0.0, 5.0);
    float i = floor(f);
    float a = i < 0.5 ? 0.0648 : i < 1.5 ? 0.0633 : i < 2.5 ? 0.0588 : i < 3.5 ? 0.048 : i < 4.5 ? 0.0247 : 0.0077;
    float b = i < 0.5 ? 0.0633 : i < 1.5 ? 0.0588 : i < 2.5 ? 0.048 : i < 3.5 ? 0.0247 : 0.0077;
    return max(mix(a, b, f - i), 0.004);
  }

  // The clouds over n from the map's weather (a, b) with the fine detail the map is too coarse
  // for: x = cover 0..1, y = base (m), z = top (m), w = cell size. The map's cover is broken up
  // by noise at ~60 and ~13 km (much more where the weather is broken cumulus than in a sheet),
  // thresholded so the share covered follows the map. Convective clouds' tops vary from column to
  // column (towers). t: seen from this far (m; the pixel's footprint on the layer, stretched when
  // seen edge-on): from far off the finest scale is averaged, not sampled sparsely (pixel-sized
  // fields would blink on and off as the view moved), and the threshold softens to match.
  // (weatherFine's cell pattern there, -1..1: lumpier tops are lit unevenly, seen from far off.)
  float gRelief = 0.0;
  // (The march's step length as a distance for the erosion detail's mip, see cloudDensity.)
  float gDetT = 0.0;
  // (Over 0 for the light samples: their detail a little blurrier, their edges soft.)
  float gDetBias = 0.0;
  // (How near the last sample was to being cloud: its shape value less the cutoff, < 0 clear.)
  float gMargin = -1.0;
  // (How broken weatherFine's weather is, 0 a deck .. 1 scattered cumulus.)
  float gBroken = 0.0;
  vec4 weatherFine(vec3 n, vec4 a, vec4 b, float t) {
    gRelief = 0.0;
    gBroken = a.w;
    if (a.x < 0.015) return vec4(0.0, 0.0, 0.0, b.w);
    vec3 q = n + uDrift;
    float fine = 1.0 - smoothstep(-2.0, 0.0, log2(max(t, 1.0) * uPixAng * ${NOISE_SIZE}.0 * 120.0 / uRc));
    // Mesoscale cells, as cloud seen from orbit organizes: closed cells (cloud cells parted by
    // thin clear lines) in decks, open cells (rings of cloud round clear middles) in broken
    // weather. Cellular noise, warped so no two cells are alike, at two scales.
    // (A texel a pixel: the frames' sub-pixel samples, added up, keep it from grain.)
    float lodM = noiseLod(t, uRc / 27.0);
    float lod2 = noiseLod(t, uRc / 61.0);
    vec3 warp = textureLod(tNoise, q * 7.0 + vec3(0.1, 0.8, 0.5), noiseLod(t, uRc / 7.0) + 1.0).rgr - vec3(0.6, 0.45, 0.6);
    float c1 = (textureLod(tNoise, q * 27.0 + warp * 0.9 + vec3(0.6, 0.3, 0.9), lodM).g - 0.478) / 0.115;
    float c2 = (textureLod(tNoise, q.zxy * 61.0 + warp * 1.7 + vec3(0.2, 0.9, 0.4), lod2).g - 0.478) / 0.115;
    float z1 = 0.8 * c1 + 0.45 * c2 * (1.0 - smoothstep(0.0, 1.5, lod2));
    // (And clusters ~90 km across, seen from far out: from thousands of km the finer cells are
    // below a pixel, and without these the map's own 40 km texels would be all there is: a blur.)
    float lod0 = noiseLod(t, uRc / 9.0);
    float c0 = (textureLod(tNoise, q.yzx * 9.0 + warp * 0.35 + vec3(0.45, 0.15, 0.7), lod0 + 0.5).g - 0.478) / 0.115;
    float fade0 = 1.0 - smoothstep(1.0, 2.5, lod0);
    z1 = mix(z1, -z1, smoothstep(0.45, 0.85, a.w));
    float z2 = (textureLod(tNoise, q * 120.0 + vec3(0.2, 0.4, 0.6), noiseLod(t, uRc / 120.0)).r - 0.67) / 0.065;
    // Mesoscale cells (tens of km: open / closed cells, cloud clusters) where the map says the
    // cells are big; fine breakup (~13 km) where the weather is broken. (As the fine scale fades
    // with distance, the threshold softens by as much: the share covered stays the same.)
    // (Fair-weather cumulus too: it gathers in streets and clusters, not sprinkled evenly.)
    float ampM = mix(0.45, 1.6, max(b.w, 0.75 * smoothstep(0.6, 0.95, a.w)));
    float ampF = mix(0.5, 2.6, a.w);
    // (The mesoscale fades too once its cells shrink to a few pixels: the whole Earth in view.)
    // (Kept until its cells are ~2 pixels across.)
    float meso = 1.0 - smoothstep(1.0, 2.5, lodM);
    // (Solid sheets, the fronts' and lows' shields and decks: whole inside, the cells only
    // roughening their edges and their tops. Broken weather is broken all through.)
    float solid = smoothstep(0.7, 0.97, a.x) * (1.0 - smoothstep(0.3, 0.7, a.w));
    float brk = 1.0 - 0.8 * solid;
    // From so far out that even the clusters are under a pixel (the whole Earth in view): the
    // map's middling cover sharpened toward clear sea or cloud (as cloud is, at that scale: an
    // even mid-grey everywhere would wash the whole planet out).
    float farK = 1.0 - fade0;
    float ax = mix(a.x, smoothstep(0.2, 0.8, a.x), 0.8 * farK);
    // The breakup: cells at each scale, each as strong as the weather is broken and as it still
    // shows from here (sd: how much of it is left to see).
    float brkN = brk * (0.13 * ampM * z1 * meso + 0.08 * c0 * fade0) + 0.07 * ampF * z2 * fine;
    float sd = length(vec3(brk * 0.13 * ampM * meso, brk * 0.08 * fade0, 0.07 * ampF * fine));
    // Cloud where the breakup, spread evenly over 0..1, is under the map's cover: the share
    // covered is the map's cover, whether that's 10% or 90% (a fixed threshold would leave thin
    // cover with next to nothing and fill thick cover solid). Where little of the breakup is left
    // to see (far off, or a solid sheet), the cover as it is, averaged.
    float y = 1.1 * brkN / max(sd, 1e-3);
    // (Squeezed toward the middle for stratiform cloud: there the map's own large-scale cover
    // shows through as whole decks and clear sky, as layer cloud is at that scale; broken cumulus
    // keeps nearly its whole share, thin as it is.)
    float spread = mix(0.55, 0.92, smoothstep(0.55, 0.9, a.w));
    float u = 0.5 + 0.5 * spread * y / sqrt(1.0 + y * y);
    float detail = smoothstep(0.02, 0.1, sd);
    // (Broken cumulus: the clouds themselves far smaller than these cells, so only partly a mask:
    // the cells organize a film of it rather than cutting it into flakes.)
    float maskK = detail * mix(0.85, 0.55, smoothstep(0.6, 0.95, a.w));
    // (Edges crisp close up, softer once the finest breakup is below a pixel: from far off a
    // cloud field's edge frays over many pixels, not a cut line.)
    float edge = mix(0.06, 0.13, 1.0 - fine);
    float cov = mix(ax, smoothstep(u - edge, u + edge, ax), maskK) * smoothstep(0.015, 0.08, a.x);
    gRelief = clamp(0.5 * z1 * meso + 0.3 * c0 * fade0, -1.0, 1.0);
    float base = a.z * 4000.0;
    float top = max(base + 200.0, a.y * 16000.0);
    // Towers: in broken, deep weather each column reaches its own height.
    float conv = smoothstep(3000.0, 7000.0, top - base) * smoothstep(0.15, 0.5, a.w);
    if (conv > 0.0) {
      float tw = clamp((textureLod(tNoise, q * 330.0 + vec3(0.3, 0.7, 0.1), noiseLod(t, uRc / 330.0)).r - 0.58) / 0.17, 0.0, 1.0);
      top = mix(top, base + (top - base) * (0.25 + 0.75 * tw), conv);
    }
    return vec4(cov, base, top, b.w);
  }

  // Cloud density 0..1 at p (relative to the Earth's centre), in weather w (see weatherFine),
  // seen from distance t.
  float cloudDensity(vec3 p, vec4 w, bool detailed, float t) {
    if (w.x < 0.02) return 0.0;
    float h = length(p) - uRc;
    float hn = (h - w.y) / max(w.z - w.y, 100.0);
    if (hn <= 0.0 || hn >= 1.0) return 0.0;
    // Flat bases, rounded tops.
    float grad = smoothstep(0.0, 0.1, hn) * (1.0 - smoothstep(0.5, 1.0, hn));
    float base = w.x * grad;
    if (base < 0.01) return 0.0;
    // Cells at two scales (different periods: no visible repeat); the light samples take one.
    // Cumulus cells ~2 km across, or broad sheets ~15 km; the light samples take the nearer kind.
    // (Two copies at unrelated scales and turned: the noise's 7 km repeat would show from orbit as
    // a lattice.)
    // (The cells barely change with height: each cumulus one column from its flat base to its
    // top (the profile above rounds it off, the detail below roughens it), as they are, not a
    // stack of separate slices, which seen through would cover far more of the sky than the cover
    // says, and look like it. Not stretched part way: the noise's texel layers, magnified, would
    // show as terraces.)
    vec3 pc = p - p * ((length(p) - uRc) * 0.92 / length(p));
    vec3 pr = vec3(0.6 * pc.x + 0.8 * pc.z, pc.y, -0.8 * pc.x + 0.6 * pc.z);
    vec3 pr0 = vec3(0.6 * p.x + 0.8 * p.z, p.y, -0.8 * p.x + 0.6 * p.z);
    // (No finer than the march's steps, as the detail below: a shape sampled every few of its
    // own cells along the ray, from far off, combs into streaks.)
    float l1 = noiseLod(max(t, gDetT), 7000.0);
    float l2 = noiseLod(max(t, gDetT), 11300.0);
    float small = 0.5 * (textureLod(tNoise, pc / 7000.0 + uDrift * 40.0, l1).r
                       + textureLod(tNoise, pr / 11300.0 + vec3(0.31, 0.57, 0.12) + uDrift * 25.0, l2).r);
    float shape = small;
    float sd = 0.5 * length(vec2(noiseSd(l1), noiseSd(l2)));
    if (detailed || w.w > 0.5) {
      float l3 = noiseLod(t, 30000.0);
      shape = mix(small, textureLod(tNoise, p / 30000.0 + vec3(0.7, 0.1, 0.4) + uDrift * 40.0, l3).r, w.w);
      sd = length(vec2((1.0 - w.w) * sd, w.w * noiseSd(l3)));
    }
    // (The noise's values bunch round 0.669, spread sd (less, the more its mips have averaged it
    // from far off): spread evenly over 0..1 (its distribution's own curve, near enough), so the
    // share of points over 1 - c is c, near or far: the clouds fill as much of the sky as the
    // cover says, separate cells when it's light, still cells from far off, not a milky film.)
    float u = 1.0 / (1.0 + exp(-1.75 * (shape - 0.669) / sd));
    // (Light cover is thin: you see through it.)
    // (Crisp-edged close up, as cumulus are; soft-edged far off, where a hard threshold would
    // alias into crawling edges.)
    // (u changes ~0.4 every 500 m: an edge a few screen pixels wide wherever it's seen from;
    // uPixAng is the cloud pass's, two of them.)
    float soft = mix(clamp(2.0 * t * uPixAng / 1250.0, 0.008, 0.05), 0.35, smoothstep(2.0, 4.0, l1));
    // (The light samples see the cloud soft-edged: crisp, a step's shadow is all or nothing, and
    // the shading breaks into facets.)
    if (!detailed || gDetBias > 0.0) soft = max(soft, 0.12);
    // (Close up, the cells' surfaces roughened by finer noise, billows on billows, a cumulus's
    // cauliflower; a deck's top lumpier still, its cells.)
    if (detailed) {
      float dl = noiseLod(max(t, gDetT), ${CLOUD_DETAIL_SCALE}.0) + gDetBias;
      float det = textureLod(tNoise, p / ${CLOUD_DETAIL_SCALE}.0 + uDrift * 40.0, dl).g;
      u += mix(0.22, 0.11, smoothstep(0.3, 0.8, gBroken)) * (det - 0.478) / 0.12 * (1.0 - smoothstep(0.5, 2.5, dl));
      // (And finer still, close up: wisps and knots a few tens of metres across.)
      float dl2 = noiseLod(max(t, gDetT), 610.0) + gDetBias;
      if (dl2 < 2.5) {
        float det2 = textureLod(tNoise, pr0 / 610.0 + vec3(0.37, 0.11, 0.83) + uDrift * 60.0, dl2).g;
        u += 0.06 * (det2 - 0.478) / 0.12 * (1.0 - smoothstep(0.5, 2.5, dl2));
      }
    }
    // (Broken cumulus a little less than the cover: seen at a slant, their sides fill the gaps.)
    float fill = mix(1.0, 0.8, smoothstep(0.3, 0.8, gBroken));
    gMargin = u - (1.0 - fill * base);
    float dens = smoothstep(0.0, 1.0, gMargin / soft) * (0.3 + 0.7 * w.x);
    // (So far off the cells are a few pixels across or less: their average, an even density, as
    // thick as lets through what the gaps between them would, the same cloud on average. (A
    // broken field averaged as thick as its clouds would be one white sheet.))
    float avgK = smoothstep(1.5, 3.0, l1);
    float cAvg = clamp(fill * w.x, 0.0, 0.95);
    dens = mix(dens, -log(1.0 - cAvg) / (SIGMA * 2.5 * max(w.z - w.y, 300.0)) * grad / 0.6, avgK);
    return dens;
  }

  // Henyey-Greenstein-shaped lobe, scaled so a sideways view is ~0.12.
  float cloudPhase(float mu, float g) {
    float g2 = g * g;
    return 0.25 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  }

  // Where a ray is between radii rLo and rHi (the stretch nearest the camera), up to tEnd.
  bool slab(vec3 ro, vec3 rd, float rLo, float rHi, float tEnd, out float tA, out float tB) {
    vec2 top = hitSphere(ro, rd, rHi);
    if (top.y < 0.0) return false;
    vec2 bot = hitSphere(ro, rd, rLo);
    float r0 = length(ro);
    if (r0 > rHi) { tA = top.x; tB = bot.x > 0.0 ? bot.x : top.y; }
    else if (r0 > rLo) { tA = 0.0; tB = bot.x > 0.0 ? bot.x : top.y; }
    else { tA = bot.y; tB = top.y; }
    tB = min(min(tB, tEnd), tA + 90000.0);
    return tB > tA;
  }

  // Sunlight reaching p: through the air (reddened, none in the Earth's shadow).
  vec3 sunAt(vec3 p) {
    if (hitSphere(p, uSun, uRc).x > 0.0) return vec3(0.0);
    float rp = length(p);
    vec2 l = sunDepth(rp - uRc, dot(p, uSun) / rp);
    return exp(-(BR * l.x + BM * 1.1 * l.y));
  }

  // Thin cirrus where the ray crosses CIRRUS_ALT: (light, opacity) and its distance.
  vec4 cirrus(vec3 ro, vec3 rd, float tEnd, float mu, out float tc) {
    float rc = uRc + ${CIRRUS_ALT}.0;
    vec2 h = hitSphere(ro, rd, rc);
    tc = length(ro) > rc ? h.x : h.y;
    if (tc <= 0.0 || tc > tEnd) return vec4(0.0);
    vec3 p = ro + rd * tc;
    vec3 n = p / rc;
    vec4 wa;
    vec4 wb;
    weatherMap(n, wa, wb);
    float hc = wb.x;
    float cov = smoothstep(0.12, 0.6, hc);
    if (cov < 0.01) return vec4(0.0);
    // Wisps: fibres drawn out along the wind, broken up by rounder noise, faint.
    vec3 q = vec3(p.x / 60000.0, p.y / 15000.0, p.z / 30000.0) + uDrift * 4.0;
    float fib = textureLod(tNoise, q, noiseLod(tc, 15000.0)).r * 0.6 + textureLod(tNoise, p / 9000.0 + uDrift * 7.0, noiseLod(tc, 9000.0)).g * 0.4;
    // (Dense anvils and hurricanes' canopies: thick and smooth, not wisps.)
    float dense = smoothstep(0.55, 0.95, hc);
    fib = mix(fib, 0.95, dense * 0.8);
    float a = cov * smoothstep(0.5 - 0.3 * hc, 0.85, fib) * (0.2 + 0.55 * dense);
    // From far off (the wisps far smaller than a pixel): their average, as a sheet of the same
    // overall opacity, streaked along the jet at a scale a pixel still resolves.
    float farC = smoothstep(1500.0, 3500.0, tc * uPixAng / max(abs(dot(rd, n)), 0.1));
    if (farC > 0.0) {
      float streak = textureLod(tNoise, vec3(p.x / 900000.0, p.y / 220000.0, p.z / 450000.0) + uDrift * 0.5, noiseLod(tc, 220000.0)).r;
      float aFar = cov * mix(0.05 + 0.08 * hc, 0.65, dense) * smoothstep(0.5 - 0.3 * hc, 0.8, mix(streak, 0.9, dense * 0.8));
      a = mix(a, aFar, farC);
    }
    if (a < 0.005) return vec4(0.0);
    vec3 col = uCloudSun * (sunAt(p) * (0.7 + 1.2 * cloudPhase(mu, 0.7)) + vec3(0.2, 0.26, 0.36) * smoothstep(-0.15, 0.1, dot(n, uSun)));
    return vec4(col * a, a);
  }

  // How thick (deep) the clouds in weather w are, 0..1.
  float thickW(vec4 w) { return smoothstep(400.0, 6000.0, w.z - w.y); }

  // The clouds as a layer (seen from far off): where the ray crosses the clouds' middle height
  // there, their cover and thickness give how opaque, lit like the march lights a cloud top.
  // Returns (light, transmittance); tHit: its distance.
  vec4 cloudLayer(vec3 ro, vec3 rd, float tEnd, float mu, out float tHit) {
    tHit = 1e30;
    float r0 = length(ro);
    vec2 h = hitSphere(ro, rd, uRc + 2000.0);
    float t = r0 > uRc + 2000.0 ? h.x : h.y;
    if (t <= 0.0 || t > tEnd) return vec4(0.0, 0.0, 0.0, 1.0);
    vec3 n = normalize(ro + rd * t);
    vec4 a;
    vec4 b;
    weatherMap(n, a, b);
    if (a.x < 0.015) return vec4(0.0, 0.0, 0.0, 1.0);
    // (Again at the clouds' own middle height.)
    float mid = 0.5 * (a.z * 4000.0 + a.y * 16000.0);
    h = hitSphere(ro, rd, uRc + mid);
    float t2 = r0 > uRc + mid ? h.x : h.y;
    if (t2 > 0.0 && t2 < tEnd) {
      t = t2;
      n = normalize(ro + rd * t);
      weatherMap(n, a, b);
    }
    float cosv = max(abs(dot(rd, n)), 0.06);
    vec4 w = weatherFine(n, a, b, t / cosv);
    if (w.x < 0.005) return vec4(0.0, 0.0, 0.0, 1.0);
    // The share of the pixel covered, each cloud as opaque as its depth through it (longer seen
    // obliquely; seen edge-on, clouds hide the gaps between them).
    float cov = 1.0 - pow(1.0 - clamp(w.x / 0.85, 0.0, 1.0), 0.6 + 0.4 * cosv);
    float od = SIGMA * 0.45 * (w.z - w.y) * 0.7 / cosv;
    // (Broken cumulus from far off: small clouds with sea between them even inside the share
    // "covered", and thin: a film over the sea, as from orbit, not a white sheet.)
    float alpha = cov * (1.0 - exp(-od)) * (1.0 - (r0 > uRc + mid ? 0.45 : 0.0) * smoothstep(0.6, 0.95, a.w) * (1.0 - thickW(w)));
    vec3 p = ro + rd * t;
    vec3 sunCol = sunAt(p + n * (w.z - mid));
    float phase = 0.55 + 1.6 * mix(cloudPhase(mu, 0.55), cloudPhase(mu, -0.25), 0.3);
    float day = smoothstep(-0.15, 0.1, dot(n, uSun));
    // (Seen from below, the sunlit side is above: darker.)
    float below = r0 < uRc + mid ? 0.45 : 1.0;
    vec3 sky = vec3(0.22, 0.3, 0.42) * 0.8 * day;
    // (Thin, low cloud is greyer than the thick decks and towers: some light gets through it,
    // and from far off it's a film over the dark sea, not a white sheet.)
    float thick = smoothstep(400.0, 6000.0, w.z - w.y);
    float relief = 1.0 + 0.12 * gRelief * (0.4 + 0.6 * (1.0 - abs(dot(n, uSun))));
    vec3 S = uCloudSun * (sunCol * phase * 0.85 * below * (0.72 + 0.33 * thick) * relief + sky);
    tHit = t;
    return vec4(S * alpha, 1.0 - alpha);
  }

  // How much sunlight reaches P (relative to the Earth's centre) through the low clouds above it,
  // 0..1: their shadows on the ground and sea (and anything else under them). t: P's distance
  // from the camera (the detail as seen from there).
  float cloudShadow(vec3 P, float t) {
    float r = length(P);
    vec3 n = P / r;
    float mus = dot(n, uSun);
    if (mus < 0.03) return 1.0;
    vec4 wa;
    vec4 wb;
    weatherMap(n, wa, wb);
    if (wa.x < 0.015) return 1.0;
    float base = wa.z * 4000.0;
    float top = max(base + 200.0, wa.y * 16000.0);
    float h = r - uRc;
    if (h > top) return 1.0;
    // Three samples up through the clouds' heights along the sun's ray (from where it enters them).
    float h0 = max(h, base);
    float dh = (top - h0) / 3.0;
    float od = 0.0;
    gDetT = 0.0;
    for (int i = 0; i < 3; i++) {
      float hs = h0 + (float(i) + 0.5) * dh;
      vec3 q = P + uSun * ((hs - h) / mus);
      vec3 up = normalize(q);
      vec4 qa;
      vec4 qb;
      weatherMap(up, qa, qb);
      vec4 w = weatherFine(up, qa, qb, t);
      od += cloudDensity(q, w, false, t) * dh / mus;
    }
    // (Some light still gets through even a thick cloud's shadow: scattered down through it.)
    return max(exp(-SIGMA * 2.5 * od), 0.2 * exp(-SIGMA * 0.3 * od));
  }

  // The march's density sample at distance t along a ray; w: the weather there. skip: how far
  // on along the ray is surely clear of cloud (0 within the heights this weather has cloud at):
  // the march leaps the clear air above, below and between the weather's clouds.
  // (w, pw: the weather last worked out along this ray, and where: it changes over kilometres,
  // so it's kept for samples within a kilometre of that, not worked out again for every one.)
  float marchDensity(vec3 ro, vec3 rd, float t, inout vec4 w, inout vec3 pw, out float skip) {
    vec3 p = ro + rd * t;
    skip = 0.0;
    gMargin = -1.0;
    if (dot(p - pw, p - pw) < 1e6) return w.x < 0.02 ? 0.0 : cloudDensity(p, w, true, t);
    pw = p;
    vec3 up = normalize(p);
    vec4 wa;
    vec4 wb;
    weatherMap(up, wa, wb);
    float h = length(p) - uRc;
    float muv = dot(rd, up);
    // (Along the ray per metre across the ground.)
    float side = 1.0 / max(sqrt(max(1.0 - muv * muv, 0.0)), 0.05);
    float base = wa.z * 4000.0;
    float top = max(base + 200.0, wa.y * 16000.0);
    skip = 0.0;
    if (wa.x < 0.015) skip = min(4000.0 * side, 20000.0);
    else if (h > top + 30.0) skip = min(muv < 0.0 ? (h - top - 30.0) / -muv : 1e9, 2500.0 * side);
    else if (h < base - 30.0) skip = min(muv > 0.0 ? (base - 30.0 - h) / muv : 1e9, 2500.0 * side);
    if (skip > 0.0) {
      w = vec4(0.0, base, top, wb.w);
      pw = vec3(1e30);
      return 0.0;
    }
    w = weatherFine(up, wa, wb, t / max(abs(muv), 0.15));
    return cloudDensity(p, w, true, t);
  }

  // The march's step through clear air at distance t along a ray (mu: its slope, up = 1):
  // growing with distance (4.5% of it: the clouds are smaller on screen), but never so long it
  // could step over a cloud (150 m in height, 300 m across the ground, both more far off).
  float clearStep(float t, float mu) {
    float lim = min(150.0 / max(abs(mu), 0.01), 300.0 / max(sqrt(max(1.0 - mu * mu, 0.0)), 0.01));
    return clamp(0.045 * t, 50.0, lim * max(1.0, t / 20000.0));
  }

  // Returns (light, transmittance); tFirst: the clouds' distance along the ray. jit: 0..1, this
  // pixel's offset into the first step.
  vec4 clouds(vec3 ro, vec3 rd, float tEnd, float jit, out float tFirst) {
    tFirst = 1e30;
    float mu = dot(rd, uSun);
    float tc;
    vec4 ci = cirrus(ro, rd, tEnd, mu, tc);
    vec4 low = vec4(0.0, 0.0, 0.0, 1.0);
    float tLow = 1e30;
    float tA0;
    float tB0;
    if (slab(ro, rd, uRc + SHELL_LO, uRc + SHELL_HI, tEnd, tA0, tB0)) {
      // From far off (a pixel spans kilometres: the whole Earth, the horizon from orbit) the
      // clouds are drawn as a lit layer; nearer, marched through; blended between.
      float far = smoothstep(1500.0, 3500.0, max(tA0, 1.0) * uPixAng);
      // (Bounds for the march: the weather where the ray enters, leaves and halfway between.)
      vec4 aA, bA, aB, bB, aM, bM;
      weatherMap(normalize(ro + rd * tA0), aA, bA);
      weatherMap(normalize(ro + rd * tB0), aB, bB);
      weatherMap(normalize(ro + rd * (0.5 * (tA0 + tB0))), aM, bM);
      float covMax = max(max(aA.x, aB.x), aM.x);
      float lo = min(min(aA.z, aB.z), aM.z) * 4000.0;
      float hi = max(max(aA.y, aB.y), aM.y) * 16000.0;
      float tA;
      float tB;
      bool inSlab = covMax > 0.015 && slab(ro, rd, uRc + lo, uRc + hi + 50.0, tEnd, tA, tB);
      // How far the march reached (beyond it, the lit layer).
      float tMarch = 1e30;
      if (far < 0.99 && inSlab) {
        // One march for every view (from the ground, inside, just over the tops, from high up):
        // through clear air in steps that grow with distance (see clearStep), leaping where the
        // weather has no cloud. On meeting cloud, its surface is found between that sample and
        // the last (halving), and the cloud sampled from there inward in quarter steps until
        // clear again: every pixel samples a cloud at the same depths into its surface, so it
        // shades smoothly, the same from frame to frame. (Samples at set distances from the
        // camera cut a crisp edge or a flat base into contour rings, or with a random offset,
        // into grain.)
        float phase = 0.55 + 1.6 * mix(cloudPhase(mu, 0.55), cloudPhase(mu, -0.25), 0.3);
        float T = 1.0;
        vec3 C = vec3(0.0);
        float tw = 0.0;
        float sw = 0.0;
        bool inCloud = false;
        int clearRun = 0;
        float tS = tA;
        vec4 w = vec4(0.0);
        vec3 pw = vec3(1e30);
        float muA = dot(rd, normalize(ro + rd * tA));
        float t = tA + jit * clearStep(tA, muA);
        tMarch = tB;
        for (int i = 0; i < 128; i++) {
          if (t > tB) break;
          vec3 p = ro + rd * t;
          float rp = length(p);
          float muv = dot(rd, p) / rp;
          float dIn = max(0.25 * clearStep(t, muv), 30.0);
          gDetT = dIn / uPixAng;
          float skip;
          float dens = marchDensity(ro, rd, t, w, pw, skip);
          if (dens > 0.002 && !inCloud) {
            // Into cloud: its surface, between the last (clear) sample and this one.
            float lo2 = tS;
            float hi2 = t;
            float sk;
            for (int j = 0; j < 4; j++) {
              float m = 0.5 * (lo2 + hi2);
              if (marchDensity(ro, rd, m, w, pw, sk) > 0.002) hi2 = m;
              else lo2 = m;
            }
            inCloud = true;
            clearRun = 0;
            tS = lo2;
            t = lo2 + 0.5 * dIn;
            continue;
          }
          if (inCloud) {
            clearRun = dens > 0.002 ? 0 : clearRun + 1;
            if (clearRun >= 4) inCloud = false;
          }
          if (dens > 0.002) {
            vec3 sunCol = sunAt(p);
            if (sunCol.r + sunCol.g > 0.0) {
              // Through the cloud toward the sun (two samples: one close, with the fine detail,
              // so each billow shades the next, the cauliflower; one farther, of the cloud seen
              // softer-edged), with a floor for the light scattered around inside it.
              gDetBias = 0.5;
              float od = cloudDensity(p + uSun * 60.0, w, true, t) * 150.0;
              gDetBias = 0.0;
              od += cloudDensity(p + uSun * 400.0, w, false, t) * 500.0;
              // (Light scattered on through the cloud: the shadowed side greys gradually, not black.)
              sunCol *= max(max(exp(-SIGMA * od), 0.3 * exp(-SIGMA * 0.25 * od)), 0.12 * exp(-SIGMA * 0.06 * od));
            }
            float hn = clamp((rp - uRc - w.y) / max(w.z - w.y, 100.0), 0.0, 1.0);
            float sunUp = dot(p, uSun) / rp;
            float day = smoothstep(-0.15, 0.1, sunUp);
            // Ambient light: the blue sky's from above (less of it in the creases and under the
            // tops), and the sunlit ground and sea's, grey, from below (lighting the flat bases).
            float odUp = cloudDensity(p + p * (300.0 / rp), w, false, t) * 300.0;
            vec3 sky = mix(vec3(0.2, 0.21, 0.23) * (0.3 + 0.7 * max(sunUp, 0.0)), vec3(0.22, 0.3, 0.42), hn)
                     * day * (0.35 + 0.65 * exp(-SIGMA * 0.5 * odUp));
            float powder = 1.0 - exp(-dens * 5.0);
            vec3 S = uCloudSun * (sunCol * phase * (0.55 + 0.45 * powder) + sky);
            // (Cloud is optically thick: a few hundred metres of it hides what's behind, so its
            // edges are sharp, not a fade.)
            // (Thinned to a mist near the camera: flying through a cloud, the ship stays in view.)
            // (Only the last couple of hundred metres: a cloud just under or beside the camera
            // stays crisp.)
            float nearK = smoothstep(20.0, 250.0, t);
            float a = 1.0 - exp(-SIGMA * 2.5 * dens * dIn * nearK);
            C += T * a * S;
            tw += t * T * a;
            sw += T * a;
            T *= 1.0 - a;
            if (T < 0.03) break;
          }
          tS = t;
          // (Through clear air close to a cloud's edge, as through cloud: wisps there would be
          // stepped over by one pixel and caught by the next, a stipple.)
          t += inCloud ? dIn : gMargin > -0.1 ? 2.0 * dIn : max(clearStep(t, muv), skip);
          tMarch = min(t, tB);
        }
        low = vec4(C, T);
        if (sw > 0.0) tLow = tw / sw;
      }
      if (far > 0.01) {
        float tL;
        vec4 lay = cloudLayer(ro, rd, tEnd, mu, tL);
        low = mix(low, lay, far);
        if (lay.a < 0.999) tLow = tLow < 1e29 ? mix(tLow, tL, far) : tL;
      } else if (inSlab && tMarch < tB) {
        // Beyond the march (low over the horizon, tens of km out): the lit layer, behind it.
        // (Only so far out: a march that ran out of steps near, threading through many clouds,
        // has gaps that show what's under them, not a flat layer's haze.)
        float tL;
        vec4 lay = cloudLayer(ro, rd, tEnd, mu, tL);
        float k = smoothstep(0.85, 1.15, tL / tMarch) * smoothstep(15000.0, 30000.0, tMarch);
        if (k > 0.0 && lay.a < 0.999) {
          lay = mix(vec4(0.0, 0.0, 0.0, 1.0), lay, k);
          low = vec4(low.rgb + low.a * lay.rgb, low.a * lay.a);
          if (tLow > 1e29) tLow = tL;
        }
      }
    }
    // Put the cirrus in front of or behind the lower clouds (it's above them).
    vec4 outc;
    if (ci.a > 0.0 && tc < tLow) outc = vec4(ci.rgb + (1.0 - ci.a) * low.rgb, (1.0 - ci.a) * low.a);
    else outc = vec4(low.rgb + low.a * ci.rgb, low.a * (1.0 - ci.a));
    tFirst = tLow < 1e29 ? tLow : (ci.a > 0.02 ? tc : 1e30);
    return outc;
  }
`;

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const ATMO_COMMON = /* glsl */ `
  uniform sampler2D tDepth;

  uniform vec2 uTanHalf;    // view-space ray slope per unit NDC (1 / proj[0][0], 1 / proj[1][1])
  uniform mat4 uCamWorld;
  uniform vec3 uCenter;     // Earth's center relative to the camera, world axes (m)
  uniform float uRg;        // ground radius under the camera (m)
  uniform float uRa;        // top of the atmosphere (m)
  uniform vec2 uDepthDecode; // projection terms (c, d): view distance along -z = d / (depth + c)
  uniform vec3 uSun;        // unit vector toward the sun
  uniform float uSunI;
  uniform sampler2D tSunDepth; // optical depth toward the sun (sunDepthTable)
  // Clouds (weather.ts): the noise volume, and the weather.
  uniform highp sampler3D tNoise;
  uniform float uClouds;       // 0 = off
  uniform sampler2D tWxA0;     // the weather map, two bakes (weather.ts)
  uniform sampler2D tWxB0;
  uniform sampler2D tWxA1;
  uniform sampler2D tWxB1;
  uniform float uWxBlend;      // between the two bakes
  uniform mat3 uWorldToEcef;   // world -> Earth-fixed directions (the map's axes)
  uniform vec3 uDrift;         // the fine detail's slow drift (noise-space offset)
  uniform float uCloudSun;     // brightness of sunlit cloud
  uniform float uFog;          // ground fog where the camera is, 0..1
  uniform float uPixAng;       // angle one cloud-pass pixel spans, rad
  uniform float uRc;           // the clouds' ground radius: the equator's (see cloudFragment)
  uniform vec3 uPolar;         // the Earth's axis (world)
  uniform vec2 uProjOff;       // projection off-centre terms (elements 8, 9)
  uniform float uFrame;        // frame count (the cloud pass's offsets move on every frame)

  const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6); // Rayleigh scattering at sea level, 1/m
  const float BM = 7e-6;                          // Mie scattering at sea level, 1/m (a clear Gulf day)
  const float HR = 8000.0;                        // Rayleigh scale height, m
  const float HM = 1200.0;                        // Mie scale height, m
  const float G = 0.8;                            // Mie anisotropy
  const int N = 24;

  // Texel centres: table row / column k sits at (k + 0.5) / size.
  vec2 sunDepth(float h, float mu) {
    float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
    float v = sqrt(clamp(h, 0.0, ${TOP}.0) / ${TOP}.0);
    vec2 uv = vec2(u * 255.0 + 0.5, v * 127.0 + 0.5) / vec2(256.0, 128.0);
    return textureLod(tSunDepth, uv, 0.0).xy * ${DEPTH_SCALE}.0;
  }

  // Ray-sphere intersection distances (near, far) for a sphere of radius r at the origin.
  vec2 hitSphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float h = b * b - c;
    if (h < 0.0) return vec2(1e30, -1e30);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }


  ${FOG_GLSL}

  // The view ray through this pixel, from the Earth's centre, and the distance to the solid
  // there (reversed-Z depth: 0 = nothing / far plane).
  void viewRay(vec2 uv, out vec3 ro, out vec3 rd, out float sceneDist, out float mu) {
    float d = texture(tDepth, uv).x;
    // View ray straight from the projection's field of view (unprojecting a far-plane point
    // loses all precision with a 1e8 far / near ratio).
    // (uProjOff: the projection's off-centre terms, e.g. the menu framing the scene to one side.)
    vec3 viewDir = normalize(vec3((uv * 2.0 - 1.0 + uProjOff) * uTanHalf, -1.0));
    rd = normalize((uCamWorld * vec4(viewDir, 0.0)).xyz);
    ro = -uCenter;
    sceneDist = d <= 0.0 ? 1e30 : (uDepthDecode.y / (d + uDepthDecode.x)) / max(1e-4, -viewDir.z);
    mu = dot(rd, uSun);
  }

  ${CLOUD_GLSL}
`;

const fragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tCloudTex;   // the cloud pass: light and transmittance
  uniform sampler2D tCloudDist;  // and the clouds' distance, km
  uniform vec2 uCloudTexel;      // the half-resolution pass's texel, uv
  uniform float uLocalSun;       // the scene's sunlight already dimmed by cloud over the camera, 0..1
  varying vec2 vUv;
  ${ATMO_COMMON}


  void main() {
    vec4 col = texture2D(tColor, vUv);
    vec3 ro;
    vec3 rd;
    float sceneDist;
    float mu0;
    viewRay(vUv, ro, rd, sceneDist, mu0);
    bool sky = sceneDist >= 1e30;

    vec2 ta = hitSphere(ro, rd, uRa);
    vec2 tg = hitSphere(ro, rd, uRg);
    float t0 = max(ta.x, 0.0);
    float t1 = min(ta.y, sceneDist);
    if (tg.x > 0.0) t1 = min(t1, tg.x);
    if (ta.y < 0.0 || t1 <= t0) {
      // Out in space, clear of the air: the sun's disk as it is (in the map, from orbit).
      if (sky && (tg.x < 0.0 || tg.y < 0.0)) col.rgb += smoothstep(0.99996, 0.99999, mu0) * 40.0;
      gl_FragColor = col;
      return;
    }

    // Samples spaced quadratically: dense near the camera, where the air is thickest along
    // near-horizontal rays that run for 1000+ km.
    // Clouds in front of whatever is here: their light, what they let through, and how far away
    // they are (the air beyond them is hidden by them too).
    // (Drawn by the cloud pass, put together at full resolution over the last frames; not over
    // anything solid nearer than them.)
    float tCloud = 1e30;
    vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);
    if (uClouds > 0.5) {
      vec4 c4 = texture2D(tCloudTex, vUv);
      // (The clouds' distance from the half-resolution pass: the nearest of the four around, so
      // at a cloud's edge it's the cloud's, not a blend with the sky's "none" behind it that
      // changes from frame to frame, and the haze in front of the edge with it.)
      vec2 o = 0.5 * uCloudTexel;
      float tf = 1000.0 * min(min(texture2D(tCloudDist, vUv + vec2(o.x, o.y)).r, texture2D(tCloudDist, vUv + vec2(-o.x, o.y)).r),
                              min(texture2D(tCloudDist, vUv + vec2(o.x, -o.y)).r, texture2D(tCloudDist, vUv - o).r));
      if (c4.a < 0.999 && !(sceneDist < tf * 0.97)) {
        cl = c4;
        tCloud = tf;
      }
    }
    vec3 transToCloud = vec3(1.0);
    bool pastCloud = false;

    float len = t1 - t0;
    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    float odR = 0.0;
    float odM = 0.0;
    for (int i = 0; i < N; i++) {
      float a0 = float(i) / float(N);
      float a1 = float(i + 1) / float(N);
      float seg = len * (a1 * a1 - a0 * a0);
      float tm = t0 + len * 0.5 * (a0 * a0 + a1 * a1);
      vec3 p = ro + rd * tm;
      // Clamped: the ground sphere only approximates the ellipsoid, so rays can dip a little
      // below it; never let the density blow up.
      float h = max(length(p) - uRg, -500.0);
      float hr = exp(-h / HR) * seg;
      float hm = exp(-h / HM) * seg;
      // How much of this step lies in front of the clouds (proportional, not all-or-nothing: from
      // orbit a step is tens of km, and switching a whole one as the clouds' distance wobbles
      // would make their edges flicker).
      float s0 = t0 + len * a0 * a0;
      float front = clamp((tCloud - s0) / max(seg, 1.0), 0.0, 1.0);
      if (!pastCloud && front < 1.0) {
        pastCloud = true;
        transToCloud = exp(-(BR * (odR + hr * front) + BM * 1.1 * (odM + hm * front)));
      }
      odR += hr;
      odM += hm;
      // In the Earth's shadow: no sunlight to scatter.
      if (hitSphere(p, uSun, uRg).x > 0.0) continue;
      float rp = length(p);
      vec2 l = sunDepth(rp - uRg, dot(p, uSun) / rp);
      vec3 att = exp(-(BR * (odR + l.x) + BM * 1.1 * (odM + l.y)));
      // Air behind the clouds only shows through what they let through.
      float behind = mix(cl.a, 1.0, front);
      sumR += att * hr * behind;
      sumM += att * hm * behind;
    }
    float mu = dot(rd, uSun);
    float phaseR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
    float g2 = G * G;
    float phaseM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * G * mu, 1.5));
    vec3 inscatter = uSunI * (sumR * BR * phaseR + sumM * BM * phaseM);
    vec3 trans = exp(-(BR * odR + BM * 1.1 * odM));
    if (!pastCloud) transToCloud = trans;
    // The clouds' shadows on the scene (the sunlight it's lit by; less of it where the whole scene
    // is dimmed already, the camera under an overcast).
    if (!sky && uClouds > 0.5) {
      float sh = 0.3 + 0.7 * texture2D(tCloudDist, vUv).g;
      col.rgb *= clamp(sh / max(uLocalSun, 0.05), 0.0, 1.0);
    }
    vec3 outc = col.rgb * trans * cl.a + cl.rgb * transToCloud + inscatter;
    // The sun's disk, reddened by the air in front of it (and hidden by cloud).
    // (No ground ahead: the ray misses it, or it's all behind the camera.)
    if (sky && (tg.x < 0.0 || tg.y < 0.0)) outc += trans * cl.a * smoothstep(0.99996, 0.99999, mu) * 40.0;
    // Guard against any stray non-finite value (bloom would smear it over the whole screen).
    // Ground fog: lit grey, by day; the scene fades into it with distance.
    float fogOD = fogDepth(ro, rd, min(sceneDist, 8e4));
    if (fogOD > 0.0) {
      vec3 up = normalize(ro);
      float day = smoothstep(-0.1, 0.25, dot(up, uSun));
      vec3 fogCol = vec3(0.6, 0.63, 0.67) * (0.06 + 0.94 * day);
      outc = mix(fogCol, outc, exp(-fogOD));
    }
    if (any(notEqual(outc, outc)) || any(greaterThan(outc, vec3(6e4)))) outc = col.rgb;
    gl_FragColor = vec4(max(outc, vec3(0.0)), 1.0);
  }
`;
/** The cloud pass (half resolution, see resolveFragment): cloud light and transmittance, their distance and shadow. */
const cloudVertex = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const cloudFragment = /* glsl */ `
  in vec2 vUv;
  layout(location = 0) out vec4 outCloud;
  layout(location = 1) out vec4 outDist;
  ${ATMO_COMMON}
  uniform vec2 uSub;       // this frame's sub-pixel: which of each 2x2 block of screen pixels
  uniform vec2 uFullSize;  // the screen's size, pixels
  void main() {
    vec3 ro;
    vec3 rd;
    float sceneDist;
    float mu;
    // (Drawn at half resolution, each pixel's ray through one of the four screen pixels it
    // covers, a different one each frame: cloudResolve puts them together.)
    vec2 uv = (2.0 * floor(gl_FragCoord.xy) + uSub + 0.5) / uFullSize;
    viewRay(uv, ro, rd, sceneDist, mu);
    // The clouds sit on the ellipsoid, not a sphere (its radius varies 21 km from the equator to
    // the poles: a sphere of the radius under the camera would put clouds under the ground in
    // places). Stretched along the axis, the ellipsoid becomes a sphere of the equator's radius:
    // march in that space (distances scale by k), where every height is measured right.
    vec3 rdS = rd + uPolar * (dot(rd, uPolar) * ${(RE / RP - 1).toExponential(8)});
    float k = length(rdS);
    rd = rdS / k;
    ro = ro + uPolar * (dot(ro, uPolar) * ${(RE / RP - 1).toExponential(8)});
    sceneDist = sceneDist < 1e29 ? sceneDist * k : sceneDist;
    vec2 tg = hitSphere(ro, rd, uRc);
    // Up to the ground (the ellipsoid), or anything solid well in front of it. (Not the globe's
    // own surface: its tiles are chords, sagging up to ~2 km below the ellipsoid from far off,
    // and would cut low clouds off in a stipple.)
    float tEnd = tg.x > 0.0 ? (sceneDist < tg.x * 0.97 - 50.0 ? sceneDist : tg.x) : sceneDist;
    float tFirst = 1e30;
    // (Each pixel's offset into the march's first step: interleaved gradient noise, moved on
    // every frame.)
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + 0.618034 * uFrame);
    vec4 c = uClouds > 0.5 ? clouds(ro, rd, tEnd, jit, tFirst) : vec4(0.0, 0.0, 0.0, 1.0);
    tFirst /= k;
    tEnd /= k;
    outCloud = c;
    // Where there's no cloud, store where the ray ends (the ground, or whatever's in front), not a
    // "none" value: the atmosphere pass reads this upscaled (blended between pixels), and a huge
    // value blended into a cloud edge would make the edge look farther than the ground behind it
    // and drop it, pixel by pixel, flickering as the view moves.
    // (And in .g: the clouds' shadow on whatever the ray ends at, the ground or a vehicle.)
    float shadow = uClouds > 0.5 && tEnd < 1e29 ? cloudShadow(ro + rd * (tEnd * k), tEnd * k) : 1.0;
    outDist = vec4(min(tFirst < 1e29 ? tFirst : tEnd, 6e7) / 1000.0, shadow, 0.0, 1.0);
  }
`;


/**
 * The clouds at full resolution from the half-resolution pass: each frame's samples are one of
 * the four screen pixels of each 2x2 block (a different one each frame), so the last four frames
 * hold them all. Kept in a history, moved with the camera (each pixel reprojected by its clouds'
 * distance), and held to the range of this frame's samples around it (where the history is
 * wrong, a solid moved, the view changed: this frame's, not a ghost).
 */
const resolveFragment = /* glsl */ `
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  uniform sampler2D tCur;      // this frame's samples (half resolution)
  uniform sampler2D tCurDist;  // their distance, km
  uniform sampler2D tHist;     // the history (full resolution)
  uniform vec2 uSub;
  uniform vec2 uFullSize;
  uniform vec2 uHalfSize;
  uniform float uHistOk;       // 0: no usable history (first frame, resized)
  uniform vec2 uTanHalf;
  uniform vec2 uProjOff;
  uniform mat4 uCamWorld;
  uniform vec3 uCamMove;       // the camera's move since the last frame (world, m)
  uniform mat3 uPrevView;      // the last frame's world -> view rotation
  uniform vec2 uPrevTanHalf;
  uniform vec2 uPrevProjOff;

  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    ivec2 h = px / 2;
    ivec2 hMax = ivec2(uHalfSize) - 1;
    vec4 here = texelFetch(tCur, min(h, hMax), 0);
    bool fresh = all(equal(px - 2 * h, ivec2(uSub)));
    // This frame's samples around: their range, and their blend at this pixel.
    vec4 lo = here;
    vec4 hi = here;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec4 c = texelFetch(tCur, clamp(h + ivec2(i, j), ivec2(0), hMax), 0);
        lo = min(lo, c);
        hi = max(hi, c);
      }
    }
    vec2 uvHalf = ((vec2(px) - uSub) * 0.5 + 0.5) / uHalfSize;
    vec4 cur = texture(tCur, uvHalf);
    // Where this pixel's clouds were on screen last frame.
    vec2 uv = (vec2(px) + 0.5) / uFullSize;
    vec3 viewDir = normalize(vec3((uv * 2.0 - 1.0 + uProjOff) * uTanHalf, -1.0));
    vec3 rd = normalize((uCamWorld * vec4(viewDir, 0.0)).xyz);
    float d = texture(tCurDist, uvHalf).r * 1000.0;
    vec3 v = uPrevView * (rd * d + uCamMove);
    vec2 uvPrev = ((v.xy / max(-v.z, 1e-6)) / uPrevTanHalf - uPrevProjOff) * 0.5 + 0.5;
    bool ok = uHistOk > 0.5 && v.z < 0.0 && all(greaterThanEqual(uvPrev, vec2(0.0))) && all(lessThanEqual(uvPrev, vec2(1.0)));
    if (!ok) {
      outColor = fresh ? here : cur;
      return;
    }
    vec4 hist = clamp(texture(tHist, uvPrev), lo, hi);
    // (A pixel's new sample blended in, not swapped: each is a little noisy, the march's offsets
    // moving on every frame; averaged over a few, they settle.)
    outColor = fresh ? mix(hist, here, 0.3) : hist;
  }
`;

export class SceneAtmospherePass extends Pass {
  readonly uniforms = {
    tColor: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uCamWorld: FX_SHARED.uCamWorld,
    uCenter: FX_SHARED.uCenter,
    uRg: FX_SHARED.uRg,
    uRa: { value: 6371e3 + 100e3 },
    uDepthDecode: { value: new THREE.Vector2(0, 1) },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSunI: { value: 18 },
    tSunDepth: { value: sunDepthTable() as THREE.Texture },
    tNoise: { value: null as THREE.Texture | null },
    tCloudTex: FX_SHARED.tCloudTex,
    tCloudDist: FX_SHARED.tCloudDist,
    uCloudTexel: { value: new THREE.Vector2(1, 1) },
    uLocalSun: { value: 1 },
    uClouds: FX_SHARED.uClouds,
    uFog: FX_SHARED.uFog,
    tWxA0: { value: null as THREE.Texture | null },
    tWxB0: { value: null as THREE.Texture | null },
    tWxA1: { value: null as THREE.Texture | null },
    tWxB1: { value: null as THREE.Texture | null },
    uWxBlend: { value: 0 },
    uWorldToEcef: { value: new THREE.Matrix3() },
    uDrift: { value: new THREE.Vector3() },
    uCloudSun: { value: 1.4 },
    uPixAng: { value: 0.001 },
    uRc: { value: RE },
    uPolar: { value: new THREE.Vector3(0, 1, 0) },
    uProjOff: { value: new THREE.Vector2() },
    uFrame: { value: 0 },
    uSub: { value: new THREE.Vector2() },
    uFullSize: { value: new THREE.Vector2(1, 1) },
  };
  private resolveUniforms = {
    tCur: { value: null as THREE.Texture | null },
    tCurDist: { value: null as THREE.Texture | null },
    tHist: { value: null as THREE.Texture | null },
    uSub: this.uniforms.uSub,
    uFullSize: this.uniforms.uFullSize,
    uHalfSize: { value: new THREE.Vector2(1, 1) },
    uHistOk: { value: 0 },
    uTanHalf: this.uniforms.uTanHalf,
    uProjOff: this.uniforms.uProjOff,
    uCamWorld: this.uniforms.uCamWorld,
    uCamMove: { value: new THREE.Vector3() },
    uPrevView: { value: new THREE.Matrix3() },
    uPrevTanHalf: { value: new THREE.Vector2(1, 1) },
    uPrevProjOff: { value: new THREE.Vector2() },
  };
  private resolveQuad: FullScreenQuad;
  /** The clouds at full resolution, two (this frame's and the last's, swapped each frame). */
  private history = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  private frame = 0;
  private prevCenter = new THREE.Vector3();
  private histValid = false;
  private quad: FullScreenQuad;
  /** Clouds at half resolution (see resolveFragment): light + transmittance, and distance. */
  private cloudQuad: FullScreenQuad;
  private cloudTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, count: 2, depthBuffer: false });
  private clearColor = new THREE.Color();
  private fxLayers = new THREE.Layers();
  /**
   * The solids are drawn here, multisampled (4x MSAA: smooth edges). Only this target needs the
   * samples: the atmosphere and everything after it work on the resolved image, in the
   * composer's plain targets, which is much cheaper than carrying 4 samples per pixel through
   * every full-screen pass.
   */
  private sceneTarget: THREE.WebGLRenderTarget;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    super();
    this.needsSwap = true;
    this.fxLayers.set(FX_LAYER);
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, depthTest: false, depthWrite: false }),
    );
    this.cloudQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        uniforms: this.uniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.resolveQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: resolveFragment,
        uniforms: this.resolveUniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
      }),
    );
    for (const t of [this.cloudTarget, ...this.history]) {
      for (const tex of t.textures) {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
      }
    }
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.cloudTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
    for (const h of this.history) h.setSize(width, height);
    this.uniforms.uFullSize.value.set(width, height);
    this.resolveUniforms.uHalfSize.value.set(this.cloudTarget.width, this.cloudTarget.height);
    this.uniforms.uCloudTexel.value.set(1 / this.cloudTarget.width, 1 / this.cloudTarget.height);
    this.histValid = false;
  }

  /**
   * earthCenter: Earth's center relative to the camera (world axes, m); groundRadius: the
   * ellipsoid's radius under the camera; sunDir: unit vector toward the sun.
   */
  setFrame(earthCenter: THREE.Vector3, groundRadius: number, sunDir: THREE.Vector3): void {
    this.uniforms.uCenter.value.copy(earthCenter);
    this.uniforms.uRg.value = groundRadius;
    this.uniforms.uRa.value = groundRadius + 100e3;
    this.uniforms.uSun.value.copy(sunDir).normalize();
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const layers = cam.layers.mask;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const scene = this.sceneTarget;

    // 1. Solid objects, with depth, over black (space).
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    cam.layers.set(0);
    renderer.setRenderTarget(scene);
    renderer.clear();
    renderer.render(this.scene, cam);

    // 2. Atmosphere over them, into the composer's buffer.
    cam.updateMatrixWorld();
    const pe = cam.projectionMatrix.elements;
    this.uniforms.uTanHalf.value.set(1 / pe[0], 1 / pe[5]);
    this.uniforms.uProjOff.value.set(pe[8], pe[9]);
    this.uniforms.uCamWorld.value.copy(cam.matrixWorld);
    this.uniforms.uDepthDecode.value.set(pe[10], pe[14]);
    this.uniforms.tColor.value = scene.texture;
    this.uniforms.tDepth.value = scene.depthTexture;
    FX_SHARED.uInvProj.value.copy(cam.projectionMatrixInverse);
    FX_SHARED.uScreen.value.set(writeBuffer.width, writeBuffer.height);
    if (this.uniforms.uClouds.value > 0.5) {
      const u = this.uniforms;
      const r = this.resolveUniforms;
      u.uPixAng.value = (2 / pe[5]) / this.cloudTarget.height;
      const f = this.frame++;
      u.uFrame.value = f % 64;
      u.uSub.value.set(...SUBPIXELS[f % 4]);
      renderer.setRenderTarget(this.cloudTarget);
      this.cloudQuad.render(renderer);
      // Put together with the last frames, at full resolution.
      const [prev, next] = f % 2 ? [this.history[0], this.history[1]] : [this.history[1], this.history[0]];
      r.tCur.value = this.cloudTarget.textures[0];
      r.tCurDist.value = this.cloudTarget.textures[1];
      r.tHist.value = prev.texture;
      r.uHistOk.value = this.histValid ? 1 : 0;
      r.uCamMove.value.copy(this.prevCenter).sub(u.uCenter.value);
      renderer.setRenderTarget(next);
      this.resolveQuad.render(renderer);
      u.tCloudTex.value = next.texture;
      u.tCloudDist.value = this.cloudTarget.textures[1];
      // (This frame's view, for the next.)
      this.prevCenter.copy(u.uCenter.value);
      r.uPrevView.value.setFromMatrix4(cam.matrixWorld).transpose();
      r.uPrevTanHalf.value.copy(u.uTanHalf.value);
      r.uPrevProjOff.value.copy(u.uProjOff.value);
      this.histValid = true;
    } else {
      this.histValid = false;
    }
    renderer.setRenderTarget(writeBuffer);
    this.quad.render(renderer);

    // 3. The glowing effects on top, depth-tested against the solids: their (resolved) depth is
    // copied into this buffer's depth first.
    if (this.fxVisible() && writeBuffer.depthTexture) {
      this.copyDepth(renderer, scene, writeBuffer);
      renderer.setRenderTarget(writeBuffer);
      renderer.shadowMap.autoUpdate = false;
      cam.layers.set(FX_LAYER);
      renderer.render(this.scene, cam);
    }

    cam.layers.mask = layers;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.autoClear = autoClear;
    renderer.setClearColor(this.clearColor, clearAlpha);
  }

  /** Blit the resolved depth of one target into another's (same size and depth format). */
  private copyDepth(renderer: THREE.WebGLRenderer, from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    // (Make sure both have their GL framebuffers.)
    renderer.setRenderTarget(to);
    const props = renderer.properties as unknown as { get(o: object): { __webglFramebuffer?: WebGLFramebuffer } };
    const src = props.get(from).__webglFramebuffer;
    const dst = props.get(to).__webglFramebuffer;
    if (!src || !dst) return;
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    renderer.setRenderTarget(null);
  }

  /** Whether anything on the effects layer is showing (exhaust, smoke, plasma...). */
  private fxVisible(): boolean {
    let any = false;
    const fx = this.fxLayers;
    this.scene.traverseVisible((o) => {
      const drawable = (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Line).isLine;
      if (!drawable || !o.layers.test(fx)) return;
      any = true;
      // (Every effect fades behind clouds and into fog: patched the first time it's seen.)
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(mat) ? mat : [mat]) if ((m as THREE.ShaderMaterial).isShaderMaterial) occludeFx(m as THREE.ShaderMaterial);
    });
    return any;
  }

  dispose(): void {
    this.quad.dispose();
    this.cloudQuad.dispose();
    this.cloudTarget.dispose();
    this.resolveQuad.dispose();
    for (const h of this.history) h.dispose();
    this.sceneTarget.dispose();
  }
}
