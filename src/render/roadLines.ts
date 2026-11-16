// Highway 4 (Boca Chica Boulevard) from the production site out to the beach, past the launch
// site: its centre line, from OpenStreetMap (© OpenStreetMap contributors, ODbL). By itself, with
// nothing of the renderer's: the site's outline is checked against it (tests/siteRoad.test.ts) and
// the road is painted on the ground along it (roads.ts).
//
// Coordinates: pad-local east / north metres (origin at the Pad 1 launch mount, ground level).

/** From the production site east to the roundabout at the launch site's gate (west to east). */
export const HIGHWAY_4_WEST: [number, number][] = [
  [-2759.5, -646.2],
  [-2740.0, -624.3],
  [-2718.7, -603.8],
  [-2705.5, -591.9],
  [-2671.7, -566.8],
  [-2646.4, -550.6],
  [-2623.3, -537.7],
  [-2598.9, -525.8],
  [-2575.4, -516.1],
  [-2547.2, -506.3],
  [-2507.3, -495.0],
  [-2204.0, -415.7],
  [-2179.4, -409.5],
  [-2132.4, -399.2],
  [-1988.9, -373.0],
  [-1917.3, -357.5],
  [-1870.7, -345.6],
  [-1842.6, -337.8],
  [-1800.7, -325.2],
  [-1754.3, -309.9],
  [-1708.5, -293.3],
  [-1287.6, -132.8],
  [-1081.4, -61.3],
  [-1035.5, -44.6],
  [-735.4, 72.3],
  [-706.9, 85.3],
  [-671.6, 104.5],
  [-548.6, 181.3],
  [-528.0, 192.9],
  [-514.9, 199.7],
  [-491.9, 209.9],
  [-465.7, 219.3],
  [-447.1, 224.7],
  [-422.4, 230.3],
  [-399.6, 233.9],
  [-385.1, 235.3],
  [-364.6, 236.0],
  [-343.8, 235.6],
  [-313.2, 232.9],
  [-275.9, 225.7],
  [-194.5, 207.2],
  [149.5, 127.5],
];

/** The roundabout at the gate: its centre and the radius of its one lane's centre line, m. */
export const ROUNDABOUT = { center: [163.2, 124.2] as [number, number], radius: 13.8 };

/** From the roundabout on east to the beach. */
export const HIGHWAY_4_EAST: [number, number][] = [
  [176.5, 121.3],
  [375.6, 75.4],
];

/** Half the highway's paved width (two lanes of 3.65 m), and the roundabout's lane's, m. */
export const ROAD_PAVED_HALF = 3.65;
export const RING_PAVED_HALF = 3.0;
