// Rollout: a vehicle on its transport (a stand on two self-propelled trailers) from the
// Starfactory along Highway 4 to the launch site, in at its east gate by the roundabout and
// across the slab to the stand beside the pad's mount, where the tower's arms can take it.
//
// Here: the way it goes (pad ENU, horizontal), and where it is along it. The highway is
// OpenStreetMap's line (render/roadLines.ts: plain data); the way across the launch site is laid
// over NOAA's 2026 survey, clear of the tank farm and its pipe rack, the buildings and the flame
// trenches (tests/rollout.test.ts holds it to that): the east drive in from the roundabout, west
// across the open slab south of the tank farm, and up to the stand beside the mount's wall (for
// Pad 2, on past Pad 1 and round the head of the inlet between the pads). Approximate: the real
// route across the site isn't published.

import { HIGHWAY_4_WEST } from '../render/roadLines';
import { PAD, PAD2 } from './constants';
import { STANDS } from './padCollision';

/** How fast the transport goes, m/s (the real ones walk; this is a brisk 22 km/h), how hard it starts and stops, and its crawl onto the stand. */
export const ROLL = { speed: 6, accel: 0.4, crawl: 1.2, crawlFor: 30 };

/**
 * Where the highway is left for the site's east drive, down it onto the slab, and west across
 * the open slab toward Pad 1's mount (east, north; m). Well south of the tank farm: its tanks'
 * ends, the blast wall along them and the pipe rack on the wall's pad side reach to about
 * n = 60 here, and the transport is 13 m wide. (It went along n = 75 before, through the ends
 * of the tanks and the rack.)
 */
const INTO_SITE: [number, number][] = [
  [158, 114],
  [139, 68],
  [122, 44],
  [60, 41],
];
/**
 * From there to Pad 2's apron: on west between the tank farm's pipe rack and Pad 1 (over the
 * lines from the rack to Pad 1's tower, which go under plates where the way crosses them:
 * render/facilities.ts), along under the western tanks' rack as it climbs north-west, through
 * the gap between the buildings and the head of the inlet, and down to the apron.
 */
const TO_PAD_2: [number, number][] = [
  [22, 49],
  [-26, 53],
  [-62, 57],
  [-112, 69],
  [-160, 84],
  [-190, 96],
  [-216, 99],
  [-242, 92],
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
