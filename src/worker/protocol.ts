import type { PilotCommand } from '../sim/pilot';
import type { FlightOptions, ManeuverNode, MenuScene, MissionStart, SimEvent, Snapshot } from '../sim/simulation';
import type { ReturnTarget } from '../sim/shipReturn';
import type { Trajectory } from '../sim/trajectory';
import type { WeatherConfig } from '../weather/model';
import type { SavedFlight } from './savedFlight';

export type { SavedFlight };

export type ToWorker =
  | { type: 'launch' }
  /**
   * Back to the stack on the pad (and which pad: 0 = Pad 1, 1 = Pad 2; default the last), or run
   * ahead to a mission's start; boosterOcean: land the booster on the Gulf there (pad ENU m);
   * options: the flight's (payload, parking orbit, engine failures...).
   */
  | { type: 'reset'; pad?: number; start?: MissionStart; boosterOcean?: [number, number] | null; options?: FlightOptions }
  /** A main-menu backdrop (from a reset). */
  | { type: 'scene'; kind: MenuScene; /** The pad the stack stands on ('pad' scene), 0 = Pad 1. */ pad?: number }
  | { type: 'warp'; value: number }
  | { type: 'pause'; value: boolean }
  /** Tower arms: lift +1 up / -1 down / 0 stop; swing +1 open / -1 close / 0 stop. */
  | { type: 'arms'; pad: number; lift: -1 | 0 | 1 | null; swing: -1 | 0 | 1 | null; slew?: -1 | 0 | 1 | null }
  /** Player controls (manual flight). */
  | { type: 'pilot'; cmd: Partial<PilotCommand> }
  /** Player staging. */
  | { type: 'stage' }
  /** Start, hold or resume the Starlink deployment (B). */
  | { type: 'deploy' }
  /** Plan / change / delete the maneuver node. */
  | { type: 'node'; node: ManeuverNode | null }
  /** Ship: go home (tower / ocean target) under autopilot, or cancel (null). */
  | { type: 'return'; target: ReturnTarget | null }
  /** The weather (the same as the renderer's): its wind acts on the vehicles. null: still air. */
  | { type: 'weather'; cfg: WeatherConfig | null; land: Uint8Array | null }
  /** Speed time up until just before the maneuver node's burn / the autopilot's next event, then back to 1x. */
  | { type: 'warpTo'; target: WarpTarget }
  /** Ask for the flight as it is now, to keep and load later: answered by a 'saved' message. */
  | { type: 'save' }
  /**
   * Take up a saved flight (the answer to an earlier 'save', kept as JSON), in place of whatever
   * is flying: answered by 'loaded', or 'loadFailed' (the flight in progress then carries on
   * untouched). The flight comes back with its own weather's wind and at 1x (any warp is
   * dropped; paused stays as it is). Like a 'reset' it counts as a scene: the snapshots' sceneId
   * goes up by one once it has been handled, loaded or not. land: the land mask, as in 'weather'
   * (needed only if no 'weather' message has brought it yet).
   */
  | { type: 'load'; data: SavedFlight; land?: Uint8Array | null };

export type WarpTarget = 'node' | 'next';

/** The world as it is now, ~60 times a second. */
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

/** The answers to 'save' and 'load'. */
export type SaveReply =
  /** The flight as it was when asked (plain JSON: JSON.stringify it into localStorage / IndexedDB). */
  | { type: 'saved'; data: SavedFlight }
  /**
   * The saved flight is now the one flying. events: its whole log so far (the snapshots only
   * carry what's logged from here on); weather: the weather it flies in (the renderer should show
   * the same).
   */
  | { type: 'loaded'; events: SimEvent[]; weather: WeatherConfig | null }
  /** The save couldn't be loaded (and why, in words): nothing has changed. */
  | { type: 'loadFailed'; reason: string };

/** Everything the worker posts: a snapshot every tick, and the answers to 'save' / 'load'. */
export type WorkerMessage = FromWorker | SaveReply;
