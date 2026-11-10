// The planet's weather: one model, evaluated anywhere on the globe at any time, deterministic
// from a seed (so the render thread, the bake worker and the physics worker agree).
//
// It's built the way weather is organized, not from a single noise pattern:
//   climate    where clouds are on an average day: the ITCZ's band of tropical thunderstorms
//              (following the sun north and south, further over land: monsoons), trade cumulus
//              over the subtropical oceans, the clear subtropical deserts, the stratocumulus
//              decks off the west coasts of continents (cold currents), the cloudy storm-track
//              oceans and Southern Ocean, afternoon cumulus and storms over land in summer;
//   systems    weather systems, born, carried along and dying on their own schedules all over
//              the globe: mid-latitude lows (a comma cloud wrapping round the centre, the warm
//              front's cloud shield ahead, a long cold front trailing towards the tropics, a dry
//              slot and cellular cumulus behind), migratory highs (clearing), tropical cyclones
//              (eye, dense overcast, spiral bands; forming over warm oceans, curving poleward);
//   wind       from the pressure field (climate + systems) through geostrophic balance, turned
//              and slowed near the ground by friction, with the jet streams aloft, the trades,
//              hurricanes' own winds and gusts near the ground.
//
// Weather over the launch site can be asked for (clear, rain...): the model then adds a system
// that brings it (a cold front, a stratus deck, sea fog, a high) and keeps other systems away
// for the day; it then moves and evolves like any other.
//
// Coordinates: latitude / longitude in degrees (geodetic is fine at this scale), heights in m,
// time in s (the simulation's clock), sun direction in Earth-fixed axes (ECEF, unit).

import { Noise3, hashInts, rng } from './noise';

export const R_EARTH = 6.371e6;
const DEG = Math.PI / 180;
const DAY = 86400;
const OMEGA = 7.2921159e-5;

export type SiteWeather = 'natural' | 'clear' | 'fair' | 'partly' | 'mostly' | 'overcast' | 'rain' | 'storm' | 'fog';

/**
 * A day's weather at Starbase (Boca Chica, on the Gulf coast of south Texas, 26 N), drawn the way
 * the place's climate deals it out. Mostly sunny: blue sky with a few small cumulus off the Gulf,
 * or a fair field of them by afternoon. Now and then a grey day under a stratus deck, a cold
 * front's rain, sea fog rolling in off the Gulf (winter and spring, when warm moist air crosses
 * the cooler shelf water), or thunderstorms (summer and early autumn, the sea breeze and tropical
 * moisture). season: the sun's latitude, deg (+ northern summer); u: uniform 0..1.
 */
export function starbaseDay(season: number, u: number): Exclude<SiteWeather, 'natural'> {
  // (Roughly Brownsville's: ~70 days a year with rain, ~30 with thunder, ~30 with dense fog.)
  const s = Math.max(-1, Math.min(1, season / 23.44));
  const sum = (s + 1) / 2; // 0 winter .. 1 summer
  const odds: [Exclude<SiteWeather, 'natural'>, number][] = [
    ['fair', 0.3 + 0.06 * sum],
    ['partly', 0.2 + 0.1 * sum],
    ['mostly', 0.1 - 0.02 * sum],
    ['clear', 0.12 - 0.07 * sum],
    ['overcast', 0.14 - 0.08 * sum],
    ['rain', 0.09 - 0.02 * sum],
    ['storm', 0.03 + 0.1 * sum],
    ['fog', 0.12 - 0.09 * sum],
  ];
  let total = 0;
  for (const [, p] of odds) total += p;
  let x = u * total;
  for (const [w, p] of odds) {
    if ((x -= p) < 0) return w;
  }
  return 'fair';
}

export interface WeatherConfig {
  seed: number;
  /** Subsolar latitude, degrees (the season: + is northern summer). */
  season: number;
  /** Weather asked for over the site at t0. */
  site: SiteWeather;
  siteLat: number;
  siteLon: number;
  t0: number;
}

/** The weather over a point: what the clouds are like there. */
export interface Sample {
  /** Low / middle cloud cover 0..1 (before the fine detail the renderer adds). */
  cover: number;
  /** Cloud base and top, m. */
  base: number;
  top: number;
  /** 0 = a solid sheet, 1 = scattered cells. */
  broken: number;
  /** Size of the cells: 0 = small cumulus, 1 = mesoscale cells (tens of km). */
  cell: number;
  /** High cloud (cirrus, anvils) 0..1. */
  high: number;
  /** Rain 0..1. */
  precip: number;
  /** Fog at the ground 0..1. */
  fog: number;
  /** Deep convection (thunderstorms: towers to the tropopause, anvils) 0..1. */
  conv: number;
  /** A middle layer over the low clouds (altocumulus, altostratus) 0..1, and its height, m. */
  mid: number;
  midAlt: number;
  /** The cirrus's height, m (higher in the tropics, lower toward the poles). */
  ciAlt: number;
}

export const newSample = (): Sample => ({ cover: 0, base: 1000, top: 2000, broken: 0.5, cell: 0.3, high: 0, precip: 0, fog: 0, conv: 0, mid: 0, midAlt: 4000, ciAlt: 10000 });

/** Cloud base of cumulus from the air's dew-point spread (temperature minus dew point), m: the lifting condensation level, ~125 m per deg C. */
export const condensationLevel = (spread: number): number => Math.min(3000, Math.max(350, 125 * spread));

/**
 * The air's dew-point spread over the site on a day of each kind, deg C: dry clear days lift the
 * cumulus bases high; muggy, overcast or wet days keep them low. (And how much middle cloud.)
 */
const SITE_AIR: Record<Exclude<SiteWeather, 'natural'>, { spread: number; mid: number }> = {
  clear: { spread: 14, mid: 0 },
  fair: { spread: 8, mid: 0.1 },
  partly: { spread: 6, mid: 0.35 },
  mostly: { spread: 4.5, mid: 0.5 },
  overcast: { spread: 3, mid: 0.75 },
  rain: { spread: 2, mid: 0.85 },
  storm: { spread: 5, mid: 0.45 },
  fog: { spread: 1.5, mid: 0.15 },
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --- Land -------------------------------------------------------------------------------------

/** Land fraction on a 0.5-degree grid (public/data/landmask.bin), and fields derived from it. */
export class Land {
  static readonly W = 720;
  static readonly H = 360;
  /** Coarse (2-degree) fields: land smoothed over ~1000 km; west-coast cold-ocean index. */
  private blur = new Float32Array(180 * 90);
  private coast = new Float32Array(180 * 90);

  constructor(private data: Uint8Array) {
    const CW = 180, CH = 90;
    const coarse = new Float32Array(CW * CH);
    for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++) {
      let s = 0;
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) s += data[(j * 4 + b) * Land.W + i * 4 + a];
      coarse[j * CW + i] = s / (16 * 255);
    }
    // Blur: ~1000 km box (in km, so wider in longitude toward the poles).
    for (let j = 0; j < CH; j++) {
      const lat = 89 - j * 2;
      const rj = 5;
      const ri = Math.min(60, Math.round(5 / Math.max(0.2, Math.cos(lat * DEG))));
      for (let i = 0; i < CW; i++) {
        let s = 0;
        let n = 0;
        for (let b = -rj; b <= rj; b++) {
          const jj = j + b;
          if (jj < 0 || jj >= CH) continue;
          for (let a = -ri; a <= ri; a += Math.max(1, Math.floor(ri / 8))) {
            s += coarse[jj * CW + ((i + a + CW) % CW)];
            n++;
          }
        }
        this.blur[j * CW + i] = s / n;
      }
    }
    // Cold-ocean index: ocean with a continent close to the east (cold currents and upwelling
    // off California, Peru, Namibia, the Canaries, Western Australia).
    for (let j = 0; j < CH; j++) {
      const lat = 89 - j * 2;
      const kmPerCell = 222 * Math.max(0.1, Math.cos(lat * DEG));
      for (let i = 0; i < CW; i++) {
        if (coarse[j * CW + i] > 0.5) continue;
        let best = 0;
        for (let a = 1; a * kmPerCell < 2500 && a < 90; a++) {
          const l = coarse[j * CW + ((i + a) % CW)];
          if (l > 0.4) {
            best = Math.max(best, l * Math.exp(-(a * kmPerCell) / 900));
            break;
          }
        }
        this.coast[j * CW + i] = best * (1 - coarse[j * CW + i]);
      }
    }
  }

  /** Land fraction 0..1 (bilinear). */
  frac(lat: number, lon: number): number {
    const W = Land.W, H = Land.H;
    const x = ((lon + 180) / 360) * W - 0.5;
    const y = ((90 - lat) / 180) * H - 0.5;
    const x0 = Math.floor(x), y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
    const fx = x - x0, fy = Math.min(1, Math.max(0, y - y0));
    const i0 = ((x0 % W) + W) % W, i1 = (i0 + 1) % W;
    const d = this.data;
    const a = d[y0 * W + i0] + (d[y0 * W + i1] - d[y0 * W + i0]) * fx;
    const b = d[(y0 + 1) * W + i0] + (d[(y0 + 1) * W + i1] - d[(y0 + 1) * W + i0]) * fx;
    return (a + (b - a) * fy) / 255;
  }

  private coarseAt(f: Float32Array, lat: number, lon: number): number {
    const x = ((lon + 180) / 360) * 180 - 0.5;
    const y = ((90 - lat) / 180) * 90 - 0.5;
    const x0 = Math.floor(x), y0 = Math.max(0, Math.min(88, Math.floor(y)));
    const fx = x - x0, fy = Math.min(1, Math.max(0, y - y0));
    const i0 = ((x0 % 180) + 180) % 180, i1 = (i0 + 1) % 180;
    const a = f[y0 * 180 + i0] + (f[y0 * 180 + i1] - f[y0 * 180 + i0]) * fx;
    const b = f[(y0 + 1) * 180 + i0] + (f[(y0 + 1) * 180 + i1] - f[(y0 + 1) * 180 + i0]) * fx;
    return a + (b - a) * fy;
  }

  /** Land fraction smoothed over ~1000 km. */
  broad(lat: number, lon: number): number {
    return this.coarseAt(this.blur, lat, lon);
  }

  /** Cold ocean off a west coast, 0..1. */
  coldOcean(lat: number, lon: number): number {
    return this.coarseAt(this.coast, lat, lon);
  }
}

