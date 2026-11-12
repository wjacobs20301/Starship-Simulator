// The render clock between simulation snapshots.
//
// The sim posts a snapshot about 60 times a second from a timer in its worker. They arrive a
// few ms early or late, now and then a whole frame late, and their sim times step unevenly (the
// physics runs in whole steps). Drawing straight between the last two as they arrive makes the
// picture stall when one is late and hurry when one is early, and on a 60 Hz display it beats
// against the timer: the ground rushing past at liftoff judders.
//
// So the picture gets a clock of its own, in sim time. It runs smoothly with real time, at the
// rate the snapshots have been coming at (a straight line fitted through the recent arrivals:
// sim time against arrival time, so one early or late arrival hardly moves it), a couple of
// snapshot intervals behind the newest, so there is nearly always a snapshot either side of it
// to draw between. A short buffer of snapshots is kept for that.
//
// What changes the line:
//   - a discontinuity (sim time going backwards, or leaping far further than the rate allows: a
//     reset, a new menu scene, a jump on rails): everything is dropped and the clock snaps to
//     the new snapshot;
//   - a change of rate (time warp, pause, resume): arrivals stop fitting the line, all to the
//     same side. Two in a row and the line is started again from the last one that fitted;
//     with the clock two intervals behind, that is just as it reaches the change. Paused, it
//     runs on to the snapshot the sim stopped at and stays; off again, it leaves as its place
//     behind the line comes by;
//   - a lone arrival off the line (held up behind a busy frame) is left out of it.
//
// No DOM, no three: only numbers (tests/snapshotClock.test.ts).

/** What to draw for a frame: between a and b (0 = a, 1 = b), and the sim time that is. */
export interface ClockFrame<T> {
  a: T;
  b: T;
  alpha: number;
  t: number;
}

interface Arrival {
  /** Sim time, s. */
  t: number;
  /** When it arrived, real ms. */
  at: number;
}

/** How far behind the line the clock runs, in snapshot intervals. */
const DELAY = 2;
/** Arrivals the line is fitted through, at most (two thirds of a second's). */
const FIT_MAX = 40;
/** An arrival fits the line if it's within this many snapshots' worth of sim time of it. */
const TOLERANCE = 1;
/** This many arrivals in a row off the line, on the same side: the rate has changed. */
const CHANGE_AFTER = 2;
/** None fitting for this many arrivals (very uneven timing): the line is fitted to them as they are. */
const STARVED_AFTER = 10;
/**
 * The clock closes on its place behind the line over about this long, ms, running at most this
 * much faster than the sim to catch up...
 */
const SLEW_MS = 300;
const MAX_FAST = 0.25;
/**
 * ...and when it's ahead of its place (too near the newest snapshot: one a little late and the
 * picture would have to wait for it), sooner, and by up to this much slower.
 */
const SLEW_BACK_MS = 120;
const MAX_SLOW = 0.5;
/** Further behind than this many intervals (after a hitch): it jumps there instead. */
const RESYNC = 4;
/** A step in sim time this many times what the rate gives (and over LEAP_MIN s) is a discontinuity. */
const LEAP_FACTOR = 100;
const LEAP_MIN = 1;
/** Snapshots kept to draw between, at most. */
const BUF_MAX = 24;
/** No arrivals for this long, ms (the page was busy or hidden): the line is fitted afresh. */
const HIATUS_MS = 250;
/** Less sim time than this per snapshot, s: standing still (paused). */
const STILL = 1e-6;

