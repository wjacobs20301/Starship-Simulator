// The flight on screen as main.ts and the modules split out of it (game/skyState.ts,
// render/vehicleMeshes.ts, game/missionFlow.ts, ui/preparing.ts, audio/flightSound.ts) share it:
// one small state object, made once in main.ts and handed to each. (Moved out of main.ts: its
// module-level trackedId, satFocus, paused, launchPad, scenesSent and workerSceneId.)

export interface FlightView {
  /** The vehicle the cameras (and the player's controls) are on, by id. */
  trackedId: string;
  /** A Starlink the cameras follow instead (V steps on to them after the vehicles), by its number. */
  satFocus: number | null;
  /** The sim is paused (as the worker last said). */
  paused: boolean;
  /** The pad the flight starts from (0 = Pad 1); the arrow keys drive its arms. */
  launchPad: number;
  /** Menu scenes asked for, and the worker's count of those it has set up. */
  scenesSent: number;
  workerSceneId: number;
}

export function createFlightView(): FlightView {
  return { trackedId: 'stack', satFocus: null, paused: false, launchPad: 0, scenesSent: 0, workerSceneId: 0 };
}

/** The worker has caught up with the last scene / mission set-up asked for. */
export function workerCaughtUp(f: FlightView): boolean {
  return f.workerSceneId >= f.scenesSent;
}