// --- Weather systems --------------------------------------------------------------------------

type Kind = 'low' | 'high' | 'tc' | 'deck' | 'fog' | 'cu' | 'sc' | 'storm';

interface Sys {
  kind: Kind;
  /** Its position (lat, lon) at time tRef; birth and lifetime (s). */
  tRef: number;
  latRef: number;
  lonRef: number;
  born: number;
  life: number;
  hemi: 1 | -1;
  /** Size, m (lows, highs: the scale of the circulation; tc: of the cloud shield). */
  R: number;
  /** Peak strength 0..1. */
  peak: number;
  /** Steering, m/s: eastward, poleward. */
  u: number;
  v: number;
  /** Tropical cyclone: latitude it recurves at, deg. */
  recurve: number;
  seed: number;
  /** Deck / fog: half-axes in units of R (east, north). */
  ax: number;
  ay: number;
  /** Shape (else from the seed): rotation (rad), east-west stretch, front bend, front length. */
  shape?: [number, number, number, number];
}

interface State {
  s: Sys;
  lat: number;
  lon: number;
  /** Centre (unit, ECEF) and its east / north axes. */
  c: [number, number, number];
  e: [number, number, number];
  n: [number, number, number];
  /** Lifecycle strength 0..1, age fraction, occlusion 0..1. */
  amp: number;
  age: number;
  occl: number;
  /** Cos of the angular radius it can affect. */
  cosReach: number;
  /** Low: the cold front (x, y pairs, units of R) and the triple point. */
  front?: Float32Array;
  /** Noise offsets for this system's irregularity; its rotation (cos, sin) and stretch. */
  ox: number;
  oy: number;
  rc: number;
  rs: number;
  sx: number;
}

const BIN = 6 * 3600;
const MAX_LIFE = 12 * DAY;

/** Unit vector (ECEF) of a latitude / longitude. */
function unit(lat: number, lon: number): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Tropical cyclone basins: [hemisphere, lon from, lon to] (warm enough oceans). */
const TC_BASINS: [1 | -1, number, number][] = [
  [1, -98, -18], // North Atlantic, Gulf, Caribbean
  [1, -150, -88], // Eastern Pacific
  [1, 110, 180], // Western Pacific
  [1, 55, 95], // North Indian
  [-1, 35, 120], // South Indian
  [-1, 140, 190], // Australia, South Pacific
];

export class WeatherModel {
  readonly cfg: WeatherConfig;
  private noise: Noise3;
  private noise2: Noise3;
  private scripted: Sys[] = [];
  /** Random systems near the site around t0 are left out (when weather is asked for there). */
  private keepAway: boolean;
  private stateCache = new Map<number, State[]>();
  private jetPhase: number;

  constructor(cfg: WeatherConfig, private land: Land | null) {
    this.cfg = { ...cfg };
    this.noise = new Noise3(hashInts(cfg.seed, 1));
    this.noise2 = new Noise3(hashInts(cfg.seed, 2));
    this.jetPhase = rng(hashInts(cfg.seed, 3))() * Math.PI * 2;
    this.keepAway = cfg.site !== 'natural';
    this.scripted = this.siteSystems();
  }

  private landFrac(lat: number, lon: number): number {
    return this.land ? this.land.frac(lat, lon) : 0;
  }

  /** Summer (+1) / winter (-1) in this hemisphere. */
  private summer(lat: number): number {
    return (Math.sign(lat || 1) * this.cfg.season) / 23.44;
  }

  /** Storm-track latitude in this hemisphere, deg (abs). */
  private stormTrack(lat: number): number {
    return 47 + 5 * this.summer(lat);
  }

  // --- Systems ----------------------------------------------------------------------------

  /** The systems born in one 6-hour slot (deterministic). */
  private bornIn(k: number): Sys[] {
    const out: Sys[] = [];
    for (const hemi of [1, -1] as const) {
      const sF = (hemi * this.cfg.season) / 23.44;
      // Mid-latitude lows: ~2-3 born a day per hemisphere (more in winter).
      {
        const r = rng(hashInts(this.cfg.seed, k, 11, hemi));
        const rate = (1.35 - 0.3 * sF) * (BIN / DAY);
        const n = Math.floor(rate + r());
        for (let i = 0; i < n; i++) {
          let lon = r() * 360 - 180;
          let lat = hemi * (this.stormTrack(hemi) - 10 + r() * 12);
          // Mostly over the oceans (and off east coasts): try again over land, usually.
          for (let tries = 0; tries < 3 && this.landFrac(lat, lon) > 0.5 && r() < 0.7; tries++) lon = r() * 360 - 180;
          const born = (k + r()) * BIN;
          out.push({
            kind: 'low', tRef: born, latRef: lat, lonRef: lon, born, life: (4.5 + 3 * r()) * DAY, hemi,
            R: (850 + 450 * r()) * 1e3, peak: 0.55 + 0.45 * r(), u: 9 + 6 * r() - 3 * sF, v: 1 + 1.6 * r(), recurve: 0, seed: hashInts(k, i, hemi, 1), ax: 1, ay: 1,
          });
          lat = 0;
        }
      }
      // Migratory highs.
      {
        const r = rng(hashInts(this.cfg.seed, k, 12, hemi));
        const n = Math.floor(1.0 * (BIN / DAY) + r());
        for (let i = 0; i < n; i++) {
          const born = (k + r()) * BIN;
          out.push({
            kind: 'high', tRef: born, latRef: hemi * (27 + 20 * r()), lonRef: r() * 360 - 180, born, life: (5 + 4 * r()) * DAY, hemi,
            R: (1400 + 800 * r()) * 1e3, peak: 0.5 + 0.5 * r(), u: 4 + 5 * r(), v: -0.6 + 1.2 * r(), recurve: 0, seed: hashInts(k, i, hemi, 2), ax: 1, ay: 1,
          });
        }
      }
      // Tropical cyclones: in the summer hemisphere's warm oceans, now and then.
      {
        const r = rng(hashInts(this.cfg.seed, k, 13, hemi));
        const rate = Math.max(0.02, 0.32 * smooth(-0.6, 0.8, sF)) * (BIN / DAY);
        const n = Math.floor(rate + r());
        for (let i = 0; i < n; i++) {
          const basins = TC_BASINS.filter((b) => b[0] === hemi);
          const b = basins[Math.floor(r() * basins.length)];
          const lon = wrapLon(b[1] + (b[2] - b[1]) * r());
          const lat = hemi * (9 + 9 * r());
          if (this.landFrac(lat, lon) > 0.3) continue;
          const born = (k + r()) * BIN;
          out.push({
            kind: 'tc', tRef: born, latRef: lat, lonRef: lon, born, life: (6 + 5 * r()) * DAY, hemi,
            R: (450 + 300 * r()) * 1e3, peak: 0.45 + 0.55 * r(), u: -5.5 + 1.5 * r(), v: 1.2 + 1.2 * r(), recurve: 22 + 10 * r(), seed: hashInts(k, i, hemi, 3), ax: 1, ay: 1,
          });
        }
      }
    }
    return out;
  }

