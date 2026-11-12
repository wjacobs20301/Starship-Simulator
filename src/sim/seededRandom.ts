// mulberry32: a small seeded random number generator (the same seed gives the same numbers, so
// the same flight replays the same way). Its whole state is one number, kept on the object where
// a saved flight can write it down (saveFlight.ts): a flight loaded again draws the numbers the
// original would have drawn next.

export class SeededRandom {
  /** state: where the sequence is (32-bit unsigned). Each user scrambles its seed into this its own way. */
  constructor(public state: number) {}

  /** The next number, 0 <= x < 1. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
