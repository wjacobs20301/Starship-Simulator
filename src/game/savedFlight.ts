// Flights kept in the browser, to be taken up again after the page is closed or reloaded (a
// flight to orbit and back is hours of sim time). Two kinds:
//  - the autosave: one, written every so often while flying (main.ts), always the latest flight;
//  - the player's own saves, made from the pause menu, up to MAX_MANUAL of them. When they're
//    all taken, a new one goes in place of the oldest (the pause menu says which beforehand), or
//    of one the player picks.
// The main menu's Continue lists them all, newest first.
//
// Storage: each save is its own localStorage entry, so writing one never puts another at risk.
// The autosave is at 'starship-sim:flight', where the one save of older builds was (so a player's
// save from before there were several is simply the autosave now); the player's are at
// 'starship-sim:flight:<id>'. A save is 12-40 kB of JSON and the browser keeps about 5 MB per
// site: nine fit, with room to spare. When a write doesn't fit, the browser leaves what was
// there before, and the player is told the flight wasn't kept.
//
// The simulation's own state is the worker's (worker/savedFlight.ts: the vehicles, autopilots,
// tower, wind...); round it, what the page needs to put the same flight back on screen: which
// mission, its objectives so far, whose controls the player had, the time of day. Both carry a
// format version, and a save from an older build is converted step by step (sim/saveVersion.ts)
// rather than dropped.
//
// Nothing here touches the page: the storage is handed in (browserStore() in the game; a fake
// one in tests/savedFlights.test.ts).

import { SAVE_UPGRADES, SAVE_VERSION, type SaveUpgrade, upgradeProblem, upgradeSave } from '../sim/saveVersion';
import type { SavedFlight } from '../worker/protocol';
import type { MissionId } from './missions';

/**
 * The page-side save's format version. Raise it when the shape of FlightSave changes, and add the
 * step from the old version to FLIGHT_SAVE_UPGRADES so older saves are converted, not dropped.
 */
export const VERSION = 2;

/**
 * How to bring a page-side save of each older version up to the next one.
 *  1 → 2: one save became several. A version 1 save is the single save of older builds, kept at
 *  the autosave's key: it gains a name (none) and whether its mission was over (never: older
 *  builds deleted a save when its mission ended).
 */
export const FLIGHT_SAVE_UPGRADES: Record<number, SaveUpgrade> = {
  1: (s) => ({ ...s, version: 2, name: '', finished: false }),
};

/** The player's own saves, at most (the autosave is besides). */
export const MAX_MANUAL = 8;
/** The autosave's id. */
export const AUTO_ID = 'auto';
const AUTO_KEY = 'starship-sim:flight';
const MANUAL_PREFIX = 'starship-sim:flight:';
/** A save's name, at most this long. */
export const NAME_MAX = 40;

export interface FlightSave {
  version: number;
  /** When it was written (ms since 1970), and the flight's clock then (s; null before the count). */
  savedAt: number;
  missionTime: number | null;
  mission: MissionId;
  title: string;
  /** The player's name for it ('' for none, and for the autosave). */
  name: string;
  /** Its mission was already over (the result given out) when it was saved. */
  finished: boolean;
  pad: number;
  /** The vehicle on screen, and those the player was flying by hand. */
  tracked: string;
  manual: string[];
  /** The time of day: the day angle at sim time t (main.ts dayPhase / dayRef). */
  day: { phase: number; t: number; missionTime: number } | null;
  /** The mission's record so far (MissionTracker.saveState). */
  tracker: unknown;
  /** The simulation itself. */
  flight: SavedFlight;
  /** Set when this build tried to take it up and couldn't: why (it's listed, but can't be continued). */
  unusable?: string;
}

/** What the game hands over to be saved: the flight, without what the save itself adds. */
export type FlightSaveContent = Omit<FlightSave, 'version' | 'savedAt' | 'name' | 'unusable'>;

/** A save as the menus list it. */
export interface SaveEntry {
  id: string;
  auto: boolean;
  name: string;
  title: string;
  mission: string;
  missionTime: number | null;
  /** 0 when it can't be read. */
  savedAt: number;
  finished: boolean;
  /** Why it can't be continued (null: it can). */
  problem: string | null;
}

/** The part of the browser's Storage used here (localStorage, or a fake one in the tests). */
export type SaveStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type SaveWrite = { ok: true; id: string; replaced: SaveEntry | null } | { ok: false; full: boolean; reason: string };

