// Starbase buildings OpenStreetMap doesn't have, or our copy of it didn't, added to its footprints
// (facilities.ts). Traced over the aerial imagery (2022) or from current OpenStreetMap; positions
// are pad-local east / north metres, `base` the ground height above the ellipsoid like the rest.

/** Axis of the long sheds and the Starfactory (east / north unit vector along their length), and across. */
const U: [number, number] = [0.714, 0.7];
const V: [number, number] = [0.7, -0.714];

/** A rotated rectangle's ring from its north-east / north-west corner, length (back along U) and width (along V). */
function rect(corner: [number, number], length: number, width: number): number[][] {
  const [e, n] = corner;
  const p = (a: number, b: number) => [e - U[0] * a + V[0] * b, n - U[1] * a + V[1] * b];
  return [p(0, 0), p(0, width), p(length, width), p(length, 0), p(0, 0)];
}

export interface ExtraFacility {
  kind: 'building';
  name: string;
  ring: number[][];
  center: number[];
  base: number;
  height: number;
  material: 'industrial';
  /** A gable roof along the long axis, rising this much above the eaves (height), m. */
  gable?: number;
  /** Drawn as an office / parking structure (window or opening ribbons). */
  office?: boolean;
}

const centre = (ring: number[][]) => {
  const pts = ring.slice(0, -1);
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
};

const make = (f: Omit<ExtraFacility, 'center' | 'kind' | 'material'>): ExtraFacility => ({ kind: 'building', material: 'industrial', center: centre(f.ring), ...f });

export const EXTRA_FACILITIES: ExtraFacility[] = [
  // The Starfactory: a steel frame in the 2022 imagery, since clad and finished.
  make({ name: 'Starfactory', ring: [[-3279, -848], [-3224, -902], [-3305, -983], [-3361, -929], [-3279, -848]], base: 1.5, height: 30 }),
  // The three long gable-roofed production sheds south of it.
  make({ name: 'Production shed', ring: rect([-3222, -905], 150, 56), base: 1.5, height: 16, gable: 6 }),
  make({ name: 'Production shed', ring: rect([-3172, -955], 190, 56), base: 1.5, height: 16, gable: 6 }),
  make({ name: 'Production shed', ring: rect([-3125, -1003], 190, 56), base: 1.5, height: 16, gable: 6 }),
  // Multi-storey parking garage (current OpenStreetMap).
  make({
    name: 'Parking garage',
    ring: [[-3171.5, -698.3], [-3170.6, -690.1], [-3175.8, -689.5], [-3170.0, -638.6], [-3058.4, -651.1], [-3065.1, -710.3], [-3171.5, -698.3]],
    base: 1.9,
    height: 17,
    office: true,
  }),
];
