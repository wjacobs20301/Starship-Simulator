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
  uLocalDir: { value: new THREE.Vector3(0, 1, 0) },
  uLocalR: { value: new THREE.Vector2(0.99889, 0.99972) },
  uFog: { value: 0 },
};

/**
 * Ground fog around Starbase: extinction FOG_K (1/m) at the ground, thinning with height
 * (scale FOG_H), faded out beyond the local weather's radius. Optical depth along a ray from ro
 * (relative to the Earth's centre) over distance t (flat ground: fine over tens of km).
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
    float w = max(smoothstep(uLocalR.x, uLocalR.y, dot(up, uLocalDir)), smoothstep(uLocalR.x, uLocalR.y, dot(normalize(ro + rd * min(t, 3e5)), uLocalDir)));
    return uFog * FOG_K * max(od, 0.0) * w;
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
  uniform vec3 uLocalDir;
  uniform vec2 uLocalR;
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
 * The cloud layer's bounds above the ground (m): no cloud below or above. Within them the base
 * and top vary with the weather (weatherAt). The noise's scales, m.
 */
export const CLOUD_SHELL_LO = 500;
export const CLOUD_SHELL_HI = 12000;
export const CLOUD_SHAPE_SCALE = 12000;
const CLOUD_DETAIL_SCALE = 2600;
/** Cirrus: a thin sheet this high, m. */
const CIRRUS_ALT = 10000;

/**
 * Clouds over the whole planet, marched per pixel:
 *  - weather systems: cloud cover from domain-warped noise (swirled, not blobby), wetter at the
 *    equator and in the storm tracks of the mid-latitudes, clear over much of the subtropics;
 *  - the base and top vary: shallow fair-weather cumulus in light cover, thick decks where it's
 *    heavy, and here and there storm towers reaching ~11 km;
 *  - cells shaped by the billow noise and frayed by the finer one;
 *  - thin streaky cirrus up at ~10 km;
 *  - lit by the sun through the air (reddening at sunset, dark on the night side) and through the
 *    cloud above each point, plus sky light.
 * weatherAt() must match weather.ts (the CPU uses it for rain and overcast lighting).
 */
