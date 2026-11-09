// Starship's heat shield, tile by tile (well, patch by patch): the ~18,000 hexagonal tiles on
// the windward half of the ship, and what a gap among them does in the entry.
//
//   Tiles lost  Shaken loose on the way up (liftoff, max-Q, hot staging: a few on some flights,
//               none on others), or taken off on purpose to test the backup layer (as SpaceX
//               did on Flights 10-12). Lost tiles leave gaps, single or in clusters.
//   Inspection  In orbit, cameras on Starlink satellites look back at the ship (Flight 15): the
//               gaps are seen, and flight control decides whether the ship is healthy enough
//               to come home to the tower (GO for the catch) or should come down in the ocean.
//   Entry       Each gap's patch of the shield heats with the local flux: hottest down the
//               windward centreline and up the nose, less toward the sides. Under a missing
//               tile is an ablative backup layer: it chars, and a gap that's big enough or hot
//               enough burns through it into the steel. A burn-through by a flap's hinge
//               cooks the flap's actuator (that flap stops pulling its weight); one elsewhere
//               that keeps going breaches a tank and the ship is lost.
//
// The shield is a grid over the windward half: rows along the ship (2 m), columns round it
// (15 deg). Each patch holds ~28 tiles. Approximate / tuned for play: a tile or three missing
// leaves a scorch; a dozen together on the centreline is a burn-through; a whole patch gone
// there (or a big gap up the nose) burns on into the tank.

import type { V3 } from './math';

/** Rows along the ship (m from its base) and columns round its windward half (deg from the belly line, + toward body +z). */
export const SHIELD = {
  x0: 1,
  rowLen: 2,
  rows: 25,
  colDeg: 15,
  cols: 12,
  /** Tiles per patch (~0.31 m hexagons). */
  tilesPer: 28,
};

/** A patch's place: x from the ship's base (m), angle round from the belly line (rad, + toward +z). */
export function patchPlace(row: number, col: number): { x: number; angle: number } {
  return { x: SHIELD.x0 + (row + 0.5) * SHIELD.rowLen, angle: ((col + 0.5 - SHIELD.cols / 2) * SHIELD.colDeg * Math.PI) / 180 };
}

/** Integrated heat (J/m^2 of local flux) that chars a fully exposed patch through. */
const BURN_LOAD = 1.1e8;
/** Patches whose burn-through cooks a flap: within this of a hinge (m along, deg round). */
const FLAP_ZONE = { aft: [0, 12], fwd: [40, 50], minDeg: 60 };

export type TileSetting = 'off' | 'random' | { lost: { row: number; col: number; n: number }[] };

export interface ShieldSnapshot {
  /** Missing tiles per patch (rows x cols, row-major). */
  missing: number[];
  /** How far each gap has charred through its backup layer, 0..1+ (1 = burn-through). */
  char: number[];
  /** Patches glowing now (local flux on the gap, W/m^2), for the render. */
  glow: number[];
  /** The inspection's verdict, once made. */
  verdict: 'go' | 'nogo' | null;
  lost: number;
}

