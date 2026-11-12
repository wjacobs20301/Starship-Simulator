// The player's controls for manual flight: the command mirrored to the sim's Pilot, the vehicles
// taken over by hand, held keys turned into attitude and throttle, and the keys that switch them.
// (Moved out of main.ts: its "Player controls (manual flight)" section and updatePilot.)

import { type PilotCommand, activeStageId } from '../sim/pilot';
import type { Snapshot } from '../sim/simulation';
import { flightAxes } from '../ui/input';
import type { ToWorker } from '../worker/protocol';

export interface PilotControlsDeps {
  /** The newest snapshot (null before the first). */
  snap(): Snapshot | null;
  /** The vehicle on screen (the one the controls are for), and changing it. */
  tracked(): string;
  setTracked(id: string): void;
  /** The worker has caught up with the last scene / mission set-up asked for. */
  workerReady(): boolean;
  send(m: ToWorker): void;
  /** A saved flight is coming up: the controls are to be taken from its first snapshot (and then have been). */
  adoptPending(): boolean;
  adoptDone(): void;
}

export interface PilotControls {
  /** The player's controls as they are (change them with set). */
  readonly cmd: Readonly<PilotCommand>;
  /** Change the controls; sent to the sim on the next update. */
  set(patch: Partial<PilotCommand>): void;
  /** Vehicles the player has taken the controls of (the others fly on autopilot). */
  readonly manualVehicles: Set<string>;
  /** Take over the tracked vehicle as it is flying right now. */
  takeOver(): { throttle: number; engines: number };
  /** Each frame: held keys -> the player's attitude / throttle inputs; send any change to the sim. */
  update(dt: number): void;
  // The keys (ui/input.ts InputActions).
  toggleManual(): void;
  toggleSas(): void;
  cycleEngines(): void;
  throttleFull(): void;
  throttleCut(): void;
}

export function createPilotControls(deps: PilotControlsDeps): PilotControls {
  /** The player's controls; mirrored to the sim's Pilot whenever they change. */
  const pilot: PilotCommand = { manual: false, target: 'stack', pitch: 0, yaw: 0, roll: 0, throttle: 1, sas: 'stability', engines: 0 };
  let pilotDirty = true;
  const setPilot = (patch: Partial<PilotCommand>) => {
    Object.assign(pilot, patch);
    pilotDirty = true;
  };
  /** Vehicles the player has taken the controls of (the others fly on autopilot). */
  const manualVehicles = new Set<string>();
  /** Throttle ramp while Shift / Ctrl are held, per second. */
  const THROTTLE_RATE = 0.6;

  /** The flown vehicle's current mean throttle on its lit engines (0 if none). */
  function currentThrottle(): number {
    const v = deps.snap()?.vehicles.find((x) => x.id === deps.tracked());
    if (!v) return 0;
    if (v.status === 'held') return 1;
    const t = v.stageState[activeStageId(v.stages)]?.throttles.filter((x) => x > 0.02) ?? [];
    return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0;
  }

  /** The engine set matching what's lit on the tracked vehicle (so taking over doesn't relight everything). */
  function currentEngineSet(): number {
    const v = deps.snap()?.vehicles.find((x) => x.id === deps.tracked());
    if (!v || v.status === 'held') return 0;
    const lit = (v.stageState[activeStageId(v.stages)]?.throttles ?? []).filter((x) => x > 0.02).length;
    if (activeStageId(v.stages) === 'booster') return lit === 0 || lit > 13 ? 0 : lit > 3 ? 1 : 2;
    return lit === 0 || lit > 3 ? 0 : 1;
  }

  /** Take over the tracked vehicle as it is flying right now. */
  const takeOver = () => ({ throttle: currentThrottle(), engines: currentEngineSet() });

  /** Held keys -> the player's attitude / throttle inputs; send any change to the sim. */
  function updatePilot(dt: number): void {
    // A saved flight coming up: nothing sent until it's here, then the controls as it has them.
    if (deps.adoptPending()) {
      const snap = deps.snap();
      if (!deps.workerReady() || !snap) return;
      const p = snap.pilot;
      Object.assign(pilot, { manual: p.manual, target: p.target, pitch: 0, yaw: 0, roll: 0, throttle: p.throttle, sas: p.sas, engines: p.engines });
      if (p.manual) deps.setTracked(p.target);
      pilotDirty = false;
      deps.adoptDone();
    }
    const axes = flightAxes();
    if (pilot.manual) {
      if (axes.pitch !== pilot.pitch || axes.yaw !== pilot.yaw || axes.roll !== pilot.roll) {
        setPilot({ pitch: axes.pitch, yaw: axes.yaw, roll: axes.roll });
      }
      if (axes.throttle !== 0) setPilot({ throttle: Math.min(1, Math.max(0, pilot.throttle + axes.throttle * THROTTLE_RATE * dt)) });
    } else if (pilot.pitch || pilot.yaw || pilot.roll) {
      setPilot({ pitch: 0, yaw: 0, roll: 0 });
    }
    if (pilot.target !== deps.tracked() && deps.workerReady()) setPilot({ target: deps.tracked(), ...takeOver() });
    if (pilotDirty) {
      deps.send({ type: 'pilot', cmd: { ...pilot } });
      pilotDirty = false;
    }
  }

  return {
    cmd: pilot,
    set: setPilot,
    manualVehicles,
    takeOver,
    update: updatePilot,
    toggleManual: () => {
      // Taking the controls from the return autopilot pauses it; handing them back resumes it
      // from wherever the ship is by then (Cancel in the Return panel ends it).
      setPilot({ manual: !pilot.manual, ...takeOver() });
      if (pilot.manual) manualVehicles.add(deps.tracked());
      else manualVehicles.delete(deps.tracked());
    },
    toggleSas: () => setPilot({ sas: pilot.sas === 'off' ? 'stability' : 'off' }),
    cycleEngines: () => setPilot({ engines: (pilot.engines + 1) % 3 }),
    throttleFull: () => setPilot({ throttle: 1 }),
    throttleCut: () => setPilot({ throttle: 0 }),
  };
}
