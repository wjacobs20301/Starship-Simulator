import { describe, expect, it } from 'vitest';
import { bc1Size, bc1Sizes, encodeBc1, encodeBc1Mipmaps } from '../src/render/bc1';
import { halveImage, mipChain, mipCount } from '../src/render/mipmaps';
import { type Rgb, colour565, decodeBc1, psnr } from './bc1Reference';

// The tile images' compression (src/render/bc1.ts), checked against a BC1 decoder written from
// the format's definition, not from the encoder (bc1Reference.ts).

/** What a slow search for each block's best two colours gets (PSNR, dB), n x n. */
function searchPsnr(rgba: Uint8Array, n: number): number {
  const q5 = (v: number) => colour565(Math.round((v * 31) / 255) << 11)[0];
  const q6 = (v: number) => colour565(Math.round((v * 63) / 255) << 5)[1];
  const snap = (c: number[]): Rgb => [q5(c[0]), q6(c[1]), q5(c[2])];
  const thirds = [3, 0, 2, 1];
  const fit = (px: Rgb[], a: Rgb, b: Rgb) => {
    const palette = [a, b, a.map((v, k) => Math.round((2 * v + b[k]) / 3)), a.map((v, k) => Math.round((v + 2 * b[k]) / 3))];
    let err = 0;
    const idx = px.map((p) => {
      const d = palette.map((c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2);
      const i = d.indexOf(Math.min(...d));
      err += d[i];
      return i;
    });
    return { err, idx };
  };
  const refined = (px: Rgb[], a: Rgb, b: Rgb) => {
    let cur = fit(px, a, b);
    for (let it = 0; it < 8; it++) {
      let xx = 0, yy = 0, xy = 0;
      const A = [0, 0, 0], B = [0, 0, 0];
      px.forEach((p, i) => {
        const w = thirds[cur.idx[i]], u = 3 - w;
        xx += w * w;
        yy += u * u;
        xy += w * u;
        for (let k = 0; k < 3; k++) {
          A[k] += w * p[k];
          B[k] += u * p[k];
        }
      });
      const det = xx * yy - xy * xy;
      if (!det) break;
      const next = fit(px, snap(A.map((v, k) => clamp(((v * yy - B[k] * xy) * 3) / det))), snap(B.map((v, k) => clamp(((v * xx - A[k] * xy) * 3) / det))));
      if (next.err >= cur.err) break;
      cur = next;
    }
    return cur.err;
  };
  let se = 0;
  for (let by = 0; by < n; by += 4) {
    for (let bx = 0; bx < n; bx += 4) {
      const px: Rgb[] = [];
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) px.push([0, 1, 2].map((k) => rgba[((by + j) * n + bx + i) * 4 + k]) as Rgb);
      let best = Infinity;
      for (let i = 0; i < 16; i++) for (let j = i; j < 16; j++) best = Math.min(best, refined(px, snap(px[i]), snap(px[j])));
      se += best;
    }
  }
  return 10 * Math.log10((255 * 255) / (se / (n * n * 3) || 1e-9));
}

/** An image from a colour for each pixel (0..255, clamped and rounded). */
function image(width: number, height: number, at: (x: number, y: number) => Rgb): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = at(x, y);
      out.set([clamp(c[0]), clamp(c[1]), clamp(c[2]), 255], (y * width + x) * 4);
    }
  }
  return out;
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Repeatable noise, 0..1. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Smooth noise (a few octaves of value noise): fields, scrub and water as an aerial photo has them. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const N = 64;
  const grid = Float32Array.from({ length: N * N }, () => r());
  const at = (x: number, y: number) => grid[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const smooth = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
  return (x, y) => 0.5 * smooth(x / 48, y / 48) + 0.25 * smooth(x / 17, y / 17) + 0.15 * smooth(x / 6, y / 6) + 0.1 * smooth(x / 2.5, y / 2.5);
}