/** The browser's localStorage, or (where a page can't have one: some private windows) a store that keeps nothing. */
export function browserStore(): SaveStore {
  try {
    const s = window.localStorage;
    if (s) return s;
  } catch {
    // (Below.)
  }
  return {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw Object.assign(new Error('no storage'), { name: 'SecurityError' });
    },
    removeItem: () => {},
  };
}

const keyOf = (id: string) => (id === AUTO_ID ? AUTO_KEY : MANUAL_PREFIX + id);

/** What was read at one key: the save, or why it can't be continued (with what could be made out of it). */
type Read = { save: FlightSave; problem: null } | { save: null; problem: string; peek: Partial<FlightSave> };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A save's parts the list shows, from whatever could be read (to name a save that can't be continued). */
function peek(x: unknown): Partial<FlightSave> {
  if (!isObject(x)) return {};
  const p: Partial<FlightSave> = {};
  if (typeof x.title === 'string') p.title = x.title;
  if (typeof x.mission === 'string') p.mission = x.mission as MissionId;
  if (typeof x.name === 'string') p.name = x.name;
  if (typeof x.savedAt === 'number') p.savedAt = x.savedAt;
  if (typeof x.missionTime === 'number') p.missionTime = x.missionTime;
  return p;
}

/** Is this, after converting, a whole save of this version? */
function wellFormed(s: Record<string, unknown>): boolean {
  return (
    s.version === VERSION &&
    typeof s.savedAt === 'number' &&
    (s.missionTime === null || typeof s.missionTime === 'number') &&
    typeof s.mission === 'string' &&
    typeof s.title === 'string' &&
    typeof s.name === 'string' &&
    typeof s.finished === 'boolean' &&
    typeof s.pad === 'number' &&
    typeof s.tracked === 'string' &&
    Array.isArray(s.manual) &&
    s.manual.every((m) => typeof m === 'string') &&
    (s.day === null || isObject(s.day)) &&
    isObject(s.flight) &&
    (s.unusable === undefined || typeof s.unusable === 'string')
  );
}

/**
 * The save at `key`, converted to this version (and written back so, once: the conversion is
 * done on first read; if that write doesn't fit, it's simply done again next time). Null: none.
 */
function readKey(store: SaveStore, key: string): Read | null {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { save: null, problem: "it's damaged and can't be read", peek: {} };
  }
  if (!isObject(parsed)) return { save: null, problem: "it's damaged and can't be read", peek: {} };
  const seen = peek(parsed);
  const pageProblem = upgradeProblem(parsed.version, VERSION, FLIGHT_SAVE_UPGRADES);
  if (pageProblem) return { save: null, problem: pageProblem, peek: seen };
  let s: Record<string, unknown>;
  try {
    s = upgradeSave(parsed as { version: number }, VERSION, FLIGHT_SAVE_UPGRADES);
  } catch (err) {
    return { save: null, problem: err instanceof Error ? err.message.replace(/^Can't load the flight: /, '') : String(err), peek: seen };
  }
  if (!wellFormed(s)) return { save: null, problem: "it's damaged: parts of it are missing", peek: { ...seen, ...peek(s) } };
  if (parsed.version !== VERSION) {
    try {
      store.setItem(key, JSON.stringify(s));
    } catch {
      // (Converted again next time.)
    }
  }
  const save = s as unknown as FlightSave;
  if (save.unusable) return { save: null, problem: save.unusable, peek: peek(s) };
  // The simulation's part: will this build load it? (Asked without loading it: a version check.)
  const flightVersion = (save.flight as { version?: unknown }).version;
  const simProblem = upgradeProblem(flightVersion, SAVE_VERSION, SAVE_UPGRADES);
  if (simProblem) return { save: null, problem: simProblem, peek: peek(s) };
  return { save, problem: null };
}

function entryOf(id: string, r: Read): SaveEntry {
  const s = r.save ?? r.peek;
  return {
    id,
    auto: id === AUTO_ID,
    name: s.name ?? '',
    title: s.title ?? 'Saved flight',
    mission: s.mission ?? '',
    missionTime: s.missionTime ?? null,
    savedAt: s.savedAt ?? 0,
    finished: r.save?.finished ?? false,
    problem: r.problem,
  };
}

/** The ids of the player's saves in the store. */
function manualIds(store: SaveStore): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(MANUAL_PREFIX) && k.length > MANUAL_PREFIX.length) ids.push(k.slice(MANUAL_PREFIX.length));
    }
  } catch {
    // (A store that can't be listed has none to list.)
  }
  return ids;
}

