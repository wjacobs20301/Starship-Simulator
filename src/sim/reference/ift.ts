// Reference ascent profile for overlay and sanity tests.
//
// APPROXIMATE: a smoothed composite reconstructed from the webcast telemetry
// readouts (surface-relative speed, altitude) of 2024–2025 Starship V2 test
// flights. It is NOT an exact record of any single flight. Replace it with
// transcribed webcast data (e.g. one sample per second) for real validation.
// Before staging the values are the stack; after staging they follow the ship.

export interface RefPoint {
  t: number; // s after T-0
  altKm: number;
  speedKmh: number;
}

export const REFERENCE_NAME = 'Approx. V2 test-flight composite';

export const REFERENCE_ASCENT: readonly RefPoint[] = [
  { t: 0, altKm: 0, speedKmh: 0 },
  { t: 20, altKm: 1.0, speedKmh: 330 },
  { t: 40, altKm: 4.5, speedKmh: 850 },
  { t: 60, altKm: 11, speedKmh: 1450 },
  { t: 80, altKm: 20, speedKmh: 2150 },
  { t: 100, altKm: 31, speedKmh: 3000 },
  { t: 120, altKm: 44, speedKmh: 4000 },
  { t: 140, altKm: 56, speedKmh: 5000 },
  { t: 160, altKm: 66, speedKmh: 5700 },
  { t: 180, altKm: 77, speedKmh: 5800 },
  { t: 210, altKm: 95, speedKmh: 6300 },
  { t: 240, altKm: 115, speedKmh: 7500 },
  { t: 300, altKm: 140, speedKmh: 10500 },
  { t: 360, altKm: 152, speedKmh: 14000 },
  { t: 420, altKm: 158, speedKmh: 18300 },
  { t: 480, altKm: 162, speedKmh: 23300 },
  { t: 520, altKm: 165, speedKmh: 26500 },
];