const S = 256;
const gradient = image(S, S, (x, y) => [40 + (x / S) * 150, 60 + (y / S) * 120, 200 - ((x + y) / (2 * S)) * 140]);
const flatSea = image(S, S, (x, y) => [70 + x / 64, 105 + y / 50, 110 + (x + y) / 90]);
const noise = (() => {
  const r = rng(7);
  return image(S, S, () => [r() * 255, r() * 255, r() * 255]);
})();
const edges = image(S, S, (x, y) => {
  // Light roofs and roads on dark ground, a red one, a diagonal: sharp two-colour boundaries.
  if ((x >> 5) % 2 === 0 && (y >> 4) % 3 === 0) return [225, 222, 215];
  if (Math.abs(x - y) < 3) return [150, 150, 152];
  if (x > 180 && x < 200 && y > 30 && y < 90) return [170, 60, 50];
  return [58, 72, 44];
});
const photo = (() => {
  const a = valueNoise(1), b = valueNoise(2), c = valueNoise(3);
  const r = rng(11);
  return image(S, S, (x, y) => {
    // Land (greens and browns, mottled) against water (grey-blue, nearly flat), with a pale
    // beach between and a little sensor grain over everything.
    const land = a(x, y), tone = b(x, y), fine = c(x * 3, y * 3);
    const shore = Math.max(0, Math.min(1, (land - 0.47) * 14));
    const ground: Rgb = [70 + tone * 90 + fine * 30, 80 + tone * 60 + fine * 35, 45 + tone * 50 + fine * 20];
    const water: Rgb = [58 + fine * 6, 92 + fine * 8, 104 + fine * 8];
    const beach = Math.exp(-(((land - 0.47) * 40) ** 2));
    const g = (r() - 0.5) * 6;
    return [0, 1, 2].map((k) => (water[k] * (1 - shore) + ground[k] * shore) * (1 - beach) + 205 * beach + g) as Rgb;
  });
})();

describe('BC1 compression', () => {
  const quality = (name: string, rgba: Uint8Array, atLeast: number) => {
    const bc = encodeBc1(rgba, S, S);
    expect(bc.length, name).toBe((S * S) / 2);
    const back = decodeBc1(bc, S, S);
    // (The first colour greater than the second in every block: no block read as having a
    // transparent pixel.)
    expect(back.opaque, `${name}: opaque blocks`).toBe(true);
    const db = psnr(rgba, back.rgba);
    expect(db, `${name}: ${db.toFixed(1)} dB`).toBeGreaterThan(atLeast);
    return db;
  };

  it('keeps smooth colour smooth', () => {
    quality('gradient', gradient, 45);
    // (Nearly flat water, a level or two across a block: the case that bands if the two colours
    // are only ever rounded to 5:6:5.)
    quality('flat sea', flatSea, 48);
  });

  it('keeps sharp edges and photo-like ground', () => {
    quality('edges', edges, 45);
    // (Grain in each channel on its own, which a JPEG's shared chroma doesn't have: harder than
    // a real tile. Blue Marble and aerial crops through a JPEG come out at 38 to 50 dB.)
    quality('photo', photo, 32);
  });

  it('does what can be done with noise', () => {
    // (Sixteen unrelated colours on one line through colour space: nothing fits. About what BC1
    // can do with it (see the search below), and every block still opaque.)
    quality('noise', noise, 13);
  });

  it('comes close to a slow search for the best two colours', () => {
    // The search: every pair of the block's own colours as the two ends, each refined by least
    // squares until it stops improving. Far too slow for tiles; the encoder should be near it.
    const crop = (rgba: Uint8Array, x0: number, y0: number, n: number) => image(n, n, (x, y) => [0, 1, 2].map((k) => rgba[((y0 + y) * S + x0 + x) * 4 + k]) as Rgb);
    for (const [name, rgba, within] of [['photo', photo, 0.5], ['edges', edges, 0.5], ['gradient', gradient, 0.5], ['noise', noise, 0.5]] as const) {
      const n = 64;
      const part = crop(rgba, 96, 64, n);
      const fast = psnr(part, decodeBc1(encodeBc1(part, n, n), n, n).rgba);
      const slow = searchPsnr(part, n);
      expect(fast, `${name}: ${fast.toFixed(2)} dB, search ${slow.toFixed(2)} dB`).toBeGreaterThan(slow - within);
    }
  });

  it('gives a flat colour back to within a level or two', () => {
    const r = rng(3);
    for (let n = 0; n < 300; n++) {
      const c: Rgb = n === 0 ? [0, 0, 0] : n === 1 ? [255, 255, 255] : [clamp(r() * 255), clamp(r() * 255), clamp(r() * 255)];
      const back = decodeBc1(encodeBc1(image(4, 4, () => c), 4, 4), 4, 4);
      expect(back.opaque, c.join()).toBe(true);
      for (let k = 0; k < 3; k++) expect(Math.abs(back.rgba[k] - c[k]), c.join()).toBeLessThanOrEqual(2);
    }
  });

  it('gets a two-colour block exactly when the colours are 5:6:5 ones', () => {
    const a = colour565(0xf800 | (20 << 5) | 3), b = colour565((4 << 11) | (50 << 5) | 28);
    const rgba = image(4, 4, (x, y) => ((x + y) % 2 ? a : b));
    expect(psnr(rgba, decodeBc1(encodeBc1(rgba, 4, 4), 4, 4).rgba)).toBe(Infinity);
  });

  it('pads an image that is not whole blocks from its edge pixels', () => {
    // 6 x 5: two blocks across, two down; the decoded part is the image.
    const rgba = image(6, 5, (x, y) => [40 + (x + y) * 18, 60 + (x + y) * 12, 128]);
    const bc = encodeBc1(rgba, 6, 5);
    expect(bc.length).toBe(bc1Size(6, 5));
    expect(bc.length).toBe(2 * 2 * 8);
    const back = decodeBc1(bc, 6, 5);
    expect(back.opaque).toBe(true);
    expect(psnr(rgba, back.rgba)).toBeGreaterThan(30);
    // (And one smaller than a block is a whole block: 8 bytes.)
    expect(bc1Size(2, 2)).toBe(8);
    expect(bc1Size(1, 1)).toBe(8);
    expect(encodeBc1(image(1, 1, () => [200, 100, 50]), 1, 1).length).toBe(8);
  });

  it('says which sizes can be compressed with mipmaps', () => {
    expect(bc1Sizes(256, 256)).toBe(true);
    expect(bc1Sizes(512, 256)).toBe(true);
    expect(bc1Sizes(4, 4)).toBe(true);
    // (WebGL: every level 1, 2 or a multiple of 4 across. 300 -> 150 -> 75 isn't.)
    expect(bc1Sizes(300, 300)).toBe(false);
    expect(bc1Sizes(2, 2)).toBe(false);
    expect(bc1Sizes(256, 100)).toBe(false);
  });
});

