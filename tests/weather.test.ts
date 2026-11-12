import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Land, type SiteWeather, WeatherModel, starbaseDay } from '../src/weather/model';
import { STORM_GRID, stormCells, stormFace, stormFaceDir } from '../src/weather/storms';

const land = new Land(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../public/data/landmask.bin'))));
const SITE = { lat: 25.99613, lon: -97.15442 };
const model = (seed: number, site: SiteWeather = 'natural') =>
  new WeatherModel({ seed, season: -1.7, site, siteLat: SITE.lat, siteLon: SITE.lon, t0: 0 }, land);

describe('global weather model', () => {
  it('is the same for the same seed, different for another', () => {
    const a = model(7).sample(40, -30, 3600);
    const b = model(7).sample(40, -30, 3600);
    expect(a).toEqual(b);
    const covers = [1, 2, 3, 4, 5].map((s) => model(s).sample(40, -30, 3600).cover.toFixed(3));
    expect(new Set(covers).size).toBeGreaterThan(2);
  });

  it('brings the weather asked for over Starbase', () => {
    for (const seed of [1, 2, 3]) {
      const at = (site: SiteWeather) => model(seed, site).sample(SITE.lat, SITE.lon, 0);
      const rain = at('rain');
      expect(rain.cover).toBeGreaterThan(0.8);
      expect(rain.precip).toBeGreaterThan(0.4);
      expect(at('clear').cover).toBeLessThan(0.15);
      expect(at('overcast').cover).toBeGreaterThan(0.85);
      expect(at('overcast').precip).toBeLessThan(0.2);
      expect(at('fog').fog).toBeGreaterThan(0.5);
      const partly = at('partly').cover;
      expect(partly).toBeGreaterThan(0.25);
      expect(partly).toBeLessThan(0.75);
    }
  });

  it('sunny days have a few small clouds, stormy ones thunderstorms nearby', () => {
    for (const seed of [1, 2, 3, 4, 7]) {
      const fair = model(seed, 'fair').sample(SITE.lat, SITE.lon, 0);
      expect(fair.cover).toBeGreaterThan(0.03);
      expect(fair.cover).toBeLessThan(0.3);
      expect(fair.precip).toBeLessThan(0.1);
      // Thunderstorms within ~120 km: deep convection, tops past 9 km.
      const m = model(seed, 'storm');
      let conv = 0;
      let top = 0;
      for (let k = 0; k < 16; k++) {
        for (const d of [0, 0.3, 0.6, 0.9]) {
          const s = m.sample(SITE.lat + d * Math.sin(k), SITE.lon + d * Math.cos(k), 0);
          conv = Math.max(conv, s.conv);
          top = Math.max(top, s.top);
        }
      }
      expect(conv).toBeGreaterThan(0.6);
      expect(top).toBeGreaterThan(9000);
      // No thunderstorms on a clear day.
      expect(model(seed, 'clear').sample(SITE.lat, SITE.lon, 0).conv).toBeLessThan(0.05);
    }
  });

  it("deals Starbase's days out as its climate does: mostly fair, now and then the rest", () => {
    const n = 4000;
    const count: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const w = starbaseDay(-1.7, (i + 0.5) / n);
      count[w] = (count[w] ?? 0) + 1;
    }
    expect(Object.keys(count).sort()).toEqual(['clear', 'fair', 'fog', 'mostly', 'overcast', 'partly', 'rain', 'storm']);
    expect((count.fair + count.partly + count.clear) / n).toBeGreaterThan(0.55);
    for (const w of ['rain', 'storm', 'fog', 'mostly', 'overcast']) expect(count[w] / n).toBeLessThan(0.15);
    // Thunderstorms in summer, fog in winter.
    const share = (season: number, w: string) => {
      let c = 0;
      for (let i = 0; i < n; i++) if (starbaseDay(season, (i + 0.5) / n) === w) c++;
      return c / n;
    };
    expect(share(23, 'storm')).toBeGreaterThan(share(-23, 'storm') * 2);
    expect(share(-23, 'fog')).toBeGreaterThan(share(23, 'fog') * 2);
  });

  it('places thunderstorm cells on a grid over cube faces, the same from anywhere', () => {
    const R = 6378137;
    // Face coordinates and back.
    for (const e of [[0.3, -0.8, 0.52], [-0.9, 0.1, -0.42], [0.05, 0.2, 0.98]]) {
      const l = Math.hypot(...e);
      const u = e.map((x) => x / l);
      const [f, a, b] = stormFace(u, R);
      const d = stormFaceDir(f, a, b, R);
      for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(u[i], 9);
    }
    // Where it's all thunderstorms, about a cell per grid square; seen from 20 km away, the same.
    const D = Math.PI / 180;
    const at = (lat: number, lon: number) => [Math.cos(lat * D) * Math.cos(lon * D), Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D)];
    const a = stormCells(at(26, -97), R, 200e3, () => 1, 900, 12000);
    const b = stormCells(at(26.18, -97), R, 200e3, () => 1, 900, 12000);
    const area = Math.PI * 200e3 ** 2;
    expect(a.length).toBeGreaterThan(0.5 * (area / STORM_GRID ** 2));
    const key = (c: { dir: number[] }) => c.dir.map((x) => x.toFixed(6)).join();
    const inB = new Set(b.map(key));
    const near = a.filter((c) => Math.acos(c.dir[0] * at(26.09, -97)[0] + c.dir[1] * at(26.09, -97)[1] + c.dir[2] * at(26.09, -97)[2]) * R < 150e3);
    for (const c of near) expect(inB.has(key(c))).toBe(true);
    // None where there's no deep convection.
    expect(stormCells(at(26, -97), R, 200e3, () => 0, 900, 12000)).toHaveLength(0);
  });

  it('has weather all over the globe, in roughly Earth-like amounts', () => {
    const W = 128, H = 64;
    const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4);
    for (const seed of [1, 2]) {
      model(seed).bake(0, [1, 0, 0], W, H, a, b);
      let sum = 0, wsum = 0;
      const band: Record<string, number> = {};
      for (let j = 0; j < H; j++) {
        const lat = -90 + ((j + 0.5) * 180) / H;
        const w = Math.cos((lat * Math.PI) / 180);
        for (let i = 0; i < W; i++) {
          const c = a[(j * W + i) * 4] / 255;
          sum += c * w;
          wsum += w;
          const k = lat < -30 ? 'south' : lat > 30 ? 'north' : 'tropics';
          band[k] = (band[k] ?? 0) + c;
        }
      }
      const mean = sum / wsum;
      expect(mean).toBeGreaterThan(0.3);
      expect(mean).toBeLessThan(0.65);
      // Weather in both hemispheres and the tropics, not just one place.
      for (const k of ['south', 'north', 'tropics']) expect(band[k]).toBeGreaterThan(0);
    }
    // The Sahara is mostly clear; the Southern Ocean's storm track is mostly cloudy.
    const sahara = [1, 2, 3, 4].map((s) => model(s).sample(23, 12, 0).cover);
    const southern = [1, 2, 3, 4].map((s) => model(s).sample(-55, 60, 0).cover);
    expect(sahara.reduce((x, y) => x + y) / 4).toBeLessThan(0.25);
    expect(southern.reduce((x, y) => x + y) / 4).toBeGreaterThan(0.4);
  });

  it('moves: the weather a day later is different', () => {
    const m = model(4);
    const now = [0, 20, 40].map((lon) => m.sample(45, lon, 0).cover);
    const later = [0, 20, 40].map((lon) => m.sample(45, lon, 86400).cover);
    expect(now.some((c, i) => Math.abs(c - later[i]) > 0.05)).toBe(true);
  });

  it('winds: light at the ground, jet streams aloft, sane everywhere', () => {
    const m = model(3);
    let maxSurface = 0;
    let maxJet = 0;
    for (let lat = -70; lat <= 70; lat += 5) {
      for (let lon = -180; lon < 180; lon += 15) {
        const s = m.wind(lat, lon, 10, 0, false);
        maxSurface = Math.max(maxSurface, Math.hypot(s[0], s[1]));
        if (Math.abs(lat) >= 20 && Math.abs(lat) <= 60) {
          const j = m.wind(lat, lon, 11000, 0, false);
          maxJet = Math.max(maxJet, j[0]);
        }
      }
    }
    expect(maxSurface).toBeLessThan(45);
    expect(maxJet).toBeGreaterThan(25);
    expect(maxJet).toBeLessThan(110);
    // Gusts: the wind near the ground varies from second to second.
    const g = [0, 1, 2, 3, 4].map((t) => m.wind(SITE.lat, SITE.lon, 20, t)[0]);
    expect(Math.max(...g) - Math.min(...g)).toBeGreaterThan(0.05);
    // And there's no wind above the air.
    expect(Math.hypot(...m.wind(SITE.lat, SITE.lon, 120e3, 0))).toBe(0);
  });
});

