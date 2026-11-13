import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brown, pink, seamlessLoop, white } from '../src/audio/engine';

// The looping noise under the engines, wind and surf: it must not dip or click where it wraps.
describe('seamless noise loops', () => {
  // (The same noise every run: drawn fresh each time, a 50 ms window of pink noise strayed past
  // the limits below once in a few hundred runs, and the suite failed for nothing.)
  beforeEach(() => {
    let seed = 0x2f6e2b1;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const rate = 48000;
  const length = rate * 4;
  const join = rate / 4;
  const rms = (x: Float32Array, from: number, n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = x[(from + i + x.length) % x.length];
      s += v * v;
    }
    return Math.sqrt(s / n);
  };

  it.each([
    ['white', white],
    ['pink', pink],
    ['brown', brown],
  ] as const)('%s noise holds its level across the join', (_, fill) => {
    const x = seamlessLoop(fill, length, join);
    const overall = rms(x, 0, length);
    // 50 ms windows either side of and through the wrap.
    for (const at of [-rate / 10, -rate / 40, 0, rate / 40, rate / 10, join / 2, join]) {
      expect(rms(x, at, rate / 20) / overall).toBeGreaterThan(0.6);
      expect(rms(x, at, rate / 20) / overall).toBeLessThan(1.6);
    }
  });

  it('brown noise runs straight on across the wrap (no step)', () => {
    const x = seamlessLoop(brown, length, join);
    let typical = 0;
    for (let i = 1; i < length; i++) typical = Math.max(typical, Math.abs(x[i] - x[i - 1]));
    expect(Math.abs(x[0] - x[length - 1])).toBeLessThanOrEqual(typical);
  });
});