describe('tile mipmaps', () => {
  it('halves down to 1 x 1: nine levels for a 256 px tile', () => {
    const chain = mipChain(photo, S, S);
    expect(chain.length).toBe(9);
    expect(mipCount(S, S)).toBe(9);
    expect(chain.map((l) => l.width)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(chain.map((l) => l.height)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1]);
    for (const l of chain) expect(l.data.length).toBe(l.width * l.height * 4);
    expect(chain[0].data).toBe(photo);
  });

  it('handles images that are not square, odd, or tiny', () => {
    const wide = mipChain(new Uint8Array(64 * 16 * 4), 64, 16);
    expect(wide.map((l) => [l.width, l.height])).toEqual([[64, 16], [32, 8], [16, 4], [8, 2], [4, 1], [2, 1], [1, 1]]);
    expect(mipCount(64, 16)).toBe(7);
    const odd = mipChain(new Uint8Array(5 * 3 * 4), 5, 3);
    expect(odd.map((l) => [l.width, l.height])).toEqual([[5, 3], [2, 1], [1, 1]]);
    expect(mipCount(5, 3)).toBe(3);
    expect(mipChain(new Uint8Array(4), 1, 1).length).toBe(1);
    expect(mipCount(1, 1)).toBe(1);
  });

  it('leaves a flat colour as it is, at every level', () => {
    for (let v = 0; v < 256; v++) {
      const half = halveImage({ data: image(2, 2, () => [v, 255 - v, (v * 7) % 256]), width: 2, height: 2 });
      expect([...half.data]).toEqual([v, 255 - v, (v * 7) % 256, 255]);
    }
  });

  it('averages in linear light, not the sRGB numbers', () => {
    // Black and white in a checker: half the light is sRGB 188, not 128.
    const half = halveImage({ data: image(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])), width: 2, height: 2 });
    expect(half.data[0]).toBeGreaterThanOrEqual(187);
    expect(half.data[0]).toBeLessThanOrEqual(188);
  });

  it('compresses every level into one buffer', () => {
    const bc = encodeBc1Mipmaps(photo, S, S);
    expect(bc.levels.length).toBe(9);
    expect(bc.levels.map((l) => l.length)).toEqual([32768, 8192, 2048, 512, 128, 32, 8, 8, 8]);
    // (43.7 kB, against 349.5 kB as RGBA with mipmaps: an eighth.)
    expect(bc.data.length).toBe(43704);
    let at = 0;
    const chain = mipChain(photo, S, S);
    bc.levels.forEach((l, i) => {
      expect(l.offset).toBe(at);
      expect([l.width, l.height]).toEqual([chain[i].width, chain[i].height]);
      at += l.length;
      // Each level is that mip, compressed: decoded, it's close to it.
      const back = decodeBc1(bc.data.subarray(l.offset, l.offset + l.length), l.width, l.height);
      expect(back.opaque).toBe(true);
      // (The small levels are the hard ones: the detail of 16 pixels in each of theirs.)
      expect(psnr(chain[i].data as Uint8Array, back.rgba), `level ${i}`).toBeGreaterThan(27);
    });
    expect(at).toBe(bc.data.length);
  });
});
