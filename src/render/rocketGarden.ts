// The rocket garden by the Mega Bays: retired vehicles standing on display (B12 and S20 in
// OpenStreetMap). They're the real booster and ship models (the flight vehicles' shapes and
// materials, shared), at their coarsest detail level: they're usually seen from kilometres away.

import * as THREE from 'three';
import { DETAIL_LEVELS, type ModelLibrary } from './models';

export interface GardenVehicle {
  kind: 'booster' | 'ship';
  /** Base position in render world (pad-local: x = E, y = U, z = -N), m. */
  pos: [number, number, number];
}

export function rocketGarden(lib: ModelLibrary, vehicles: GardenVehicle[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Rocket garden';
  for (const v of vehicles) {
    const model = (v.kind === 'booster' ? lib.booster : lib.ship).clone(true);
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const levels = DETAIL_LEVELS.get(o.geometry);
      if (levels?.length) o.geometry = levels[levels.length - 1].geometry;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    model.position.set(...v.pos);
    group.add(model);
  }
  return group;
}