  /** The systems that bring the weather asked for over the site. */
  private siteSystems(): Sys[] {
    const { site, siteLat, siteLon, t0 } = this.cfg;
    const hemi: 1 | -1 = siteLat >= 0 ? 1 : -1;
    const r = rng(hashInts(this.cfg.seed, 99));
    // Place a centre at (dx east, dy north) m from the site.
    const at = (dx: number, dy: number): [number, number] => [siteLat + dy / R_EARTH / DEG, siteLon + dx / (R_EARTH * Math.cos(siteLat * DEG)) / DEG];
    const sys = (o: Partial<Sys> & Pick<Sys, 'kind' | 'R' | 'life'>, age: number, dx: number, dy: number): Sys => {
      const [lat, lon] = at(dx, dy);
      return { tRef: t0, latRef: lat, lonRef: lon, born: t0 - age * o.life, hemi, peak: 1, u: 0, v: 0, recurve: 0, seed: hashInts(this.cfg.seed, 7, o.kind.length), ax: 1, ay: 1, ...o };
    };
    // (Each day its own: how strong, where and which way it's going vary with the seed.)
    switch (site) {
      case 'clear':
        return [sys({ kind: 'high', R: 1900e3, life: 7 * DAY, peak: 1, u: 3, v: 0 }, 0.45, -200e3, 450e3)];
      case 'fair':
        // Blue sky and sun, a few small cumulus: a high's edge holding most of the cloud back,
        // a thin scatter of fair-weather cumulus off the Gulf.
        return [
          sys({ kind: 'high', R: 1500e3, life: 6 * DAY, peak: 0.7 + 0.25 * r(), u: 3, v: 0 }, 0.45, -300e3 + 200e3 * r(), 500e3),
          sys({ kind: 'cu', R: 300e3, life: 1.5 * DAY, peak: 0.25 + 0.2 * r(), u: -2, v: 0.5, ax: 1.4, ay: 1 }, 0.4, 40e3, -20e3),
        ];
      case 'partly':
        // A day of fair-weather cumulus over the coast: a field a few hundred km across, in
        // clusters and streets, drifting inland; the global weather all round it.
        return [sys({ kind: 'cu', R: 320e3, life: 1.5 * DAY, peak: 0.85 + 0.25 * r(), u: -2, v: 0.5, ax: 1.4, ay: 1 }, 0.4, 40e3, -20e3)];
      case 'mostly':
        // Mostly cloudy: a broken deck of stratocumulus and cumulus, lanes of blue between.
        return [sys({ kind: 'sc', R: 380e3, life: 1.5 * DAY, peak: 1, u: -2, v: 0.5, ax: 1.4, ay: 1 }, 0.4, 40e3, -20e3)];
      case 'overcast':
        return [sys({ kind: 'deck', R: 650e3, life: 1.6 * DAY, peak: 1, u: 2.5, v: 0.5, ax: 1.3, ay: 0.75 }, 0.4, -120e3 + 100e3 * r(), 60e3)];
      case 'fog':
        // Sea fog along the coast, offshore: long north-south, a few hundred km.
        return [sys({ kind: 'fog', R: 260e3, life: 1.1 * DAY, peak: 1, u: 1, v: 0.3, ax: 0.75, ay: 1.6 }, 0.35, 60e3, 30e3)];
      case 'storm': {
        // Thunderstorms: a cluster of them coming off the land, drifting toward the coast at
        // 20-30 km/h, in a humid day's towering cumulus: over the site already, more building
        // to the west. (Its cells drift with it: weather/storms.ts puts one coming in over the
        // site.)
        const ang = (r() - 0.5) * 1.2;
        const R = 55e3 + 20e3 * r();
        const d = R * (0.1 + 0.4 * r());
        return [
          sys({ kind: 'storm', R, life: 0.4 * DAY, peak: 0.9 + 0.1 * r(), u: 5.5 + 2.5 * r(), v: 0.5 * (r() - 0.5), ax: 1.3, ay: 1 }, 0.3, -d * Math.cos(ang), d * Math.sin(ang)),
          sys({ kind: 'cu', R: 300e3, life: 1.5 * DAY, peak: 0.6, u: -2, v: 0.5, ax: 1.4, ay: 1 }, 0.4, 40e3, -20e3),
        ];
      }
      case 'rain': {
        // A low to the north whose cold front is crossing the site now.
        const R = 1000e3;
        const age = 0.42;
        const occl = smooth(0.35, 0.85, age);
        const pts = coldFront(occl, 0.5, 1);
        const k = 7; // a point ~45% along the front
        const fx = pts[k * 2], fy = pts[k * 2 + 1];
        return [sys({ kind: 'low', R, life: 6 * DAY, peak: 0.95, u: 9, v: 1.2, shape: [0, 1, 0.5, 1] }, age, -fx * R - 30e3, -fy * R * hemi)];
      }
      default:
        return [];
    }
  }

  /** Position along a track from its reference point to time t (s): [lat, lon, land exposure]. */
  private track(s: Sys, t: number): [number, number, number] {
    let lat = s.latRef;
    let lon = s.lonRef;
    let landT = 0;
    const total = t - s.tRef;
    const steps = Math.max(1, Math.ceil(Math.abs(total) / (3 * 3600)));
    const dt = total / steps;
    for (let i = 0; i < steps; i++) {
      let u = s.u;
      let v = s.v;
      if (s.kind === 'tc') {
        // West with the trades, then poleward and recurving east into the westerlies.
        const rc = smooth(s.recurve - 4, s.recurve + 6, Math.abs(lat));
        u = s.u * (1 - rc) + 9 * rc;
        v = s.v + 3.5 * rc;
        if (dt > 0) landT += this.landFrac(lat, lon) * dt;
      }
      lat += (s.hemi * v * dt) / R_EARTH / DEG;
      lat = Math.max(-85, Math.min(85, lat));
      lon += (u * dt) / (R_EARTH * Math.max(0.1, Math.cos(lat * DEG))) / DEG;
    }
    return [lat, wrapLon(lon), landT];
  }

  /** The systems alive at time t, with where they are and how strong. */
  states(t: number): State[] {
    const key = Math.round(t / 60);
    const hit = this.stateCache.get(key);
    if (hit) return hit;
    const out: State[] = [];
    const { siteLat, siteLon, t0 } = this.cfg;
    const site = unit(siteLat, siteLon);
    const all: Sys[] = [...this.scripted];
    for (let k = Math.floor((t - MAX_LIFE) / BIN); k <= Math.floor(t / BIN); k++) {
      for (const s of this.bornIn(k)) {
        if (t < s.born || t > s.born + s.life) continue;
        if (this.keepAway && s.kind !== 'high' && this.nearSite(s, site, t0)) continue;
        all.push(s);
      }
    }
    for (const s of all) {
      const st = this.stateOf(s, t);
      if (st) out.push(st);
    }
    if (this.stateCache.size > 64) this.stateCache.clear();
    this.stateCache.set(key, out);
    return out;
  }

