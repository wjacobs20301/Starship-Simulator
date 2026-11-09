// Player-adjustable settings. A settings panel can call updateSettings(); anything that
// depends on a setting subscribes with onSettingsChange(). Values persist per browser.

/** Weather (clouds, rain, fog): on. (False hides its settings and turns it off.) */
export const WEATHER_AVAILABLE = true;

/** Weather over Starbase: as the global weather has it, or set. */
export type { SiteWeather as StarbaseWeather } from './weather/model';
import type { SiteWeather } from './weather/model';

/** Free roam's weather: a day as Starbase's climate deals them out ('starbase'), or one picked. */
export type FreeWeather = 'starbase' | Exclude<SiteWeather, 'natural'>;
/** What the weather over Starbase is called (the HUD, the menu). */
export const WEATHER_NAME: Record<SiteWeather, string> = {
  natural: 'As it comes', clear: 'Clear', fair: 'Sunny', partly: 'Partly cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Thunderstorms', fog: 'Sea fog',
};
export const FREE_WEATHER: readonly FreeWeather[] = ['starbase', 'clear', 'fair', 'partly', 'overcast', 'rain', 'storm', 'fog'];

export interface Settings {
  /** Serial painted on the ship's side, e.g. "SN44". */
  shipSerial: string;
  /** Launch sound off. */
  muted: boolean;
  /**
   * Render resolution: a fraction of the display's (1 = full, the default), or 'auto', which lowers
   * it when frames are missed.
   */
  renderScale: 'auto' | number;
  /** Clouds on (planet-wide, volumetric). */
  clouds: boolean;
  /** Free roam's weather over Starbase. */
  freeWeather: FreeWeather;
  /** Raptors can fail (at roughly real rates): an engine out on the way up, one that won't relight. */
  engineFailures: boolean;
  /** Heat shield tiles can shake loose on the way up (the gaps run hot at entry). */
  tileLoss: boolean;
}

const DEFAULTS: Settings = { shipSerial: 'SN41', muted: false, renderScale: 'auto', clouds: true, freeWeather: 'starbase', engineFailures: false, tileLoss: false };
const STORAGE_KEY = 'starship-sim.settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s: Settings = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
    // (The old setting, 'weather', is gone: free roam starts on Starbase's own.)
    delete (s as Partial<Settings> & { weather?: unknown }).weather;
    if (!FREE_WEATHER.includes(s.freeWeather)) s.freeWeather = 'starbase';
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();
const listeners = new Set<(s: Settings) => void>();

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode etc.): the setting still applies for this session.
  }
  for (const fn of listeners) fn(settings);
}

/** Calls fn now and on every change; returns an unsubscribe function. */
export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  fn(settings);
  return () => listeners.delete(fn);
}