describe('the land, softened for the clouds', () => {
  it('is the land fraction far from a shore, and crosses a shore over a few cells, not one', () => {
    // Mid-Pacific, mid-Sahara: as the grid has them.
    expect(land.soft(0, -140)).toBeCloseTo(0, 3);
    expect(land.soft(23, 10)).toBeCloseTo(1, 3);
    // Across the Gulf coast of Mexico (sea to land, east to west at 22 N): the grid steps by half
    // the way in one cell; softened, by a good deal less in any one.
    let sharp = 0;
    let soft = 0;
    for (let lon = -94; lon > -101; lon -= 0.5) {
      sharp = Math.max(sharp, Math.abs(land.frac(22, lon) - land.frac(22, lon - 0.5)));
      soft = Math.max(soft, Math.abs(land.soft(22, lon) - land.soft(22, lon - 0.5)));
    }
    expect(sharp).toBeGreaterThan(0.4);
    expect(soft).toBeLessThan(0.6 * sharp);
    // The same reach in km near the pole as at the equator: no streaks along the meridians.
    let jump = 0;
    for (let lon = -180; lon < 180; lon += 0.5) jump = Math.max(jump, Math.abs(land.soft(84, lon) - land.soft(84, lon + 0.5)));
    expect(jump).toBeLessThan(0.1);
    // And as much land as there was (to a percent, along a parallel).
    let a = 0;
    let b = 0;
    for (let lon = -180; lon < 180; lon += 0.5) {
      a += land.frac(40, lon);
      b += land.soft(40, lon);
    }
    expect(b / a).toBeGreaterThan(0.93);
    expect(b / a).toBeLessThan(1.07);
  });
});

describe('the cold-ocean index', () => {
  it('has no empty row between two full ones (the Gulf at 25 N, between 27 N and 23 N)', () => {
    for (const lon of [-94, -92, -90, -88]) {
      const a = land.coldOcean(27, lon);
      const b = land.coldOcean(25, lon);
      const c = land.coldOcean(23, lon);
      expect(Math.min(a, c), `lon ${lon}`).toBeGreaterThan(0.05);
      expect(b, `lon ${lon}`).toBeGreaterThan(0.6 * Math.min(a, c));
    }
    // Still where it belongs: off California and Peru, not in mid-ocean.
    expect(land.coldOcean(30, -120)).toBeGreaterThan(0.3);
    expect(land.coldOcean(-15, -80)).toBeGreaterThan(0.3);
    expect(land.coldOcean(0, -150)).toBeLessThan(0.02);
  });
});
