// A flight saved by the worker: the simulation's own save (sim/saveFlight.ts) plus what the
// worker holds outside it. That's the weather: the wind on the vehicles is a function the worker
// builds from the weather's settings, so the settings are saved and the same wind is built again
// before the flight is loaded (with what its model had in mind, so the wind is the same to the
// last digit: WeatherModel.windMemory). The land mask the weather also uses is fixed data,
// megabytes of it, sent to the worker once: it stays out of the save.
//
// Kept apart from sim.worker.ts so the tests can save and load a flight the way the worker does,
// without a worker.

import type { Env } from '../sim/dynamics';
import type { SavedSimulation } from '../sim/saveFlight';
import type { Simulation } from '../sim/simulation';
import { type Land, type WeatherConfig, WeatherModel, type WindMemory } from '../weather/model';

/**
 * What a 'save' message is answered with and a 'load' message takes: plain JSON, to keep in
 * localStorage / IndexedDB. Its version, the flight's times, phase and options are at the top
 * (SavedSimulation), for a list of saved flights.
 */
export interface SavedFlight extends SavedSimulation {
  /** The weather whose wind the flight was flying in (null: still air). */
  weather: WeatherConfig | null;
  /** What that weather's wind had in mind when saved (null: still air). */
  windMemory: WindMemory | null;
}

/** The weather in force: its settings, its model, and the wind that puts on the vehicles. */
export interface FlightWeather {
  cfg: WeatherConfig;
  model: WeatherModel;
  wind: NonNullable<Env['wind']>;
}

/** The weather for these settings (null: still air). */
export function flightWeather(cfg: WeatherConfig | null, land: Land | null): FlightWeather | null {
  if (!cfg) return null;
  const model = new WeatherModel(cfg, land);
  const DEG = 180 / Math.PI;
  return { cfg: { ...cfg }, model, wind: (geo, t, gusts = true) => model.wind(geo.lat * DEG, geo.lon * DEG, Math.max(0, geo.h), t, gusts) };
}

/** The flight as it is now, with the weather it's flying in. */
export function saveFlight(sim: Simulation, weather: FlightWeather | null): SavedFlight {
  return { ...sim.save(), weather: weather ? { ...weather.cfg } : null, windMemory: weather ? weather.model.windMemory(sim.t) : null };
}

/**
 * Take up a saved flight in `sim`, in its weather's wind. Returns that weather (now the one in
 * force; null: still air). Throws, leaving the simulation and its wind as they were, if the save
 * can't be loaded (another version, damaged).
 */
export function loadFlight(sim: Simulation, saved: SavedFlight, land: Land | null): FlightWeather | null {
  const before = sim.env.wind;
  try {
    const weather = flightWeather(saved?.weather ?? null, land);
    if (weather && saved.windMemory) weather.model.restoreWindMemory(saved.windMemory);
    // (The wind first: nothing reads it while loading, but the flight must never step without it.)
    sim.env.wind = weather?.wind;
    sim.load(saved);
    return weather;
  } catch (err) {
    sim.env.wind = before;
    throw err;
  }
}
