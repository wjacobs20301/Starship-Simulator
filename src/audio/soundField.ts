// What a listener hears from the rocket plumes, including the speed-of-sound delay: for a
// spectator 9 km away, liftoff is silent for ~26 s. Every frame each running plume records its
// position and sound power; a query finds, per source, the emission time t_e whose sound is
// arriving now (t - t_e = |listener - source(t_e)| / c) and sums the received levels.
//
// Levels follow the usual rocket-noise estimate: acoustic power = eta * mechanical jet power
// (eta ~ 0.5%), spherical spreading, a little air absorption. A full Super Heavy is ~208 dB re
// 1 pW: ~144 dB at 450 m, ~118 dB at 9 km, similar to measured launch levels.

import type { V3 } from '../sim/math';

export const SPEED_OF_SOUND = 343;
const HISTORY_S = 90;
const EXHAUST_VELOCITY = 3300;
const ACOUSTIC_EFFICIENCY = 0.005;

interface Sample {
  t: number;
  pos: V3;
  /** Sound power, W. */
  power: number;
}

export interface Heard {
  /** Received sound pressure level, dB (-Infinity for silence). */
  level: number;
  /** Distance to the loudest source when its sound left it, m. */
  distance: number;
}

/** Sound power of a plume from thrust (N) and the ambient pressure ratio (p / p0) at the source. */
export function plumePower(thrust: number, pressureRatio: number): number {
  // Jet noise comes from the exhaust mixing with the air: little air, little noise.
  return ACOUSTIC_EFFICIENCY * 0.5 * thrust * EXHAUST_VELOCITY * Math.min(1, pressureRatio);
}

export class SoundField {
  private sources = new Map<string, Sample[]>();

  /** Record a source's state at simulation time t (call every frame, even when silent). */
  record(id: string, t: number, pos: V3, power: number): void {
    let h = this.sources.get(id);
    if (!h) this.sources.set(id, (h = []));
    // Time went backwards (reset): start over.
    if (h.length && t < h[h.length - 1].t) h.length = 0;
    if (h.length && t === h[h.length - 1].t) h[h.length - 1] = { t, pos, power };
    else h.push({ t, pos, power });
    while (h.length > 2 && h[0].t < t - HISTORY_S) h.shift();
  }

  /**
   * Call after recording a frame at time t. Sources that stopped being recorded (a stack that
   * just separated, a destroyed vehicle) fall silent from their last sample on; they are forgotten
   * once that has been heard everywhere. Histories from before a reset (in the future) go too.
   */
  prune(t: number): void {
    for (const [id, h] of this.sources) {
      const last = h[h.length - 1];
      if (!last || last.t > t + 1 || last.t < t - HISTORY_S) this.sources.delete(id);
      else if (last.t < t && last.power > 0) h.push({ t: last.t + 1e-3, pos: last.pos, power: 0 });
    }
  }

  clear(): void {
    this.sources.clear();
  }

  hear(t: number, listener: V3): Heard {
    let total = 0;
    let loudest = 0;
    let distance = Infinity;
    for (const h of this.sources.values()) {
      if (!h.length) continue;
      // Fixed-point iteration for the retarded time (converges fast: sources move << c).
      let te = t;
      let s = this.at(h, te);
      for (let i = 0; i < 4; i++) {
        te = t - dist(s.pos, listener) / SPEED_OF_SOUND;
        s = this.at(h, te);
      }
      if (te < h[0].t || s.power <= 0) continue;
      const r = Math.max(10, dist(s.pos, listener));
      // Intensity at r (W/m^2), with ~0.5 dB/km of low-frequency air absorption.
      const intensity = (s.power / (4 * Math.PI * r * r)) * 10 ** (-r / 20000);
      total += intensity;
      if (intensity > loudest) {
        loudest = intensity;
        distance = r;
      }
    }
    return { level: total > 0 ? 10 * Math.log10(total / 1e-12) : -Infinity, distance };
  }

  private at(h: Sample[], t: number): Sample {
    if (t <= h[0].t) return h[0];
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    let lo = 0;
    let hi = h.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (h[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = h[lo];
    const b = h[hi];
    const f = (t - a.t) / (b.t - a.t);
    return {
      t,
      pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * f, a.pos[1] + (b.pos[1] - a.pos[1]) * f, a.pos[2] + (b.pos[2] - a.pos[2]) * f],
      power: a.power + (b.power - a.power) * f,
    };
  }
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
