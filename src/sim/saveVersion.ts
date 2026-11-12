// Saved flights outlive the build that wrote them: a player's save from last month must still
// load after an update that changed what a save holds. So a save carries its format's version,
// and a format change comes with an upgrade: a function that turns a save of version N into one
// of version N + 1. A save of an older version is run through those one step at a time until it
// is the current version; one with a step missing (or from a newer build) is refused, with a
// reason a player can be shown.
//
// Two formats use this: the simulation's own state (SAVE_VERSION and SAVE_UPGRADES here, used by
// Simulation.load) and the page's wrapper round it (game/savedFlight.ts). Kept free of the
// simulation's classes so the page can ask whether a save will load without loading it.

/** Turns a save of version N (the key it's filed under) into one of version N + 1. */
export type SaveUpgrade = (saved: Record<string, unknown>) => Record<string, unknown>;

/**
 * The simulation's save format version (sim/saveFlight.ts says when to raise it). A save of any
 * other version is upgraded through SAVE_UPGRADES, or refused.
 */
export const SAVE_VERSION = 1;

/**
 * How to bring the simulation's save of each older version up to the next one. Raising
 * SAVE_VERSION from N to N + 1 means adding the entry N here (when the change can be made good
 * in an old save: a field with an obvious value to fill in, a renamed one), or leaving it out
 * (when it can't), in which case saves of version N and older are refused.
 *
 * Nothing to convert yet: version 1 is the first.
 */
export const SAVE_UPGRADES: Record<number, SaveUpgrade> = {};

/**
 * Why a save of `version` can't be brought up to `current` through `upgrades` (null: it can,
 * or it already is current). For a list of saves, without touching one.
 */
export function upgradeProblem(version: unknown, current: number, upgrades: Record<number, SaveUpgrade>): string | null {
  if (typeof version !== 'number' || !Number.isInteger(version)) return "it isn't a saved flight";
  if (version > current) return `it was saved by a newer version of the game (format version ${version}; this one reads up to ${current})`;
  for (let v = version; v < current; v++) {
    if (!Object.prototype.hasOwnProperty.call(upgrades, v)) {
      return `it was saved in format version ${version}, and this version of the game reads version ${current} and can't convert it`;
    }
  }
  return null;
}

/**
 * A save brought up to `current`, one version at a time. The steps work on a copy: `saved` is
 * left as it was. Throws an Error naming the reason (upgradeProblem) if it can't be done, or if a
 * step doesn't hand back the next version.
 */
export function upgradeSave<T extends { version: number }>(saved: { version: number }, current: number, upgrades: Record<number, SaveUpgrade>, what = 'the flight'): T {
  const problem = upgradeProblem(saved?.version, current, upgrades);
  if (problem) throw new Error(`Can't load ${what}: ${problem}`);
  if (saved.version === current) return saved as T;
  let s = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
  for (let v = saved.version; v < current; v++) {
    s = upgrades[v](s);
    // (A step that forgets to say what it made is a bug in the step: don't guess.)
    if (s?.version !== v + 1) throw new Error(`Can't load ${what}: converting it from format version ${v} went wrong`);
  }
  return s as unknown as T;
}
