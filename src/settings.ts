// Player-adjustable settings. A settings panel can call updateSettings(); anything that
// depends on a setting subscribes with onSettingsChange(). Values persist per browser.

/** Weather (clouds, rain, fog): on. (False hides its settings and turns it off.) */
export const WEATHER_AVAILABLE = true;

/** Weather over Starbase: as the global weather has it, or set. */
export type { SiteWeather as StarbaseWeather } from './weather/model';
import type { SiteWeather } from './weather/model';
import { type KeyOverrides, cleanKeys } from './ui/keys';

/** Free roam's weather: a day as Starbase's climate deals them out ('starbase'), or one picked. */
export type FreeWeather = 'starbase' | Exclude<SiteWeather, 'natural'>;
/** What the weather over Starbase is called (the HUD, the menu). */
export const WEATHER_NAME: Record<SiteWeather, string> = {
  natural: 'As it comes', clear: 'Clear', fair: 'Mostly sunny', partly: 'Partly cloudy', mostly: 'Mostly cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Thunderstorms', fog: 'Sea fog',
};
export const FREE_WEATHER: readonly FreeWeather[] = ['starbase', 'clear', 'fair', 'partly', 'mostly', 'overcast', 'rain', 'storm', 'fog'];

export interface Settings {
  /** Serial painted on the ship's side, e.g. "SN44". */
  shipSerial: string;
  /** Launch sound off. */
  muted: boolean;
  /** Loudness, 0..1 (of everything: the world's sounds and the menus'). */
  volume: number;
  /** The flight displays' size: 1, or larger for a small or distant screen. */
  uiScale: number;
  /**
   * How much the picture costs to draw, apart from its resolution: 'high' is everything; 'medium'
   * coarser clouds and shadows; 'low' no shadows or glow as well, for slow graphics cards.
   */
  detail: 'high' | 'medium' | 'low';
  /** How far a drag or a controller's stick turns the camera (1 = normal). */
  cameraSpeed: number;
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
  /** Free roam: the ship carries 26 Starlink V3 satellites (deployed with B in orbit). */
  freeStarlink: boolean;
  /** Keys the player has changed (ui/keys.ts): action -> key, '' for none. The rest are the defaults. */
  keys: KeyOverrides;
}

const DEFAULTS: Settings = { shipSerial: 'SN41', muted: false, volume: 1, uiScale: 1, detail: 'high', cameraSpeed: 1, renderScale: 'auto', clouds: true, freeWeather: 'starbase', engineFailures: false, tileLoss: false, freeStarlink: false, keys: {} };
const STORAGE_KEY = 'starship-sim.settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s: Settings = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
    // (The old setting, 'weather', is gone: free roam starts on Starbase's own.)
    delete (s as Partial<Settings> & { weather?: unknown }).weather;
    if (!FREE_WEATHER.includes(s.freeWeather)) s.freeWeather = 'starbase';
    // (Anything out of range, from an older version or a hand-edited store: the default.)
    const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
    s.volume = num(s.volume, 0, 1, 1);
    s.uiScale = num(s.uiScale, 0.8, 1.5, 1);
    s.cameraSpeed = num(s.cameraSpeed, 0.25, 3, 1);
    if (!['high', 'medium', 'low'].includes(s.detail)) s.detail = 'high';
    s.keys = cleanKeys(s.keys);
    s.shipSerial = String(s.shipSerial ?? '').replace(/[^A-Za-z0-9 -]/g, '').slice(0, 6) || DEFAULTS.shipSerial;
    return s;
  } catch {
    return { ...DEFAULTS, keys: {} };
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
