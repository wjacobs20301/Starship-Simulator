// The launch site's outline, and the road it must keep off. (By themselves, with nothing of the
// renderer's: a test reads them, tests/siteRoad.test.ts.)
//
// Coordinates: pad-local east / north metres (origin at the Pad 1 launch mount, ground level).

import { HIGHWAY_4_EAST, HIGHWAY_4_WEST } from './roadLines';

/**
 * Launch-site outline, (east, north) m, counter-clockwise. Traced over NOAA's January 2026
 * survey (scripts/terrain/build-noaa.ts), which is the ground round it: the fence down the west
 * side to the pond in its corner, Pad 2's apron along its retaining wall, the drive round the
 * head of the inlet between the pads, and the lot of the building south of the tank farm. (A
 * plain rectangle before, from the 2022 imagery, when Pad 2 was sand: it lay over the inlet and
 * the marsh west of the fence.) Round Pad 1 it is wider than the survey has it: that pad was
 * being rebuilt then, its mount taken away, and the mount and trench here stand on what was
 * still sand beyond the wall.
 *
 * Its north side runs along Highway 4, which is in the aerial imagery and stays in it: the
 * edge stands ROAD_CLEAR back from the road's centre line, so that neither the slab nor the
 * sloped fill round it (EDGE wide) lies on the road. (It ran 4 to 11 m from the centre line,
 * and the fill and its apron, added later, buried the road for the whole length of the site.
 * Then the road's line was one traced by eye off the photo, up to 5 m out: the outline is set
 * against OpenStreetMap's now.)
 */
export const SITE_OUTLINE: [number, number][] = [
  [-394, -1],
  [-367, 14],
  [-332, 29],
  [-312, 39],
  [-292, 42],
  [-270, 52],
  [-249, 67],
  [-220, 91],
  [-193, 84],
  [-181, 48],
  [-181, 29],
  [-175, 16],
  [-154, 3],
  [-142, 3],
  [-128, -6],
  [-126, -14],
  [-102, -9],
  [-83, -17],
  [-78, -22],
  [-78, -82],
  [130, -82],
  [130, 107],
  [60, 126],
  [-55, 157],
  [-200, 191],
  [-334, 213],
  [-445, 202],
];

/**
 * Width of the bank round the slab, m: down from its edge into the ground about it. (Nine metres
 * of gentle fill before; the site's edge is a retaining wall, and where the ground falls away
 * under so shallow a bank its foot wandered metres in and out with every triangle of the
 * terrain: a saw's edge down the slanted west fence.)
 */
export const SITE_EDGE = 3;

/** Highway 4 past the launch site: its centre line (east, north; m), west to east (roadLines.ts: OpenStreetMap's). */
export const HIGHWAY_4: [number, number][] = [...HIGHWAY_4_WEST.filter(([e]) => e > -900), ...HIGHWAY_4_EAST];
/** Half the road's width with its shoulders, m. */
export const ROAD_HALF = 6;
/** The least the outline may stand from the road's centre line, m: the road, the fill's edge, a metre of verge. */
export const ROAD_CLEAR = ROAD_HALF + 9 + 1;

/** How far a point (east, north) is from a line of points, m. */
export function distanceToLine(p: readonly [number, number], line: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.min(1, Math.max(0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** The outline's least distance from the road's centre line, m (sampled every 2 m along it). */
export function outlineRoadClearance(outline: readonly (readonly [number, number])[] = SITE_OUTLINE): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k <= n; k++) best = Math.min(best, distanceToLine([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], HIGHWAY_4));
  }
  return best;
}
