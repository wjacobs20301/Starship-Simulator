// Mipmaps for a tile's image, made on the CPU: a compressed texture can't have the GPU make them
// (generateMipmap doesn't work on block-compressed formats), so each level is made here and
// compressed on its own (bc1.ts). No DOM, no three: runs in the tile worker and in the tests.

/** One level of an image: RGBA, 8 bits a channel, rows from the first to the last. */
export interface MipLevel {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** sRGB (0..255) -> linear light (0..1). */
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/**
 * Linear light -> sRGB, by table (a pow per channel per pixel is most of the time otherwise).
 * Fine enough that the darkest sRGB steps each have entries of their own: a flat colour comes
 * back as itself.
 */
const LINEAR_STEPS = 1 << 14;
const TO_SRGB = new Uint8Array(LINEAR_STEPS);
for (let i = 0; i < LINEAR_STEPS; i++) {
  const l = (i + 0.5) / LINEAR_STEPS;
  TO_SRGB[i] = Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
}

/** How many levels an image has, down to 1 x 1. */
export const mipCount = (width: number, height: number): number => Math.floor(Math.log2(Math.max(width, height))) + 1;

/**
 * The next level down: half the size each way (rounded down, never below 1), each pixel the
 * average of the 2 x 2 above it. Averaged in linear light, as the GPU does for an sRGB texture:
 * averaging the sRGB numbers themselves darkens fine light-and-dark detail (surf, roads, roofs)
 * as it shrinks. An odd last row or column is left out.
 */
export function halveImage(src: MipLevel): MipLevel {
  const { data: s, width: w, height: h } = src;
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const r0 = Math.min(h - 1, 2 * y) * w;
    const r1 = Math.min(h - 1, 2 * y + 1) * w;
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, 2 * x);
      const x1 = Math.min(w - 1, 2 * x + 1);
      const a = (r0 + x0) * 4, b = (r0 + x1) * 4, c = (r1 + x0) * 4, d = (r1 + x1) * 4;
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 3; k++) {
        const l = (TO_LINEAR[s[a + k]] + TO_LINEAR[s[b + k]] + TO_LINEAR[s[c + k]] + TO_LINEAR[s[d + k]]) * 0.25;
        out[o + k] = TO_SRGB[Math.min(LINEAR_STEPS - 1, (l * LINEAR_STEPS) | 0)];
      }
      out[o + 3] = (s[a + 3] + s[b + 3] + s[c + 3] + s[d + 3] + 2) >> 2;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Every level of an image, the image itself first, down to 1 x 1. */
export function mipChain(data: Uint8Array | Uint8ClampedArray, width: number, height: number): MipLevel[] {
  const levels: MipLevel[] = [{ data, width, height }];
  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) levels.push(halveImage(levels[levels.length - 1]));
  return levels;
}