  /** A system's state at time t (null if it isn't alive or is too weak to matter). */
  private stateOf(s: Sys, t: number): State | null {
    if (t < s.born || t > s.born + s.life) return null;
    const [lat, lon, landT] = this.track(s, t);
    const age = (t - s.born) / s.life;
    let amp: number;
    switch (s.kind) {
      case 'low': amp = smooth(0, 0.3, age) * (1 - smooth(0.75, 1, age)); break;
      case 'high': amp = smooth(0, 0.2, age) * (1 - smooth(0.75, 1, age)); break;
      case 'tc': amp = smooth(0, 0.35, age) * (1 - smooth(0.75, 1, age)) * Math.exp(-landT / (1.2 * DAY)) * (1 - smooth(32, 42, Math.abs(lat))); break;
      default: amp = smooth(0, 0.1, age) * (1 - smooth(0.7, 1, age));
    }
    amp *= s.peak;
    if (amp < 0.01) return null;
    const c = unit(lat, lon);
    const e: [number, number, number] = [-Math.sin(lon * DEG), Math.cos(lon * DEG), 0];
    const n: [number, number, number] = [-Math.sin(lat * DEG) * Math.cos(lon * DEG), -Math.sin(lat * DEG) * Math.sin(lon * DEG), Math.cos(lat * DEG)];
    const occl = s.kind === 'low' ? smooth(0.35, 0.85, age) : 0;
    const reachR = s.kind === 'low' ? 4.2 * s.R : s.kind === 'high' ? 2.5 * s.R : s.kind === 'tc' ? 1.6 * s.R : 2 * Math.max(s.ax, s.ay) * s.R;
    const r = rng(s.seed);
    const ox = r() * 200, oy = r() * 200;
    const [rot, sx, bend, len] = s.shape ?? [(r() - 0.5) * 0.8, 0.85 + 0.55 * r(), r(), 0.8 + 0.55 * r()];
    return {
      s, lat, lon, c, e, n, amp, age, occl,
      cosReach: Math.cos(Math.min(Math.PI / 2, reachR / R_EARTH)),
      front: s.kind === 'low' ? coldFront(occl, bend, len) : undefined,
      ox, oy, rc: Math.cos(rot), rs: Math.sin(rot), sx,
    };
  }

  /** Whether a random system would bring cloud or rain over the site around t0 (-6 h .. +18 h). */
  private nearSite(s: Sys, site: [number, number, number], t0: number): boolean {
    for (const dt of [-6, 0, 6, 12, 18]) {
      const t = t0 + dt * 3600;
      if (t < s.born || t > s.born + s.life) continue;
      const st = this.stateOf(s, t);
      if (!st || site[0] * st.c[0] + site[1] * st.c[1] + site[2] * st.c[2] < st.cosReach) continue;
      const A = this.acc;
      A.w = 0; A.keep = 1; A.high = 1; A.precip = 1; A.fog = 0; A.topMax = 0; A.base = 0; A.top = 0; A.broken = 0; A.cell = 0;
      this.system(st, site, 0, this.add);
      if (1 - A.keep > 0.12 || 1 - A.high > 0.3) return true;
    }
    return false;
  }

  // --- Clouds -----------------------------------------------------------------------------

  /**
   * The weather at (lat, lon) at time t. sun: direction to the sun (ECEF, unit), for the
   * daytime convection over land (omit: no diurnal cycle).
   */
  sample(lat: number, lon: number, t: number, sun?: readonly number[], out: Sample = newSample()): Sample {
    return this.sampleWith(this.states(t), lat, lon, t, sun, out);
  }

  private acc = { w: 0, keep: 1, base: 0, top: 0, broken: 0, cell: 0, high: 1, precip: 1, fog: 0, topMax: 0, conv: 0, mid: 1, midW: 0, midAlt: 0 };
  /** Cumulus cloud base at the point being sampled, m (condensationLevel of its air). */
  private lcl = 900;
  /** A middle layer: cover c at height alt, m (combined like the low clouds' cover). */
  private addMid = (c: number, alt: number): void => {
    if (c <= 0.005) return;
    const A = this.acc;
    A.mid *= 1 - clamp01(c);
    A.midAlt += alt * c;
    A.midW += c;
  };

  /** Add a cloud layer to the accumulator: cover, base, top, broken, cell, rain, high cloud. */
  private add = (c: number, base: number, top: number, broken: number, cell: number, precip = 0, high = 0): void => {
    const A = this.acc;
    if (high > 0) A.high *= 1 - clamp01(high);
    if (c <= 0.003) return;
    c = clamp01(c);
    A.keep *= 1 - c;
    const w = c * c;
    A.w += w;
    A.base += base * w;
    A.top += top * w;
    A.broken += broken * w;
    A.cell += cell * w;
    if (top > A.topMax) A.topMax = top * Math.min(1, c * 2.5) + A.topMax * (1 - Math.min(1, c * 2.5));
    if (precip > 0) A.precip *= 1 - clamp01(precip);
  };

