import { describe, expect, it } from 'vitest';
import { SnapshotClock } from '../src/render/snapshotClock';

// Synthetic snapshot streams, made the way the worker makes them (sim.worker.ts): a 60 Hz timer
// that fires a few ms early or late, the sim stepped by the real time since the last tick, times
// the warp, in whole 10 ms physics steps; then each snapshot delivered to the page, perhaps late.

const TICK = 1000 / 60;
const DT = 0.01;

/** A small seeded random number generator (mulberry32), so the streams are the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface Arrival {
  t: number;
  at: number;
}

interface StreamOptions {
  seconds: number;
  seed: number;
  /** ±ms on each arrival: 'timer' the worker's tick is off (its sim time goes with it), 'delivery' the message is. */
  jitter?: number;
  kind?: 'timer' | 'delivery';
  /** Every so often (1.5-3 s) a snapshot 30-40 ms late. */
  late?: boolean;
  /** Warp and pause at a real time (ms). */
  warp?: (ms: number) => number;
  paused?: (ms: number) => boolean;
  /** A reset at this real time (ms): sim time back to 0. */
  resetAt?: number;
}

function stream(o: StreamOptions): Arrival[] {
  const rand = rng(o.seed);
  const jitter = o.jitter ?? 6;
  const out: Arrival[] = [];
  let sim = 0, acc = 0, last = 0, lastAt = 0;
  let nextLate = 1500 + rand() * 1500;
  let wasReset = false;
  for (let k = 1; k * TICK < o.seconds * 1000; k++) {
    const nominal = k * TICK;
    const lateBy = o.late && nominal >= nextLate ? 30 + rand() * 10 : 0;
    if (lateBy) nextLate = nominal + 1500 + rand() * 1500;
    const off = (rand() * 2 - 1) * jitter;
    // (A timer can't fire before the last tick finished.)
    const tick = o.kind === 'delivery' ? nominal : Math.max(last + 1, nominal + off + lateBy);
    if (o.resetAt !== undefined && !wasReset && tick >= o.resetAt) {
      wasReset = true;
      sim = 0;
      acc = 0;
    }
    if (!o.paused?.(tick)) {
      acc += ((tick - last) / 1000) * (o.warp?.(tick) ?? 1);
      const steps = Math.floor(acc / DT + 1e-9);
      sim += steps * DT;
      acc -= steps * DT;
    }
    last = tick;
    // (Messages arrive in the order they were sent.)
    const at = Math.max(lastAt, o.kind === 'delivery' ? tick + jitter + off + lateBy : tick);
    lastAt = at;
    out.push({ t: sim, at });
  }
  return out;
}

interface Frame {
  now: number;
  /** Sim time drawn: by the clock, and by the old way (between the last two snapshots as they arrived). */
  clock: number;
  old: number;
  /** The newest snapshot's sim time at this frame. */
  newest: number;
  alpha: number;
  /** The sim times of the pair the clock gave. */
  a: number;
  b: number;
}

/** Play a stream through the clock, drawing a frame every `period` ms. */
function play(arrivals: Arrival[], period: number, phase = 3): Frame[] {
  const clock = new SnapshotClock<Arrival>();
  const frames: Frame[] = [];
  let i = 0;
  let prev: Arrival | null = null, curr: Arrival | null = null;
  const end = arrivals[arrivals.length - 1].at;
  for (let now = phase; now < end; now += period) {
    while (i < arrivals.length && arrivals[i].at <= now) {
      const s = arrivals[i++];
      clock.push(s, s.t, s.at);
      prev = curr;
      curr = s;
    }
    const f = clock.sample(now);
    if (!f || !curr) continue;
    // The old way (main.ts before): alpha by the time since the last arrival over the last interval.
    const span = prev ? curr.at - prev.at : 0;
    const alpha = span > 0 ? Math.min(1, (now - curr.at) / span) : 1;
    const old = prev ? prev.t + (curr.t - prev.t) * alpha : curr.t;
    frames.push({ now, clock: f.t, old, newest: curr.t, alpha: f.alpha, a: f.a.t, b: f.b.t });
  }
  return frames;
}

