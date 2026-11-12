// BC1 (DXT1) texture compression: 4 x 4 pixel blocks of 8 bytes each, half a byte per pixel
// against four uncompressed. The GPU samples it as it is, so a tile's image takes an eighth of
// the memory. The tiles on disk stay JPEGs; they're compressed as they load (tiles.worker.ts).
// No DOM, no three: runs in the tile worker and in the tests.
//
// A block is two colours (5:6:5 bits) and, for each pixel, one of four points on the line between
// them (the two ends and the thirds). The work is choosing the two colours: here the ends of the
// block's colours along their main axis, then refined by least squares for the points chosen.
// Opaque only: the first colour is always written the greater of the two, which is what tells the
// GPU all four points are colours (the other way round, the fourth is "transparent").

import { type MipLevel, mipChain } from './mipmaps';

/** 5 and 6 bit channel values as the GPU widens them to 8 bits. */
const EXPAND5 = new Uint8Array(32);
const EXPAND6 = new Uint8Array(64);
for (let i = 0; i < 32; i++) EXPAND5[i] = (i << 3) | (i >> 2);
for (let i = 0; i < 64; i++) EXPAND6[i] = (i << 2) | (i >> 4);

/** The nearest 5 / 6 bit value to each 8 bit one. */
const QUANT5 = new Uint8Array(256);
const QUANT6 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  QUANT5[i] = Math.min(31, Math.round((i * 31) / 255));
  QUANT6[i] = Math.min(63, Math.round((i * 63) / 255));
}

/**
 * For a block of one flat colour: the pair of 5 / 6 bit ends whose third point (two parts the
 * first, one part the second) comes nearest each 8 bit value. Far finer than the 32 or 64 levels
 * the ends alone give: flat sea and sand would band otherwise. ([first, second] per value.)
 */
function solidTable(expand: Uint8Array): Uint8Array {
  const n = expand.length;
  const out = new Uint8Array(512);
  for (let v = 0; v < 256; v++) {
    let best = Infinity;
    for (let hi = 0; hi < n; hi++) {
      for (let lo = 0; lo < n; lo++) {
        // (Ends far apart count against a pair a little: GPUs differ in how they round the
        // thirds, and the further apart the ends, the further off a GPU's answer can be.)
        const err = Math.abs(((2 * expand[hi] + expand[lo] + 1) / 3 | 0) - v) * 100 + Math.abs(hi - lo) * 3;
        if (err < best) {
          best = err;
          out[v * 2] = hi;
          out[v * 2 + 1] = lo;
        }
      }
    }
  }
  return out;
}
const SOLID5 = solidTable(EXPAND5);
const SOLID6 = solidTable(EXPAND6);

/** Bytes of a BC1 image (a level smaller than a block is still one block). */
export const bc1Size = (width: number, height: number): number => Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * 8;

// --- One block ---------------------------------------------------------------------------

/** The block being compressed: 16 pixels, r g b each. */
const px = new Uint8Array(48);
/** Weight of the first colour, in thirds, at each of the four points (as the GPU numbers them). */
const THIRDS = [3, 0, 2, 1];

/** fit()'s answer: which point each pixel takes (2 bits each, first pixel lowest). */
let fitIndices = 0;

/**
 * The points nearest each pixel for a pair of end colours (8 bit, as widened), and how far off
 * the block then is (squared error, summed).
 */
function fit(r0: number, g0: number, b0: number, r1: number, g1: number, b1: number): number {
  const r2 = ((2 * r0 + r1 + 1) / 3) | 0, g2 = ((2 * g0 + g1 + 1) / 3) | 0, b2 = ((2 * b0 + b1 + 1) / 3) | 0;
  const r3 = ((r0 + 2 * r1 + 1) / 3) | 0, g3 = ((g0 + 2 * g1 + 1) / 3) | 0, b3 = ((b0 + 2 * b1 + 1) / 3) | 0;
  let err = 0;
  let idx = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    let d = (r - r0) * (r - r0) + (g - g0) * (g - g0) + (b - b0) * (b - b0);
    let k = 0;
    const d1 = (r - r1) * (r - r1) + (g - g1) * (g - g1) + (b - b1) * (b - b1);
    if (d1 < d) { d = d1; k = 1; }
    const d2 = (r - r2) * (r - r2) + (g - g2) * (g - g2) + (b - b2) * (b - b2);
    if (d2 < d) { d = d2; k = 2; }
    const d3 = (r - r3) * (r - r3) + (g - g3) * (g - g3) + (b - b3) * (b - b3);
    if (d3 < d) { d = d3; k = 3; }
    err += d;
    idx |= k << (2 * i);
  }
  fitIndices = idx;
  return err;
}

