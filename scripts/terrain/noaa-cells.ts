// Which cells of NOAA's January 2026 survey the terrain uses (fetch-noaa.ts, build-noaa.ts).
import { resolve } from 'node:path';
import { SRC } from './config';

export const NOAA_BASE = 'https://noaa-eri-pds.s3.amazonaws.com/2026_Pre_Event/GC2601a_OB_N_RGB/';
export const NOAA_DIR = resolve(SRC, 'noaa2026');
/** A cell's side: 45 arcseconds (about 1.25 km east-west, 1.39 km north-south). */
export const CELL_DEG = 45 / 3600;

/**
 * The cells, by their north-west corners: [west longitude, north latitude], in arcseconds.
 * Two rows from west of the production site and village to the beach, and the row north of
 * them over the launch site.
 */
const dms = (d: number, m: number, s: number) => d * 3600 + m * 60 + s;
const COLS = [dms(97, 12, 0), dms(97, 11, 15), dms(97, 10, 30), dms(97, 9, 45), dms(97, 9, 0)];
const ROWS = [dms(26, 0, 0), dms(25, 59, 15)];
const NORTH: [number, number][] = [
  [dms(97, 9, 45), dms(26, 0, 45)],
  [dms(97, 9, 0), dms(26, 0, 45)],
];

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const stamp = (arcsec: number, degDigits: number) =>
  pad(Math.floor(arcsec / 3600), degDigits) + pad(Math.floor((arcsec % 3600) / 60), 2) + pad(arcsec % 60, 2);

export interface NoaaCell { name: string; west: number; east: number; south: number; north: number }

export function noaaCells(): NoaaCell[] {
  const corners: [number, number][] = [...NORTH];
  for (const lat of ROWS) for (const lon of COLS) corners.push([lon, lat]);
  return corners.map(([lon, lat]) => ({
    name: `GC2601a_OB_N_C${stamp(lon, 3)}w${stamp(lat, 2)}n.tif`,
    west: -lon / 3600,
    east: -lon / 3600 + CELL_DEG,
    south: lat / 3600 - CELL_DEG,
    north: lat / 3600,
  }));
}