  private sampleWith(states: State[], lat: number, lon: number, t: number, sun: readonly number[] | undefined, out: Sample): Sample {
    const A = this.acc;
    A.w = 0; A.keep = 1; A.base = 0; A.top = 0; A.broken = 0; A.cell = 0; A.high = 1; A.precip = 1; A.fog = 0; A.topMax = 0; A.conv = 0; A.mid = 1; A.midW = 0; A.midAlt = 0;
    const add = this.add;

    const n = unit(lat, lon);
    const L = this.landFrac(lat, lon);
    const al = Math.abs(lat);
    const sF = this.summer(lat);
    const season = this.cfg.season;
    const broadL = this.land ? this.land.broad(lat, lon) : 0;

    // Suppression of the background clouds: by highs, inside lows (their own clouds replace it).
    let supp = 0;
    const sys: State[] = [];
    for (const st of states) {
      if (n[0] * st.c[0] + n[1] * st.c[1] + n[2] * st.c[2] < st.cosReach) continue;
      sys.push(st);
      if (st.s.kind === 'high') {
        this.local(st, n);
        const r = Math.hypot(this.lx, this.ly);
        supp = 1 - (1 - supp) * (1 - 0.9 * st.amp * Math.exp(-(r * r) / 0.9));
      }
    }

    // --- Climate ---
    // Daytime heating over land: afternoon peak (local solar time).
    let diur = 0.35;
    if (sun) {
      const sLon = Math.atan2(sun[1], sun[0]) / DEG;
      let hour = 12 + (wrapLon(lon - sLon)) / 15;
      hour = ((hour % 24) + 24) % 24;
      const dh = Math.min(Math.abs(hour - 15.5), 24 - Math.abs(hour - 15.5));
      const sinE = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
      diur = Math.exp(-(dh * dh) / 14) * smooth(-0.1, 0.5, sinE + 0.3) ;
    }
    // Noise slices: features that grow and die over ~half a day, drifting with the flow.
    const conv = this.evolving(n, lat, t, 10, 4, 9 * 3600, this.noise);
    const clim = this.evolving(n, lat, t, 5.5, 2, 30 * 3600, this.noise2);
    const vary = 0.75 + 0.5 * (0.5 + 0.5 * clim);
    // Mesoscale organization (~300-800 km): the background clouds gather into clusters, streets
    // and decks with clear water between, not an even film (from orbit an even film reads as a
    // grey veil). About the same cover on average, much more contrast.
    const org = this.evolving(n, lat, t, 13, 2, 14 * 3600, this.noise2);
    const clump = 0.3 + 1.4 * smooth(-0.65, 0.65, org + 0.3 * clim);

    const itczLat = 5 + 0.35 * season + 0.55 * season * broadL;
    const itcz = Math.exp(-(((lat - itczLat) / 6.5) ** 2));
    const tropLand = L * Math.exp(-(((lat - 0.55 * season) / 15) ** 2)) * (0.45 + 0.75 * diur);
    const midLand = L * smooth(-0.2, 0.6, sF) * Math.exp(-(((al - 40) / 11) ** 2)) * diur;
    const desert = (L * 0.6 + broadL * 0.4) * Math.exp(-(((al - 24 - 0.25 * season * Math.sign(lat || 1)) / 8.5) ** 2));
    const subHigh = Math.exp(-(((al - 29 - 0.2 * season * Math.sign(lat || 1)) / 9) ** 2)) * (1 - broadL);
    const keepClim = (1 - supp) * (1 - 0.88 * desert);

    // How dry the air is (dew-point spread, deg C), which sets how high cumulus form: muggy
    // over the sea and in the tropics, drier over land, much drier over deserts, varying from
    // day to day with the weather; near the site, the day's weather asked for.
    const dryN = this.evolving(n, lat, t, 4, 2, 40 * 3600, this.noise);
    let spread = (1 - L) * 4 + L * 7 + 12 * desert - 2 * itcz + 4 * dryN;
    const siteN = unit(this.cfg.siteLat, this.cfg.siteLon);
    const siteAng = Math.acos(Math.min(1, n[0] * siteN[0] + n[1] * siteN[1] + n[2] * siteN[2])) / DEG;
    const siteK = this.cfg.site === 'natural' ? 0 : Math.exp(-((siteAng / 6) ** 2)) * Math.exp(-(((t - this.cfg.t0) / (1.5 * DAY)) ** 2));
    const siteAir = this.cfg.site === 'natural' ? null : SITE_AIR[this.cfg.site];
    if (siteAir) spread += (siteAir.spread - spread) * siteK;
    this.lcl = condensationLevel(Math.max(1.5, spread));
    const lcl = this.lcl;
    // A cumulus layer's base and top for this air: from its condensation level, the top shifted
    // with it (the same depth of cloud).
    const cuBase = lcl;
    const cuTop = (top: number, base0: number) => top + (lcl - base0);

    // A middle layer: altocumulus / altostratus here and there in the mid-latitudes and the
    // tropics' moist air, at 2.5 to 6 km.
    const midN = this.evolving(n, lat, t, 7, 2, 20 * 3600, this.noise2);
    const midAltN = this.evolving(n, lat, t, 3, 1, 30 * 3600, this.noise);
    const midBand = Math.exp(-(((al - 40) / 18) ** 2)) + 0.5 * itcz;
    let midC = smooth(0.15, 0.75, midN) * midBand * 0.55 * (1 - supp) * (1 - 0.8 * desert);
    if (siteAir) midC += (siteAir.mid - midC) * siteK;
    this.addMid(midC, 2500 + 3500 * (0.5 + 0.5 * midAltN));

    // Deep convection: clusters and lines of thunderstorms (ITCZ, tropical land, summer land).
    const convPot = clamp01(itcz * (1 - 0.6 * L) + tropLand + 0.8 * midLand) * (1 - 0.6 * subHigh);
    if (convPot > 0.02) {
      // (Ragged: each cluster several cells, not one smooth blob.)
      const cv = conv + 0.22 * org;
      const deep = convPot * smooth(0.36 - 0.25 * convPot, 0.78 - 0.25 * convPot, cv);
      // Anvils: the storms' tops spread out far around the cores, thinning away from them.
      const anvil = convPot * smooth(0.02 - 0.25 * convPot, 0.55 - 0.25 * convPot, cv);
      add(deep * 1.3 * keepClim, 0.85 * cuBase, 9000 + 6500 * smooth(0.1, 0.8, deep) * (1 - 0.25 * smooth(25, 40, al)), 0.35, 0.65, deep * 0.9, anvil * keepClim);
      A.conv = Math.max(A.conv, smooth(0.05, 0.4, deep * keepClim));
      add(0.3 * convPot * (0.5 + 0.5 * clump) * keepClim, cuBase, cuTop(2200, 700), 0.92, 0.12);
    }
    // Trade cumulus over the subtropical / tropical oceans.
    const trade = (1 - L) * Math.exp(-(((al - 16) / 12) ** 2));
    if (trade > 0.02) add(trade * (0.12 + 0.16 * smooth(-0.3, 0.6, conv)) * vary * clump * keepClim, cuBase, cuTop(1500 + 900 * (0.5 + 0.5 * clim), 600), 0.9, 0.18);
    // Stratocumulus decks over cold oceans off west coasts (the subtropical highs' east flanks).
    if (this.land) {
      const msc = this.land.coldOcean(lat, lon) * Math.exp(-(((al - 24 - 0.3 * season * Math.sign(lat || 1)) / 10) ** 2));
      if (msc > 0.02) add(Math.min(1, msc * 1.6) * (0.9 + 0.1 * clim) * (0.7 + 0.3 * clump) * (1 - 0.5 * supp), 450, 1300, 0.18, 0.55, 0.02);
    }
    // The storm-track oceans and the Southern Ocean: low cloud most of the time.
    const stormOcean = (1 - L) * Math.exp(-(((al - 55) / 12) ** 2)) * (lat < 0 ? 1.15 : 1);
    if (stormOcean > 0.02) add(stormOcean * 0.5 * smooth(-0.45, 0.45, clim) * (0.4 + 0.6 * clump) * (1 - supp), 700, 2000 + 600 * clim, 0.5, 0.75, 0.05);
    // Fair-weather cumulus over land by day (not deserts).
    const fair = L * diur * (1 - smooth(55, 70, al)) * 0.45;
    if (fair > 0.02) add(fair * vary * clump * keepClim, cuBase, cuTop(2400, 900), 0.95, 0.08);
    // Mid / high-latitude land: grey stratus decks, more in winter.
    const greyLand = L * Math.exp(-(((al - 55) / 12) ** 2)) * (0.18 - 0.1 * sF) * smooth(0, 0.5, clim);
    if (greyLand > 0.02) add(greyLand * vary * (0.4 + 0.6 * clump) * (1 - supp), 500, 1800, 0.35, 0.45);
    // Polar: Arctic stratus; Antarctic plateau clear.
    const polar = Math.exp(-(((al - 78) / 9) ** 2)) * (lat < -70 && L > 0.5 ? 0.25 : 1) * 0.45;
    if (polar > 0.02) add(polar * vary * (0.5 + 0.5 * clump) * (1 - supp), 300, 1300, 0.25, 0.4);
    // Cirrus: jet-stream cirrus in the mid-latitudes, here and there.
    const jetCi = Math.exp(-(((al - 40 + 4 * sF) / 10) ** 2)) * smooth(0.2, 0.7, clim) * 0.45 * (1 - supp);
    if (jetCi > 0.01) add(0, 0, 0, 0, 0, 0, jetCi);
    // (Its height: near the tropopause, higher in the tropics.)
    out.ciAlt = 12500 - 3500 * smooth(15, 60, al) + 900 * midAltN;

    // --- Systems ---
    for (const st of sys) this.system(st, n, L, add);

    const cover = 1 - A.keep;
    out.cover = cover;
    out.mid = 1 - A.mid;
    out.midAlt = A.midW > 0 ? A.midAlt / A.midW : 4000;
    if (A.w > 0) {
      out.base = A.base / A.w;
      out.top = Math.max(out.base + 300, Math.max(A.top / A.w, A.topMax * 0.9));
      out.broken = A.broken / A.w;
      out.cell = A.cell / A.w;
    } else {
      out.base = 1000;
      out.top = 2000;
      out.broken = 0.8;
      out.cell = 0.2;
    }
    out.high = 1 - A.high;
    out.precip = 1 - A.precip;
    out.fog = A.fog;
    out.conv = A.conv;
    return out;
  }

  /**
   * Noise that evolves: two time slices (features grow and fade over `period`), each drifting
   * with the climatological flow (trades west, mid-latitudes east) from its own start, so
   * features move without being sheared out.
   */
  private evolving(n: [number, number, number], lat: number, t: number, scale: number, oct: number, period: number, nz: Noise3): number {
    const k = Math.floor(t / period);
    const f = t / period - k;
    const al = Math.abs(lat);
    const u = -6 * Math.exp(-(((al - 14) / 12) ** 2)) + 11 * Math.exp(-(((al - 47) / 14) ** 2));
    const rate = u / (R_EARTH * Math.max(0.15, Math.cos(lat * DEG)));
    let s = 0;
    for (let j = 0; j < 2; j++) {
      const kk = k - j;
      const w = j === 0 ? f : 1 - f;
      const fw = Math.sin(w * Math.PI * 0.5);
      if (fw < 1e-3) continue;
      const ang = -rate * (t - kk * period);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const x = n[0] * ca - n[1] * sa;
      const y = n[0] * sa + n[1] * ca;
      const o = (kk * 37.17) % 200;
      s += fw * nz.fbm(x * scale + o, y * scale + o * 0.7, n[2] * scale + o * 1.3, oct);
    }
    // (The two weights' squares sum to ~1: keep the spread.)
    return s * 1.6;
  }

