// The sea's surface: waves from the wind where the camera is (the weather model's), drawn into
// the water's shading wherever there is sea (the detailed region round Starbase, terrain.ts, and
// the whole-Earth tiles, globeTiles.ts).
//
// The waves: a fixed set of long-crested trains (16 wavelength bands from 0.7 m to ~500 m, three
// headings in each, plus two of swell), their heights from a fully developed wind sea's spectrum
// (Pierson-Moskowitz) and spread about the wind's heading, so a light breeze leaves a glassy sea
// of ripples and a gale a heaving one of long dark waves streaked white. Each train is summed in
// the shader for the surface's tilt (its normal), and once one is finer than a few pixels it's
// faded out and its tilt counted into the roughness instead, with everything finer than the set
// (Cox & Munk's slopes for the wind), so from far off and from orbit the sun's glitter on the sea
// spreads as wide as the wind roughens it. Whitecaps on the crests, as many as the wind breaks
// (Monahan's share of the sea), and in a gale foam streaks down the wind.
//
// The trains' headings never turn (the wind turning shifts their heights): turning them would
// sweep the phase of every wave far off, a flicker. Positions are on a plane through an anchor
// (east, north there), moved with the camera in whole steps whose phase is folded into each
// train's, so the numbers the GPU sees stay small.

import * as THREE from 'three';
import type { V3 } from '../sim/math';

const G = 9.81;
const BANDS = 16;
const PER_BAND = 3;
/** Wave trains: the wind sea's, then two of swell. */
export const SEA_N = BANDS * PER_BAND + 2;
/** How far the camera goes from the anchor before it moves (m: a whole step). */
const STEP = 8000;
/** Beyond this from the anchor's plane origin, a new plane (rare: the pattern jumps). */
const REPLANE = 1.5e6;
/** The sea the wind blows over, m. */
const FETCH = 300e3;