/**
 * Write a block: the two colours (5:6:5, the greater first) and the indices. The colours as
 * chosen may be either way round, or the same: swapped, the indices swap with them; the same, one
 * is moved a step off (unused: every pixel points at the other), so the first is still greater.
 */
function writeBlock(out: Uint8Array, o: number, c0: number, c1: number, idx: number): void {
  if (c0 < c1) {
    const t = c0;
    c0 = c1;
    c1 = t;
    idx ^= 0x55555555;
  } else if (c0 === c1) {
    if (c0 > 0) {
      c1 = c0 - 1;
      idx = 0;
    } else {
      c0 = 1;
      idx = 0x55555555;
    }
  }
  out[o] = c0 & 255;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 255;
  out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255;
  out[o + 5] = (idx >> 8) & 255;
  out[o + 6] = (idx >> 16) & 255;
  out[o + 7] = (idx >> 24) & 255;
}

/** Compress the block in px into out at o. */
function encodeBlock(out: Uint8Array, o: number): void {
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < 48; i += 3) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
    sumR += r;
    sumG += g;
    sumB += b;
  }
  // One flat colour: its best pair from the table, every pixel on the third point.
  if (minR === maxR && minG === maxG && minB === maxB) {
    const c0 = (SOLID5[minR * 2] << 11) | (SOLID6[minG * 2] << 5) | SOLID5[minB * 2];
    const c1 = (SOLID5[minR * 2 + 1] << 11) | (SOLID6[minG * 2 + 1] << 5) | SOLID5[minB * 2 + 1];
    // (The same colour either way if the pair is: the first colour itself.)
    writeBlock(out, o, c0, c1, 0xaaaaaaaa | 0);
    return;
  }

  // The axis the block's colours lie along: the main axis of their spread (covariance), by a few
  // rounds of power iteration from the channel that varies most.
  const mR = sumR / 16, mG = sumG / 16, mB = sumB / 16;
  let rr = 0, rg = 0, rb = 0, gg = 0, gb = 0, bb = 0;
  for (let i = 0; i < 48; i += 3) {
    const r = px[i] - mR, g = px[i + 1] - mG, b = px[i + 2] - mB;
    rr += r * r;
    rg += r * g;
    rb += r * b;
    gg += g * g;
    gb += g * b;
    bb += b * b;
  }
  let vx: number, vy: number, vz: number;
  if (rr >= gg && rr >= bb) { vx = rr; vy = rg; vz = rb; }
  else if (gg >= bb) { vx = rg; vy = gg; vz = gb; }
  else { vx = rb; vy = gb; vz = bb; }
  for (let it = 0; it < 4; it++) {
    const x = rr * vx + rg * vy + rb * vz;
    const y = rg * vx + gg * vy + gb * vz;
    const z = rb * vx + gb * vy + bb * vz;
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (m === 0) break;
    vx = x / m;
    vy = y / m;
    vz = z / m;
  }
  const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= len;
  vy /= len;
  vz /= len;

  // First ends: the furthest colours either way along the axis (on it, through the mean).
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 48; i += 3) {
    const d = (px[i] - mR) * vx + (px[i + 1] - mG) * vy + (px[i + 2] - mB) * vz;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  let q0r = QUANT5[clamp8(mR + vx * hi)], q0g = QUANT6[clamp8(mG + vy * hi)], q0b = QUANT5[clamp8(mB + vz * hi)];
  let q1r = QUANT5[clamp8(mR + vx * lo)], q1g = QUANT6[clamp8(mG + vy * lo)], q1b = QUANT5[clamp8(mB + vz * lo)];
  let best = fit(EXPAND5[q0r], EXPAND6[q0g], EXPAND5[q0b], EXPAND5[q1r], EXPAND6[q1g], EXPAND5[q1b]);
  let idx = fitIndices;

  // Refine: for the points the pixels took, the two ends that fit them best (least squares, a
  // 2 x 2 solve per channel); then the points again for those ends. Kept while it gets better.
  for (let it = 0; it < 3 && best > 0; it++) {
    let xx = 0, yy = 0, xy = 0;
    let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bbl = 0;
    for (let i = 0; i < 16; i++) {
      const w = THIRDS[(idx >> (2 * i)) & 3];
      const u = 3 - w;
      xx += w * w;
      yy += u * u;
      xy += w * u;
      const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
      ar += w * r;
      ag += w * g;
      ab += w * b;
      br += u * r;
      bg += u * g;
      bbl += u * b;
    }
    const det = xx * yy - xy * xy;
    // (Every pixel on the same point: nothing to solve for.)
    if (det === 0) break;
    const f = 3 / det;
    const n0r = QUANT5[clamp8((ar * yy - br * xy) * f)], n0g = QUANT6[clamp8((ag * yy - bg * xy) * f)], n0b = QUANT5[clamp8((ab * yy - bbl * xy) * f)];
    const n1r = QUANT5[clamp8((br * xx - ar * xy) * f)], n1g = QUANT6[clamp8((bg * xx - ag * xy) * f)], n1b = QUANT5[clamp8((bbl * xx - ab * xy) * f)];
    if (n0r === q0r && n0g === q0g && n0b === q0b && n1r === q1r && n1g === q1g && n1b === q1b) break;
    const err = fit(EXPAND5[n0r], EXPAND6[n0g], EXPAND5[n0b], EXPAND5[n1r], EXPAND6[n1g], EXPAND5[n1b]);
    if (err >= best) break;
    best = err;
    idx = fitIndices;
    q0r = n0r; q0g = n0g; q0b = n0b;
    q1r = n1r; q1g = n1g; q1b = n1b;
  }

  // A block that's nearly flat (water, sand, a field): the ends the table gives its mean colour
  // put a point on it more finely than the 5:6:5 ends can, where those came out the same or close.
  if (best > 0 && maxR - minR < 24 && maxG - minG < 24 && maxB - minB < 24) {
    const r = Math.round(mR), g = Math.round(mG), b = Math.round(mB);
    const s0r = SOLID5[r * 2], s0g = SOLID6[g * 2], s0b = SOLID5[b * 2];
    const s1r = SOLID5[r * 2 + 1], s1g = SOLID6[g * 2 + 1], s1b = SOLID5[b * 2 + 1];
    const err = fit(EXPAND5[s0r], EXPAND6[s0g], EXPAND5[s0b], EXPAND5[s1r], EXPAND6[s1g], EXPAND5[s1b]);
    if (err < best) {
      idx = fitIndices;
      q0r = s0r; q0g = s0g; q0b = s0b;
      q1r = s1r; q1g = s1g; q1b = s1b;
    }
  }
  writeBlock(out, o, (q0r << 11) | (q0g << 5) | q0b, (q1r << 11) | (q1g << 5) | q1b, idx);
}

