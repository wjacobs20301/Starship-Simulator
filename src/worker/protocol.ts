import type { PilotCommand } from '../sim/pilot';
import type { ManeuverNode, MenuScene, MissionStart, Snapshot } from '../sim/simulation';
import type { ReturnTarget } from '../sim/shipReturn';
import type { Trajectory } from '../sim/trajectory';

export type ToWorker =
  | { type: 'launch' }
  /**
   * Back to the stack on the pad (and which pad: 0 = Pad 1, 1 = Pad 2; default the last), or run
   * ahead to a mission's start; boosterOcean: land the booster on the Gulf there (pad ENU m).
   */
  | { type: 'reset'; pad?: number; start?: MissionStart; boosterOcean?: [number, number] | null }
  /** A main-menu backdrop (from a reset). */
  | { type: 'scene'; kind: MenuScene }
  | { type: 'warp'; value: number }
  | { type: 'pause'; value: boolean }
  /** Tower arms: lift +1 up / -1 down / 0 stop; swing +1 open / -1 close / 0 stop. */
  | { type: 'arms'; pad: number; lift: -1 | 0 | 1 | null; swing: -1 | 0 | 1 | null; slew?: -1 | 0 | 1 | null }
  /** Player controls (manual flight). */
  | { type: 'pilot'; cmd: Partial<PilotCommand> }
  /** Player staging. */
  | { type: 'stage' }
  /** Plan / change / delete the maneuver node. */
  | { type: 'node'; node: ManeuverNode | null }
  /** Ship: go home (tower / ocean target) under autopilot, or cancel (null). */
  | { type: 'return'; target: ReturnTarget | null }
  /** Speed time up until just before the maneuver node's burn / the autopilot's next event, then back to 1x. */
  | { type: 'warpTo'; target: WarpTarget };

export type WarpTarget = 'node' | 'next';

export type FromWorker = {
  type: 'snapshot';
  snapshot: Snapshot;
  warp: number;
  /** Warp actually running: capped at the physics limit unless on rails. */
  effectiveWarp: number;
  /** Whether the warp is on rails. */
  rails: boolean;
  paused: boolean;
  /** How many menu scenes have been set up (so the menu knows when the latest is ready). */
  sceneId: number;
  /** Warping ahead to this (and when it'll stop, sim time), or null. */
  warpTo: { target: WarpTarget; at: number } | null;
  /** Predicted trajectories, attached only when recomputed (a few times a second). */
  trajectories?: Trajectory[];
};