interface Train {
  /** Heading, rad (from east, toward north). */
  th: number;
  k: number;
  omega: number;
  /** Band width (rad/s). */
  dOmega: number;
  phase0: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRAINS: Train[] = (() => {
  const r = mulberry(0x5ea5);
  const out: Train[] = [];
  const ratio = 1.55;
  for (let b = 0; b < BANDS; b++) {
    const lam = 0.7 * ratio ** b * (0.92 + 0.16 * r());
    const k = (2 * Math.PI) / lam;
    const omega = Math.sqrt(G * k);
    const th0 = r() * 2 * Math.PI;
    for (let j = 0; j < PER_BAND; j++) {
      out.push({ th: th0 + (j * 2 * Math.PI) / PER_BAND + (r() - 0.5) * 0.7, k, omega, dOmega: omega * (Math.sqrt(Math.sqrt(ratio)) - 1 / Math.sqrt(Math.sqrt(ratio))), phase0: r() * 2 * Math.PI });
    }
  }
  // Swell (headings set for the place: see SeaState.setSwell).
  for (const lam of [170, 235]) {
    const k = (2 * Math.PI) / lam;
    out.push({ th: 0, k, omega: Math.sqrt(G * k), dOmega: 0, phase0: r() * 2 * Math.PI });
  }
  return out;
})();

/** Pierson-Moskowitz: the wave height spectrum (m^2 s) at omega for a wind U (m/s at 10 m). */
function pm(omega: number, U: number): number {
  const u = Math.max(0.5, U * 1.07);
  return 8.1e-3 * G * G * omega ** -5 * Math.exp(-0.74 * (G / (u * omega)) ** 4);
}

/** The standard normal's upper quantile: the z with P(Z > z) = p (Abramowitz & Stegun 26.2.23). */
function upperQuantile(p: number): number {
  const q = Math.min(0.5, Math.max(1e-6, p));
  const t = Math.sqrt(-2 * Math.log(q));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class SeaState {
  readonly uniforms = {
    /** Per train: heading (x, y on the plane), k, amplitude (m). */
    uSeaW: { value: Array.from({ length: SEA_N }, () => new THREE.Vector4()) },
    uSeaPh: { value: new Float32Array(SEA_N) },
    /** Wind (m/s), whitecap share, foam threshold (in the resolved height's sigmas), the slopes finer than the set (mean square). */
    uSea: { value: new THREE.Vector4() },
    /** The wind's heading on the plane (x, y), streaks (0..1), how much darker the sea. */
    uSea2: { value: new THREE.Vector4() },
    /** The camera from the (moved) anchor, world axes: a fragment's plane point is dot(rel + this, E / N). */
    uSeaOff: { value: new THREE.Vector3() },
    uSeaE: { value: new THREE.Vector3(1, 0, 0) },
    uSeaN: { value: new THREE.Vector3(0, 0, -1) },
    /** The Earth's centre from the camera (world). */
    uSeaCentre: { value: new THREE.Vector3() },
    /** The wind sea's height (Hs, m), the swell's, its wavenumber, its phase now (for the surf). */
    uSea3: { value: new THREE.Vector4() },
  };
  /** The wind the sea is up to (m/s, on the plane: east, north), eased. */
  private wind = new THREE.Vector2(-5, 2);
  private windSet = false;
  /** The plane: origin (world, float64), axes (world). */
  private origin: V3 = [0, 0, 0];
  private E = new THREE.Vector3(1, 0, 0);
  private N = new THREE.Vector3(0, 0, -1);
  /** The anchor's step on the plane (m). */
  private shift: [number, number] = [0, 0];
  private swellH = 0.6;
  private swellTh = Math.PI - 0.3;
  private v = new THREE.Vector3();
  private clock = 0;
  /** For the debug panel: the sea now. */
  readonly state = { U: 0, Hs: 0, whitecaps: 0, lambdaPeak: 0 };

  /** Debug: this wind instead (m/s east, north). */
  debugWind: [number, number] | null = null;

  /** Snap to the wind at once (a new scene): the next update doesn't ease. */
  reset(): void {
    this.windSet = false;
  }

  /**
   * Each frame. dt: real seconds (0 when paused); cam: the camera (world, float64); centre: the
   * Earth's centre (world); windEN: the surface wind there (m/s east, north; null: none known,
   * a moderate breeze); east / north: the local axes there (world).
   */
  update(dt: number, cam: V3, centre: V3, windEN: readonly number[] | null, east: THREE.Vector3, north: THREE.Vector3): void {
    this.clock += dt;
    const u = this.uniforms;
    // The plane: re-laid only when the camera's far from it (and then square to the ground there).
    const dx = cam[0] - this.origin[0], dy = cam[1] - this.origin[1], dz = cam[2] - this.origin[2];
    if (dx * dx + dy * dy + dz * dz > REPLANE * REPLANE) {
      const up = this.v.set(cam[0] - centre[0], cam[1] - centre[1], cam[2] - centre[2]).normalize();
      const R = Math.hypot(cam[0] - centre[0], cam[1] - centre[1], cam[2] - centre[2]);
      const g = Math.min(R, 6.4e6);
      this.origin = [centre[0] + up.x * g, centre[1] + up.y * g, centre[2] + up.z * g];
      this.E.copy(east);
      this.N.copy(north);
      this.shift = [0, 0];
    }
    // The camera on the plane, and the anchor's step nearest it.
    const ce = dx * this.E.x + dy * this.E.y + dz * this.E.z;
    const cn = dx * this.N.x + dy * this.N.y + dz * this.N.z;
    this.shift = [Math.round(ce / STEP) * STEP, Math.round(cn / STEP) * STEP];
    const [se, sn] = this.shift;
    u.uSeaOff.value.set(
      cam[0] - this.origin[0] - se * this.E.x - sn * this.N.x,
      cam[1] - this.origin[1] - se * this.E.y - sn * this.N.y,
      cam[2] - this.origin[2] - se * this.E.z - sn * this.N.z,
    );
    u.uSeaE.value.copy(this.E);
    u.uSeaN.value.copy(this.N);
    u.uSeaCentre.value.set(centre[0] - cam[0], centre[1] - cam[1], centre[2] - cam[2]);

    // The wind, on the plane's axes (a sea takes a while to get up or die down).
    let we = -5, wn = 2;
    if (this.debugWind) [we, wn] = this.debugWind;
    else if (windEN) [we, wn] = windEN;
    const w = this.v.copy(east).multiplyScalar(we).addScaledVector(north, wn);
    const pe = w.dot(this.E), pn = w.dot(this.N);
    if (!this.windSet) {
      this.wind.set(pe, pn);
      this.windSet = true;
      this.setSwell(cam, centre);
    } else {
      const k = 1 - Math.exp(-dt / 25);
      this.wind.x += (pe - this.wind.x) * k;
      this.wind.y += (pn - this.wind.y) * k;
    }
    const U = Math.max(0.3, this.wind.length());
    const thW = Math.atan2(this.wind.y, this.wind.x);
    // (The waves' size: fully developed up to what ~300 km of sea lets the wind raise (JONSWAP's
    // peak for that fetch): as the spectrum of a lighter wind, its tail and the whitecaps the
    // wind's own.)
    const wpFetch = 22 * ((G * G) / (U * FETCH)) ** (1 / 3);
    const Us = Math.min(U, (0.877 * G) / wpFetch);

    // The trains' heights for this wind (and the swell's).
    let mss = 0;
    let var0 = 0;
    for (let i = 0; i < SEA_N; i++) {
      const t = TRAINS[i];
      let a: number;
      if (i < BANDS * PER_BAND) {
        const d = Math.cos(t.th - thW);
        // (Spread: cos^2 about the wind, a little the other way too.)
        const D = 0.9 * (d > 0 ? (2 / Math.PI) * d * d : 0) + 0.1 / (2 * Math.PI);
        a = Math.sqrt(2 * pm(t.omega, Us) * t.dOmega * D * ((2 * Math.PI) / PER_BAND));
      } else {
        // (Swell: two trains sharing its height.)
        a = (this.swellH / 4) * Math.SQRT2 * (i === SEA_N - 2 ? 0.8 : 0.6);
      }
      // (No train steeper than breaks.)
      a = Math.min(a, 0.11 / t.k);
      mss += 0.5 * (a * t.k) ** 2;
      var0 += 0.5 * a * a;
      const th = i < BANDS * PER_BAND ? t.th : this.swellTh + (i === SEA_N - 1 ? 0.25 : 0);
      const dir = u.uSeaW.value[i].set(Math.cos(th), Math.sin(th), t.k, a);
      // Phase, folded with the anchor's step (float64 here, so nothing jumps).
      const ph = t.phase0 - t.omega * this.clock + t.k * (dir.x * se + dir.y * sn);
      u.uSeaPh.value[i] = ph - Math.floor(ph / (2 * Math.PI)) * 2 * Math.PI;
    }
    // Finer than the set: what's left of Cox & Munk's slopes for this wind.
    const cm = 0.003 + 5.12e-3 * U;
    const W = Math.min(0.3, 3.84e-6 * U ** 3.41);
    u.uSea.value.set(U, W, W > 1e-5 ? upperQuantile(W) : 6, Math.max(0.0015, cm - mss));
    u.uSea2.value.set(Math.cos(thW), Math.sin(thW), smooth(14, 24, U), 0.4 * smooth(7, 22, U));
    {
      let vw = 0;
      for (let i = 0; i < BANDS * PER_BAND; i++) vw += 0.5 * u.uSeaW.value[i].w ** 2;
      const sw = TRAINS[SEA_N - 2];
      const ph = -sw.omega * this.clock;
      u.uSea3.value.set(4 * Math.sqrt(vw), this.swellH, sw.k, ph - Math.floor(ph / (2 * Math.PI)) * 2 * Math.PI);
    }
    this.state.U = U;
    this.state.Hs = 4 * Math.sqrt(var0);
    this.state.whitecaps = W;
    this.state.lambdaPeak = (2 * Math.PI * G) / ((0.877 * G) / Math.max(0.5, Us)) ** 2;
  }

  /** The swell for the place: some long waves from far-off storms, its own heading and height. */
  private setSwell(cam: V3, centre: V3): void {
    const r = Math.hypot(cam[0] - centre[0], cam[1] - centre[1], cam[2] - centre[2]);
    // (A hash of where, on a ~1000 km grid.)
    const h = mulberry(Math.floor(((cam[0] - centre[0]) / r) * 6) * 73 + Math.floor(((cam[1] - centre[1]) / r) * 6) * 151 + Math.floor(((cam[2] - centre[2]) / r) * 6) * 283 + 7);
    h();
    this.swellH = 0.4 + 1.1 * h();
    this.swellTh = Math.atan2(this.wind.y, this.wind.x) + (h() - 0.5) * 1.6;
  }
}

/**
 * The shader side, in two parts. SEA_COMMON (vertex or fragment): the uniforms, seaPlane(rel)
 * (rel: the point from the camera, world) and seaHeight (the surface's rise and sideways shift,
 * for a mesh). SEA_FRAG (fragment): seaSurface(rel, p, J, wpLim, swellK): p its seaPlane, J
 * seaPixel(p); wpLim: the waves' peak frequency the local fetch allows (0: open sea), swellK:
 * how much swell gets in (1: open sea). Returns the normal (world), roughness, foam (0..1) and
 * the water's darkening in gSea*.
 */
export const SEA_COMMON = /* glsl */ `
uniform vec4 uSeaW[${SEA_N}];
uniform float uSeaPh[${SEA_N}];
uniform vec4 uSea;
uniform vec4 uSea2;
uniform vec4 uSea3;
uniform vec3 uSeaOff;
uniform vec3 uSeaE;
uniform vec3 uSeaN;
uniform vec3 uSeaCentre;
float seaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float seaNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), u.x), mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 seaPlane(vec3 rel) {
  vec3 w = rel + uSeaOff;
  return vec2(dot(w, uSeaE), dot(w, uSeaN));
}
// (Where the waves are reckoned from: the plane warped a few metres, slowly, so the shorter
// crests wander and break up as a real chop's do instead of running in straight parallel rows;
// the long waves hardly move.)
vec2 seaWarp(vec2 p) {
  return p + 7.0 * vec2(seaNoise(p / 43.0) - 0.5, seaNoise(p / 37.0 + 11.3) - 0.5) + 2.5 * vec2(seaNoise(p / 13.0 + 5.1) - 0.5, seaNoise(p / 11.0 + 2.7) - 0.5);
}
// (Train i's share here: the swell as much as gets in; the wind sea's longer waves only as far as
// the fetch lets the wind raise them.)
float seaScale(int i, float k, float wpLim, float swellK) {
  if (i >= ${SEA_N - 2}) return swellK;
  return wpLim > 0.0 ? smoothstep(0.75, 1.2, sqrt(9.81 * k) / wpLim) : 1.0;
}
// The surface's rise (m) and its sideways shift on the plane (m: the crests drawn sharp, the
// troughs wide, as Gerstner's waves), from the trains a mesh 'spacing' apart can hold.
float seaHeight(vec2 p, float spacing, float wpLim, float swellK, out vec2 chop) {
  float h = 0.0;
  chop = vec2(0.0);
  vec2 pw = seaWarp(p);
  for (int i = 0; i < ${SEA_N}; i++) {
    vec4 W = uSeaW[i];
    float f = smoothstep(2.5 * spacing, 6.0 * spacing, 6.2832 / W.z) * seaScale(i, W.z, wpLim, swellK);
    if (f <= 0.0) continue;
    float ph = dot(pw, W.xy) * W.z + uSeaPh[i];
    h += f * W.w * sin(ph);
    chop += f * 0.65 * W.w * cos(ph) * W.xy;
  }
  return h;
}
`;

export const SEA_FRAG = /* glsl */ `
vec3 gSeaNormal;
float gSeaRough;
float gSeaFoam;
// (The water's own colour, as a share of the map's: the sea is dark, its look mostly the sky it
// reflects, which is what shows the waves: up close, darker than the photo (lit by a hazy sky
// from far off, and from orbit), which it's back to some tens of km off.)
float gSeaBody;
// The point's change across a pixel (x, y: dp/dx; z, w: dp/dy): take it for every fragment (a
// derivative), then call seaSurface only where there's water.
vec4 seaPixel(vec2 p) {
  return vec4(dFdx(p), dFdy(p));
}
// (A pixel's reach along heading d, m.)
float seaReach(vec4 J, vec2 d) { return abs(dot(J.xy, d)) + abs(dot(J.zw, d)) + 1e-4; }
void seaSurface(vec3 rel, vec2 p, vec4 J, float wpLim, float swellK) {
  vec2 pw = seaWarp(p);
  vec2 slope = vec2(0.0);
  float h = 0.0, v = 0.0, vAll = 0.0, lost = 0.0;
  for (int i = 0; i < ${SEA_N}; i++) {
    vec4 W = uSeaW[i];
    W.w *= seaScale(i, W.z, wpLim, swellK);
    float ak = W.w * W.z;
    vAll += 0.5 * W.w * W.w;
    // (Faded out once finer than a few pixels along its heading: its tilt goes into the roughness.)
    float f = smoothstep(3.5, 9.0, 6.2832 / (W.z * seaReach(J, W.xy)));
    lost += 0.5 * ak * ak * (1.0 - f);
    if (f <= 0.0) continue;
    float ph = dot(pw, W.xy) * W.z + uSeaPh[i];
    float s = sin(ph);
    slope += f * ak * cos(ph) * W.xy;
    h += f * W.w * s;
    v += 0.5 * f * f * W.w * W.w;
  }
  vec3 up = normalize(rel - uSeaCentre);
  vec3 e = normalize(uSeaE - up * dot(uSeaE, up));
  vec3 n = cross(up, e);
  gSeaNormal = normalize(up - slope.x * e - slope.y * n);
  // Roughness (GGX alpha ~ the unresolved slopes' rms; three's roughness is alpha's root).
  gSeaRough = clamp(sqrt(sqrt(uSea.w + lost)), 0.1, 0.75);

  // Whitecaps: breaking on the higher crests, here and there (as many as the wind breaks: the
  // threshold's for that share of the sea); each a bright lacy patch, with older, thinner foam
  // round it; in a gale, streaks down the wind. All fade to their average where too fine to draw.
  vec2 wd = uSea2.xy;
  vec2 q = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));
  vec2 dq = vec2(seaReach(J, wd), seaReach(J, vec2(-wd.y, wd.x)));
  float L = clamp(uSea.x * uSea.x * 0.035, 2.0, 18.0);
  // (How well drawn: patches, their lace, the streaks across the wind.)
  float okP = 1.0 - smoothstep(0.15 * L, 0.5 * L, max(dq.x, dq.y));
  float okL = 1.0 - smoothstep(0.25, 0.9, max(dq.x, dq.y));
  float sig = sqrt(max(v, 1e-6));
  float spot = 0.6 * seaNoise(vec2(q.x / (2.2 * L), q.y / L)) + 0.4 * seaNoise(vec2(q.x / (0.9 * L), q.y / (0.5 * L)) + 31.0);
  float z = (spot - 0.5) * 4.0 * 0.75 + 0.65 * h / sig;
  float lace = mix(0.75, 0.45 + 0.55 * seaNoise(q / 0.7 + 7.0) * (0.6 + 0.8 * seaNoise(q / 2.1 + 3.0)), okL);
  float cap = smoothstep(uSea.z - 0.2, uSea.z + 0.45, z);
  float old = 0.3 * smoothstep(uSea.z - 1.1, uSea.z - 0.2, z);
  float foamNear = max(cap * (0.55 + 0.45 * lace), old * lace);
  // (Far off: the average.)
  float on = smoothstep(0.0003, 0.003, uSea.y);
  float foam = mix(uSea.y * 1.2, foamNear, okP) * on;
  if (uSea2.z > 0.0) {
    float okS = 1.0 - smoothstep(0.3, 1.2, dq.y);
    float st = seaNoise(vec2(q.x / 70.0, q.y / 2.2)) * 0.6 + 0.4 * seaNoise(vec2(q.x / 23.0 + 5.0, q.y / 1.1));
    float streak = smoothstep(0.74, 0.86, st) * lace * smoothstep(0.3, 0.7, seaNoise(vec2(q.x / 150.0, q.y / 40.0) + 3.0));
    foam = max(foam, uSea2.z * mix(0.04, 0.4 * streak, okS));
  }
  gSeaFoam = clamp(foam, 0.0, 1.0);
  gSeaBody = mix(0.3, 1.0, smoothstep(2000.0, 40000.0, length(rel))) * (1.0 - uSea2.w);
}
`;


/** Both parts, for a fragment shader. */
export const SEA_GLSL = SEA_COMMON + SEA_FRAG;

/** The same uniforms, for a material's shader (onBeforeCompile). */
export function bindSea(shader: { uniforms: Record<string, THREE.IUniform> }, sea: SeaState): void {
  Object.assign(shader.uniforms, sea.uniforms);
}

/** The one sea for everything. */
export const sea = new SeaState();
