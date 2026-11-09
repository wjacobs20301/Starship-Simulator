// Raptor engine failures and relights.
//
// Real flights lose engines: Flight 14's ship shut one engine down early on the way up and burned
// the others longer to make orbit; its booster lost some on the way down. Two kinds:
//
//   engine out    a running engine shuts down (a small chance every second it runs)
//   no relight    an engine commanded to start doesn't (a chance at each start; higher for
//                 relights, especially in space after a long cold soak)
//
// A failed engine stays out for the rest of the flight. The autopilots fly on with what's left:
// burns run longer, the booster's landing burn and the ship's hover use the engines that work.
//
// Faults are off unless the flight asks for them ('random', at roughly real rates: about one
// flight in three sees an engine out somewhere), or scripted (a replay of a real flight: which
// engine, when). Relights in space are logged either way: Flight 15's deorbit burn is one.

import type { Vehicle } from './vehicle';

export interface ScriptedFault {
  vehicle: 'stack' | 'booster' | 'ship';
  /** The stage whose engine fails (the stack carries both). */
  stage: 'booster' | 'ship';
  ring: number;
  /** Which engine of that ring (0-based). */
  n: number;
  /** Mission time it fails if running (s), or ... */
  at?: number;
  /** ... it fails to light at its next start from this mission time on. */
  noRelightAfter?: number;
}

export type FaultSetting = 'off' | 'random' | ScriptedFault[];

/** Random mode: engine-out hazard per running engine, 1/s. */
const HAZARD = 4e-5;
/** Random mode: chance an engine fails to start (first start / relight in the air / relight in space). */
const IGNITION_FAIL = { first: 0.002, air: 0.008, space: 0.02 };
/** Off this long before lighting, s: a start (shorter is a pulse of a trim burn). */
const RESTART_GAP = 10;
/** Above this, a relight counts as in space, m. */
const SPACE_ALT = 100e3;

/** Engine names as SpaceX calls them. */
export function engineName(stage: 'booster' | 'ship', ring: number, n: number): string {
  if (stage === 'ship') return ring === 0 ? `sea-level Raptor ${n + 1}` : `RVac ${n + 1}`;
  return `${['center', 'inner ring', 'outer ring'][ring] ?? 'outer ring'} Raptor ${n + 1}`;
}

