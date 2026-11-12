// Instant replay: the last few minutes of the flight, kept as the sim sent them, played back
// through the same renderer (any camera, any speed, scrubbed back and forth) while the live
// flight waits, paused. The snapshots are stored as they came (without their one-off events,
// so a replay doesn't log, score or sound them again), one every 1/30 s of sim time at most.

import type { Snapshot } from '../sim/simulation';
import { escapeHtml, keyText } from './keyLabels';

/** Snapshots kept: 5 minutes at 30 a second. */
const CAPACITY = 9000;
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

const clock = (t: number | null) => {
  if (t === null) return '';
  const a = Math.abs(t);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), s = Math.floor(a % 60);
  return `T${t < 0 ? '-' : '+'}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export class Replay {
  private buf: Snapshot[] = [];
  active = false;
  playing = true;
  private speedIx = 3;
  /** Playback position: sim time. */
  private t = 0;
  private lastNow = 0;
  private bar: HTMLElement;
  private shown = '';

  constructor() {
    this.bar = document.createElement('div');
    this.bar.id = 'replay-bar';
    this.bar.className = 'hidden';
    document.body.append(this.bar);
  }

  /** Each live snapshot (not while replaying). */
  record(s: Snapshot): void {
    const last = this.buf[this.buf.length - 1];
    // (A new flight or scene starts the replay over.)
    if (last && (s.t < last.t || s.t - last.t > 600)) this.buf.length = 0;
    else if (last && s.t - last.t < 1 / 30) return;
    this.buf.push({ ...s, events: [] });
    if (this.buf.length > CAPACITY) this.buf.splice(0, this.buf.length - CAPACITY);
  }

  /** Whether there's anything to replay (a few seconds at least). */
  get available(): boolean {
    return this.buf.length > 30 && this.buf[this.buf.length - 1].t - this.buf[0].t > 3;
  }

  start(now: number): void {
    if (!this.available) return;
    this.active = true;
    this.playing = true;
    this.speedIx = 3;
    // From 30 s back (or the start of what's kept).
    const end = this.buf[this.buf.length - 1].t;
    this.t = Math.max(this.buf[0].t, end - 30);
    this.lastNow = now;
    this.bar.classList.remove('hidden');
  }

  stop(): void {
    this.active = false;
    this.bar.classList.add('hidden');
  }

  togglePlay(): void {
    this.playing = !this.playing;
  }

  speed(dir: -1 | 1): void {
    this.speedIx = Math.max(0, Math.min(SPEEDS.length - 1, this.speedIx + dir));
  }

  seek(seconds: number): void {
    if (!this.buf.length) return;
    this.t = Math.max(this.buf[0].t, Math.min(this.buf[this.buf.length - 1].t, this.t + seconds));
  }

  /**
   * Each frame while replaying: the two snapshots either side of the playback time and how far
   * between (for the renderer's interpolation). now: real ms.
   */
  frame(now: number): { a: Snapshot; b: Snapshot; f: number } | null {
    if (!this.buf.length) return null;
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const first = this.buf[0].t, last = this.buf[this.buf.length - 1].t;
    if (this.playing) this.t += dt * SPEEDS[this.speedIx];
    if (this.t >= last) {
      this.t = last;
      this.playing = false;
    }
    this.t = Math.max(first, this.t);
    // (Binary search for the pair round t.)
    let lo = 0, hi = this.buf.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].t <= this.t) lo = mid;
      else hi = mid;
    }
    const a = this.buf[lo], b = this.buf[hi];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (this.t - a.t) / (b.t - a.t))) : 1;
    const span = Math.max(1e-6, last - first);
    const pct = ((this.t - first) / span) * 100;
    const html =
      `<b>REPLAY</b><span>${clock(a.missionTime)}</span>` +
      `<i class="rp-track"><i style="width:${pct.toFixed(1)}%"></i></i>` +
      `<span>${this.playing ? '▶' : '❚❚'} ${SPEEDS[this.speedIx]}×</span>` +
      `<small>${escapeHtml(`${keyText('launch')} play · ← → 5 s · ${keyText('warpDown')} ${keyText('warpUp')} speed · ${keyText('replay')} back to live`)}</small>`;
    // (Only when it changes: every write costs a style / layout pass.)
    if (html !== this.shown) {
      this.shown = html;
      this.bar.innerHTML = html;
    }
    return { a, b, f };
  }
}