  /** A point in a system's local frame: units of R; Y poleward (mirrored in the south). */
  private lx = 0;
  private ly = 0;
  private local(st: State, n: readonly number[]): void {
    const k = R_EARTH / st.s.R;
    this.lx = (n[0] * st.e[0] + n[1] * st.e[1] + n[2] * st.e[2]) * k;
    this.ly = st.s.hemi * (n[0] * st.n[0] + n[1] * st.n[1] + n[2] * st.n[2]) * k;
  }

  private system(st: State, n: readonly number[], L: number, add: (c: number, base: number, top: number, broken: number, cell: number, precip?: number, high?: number) => void): void {
    this.local(st, n);
    const X0 = this.lx, Y0 = this.ly;
    // (Nothing this far out.)
    const r0 = Math.hypot(X0, Y0);
    const kind = st.s.kind;
    if (kind === 'low' ? r0 > 4.1 : kind === 'tc' ? r0 > 1.05 : r0 > 2.1 * Math.max(st.s.ax, st.s.ay)) return;
    const nz = this.noise2;
    // Each system its own shape: the frame warped a little.
    const wx = 0.16 * nz.get(X0 * 1.3 + st.ox, Y0 * 1.3, st.oy);
    const wy = 0.16 * nz.get(X0 * 1.3, Y0 * 1.3 + st.oy, st.ox);
    // (Turned and stretched: no two alike.)
    const X = ((X0 + wx) * st.rc + (Y0 + wy) * st.rs) / st.sx;
    const Y = -(X0 + wx) * st.rs + (Y0 + wy) * st.rc;
    const r = Math.hypot(X, Y);
    const a = st.amp;
    // Texture within the cloud masses (bands and streaks a few hundred km across).
    const tex = 0.82 + 0.36 * (0.5 + 0.5 * nz.fbm(X * 3.2 + st.oy, Y * 3.2 + st.ox, 5.5, 2));
    switch (st.s.kind) {
      case 'low': {
        const oc = st.occl;
        const f = st.front as Float32Array;
        const tx = f[0], ty = f[1];
        // Comma head: a spiral filled toward the centre, wrapping further as it occludes.
        const th = Math.atan2(Y, X);
        const tp = (((th + 0.35) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const thMax = 3.2 + 1.5 * oc;
        const rs = 0.9 * Math.exp(-0.2 * tp);
        const head = smooth(rs + 0.14, rs - 0.1, r) * smooth(thMax + 0.2, thMax - 0.45, tp) + smooth(0.16, 0.05, r) * 0.8;
        // Warm front: from the triple point east-southeast; the cloud shield poleward of it.
        const yW = ty - 0.22 * (X - tx);
        const shield = smooth(yW - 0.06, yW + 0.2, Y) * smooth(1.2, 0.7, Y - 0.15 * X) * smooth(2.5 + 0.3 * a, 1.6, X) * smooth(-0.15, 0.3, X);
        const nearWarm = Math.exp(-(((Y - yW) / 0.35) ** 2));
        // Cold front: distance to the polyline, which side, and how far along.
        let best = 1e9, side = 1, along = 0;
        for (let i = 0; i + 3 < f.length; i += 2) {
          const ax = f[i], ay = f[i + 1], bx = f[i + 2], by = f[i + 3];
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const u = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / l2));
          const px = ax + dx * u - X, py = ay + dy * u - Y;
          const d2 = px * px + py * py;
          if (d2 < best) {
            best = d2;
            side = dx * (Y - ay) - dy * (X - ax) > 0 ? 1 : -1;
            along = (i / 2 + u) / (f.length / 2 - 1);
          }
        }
        const d = Math.sqrt(best);
        const width = 0.22 * (1 - 0.45 * along);
        const ahead = side > 0;
        const band = (ahead ? Math.exp(-((d / width) ** 2)) : Math.exp(-((d / 0.05) ** 2))) * smooth(1, 0.82, along);
        // The dry slot: behind the cold front, round to the south-west of the centre.
        const behind = !ahead;
        const dry = behind ? smooth(1.6, 0.9, r) * (1 - head) : 0;
        // Warm sector: ahead of the cold front, south of the warm front.
        const warmSec = ahead && Y < yW ? smooth(2.6, 1.8, r) * smooth(3.9, 3.0, r0) * smooth(0.1, 0.35, d) : 0;
        // Cold air behind the front, over the ocean: open-cell cumulus.
        const coldSec = behind ? smooth(0.15, 0.45, d) * smooth(3.3, 2.3, r) * smooth(3.9, 3.0, r0) * smooth(0.6, 1.2, r) * (1 - 0.75 * L) : 0;
        add(head * 0.97 * a * tex, 650, 7500 - 2500 * smooth(0, thMax, tp), 0.12, 0.5, head * 0.55 * a, head * 0.6 * a);
        add(shield * 0.95 * a * tex, 700 + 1200 * (1 - nearWarm), 4500 + 4000 * nearWarm, 0.1, 0.4, shield * nearWarm * 0.6 * a, shield * 0.85 * a);
        // (Cirrus well ahead of the warm front.)
        const ahead2 = smooth(-0.1, 0.4, X) * smooth(3.0, 2.0, X) * smooth(yW - 0.2, yW + 0.3, Y) * smooth(1.8, 1.0, Y);
        add(0, 0, 0, 0, 0, 0, ahead2 * 0.7 * a);
        add(band * 0.97 * a * tex, 700, 8500 + 2500 * (1 - along), 0.3, 0.55, band * 0.75 * a * (1 - 0.5 * along), band * 0.7 * a);
        add(warmSec * 0.45 * a * tex, this.lcl, 1800 + (this.lcl - 600), 0.55, 0.4);
        add(coldSec * 0.6 * a, this.lcl, 2600 + (this.lcl - 850), 0.62, 1.0);
        // (The warm front's cloud shield: a middle deck, altostratus, ahead of it.)
        this.addMid(shield * 0.8 * a, 3500 + 2000 * (1 - nearWarm));
        void dry;
        break;
      }
      case 'tc': {
        const rk = r * st.s.R / 1e3; // km
        const eye = 14 + 18 * (st.ox / 200);
        const cdo = (110 + 90 * a) * (0.85 + 0.3 * (st.oy / 200));
        const th = Math.atan2(Y0, X0) * st.s.hemi;
        const spiral = Math.pow(0.5 + 0.5 * Math.cos(2 * th + 3.2 * Math.log(rk / cdo + 0.05) * 1), 3);
        const org = smooth(0.2, 0.6, a);
        const core = smooth(cdo * 1.25, cdo * 0.75, rk) * (1 - smooth(eye * 1.3, eye * 0.6, rk) * org);
        const bands = spiral * smooth(cdo * 0.8, cdo * 1.2, rk) * smooth(st.s.R / 1e3, cdo * 1.5, rk);
        add(core * a * 1.15, 500, 15000, 0.12, 0.6, core * a, core * a * 1.1);
        add(bands * a * tex, 600, 11000, 0.35, 0.5, bands * 0.6 * a, bands * 0.4 * a);
        // The outflow cirrus canopy.
        add(0, 0, 0, 0, 0, 0, smooth(cdo * 3.2, cdo * 1.2, rk) * 0.5 * a * org);
        break;
      }
      case 'deck': {
        const rho = Math.hypot(X / st.s.ax, Y / st.s.ay);
        const c = smooth(1, 0.7, rho) * a;
        add(c * (0.96 + 0.04 * tex), 350, 1500, 0.05, 0.4, c * 0.06);
        break;
      }
      case 'cu': {
        const rho = Math.hypot(X / st.s.ax, Y / st.s.ay) + 0.35 * (tex - 1);
        // Streets along the wind and clusters, clear lanes between (away from the middle).
        const streets = 0.5 + 0.5 * nz.fbm(X * 2.2 + st.ox, Y * 7 + st.oy, 3.3, 2);
        const patchy = 1 - smooth(0.2, 0.55, rho) * (1 - smooth(0.32, 0.62, streets));
        const c = smooth(1, 0.5, rho) * patchy * a;
        add(c * 0.5, this.lcl, 2300 + (this.lcl - 800), 0.92, 0.12);
        break;
      }
      case 'sc': {
        // A broken deck: lumpy stratocumulus and cumulus covering most of the sky, in rolls
        // along the wind with lanes of blue between.
        const rho = Math.hypot(X / st.s.ax, Y / st.s.ay) + 0.25 * (tex - 1);
        const lanes = 0.5 + 0.5 * nz.fbm(X * 2.6 + st.ox, Y * 6 + st.oy, 4.1, 2);
        const c = smooth(1, 0.55, rho) * (0.62 + 0.38 * smooth(0.3, 0.6, lanes)) * a;
        add(c * 0.9, this.lcl, this.lcl + 1300, 0.55, 0.22);
        break;
      }
      case 'storm': {
        // A cluster of thunderstorms: a few cumulonimbus cores (heavy rain, tops up to the
        // tropopause), their anvils spread downwind, towering cumulus round them.
        // (The map holds where the storms are, how high, where it rains; the renderer builds
        // the towers and the anvil spread over them, at the tropopause, from that.)
        const rho = Math.hypot(X / st.s.ax, Y / st.s.ay);
        const cells = 0.5 + 0.5 * nz.fbm(X * 3 + st.ox, Y * 3 + st.oy, 7.7, 2);
        const area = smooth(1.25, 0.55, rho) * a;
        const core = smooth(1, 0.35, rho) * smooth(0.38, 0.62, cells) * a;
        // (Rain: where the cells are, which the renderer and the weather where the camera is work
        // out from conv; this, the share of the area under them.)
        add(area, this.lcl, 11500 + 3000 * smooth(0.45, 0.8, cells), 0.4, 0.6, Math.max(core, 0.45 * area), area * 0.35);
        this.acc.conv = Math.max(this.acc.conv, area);
        add(smooth(1.6, 0.8, rho) * 0.35 * a, this.lcl, 3200 + (this.lcl - 900), 0.9, 0.15);
        break;
      }
      case 'fog': {
        const rho = Math.hypot(X / st.s.ax, Y / st.s.ay);
        const c = smooth(1, 0.65, rho) * a;
        add(c, 20, 260, 0.02, 0.3);
        this.acc.fog = Math.max(this.acc.fog, c);
        break;
      }
      default:
        break;
    }
  }

