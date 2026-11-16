// Starbase buildings OpenStreetMap doesn't have, or our copy of it didn't, added to its footprints
// (facilities.ts). Traced over the aerial imagery (2022) or from current OpenStreetMap; positions
// are pad-local east / north metres, `base` the ground height above the ellipsoid like the rest.

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
  /**
   * Part of the Starfactory: its roof is the survey's own picture of it (facilities.ts), and
   * whatever older footprint lies under it is left out.
   */
  factory?: boolean;
}

const centre = (ring: number[][]) => {
  const pts = ring.slice(0, -1);
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
};

const make = (f: Omit<ExtraFacility, 'center' | 'kind' | 'material'>): ExtraFacility => ({ kind: 'building', material: 'industrial', center: centre(f.ring), ...f });

export const EXTRA_FACILITIES: ExtraFacility[] = [
  // The Starfactory, as NOAA's January 2026 survey has it (scripts/terrain/build-noaa.ts): one
  // building some 450 m long, its roofs traced off the survey to a metre or two. (Four boxes
  // before, a quarter of its size, from when it was a steel frame and three sheds.) Heights from
  // the shadows in the survey (their length about the height at 1 pm in January): approximate.
  //   - the high bay along its north-west side, grey-roofed;
  make({ name: 'Starfactory', ring: [[-3183, -739], [-3130, -793], [-3319, -986], [-3381, -941], [-3183, -739]], base: 1.5, height: 24, factory: true }),
  //   - the low annex on that bay's north-west wall;
  make({ name: 'Starfactory', ring: [[-3244, -800], [-3265, -782], [-3300, -833], [-3286, -844], [-3244, -800]], base: 1.5, height: 12, factory: true }),
  //   - the main hall, white-roofed, with the front block and the wing along the highway.
  make({
    name: 'Starfactory',
    ring: [[-3130, -793], [-3077, -841], [-3054, -817], [-3050, -767], [-2993, -769], [-2973, -761], [-2937, -823], [-2936, -834], [-2969, -883], [-3000, -929], [-3051, -994], [-3213, -1151], [-3360, -1000], [-3319, -986], [-3130, -793]],
    base: 1.5,
    height: 17,
    factory: true,
  }),
  // The multi-storey parking garage north of the Starfactory, as NOAA's January 2026 survey has
  // it: its whole top deck, a little askew of the street. (OpenStreetMap's outline before, short
  // of the deck's north bays and its east end.)
  make({
    name: 'Parking garage',
    ring: [[-3178, -621], [-3027, -635], [-3064, -707], [-3188, -692], [-3178, -621]],
    base: 1.9,
    height: 17,
    office: true,
  }),
];