export class SnapshotClock<T> {
  /** Recent snapshots, oldest first: from the one at or before the clock on. */
  private buf: { t: number; item: T }[] = [];
  /** The arrivals the line is fitted through. */
  private fit: Arrival[] = [];
  /** Arrivals off the line since the last that fitted: stragglers, or the start of a new rate. */
  private pending: Arrival[] = [];
  private pendingSide = 0;
  /** The latest arrivals, fitting or not (for STARVED_AFTER). */
  private recent: Arrival[] = [];
  private sinceFit = 0;
  /** Which of fit / pending the last arrival went to. */
  private lastIn: Arrival[] | null = null;
  private lastAt = 0;
  /** The line: sim seconds per real ms (null: not known yet), through (lineAt, lineT). */
  private slope: number | null = null;
  private lineT = 0;
  private lineAt = 0;
  /** Real ms between snapshots, averaged. */
  private interval = 1000 / 60;
  /** The last rate the clock ran at (to run on to the snapshot the sim stopped at when it pauses). */
  private coast = 0;
  private clock = 0;
  /** The clock is standing (paused, or the rate not known yet) rather than running along the line. */
  private waiting = true;
  private lastNow: number | null = null;

  /** Sim seconds per real ms, as the arrivals have it (0 before it's known, and paused). */
  get rate(): number {
    return this.slope ?? 0;
  }

  /** The clock's sim time (as of the last frame). */
  get time(): number {
    return this.clock;
  }

  /** Forget everything: the next snapshot starts afresh (a new flight or scene). */
  reset(): void {
    this.buf = [];
  }

  /** A snapshot has arrived: its sim time (s) and when (real ms). */
  push(item: T, t: number, at: number): void {
    const newest = this.buf[this.buf.length - 1];
    if (!newest) return this.start(item, t, at);
    const dt = t - newest.t;
    const gap = at - this.lastAt;
    // A discontinuity: nothing before it is any use. (A leap can only be told once the rate is known.)
    if (dt < 0 || (this.slope !== null && dt > LEAP_MIN && dt > LEAP_FACTOR * this.slope * Math.max(gap, this.interval))) {
      return this.start(item, t, at);
    }
    this.lastAt = at;
    // (The same sim time again, paused: the latest of them is the one to show.)
    if (dt === 0) newest.item = item;
    else this.buf.push({ t, item });
    while (this.buf.length > 2 && this.buf[1].t <= this.clock) this.buf.shift();
    if (this.buf.length > BUF_MAX) this.buf.splice(0, this.buf.length - BUF_MAX);

    const arrival = { t, at };
    if (gap > HIATUS_MS) {
      // (The old line stands until there are enough new arrivals for another.)
      this.fit = [arrival];
      this.pending = [];
      this.recent = [arrival];
      this.sinceFit = 0;
      this.lastIn = this.fit;
      return;
    }
    this.interval += (gap - this.interval) * 0.05;
    // Hard on the heels of the last one: that one was held up (several delivered at once after a
    // busy frame), so it says nothing about the timing. This one stands for both.
    if (gap < 0.25 * this.interval && this.lastIn?.length) {
      this.lastIn.pop();
      this.recent.pop();
    }
    this.recent.push(arrival);
    if (this.recent.length > STARVED_AFTER) this.recent.shift();

    if (this.slope === null || this.fit.length < 3) return this.accept(arrival);
    const off = t - (this.lineT + this.slope * (at - this.lineAt));
    if (Math.abs(off) <= TOLERANCE * this.slope * this.interval + STILL) return this.accept(arrival);
    // Off the line.
    const side = Math.sign(off);
    if (side !== this.pendingSide) this.pending = [];
    this.pendingSide = side;
    this.pending.push(arrival);
    this.lastIn = this.pending;
    if (this.pending.length >= CHANGE_AFTER) {
      // A new rate, from the last arrival on the old line (the worker changes rate on a tick).
      this.fit = [this.fit[this.fit.length - 1], ...this.pending];
      this.pending = [];
      this.sinceFit = 0;
      this.lastIn = this.fit;
      this.refit();
    } else if (++this.sinceFit >= STARVED_AFTER) {
      this.fit = this.recent.slice();
      this.pending = [];
      this.sinceFit = 0;
      this.lastIn = this.fit;
      this.refit();
    }
  }

