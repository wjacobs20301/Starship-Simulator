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
 * The two halves of the solid scene, drawn apart (set each frame from setBackground's roots):
 * the background (terrain, the globe, the Moon, stars), which the clouds are marched against,
 * and everything else (vehicles, the pad, buildings), drawn over the clouds and the air with
 * its own smooth (multisampled) edges.
 */
const BG_LAYER = 2;
const NEAR_LAYER = 3;

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
  uRainMist: { value: 0 },
};

/**
 * Ground fog where the camera is (uFog, from the weather there): extinction FOG_K (1/m) at the
 * ground, thinning with height (scale FOG_H). Optical depth along a ray from ro (relative to the
 * Earth's centre) over distance t (flat ground: fine over tens of km). Fog banks seen from afar
 * are drawn by the clouds (the weather map has them as cloud at the ground).
 */
const FOG_GLSL = /* glsl */ `
  float fogDepth(vec3 ro, vec3 rd, float t) {
    if (uFog <= 0.0 && uRainMist <= 0.0) return 0.0;
    const float FOG_K = 2.4e-3;
    const float FOG_H = 140.0;
    vec3 up = normalize(ro);
    float hc = max(length(ro) - uRg, 0.0);
    float a = dot(rd, up);
    float hEnd = max(hc + a * t, 0.0);
    float od = abs(a) < 1e-4 ? t * exp(-hc / FOG_H) : FOG_H / a * (exp(-hc / FOG_H) - exp(-hEnd / FOG_H));
    // (And the rain's: the falling rain greys the distance out, a few km of visibility, all the
    // way up to the cloud base.)
    const float RAIN_K = 2.8e-4;
    const float RAIN_H = 900.0;
    float odR = abs(a) < 1e-4 ? t * exp(-hc / RAIN_H) : RAIN_H / a * (exp(-hc / RAIN_H) - exp(-hEnd / RAIN_H));
    return uFog * FOG_K * max(od, 0.0) + uRainMist * RAIN_K * max(odR, 0.0);
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
  uniform float uRainMist;
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
  // (And gConvMap: how much of it is deep convection, thunderstorms, 0..1: only looked up where
  // the cloud is deep.)
  float gConvMap = 0.0;
  // (The map's latitudes are geodetic: from n, in the march space (the ellipsoid stretched to a
  // sphere along the axis), the ground normal there.)
  vec3 wxDir(vec3 n) {
    vec3 e = uWorldToEcef * n;
    return normalize(vec3(e.xy, e.z * ${(RE / RP).toExponential(10)}));
  }
  // (And back: the march-space direction of the ground under a geodetic direction, world axes.)
  vec3 wxDirToMarch(vec3 g) {
    return normalize(vec3(g.xy, g.z * ${(RP / RE).toExponential(10)})) * uWorldToEcef;
  }
  void weatherMap(vec3 n, out vec4 a, out vec4 b) {
    vec3 e = wxDir(n);
    vec2 uv = vec2(atan(e.y, e.x) * 0.15915494 + 0.5, asin(clamp(e.z, -1.0, 1.0)) * 0.31830989 + 0.5);
    a = mix(textureLod(tWxA0, uv, 0.0), textureLod(tWxA1, uv, 0.0), uWxBlend);
    b = mix(textureLod(tWxB0, uv, 0.0), textureLod(tWxB1, uv, 0.0), uWxBlend);
    gConvMap = a.y * 16000.0 - a.z * 4000.0 > 4500.0 ? mix(textureLod(tWxC0, uv, 0.0).r, textureLod(tWxC1, uv, 0.0).r, uWxBlend) : 0.0;
  }

  // The weather map's third image at n: deep convection, the middle layer's cover, its height
  // (2..8 km) and the cirrus's height (6..14 km).
  vec4 weatherC(vec3 n) {
    vec3 e = wxDir(n);
    vec2 uv = vec2(atan(e.y, e.x) * 0.15915494 + 0.5, asin(clamp(e.z, -1.0, 1.0)) * 0.31830989 + 0.5);
    return mix(textureLod(tWxC0, uv, 0.0), textureLod(tWxC1, uv, 0.0), uWxBlend);
  }

  // Where the ray crosses a sheet whose height varies over the planet: first at a nominal height,
  // then again at the sheet's height there (from the map's third image, channel k: alt = lo +
  // span * value). Returns the distance (or -1) and the point's map values.
  float sheetHit(vec3 ro, vec3 rd, float tEnd, float nominal, int k, float lo, float span, out vec4 c) {
    float r0 = length(ro);
    float rn = uRc + nominal;
    vec2 h = hitSphere(ro, rd, rn);
    float t = r0 > rn ? h.x : h.y;
    if (t <= 0.0 || t > tEnd) return -1.0;
    c = weatherC(normalize(ro + rd * t));
    float alt = lo + span * (k == 2 ? c.b : c.a);
    float rs = uRc + alt;
    h = hitSphere(ro, rd, rs);
    t = r0 > rs ? h.x : h.y;
    if (t <= 0.0 || t > tEnd) return -1.0;
    c = weatherC(normalize(ro + rd * t));
    return t;
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

  // --- Thunderstorm cells ---------------------------------------------------------------------
  // Cumulonimbus one by one: the map is far too coarse for them (a storm's tower is a few km
  // across, its texels ~40 km), so where it has deep convection they're placed here, on a
  // jittered grid STORM_GRID apart (over a cube's faces, in Earth-fixed axes: the same cells from
  // anywhere), each its own size, height and stage: towers from the base up toward the
  // tropopause, leaning with the wind aloft, and the mature ones' anvils spread flat at the top,
  // downwind. The lightning (weather/storms.ts) puts its strokes in the same cells.
  const float STORM_GRID = 60000.0;
  uint stormHash(int f, int i, int j, uint k) {
    uint x = uint(i) * 0x8da6b343u ^ uint(j) * 0xd8163841u ^ (k + uint(f) * 16u) * 0xcb1ab31fu;
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
  }
  float stormRand(int f, int i, int j, uint k) { return float(stormHash(f, i, j, k) >> 8u) / 16777216.0; }
  // A direction's cube face (Earth-fixed) and its place on it (m, gnomonic).
  int stormFace(vec3 e, out vec2 uv) {
    vec3 a = abs(e);
    if (a.x >= a.y && a.x >= a.z) { uv = e.yz / a.x * uRc; return e.x > 0.0 ? 0 : 1; }
    if (a.y >= a.z) { uv = e.zx / a.y * uRc; return e.y > 0.0 ? 2 : 3; }
    uv = e.xy / a.z * uRc;
    return e.z > 0.0 ? 4 : 5;
  }
  vec3 stormFaceDir(int f, vec2 uv) {
    uv /= uRc;
    vec3 e = f < 2 ? vec3(f == 0 ? 1.0 : -1.0, uv.x, uv.y) : f < 4 ? vec3(uv.y, f == 2 ? 1.0 : -1.0, uv.x) : vec3(uv.x, uv.y, f == 4 ? 1.0 : -1.0);
    return normalize(e);
  }
  // (Up to 3 cells near the last weatherFine point, in a frame there (the ground point, east,
  // north): A = centre (m east, north), tower radius, top (m); B = anvil radius (0: none yet).)
  vec4 gCellA[3];
  vec4 gCellB[3];
  int gCells = 0;
  // (And how far from that point, across the ground, the nearest cell's farthest reach is: clear
  // air the march can leap.)
  float gCellClear = 0.0;
  // (Whether the list is good for points within 2 km of gCellO; whether to look them up at all:
  // not for the shadows or the far layer.)
  bool gCellsValid = false;
  bool gWantCells = true;
  vec3 gCellO;
  vec3 gCellE;
  vec3 gCellN;
  void findStormCells(vec3 n, float base, float top, float conv) {
    if (gCellsValid && dot(n * uRc - gCellO, n * uRc - gCellO) < 4e6) return;
    gCells = 0;
    gCellClear = 0.0;
    gCellsValid = false;
    if (conv < 0.02 || top - base < 5000.0) return;
    gCellsValid = true;
    vec3 e = wxDir(n);
    vec2 g;
    int f = stormFace(e, g);
    // (The cells drift with the storms: where this is on the moved grid.)
    vec2 gs = g - uStormShift;
    // (Cells from beyond the 3 x 3 around reach no closer than this: their centres at least
    // three quarters of the grid off (less on the ground toward a face's edge), their anvils
    // under ~21 km.)
    gCellClear = max(0.75 * STORM_GRID / (1.0 + dot(g, g) / (uRc * uRc)) - 21000.0, 0.0);
    gCellO = n * uRc;
    gCellE = normalize(cross(uPolar, n));
    gCellN = cross(n, gCellE);
    ivec2 gi = ivec2(floor(gs / STORM_GRID));
    float dK[3] = float[3](1e9, 1e9, 1e9);
    for (int dj = -1; dj <= 1; dj++) {
      for (int di = -1; di <= 1; di++) {
        int i = gi.x + di;
        int j = gi.y + dj;
        float h0 = stormRand(f, i, j, 0u);
        float k = smoothstep(h0, h0 + 0.25, conv);
        if (k <= 0.0) continue;
        vec2 c = (vec2(float(i), float(j)) + 0.5 + (vec2(stormRand(f, i, j, 1u), stormRand(f, i, j, 2u)) - 0.5) * 0.5) * STORM_GRID + uStormShift;
        vec3 cw = wxDirToMarch(stormFaceDir(f, c));
        vec3 dc = cw * uRc - gCellO;
        vec2 rel = vec2(dot(dc, gCellE), dot(dc, gCellN));
        // Its stage: growing (a tower, no anvil yet, still rising) or mature (at the
        // tropopause, an anvil); its size.
        float stage = stormRand(f, i, j, 3u);
        float mature = step(0.35, stage);
        float rT = (3000.0 + 3500.0 * stormRand(f, i, j, 4u)) * (0.6 + 0.4 * k);
        float topC = base + (top - base) * (mature > 0.0 ? 0.88 + 0.12 * stormRand(f, i, j, 5u) : 0.35 + 1.4 * stage);
        float rA = mature * (7000.0 + 6000.0 * stormRand(f, i, j, 6u)) * (0.5 + 0.5 * k);
        float ext = max(rT * 1.45, rA * 1.5) + 0.1 * (topC - base);
        gCellClear = min(gCellClear, length(rel) - ext);
        float d = length(rel) - ext - 2500.0;
        if (d > 0.0) continue;
        vec4 A = vec4(rel, rT, topC);
        vec4 B = vec4(rA, 0.0, 0.0, 0.0);
        // (Nearest first: the first three.)
        for (int s = 0; s < 3; s++) {
          if (d < dK[s]) {
            float td = dK[s]; vec4 tA = gCellA[s]; vec4 tB = gCellB[s];
            dK[s] = d; gCellA[s] = A; gCellB[s] = B;
            d = td; A = tA; B = tB;
          }
        }
      }
    }
    gCells = dK[2] < 1e8 ? 3 : dK[1] < 1e8 ? 2 : dK[0] < 1e8 ? 1 : 0;
  }
  // How far inside the storm cells p is (> 0 inside: the share of its radius in), at height h
  // over the weather's base.
  float stormCellsV(vec3 p, float h, float base) {
    vec3 q = p * (uRc / length(p)) - gCellO;
    vec2 xy = vec2(dot(q, gCellE), dot(q, gCellN));
    // (Their sides bulging in and out as they rise, turret on turret, not straight walls.)
    float bulge = 1.0 + 0.6 * (textureLod(tNoise, vec3(xy / 5200.0, h / 1700.0) + vec3(0.27, 0.61, 0.13) + uDrift * 20.0, 0.0).r - 0.669);
    float v = -1.0;
    for (int i = 0; i < 3; i++) {
      if (i >= gCells) break;
      vec4 A = gCellA[i];
      float rA = gCellB[i].x;
      float hc = (h - base) / max(A.w - base, 500.0);
      if (hc <= 0.0 || hc >= 1.0) continue;
      // The tower: leaning downwind as it rises, a little wider up high; a growing one's top
      // domed, a mature one's flat under the tropopause.
      vec2 cT = A.xy + vec2(0.1 * (h - base), 0.0);
      float dome = rA > 0.0 ? 1.0 : sqrt(max(1.0 - pow(max(hc - 0.6, 0.0) / 0.4, 2.0), 0.0));
      float vt = 1.0 - length(xy - cT) / max(A.z * (0.8 + 0.35 * hc) * dome * bulge, 1.0);
      v = max(v, min(vt, (1.0 - hc) * 25.0));
      // The anvil: flaring out from the tower's top, spread downwind, thinner toward its edge
      // (only its top there), its underside flat-ish.
      if (rA > 0.0) {
        float a = smoothstep(0.72, 0.9, hc);
        vec2 cA = A.xy + vec2(0.1 * (A.w - base) + 0.45 * rA * a, 0.0);
        float dA = length(xy - cA) / max(rA * a * mix(1.0, bulge, 0.5), 1.0);
        float va = min(min(1.0 - dA, (hc - 0.8 - 0.13 * dA * dA) * 8.0), (1.0 - hc) * 25.0);
        v = max(v, va);
      }
    }
    return v;
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
  // (And how much of it is thunderstorms, from the map: see cloudDensity.)
  float gConv = 0.0;
  // (The storm cells alone, not the cumulus round them: stormFar.)
  bool gCellsOnly = false;
  vec4 weatherFine(vec3 n, vec4 a, vec4 b, float t) {
    gRelief = 0.0;
    gBroken = a.w;
    gConv = gConvMap;
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
      // (Not a thunderstorm's: its anvil spreads flat at the tropopause over all its towers.)
      top = mix(top, base + (top - base) * (0.25 + 0.75 * tw), conv * (1.0 - gConv));
    }
    // (Thunderstorms: the cells, here; the cloud between them the map's, unbroken, low.)
    cov = mix(cov, a.x, gConv);
    if (gWantCells) findStormCells(n, base, top, gConv);
    else {
      gCells = 0;
      gCellsValid = false;
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
    // (Narrowing from low down: domed tops, not flat-topped mesas, which seen in rows toward the
    // horizon line up as stripes.)
    float grad = smoothstep(0.0, 0.1, hn) * (1.0 - smoothstep(0.35, 1.0, hn));
    // (Cumulus taper from low down, domes and towers, not straight-sided columns with a lid:
    // seen from the side those were cliffs, from below curtains hanging from the base.)
    float cuK = smoothstep(0.3, 0.8, gBroken);
    grad = mix(grad, smoothstep(0.0, 0.03, hn) * (1.0 - smoothstep(0.15, 1.0, hn)), cuK);
    // Thunderstorms: towers from a flat base all the way up to the tropopause, each a column a few
    // km across, and the anvil spread flat over them at the top, flaring out from the towers.
    float cb = gConv * smoothstep(5000.0, 8000.0, w.z - w.y);
    grad = mix(grad, smoothstep(0.0, 0.012, hn) * (1.0 - smoothstep(0.95, 1.0, hn)), cb);
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
    // (Each column leans and bulges as it rises: its cross-section shifted sideways with height
    // by a smooth noise, a few hundred metres over a cloud's depth. Straight up, every side was
    // a wall.)
    if (detailed) {
      float lw = noiseLod(max(t, gDetT), 7300.0) + 1.0;
      if (lw < 3.5) {
        vec2 wv = textureLod(tNoise, p / 7300.0 + vec3(0.21, 0.63, 0.47) + uDrift * 30.0, lw).rg;
        wv = vec2((wv.x - 0.669) / 0.065, (wv.y - 0.478) / 0.115) * (1.0 - smoothstep(2.0, 3.5, lw));
        pc += vec3(wv.x, wv.y, -wv.x) * (0.1 * clamp(h - w.y, 0.0, 2500.0));
      }
    }
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
    if (!detailed || gDetBias > 0.0) soft = max(soft, gDetBias < 0.1 ? 0.05 : 0.12);
    // (Close up, a cloud thins out over its last few tens of metres, a fringe the light comes
    // through, not a cut-out edge drawn round it.)
    else soft = max(soft, 0.045 * (1.0 - smoothstep(2500.0, 7000.0, t)));
    // (Close up, the cells' surfaces roughened by finer noise, billows on billows, a cumulus's
    // cauliflower; a deck's top lumpier still, its cells.)
    float u0 = u;
    if (detailed) {
      float dl = noiseLod(max(t, gDetT), ${CLOUD_DETAIL_SCALE}.0) + gDetBias;
      // (Mostly billows of several sizes (the shape noise again, finer), a little of the even
      // Worley cells: those alone are bubbles all one size, a foam, not a cauliflower.)
      vec2 det = textureLod(tNoise, p / ${CLOUD_DETAIL_SCALE}.0 + uDrift * 40.0, dl).rg;
      // (Lumpier up the sides and over the tops, the cauliflower; the base flat and smooth.)
      float dAmp = mix(0.55, 1.3, smoothstep(0.02, 0.45, hn));
      u += dAmp * (0.12 * (det.x - 0.669) + 0.07 * (det.y - 0.478)) / 0.12 * (1.0 - smoothstep(0.5, 2.5, dl));
      // (And finer still, close up: wisps and knots a few tens of metres across.)
      float dl2 = noiseLod(max(t, gDetT), 610.0) + gDetBias;
      // (The light sample next to it sees them too: each knot shades the next, the
      // cauliflower's light and shade, not a smooth plaster surface.)
      if (dl2 < 3.5) {
        float det2 = textureLod(tNoise, pr0 / 610.0 + vec3(0.37, 0.11, 0.83) + uDrift * 60.0, dl2).g;
        u += 0.075 * dAmp * (det2 - 0.478) / 0.12 * (1.0 - smoothstep(1.5, 3.5, dl2));
        // (And the finest, from a few hundred metres: knots and curls ~10-40 m, a real cloud's
        // texture rather than an airbrushed surface.)
        float dl3 = noiseLod(max(t, gDetT), 170.0) + gDetBias;
        if (dl3 < 2.3) {
          float det3 = textureLod(tNoise, pr0.zxy / 170.0 + vec3(0.59, 0.23, 0.41) + uDrift * 90.0, dl3).r;
          u += 0.04 * dAmp * (det3 - 0.669) / 0.065 * (1.0 - smoothstep(1.3, 2.3, dl3));
        }
      }
    }
    // (The detail roughens a cloud's surface, eating into it as far as it likes, but builds out
    // from it only a little: unbounded, it made new little clouds of its own all over the clear
    // sky, grainy grey specks and balls.)
    u = min(u, u0 + 0.07);
    // (Broken cumulus a little less than the cover: seen at a slant, their sides fill the gaps.)
    float fill = mix(1.0, 0.8, smoothstep(0.3, 0.8, gBroken));
    // (And in clumps and thinner stretches ~25 km across, as a cumulus field is, not one even
    // lattice of cells.)
    float cumulus = smoothstep(0.3, 0.8, gBroken);
    if (cumulus > 0.0 && detailed && gDetBias == 0.0) {
      float clump = textureLod(tNoise, pc / 26000.0 + vec3(0.13, 0.71, 0.29), noiseLod(t, 26000.0)).r;
      fill *= mix(1.0, clamp(1.0 + 5.0 * (clump - 0.669), 0.3, 1.5), cumulus);
    }
    gMargin = u - (1.0 - fill * base);
    if (cb > 0.0) {
      // Thunderstorms: the cells (towers and anvils), and towering cumulus between them, the
      // map's cloud capped at a few km. (The cells' outlines roughened as a cumulus's are: by
      // the same detail, and the cells' noise.)
      float hnCu = (h - w.y) / 2800.0;
      float gCu = smoothstep(0.0, 0.03, hnCu) * (1.0 - smoothstep(0.15, 1.0, hnCu));
      float mCu = gCellsOnly ? -1.0 : u - (1.0 - 0.25 * w.x * gCu);
      float vC = gCells > 0 ? stormCellsV(p, h, w.y) : -1.0;
      // (The cell as the cover the cumulus's own shapes fill: solid inside, ragged toward its
      // edge, the same billows and knots as any cumulus, not a smooth cylinder.)
      float mCell = u - (1.0 - 1.1 * smoothstep(-0.4, 0.3, vC));
      gMargin = mix(gMargin, max(mCu, mCell), cb);
    }
    // (A cloud as dense inside in light cover as in heavy: the cover is how many there are, not
    // how thin. (Thinned, small cumulus were half see-through, soft-edged puffs.))
    float dens = smoothstep(0.0, 1.0, gMargin / max(soft, 0.012)) * (0.75 + 0.25 * w.x);
    // (Thinner toward its edges, densest in its cores, as a cloud's water is: light gets in at
    // the edges (bright rims), and from below each core shows as a darker patch, the base
    // mottled, not one flat grey.)
    dens *= mix(0.4, 1.0, smoothstep(0.0, 0.3, gMargin));
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
    if (earthShadow(p, uRc)) return vec3(0.0);
    float rp = length(p);
    vec2 l = sunDepth(rp - uRc, dot(p, uSun) / rp);
    return exp(-((BR + BO) * l.x + BM * 1.1 * l.y));
  }

  // Thin cirrus where the ray crosses its height there (8.5 to 13 km: higher in the tropics):
  // (light, opacity) and its distance.
  vec4 cirrus(vec3 ro, vec3 rd, float tEnd, float mu, out float tc) {
    vec4 cw;
    tc = sheetHit(ro, rd, tEnd, ${CIRRUS_ALT}.0, 3, 6000.0, 8000.0, cw);
    if (tc <= 0.0) return vec4(0.0);
    vec3 p = ro + rd * tc;
    vec3 n = normalize(p);
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

  // The middle layer's patches (tens of km), more of the sky as its cover grows: 0..1 at p.
  float midPatchy(vec3 p, float cov, float t) {
    float big = textureLod(tNoise, p / 45000.0 + uDrift * 1.5, noiseLod(t, 45000.0)).g;
    return smoothstep(0.62 - 0.3 * cov, 0.72 - 0.25 * cov, big + 0.2 * cov);
  }

  // The middle layer's depth, m: a thin altocumulus a couple of hundred metres, a dense
  // altostratus most of a kilometre.
  float midDepth(float cov) { return mix(150.0, 900.0, smoothstep(0.3, 0.9, cov)); }

  // How much sunlight gets down through the middle layer to p, 0..1 (1 above it or where
  // there's none). t: p's distance from the camera.
  float midShade(vec3 p, float t) {
    float rp = length(p);
    vec3 n = p / rp;
    float mus = dot(n, uSun);
    if (mus < 0.02) return 1.0;
    vec4 c = weatherC(n);
    float alt = 2000.0 + 6000.0 * c.b;
    float h = rp - uRc;
    if (c.g < 0.02 || h > alt) return 1.0;
    vec3 q = p + uSun * ((alt - h) / mus);
    c = weatherC(normalize(q));
    float cov = c.g;
    if (cov < 0.02) return 1.0;
    float sheet = smoothstep(0.5, 0.9, cov);
    float a = midPatchy(q, cov, max(t, 8000.0)) * mix(0.35, 0.8, sheet);
    // (Light diffuses down through it: under a grey altostratus a soft, sourceless light.)
    return 1.0 - 0.85 * a;
  }

  // The middle layer (altocumulus, altostratus) where the ray crosses its height there (2.5 to
  // 6 km): thin, it's rows of small rounded cells; dense, a smooth grey sheet. (light, opacity)
  // and its distance. From inside it (flying up or down through it), a fog as deep as the
  // layer is along the ray.
  vec4 midDeck(vec3 ro, vec3 rd, float tEnd, float mu, out float tm) {
    float r0 = length(ro);
    vec3 n0 = ro / r0;
    vec4 c0 = weatherC(n0);
    float h0 = r0 - uRc;
    float alt0 = 2000.0 + 6000.0 * c0.b;
    float half0 = 0.5 * midDepth(c0.g);
    if (c0.g > 0.02 && abs(h0 - alt0) < half0) {
      // Inside: the way out of the layer along the ray (up or down; level, many km of it).
      float up = dot(rd, n0);
      float len = up > 0.002 ? (alt0 + half0 - h0) / up : up < -0.002 ? (h0 - alt0 + half0) / -up : 1e9;
      len = min(len, min(tEnd, 30000.0));
      float cov = c0.g;
      float sheet = smoothstep(0.5, 0.9, cov);
      // (Drifting through it: thicker and thinner wisps, the cells' size.)
      vec3 q = vec3(ro.x / 1600.0, ro.y / 1100.0, ro.z / 1300.0) + uDrift * 6.0;
      float wisp = textureLod(tNoise, q + rd * min(len, 800.0) / 1300.0, 0.0).g;
      float dens = midPatchy(ro, cov, 0.0) * mix(0.5 + 0.9 * wisp, 1.0, sheet);
      // Visibility: a few hundred metres in a thin layer, ~100 m in a dense one.
      float vis = mix(450.0, 110.0, sheet);
      float a = 1.0 - exp(-dens * len / vis);
      if (a < 0.005) { tm = -1.0; return vec4(0.0); }
      float day = smoothstep(-0.15, 0.1, dot(n0, uSun));
      // (Lit from above: brighter near its top, greyer near its base.)
      float depthIn = clamp((alt0 + half0 - h0) / (2.0 * half0), 0.0, 1.0);
      vec3 col = uCloudSun * (sunAt(ro) * (0.45 + 0.5 * cloudPhase(mu, 0.3)) * mix(1.0, mix(0.6, 0.35, sheet), depthIn) + vec3(0.2, 0.26, 0.36) * 0.8 * day);
      tm = 0.5 * min(len, 2.0 * vis);
      return vec4(col * a, a);
    }
    vec4 cw;
    tm = sheetHit(ro, rd, tEnd, 4000.0, 2, 2000.0, 6000.0, cw);
    if (tm <= 0.0 || cw.g < 0.02) return vec4(0.0);
    vec3 p = ro + rd * tm;
    vec3 n = normalize(p);
    float cov = cw.g;
    float cosv = max(abs(dot(rd, n)), 0.08);
    // How much of the layer a pixel spans along it (seen obliquely, far more than across).
    // Seen low over the horizon (from near its height, or from far off) a pixel spans km of it:
    // its cells and then its patches are drawn as their average there, not sampled (sampled,
    // they broke up into a row of blocks and specks along the horizon).
    float tEff = tm / max(abs(dot(rd, n)), 0.004);
    float foot = tEff * uPixAng;
    float patchy = midPatchy(p, cov, tEff);
    patchy = mix(patchy, smoothstep(0.05, 0.85, cov), smoothstep(6000.0, 25000.0, foot));
    // Altocumulus cells (~1 km), along the wind.
    vec3 q = vec3(p.x / 1600.0, p.y / 1100.0, p.z / 1300.0) + uDrift * 6.0;
    float cells = textureLod(tNoise, q, noiseLod(tEff, 1100.0)).g;
    float ac = smoothstep(0.47, 0.6, cells + 0.08 * cov);
    float sheet = smoothstep(0.5, 0.9, cov);
    float a = patchy * mix(0.7 * ac, 0.82, sheet);
    // From far off: the average, as a sheet of the same opacity.
    float farC = smoothstep(300.0, 1200.0, foot);
    if (farC > 0.0) a = mix(a, patchy * mix(0.3, 0.8, sheet), farC);
    // (Seen edge-on, a thin sheet still hides what's beyond it.)
    a = 1.0 - pow(1.0 - clamp(a, 0.0, 0.97), 0.6 + 0.4 / cosv);
    if (a < 0.005) return vec4(0.0);
    float day = smoothstep(-0.15, 0.1, dot(n, uSun));
    // (Seen from below, its sunlit side is above: greyer.)
    float below = r0 < uRc + 2000.0 + 6000.0 * cw.b ? mix(0.75, 0.4, sheet) : 1.0;
    vec3 col = uCloudSun * (sunAt(p) * (0.55 + 1.1 * cloudPhase(mu, 0.55)) * below + vec3(0.2, 0.26, 0.36) * 0.8 * day);
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
    gWantCells = false;
    vec4 w = weatherFine(n, a, b, t / cosv);
    gWantCells = true;
    if (w.x < 0.005) return vec4(0.0, 0.0, 0.0, 1.0);
    // The share of the pixel covered, each cloud as opaque as its depth through it (longer seen
    // obliquely; seen edge-on, clouds hide the gaps between them).
    float cov = 1.0 - pow(1.0 - clamp(w.x / 0.85, 0.0, 1.0), 0.6 + 0.4 * cosv);
    float od = SIGMA * 0.45 * (w.z - w.y) * 0.7 / cosv;
    // (Broken cumulus from far off: small clouds with sea between them even inside the share
    // "covered", and thin: a film over the sea, as from orbit, not a white sheet.)
    float alpha = cov * (1.0 - exp(-od)) * (1.0 - (r0 > uRc + mid ? 0.45 : 0.0) * smoothstep(0.6, 0.95, a.w) * (1.0 - thickW(w)));
    vec3 p = ro + rd * t;
    vec3 sunCol = sunAt(p + n * (w.z - mid)) * midShade(p + n * (w.z - mid), t);
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
    // Two samples up through the clouds' heights along the sun's ray (from where it enters them).
    float h0 = max(h, base);
    float dh = (top - h0) / 2.0;
    float od = 0.0;
    // (Soft-edged: a cloud a kilometre or two up casts a shadow with a wide penumbra.)
    gDetT = 400.0 / uPixAng;
    for (int i = 0; i < 2; i++) {
      float hs = h0 + (float(i) + 0.5) * dh;
      vec3 q = P + uSun * ((hs - h) / mus);
      vec3 up = normalize(q);
      vec4 qa;
      vec4 qb;
      weatherMap(up, qa, qb);
      gWantCells = false;
      vec4 w = weatherFine(up, qa, qb, t);
      gWantCells = true;
      od += cloudDensity(q, w, false, t) * dh / mus;
    }
    // (Some light still gets through even a thick cloud's shadow: scattered down through it.)
    return max(exp(-SIGMA * 2.5 * od), 0.2 * exp(-SIGMA * 0.3 * od)) * midShade(P, t);
  }

  // In a thunderstorm's weather, above the cumulus between the cells: how far the march can leap
  // and stay clear of every cell (0: not here).
  float stormSkip(vec3 p, vec4 w) {
    if (gConv < 0.3 || w.z - w.y < 6000.0 || length(p) - uRc < w.y + 4000.0) return 0.0;
    vec3 q = p * (uRc / length(p)) - gCellO;
    return max(gCellClear - length(q) - 400.0, 0.0);
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
    if (dot(p - pw, p - pw) < 1e6) {
      float d = w.x < 0.02 ? 0.0 : cloudDensity(p, w, true, t);
      if (d <= 0.0) skip = stormSkip(p, w);
      return d;
    }
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
    float d = cloudDensity(p, w, true, t);
    if (d <= 0.0) skip = stormSkip(p, w);
    return d;
  }

  // The march's step through clear air at distance t along a ray (mu: its slope, up = 1):
  // growing with distance (4.5% of it: the clouds are smaller on screen), but never so long it
  // could step over a cloud: 300 m across the ground (more far off, where they're smaller on
  // screen), 150 m in height (up to 400 m far off: never more, or from orbit a step would cross
  // the whole layer, catching it in some pixels and not others: a halftone of dots).
  float clearStep(float t, float mu) {
    float far = max(1.0, t / 20000.0);
    float lim = min(min(150.0 * far, 400.0) / max(abs(mu), 0.01), 300.0 * far / max(sqrt(max(1.0 - mu * mu, 0.0)), 0.01));
    return clamp(0.045 * t, 50.0, lim);
  }

  // Rain falling from the clouds, seen from a way off: grey curtains from a raining cloud's base
  // down to the ground, in patches a few km across. (Near the camera the rain is the mist,
  // fogDepth, and the streaks.) Returns (light, transmittance); tR: its distance.
  vec4 rainShafts(vec3 ro, vec3 rd, float tEnd, float jit, out float tR) {
    tR = 1e30;
    vec4 none = vec4(0.0, 0.0, 0.0, 1.0);
    if (uRainAny < 0.5) return none;
    float tA;
    float tB;
    if (!slab(ro, rd, uRc - 500.0, uRc + 4000.0, min(tEnd, 80000.0), tA, tB)) return none;
    tA = max(tA, 1500.0);
    if (tB <= tA) return none;
    float len = tB - tA;
    float T = 1.0;
    vec3 C = vec3(0.0);
    float tw = 0.0;
    float sw = 0.0;
    for (int i = 0; i < 16; i++) {
      // (Spaced quadratically: closer together near, where a curtain spans more of the view.)
      float a0 = (float(i) + jit) / 16.0;
      float a1 = (float(i) + 1.0) / 16.0;
      float t = tA + len * a0 * a0;
      float dt = len * (a1 * a1 - (float(i) / 16.0) * (float(i) / 16.0));
      vec3 p = ro + rd * t;
      vec3 n = normalize(p);
      vec4 wa;
      vec4 wb;
      weatherMap(n, wa, wb);
      float pr = smoothstep(0.12, 0.6, wb.y);
      if (pr <= 0.0) continue;
      float h = length(p) - uRc;
      float base = wa.z * 4000.0;
      if (h > base + 50.0) continue;
      // (Falling in shafts under the cells raining hardest, leaning a little with the wind.)
      vec3 q = (p - n * (h * 0.85)) / 9000.0 + vec3(0.5, 0.2, 0.8) + uDrift * 20.0;
      // (Showers in broken weather, apart; a steady rain from a deck, nearly everywhere.)
      float thr = mix(0.58, 0.7, smoothstep(0.4, 0.8, wa.w));
      float shaft = smoothstep(thr, thr + 0.06, textureLod(tNoise, q, 1.0).r);
      // (Thunderstorms: under their towers, a downpour; none between them.)
      if (gConvMap > 0.05) {
        vec4 wf = weatherFine(n, wa, wb, t);
        float v = gCells > 0 ? stormCellsV(n * (uRc + wf.y + 200.0), wf.y + 200.0, wf.y) : -1.0;
        shaft = mix(shaft, smoothstep(-0.25, 0.3, v + 0.25 * (textureLod(tNoise, q * 3.0, 1.0).r - 0.669) / 0.065), gConvMap);
        pr = mix(pr, 1.0, gConvMap);
      }
      float dens = pr * shaft * (1.0 - smoothstep(base - 150.0, base + 50.0, h)) * smoothstep(1500.0, 5000.0, t);
      if (dens <= 0.0) continue;
      float a = 1.0 - exp(-8e-4 * dens * dt);
      // (Lit by the dim grey light under the cloud: darker than the sky behind.)
      vec3 S = uCloudSun * vec3(0.30, 0.32, 0.36) * 0.35 * smoothstep(-0.15, 0.1, dot(n, uSun));
      C += T * a * S;
      tw += t * T * a;
      sw += T * a;
      T *= 1.0 - a;
    }
    if (sw > 0.0) tR = tw / sw;
    return vec4(C, T);
  }

  // Thunderstorms beyond the march (it runs out of steps tens of km out, threading through the
  // cumulus near), out to the end of the clouds' slab: their towers and anvils standing up over the
  // horizon. The cells alone, marched on their own: long steps through the clear air between
  // them, shorter through them, lit simply. Returns (light, transmittance); tHit: its distance.
  vec4 stormFar(vec3 ro, vec3 rd, float t0, float t1, float jit, float mu, out float tHit) {
    tHit = 1e30;
    float T = 1.0;
    vec3 C = vec3(0.0);
    float tw = 0.0;
    float sw = 0.0;
    vec3 pw = vec3(1e30);
    vec4 w = vec4(0.0);
    float phase = 0.55 + 1.6 * mix(cloudPhase(mu, 0.55), cloudPhase(mu, -0.25), 0.3);
    float t = t0 + jit * 600.0;
    for (int i = 0; i < 64; i++) {
      if (t > t1 || T < 0.04) break;
      vec3 p = ro + rd * t;
      float rp = length(p);
      float h = rp - uRc;
      float dt = max(500.0, 0.012 * t);
      // (The weather, and the cells near, every 3 km along the ray.)
      if (dot(p - pw, p - pw) > 9e6) {
        pw = p;
        vec3 up = p / rp;
        vec4 wa;
        vec4 wb;
        weatherMap(up, wa, wb);
        if (gConvMap < 0.05) {
          gCells = 0;
          gCellsValid = false;
          gCellClear = 3000.0;
          gCellO = up * uRc;
        } else w = weatherFine(up, wa, wb, t);
      }
      vec3 q = p * (uRc / rp) - gCellO;
      float clear = gCellClear - length(q) - 300.0;
      if (gCells == 0 || h > w.z + 50.0) {
        t += max(dt, clear);
        continue;
      }
      float v = stormCellsV(p, h, w.y);
      float dens = 0.0;
      if (v > -0.45) {
        // (Shaped as the march shapes them, the cumulus's own billows, at the detail a step this
        // long shows.)
        gCellsOnly = true;
        gDetT = dt / uPixAng;
        dens = cloudDensity(p, w, true, t);
        gCellsOnly = false;
      }
      if (dens > 0.002) {
        float a = 1.0 - exp(-SIGMA * 2.5 * dens * dt);
        // Lit: through the cell toward the sun (how far in that is), its lower part in the shade
        // of all that's above, and the sky's light.
        vec3 ps = p + uSun * 1800.0;
        vec3 ps2 = p + uSun * 4500.0;
        float vs = max(stormCellsV(ps, length(ps) - uRc, w.y), stormCellsV(ps2, length(ps2) - uRc, w.y));
        float hc = clamp((h - w.y) / max(w.z - w.y, 500.0), 0.0, 1.0);
        float lit = exp(-3.0 * clamp(vs + 0.25, 0.0, 1.2)) * (0.5 + 0.5 * smoothstep(0.0, 0.7, hc)) + 0.12;
        float sunUp = dot(p, uSun) / rp;
        float day = smoothstep(-0.15, 0.1, sunUp);
        vec3 sky = vec3(0.22, 0.28, 0.38) * day * (0.45 + 0.55 * hc) * (1.0 + 1.5 * (1.0 - smoothstep(0.05, 0.3, sunUp)));
        vec3 S = uCloudSun * (sunAt(p) * phase * lit + sky);
        if (uFlash.w > 0.0) S += vec3(0.75, 0.8, 1.0) * uFlash.w * 1.2 * exp(-length(p - uFlash.xyz) / 5000.0);
        C += T * a * S;
        tw += t * T * a;
        sw += T * a;
        T *= 1.0 - a;
        t += dt;
      } else t += v > -0.45 ? dt : max(dt, min(clear, -v * 2000.0));
    }
    if (sw > 0.0) tHit = tw / sw;
    return vec4(C, T);
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
      float convAny = gConvMap;
      weatherMap(normalize(ro + rd * tB0), aB, bB);
      convAny = max(convAny, gConvMap);
      weatherMap(normalize(ro + rd * (0.5 * (tA0 + tB0))), aM, bM);
      convAny = max(convAny, gConvMap);
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
        float midSh = -1.0;
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
          // (Through cloud: a quarter of the clear step, never under 30 m, nor under half a
          // pixel's breadth there: from orbit, finer steps only cost.)
          // (Down to 10 m within a km or two: the finest detail there is a few metres across.)
          float dIn = max(max(0.25 * clearStep(t, muv), mix(10.0, 30.0, smoothstep(500.0, 2500.0, t))), 0.5 * t * uPixAng);
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
            // (The middle layer's shade: it varies over tens of km, so once per ray.)
            if (midSh < 0.0) midSh = midShade(p, t);
            vec3 sunCol = sunAt(p) * midSh;
            float odSun = 0.0;
            if (sunCol.r + sunCol.g > 0.0) {
              // Through the cloud toward the sun (two samples: one close, with the fine detail,
              // so each billow shades the next, the cauliflower; one farther, of the cloud seen
              // softer-edged), with a floor for the light scattered around inside it.
              // (Close up, first a sample just off the surface, with the finest detail: each knot
              // of the cauliflower lit on its sunward side and shading the next, crisply.)
              // (These at about the detail a pixel shows (a mip coarser: any finer, and from tens
              // of km it shimmered in a stipple), not the march step's, several times coarser
              // from a few km: there a cloud's sides went flat, one even tone, a cut-out.)
              float gdMarch = gDetT;
              gDetT = min(2.0 * t, gdMarch);
              float od = 0.0;
              float o1 = max(30.0, 3.0 * t * uPixAng);
              float o2 = max(110.0, 3.5 * o1);
              if (t < 15000.0) {
                gDetBias = 0.01;
                od += cloudDensity(p + uSun * o1, w, true, t) * 2.3 * o1;
              }
              gDetBias = 0.5;
              od += cloudDensity(p + uSun * o2, w, true, t) * (t < 15000.0 ? 1.1 : 1.4) * o2;
              gDetBias = 0.0;
              gDetT = gdMarch;
              float d400 = cloudDensity(p + uSun * 400.0, w, false, t);
              od += d400 * 500.0;
              // (And the cloud's bulk beyond, coarsely: a base or a deep interior lies under a
              // kilometre or more of it, grey, not lit through 460 m as if that were all.)
              // (Not where the ray toward the sun is out of the cloud by 400 m: near its sunlit
              // surface, most of the samples.)
              if (d400 > 0.05) od += cloudDensity(p + uSun * 1150.0, w, false, t) * 900.0;
              // (A thunderstorm's tower is km of cloud toward the sun from most of it: its base and
              // shaded side dark, as a cumulonimbus's are. The cells, from here on out.)
              if (gCells > 0 && gConv > 0.2) {
                vec3 p2 = p + uSun * 2600.0;
                vec3 p3 = p + uSun * 5500.0;
                od += (smoothstep(-0.1, 0.2, stormCellsV(p2, length(p2) - uRc, w.y)) * 2000.0
                     + smoothstep(-0.1, 0.2, stormCellsV(p3, length(p3) - uRc, w.y)) * 3500.0) * gConv;
              }
              odSun = od;
              // (Light scattered on through the cloud: the shadowed side greys gradually, not
              // black. Scattered many times, it has lost its direction: only the light straight
              // through gets the strong forward lobe, so a thick cloud toward the sun is grey with
              // a bright rim, not glowing white all through.)
              // (Deep in, light diffuses through rather than dying off as a beam does: a slab
              // passes on ~1 / (1 + 0.75 tau (1 - g)) of it, so the base of a deep overcast is a
              // mid grey, the sky's light under it, not near black.)
              float tau = SIGMA * od;
              float phaseMs = mix(phase, 0.8, 0.6);
              // (With the sun low, the way out toward it runs sideways through the whole layer,
              // far beyond these samples: deep in, little of its light diffuses through. Else at
              // sunset every cloud was the sun's orange all through, a muddy brown.)
              float lowSun = 1.0 - smoothstep(0.05, 0.4, dot(p, uSun) / rp);
              float tauD = tau * (1.0 + 3.0 * lowSun * smoothstep(5.0, 15.0, tau));
              float diffuse = max(1.0 / (1.0 + 0.11 * tauD) - exp(-tauD), 0.0);
              // (As much as a slab's in a deck; less in a cumulus, out of whose sides the light
              // escapes: its shaded side stays shaded.)
              float kDiff = mix(0.8, 0.3, smoothstep(0.3, 0.8, gBroken));
              sunCol *= (exp(-tau) * phase + 0.12 * exp(-0.25 * tau) * phaseMs + kDiff * diffuse * 0.8) / phase;
            }
            float hn = clamp((rp - uRc - w.y) / max(w.z - w.y, 100.0), 0.0, 1.0);
            float sunUp = dot(p, uSun) / rp;
            float day = smoothstep(-0.15, 0.1, sunUp);
            // Ambient light: the blue sky's from above (less of it down in the cloud, where the
            // light toward the sun is cut off too), and the sunlit ground and sea's, grey, from
            // below (lighting the flat bases).
            // (A cloud's base sees the sky round it too, not only the ground: at sunset, with the
            // ground dark, that sky is most of its light, a blue-grey under the gold-lit edges.)
            vec3 sky = mix(vec3(0.2, 0.21, 0.23) * (0.3 + 0.7 * max(sunUp, 0.0)), vec3(0.22, 0.3, 0.42), 0.25 + 0.75 * hn)
                     * day * (0.45 + 0.55 * exp(-SIGMA * 0.15 * odSun)) * 0.65
                     // (Round sunset the sky's light is a bigger share of what lights a cloud's
                     // shaded side than at noon: its bright western half.)
                     * (1.0 + 1.5 * (1.0 - smoothstep(0.05, 0.3, sunUp)));
            float powder = 1.0 - exp(-dens * 5.0);
            vec3 S = uCloudSun * (sunCol * phase * (0.55 + 0.45 * powder) + sky);
            // (Lightning: the cloud lit from inside round the stroke, the light diffusing out
            // through it a few km.)
            if (uFlash.w > 0.0) {
              float fd = length(p - uFlash.xyz);
              S += vec3(0.75, 0.8, 1.0) * uFlash.w * (2.2 * exp(-fd / 1800.0) + 0.35 * exp(-fd / 6000.0));
            }
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
          // (Two bands: within ~150 m of a surface, a quarter step; within ~300 m, half: a cloud's
          // thin edge seen at a slant was caught by every other pixel along a long step, in
          // diagonal hatching.)
          t += inCloud || gMargin > -0.12 ? dIn : gMargin > -0.25 ? 2.0 * dIn : max(clearStep(t, muv), skip);
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
        // (Thunderstorms there: marched on their own, the cells; the layer only where there
        // are none, not a flat slab for their towers and anvils.)
        if (convAny > 0.05) {
          float tS2;
          vec4 st = stormFar(ro, rd, tMarch, tB, jit, mu, tS2);
          if (st.a < 0.999) {
            low = vec4(low.rgb + low.a * st.rgb, low.a * st.a);
            if (tLow > 1e29) tLow = tS2;
          }
        }
        float tL;
        vec4 lay = cloudLayer(ro, rd, tEnd, mu, tL);
        float k = smoothstep(0.85, 1.15, tL / tMarch) * smoothstep(15000.0, 30000.0, tMarch) * (1.0 - gConvMap);
        if (k > 0.0 && lay.a < 0.999) {
          lay = mix(vec4(0.0, 0.0, 0.0, 1.0), lay, k);
          low = vec4(low.rgb + low.a * lay.rgb, low.a * lay.a);
          if (tLow > 1e29) tLow = tL;
        }
      }
    }
    // The rain under them: in front of the clouds it falls from (seen from below), or behind.
    float tR;
    vec4 rn = rainShafts(ro, rd, tEnd, jit, tR);
    if (rn.a < 0.999) {
      if (tR < tLow) low = vec4(rn.rgb + rn.a * low.rgb, rn.a * low.a);
      else low = vec4(low.rgb + low.a * rn.rgb, low.a * rn.a);
      tLow = min(tLow, tR);
    }
    // The low clouds, the middle layer and the cirrus, nearest first along the ray (each as
    // light added and light let through).
    float tm;
    vec4 md = midDeck(ro, rd, tEnd, mu, tm);
    vec4 L0 = low;
    vec4 L1 = vec4(md.rgb, 1.0 - md.a);
    vec4 L2 = vec4(ci.rgb, 1.0 - ci.a);
    float d0 = tLow;
    float d1 = md.a > 0.0 ? tm : 1e31;
    float d2 = ci.a > 0.0 ? tc : 1e31;
    // (Three: sort by swapping.)
    vec4 tmpL;
    float tmpD;
    if (d1 < d0) { tmpL = L0; L0 = L1; L1 = tmpL; tmpD = d0; d0 = d1; d1 = tmpD; }
    if (d2 < d1) { tmpL = L1; L1 = L2; L2 = tmpL; tmpD = d1; d1 = d2; d2 = tmpD; }
    if (d1 < d0) { tmpL = L0; L0 = L1; L1 = tmpL; tmpD = d0; d0 = d1; d1 = tmpD; }
    vec4 outc = vec4(L0.rgb + L0.a * (L1.rgb + L1.a * L2.rgb), L0.a * L1.a * L2.a);
    // (The clouds' distance: the low clouds or the middle layer, whichever's nearer; the cirrus
    // only where there's neither.)
    tFirst = min(tLow < 1e29 ? tLow : 1e30, md.a > 0.02 ? tm : 1e30);
    if (tFirst > 1e29 && ci.a > 0.02) tFirst = tc;
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
  uniform sampler2D tWxC0;     // and deep convection (thunderstorms)
  uniform sampler2D tWxC1;
  uniform float uWxBlend;      // between the two bakes
  uniform mat3 uWorldToEcef;   // world -> Earth-fixed directions (the map's axes)
  uniform vec3 uDrift;         // the fine detail's slow drift (noise-space offset)
  uniform vec2 uStormShift;    // the storm cells' drift on the cube faces, m (weather/storms.ts stormShift)
  uniform float uCloudSun;     // brightness of sunlit cloud
  uniform float uRainAny;      // rain anywhere within ~150 km (else no rain curtains to look for)
  uniform vec4 uFlash;         // lightning in the clouds: where (from the Earth's centre, the march's space), how bright
  uniform float uFog;          // ground fog where the camera is, 0..1
  uniform float uRainMist;     // and rain, 0..1
  uniform float uPixAng;       // angle one cloud-pass pixel spans, rad
  uniform float uRc;           // the clouds' ground radius: the equator's (see cloudFragment)
  uniform vec3 uPolar;         // the Earth's axis (world)
  uniform vec2 uProjOff;       // projection off-centre terms (elements 8, 9)

  const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6); // Rayleigh scattering at sea level, 1/m
  // Ozone's absorption, per metre of the air's (Rayleigh) depth: its layer is high up, so it
  // barely tints the noon sun, but the long low paths at sunset lose their green and red to it:
  // the twilight sky blue overhead, not a yellow-grey. (Its column against the air's, roughly.)
  const vec3 BO = vec3(1.24e-6, 3.57e-6, 0.16e-6);
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

  // Whether p (from the Earth's centre) is in the Earth's shadow: the way to the sun runs into
  // the ground (radius r). (Not when the line misses the Earth altogether: with the sun low, from
  // high up it does, and that's sunlight. Counted as shadow, the sky went dark with the sun
  // still a few degrees up, and every cloud with it.)
  bool earthShadow(vec3 p, float r) {
    vec2 t = hitSphere(p, uSun, r);
    return t.x > 0.0 && t.x < 1e29;
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
  uniform float uHazeMin;        // the fewest steps the haze takes along a ray (the shortest)
  uniform sampler2D tNear;       // the near solids (vehicles, the pad, buildings): premultiplied, alpha = coverage
  uniform sampler2D tNearDepth;
  uniform vec2 uScreen;          // the screen's size, pixels
  varying vec2 vUv;
  ${ATMO_COMMON}


  // The air along a ray, added up step by step (see main): the light it scatters toward the
  // camera (Rayleigh, Mie), its optical depth, and the same up to the near solid; and what gets
  // through to the clouds, once a step reaches them.
  struct HazeSums {
    vec3 sumR;
    vec3 sumM;
    vec3 sumRN;
    vec3 sumMN;
    float odR;
    float odM;
    float odRN;
    float odMN;
    vec3 transToCloud;
    bool pastCloud;
  };

  // One step, from a0 to a1 of the way (spaced quadratically: dense near the camera, where the
  // air is thickest along near-horizontal rays that run for 1000+ km). tCloud: the clouds'
  // distance; nearDist: the near solid's; clT: what the clouds let through.
  void hazeStep(float a0, float a1, vec3 ro, vec3 rd, float t0, float len, float tCloud, float nearDist, float clT, inout HazeSums z) {
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
    if (!z.pastCloud && front < 1.0) {
      z.pastCloud = true;
      z.transToCloud = exp(-(BR * (z.odR + hr * front) + BM * 1.1 * (z.odM + hm * front)));
    }
    z.odR += hr;
    z.odM += hm;
    // (The share of this step in front of the near solid.)
    float fN = clamp((nearDist - s0) / max(seg, 1.0), 0.0, 1.0);
    z.odRN += hr * fN;
    z.odMN += hm * fN;
    // In the Earth's shadow: no sunlight to scatter, only the sky's own light scattered again
    // (multiple scattering, roughly): the air over it, above the shadow's edge, still sunlit, and
    // the bright sky toward the sun light it from above and the side. At twilight that is what
    // lights the sky overhead, its deep blue (the sunlight there has crossed the ozone the long
    // way), not black.
    if (earthShadow(p, uRg)) {
      float rq = length(p);
      float mq = dot(p, uSun) / rq;
      // (How high the shadow's edge is over p: the sun's ray through it just grazes the ground.)
      float rs = uRg / sqrt(max(1.0 - mq * mq, 1e-4));
      float top = rs - uRg + 2000.0;
      vec2 lt = sunDepth(min(top, 99000.0), mq);
      vec3 ms = exp(-((BR + BO) * (z.odR + lt.x) + BM * 1.1 * (z.odM + lt.y))) * exp(-max(rs - rq, 0.0) / 9000.0)
              * (1.0 - smoothstep(40000.0, 90000.0, top)) * 0.35;
      float behindS = mix(clT, 1.0, front);
      z.sumR += ms * hr * behindS;
      z.sumRN += ms * hr * behindS * fN;
      return;
    }
    float rp = length(p);
    vec2 l = sunDepth(rp - uRg, dot(p, uSun) / rp);
    // (Under an overcast, the air in front of the clouds is in their shade as the ground is: lit
    // by what gets through. Sunlit haze there washed the ground out pale under a dark sky.)
    vec3 att = exp(-((BR + BO) * (z.odR + l.x) + BM * 1.1 * (z.odM + l.y))) * mix(1.0, uLocalSun, front);
    // Air behind the clouds only shows through what they let through.
    float behind = mix(clT, 1.0, front);
    z.sumR += att * hr * behind;
    z.sumM += att * hm * behind;
    z.sumRN += att * hr * behind * fN;
    z.sumMN += att * hm * behind * fN;
  }

  void main() {
    vec4 col = texture2D(tColor, vUv);
    vec3 ro;
    vec3 rd;
    float sceneDist;
    float mu0;
    viewRay(vUv, ro, rd, sceneDist, mu0);
    bool sky = sceneDist >= 1e30;
    // The near solids here, and how far. (Their depth is one sample of the four: at an edge it
    // can miss the solid the colour has a share of; then the nearest of the neighbours'.)
    vec4 near = texture2D(tNear, vUv);
    float nearD = 0.0;
    float nearDist = 1e30;
    if (near.a > 0.002) {
      nearD = texture2D(tNearDepth, vUv).x;
      if (nearD <= 0.0) {
        vec2 e = 1.0 / uScreen;
        nearD = max(max(texture2D(tNearDepth, vUv + vec2(e.x, 0.0)).x, texture2D(tNearDepth, vUv - vec2(e.x, 0.0)).x),
                    max(texture2D(tNearDepth, vUv + vec2(0.0, e.y)).x, texture2D(tNearDepth, vUv - vec2(0.0, e.y)).x));
      }
      vec3 vd = normalize(vec3((vUv * 2.0 - 1.0 + uProjOff) * uTanHalf, -1.0));
      if (nearD > 0.0) nearDist = (uDepthDecode.y / (nearD + uDepthDecode.x)) / max(1e-4, -vd.z);
      // (Behind the ground or sea: hidden.)
      if (nearD <= 0.0 || nearDist > sceneDist * 1.001 + 0.5) near = vec4(0.0);
    }
    if (near.a <= 0.002) near = vec4(0.0);
    gl_FragDepthEXT = near.a > 0.5 ? nearD : texture2D(tDepth, vUv).x;

    vec2 ta = hitSphere(ro, rd, uRa);
    vec2 tg = hitSphere(ro, rd, uRg);
    float t0 = max(ta.x, 0.0);
    float t1 = min(ta.y, sceneDist);
    if (tg.x > 0.0) t1 = min(t1, tg.x);
    if (ta.y < 0.0 || t1 <= t0) {
      // Out in space, clear of the air: the sun's disk as it is (in the map, from orbit).
      if (sky && (tg.x < 0.0 || tg.y < 0.0)) col.rgb += smoothstep(0.99996, 0.99999, mu0) * 40.0;
      gl_FragColor = vec4(col.rgb * (1.0 - near.a) + near.rgb, 1.0);
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
    // (Fewer steps along short rays, the ground near by: the air along them is all but the same
    // from end to end, and 8 or 16 steps add it up as well as 24 (within a level or three of 255,
    // measured at noon and sunset). The long rays, through the sky and to the horizon, where the
    // light changes along the way (sunset, the Earth's shadow), keep all 24.)
    // (Nor rays that climb or drop far through the air: looking down from high up with the sun
    // low, the light reddens all the way down.)
    float dhR = abs(length(ro + rd * t1) - length(ro + rd * t0));
    int n = int(clamp(uHazeMin + (24.0 - uHazeMin) * max((len - 15000.0) / 60000.0, dhR / 6000.0), uHazeMin, 24.0));
    // (Each count its own loop, of a fixed length: one the shader can unroll.)
    HazeSums z = HazeSums(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0), 0.0, 0.0, 0.0, 0.0, vec3(1.0), false);
    if (n <= 8) {
      for (int i = 0; i < 8; i++) hazeStep(float(i) / 8.0, float(i + 1) / 8.0, ro, rd, t0, len, tCloud, nearDist, cl.a, z);
    } else if (n <= 16) {
      for (int i = 0; i < 16; i++) hazeStep(float(i) / 16.0, float(i + 1) / 16.0, ro, rd, t0, len, tCloud, nearDist, cl.a, z);
    } else {
      for (int i = 0; i < N; i++) hazeStep(float(i) / float(N), float(i + 1) / float(N), ro, rd, t0, len, tCloud, nearDist, cl.a, z);
    }
    vec3 sumR = z.sumR;
    vec3 sumM = z.sumM;
    vec3 sumRN = z.sumRN;
    vec3 sumMN = z.sumMN;
    float odR = z.odR;
    float odM = z.odM;
    float odRN = z.odRN;
    float odMN = z.odMN;
    if (z.pastCloud) {
      pastCloud = true;
      transToCloud = z.transToCloud;
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
    if (uClouds > 0.5) {
      vec2 shd = 0.3 + 0.7 * texture2D(tCloudDist, vUv).gb;
      if (!sky) col.rgb *= clamp(shd.x / max(uLocalSun, 0.05), 0.0, 1.0);
      near.rgb *= clamp(shd.y / max(uLocalSun, 0.05), 0.0, 1.0);
    }
    vec3 outc = col.rgb * trans * cl.a + cl.rgb * transToCloud + inscatter;
    // The near solid: through the air in front of it, and any cloud in front of it.
    vec3 nearC = vec3(0.0);
    if (near.a > 0.0) {
      vec3 transN = exp(-(BR * odRN + BM * 1.1 * odMN));
      float cf = tCloud < 1e29 ? 1.0 - smoothstep(0.97, 1.03, tCloud / nearDist) : 0.0;
      nearC = near.rgb * transN * mix(1.0, cl.a, cf) + near.a * (cl.rgb * transToCloud * cf + uSunI * (sumRN * BR * phaseR + sumMN * BM * phaseM));
    }
    // The sun's disk, reddened by the air in front of it (and hidden by cloud).
    // (No ground ahead: the ray misses it, or it's all behind the camera.)
    if (sky && (tg.x < 0.0 || tg.y < 0.0)) outc += trans * cl.a * smoothstep(0.99996, 0.99999, mu) * 40.0;
    // Guard against any stray non-finite value (bloom would smear it over the whole screen).
    // Ground fog: lit grey, by day; the scene fades into it with distance.
    float fogOD = fogDepth(ro, rd, min(sceneDist, 8e4));
    if (fogOD > 0.0) {
      vec3 up = normalize(ro);
      float day = smoothstep(-0.1, 0.25, dot(up, uSun));
      // (Under overcast, as dim as the light there.)
      vec3 fogCol = vec3(0.6, 0.63, 0.67) * (0.06 + 0.94 * day) * (0.35 + 0.65 * uLocalSun);
      outc = mix(fogCol, outc, exp(-fogOD));
      if (near.a > 0.0) nearC = mix(fogCol * near.a, nearC, exp(-fogDepth(ro, rd, min(nearDist, 8e4))));
    }
    outc = outc * (1.0 - near.a) + nearC;
    if (any(notEqual(outc, outc)) || any(greaterThan(outc, vec3(6e4)))) outc = col.rgb * (1.0 - near.a) + near.rgb;
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
  uniform vec2 uSub;       // this frame's sub-pixel: which of each 2x2 block of (cloud) pixels
  uniform vec2 uFullSize;  // the clouds' full resolution (the screen's, or less: see setPixelRatio)
  uniform sampler2D tNearDepth; // the near solids' depth (their shadows)
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
    // (Each screen pixel's offset into the march's first step: interleaved gradient noise, the
    // same every frame (moving it on would make the clouds' edges shimmer).)
    vec2 fullPx = 2.0 * floor(gl_FragCoord.xy) + uSub;
    float jit = fract(52.9829189 * fract(dot(fullPx, vec2(0.06711056, 0.00583715))));
    vec4 c = uClouds > 0.5 ? clouds(ro, rd, tEnd, jit, tFirst) : vec4(0.0, 0.0, 0.0, 1.0);
    tFirst /= k;
    tEnd /= k;
    outCloud = c;
    // Where there's no cloud, store where the ray ends (the ground, or whatever's in front), not a
    // "none" value: the atmosphere pass reads this upscaled (blended between pixels), and a huge
    // value blended into a cloud edge would make the edge look farther than the ground behind it
    // and drop it, pixel by pixel, flickering as the view moves.
    // (And in .g: the clouds' shadow on whatever the ray ends at, the ground or the sea; in .b,
    // on the near solid there, if any (a vehicle, the pad, a building).)
    // (Through the middle of the pixel's 2x2 block, the same every frame: the sub-pixel moving
    // from frame to frame would make the shadows' edges shimmer.)
    float shadow = 1.0;
    float shadowNear = 1.0;
    if (uClouds > 0.5) {
      vec2 uvC = (2.0 * floor(gl_FragCoord.xy) + 1.0) / uFullSize;
      vec3 roC;
      vec3 rdC;
      float dC;
      float muC;
      viewRay(uvC, roC, rdC, dC, muC);
      vec3 rdCS = rdC + uPolar * (dot(rdC, uPolar) * ${(RE / RP - 1).toExponential(8)});
      float kC = length(rdCS);
      rdC = rdCS / kC;
      roC = roC + uPolar * (dot(roC, uPolar) * ${(RE / RP - 1).toExponential(8)});
      vec2 tgC = hitSphere(roC, rdC, uRc);
      float dS = dC < 1e29 ? dC * kC : dC;
      float tC = tgC.x > 0.0 ? (dS < tgC.x * 0.97 - 50.0 ? dS : tgC.x) : dS;
      // (Not from far off, a pixel spanning hundreds of metres: from orbit a cloud's shadow is
      // offset from it by a pixel or two.)
      // (Nor seen at a slant, low over the horizon: a pixel then spans a long strip of ground or
      // sea, and the shadows, one per 2x2 block, came out as pale stair-stepped blocks. There,
      // their average: as much darker as the clouds above cover.)
      vec3 PC = roC + rdC * tC;
      vec3 nC = normalize(PC);
      float slantC = tC * uPixAng / max(abs(dot(rdC, nC)), 0.02);
      float fade = smoothstep(250.0, 500.0, tC * uPixAng);
      float fadeS = smoothstep(100.0, 300.0, slantC);
      if (tC < 1e29 && fade < 1.0) {
        float s = fadeS < 1.0 ? cloudShadow(PC, tC) : 1.0;
        if (fadeS > 0.0) {
          vec4 wa;
          vec4 wb;
          weatherMap(nC, wa, wb);
          s = mix(s, 1.0 - 0.5 * smoothstep(0.015, 0.9, wa.x), fadeS);
        }
        shadow = mix(s, 1.0, fade);
      }
      float dN = texture(tNearDepth, uvC).x;
      if (dN > 0.0) {
        vec3 vd = normalize(vec3((uvC * 2.0 - 1.0 + uProjOff) * uTanHalf, -1.0));
        float tN = (uDepthDecode.y / (dN + uDepthDecode.x)) / max(1e-4, -vd.z) * kC;
        float fadeN = smoothstep(250.0, 500.0, tN * uPixAng);
        shadowNear = tN < tC * 1.001 + 1.0 ? (fadeN < 1.0 ? mix(cloudShadow(roC + rdC * tN, tN), 1.0, fadeN) : 1.0) : shadow;
      } else shadowNear = shadow;
    }
    outDist = vec4(min(tFirst < 1e29 ? tFirst : tEnd, 6e7) / 1000.0, shadow, shadowNear, 1.0);
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

  // The history at uv, Catmull-Rom filtered (five bilinear taps). (Bilinear alone blurs it a
  // little more every frame it's moved: in flight, the clouds went soft.)
  vec4 histAt(vec2 uv) {
    vec2 sp = uv * uFullSize;
    vec2 tc = floor(sp - 0.5) + 0.5;
    vec2 f = sp - tc;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t0 = (tc - 1.0) / uFullSize;
    vec2 t3 = (tc + 2.0) / uFullSize;
    vec2 t12 = (tc + w2 / w12) / uFullSize;
    vec4 r = texture(tHist, vec2(t12.x, t0.y)) * (w12.x * w0.y) + texture(tHist, vec2(t0.x, t12.y)) * (w0.x * w12.y)
           + texture(tHist, t12) * (w12.x * w12.y) + texture(tHist, vec2(t3.x, t12.y)) * (w3.x * w12.y)
           + texture(tHist, vec2(t12.x, t3.y)) * (w12.x * w3.y);
    return r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
  }

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
    vec4 hist = clamp(histAt(uvPrev), lo, hi);
    // (A pixel's new sample blended in, not swapped: steadier.)
    outColor = fresh ? mix(hist, here, 0.2) : hist;
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
    // (Sunlight for the air's glow: the sky's colour from the ground. Brighter, looking down
    // from high up the haze over the ground was several times the ground's own light: a milky
    // wash over everything, the clouds included.)
    uSunI: { value: 10 },
    tSunDepth: { value: sunDepthTable() as THREE.Texture },
    tNoise: { value: null as THREE.Texture | null },
    tCloudTex: FX_SHARED.tCloudTex,
    tCloudDist: FX_SHARED.tCloudDist,
    uCloudTexel: { value: new THREE.Vector2(1, 1) },
    uLocalSun: { value: 1 },
    uHazeMin: { value: 8 },
    tNear: { value: null as THREE.Texture | null },
    tNearDepth: { value: null as THREE.Texture | null },
    uScreen: FX_SHARED.uScreen,
    uClouds: FX_SHARED.uClouds,
    uFog: FX_SHARED.uFog,
    uRainMist: FX_SHARED.uRainMist,
    tWxA0: { value: null as THREE.Texture | null },
    tWxB0: { value: null as THREE.Texture | null },
    tWxA1: { value: null as THREE.Texture | null },
    tWxB1: { value: null as THREE.Texture | null },
    tWxC0: { value: null as THREE.Texture | null },
    tWxC1: { value: null as THREE.Texture | null },
    uWxBlend: { value: 0 },
    uWorldToEcef: { value: new THREE.Matrix3() },
    uDrift: { value: new THREE.Vector3() },
    uStormShift: { value: new THREE.Vector2() },
    uCloudSun: { value: 1.4 },
    uRainAny: { value: 0 },
    uFlash: { value: new THREE.Vector4() },
    uPixAng: { value: 0.001 },
    uRc: { value: RE },
    uPolar: { value: new THREE.Vector3(0, 1, 0) },
    uProjOff: { value: new THREE.Vector2() },
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
  /** The background (see BG_LAYER) is drawn here, with its depth. */
  private sceneTarget: THREE.WebGLRenderTarget;
  /**
   * The near solids (see NEAR_LAYER), over nothing (alpha 0), multisampled (4x MSAA: smooth
   * edges). Only this target needs the samples: the atmosphere and everything after it work on
   * the resolved image, much cheaper than carrying 4 samples per pixel through every pass.
   */
  private nearTarget: THREE.WebGLRenderTarget;
  /** The background's roots (see BG_LAYER). */
  private background = new Set<THREE.Object3D>();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    super();
    this.needsSwap = true;
    this.quad = new FullScreenQuad(
      // (Writes the solids' depth, both halves', for the effects drawn after: always. Under the
      // reversed depth buffer three.js swaps each test for its complement: "never" is drawn as
      // "always".)
      new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, depthTest: true, depthWrite: true, depthFunc: THREE.NeverDepth }),
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
    // (The background without multisampling: its edges are the horizon and hills, against the
    // sky's haze; the near solids, drawn apart, keep it. ~5 ms a frame at 2x pixel density.)
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.nearTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.nearTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  }

  /** The background's roots: drawn first, the clouds marched against them (see BG_LAYER). */
  setBackground(...roots: THREE.Object3D[]): void {
    for (const r of roots) this.background.add(r);
  }

  /** The clouds' resolution, as a share of the screen's (see setPixelRatio). */
  private cloudRes = 1;

  /**
   * The screen's pixel density: the clouds are drawn at no more than 1.25 pixels per point (on a
   * high-density screen, the soft clouds don't need every pixel; the upscale is invisible, and it
   * saves a third or more of their cost). Before setSize.
   */
  /** The clouds' pixels per point of the screen (lowered under load: see main's resolution governor). */
  cloudDensity = 1.25;

  setPixelRatio(ratio: number): void {
    this.cloudRes = Math.min(1, this.cloudDensity / ratio);
    // The near solids' multisampling: at a high pixel density the pixels are already small enough
    // that 2 samples smooth their edges as well as 4 (a 4x multisampled HDR target at 2x density
    // is a lot to clear and resolve every frame).
    const samples = ratio >= 1.5 ? 2 : 4;
    if (this.nearTarget.samples !== samples) {
      this.nearTarget.samples = samples;
      this.nearTarget.dispose();
    }
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.nearTarget.setSize(width, height);
    const cw = Math.max(1, Math.round(width * this.cloudRes));
    const ch = Math.max(1, Math.round(height * this.cloudRes));
    this.cloudTarget.setSize(Math.max(1, Math.ceil(cw / 2)), Math.max(1, Math.ceil(ch / 2)));
    for (const h of this.history) h.setSize(cw, ch);
    this.uniforms.uFullSize.value.set(cw, ch);
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

    // 1. The background (terrain, the globe, the Moon, stars), with depth, over black (space).
    // (The shadow map, drawn here, has everything in it: the shadow camera sees layer 0.)
    const fxAny = this.sortLayers();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    cam.layers.set(BG_LAYER);
    renderer.setRenderTarget(scene);
    renderer.clear();
    renderer.render(this.scene, cam);
    // And the near solids apart, over nothing: put over the clouds and air after, their edges
    // smooth. (Drawn in with the background, the clouds' depth test would cut their edges to
    // the pixel, and the half-resolution clouds would leave a blocky fringe round them.)
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    cam.layers.set(NEAR_LAYER);
    renderer.setRenderTarget(this.nearTarget);
    renderer.clear();
    renderer.render(this.scene, cam);
    this.uniforms.tNear.value = this.nearTarget.texture;
    this.uniforms.tNearDepth.value = this.nearTarget.depthTexture;

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
    (this.quad.material as THREE.ShaderMaterial).depthFunc = renderer.capabilities.reversedDepthBuffer ? THREE.NeverDepth : THREE.AlwaysDepth;
    this.quad.render(renderer);

    // 3. The glowing effects on top, depth-tested against the solids (whose depth the pass above
    // wrote into this buffer).
    if (fxAny && writeBuffer.depthTexture) {
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

  /**
   * Each solid onto the background's layer or the near one (by its root: see setBackground),
   * lights onto both; effects patched to fade behind clouds and into fog. Whether any effect is
   * showing (exhaust, smoke, plasma...).
   */
  private sortLayers(): boolean {
    let fx = false;
    const BG = 1 << BG_LAYER;
    const NEAR = 1 << NEAR_LAYER;
    const FX = 1 << FX_LAYER;
    const visit = (o: THREE.Object3D, bg: boolean) => {
      if (!o.visible) return;
      bg ||= this.background.has(o);
      const L = o.layers;
      if ((o as THREE.Light).isLight) L.mask |= BG | NEAR;
      else if (L.mask & 1) L.mask = (L.mask & ~(BG | NEAR)) | (bg ? BG : NEAR);
      if (L.mask & FX) {
        const drawable = (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Line).isLine;
        if (drawable) {
          fx = true;
          // (Every effect fades behind clouds and into fog: patched the first time it's seen.)
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
          for (const m of Array.isArray(mat) ? mat : [mat]) if ((m as THREE.ShaderMaterial).isShaderMaterial) occludeFx(m as THREE.ShaderMaterial);
        }
      }
      for (const c of o.children) visit(c, bg);
    };
    visit(this.scene, false);
    return fx;
  }

  dispose(): void {
    this.quad.dispose();
    this.cloudQuad.dispose();
    this.cloudTarget.dispose();
    this.resolveQuad.dispose();
    for (const h of this.history) h.dispose();
    this.sceneTarget.dispose();
    this.nearTarget.dispose();
  }
}
