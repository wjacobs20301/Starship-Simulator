// The map view's marks (the vehicles, the ship's return target, the mission's landing target) and
// the landing target's beacon in the world. (Moved out of main.ts: its targetMarker / shownTarget
// and the frame step mapStep.)

import type { FlightView } from '../game/flightView';
import type { MissionDef, MissionTarget } from '../game/missions';
import type { Snapshot } from '../sim/simulation';
import type { GameMenu } from '../ui/gameMenu';
import type { ReturnPanel } from '../ui/returnPanel';
import type { CameraRig } from './cameras';
import type { FloatingOrigin } from './floatingOrigin';
import type { FxVehicle } from './fx/launchFx';
import type { MapVehicle, MapView } from './mapView';
import type { World } from './scene';
import { TargetMarker } from './targetMarker';

export interface MapMarksDeps {
  world: World;
  origin: FloatingOrigin;
  rig: CameraRig;
  mapView: MapView;
  menu: Pick<GameMenu, 'kind'>;
  /** The mission (its landing target). */
  tracker: { readonly mission: MissionDef };
  /** The ocean return point picked (shown while coasting). */
  returnPanel: Pick<ReturnPanel, 'ocean'>;
  /** The tracked vehicle (marked on the map). */
  flight: FlightView;
}

export interface MapMarks {
  /** The map view, its marks, and the mission's landing target beacon: that target (null in the main menu). */
  mapStep(snap: Snapshot, placements: FxVehicle[], simTime: number, now: number): MissionTarget | null;
}

/** Puts the landing target's beacon in the scene now. */
export function createMapMarks(deps: MapMarksDeps): MapMarks {
  const { world, origin, rig, mapView, menu, tracker, returnPanel, flight } = deps;
  /** The mission's landing target beacon (and which target it's showing). */
  const targetMarker = new TargetMarker();
  world.scene.add(targetMarker.group);
  let shownTarget: MissionTarget | null = null;

  function mapStep(snap: Snapshot, placements: FxVehicle[], simTime: number, now: number): MissionTarget | null {
    if (mapView.visible !== rig.map) mapView.setVisible(rig.map);
    const mapVehicles: MapVehicle[] = placements
      .filter((pl) => pl.snap.status !== 'destroyed')
      .map((pl) => ({ id: pl.snap.id, name: pl.snap.name, world: pl.world, altitude: pl.snap.telemetry.altitude }));
    const ret = snap.shipReturn;
    const returnMarks = ret
      ? [
          { ...ret.targetLatLon, cls: 'mark return', html: `<i></i><span>${ret.target.kind === 'tower' ? `Pad ${ret.target.pad + 1} tower` : 'Return target'}</span>` },
          ...(ret.predicted ? [{ lat: ret.predicted.lat, lon: ret.predicted.lon, cls: 'mark impact', html: '<i></i><span>Guidance landing</span>' }] : []),
        ]
      : snap.phase === 'coast' && rig.map
        ? [{ ...returnPanel.ocean, cls: 'mark return', html: '<i></i><span>Ocean return point</span>' }]
        : [];
    // The mission's landing target: a beacon in the world, a mark on the map.
    const missionTarget = menu.kind === 'main' ? null : (tracker.mission.target ?? null);
    if (missionTarget !== shownTarget) {
      shownTarget = missionTarget;
      targetMarker.set(missionTarget);
    }
    targetMarker.update(origin, now / 1000);
    if (missionTarget) returnMarks.push({ lat: missionTarget.lat, lon: missionTarget.lon, cls: 'mark return', html: `<i></i><span>${missionTarget.label}</span>` });
    mapView.update(origin, world.camera, simTime, mapVehicles, flight.trackedId, returnMarks);
    return missionTarget;
  }

  return { mapStep };
}