  // --- Pressure and wind ------------------------------------------------------------------

  /** Sea-level pressure anomaly, Pa. */
  private pressure(states: State[], lat: number, lon: number): number {
    const al = Math.abs(lat);
    const season = this.cfg.season;
    const sF = this.summer(lat);
    const hs = Math.sign(lat || 1);
    const broadL = this.land ? this.land.broad(lat, lon) : 0;
    const itczLat = 5 + 0.35 * season + 0.55 * season * broadL;
    let p =
      -400 * Math.exp(-(((lat - itczLat) / 9) ** 2)) +
      900 * Math.exp(-(((al - 32 - 0.2 * season * hs) / 9) ** 2)) * (0.45 + 0.55 * (1 - broadL)) -
      500 * broadL * smooth(0, 1, sF) * Math.exp(-(((al - 30) / 12) ** 2)) -
      (lat < 0 ? 1400 : 1000) * Math.exp(-(((al - 62) / 9) ** 2)) +
      400 * Math.exp(-(((al - 88) / 6) ** 2));
    const n = unit(lat, lon);
    for (const st of states) {
      const k = st.s.kind;
      if (k !== 'low' && k !== 'high') continue;
      const dot = n[0] * st.c[0] + n[1] * st.c[1] + n[2] * st.c[2];
      if (dot < st.cosReach) continue;
      const r = (Math.acos(Math.min(1, dot)) * R_EARTH) / st.s.R;
      if (k === 'low') p -= 3000 * st.amp / (1 + (r / 0.75) ** 2) * smooth(4.2, 3.2, r);
      else p += 1600 * st.amp * Math.exp(-r * r);
    }
    return p;
  }

  /** Large-scale wind near the top of the boundary layer (geostrophic, blended to the trades
   *  near the equator) at (lat, lon), m/s east, north. */
  private gradientWind(states: State[], lat: number, lon: number): [number, number] {
    const dd = 0.45; // deg (~50 km)
    const cl = Math.max(0.05, Math.cos(lat * DEG));
    const dpdx = (this.pressure(states, lat, lon + dd / cl) - this.pressure(states, lat, lon - dd / cl)) / (2 * dd * DEG * R_EARTH);
    const dpdy = (this.pressure(states, lat + dd, lon) - this.pressure(states, lat - dd, lon)) / (2 * dd * DEG * R_EARTH);
    const al = Math.abs(lat);
    const sgn = lat >= 0 ? 1 : -1;
    const f = 2 * OMEGA * Math.sin(Math.max(12, al) * DEG) * sgn;
    const rho = 1.2;
    let ug = -dpdy / (rho * f);
    let vg = dpdx / (rho * f);
    const sp = Math.hypot(ug, vg);
    if (sp > 40) {
      ug *= 40 / sp;
      vg *= 40 / sp;
    }
    // Tropics: the trades (north-easterly / south-easterly, into the ITCZ).
    const gw = smooth(9, 20, al);
    const season = this.cfg.season;
    const itczLat = 5 + 0.35 * season;
    const tr = Math.exp(-(((al - 13) / 10) ** 2));
    const ut = -7 * tr;
    const vt = (lat > itczLat ? -2.5 : 2.5) * tr;
    return [ug * gw + ut * (1 - gw), vg * gw + vt * (1 - gw)];
  }

  /** Jet streams and the stratosphere's winds: m/s east, north at height h. */
  private jets(lat: number, lon: number, h: number, t: number): [number, number] {
    const al = Math.abs(lat);
    const sF = this.summer(lat);
    const tropo = 16000 - 5000 * smooth(20, 55, al);
    const shape = h < tropo ? (h / tropo) ** 1.4 : Math.exp(-(((h - tropo) / 5500) ** 2));
    // Subtropical jet (strong in winter) and the meandering polar-front jet.
    const stj = (32 - 14 * sF) * Math.exp(-(((al - 29 - 2 * sF) / 6) ** 2));
    const k = 5;
    const ph = k * lon * DEG - (2 * Math.PI * t) / (7 * DAY) + this.jetPhase;
    const pjLat = this.stormTrack(lat) + 7 * Math.sin(ph);
    const pj = (30 - 9 * sF) * Math.exp(-(((al - pjLat) / 7) ** 2));
    // Meander: the polar jet's direction follows its wave.
    const slope = (7 * k * Math.cos(ph) * DEG) / Math.max(0.2, Math.cos(lat * DEG)) / DEG / (180 / Math.PI);
    let u = (stj + pj) * shape;
    let v = pj * shape * Math.max(-0.6, Math.min(0.6, slope)) * (lat >= 0 ? 1 : -1);
    // Upper tropics: weak easterlies.
    u += -8 * Math.exp(-(((al - 5) / 12) ** 2)) * smooth(8000, 14000, h) * (1 - smooth(20000, 26000, h));
    // Stratosphere: winter westerlies (polar vortex), summer easterlies.
    const strat = smooth(18000, 30000, h) * (1 - smooth(60000, 75000, h)) * Math.exp(-(((al - 60) / 22) ** 2));
    u += strat * (sF > 0 ? -18 * sF : 45 * -sF);
    return [u, v];
  }