/** Sim time per frame, ms: its mean and standard deviation. */
function steps(frames: Frame[], key: 'clock' | 'old'): { mean: number; sd: number; min: number; max: number } {
  const d = frames.slice(1).map((f, i) => (f[key] - frames[i][key]) * 1000);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length);
  return { mean, sd, min: Math.min(...d), max: Math.max(...d) };
}

const after = (frames: Frame[], ms: number) => frames.filter((f) => f.now >= ms);
const between = (frames: Frame[], from: number, to: number) => frames.filter((f) => f.now >= from && f.now < to);

/** What every frame must be: between two snapshots there are, never past the newest, never backwards. */
function expectSound(frames: Frame[]): void {
  frames.forEach((f, i) => {
    expect(f.alpha).toBeGreaterThanOrEqual(0);
    expect(f.alpha).toBeLessThanOrEqual(1);
    expect(f.clock).toBeGreaterThanOrEqual(f.a - 1e-9);
    expect(f.clock).toBeLessThanOrEqual(f.b + 1e-9);
    expect(f.clock).toBeLessThanOrEqual(f.newest + 1e-9);
    if (i > 0 && f.newest >= frames[i - 1].newest) expect(f.clock).toBeGreaterThanOrEqual(frames[i - 1].clock);
  });
}

const DISPLAYS = [
  { name: '60 Hz', period: 1000 / 59.94 },
  { name: '120 Hz', period: 1000 / 119.88 },
];