  /**
   * For a frame drawn at `now` (real ms, the same clock as the arrivals'): the two snapshots to
   * draw between and how far. Never past the newest; never backwards. Null before any snapshot.
   */
  sample(now: number): ClockFrame<T> | null {
    const n = this.buf.length;
    if (!n) return null;
    const newest = this.buf[n - 1];
    const dt = this.lastNow === null ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    const rate = this.slope;
    const step = rate === null ? 0 : rate * this.interval;
    if (rate === null) {
      // Rate not known yet (the first snapshots after a reset): the picture waits on the first.
      this.waiting = true;
    } else if (step < STILL) {
      // Paused: on at the rate it had to the snapshot the sim stopped on, and hold there. (Not
      // onto a later one: that is the sim off again, and the line about to say so.)
      const stop = Math.min(newest.t, this.lineT);
      if (stop > this.clock) this.clock += Math.min(stop - this.clock, this.coast > 0 ? this.coast * dt : Infinity);
      this.waiting = true;
    } else {
      this.coast = rate;
      /** Its place: behind the line. */
      const place = this.lineT + rate * (now - this.lineAt) - DELAY * step;
      if (this.waiting) {
        // Standing, and the sim is off again: it leaves as its place comes by (not before: it
        // would be hard up against the newest snapshot).
        if (place > this.clock) {
          this.clock = Math.min(place, this.clock + rate * dt);
          this.waiting = false;
        }
      } else {
        // On by the real time since the last frame; then how far that is from its place.
        this.clock += rate * dt;
        const err = place - this.clock;
        // (Left far behind, by a hitch: straight there. Otherwise a little faster or slower.)
        if (err > RESYNC * step) this.clock = place;
        else this.clock += rate * dt * (err > 0 ? Math.min(MAX_FAST, err / (rate * SLEW_MS)) : Math.max(-MAX_SLOW, err / (rate * SLEW_BACK_MS)));
      }
    }
    // Only between snapshots there are: the next one late, the clock waits on the newest.
    this.clock = Math.max(this.buf[0].t, Math.min(newest.t, this.clock));
    let i = n - 1;
    while (i > 0 && this.buf[i].t > this.clock) i--;
    const a = this.buf[i];
    const b = this.buf[i + 1] ?? a;
    return { a: a.item, b: b.item, alpha: b.t > a.t ? (this.clock - a.t) / (b.t - a.t) : 1, t: this.clock };
  }

  /** From this snapshot on: the clock on it, the rate to be found. */
  private start(item: T, t: number, at: number): void {
    const arrival = { t, at };
    this.buf = [{ t, item }];
    this.fit = [arrival];
    this.pending = [];
    this.recent = [arrival];
    this.sinceFit = 0;
    this.lastIn = this.fit;
    this.lastAt = at;
    this.slope = null;
    this.coast = 0;
    this.clock = t;
    this.waiting = true;
  }

  /** An arrival that fits the line (or there's no line yet to judge it by): the line takes it in. */
  private accept(arrival: Arrival): void {
    this.pending = [];
    this.sinceFit = 0;
    this.fit.push(arrival);
    if (this.fit.length > FIT_MAX) this.fit.shift();
    this.lastIn = this.fit;
    this.refit();
  }

  /** Least squares: sim time against arrival time. (Fewer than three arrivals: the line stays as it was.) */
  private refit(): void {
    const n = this.fit.length;
    if (n < 3) return;
    let mAt = 0, mT = 0;
    for (const p of this.fit) {
      mAt += p.at - this.fit[0].at;
      mT += p.t - this.fit[0].t;
    }
    mAt = this.fit[0].at + mAt / n;
    mT = this.fit[0].t + mT / n;
    let sxx = 0, sxy = 0;
    for (const p of this.fit) {
      sxx += (p.at - mAt) * (p.at - mAt);
      sxy += (p.at - mAt) * (p.t - mT);
    }
    if (sxx <= 0) return;
    this.slope = Math.max(0, sxy / sxx);
    this.lineAt = mAt;
    this.lineT = mT;
  }
}
