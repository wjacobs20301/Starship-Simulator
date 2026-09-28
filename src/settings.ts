// Player-adjustable settings. A settings panel can call updateSettings(); anything that
// depends on a setting subscribes with onSettingsChange(). Values persist per browser.

/** Weather (clouds, rain, fog) is switched off for now: the settings for it are hidden. */
export const WEATHER_AVAILABLE = false;

/** Weather over Starbase: as the global weather has it, or set. */
export type StarbaseWeather = 'natural' | 'clear' | 'partly' | 'overcast' | 'rain' | 'fog';

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
  /** Weather over Starbase. */
  weather: StarbaseWeather;
}

const DEFAULTS: Settings = { shipSerial: 'SN44', muted: false, renderScale: 'auto', clouds: true, weather: 'partly' };
const STORAGE_KEY = 'starship-sim.settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
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