function rng(seed: number): () => number {
  let a = Math.imul((seed >>> 0) ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HeatShield {
  readonly n = SHIELD.rows * SHIELD.cols;
  missing = new Array<number>(this.n).fill(0);
  /** Heat load each patch has taken (J/m^2). */
  load = new Array<number>(this.n).fill(0);
  char = new Array<number>(this.n).fill(0);
  glow = new Array<number>(this.n).fill(0);
  verdict: 'go' | 'nogo' | null = null;
  /** Flaps cooked by a burn-through at their hinge (indices into the ship's surfaces: fwd L, fwd R, aft L, aft R). */
  flapsHit = new Set<number>();
  private rand: () => number;
  private shaken = new Set<string>();
  private burned = new Set<number>();

  constructor(
    private setting: TileSetting,
    seed: number,
    private log: (text: string) => void,
  ) {
    this.rand = rng(seed);
    if (typeof setting === 'object') for (const l of setting.lost) this.lose(l.row, l.col, l.n);
  }

  get lost(): number {
    return this.missing.reduce((a, b) => a + b, 0);
  }

  private lose(row: number, col: number, n: number): void {
    const i = row * SHIELD.cols + col;
    if (i < 0 || i >= this.n) return;
    this.missing[i] = Math.min(SHIELD.tilesPer, this.missing[i] + n);
  }

  /**
   * On the way up (random setting): a chance of tiles shaking loose at each hard moment. Each
   * event is a gap of one tile or a few together.
   */
  shake(moment: 'liftoff' | 'maxq' | 'staging'): void {
    if (this.setting !== 'random' || this.shaken.has(moment)) return;
    this.shaken.add(moment);
    // (Chance of an event and the most it loses: hot staging shakes the aft end hardest.)
    const odds = { liftoff: 0.35, maxq: 0.3, staging: 0.45 }[moment];
    let lost = 0;
    for (let k = 0; k < 3; k++) {
      if (this.rand() > odds) continue;
      const row = moment === 'staging' && this.rand() < 0.6 ? Math.floor(this.rand() * 6) : Math.floor(this.rand() * SHIELD.rows);
      const col = Math.floor(this.rand() * SHIELD.cols);
      // Mostly single tiles; now and then a cluster (one knocks its neighbours loose).
      const n = this.rand() < 0.7 ? 1 : 2 + Math.floor(this.rand() * 7);
      this.lose(row, col, n);
      lost += n;
    }
    if (lost) this.log(`Heat shield: ${lost} tile${lost > 1 ? 's' : ''} shaken loose (${{ liftoff: 'liftoff', maxq: 'max-Q', staging: 'hot staging' }[moment]})`);
  }

  /** Where a patch sees the heating: the windward centreline and the nose run hottest. */
  static factor(row: number, col: number): number {
    const { x, angle } = patchPlace(row, col);
    const side = Math.cos(angle);
    const nose = x > 40 ? 1 + 0.6 * ((x - 40) / 10) : 1;
    return (0.3 + 0.7 * side * side) * nose;
  }

  /**
   * How much a gap of n tiles lets through: one tile is mostly sheltered by its neighbours' edges;
   * a dozen is wide open; a whole patch gone, the plasma scours in and burns on into the steel.
   */
  static exposure(n: number): number {
    return n <= 0 ? 0 : 0.28 + 0.72 * Math.min(1, (n - 1) / 11) + 0.5 * Math.max(0, (n - 12) / 16);
  }

  /** The inspection in orbit: look at the gaps and judge what the entry would do to them. */
  inspect(forCatch = true): { verdict: 'go' | 'nogo'; text: string } {
    // An entry from orbit puts ~1.2e8 J/m^2 into the windward centreline (measured from the sim).
    const NOMINAL_LOAD = 1.2e8;
    let worst = 0;
    let where = '';
    let flapRisk = false;
    for (let i = 0; i < this.n; i++) {
      if (!this.missing[i]) continue;
      const row = Math.floor(i / SHIELD.cols);
      const col = i % SHIELD.cols;
      const c = (HeatShield.factor(row, col) * NOMINAL_LOAD * HeatShield.exposure(this.missing[i])) / BURN_LOAD;
      if (c > worst) {
        worst = c;
        where = HeatShield.describe(row, col);
      }
      if (c > 0.8 && this.flapAt(row, col) !== null) flapRisk = true;
    }
    const lost = this.lost;
    const verdict = worst > 0.85 || flapRisk ? 'nogo' : 'go';
    this.verdict = verdict;
    const go = forCatch ? 'GO for the catch' : 'GO for entry';
    const text = !lost
      ? `Heat shield inspection: no tiles missing. ${go}`
      : `Heat shield inspection: ${lost} tile${lost > 1 ? 's' : ''} missing, the worst gap ${where} (${Math.round(worst * 100)}% of burn-through expected). ` +
        (verdict === 'go' ? go : forCatch ? 'NO-GO for the catch: the ship comes down in the ocean instead' : 'Expect a burn-through in the entry');
    return { verdict, text };
  }

  /** In words, where a patch is. */
  static describe(row: number, col: number): string {
    const { x, angle } = patchPlace(row, col);
    const along = x < 12 ? 'by the aft flaps' : x > 40 ? 'on the nose' : x < 26 ? 'low on the belly' : 'high on the belly';
    const deg = (angle * 180) / Math.PI;
    const round = Math.abs(deg) < 25 ? 'on the centreline' : Math.abs(deg) > 60 ? `near the ${deg > 0 ? 'left' : 'right'} edge` : `${deg > 0 ? 'left' : 'right'} of centre`;
    return `${along}, ${round}`;
  }

  /** The flap a patch is by the hinge of (0 fwd L, 1 fwd R, 2 aft L, 3 aft R), or null. */
  flapAt(row: number, col: number): number | null {
    const { x, angle } = patchPlace(row, col);
    if (Math.abs((angle * 180) / Math.PI) < FLAP_ZONE.minDeg) return null;
    const left = angle > 0;
    if (x >= FLAP_ZONE.aft[0] && x <= FLAP_ZONE.aft[1]) return left ? 2 : 3;
    if (x >= FLAP_ZONE.fwd[0] && x <= FLAP_ZONE.fwd[1]) return left ? 0 : 1;
    return null;
  }

  /**
   * Each step in the air: heat the gaps by the stagnation flux (W/m^2) as the belly takes it
   * (shielded: 0..1, how squarely the belly meets the flow). Returns why the ship is lost, or null.
   */
  heat(flux: number, shielded: number, dt: number): string | null {
    let lostWhy: string | null = null;
    for (let i = 0; i < this.n; i++) {
      const m = this.missing[i];
      if (!m) {
        this.glow[i] = 0;
        continue;
      }
      const row = Math.floor(i / SHIELD.cols);
      const col = i % SHIELD.cols;
      const local = flux * shielded * HeatShield.factor(row, col);
      this.glow[i] = local;
      this.load[i] += local * dt;
      this.char[i] = (this.load[i] * HeatShield.exposure(m)) / BURN_LOAD;
      if (this.char[i] >= 1 && !this.burned.has(i)) {
        this.burned.add(i);
        const flap = this.flapAt(row, col);
        if (flap !== null) {
          this.flapsHit.add(flap);
          this.log(`Burn-through ${HeatShield.describe(row, col)}: the ${['left forward', 'right forward', 'left aft', 'right aft'][flap]} flap's hinge is cooking`);
        } else this.log(`Burn-through ${HeatShield.describe(row, col)}: plasma on the steel`);
      }
      // Burned on through the steel into a tank.
      if (this.char[i] >= 1.45 && this.flapAt(row, col) === null) lostWhy = `heat shield breach ${HeatShield.describe(row, col)}: burn-through into the tank`;
    }
    return lostWhy;
  }

  snapshot(): ShieldSnapshot {
    return { missing: [...this.missing], char: this.char.map((c) => Math.round(c * 100) / 100), glow: this.glow.map((g) => Math.round(g)), verdict: this.verdict, lost: this.lost };
  }
}

/** A patch's centre in the ship's body frame (x from the ship's base), on a hull of radius r. */
export function patchCentre(row: number, col: number, r = 4.5): V3 {
  const { x, angle } = patchPlace(row, col);
  return [x, r * Math.cos(angle), r * Math.sin(angle)];
}
