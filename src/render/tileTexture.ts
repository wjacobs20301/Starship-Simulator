// A map tile's image as a texture.
//
// Compressed where the GPU takes it (BC1 / S3TC: desktop GPUs, Apple-silicon Macs): the tile
// worker turns the JPEG into BC1 blocks with their mipmaps (tiles.worker.ts, bc1.ts) and the
// texture is uploaded as that, 43.7 kB a tile on the GPU instead of 349.5 kB as RGBA with
// mipmaps: with 1500 terrain tiles kept, 66 MB for half a gigabyte. Nothing is decoded or
// mipmapped on the main thread either.
//
// Otherwise uncompressed, as before: decoded off the main thread where the browser can
// (createImageBitmap): an <img> is decoded when it's first uploaded to the GPU, in the middle of
// a frame, and with a dozen tiles arriving at once that's a late frame each time.

import * as THREE from 'three';
import type { Bc1Image } from './bc1';

const bitmaps =
  typeof createImageBitmap === 'function'
    ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    : null;
const images = new THREE.TextureLoader();

/** Tile textures alive now, and their size on the GPU (bytes, mipmaps included): for a look in the console. */
export const tileTextureStats = { compressed: 0, uncompressed: 0, gpuBytes: 0 };

let compressed: boolean | null = null;

/**
 * Whether tile images are to be compressed (by the worker) for this GPU. The tiles are sRGB, so
 * both extensions are needed: with only the plain one three has no format to upload an sRGB BC1
 * texture as (WebGLUtils.convert gives null, and the texture stays black), and uploading it as
 * linear would need every tile shader to decode it and filter in the wrong space. Rare (the two
 * come together on everything current); uncompressed there.
 */
export function compressTiles(renderer: THREE.WebGLRenderer): boolean {
  if (compressed === null) {
    // (Dev: ?rawTiles in the address loads them uncompressed, to compare the two.)
    const off = import.meta.env.DEV && new URLSearchParams(location.search).has('rawTiles');
    compressed = !off && renderer.extensions.has('WEBGL_compressed_texture_s3tc') && renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
  }
  return compressed;
}

/**
 * The worker couldn't compress a tile's image (this browser has no canvas in a worker to read
 * its pixels with, or the image is of a size BC1 can't take): uncompressed from here on.
 */
export function compressTilesFailed(): void {
  if (compressed) console.warn('tile images: the worker can\u2019t compress them here; loading them uncompressed');
  compressed = false;
}

/** Nothing: what a compressed texture's levels are left holding once they're on the GPU. */
const UPLOADED = new Uint8Array(0);

/**
 * A texture of a tile's image as the worker compressed it. Rows as the uncompressed path has
 * them (the worker flips the image: flipY can't apply to a compressed upload), so the same
 * texture coordinates serve both.
 */
export function compressedTileTexture(img: Bc1Image): THREE.Texture {
  const mipmaps = img.levels.map((l) => ({ data: img.data.subarray(l.offset, l.offset + l.length), width: l.width, height: l.height }));
  const tex = new THREE.CompressedTexture(mipmaps, img.width, img.height, THREE.RGB_S3TC_DXT1_Format, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  // Once it's on the GPU the blocks aren't needed here: let them go (44 kB a tile). (A lost
  // graphics context can't be restored from them then; the page is reloaded for that anyway.)
  tex.onUpdate = () => dropLevels(tex);
  tex.userData.gpuBytes = img.data.byteLength;
  tileTextureStats.compressed++;
  tileTextureStats.gpuBytes += img.data.byteLength;
  return tex;
}

/** Let go of a compressed texture's blocks (the levels stay, empty: three counts them). */
function dropLevels(tex: THREE.Texture): void {
  for (const m of tex.mipmaps as { data: Uint8Array }[]) m.data = UPLOADED;
}

/** A tile's image as an uncompressed texture. */
export async function loadTileTexture(url: string): Promise<THREE.Texture> {
  const tex = await loadUncompressed(url);
  const { width, height } = tex.image as { width: number; height: number };
  tex.userData.gpuBytes = Math.round((width * height * 4 * 4) / 3);
  tileTextureStats.uncompressed++;
  tileTextureStats.gpuBytes += tex.userData.gpuBytes;
  return tex;
}

async function loadUncompressed(url: string): Promise<THREE.Texture> {
  if (bitmaps) {
    try {
      const bmp = await bitmaps.loadAsync(url);
      // (Flipped as it was decoded: a bitmap can't be flipped on upload.)
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    } catch {
      // (A browser that won't take the options: as an <img>. A tile that isn't there fails again below.)
    }
  }
  return images.loadAsync(url);
}

/** Free a tile's texture (and its decoded image, held in memory until closed). */
export function disposeTileTexture(tex: THREE.Texture | null | undefined): void {
  if (!tex) return;
  if ((tex as THREE.CompressedTexture).isCompressedTexture) {
    // (One never drawn still has its blocks.)
    dropLevels(tex);
    tileTextureStats.compressed--;
  } else {
    (tex.image as { close?: () => void } | null)?.close?.();
    tileTextureStats.uncompressed--;
  }
  tileTextureStats.gpuBytes -= (tex.userData.gpuBytes as number | undefined) ?? 0;
  tex.dispose();
}