const CLOUD_GLSL = /* glsl */ `
  const float SHELL_LO = ${CLOUD_SHELL_LO}.0;
  const float SHELL_HI = ${CLOUD_SHELL_HI}.0;
  const float SIGMA = 0.02;

  // The weather over a point on the globe (n: unit, from the Earth's centre), in two parts.
  // The broad part (weatherBroad) changes over hundreds of km: a ray's clouds take it from where
  // the ray enters and leaves the layer, interpolated. The fine part (weatherFine: the smallest
  // scales, which set the edges of the cloud fields) is taken at each sample itself, so the edges
  // are fixed on the ground: interpolated from far-apart points, they'd swim as the view moved.
  // Broad: x = cover before the fine scales and the threshold, y = cloud base (m),
  // z = where towers grow (0..1), w = the kind of cells; warp: the offset of the warped field.
  vec4 weatherBroad(vec3 n, out vec3 warp) {
    // The whole field is offset by uDrift: a new random weather map each flight, drifting slowly.
    vec3 m = n + uDrift;
    // Warped twice: large swirls, then curls and comma shapes within them (fronts, lows), not blobs.
    vec3 w1 = vec3(
      textureLod(tNoise, m * 1.1 + vec3(0.1, 0.2, 0.3), 0.0).r,
      textureLod(tNoise, m * 1.1 + vec3(0.6, 0.9, 0.4), 0.0).r,
      textureLod(tNoise, m * 1.1 + vec3(0.35, 0.05, 0.8), 0.0).r
    );
    vec3 q1 = m + (w1 - 0.5) * 0.7;
    vec3 w2 = vec3(
      textureLod(tNoise, q1 * 2.7 + vec3(0.8, 0.15, 0.55), 0.0).r,
      textureLod(tNoise, q1 * 2.7 + vec3(0.25, 0.65, 0.05), 0.0).r,
      textureLod(tNoise, q1 * 2.7 + vec3(0.45, 0.35, 0.95), 0.0).r
    );
    vec3 q = q1 + (w2 - 0.5) * 0.28;
    warp = q - m;
    // Three broad scales, from ocean-wide systems down to cloud fields a few hundred km across
    // (a fourth, finer, in weatherFine).
    float c = 0.4 * textureLod(tNoise, q * 1.9, 0.0).r
            + 0.28 * textureLod(tNoise, q * 4.7 + vec3(0.4, 0.1, 0.7), 0.0).r
            + 0.18 * textureLod(tNoise, q * 11.3 + vec3(0.2, 0.8, 0.5), 0.0).r;
    float lat = asin(clamp(dot(n, uAxis), -1.0, 1.0)) * 57.29578;
    float al = abs(lat);
    float band = 0.42 + 0.3 * exp(-lat * lat / 80.0) - 0.26 * exp(-(al - 24.0) * (al - 24.0) / 90.0)
               + 0.18 * exp(-(al - 55.0) * (al - 55.0) / 140.0) - 0.08 * exp(-(al - 78.0) * (al - 78.0) / 100.0);
    // (Summed octaves bunch up round the middle: stretched back out. Latitude only nudges it:
    // wetter tropics and storm tracks, drier subtropics.)
    float pre = (c - 0.5) * 2.4 + 0.5 + (band - 0.45) * 0.45;
    float conv = textureLod(tNoise, q * 9.0 + vec3(0.7, 0.3, 0.1), 0.0).g;
    float base = 650.0 + 1000.0 * textureLod(tNoise, q * 4.0 + vec3(0.9, 0.5, 0.2), 0.0).r;
    // What kind of cells: small puffy cumulus (0) to broad stratocumulus sheets (1), by region.
    float kind = smoothstep(0.35, 0.65, textureLod(tNoise, q * 6.0 + vec3(0.15, 0.85, 0.35), 0.0).r);
    return vec4(pre, base, conv, kind);
  }

  // Mip level for noise of period "scale" (m) seen from distance t: about one texel per pixel.
  float noiseLod(float t, float scale) {
    return max(0.0, log2(max(t, 1.0) * uPixAng * ${NOISE_SIZE}.0 / scale));
  }

  // Cover, base, top from the broad weather and a cover value.
  vec4 weatherFrom(vec4 b, float cov) {
    float depth = 350.0 + 3000.0 * cov * cov + 7000.0 * smoothstep(0.62, 0.85, b.z) * smoothstep(0.6, 0.9, cov);
    return vec4(cov, b.y, min(b.y + depth, SHELL_HI - 200.0), b.w);
  }

  // The full weather at n from its broad part: x = cloud cover 0..1, y = base (m), z = top (m),
  // w = the kind of cells. (The finest scale breaks the masses up: fields ~80 km across.)
  // t: seen from this far (m; over the pixel's footprint on the layer, stretched when seen
  // edge-on); from far off the fine scales are averaged, not sampled sparsely
  // (which makes the cloud fields' edges shimmer as the view moves).
  vec4 weatherFine(vec3 n, vec4 b, vec3 warp, float t) {
    vec3 q = n + uDrift + warp;
    // (The finest scale fades out once its fields shrink to a pixel or so: thresholded into
    // cover, pixel-sized fields blink on and off as the view moves. As it fades, the threshold
    // widens by as much, so the average cover stays the same: where it would have broken thin
    // cover into flecks there's a faint veil, not nothing, and no ring where the fade happens.)
    float fine = 1.0 - smoothstep(-2.0, 0.0, log2(max(t, 1.0) * uPixAng * ${NOISE_SIZE}.0 * 120.0 / uRg));
    float pre = b.x + 0.336 * textureLod(tNoise, q * 27.0 + vec3(0.6, 0.3, 0.9), noiseLod(t, uRg / 27.0)).g
              + (textureLod(tNoise, q * 120.0 + vec3(0.2, 0.4, 0.6), noiseLod(t, uRg / 120.0)).r - 0.5) * 0.35 * fine;
    float soft = 0.14 * (1.0 - fine);
    return weatherFrom(b, smoothstep(0.85 - soft, 1.07 + soft, pre));
  }

  // The most the fine scales could make of the broad weather (for bounding the march).
  vec4 weatherMost(vec4 b) {
    return weatherFrom(b, smoothstep(0.85, 1.07, b.x + 0.336 + 0.175));
  }

  vec4 weatherAt(vec3 n) {
    vec3 warp;
    vec4 b = weatherBroad(n, warp);
    return weatherFine(n, b, warp, 0.0);
  }


  // Cloud density 0..1 at p (relative to the Earth's centre), in weather w (see weatherAt),
  // seen from distance t.
  float cloudDensity(vec3 p, vec4 w, bool detailed, float t) {
    if (w.x < 0.02) return 0.0;
    float h = length(p) - uRg;
    float hn = (h - w.y) / max(w.z - w.y, 100.0);
    if (hn <= 0.0 || hn >= 1.0) return 0.0;
    // Flat bases, rounded tops.
    float grad = smoothstep(0.0, 0.1, hn) * (1.0 - smoothstep(0.5, 1.0, hn));
    float base = w.x * grad;
    if (base < 0.01) return 0.0;
    // Cells at two scales (different periods: no visible repeat); the light samples take one.
    // Cumulus cells ~2 km across, or broad sheets ~15 km; the light samples take the nearer kind.
    float small = textureLod(tNoise, p / 7000.0 + uDrift * 40.0, noiseLod(t, 7000.0)).r;
    float shape = small;
    if (detailed || w.w > 0.5) shape = mix(small, textureLod(tNoise, p / 30000.0 + vec3(0.7, 0.1, 0.4) + uDrift * 40.0, noiseLod(t, 30000.0)).r, w.w);
    // (Light cover is thin: you see through it.)
    // (Soft-edged: a hard threshold aliases into crawling edges seen from far off.)
    float dens = smoothstep(0.0, 1.0, (shape - (1.0 - base)) / max(base, 0.05)) * (0.3 + 0.7 * w.x);
    if (detailed && dens > 0.0) {
      float det = textureLod(tNoise, p / ${CLOUD_DETAIL_SCALE}.0 + uDrift * 40.0, noiseLod(t, ${CLOUD_DETAIL_SCALE}.0)).g;
      dens = max(0.0, dens - det * 0.35 * (1.0 - dens));
    }
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
    if (hitSphere(p, uSun, uRg).x > 0.0) return vec3(0.0);
    float rp = length(p);
    vec2 l = sunDepth(rp - uRg, dot(p, uSun) / rp);
    return exp(-(BR * l.x + BM * 1.1 * l.y));
  }

  // Thin cirrus where the ray crosses CIRRUS_ALT: (light, opacity) and its distance.
  vec4 cirrus(vec3 ro, vec3 rd, float tEnd, float mu, out float tc) {
    float rc = uRg + ${CIRRUS_ALT}.0;
    vec2 h = hitSphere(ro, rd, rc);
    tc = length(ro) > rc ? h.x : h.y;
    if (tc <= 0.0 || tc > tEnd || tc > 4e5) return vec4(0.0);
    vec3 p = ro + rd * tc;
    vec3 n = p / rc;
    float cov = smoothstep(0.6, 0.85, texture(tNoise, n * 3.3 + vec3(0.5, 0.5, 0.1) + uDrift).r);
    if (cov < 0.01) return vec4(0.0);
    // Wisps: fibres drawn out along the wind, broken up by rounder noise, faint.
    vec3 q = vec3(p.x / 60000.0, p.y / 15000.0, p.z / 30000.0) + uDrift * 4.0;
    float fib = textureLod(tNoise, q, noiseLod(tc, 15000.0)).r * 0.6 + textureLod(tNoise, p / 9000.0 + uDrift * 7.0, noiseLod(tc, 9000.0)).g * 0.4;
    float a = cov * smoothstep(0.5, 0.85, fib) * 0.18;
    if (a < 0.005) return vec4(0.0);
    vec3 col = uCloudSun * (sunAt(p) * (0.7 + 1.2 * cloudPhase(mu, 0.7)) + vec3(0.2, 0.26, 0.36) * smoothstep(-0.15, 0.1, dot(n, uSun)));
    return vec4(col * a, a);
  }

  // Returns (light, transmittance); tFirst: the clouds' distance along the ray.
  vec4 clouds(vec3 ro, vec3 rd, float tEnd, out float tFirst) {
    tFirst = 1e30;
    float mu = dot(rd, uSun);
    float tc;
    vec4 ci = cirrus(ro, rd, tEnd, mu, tc);
    vec4 low = vec4(0.0, 0.0, 0.0, 1.0);
    float tLow = 1e30;
    float tA0;
    float tB0;
    if (slab(ro, rd, uRg + SHELL_LO, uRg + SHELL_HI, tEnd, tA0, tB0)) {
      vec3 warpA;
      vec3 warpB;
      vec4 bA = weatherBroad(normalize(ro + rd * tA0), warpA);
      vec4 bB = weatherBroad(normalize(ro + rd * tB0), warpB);
      // (Bounds for the march: the most cloud the fine scales could give.)
      vec4 wA = weatherMost(bA);
      vec4 wB = weatherMost(bB);
      float tA;
      float tB;
      // March only the heights this weather has cloud at.
      if (max(wA.x, wB.x) > 0.02 && slab(ro, rd, uRg + min(wA.y, wB.y), uRg + max(wA.z, wB.z) + 50.0, tEnd, tA, tB)) {
        const int NC = 28;
        float rTop = uRg + max(wA.z, wB.z) + 50.0;
        float rBase = uRg + min(wA.y, wB.y);
        // From above the clouds (orbit), sample on fixed-altitude shells through the layer: the
        // samples stay put in the world as the camera moves (stepping along the ray from the
        // camera, they'd slide through the clouds every frame and the edges would crawl).
        // Inside or below the layer, step along the ray, each pixel offset a little into the step.
        bool fromAbove = length(ro) > rTop;
        // (Spacing 150 m, doubled as often as needed for tall towers to fit in NC shells.)
        float SHELL_DH = 150.0 * exp2(max(0.0, ceil(log2((rTop - rBase) / (150.0 * float(NC))))));
        float kTop = floor((rTop - uRg - SHELL_LO) / SHELL_DH);
        // (From above: the shells' middles, steady. Else a fixed offset per pixel into the step.)
        float jit = fromAbove ? 0.5 : fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float phase = 0.55 + 1.6 * mix(cloudPhase(mu, 0.55), cloudPhase(mu, -0.25), 0.3);
        float T = 1.0;
        vec3 C = vec3(0.0);
        float tw = 0.0;
        float sw = 0.0;
        float tPrev = tA;
        if (fromAbove) tPrev = hitSphere(ro, rd, uRg + SHELL_LO + (kTop + 1.0) * SHELL_DH).x;
        for (int i = 0; i < NC; i++) {
          float t;
          float dt;
          if (fromAbove) {
            // Altitudes on one fixed grid (every SHELL_DH), from just under this weather's tops
            // down: the same heights for every ray and every frame.
            float h = SHELL_LO + (kTop - float(i) + 0.5) * SHELL_DH;
            if (uRg + h < rBase - SHELL_DH) break;
            vec2 hs = hitSphere(ro, rd, uRg + h);
            if (hs.x <= 0.0 || hs.x > 9e29 || hs.x > tB) break;
            t = hs.x;
            dt = max(t - tPrev, 1.0);
            tPrev = t;
          } else {
            dt = (tB - tA) / float(NC);
            t = tA + (float(i) + jit) * dt;
          }
          vec3 p = ro + rd * t;
          float f = clamp((t - tA0) / max(1.0, tB0 - tA0), 0.0, 1.0);
          vec3 up = normalize(p);
          vec4 w = weatherFine(up, mix(bA, bB, f), mix(warpA, warpB, f), t / max(abs(dot(rd, up)), 0.15));
          float dens = cloudDensity(p, w, true, t);
          if (dens <= 0.002) continue;
          vec3 sunCol = sunAt(p);
          if (sunCol.r + sunCol.g > 0.0) {
            // Through the cloud above toward the sun (two samples), with a floor for the light
            // scattered around inside it.
            float od = cloudDensity(p + uSun * 180.0, w, false, t) * 180.0 + cloudDensity(p + uSun * 700.0, w, false, t) * 520.0;
            sunCol *= max(exp(-SIGMA * od), 0.3 * exp(-SIGMA * 0.25 * od));
          }
          float rp = length(p);
          float hn = clamp((rp - uRg - w.y) / max(w.z - w.y, 100.0), 0.0, 1.0);
          float day = smoothstep(-0.15, 0.1, dot(p, uSun) / rp);
          vec3 sky = vec3(0.22, 0.3, 0.42) * (0.45 + 0.55 * hn) * day;
          float powder = 1.0 - exp(-dens * 5.0);
          vec3 S = uCloudSun * (sunCol * phase * (0.55 + 0.45 * powder) + sky);
          float a = 1.0 - exp(-SIGMA * dens * dt);
          C += T * a * S;
          tw += t * T * a;
          sw += T * a;
          T *= 1.0 - a;
          if (T < 0.02) break;
        }
        low = vec4(C, T);
        if (sw > 0.0) tLow = tw / sw;
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
  uniform vec3 uAxis;          // the Earth's axis (world)
  uniform vec3 uLocalDir;      // Starbase, from the Earth's centre (world)
  uniform vec2 uLocalR;        // cos of the local weather's outer / inner radius
  uniform float uLocalCover;   // cloud cover set for Starbase (0..1), < 0: none set
  uniform vec3 uDrift;         // the weather's slow drift (noise-space offset)
  uniform float uCloudSun;     // brightness of sunlit cloud
  uniform float uFog;          // ground fog around Starbase, 0..1
  uniform float uPixAng;       // angle one cloud-pass pixel spans, rad
  uniform vec2 uProjOff;       // projection off-centre terms (elements 8, 9)

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
    // (Drawn at half resolution by the cloud pass; not over anything solid nearer than them.)
    float tCloud = 1e30;
    vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);
    if (uClouds > 0.5) {
      vec4 c4 = texture2D(tCloudTex, vUv);
      float tf = texture2D(tCloudDist, vUv).r * 1000.0;
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
/** The cloud pass (half resolution): cloud light and transmittance, and their distance. */
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
  void main() {
    vec3 ro;
    vec3 rd;
    float sceneDist;
    float mu;
    viewRay(vUv, ro, rd, sceneDist, mu);
    vec2 tg = hitSphere(ro, rd, uRg);
    float tEnd = tg.x > 0.0 ? min(sceneDist, tg.x) : sceneDist;
    float tFirst = 1e30;
    vec4 c = uClouds > 0.5 ? clouds(ro, rd, tEnd, tFirst) : vec4(0.0, 0.0, 0.0, 1.0);
    outCloud = c;
    // Where there's no cloud, store where the ray ends (the ground, or whatever's in front), not a
    // "none" value: the atmosphere pass reads this upscaled (blended between pixels), and a huge
    // value blended into a cloud edge would make the edge look farther than the ground behind it
    // and drop it, pixel by pixel, flickering as the view moves.
    outDist = vec4(min(tFirst < 1e29 ? tFirst : tEnd, 6e7) / 1000.0, 0.0, 0.0, 1.0);
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
    uClouds: FX_SHARED.uClouds,
    uFog: FX_SHARED.uFog,
    uAxis: { value: new THREE.Vector3(0, 1, 0) },
    uLocalDir: FX_SHARED.uLocalDir,
    uLocalR: FX_SHARED.uLocalR,
    uLocalCover: { value: -1 },
    uDrift: { value: new THREE.Vector3() },
    uCloudSun: { value: 1.4 },
    uPixAng: { value: 0.001 },
    uProjOff: { value: new THREE.Vector2() },
  };
  private quad: FullScreenQuad;
  /** Clouds at half resolution (they're soft): light + transmittance, and distance. */
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
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.cloudTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
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
      u.uPixAng.value = (2 / pe[5]) / this.cloudTarget.height;
      renderer.setRenderTarget(this.cloudTarget);
      this.cloudQuad.render(renderer);
      u.tCloudTex.value = this.cloudTarget.textures[0];
      u.tCloudDist.value = this.cloudTarget.textures[1];
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
    this.sceneTarget.dispose();
  }
}