/** mulberry32: a small seeded generator (the same flight replays the same way). */
function rng(seed: number): () => number {
  // (Seeds 1, 2, 3... scrambled first: nearby seeds would start out alike.)
  let a = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class EngineFaults {
  private rand: () => number;
  /** Engines starting now (vehicle id / index), and since when. */
  private starting = new Set<string>();
  /** When each engine last ran (vehicle id / index): a pulse after a moment off isn't a new start. */
  private lastRan = new Map<string, number>();
  /** Engines that have run (by vehicle id / stage / ring / n, carried across separation). */
  private ran = new Set<string>();
  /** A relight in space being watched: when it started and which engines were commanded. */
  private relight: { t: number; want: string[] } | null = null;
  private reported = -Infinity;
  private done = new Set<ScriptedFault>();
  /** How many in-space relights have lit, and how many engines failed (for the log / missions). */
  relights = 0;
  failures = 0;

  constructor(
    private setting: FaultSetting,
    seed: number,
    private log: (text: string) => void,
  ) {
    this.rand = rng(seed);
  }

  /**
   * Each step, before the engines spool: roll for failures, start the scripted ones, watch
   * relights. alt: the vehicle's altitude (m) by id; mt: mission time (s) or null before T-0.
   */
  update(vehicles: Vehicle[], alt: (v: Vehicle) => number, t: number, mt: number | null, dt: number): void {
    const random = this.setting === 'random';
    const script = Array.isArray(this.setting) ? this.setting : [];
    for (const v of vehicles) {
      if (v.status !== 'flight' && v.status !== 'held') continue;
      const h = alt(v);
      v.engines.forEach((e, i) => {
        if (e.failed) return;
        const stage = v.stages[e.stage].def.id;
        const n = v.engines.filter((x, j) => j < i && x.stage === e.stage && x.place.ring === e.place.ring).length;
        const id = `${stage}/${e.place.ring}/${n}`;
        const key = `${v.id}#${i}`;
        const prop = v.stages[e.stage].prop;
        // Scripted: shut down at a time, or refuse the next start after one.
        for (const s of script) {
          if (this.done.has(s) || s.stage !== stage || s.ring !== e.place.ring || s.n !== n || mt === null) continue;
          if (s.at !== undefined && mt >= s.at && e.throttle > 0.05) {
            this.done.add(s);
            this.fail(v, e, stage, n, 'out');
            return;
          }
        }
        const lighting = e.throttleCmd > 0 && e.throttle < 0.05 && prop > 0;
        // (A start: off for a while first. The autopilots pulse engines in trim burns; those
        // short gaps don't count.)
        const offFor = t - (this.lastRan.get(key) ?? -Infinity);
        if (e.throttle > 0.05) this.lastRan.set(key, t);
        if (lighting && !this.starting.has(key) && offFor > RESTART_GAP) {
          const relight = this.ran.has(id);
          this.starting.add(key);
          // Does it light?
          const scripted = script.find((s) => !this.done.has(s) && s.noRelightAfter !== undefined && mt !== null && mt >= s.noRelightAfter && s.stage === stage && s.ring === e.place.ring && s.n === n);
          const space = relight && h > SPACE_ALT && v.id === 'ship';
          const p = !random ? 0 : !relight ? IGNITION_FAIL.first : space ? IGNITION_FAIL.space : IGNITION_FAIL.air;
          if (scripted || this.rand() < p) {
            if (scripted) this.done.add(scripted);
            this.fail(v, e, stage, n, 'norelight', space);
            if (space) this.noteRelight(t, key);
            return;
          }
          // A relight in space: note it, to report how many lit once they're up.
          if (space) this.noteRelight(t, key);
        }
        if (!lighting && e.throttleCmd <= 0) this.starting.delete(key);
        if (e.throttle > 0.3) {
          this.ran.add(id);
          if (random && this.rand() < HAZARD * dt) this.fail(v, e, stage, n, 'out');
        }
      });
    }
    // Report the relight once the engines are up (or have failed).
    const r = this.relight;
    if (r && t - r.t > 2) {
      this.relight = null;
      this.reported = t;
      const ship = vehicles.find((v) => v.id === 'ship');
      if (ship) {
        const lit = r.want.filter((k) => {
          const e = ship.engines[Number(k.split('#')[1])];
          return e && !e.failed && e.throttle > 0.3;
        }).length;
        if (lit > 0) this.relights++;
        this.log(`In-space Raptor relight: ${lit} of ${r.want.length} engine${r.want.length > 1 ? 's' : ''} lit${lit < r.want.length ? ', burning longer on the rest' : ''}`);
      }
    }
  }

  /** An engine commanded to relight in space: counted in the report a moment later. */
  private noteRelight(t: number, key: string): void {
    // (One report a burn: engines pausing and lighting again within it aren't another relight.)
    if (t - this.reported < 120) return;
    if (!this.relight || t - this.relight.t > 5) this.relight = { t, want: [] };
    if (!this.relight.want.includes(key)) this.relight.want.push(key);
  }

  /** Fail an engine now (scripted, random, or the player's / a test's request). */
  fail(v: Vehicle, e: Vehicle['engines'][number], stage: 'booster' | 'ship', n: number, kind: 'out' | 'norelight', inSpace = false): void {
    e.failed = true;
    e.throttleCmd = 0;
    this.failures++;
    const left = v.engines.filter((x) => x.stage === e.stage && !x.failed).length;
    const all = v.engines.filter((x) => x.stage === e.stage).length;
    const who = `${stage === 'ship' ? 'Ship' : 'Booster'} ${engineName(stage, e.place.ring, n)}`;
    this.log(kind === 'out' ? `Engine out: ${who} shut down (${left} of ${all} left)` : `Engine out: ${who} failed to ${inSpace ? 'relight in space' : 'light'} (${left} of ${all} left)`);
  }
}

/** How many engines of a stage still work, optionally only some rings. */
export function workingEngines(v: Vehicle, stageIndex: number, ring?: (ring: number) => boolean): number {
  return v.engines.filter((e) => e.stage === stageIndex && !e.failed && (!ring || ring(e.place.ring))).length;
}
