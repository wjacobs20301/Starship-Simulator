// A mission's flow once its flight is set up: the launch, the hand-overs its events drive (the
// camera to the booster, the ship home, normal speed for the deployment), the scoring, and the
// options a new flight is set up with. (Moved out of main.ts: its startMission, followMission and
// flightOptions.)

import { settings } from '../settings';
import type { ReturnTarget } from '../sim/shipReturn';
import type { FlightOptions, Snapshot } from '../sim/simulation';
import type { GameMenu } from '../ui/gameMenu';
import type { MissionUi } from '../ui/missionUi';
import type { ToWorker } from '../worker/protocol';
import type { FlightView } from './flightView';
import { type MissionSetup, type MissionTracker, SPLASH_TARGET } from './missions';
import type { PilotControls } from './pilotControls';

export interface MissionFlowDeps {
  tracker: MissionTracker;
  missionUi: Pick<MissionUi, 'hideResults' | 'showResults'>;
  menu: Pick<GameMenu, 'kind'>;
  pilotCtl: Pick<PilotControls, 'set' | 'manualVehicles'>;
  send(m: ToWorker): void;
  /** The tracked vehicle (the hand-overs change it) and the launch pad (the ship's catch tower). */
  flight: FlightView;
}

export interface MissionFlow {
  /** Launch with the selected mission's setup. */
  startMission(): void;
  /** Mission hand-overs driven by the flight's events, and scoring. */
  followMission(snap: Snapshot): void;
  /** A flight's options: the mission's setup, and the player's realism settings where it leaves them open. */
  flightOptions(setup: MissionSetup): FlightOptions;
}

export function createMissionFlow(deps: MissionFlowDeps): MissionFlow {
  const { tracker, missionUi, menu, pilotCtl, send, flight } = deps;

  function startMission(): void {
    const setup = tracker.mission.setup;
    tracker.reset();
    missionUi.hideResults();
    // (Unless the player handed the stack to the autopilot on the pad, with L.)
    if (setup.fly === 'stack' && pilotCtl.manualVehicles.has('stack')) pilotCtl.set({ manual: true, target: 'stack', sas: 'stability', throttle: 1, engines: 0 });
    send({ type: 'launch' });
  }

  function followMission(snap: Snapshot): void {
    if (menu.kind === 'main') return; // a menu backdrop, not a flight
    const setup = tracker.mission.setup;
    for (const e of snap.events) {
      // Flying the stack by hand: at separation the controls stay with the ship.
      if (e.kind === 'separation' && pilotCtl.manualVehicles.has('stack')) pilotCtl.manualVehicles.add('ship');
      // Missions about the booster: the camera goes with it at separation.
      if (setup.followBooster && e.kind === 'separation') flight.trackedId = 'booster';
      // Ship Catch: at SECO the ship heads home by itself. Time only speeds up when the player
      // warps; it drops back to normal for the flip and catch so they can be watched.
      if (setup.shipReturn && e.kind === 'seco') {
        flight.trackedId = 'ship';
        const aim = tracker.mission.target?.vehicle === 'ship' ? tracker.mission.target : SPLASH_TARGET;
        const target: ReturnTarget =
          setup.shipReturn === 'tower'
            ? setup.shipCatchSlew !== undefined
              ? { kind: 'tower', pad: flight.launchPad, slew: setup.shipCatchSlew }
              : { kind: 'tower', pad: -1 }
            : { kind: 'ocean', lat: aim.lat, lon: aim.lon };
        send({ type: 'return', target });
      }
      if (setup.shipReturn && e.kind === 'landingFlip') send({ type: 'warp', value: 1 });
      // Starlink flights: back to normal speed, the camera on the ship, for the deployment.
      if (setup.payload && e.kind === 'doorOpening') {
        flight.trackedId = 'ship';
        send({ type: 'warp', value: 1 });
      }
    }
    if (snap.phase === 'prelaunch') return;
    const result = tracker.update(snap);
    // (Over: the result once. The flight is still autosaved after, marked as over; the player's
    // own saves are theirs to delete.)
    if (result) missionUi.showResults(result);
  }

  function flightOptions(setup: MissionSetup): FlightOptions {
    return {
      // (Free roam: Starlinks if the player loaded them, deployed when they press B.)
      payload: setup.payload ?? (tracker.mission.id === 'free' && settings.freeStarlink ? 'starlink' : null),
      deploy: setup.payload ? 'auto' : 'manual',
      parkingAlt: setup.parkingAlt ?? null,
      faults: setup.faults ?? (settings.engineFailures ? 'random' : 'off'),
      faultSeed: Math.floor(Math.random() * 2 ** 31),
      tiles: settings.tileLoss ? 'random' : 'off',
      splashFireball: setup.splashFireball ?? false,
      // (Dev-only: __flightOptions overrides these for the next flight, e.g. set tiles missing.)
      ...(import.meta.env.DEV ? (window as unknown as { __flightOptions?: FlightOptions }).__flightOptions : undefined),
    };
  }

  return { startMission, followMission, flightOptions };
}
