import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATCH_WIND_LIMIT } from '../src/sim/boosterReturn';
import { DEFAULT_ENV } from '../src/sim/dynamics';
import { Simulation } from '../src/sim/simulation';
import { Land, type SiteWeather, WeatherModel, calmSeed } from '../src/weather/model';

// Flights through the weather's wind (the same model the game uses). The ascent turns into the
// wind only when side loads near the limit; the booster's guidance flies the day's wind profile;
// over the catch wind limit the catch is called off and it lands on the Gulf instead.
const land = new Land(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../public/data/landmask.bin'))));
const DEG = 180 / Math.PI;

const cfg = (seed: number, site: SiteWeather) => ({ seed, season: -1.7, site, siteLat: 25.99613, siteLon: -97.15442, t0: 0 });

function fly(seed: number, site: SiteWeather) {
  const m = new WeatherModel(cfg(seed, site), land);
  const sim = new Simulation({ ...DEFAULT_ENV });
  sim.env.wind = (g, t, gusts = true) => m.wind(g.lat * DEG, g.lon * DEG, Math.max(0, g.h), t, gusts);
  sim.launch();
  const done = () => ['caught', 'destroyed', 'landed'].includes(sim.find('booster')?.status ?? '');
  while ((sim.mission.missionTime ?? -99) < 520 && !done()) sim.step();
  const tw = m.wind(25.99613, -97.15442, 150, 140, false);
  return { sim, booster: sim.find('booster'), towerWind: Math.hypot(tw[0], tw[1]) };
}

describe('booster return in the wind', () => {
  for (const [seed, site] of [[2, 'natural'], [3, 'rain'], [4, 'clear'], [14, 'overcast']] as const) {
    it(`seed ${seed} (${site}): flies through it and is caught`, { timeout: 120_000 }, () => {
      const { sim, booster } = fly(seed, site);
      expect(sim.events.some((e) => /lost|structural/.test(e.text))).toBe(false);
      expect(booster?.status).toBe('caught');
    });
  }

  it('over the wind limit at the tower: no catch, lands on the Gulf instead', { timeout: 120_000 }, () => {
    const { sim, booster, towerWind } = fly(9, 'natural');
    expect(towerWind).toBeGreaterThan(CATCH_WIND_LIMIT);
    expect(sim.events.some((e) => /^Catch no-go/.test(e.text))).toBe(true);
    expect(booster?.status).toBe('landed');
  });

  it('missions get fair weather: light wind at the tower for hours', () => {
    for (const seed of [9, 21, 33, 45, 57, 69]) {
      const c = cfg(seed, 'partly');
      const m = new WeatherModel({ ...c, seed: calmSeed(c, land) }, land);
      for (let t = 0; t <= 2.5 * 3600; t += 600) {
        const w = m.wind(c.siteLat, c.siteLon, 150, t, false);
        expect(Math.hypot(w[0], w[1])).toBeLessThan(7);
      }
      expect(m.sample(c.siteLat, c.siteLon, 0).precip).toBeLessThan(0.1);
    }
  });
});
