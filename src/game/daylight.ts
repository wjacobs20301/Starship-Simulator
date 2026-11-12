// The time of day a flight starts at: chosen so that the moments worth seeing (liftoff, the
// catch, the splashdown half a world away) fall in daylight.

import * as THREE from 'three';
import { ecefToWorld, toWorld } from '../render/geo';
import { SUN_AT_DAY0 } from '../render/scene';
import { PAD } from '../sim/constants';
import type { MissionDef } from './missions';

/** The Earth turns once in 24 h of sim time (rad / s). */
export const DAY_RATE = (2 * Math.PI) / 86400;

const EARTH_CENTER_WORLD = ecefToWorld([0, 0, 0]);
const EARTH_AXIS_WORLD = new THREE.Vector3(...ecefToWorld([0, 0, 1e6])).sub(new THREE.Vector3(...EARTH_CENTER_WORLD)).normalize();

/** Where and when a mission wants daylight: at a mission time (s), or some time after its start. */
export interface DaylightAt {
  lat: number;
  lon: number;
  /** Instead of lat / lon: where the flown vehicle is at the start. */
  atVehicle?: boolean;
  missionTime?: number;
  afterStart?: number;
  /** Wants it dark there instead (the sun well below the horizon). */
  night?: boolean;
}

/** The key moments of a mission, to be in daylight: the pad at liftoff, the target on arrival. */
export function missionDaylight(m: MissionDef): DaylightAt[] | null {
  if (m.group === 'free') return null;
  const pad = { lat: PAD.latDeg, lon: PAD.lonDeg };
  const start = m.setup.start ?? 'pad';
  if (start === 'entry' && m.target) {
    // Night where the ship starts, then entry (~10-25 minutes, eastward) into the dawn and
    // daylight over the target: the sunrise line lies between.
    const { lat, lon } = m.target;
    return [
      { lat: 0, lon: 0, atVehicle: true, afterStart: 0, night: true },
      { lat, lon, afterStart: 900 },
      { lat, lon, afterStart: 1500 },
    ];
  }
  // Starting near Starbase part-way up (staging, the booster coming home).
  if (start !== 'pad') return [{ ...pad, afterStart: 0 }];
  const wants: DaylightAt[] = [{ ...pad, missionTime: 0 }];
  // The ship's splashdown on the far side of the world, ~65 minutes after liftoff.
  if (m.target?.vehicle === 'ship') wants.push({ lat: m.target.lat, lon: m.target.lon, missionTime: 3900 });
  return wants;
}
/**
 * The day angle at this flight's start that puts its key moments in daylight: the sun at least
 * ~30 degrees up at each if that can be had (or ~12 below, where it wants night), else as near
 * as they can all have it together;
 * of those, the nearest to a Starbase morning (day angle 0).
 */
export function daylightPhase(wants: DaylightAt[], missionTime: number, vehicle: { lat: number; lon: number } | null): number {
  const center = new THREE.Vector3(...EARTH_CENTER_WORLD);
  wants = wants.filter((w) => !w.atVehicle || vehicle);
  const ups = wants.map((w) => {
    const at = w.atVehicle ? vehicle! : w;
    return new THREE.Vector3(...toWorld(at.lat, at.lon, 0)).sub(center).normalize();
  });
  const q = new THREE.Quaternion();
  const sun = new THREE.Vector3();
  const score = (phase: number) =>
    Math.min(
      ...wants.map((w, i) => {
        const dt = w.missionTime !== undefined ? w.missionTime - missionTime : (w.afterStart ?? 0);
        q.setFromAxisAngle(EARTH_AXIS_WORLD, -(phase + DAY_RATE * dt));
        sun.copy(SUN_AT_DAY0).applyQuaternion(q);
        const elev = Math.asin(THREE.MathUtils.clamp(sun.dot(ups[i]), -1, 1));
        // (Enough is enough: 30 degrees up for daylight, 12 below for a dark night.)
        return w.night ? Math.min(-elev, 12 * (Math.PI / 180)) : Math.min(elev, 30 * (Math.PI / 180));
      }),
    );
  const step = Math.PI / 180;
  const tries = [0];
  for (let k = 1; k <= 180; k++) tries.push(k * step, -k * step);
  const scores = tries.map(score);
  const best = Math.max(...scores);
  return tries[scores.findIndex((x) => x >= best - 0.5 * step)];
}
