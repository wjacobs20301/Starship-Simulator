// The terrain's tile images in one texture: an array of layers, a tile to a layer, so that every
// tile can be drawn with the same material.
//
// Why: three uploads a material's uniforms again for every material it meets in a frame, and
// the terrain's are many (the sea's fifty wave trains, the lights, the site's masks...). With a
// material and a texture of its own per tile, the ~400 tiles in view at the pad were ~11 ms of
// script time a frame in uniform uploads alone, two thirds of a 60 Hz frame. Sharing one material
// they cost a fraction of that; what differs from tile to tile (which image) rides in a vertex
// attribute, the layer.
//
// Compressed tiles only (BC1, from the tile worker): 44 kB a layer, so the whole array, allocated
// at once, is ~75 MB on the GPU. (Uncompressed it would be eight times that: those tiles keep a
// texture and a material each, as before.) The blocks are kept here too: three uploads a layer
// from the array's own data.

import * as THREE from 'three';
import type { Bc1Image } from './bc1';
import { tileTextureStats } from './tileTexture';

export class TileArray {
  readonly texture: THREE.CompressedArrayTexture;
  private free: number[] = [];
  private levels: { data: Uint8Array; width: number; height: number; bytes: number }[] = [];
  private layerBytes = 0;

  /** layers: how many tiles it holds; size: a tile image's side, px (a power of two). */
  constructor(
    readonly layers: number,
    readonly size: number,
    anisotropy: number,
  ) {
    for (let s = size; s >= 1; s >>= 1) {
      const blocks = Math.max(1, (s + 3) >> 2);
      const bytes = blocks * blocks * 8;
      this.levels.push({ data: new Uint8Array(bytes * layers), width: s, height: s, bytes });
      this.layerBytes += bytes;
    }
    for (let i = layers - 1; i >= 0; i--) this.free.push(i);
    const tex = new THREE.CompressedArrayTexture(
      this.levels.map((l) => ({ data: l.data, width: l.width, height: l.height })) as unknown as THREE.CompressedTextureMipmap[],
      size,
      size,
      layers,
      THREE.RGB_S3TC_DXT1_Format,
      THREE.UnsignedByteType,
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = anisotropy;
    this.texture = tex;
  }

  /** Whether an image fits a layer (the size the array was made for, with every mipmap). */
  fits(img: Bc1Image): boolean {
    return img.width === this.size && img.height === this.size && img.levels.length === this.levels.length && img.levels.every((l, i) => l.length === this.levels[i].bytes);
  }

  /** A tile's image into a free layer: the layer, or -1 (none free, or the image doesn't fit). */
  add(img: Bc1Image): number {
    if (!this.free.length || !this.fits(img)) return -1;
    const layer = this.free.pop()!;
    img.levels.forEach((l, i) => this.levels[i].data.set(img.data.subarray(l.offset, l.offset + l.length), layer * this.levels[i].bytes));
    // (Only the layers changed are uploaded, never the whole array.)
    this.texture.addLayerUpdate(layer);
    this.texture.needsUpdate = true;
    tileTextureStats.compressed++;
    tileTextureStats.gpuBytes += this.layerBytes;
    return layer;
  }

  /** A layer back, its tile gone. */
  release(layer: number): void {
    if (layer < 0) return;
    this.free.push(layer);
    tileTextureStats.compressed--;
    tileTextureStats.gpuBytes -= this.layerBytes;
  }
}