describe('the render clock between snapshots', () => {
  for (const display of DISPLAYS) {
    for (const kind of ['timer', 'delivery'] as const) {
      it(`steady motion from jittery snapshots (${kind} jitter), ${display.name} frames`, () => {
        for (const seed of [7, 8, 9]) {
          const frames = after(play(stream({ seconds: 30, seed, kind }), display.period, seed), 1000);
          expectSound(frames);
          const now = steps(frames, 'clock'), old = steps(frames, 'old');
          // The same speed as the sim, on average...
          expect(now.mean).toBeCloseTo(display.period, 1);
          // ...and far steadier frame to frame than between the last two snapshots: a twentieth
          // of the spread (a 400th of the variance), every frame within 5% of the sim's speed.
          expect(now.sd).toBeLessThan(old.sd / 20);
          expect(now.sd).toBeLessThan(0.02 * display.period);
          expect(now.min).toBeGreaterThan(0.95 * display.period);
          expect(now.max).toBeLessThan(1.05 * display.period);
          // Behind the newest snapshot, but never far.
          for (const f of frames) expect(f.newest - f.clock).toBeLessThan(3.5 * TICK / 1000);
        }
      });

      it(`a snapshot 30-40 ms late now and then (${kind} jitter), ${display.name} frames`, () => {
        for (const seed of [11, 12, 13]) {
          const frames = after(play(stream({ seconds: 60, seed, kind, late: true }), display.period, seed), 1000);
          expectSound(frames);
          const now = steps(frames, 'clock'), old = steps(frames, 'old');
          expect(now.mean).toBeCloseTo(display.period, 1);
          // (The picture has to wait for a snapshot that late, a frame at most: still a
          // twentieth of the variance.)
          expect(now.sd * now.sd).toBeLessThan((old.sd * old.sd) / 20);
          expect(now.min).toBeGreaterThanOrEqual(0);
          // Catching up after one: a little faster, never a jump.
          expect(now.max).toBeLessThan(1.2 * display.period);
          for (const f of frames) expect(f.newest - f.clock).toBeLessThan(5 * TICK / 1000);
        }
      });
    }
  }

  // CLOCK_STATS=1 npx vitest run tests/snapshotClock.test.ts --reporter=verbose prints the comparison.
  it.runIf(process.env.CLOCK_STATS)('how much steadier, in numbers', () => {
    const rows: string[] = [];
    for (const display of DISPLAYS) {
      for (const late of [false, true]) {
        for (const kind of ['timer', 'delivery'] as const) {
          const frames = after(play(stream({ seconds: 60, seed: 3, kind, late }), display.period), 1000);
          const now = steps(frames, 'clock'), old = steps(frames, 'old');
          const lag = frames.map((f) => (f.now / 1000 - f.clock) * 1000);
          rows.push(
            `${display.name} ${kind}${late ? ' + late' : ''}: step sd ${old.sd.toFixed(2)} -> ${now.sd.toFixed(3)} ms of ${display.period.toFixed(2)}` +
              ` (old ${old.min.toFixed(1)}..${old.max.toFixed(1)}, new ${now.min.toFixed(1)}..${now.max.toFixed(1)}), behind real time ${Math.min(...lag).toFixed(0)}..${Math.max(...lag).toFixed(0)} ms`,
          );
        }
      }
    }
    console.log(rows.join('\n'));
  });

  it('pause: runs up to the newest snapshot and holds; resume: off again without a jump', () => {
    const paused = (ms: number) => ms >= 3000 && ms < 5000;
    const arrivals = stream({ seconds: 8, seed: 5, paused });
    const frames = play(arrivals, DISPLAYS[0].period);
    expectSound(frames);
    const held = arrivals.find((s) => s.at >= 3000 + 2 * TICK)!.t;
    // Within a few snapshots of the pause the picture is on the last one, and stays.
    for (const f of between(frames, 3000 + 5 * TICK, 5000)) expect(f.clock).toBe(held);
    // (No jump on the way there: at most the speed it had.)
    expect(steps(between(frames, 2900, 3200), 'clock').max).toBeLessThan(1.3 * DISPLAYS[0].period);
    // Resumed: moving again within a few snapshots, no faster than the sim, then steady.
    const resumed = between(frames, 5000, 5400);
    expect(resumed[resumed.length - 1].clock).toBeGreaterThan(held + 0.3);
    expect(steps(resumed, 'clock').max).toBeLessThan(1.3 * DISPLAYS[0].period);
    const steady = steps(after(frames, 5500), 'clock');
    expect(steady.sd).toBeLessThan(0.05 * DISPLAYS[0].period);
  });

  it('time warp 1x -> 10x -> 1x: follows within a few snapshots, no lurch', () => {
    const warp = (ms: number) => (ms >= 3000 && ms < 6000 ? 10 : 1);
    const frames = play(stream({ seconds: 9, seed: 9, warp }), DISPLAYS[0].period);
    expectSound(frames);
    const p = DISPLAYS[0].period;
    // Before, during (from 8 snapshots after the change) and after: the sim's speed, steadily.
    for (const [from, to, rate] of [[1000, 3000, 1], [3000 + 8 * TICK, 6000, 10], [6000 + 8 * TICK, 9000, 1]] as const) {
      const s = steps(between(frames, from, to), 'clock');
      expect(s.mean / (rate * p)).toBeGreaterThan(0.97);
      expect(s.mean / (rate * p)).toBeLessThan(1.03);
      expect(s.min).toBeGreaterThan(0.75 * rate * p);
      expect(s.max).toBeLessThan(1.3 * rate * p);
    }
    // Through the changes: never faster than the faster of the two rates (with the catching-up
    // allowance), never stopped for more than a frame, never backwards.
    for (const at of [3000, 6000]) {
      const d = between(frames, at - 50, at + 10 * TICK);
      const s = steps(d, 'clock');
      expect(s.max).toBeLessThan(1.3 * 10 * p);
      expect(s.min).toBeGreaterThanOrEqual(0);
      const stopped = d.slice(1).filter((f, i) => f.clock === d[i].clock).length;
      expect(stopped).toBeLessThanOrEqual(1);
    }
    // And never far behind: a few snapshots' worth at the rate of the time.
    for (const f of between(frames, 3200, 6000)) expect(f.newest - f.clock).toBeLessThan(4 * 10 * TICK / 1000);
    for (const f of after(frames, 6200)) expect(f.newest - f.clock).toBeLessThan(3 * TICK / 1000);
  });

  it('every warp step up and down the physics levels is followed', () => {
    const levels = [1, 2, 5, 10, 50, 10, 5, 2, 1];
    const warp = (ms: number) => levels[Math.min(levels.length - 1, Math.floor(ms / 2000))];
    const frames = play(stream({ seconds: 18, seed: 21, warp }), DISPLAYS[1].period);
    expectSound(frames);
    levels.forEach((rate, i) => {
      const s = steps(between(frames, i * 2000 + 10 * TICK, (i + 1) * 2000), 'clock');
      expect(s.mean / (rate * DISPLAYS[1].period)).toBeGreaterThan(0.97);
      expect(s.mean / (rate * DISPLAYS[1].period)).toBeLessThan(1.03);
    });
  });

  it('a reset (sim time back to zero): snaps to the new snapshot at once', () => {
    const arrivals = stream({ seconds: 6, seed: 13, resetAt: 3000 });
    const frames = play(arrivals, DISPLAYS[0].period);
    const first = arrivals.find((s, i) => i > 0 && s.t < arrivals[i - 1].t)!;
    const f = frames.find((x) => x.now >= first.at)!;
    // The first frame after it: the new snapshot itself, nothing blended from before.
    expect(f.a).toBe(first.t);
    expect(f.b).toBe(first.t);
    expect(f.clock).toBe(first.t);
    // Then on from there as from any start.
    const later = after(frames, first.at + 500);
    expectSound(later);
    expect(steps(later, 'clock').sd).toBeLessThan(0.05 * DISPLAYS[0].period);
    for (const x of later) expect(x.newest - x.clock).toBeLessThan(3 * TICK / 1000);
  });

  it('a leap forward (a new scene far ahead, a jump on rails): snaps too', () => {
    const clock = new SnapshotClock<number>();
    let at = 0, t = 0;
    for (let i = 0; i < 60; i++) clock.push(i, (t += 1 / 60), (at += TICK));
    clock.sample(at);
    clock.push(1000, (t += 400), (at += TICK));
    const f = clock.sample(at + 5)!;
    expect(f.a).toBe(1000);
    expect(f.b).toBe(1000);
    expect(f.t).toBe(t);
  });

  it('snapshots delivered in a bunch after a busy stretch: back on the line, not thrown by them', () => {
    // 150 ms with the page busy: nine snapshots arrive together, then the stream goes on.
    const arrivals = stream({ seconds: 6, seed: 17, jitter: 2 }).map((s) => (s.at > 3000 && s.at < 3150 ? { t: s.t, at: 3150 } : s));
    const frames = play(arrivals, DISPLAYS[0].period).filter((f) => f.now < 3000 || f.now > 3150);
    expectSound(frames);
    const s = steps(after(frames, 3200), 'clock');
    expect(s.sd).toBeLessThan(0.05 * DISPLAYS[0].period);
    for (const f of after(frames, 3200)) expect(f.newest - f.clock).toBeLessThan(3 * TICK / 1000);
  });

  it('no frames drawn for a second (the pause menu up, the tab hidden): back in step at once', () => {
    const arrivals = stream({ seconds: 6, seed: 19 });
    const frames = play(arrivals, DISPLAYS[0].period).filter((f) => f.now < 3000 || f.now > 4000);
    // (play() sampled the clock all along: again, with the frames really left out.)
    const clock = new SnapshotClock<Arrival>();
    const drawn: { now: number; t: number; newest: number }[] = [];
    let i = 0;
    for (const f of frames) {
      while (i < arrivals.length && arrivals[i].at <= f.now) clock.push(arrivals[i], arrivals[i].t, arrivals[i++].at);
      drawn.push({ now: f.now, t: clock.sample(f.now)!.t, newest: arrivals[i - 1].t });
    }
    drawn.forEach((d, k) => {
      expect(d.t).toBeLessThanOrEqual(d.newest + 1e-9);
      if (k > 0) expect(d.t).toBeGreaterThanOrEqual(drawn[k - 1].t);
      if (d.now > 1000) expect(d.newest - d.t).toBeLessThan(3.5 * TICK / 1000);
    });
  });

  it('nothing to draw before the first snapshot; the first is drawn as it is', () => {
    const clock = new SnapshotClock<string>();
    expect(clock.sample(0)).toBeNull();
    clock.push('first', 12.5, 100);
    expect(clock.sample(104)).toEqual({ a: 'first', b: 'first', alpha: 1, t: 12.5 });
    clock.reset();
    expect(clock.sample(110)).toBeNull();
  });
});
