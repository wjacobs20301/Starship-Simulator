import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Land, type SiteWeather, WeatherModel } from '../src/weather/model';

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
