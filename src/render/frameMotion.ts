// What a frame draws the motion from: the two snapshots either side of the frame's sim time, how
// far between them, and where things are at that time. (Moved out of main.ts: its FrameMotion and
// frameMotion, the first of frame()'s steps.)

import type { Received } from '../game/viewModes';
import type { V3 } from '../sim/math';
import type { Snapshot } from '../sim/simulation';
import type { Replay } from '../ui/replay';
import { enuToWorld } from './floatingOrigin';
import type { SnapshotClock } from './snapshotClock';

/** What a frame draws the motion from (frameMotion): the snapshots either side of simTime, and how far between. */
export interface FrameMotion {
  /** The newest snapshot: everything but places, attitudes and simTime comes from it. */
  snap: Snapshot;
  from: Snapshot | null;
  to: Snapshot;
  alpha: number;
  simTime: number;
  placeAt(p: V3 | undefined, q: V3, vel: V3, ahead: number): V3;
  satPlace(s: { n: number; pos: V3 }): V3;
  /** A satellite's world position, between snapshots. */
  satWorld(n: number): V3 | null;
}

/**
 * replay: instant replay (while it plays, prev and curr are the pair it gave); motion: the live
 * snapshots' steady sim-time clock (main.ts motion).
 */
export function frameMotion(curr: Received, prev: Received | null, ts: number, now: number, replay: Pick<Replay, 'active'>, motion: SnapshotClock<Snapshot>): FrameMotion {
  // Render between snapshots so motion is smooth at any frame rate. Live: where the snapshot
  // clock is, a steady sim time a couple of snapshots behind the newest, between the two either
  // side of it (`from`, `to`), so their uneven arrival doesn't show. A replay: between the pair
  // it gave (made prev and curr above). Only places, attitudes and simTime come from these;
  // everything else is the newest snapshot's, `snap`.
  const snap = curr.snap;
  const live = replay.active ? null : motion.sample(Math.min(ts, now));
  const span = prev ? curr.at - prev.at : 0;
  const from = live ? live.a : (prev?.snap ?? null);
  const to = live ? live.b : snap;
  const alpha = live ? live.alpha : span > 0 ? Math.min(1, (now - curr.at) / span) : 1;
  const simTime = from ? from.t + (to.t - from.t) * alpha : to.t;
  /**
   * Where something is at simTime: between its places in the two snapshots (p, q); or, when it
   * isn't in the earlier one yet (a stage just separated, a satellite just out), back along its
   * velocity from the first place it's known (q, `ahead` seconds on), so it doesn't run ahead
   * of the rest for a frame or two.
   */
  const placeAt = (p: V3 | undefined, q: V3, vel: V3, ahead: number): V3 =>
    p
      ? [p[0] + (q[0] - p[0]) * alpha, p[1] + (q[1] - p[1]) * alpha, p[2] + (q[2] - p[2]) * alpha]
      : [q[0] - vel[0] * ahead, q[1] - vel[1] * ahead, q[2] - vel[2] * ahead];
  /** A satellite out of the bay, in pad ENU at simTime (one just deployed is moving as the ship is). */
  const shipVel: V3 = snap.vehicles.find((v) => v.id === 'ship')?.telemetry.vAirEnu ?? [0, 0, 0];
  const satPlace = (s: { n: number; pos: V3 }): V3 => {
    const q = to === snap ? s : to.payload?.sats.find((x) => x.n === s.n);
    const p = q && from?.payload?.sats.find((x) => x.n === s.n);
    return placeAt(p ? p.pos : undefined, (q ?? s).pos, shipVel, (q ? to.t : snap.t) - simTime);
  };
  /** A satellite's world position, between snapshots. */
  const satWorld = (n: number): V3 | null => {
    const s = snap.payload?.sats.find((x) => x.n === n);
    return s ? enuToWorld(satPlace(s)) : null;
  };
  return { snap, from, to, alpha, simTime, placeAt, satPlace, satWorld };
}