const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

// --- Images ------------------------------------------------------------------------------

/**
 * Compress an RGBA image (alpha ignored) to BC1: blocks left to right, rows in the image's own
 * order. An image not a multiple of 4 across or down has its edge pixels repeated to fill the
 * last blocks (so one smaller than a block, a 2 x 2 or 1 x 1 mip level, is one whole block).
 * Written into out at offset if given.
 */
export function encodeBc1(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  out: Uint8Array = new Uint8Array(bc1Size(width, height)),
  offset = 0,
): Uint8Array {
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let j = 0; j < 4; j++) {
        const row = Math.min(height - 1, by * 4 + j) * width;
        for (let i = 0; i < 4; i++) {
          const s = (row + Math.min(width - 1, bx * 4 + i)) * 4;
          const d = (j * 4 + i) * 3;
          px[d] = rgba[s];
          px[d + 1] = rgba[s + 1];
          px[d + 2] = rgba[s + 2];
        }
      }
      encodeBlock(out, offset + (by * bw + bx) * 8);
    }
  }
  return out;
}

/** A compressed image with all its mipmaps: one buffer, and where each level is in it. */
export interface Bc1Image {
  width: number;
  height: number;
  data: Uint8Array;
  levels: { width: number; height: number; offset: number; length: number }[];
}

/** Whether a size can be a BC1 texture with mipmaps: WebGL wants every level 1, 2 or a multiple of 4 across. */
export const bc1Sizes = (width: number, height: number): boolean =>
  width >= 4 && height >= 4 && (width & (width - 1)) === 0 && (height & (height - 1)) === 0;

/**
 * An RGBA image as BC1 with every mipmap down to 1 x 1 (the last two, smaller than a block, as a
 * block each: the GPU reads the corner of it). A 256 px tile: 43.7 kB, against 349.5 kB as RGBA.
 */
export function encodeBc1Mipmaps(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Bc1Image {
  const chain: MipLevel[] = mipChain(rgba, width, height);
  const levels: Bc1Image['levels'] = [];
  let total = 0;
  for (const l of chain) {
    const length = bc1Size(l.width, l.height);
    levels.push({ width: l.width, height: l.height, offset: total, length });
    total += length;
  }
  const data = new Uint8Array(total);
  chain.forEach((l, i) => encodeBc1(l.data, l.width, l.height, data, levels[i].offset));
  return { width, height, data, levels };
}
