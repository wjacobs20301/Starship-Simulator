// Shared settings for the terrain pipeline (fetch -> build -> public/terrain).
import { resolve } from 'node:path';

export const CENTER = { lat: 25.99613, lon: -97.15442 };
export interface Bounds { south: number; north: number; west: number; east: number }
const box = (halfM: number): Bounds => ({
  south: CENTER.lat - halfM / 110_800,
  north: CENTER.lat + halfM / 110_800,
  west: CENTER.lon - halfM / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180)),
  east: CENTER.lon + halfM / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180)),
});
/** Core: 40 x 40 km around the Pad 1 mount with 3 m USGS lidar heights. */
export const CORE = box(20_000);
/** Region: 200 x 200 km of streamed imagery (NAIP 0.6 m in the US, Sentinel-2 10 m in Mexico). */
export const BOUNDS = box(100_000);

/** Web Mercator zoom levels: imagery is fetched at MAX_ZOOM (~0.54 m/px here) and downsampled. */
export const MAX_ZOOM = 18;
export const MIN_ZOOM = 8;
/** Sentinel-2 (10 m) is fetched at this zoom (~8.6 m/px) and fills areas without NAIP. */
export const S2_ZOOM = 14;

export const ROOT = resolve(import.meta.dirname, '../..');
export const SRC = resolve(ROOT, 'art/source/terrain');
export const OUT = resolve(ROOT, 'public/terrain');

/** NAIP 2022 (Texas) mosaic on Microsoft Planetary Computer; public domain (USDA). */
export const NAIP_MOSAIC_SEARCH = {
  collections: ['naip'],
  'filter-lang': 'cql2-json',
  filter: {
    op: 'and',
    args: [
      { op: '=', args: [{ property: 'naip:year' }, '2022'] },
      { op: '=', args: [{ property: 'naip:state' }, 'tx'] },
    ],
  },
};

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Tile index range covering the bounds at zoom z (inclusive). */
export function tileRange(z: number, b: Bounds = BOUNDS) {
  return {
    x0: Math.floor(lonToTileX(b.west, z)),
    x1: Math.floor(lonToTileX(b.east, z)),
    y0: Math.floor(latToTileY(b.north, z)),
    y1: Math.floor(latToTileY(b.south, z)),
  };
}

/** Planetary Computer STAC search, following pagination. */
export interface StacItem { id: string; bbox: number[]; assets: Record<string, { href: string }> }
export async function stacSearch(body: Record<string, unknown>): Promise<StacItem[]> {
  const out: StacItem[] = [];
  let url: string | null = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
  let req: Record<string, unknown> = body;
  while (url) {
    const res: Response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const d = (await res.json()) as { features: StacItem[]; links?: { rel: string; href: string; body?: Record<string, unknown> }[] };
    out.push(...d.features);
    const next = d.links?.find((l) => l.rel === 'next');
    url = next?.href ?? null;
    req = next?.body ?? req;
  }
  return out;
}
