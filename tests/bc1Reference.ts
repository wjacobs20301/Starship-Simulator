// A BC1 decoder for the tests, written from the format's definition: two 5:6:5 colours,
// little-endian, then 2 bits a pixel; first colour greater: the four are the two and the thirds
// between them; otherwise the two, their middle, and transparent black (which a tile must never
// get: `opaque` says none of the blocks is that kind).

export type Rgb = [number, number, number];

export function colour565(c: number): Rgb {
  const r = c >> 11, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

export function decodeBc1(data: Uint8Array, width: number, height: number): { rgba: Uint8Array; opaque: boolean } {
  const rgba = new Uint8Array(width * height * 4);
  const bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
  let opaque = true;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * 8;
      const c0 = data[o] + data[o + 1] * 256, c1 = data[o + 2] + data[o + 3] * 256;
      if (c0 <= c1) opaque = false;
      const a = colour565(c0), b = colour565(c1);
      const palette: Rgb[] =
        c0 > c1
          ? [a, b, a.map((v, k) => Math.round((2 * v + b[k]) / 3)) as Rgb, a.map((v, k) => Math.round((v + 2 * b[k]) / 3)) as Rgb]
          : [a, b, a.map((v, k) => Math.round((v + b[k]) / 2)) as Rgb, [0, 0, 0]];
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const x = bx * 4 + i, y = by * 4 + j;
          if (x >= width || y >= height) continue;
          const p = palette[(data[o + 4 + j] >> (2 * i)) & 3];
          rgba.set([p[0], p[1], p[2], 255], (y * width + x) * 4);
        }
      }
    }
  }
  return { rgba, opaque };
}

export function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) se += (a[i + k] - b[i + k]) ** 2;
  const mse = se / ((a.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
