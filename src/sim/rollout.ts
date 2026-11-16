// Rollout: a vehicle on its transport (a stand on two self-propelled trailers) from the
// Starfactory along Highway 4 to the launch site, in at its east gate by the roundabout and
// across the slab to the stand beside the pad's mount, where the tower's arms can take it.
//
// Here: the way it goes (pad ENU, horizontal), and where it is along it. The highway is
// OpenStreetMap's line (render/roadLines.ts: plain data); the way across the launch site is laid
// over NOAA's 2026 survey, clear of the tank farm, the buildings and the flame trenches: the
// east drive in from the roundabout, along the south side of the tank farm, and up to the stand
// beside the mount's wall (for Pad 2, on by the drive round the head of the inlet between the
// pads). Approximate: the real route across the site isn't published.

import { HIGHWAY_4_WEST } from '../render/roadLines';
import { PAD, PAD2 } from './constants';
import { STANDS } from './padCollision';

/** How fast the transport goes, m/s (the real ones walk; this is a brisk 22 km/h), how hard it starts and stops, and its crawl onto the stand. */
export const ROLL = { speed: 6, accel: 0.4, crawl: 1.2, crawlFor: 30 };

/** Where the highway is left for the site's east drive, then the way to the south side of the tank farm (east, north; m). */
const INTO_SITE: [number, number][] = [
  [158, 114],
  [139, 68],
  [115, 31],
  [90, 62],
  [40, 75],
];
/** From there to Pad 2's apron: west past the tank farm and round the head of the inlet. */
const TO_PAD_2: [number, number][] = [
  [-60, 78],
  [-118, 72],
  [-170, 86],
  [-215, 100],
  [-262, 80],
];

/** The way to a pad's stand: its points (east, north; m), from the Starfactory's gate on the highway. */
export function rolloutRoute(pad: number): [number, number][] {
  const from = HIGHWAY_4_WEST.findIndex(([e]) => e > -2960);
  const stand = STANDS[pad];
  const a = ((pad === 0 ? PAD : PAD2).trench.axisDeg * Math.PI) / 180;
  // (Onto the stand's place along the mount's wall: parallel to the trench, from its open end.)
  const run = pad === 0 ? 35 : 46;
  const lead: [number, number] = [stand.at[0] + Math.cos(a) * run, stand.at[1] + Math.sin(a) * run];
  return [...HIGHWAY_4_WEST.slice(from).map(([e, n]) => [e, n] as [number, number]), ...INTO_SITE, ...(pad === 1 ? TO_PAD_2 : []), lead, stand.at];
}

export function routeLength(route: readonly (readonly [number, number])[]): number {
  let len = 0;
  for (let i = 0; i + 1 < route.length; i++) len += Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
  return len;
}

/** The point `s` metres along a route, and the way the route runs there (rad from east; eased round its corners). */
export function routeAt(route: readonly (readonly [number, number])[], s: number): { e: number; n: number; heading: number } {
  const at = (d: number): [number, number] => {
    let left = Math.max(0, d);
    for (let i = 0; i + 1 < route.length; i++) {
      const [a, b] = [route[i], route[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (left <= len || i + 2 === route.length) {
        const k = len > 0 ? Math.min(1, left / len) : 0;
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      }
      left -= len;
    }
    return [route[0][0], route[0][1]];
  };
  const total = routeLength(route);
  const p = at(s);
  // (Its heading from a trailer's length of the way: round a corner it comes round with it.)
  const [back, ahead] = [at(Math.max(0, Math.min(total - 12, s - 6))), at(Math.max(12, Math.min(total, s + 6)))];
  return { e: p[0], n: p[1], heading: Math.atan2(ahead[1] - back[1], ahead[0] - back[0]) };
}