/** Every save, newest first (those that can't be read last, as they're the oldest for all we know). */
export function listSaves(store: SaveStore): SaveEntry[] {
  const out: SaveEntry[] = [];
  for (const id of [AUTO_ID, ...manualIds(store)]) {
    const r = readKey(store, keyOf(id));
    if (r) out.push(entryOf(id, r));
  }
  return sortNewestFirst(out);
}

export function sortNewestFirst<T extends SaveEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.savedAt - a.savedAt || (a.auto === b.auto ? a.id.localeCompare(b.id) : a.auto ? -1 : 1));
}

/** The newest save that can be continued (the main menu's quick Continue), if any. */
export function latestSave<T extends SaveEntry>(entries: T[]): T | null {
  return sortNewestFirst(entries).find((e) => e.problem === null) ?? null;
}

/** One save, to take up: the save itself, or why it can't be. */
export function readSave(store: SaveStore, id: string): { save: FlightSave } | { problem: string } {
  const r = readKey(store, keyOf(id));
  if (!r) return { problem: "it isn't there any more" };
  return r.save ? { save: r.save } : { problem: r.problem };
}

/** Did a write fail for want of room (rather than storage being off altogether)? */
function isQuota(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

function put(store: SaveStore, id: string, s: FlightSave, replaced: SaveEntry | null): SaveWrite {
  try {
    // (A write that doesn't fit leaves the entry as it was: nothing kept before is lost.)
    store.setItem(keyOf(id), JSON.stringify(s));
    return { ok: true, id, replaced };
  } catch (err) {
    const full = isQuota(err);
    return {
      ok: false,
      full,
      reason: full ? "the browser's storage for this site is full" : "this browser isn't keeping anything for this site (a private window?)",
    };
  }
}

/** Keep the flight as the autosave (in place of the one before). */
export function writeAutosave(store: SaveStore, content: FlightSaveContent, now = Date.now()): SaveWrite {
  return put(store, AUTO_ID, { ...content, version: VERSION, savedAt: now, name: '' }, null);
}

/**
 * Where a new save of the player's goes: in place of `replace` (one of theirs), else a new place
 * while there's room, else in place of the oldest of theirs. id null: a new place.
 */
export function manualTarget<T extends SaveEntry>(entries: T[], replace: string | null = null): { id: string | null; replaces: T | null } {
  const mine = entries.filter((e) => !e.auto);
  if (replace !== null) {
    const r = mine.find((e) => e.id === replace);
    if (r) return { id: r.id, replaces: r };
  }
  if (mine.length < MAX_MANUAL) return { id: null, replaces: null };
  // (Those that can't be read count as oldest: they go first.)
  const oldest = [...mine].sort((a, b) => a.savedAt - b.savedAt || a.id.localeCompare(b.id))[0];
  return { id: oldest.id, replaces: oldest };
}

/** A save's name as kept: one line, trimmed, not too long. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** Keep the flight as one of the player's saves (manualTarget says where). */
export function writeManualSave(
  store: SaveStore,
  content: FlightSaveContent,
  opts: { name: string; replace?: string | null },
  now = Date.now(),
  random: () => number = Math.random,
): SaveWrite {
  const entries = listSaves(store);
  const target = manualTarget(entries, opts.replace ?? null);
  let id = target.id;
  if (id === null) {
    const taken = new Set(entries.map((e) => e.id));
    do id = now.toString(36) + Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
    while (taken.has(id));
  }
  return put(store, id, { ...content, version: VERSION, savedAt: now, name: cleanName(opts.name) }, target.replaces);
}

export function deleteSave(store: SaveStore, id: string): void {
  try {
    store.removeItem(keyOf(id));
  } catch {
    // (Nothing to delete.)
  }
}

/**
 * This build couldn't take the save up (the simulation refused it): keep it, but listed as one that
 * can't be continued, saying why, so the player can see it and delete it. The other saves are
 * left alone. (If even this doesn't fit, it's simply tried again next time it's picked.)
 */
export function markUnusable(store: SaveStore, id: string, reason: string): void {
  const r = readKey(store, keyOf(id));
  if (!r?.save) return;
  try {
    store.setItem(keyOf(id), JSON.stringify({ ...r.save, unusable: reason }));
  } catch {
    // (Above.)
  }
}

/** When a save was made, the friendly way: "Today 14:05", "Yesterday 09:12", "3 Nov, 14:05" (local time). */
export function formatSavedAt(savedAt: number, now = Date.now()): string {
  if (!savedAt) return 'When unknown';
  const d = new Date(savedAt);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date}, ${time}`;
}