  /** Tropical cyclones' own winds at (lat, lon, h): m/s east, north. */
  private cycloneWinds(states: State[], n: readonly number[], h: number): [number, number] {
    let ue = 0, vn = 0;
    for (const st of states) {
      if (st.s.kind !== 'tc') continue;
      const dot = n[0] * st.c[0] + n[1] * st.c[1] + n[2] * st.c[2];
      if (dot < st.cosReach) continue;
      const x = (n[0] * st.e[0] + n[1] * st.e[1] + n[2] * st.e[2]) * R_EARTH;
      const y = (n[0] * st.n[0] + n[1] * st.n[1] + n[2] * st.n[2]) * R_EARTH;
      const r = Math.hypot(x, y);
      if (r < 1) continue;
      const vmax = (25 + 45 * st.s.peak) * st.amp / st.s.peak * smooth(0, 0.6, st.amp) ;
      const rm = 30e3 + 25e3 * (st.ox / 200);
      const v = r < rm ? vmax * (r / rm) : vmax * (rm / r) ** 0.55;
      const fall = 1 - smooth(9000, 15000, h);
      // Cyclonic (anticlockwise in the north), spiralling in near the ground.
      const inflow = 20 * DEG * (1 - smooth(500, 1500, h));
      const tx = -y / r, ty = x / r;
      const s = st.s.hemi;
      const ct = Math.cos(inflow), sn = Math.sin(inflow);
      const dx = s * tx * ct - (x / r) * sn;
      const dy = s * ty * ct - (y / r) * sn;
      ue += dx * v * fall;
      vn += dy * v * fall;
    }
    return [ue, vn];
  }

  private windCache = new Map<string, [number, number]>();

  /**
   * The wind at (lat, lon) and height h (m above the ground), time t: m/s east, north, up.
   * gusts: add turbulence near the ground (deterministic in place and time).
   */
  wind(lat: number, lon: number, h: number, t: number, gusts = true): [number, number, number] {
    const states = this.states(t);
    // (The large-scale field is smooth: cached on ~5 km / 5 min cells.)
    const key = `${Math.round(lat * 20)},${Math.round(lon * 20)},${Math.round(t / 300)}`;
    let g = this.windCache.get(key);
    if (!g) {
      g = this.gradientWind(states, lat, lon);
      if (this.windCache.size > 4000) this.windCache.clear();
      this.windCache.set(key, g);
    }
    const L = this.landFrac(lat, lon);
    const al = Math.abs(lat);
    let [ug, vg] = g;
    // Friction: weaker and turned toward low pressure near the ground.
    const z0 = 0.0002 + L * 0.1;
    const zz = Math.max(2, h);
    const bl = 1000;
    const ang = (20 + 15 * L) * DEG * (lat >= 0 ? 1 : -1) * (1 - smooth(100, bl, h));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ur = ug * ca - vg * sa;
    const vr = ug * sa + vg * ca;
    const surf = (0.72 - 0.22 * L) * Math.log(Math.min(zz, 100) / z0) / Math.log(10 / z0);
    const k = h < 100 ? surf : surf + (1 - surf) * smooth(100, bl, h);
    // Large-scale systems are stronger aloft.
    const aloft = 1 + 0.5 * smooth(bl, 9000, h) * smooth(20, 35, al) - smooth(14000, 22000, h);
    let ue = ur * k * Math.max(0, aloft);
    let vn = vr * k * Math.max(0, aloft);
    const [uj, vj] = this.jets(lat, lon, h, t);
    ue += uj;
    vn += vj;
    const [uc, vc] = this.cycloneWinds(states, unit(lat, lon), h);
    ue += uc;
    vn += vc;
    // Fades out above the mesosphere (the air there is too thin to matter).
    const top = 1 - smooth(80000, 100000, h);
    ue *= top;
    vn *= top;
    let wu = 0;
    if (gusts && h < 2500) {
      const sp = Math.hypot(ue, vn);
      const lvl = (0.14 + 0.1 * L) * sp * (1 - smooth(300, 2500, h));
      const x = (lon * DEG * R_EARTH * Math.cos(lat * DEG)) / 300;
      const y = (lat * DEG * R_EARTH) / 300;
      const tt = t / 6;
      ue += lvl * 1.6 * this.noise.fbm(x + tt * 0.5, y, tt, 3);
      vn += lvl * 1.6 * this.noise.fbm(x, y + tt * 0.5, tt + 50, 3);
      wu = lvl * 0.6 * this.noise.fbm(x + 30, y + 30, tt + 90, 2);
    }
    return [ue, vn, wu];
  }

  // --- Bake ---------------------------------------------------------------------------------

  /**
   * The weather map for the renderer: two RGBA8 equirectangular images, W x H, row 0 at the
   * south pole, column 0 at 180 W.
   *   a: cover, top (0..16 km), base (0..4 km), broken
   *   b: high cloud, precip, fog, cell size
   *   c: deep convection (thunderstorms), middle-layer cover, its height (2..8 km), cirrus
   *      height (6..14 km)
   */
  bake(t: number, sun: readonly number[] | undefined, W: number, H: number, a: Uint8Array, b: Uint8Array, j0 = 0, j1 = H, c?: Uint8Array): void {
    const states = this.states(t);
    const s = newSample();
    for (let j = j0; j < j1; j++) {
      const lat = -90 + ((j + 0.5) * 180) / H;
      // Only the systems that reach this row.
      const cl = Math.cos(lat * DEG), sl = Math.sin(lat * DEG);
      const rowStates = states.filter((st) => {
        // Max over longitude of dot(n, c) = cos(lat - latc).
        return cl * Math.cos(st.lat * DEG) + sl * Math.sin(st.lat * DEG) >= st.cosReach;
      });
      for (let i = 0; i < W; i++) {
        const lon = -180 + ((i + 0.5) * 360) / W;
        this.sampleWith(rowStates, lat, lon, t, sun, s);
        const o = ((j - j0) * W + i) * 4;
        a[o] = Math.round(clamp01(s.cover) * 255);
        a[o + 1] = Math.round(clamp01(s.top / 16000) * 255);
        a[o + 2] = Math.round(clamp01(s.base / 4000) * 255);
        a[o + 3] = Math.round(clamp01(s.broken) * 255);
        b[o] = Math.round(clamp01(s.high) * 255);
        b[o + 1] = Math.round(clamp01(s.precip) * 255);
        b[o + 2] = Math.round(clamp01(s.fog) * 255);
        b[o + 3] = Math.round(clamp01(s.cell) * 255);
        if (c) {
          c[o] = Math.round(clamp01(s.conv) * 255);
          c[o + 1] = Math.round(clamp01(s.mid) * 255);
          c[o + 2] = Math.round(clamp01((s.midAlt - 2000) / 6000) * 255);
          c[o + 3] = Math.round(clamp01((s.ciAlt - 6000) / 8000) * 255);
        }
      }
    }
  }
}

/** A low's cold front: from the triple point, curving toward the tropics and west (units of R,
 *  Y poleward); 16 points. The first point is the triple point. */
function coldFront(occl: number, bend: number, len: number): Float32Array {
  const tx = 0.6 + 0.35 * occl, ty = -0.2 - 0.25 * occl;
  const p1x = tx - 0.1 - 0.3 * bend, p1y = ty - 1.15 * len;
  const p2x = tx - (1.0 + 1.1 * bend) * len, p2y = ty - 2.3 * len;
  const N = 16;
  const out = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);
    const a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
    out[i * 2] = a * tx + b * p1x + c * p2x;
    out[i * 2 + 1] = a * ty + b * p1y + c * p2y;
  }
  return out;
}

/**
 * Fair flying weather for a mission: the first seed from `seed` on whose wind over the site stays
 * light (under maxWind at the catch tower's top, gusts aside) from t0 through the next `hours`,
 * so a mission is never called off for weather. Falls back to the calmest seed tried.
 */
export function calmSeed(cfg: WeatherConfig, land: Land | null, maxWind = 7, hours = 2.5, tries = 40): number {
  let best = cfg.seed;
  let bestWind = Infinity;
  for (let k = 0; k < tries; k++) {
    const seed = (cfg.seed + k * 7919) % 2 ** 31;
    const m = new WeatherModel({ ...cfg, seed }, land);
    let worst = 0;
    for (let t = 0; t <= hours * 3600 && worst < bestWind; t += 600) {
      const w = m.wind(cfg.siteLat, cfg.siteLon, 150, cfg.t0 + t, false);
      worst = Math.max(worst, Math.hypot(w[0], w[1]));
    }
    if (worst < bestWind) {
      best = seed;
      bestWind = worst;
    }
    if (worst < maxWind) break;
  }
  return best;
}
