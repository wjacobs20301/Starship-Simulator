import { describe, expect, it } from 'vitest';
import { HIGHWAY_4, ROAD_CLEAR, SITE_OUTLINE, distanceToLine, outlineRoadClearance } from '../src/render/siteOutline';

// The launch site's slab and the fill round it are laid over the aerial imagery. Highway 4 runs
// along the site's north side, in that imagery: nothing of the site's ground may lie on it.
describe('the launch site keeps off Highway 4', () => {
  it('the outline stands clear of the road, with room for the fill round it', () => {
    expect(outlineRoadClearance()).toBeGreaterThanOrEqual(ROAD_CLEAR);
  });

  it('the road is north of the site all the way along it', () => {
    for (const [e, n] of SITE_OUTLINE) {
      // (The road's height at this easting.)
      let road = NaN;
      for (let i = 0; i + 1 < HIGHWAY_4.length; i++) {
        const [a, b] = [HIGHWAY_4[i], HIGHWAY_4[i + 1]];
        if (e >= a[0] && e <= b[0]) road = a[1] + ((b[1] - a[1]) * (e - a[0])) / (b[0] - a[0]);
      }
      expect(Number.isFinite(road)).toBe(true);
      expect(n).toBeLessThan(road);
    }
  });

  it('a slab drawn up to the road again would be caught', () => {
    // (The outline as it was: its north side on the road's verge.)
    const was: [number, number][] = [[-445, -18], [130, -82], [130, 118], [60, 136], [-55, 166], [-200, 205], [-334, 228], [-445, 212]];
    expect(outlineRoadClearance(was)).toBeLessThan(ROAD_CLEAR);
    expect(distanceToLine([-334, 228], HIGHWAY_4)).toBeLessThan(6);
  });
});
