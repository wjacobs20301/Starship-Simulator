// What the page and the tile workers (tiles.worker.ts) say to each other: a tile to build, and
// the tile built (its arrays handed over, not copied).

import type { Bc1Image } from '../render/bc1';
import type { GlobeGeometry, GlobeTileShape, TerrainGeometry, TerrainTileShape, TileId } from '../render/tileGeometry';

/** A terrain tile to build (terrain.ts). */
export interface TerrainTileJob {
  kind: 'terrain';
  shape: TerrainTileShape;
  /** The DEM tile its heights come from (its own or an ancestor's), or null: open sea, 0 m. */
  /**
   * (ring: the eight DEM tiles round that one, by rows from the north-west, null where there's
   * none: its water is cleaned and its shores smoothed with them in view. Left out: none known.)
   */
  dem: { url: string; at: TileId; grid: number; ring?: (string | null)[] } | null;
  /** Its image to compress (address), or null: none, or the page loads it itself (uncompressed). */
  image: string | null;
}

/** A globe tile to build (globeTiles.ts). */
export interface GlobeTileJob {
  kind: 'globe';
  shape: GlobeTileShape;
  image: string | null;
}

export type TileJob = TerrainTileJob | GlobeTileJob;

/**
 * A tile's image, compressed, with its mipmaps. null with imageSkipped: the worker couldn't (a
 * browser without an OffscreenCanvas to read the pixels with, or an image of an odd size): the
 * page loads it uncompressed.
 */
interface TileImageResult {
  image: Bc1Image | null;
  imageSkipped: boolean;
}

export interface TerrainTileResult extends TileImageResult {
  kind: 'terrain';
  /** Ground heights (m), TERRAIN_GRID x TERRAIN_GRID: kept by the page for groundHeight(). */
  heights: Float32Array;
  geometry: TerrainGeometry;
}

export interface GlobeTileResult extends TileImageResult {
  kind: 'globe';
  geometry: GlobeGeometry;
}

export type TileResult = TerrainTileResult | GlobeTileResult;

export interface ToTileWorker {
  id: number;
  job: TileJob;
}

export type FromTileWorker = { id: number; ok: true; result: TileResult } | { id: number; ok: false; error: string };
