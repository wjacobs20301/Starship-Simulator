// The rollout's score: music under the ship's ride out to the pad, made here as it plays (no
// recording: oscillators and noise, like the menu's), and built up with the road. It is in D
// minor, four bars round and round (D minor, B flat, F, C) at a walking 78 beats a minute, and
// what plays over them depends on how far along its way the transport is:
//
//   leaving the gate     a low drone and slow chords
//   a little way on      short string notes, eight to the bar
//   a quarter of the way a bass on the beat
//   a third              a deep drum on the bar, then on the half bar
//   nearly half          the theme, on horns: eight bars, the second four a third higher
//   two thirds           high strings over it, a swell and a cymbal into each fourth bar
//   three quarters       the drums driving, the short strings doubled, the theme an octave up
//   on its stand         one chord of D major, a drum and a cymbal, left to ring
//
// Everything is scheduled a bar at a time on the audio clock (scoreBar), from update() each
// frame. The bar and the last chord are plain functions of an audio context, so they can be
// rendered without being heard (an OfflineAudioContext) to check their levels.

import type { AudioEngine } from './engine';

const BPM = 78;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
/** How loud the whole score is, on the world's bus. */
const LEVEL = 0.62;

/** The four bars' chords (MIDI notes): the bass's note, the slow chord, and the notes the short strings play. */
const CHORDS = [
  { root: 38, pad: [57, 62, 65], arp: [62, 65, 69, 74] },
  { root: 34, pad: [58, 62, 65], arp: [62, 65, 70, 74] },
  { root: 41, pad: [57, 60, 65], arp: [60, 65, 69, 72] },
  { root: 36, pad: [55, 60, 64], arp: [60, 64, 67, 72] },
];
/** Which of a chord's notes the short strings play on each half beat. */
const PATTERN = [0, 2, 1, 2, 0, 3, 1, 2];
/** The theme, eight bars of it: in each, [the beat it starts on, how many beats long, the note]. */
const THEME: [number, number, number][][] = [
  [[0, 2, 62], [2, 1, 65], [3, 1, 69]],
  [[0, 3, 70], [3, 1, 69]],
  [[0, 2, 65], [2, 1, 69], [3, 1, 72]],
  [[0, 2, 67], [2, 2, 64]],
  [[0, 2, 69], [2, 1, 74], [3, 1, 77]],
  [[0, 3, 77], [3, 1, 74]],
  [[0, 2, 72], [2, 1, 69], [3, 1, 72]],
  [[0, 4, 76]],
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const sm = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The score's own mixer: a bus for each section, into one tone control and a hall. */
export interface ScoreBus {
  ctx: BaseAudioContext;
  /** Everything the bars play (faded out under the last chord), and the last chord's own way in. */
  body: GainNode;
  end: GainNode;
  pad: AudioNode;
  short: AudioNode;
  low: AudioNode;
  brass: AudioNode;
  high: AudioNode;
  drums: AudioNode;
  /** The tone control: dull at the gate, open at the pad. */
  tone: BiquadFilterNode;
  noise: AudioBuffer;
}

export function scoreBus(ctx: BaseAudioContext, out: AudioNode): ScoreBus {
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 700;
  tone.Q.value = 0.5;
  tone.connect(out);
  // A hall: three seconds of dying noise.
  const len = Math.floor(ctx.sampleRate * 3.2);
  const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = impulse.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * (1 - i / len) ** 2.2;
    }
  }
  const hall = ctx.createConvolver();
  hall.buffer = impulse;
  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  tone.connect(hall).connect(wet).connect(out);
  const body = ctx.createGain();
  body.connect(tone);
  const end = ctx.createGain();
  end.connect(tone);
  /** A section: its own top cut, into the body. */
  const section = (cut: number, q = 0.5): AudioNode => {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cut;
    f.Q.value = q;
    f.connect(body);
    return f;
  };
  const noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  return { ctx, body, end, pad: section(1500), short: section(2800, 0.9), low: section(380), brass: section(2400), high: section(4200), drums: body, tone, noise };
}

/** A held note: a wave, a note, a few cents off it; from t for dur, rising over attack and dying over release. */
function held(b: ScoreBus, dest: AudioNode, type: OscillatorType, midi: number, cents: number, t: number, dur: number, peak: number, attack: number, release: number): void {
  const o = b.ctx.createOscillator();
  o.type = type;
  o.frequency.value = hz(midi);
  o.detune.value = cents;
  const g = b.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, Math.max(t + attack, t + dur - release));
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** A short note: struck, and gone in `decay` seconds. */
function struck(b: ScoreBus, dest: AudioNode, type: OscillatorType, midi: number, t: number, peak: number, decay: number): void {
  const o = b.ctx.createOscillator();
  o.type = type;
  o.frequency.value = hz(midi);
  const g = b.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-6, peak * 0.001), t + decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + decay + 0.05);
}

/** A drum: a tone falling from f0 to f1 (Hz) and dying over `decay`, with a thump of noise on it. */
function drum(b: ScoreBus, dest: AudioNode, t: number, peak: number, f0: number, f1: number, decay: number): void {
  const o = b.ctx.createOscillator();
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.4);
  const g = b.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.004);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-6, peak * 0.001), t + decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + decay + 0.05);
  hiss(b, dest, t, peak * 0.5, 'lowpass', f0 * 4, f0 * 4, 0.004, decay * 0.25);
}

/** Noise through a filter that moves from f0 to f1 (Hz): up to its peak over `rise`, gone `fall` after. */
function hiss(b: ScoreBus, dest: AudioNode, t: number, peak: number, type: BiquadFilterType, f0: number, f1: number, rise: number, fall: number): void {
  const n = b.ctx.createBufferSource();
  n.buffer = b.noise;
  n.loop = true;
  const f = b.ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = 0.8;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + rise + fall);
  const g = b.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + rise);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-6, peak * 0.001), t + rise + fall);
  n.connect(f).connect(g).connect(dest);
  n.start(t, Math.random() * 2);
  n.stop(t + rise + fall + 0.05);
}

/** A horn note: saws an octave apart behind a filter that opens as it's blown. */
function horn(b: ScoreBus, dest: AudioNode, midi: number, t: number, dur: number, peak: number): void {
  const f = b.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(380, t);
  f.frequency.linearRampToValueAtTime(1700, t + 0.22);
  f.frequency.setTargetAtTime(1100, t + 0.3, 0.5);
  f.connect(dest);
  for (const [up, cents, k] of [[0, -5, 1], [0, 6, 1], [-12, 0, 0.6]]) held(b, f, 'sawtooth', midi + up, cents, t, dur + 0.12, peak * k, 0.09, 0.22);
}

/**
 * One bar of the score, from t0: bar counts them (the chord, the theme's place); x is how far
 * along its way the transport is, 0..1 (what plays, and how hard).
 */
export function scoreBar(b: ScoreBus, t0: number, bar: number, x: number): void {
  const ch = CHORDS[bar % 4];
  b.tone.frequency.setTargetAtTime(700 + 6800 * x * x, t0, 1.5);
  // The drone, and the slow chord over it: each a little into the next.
  // (The drone is kept under the rest: most of a bar's power would be in it otherwise, the same
  // at the gate as at the pad, and nothing over it heard to build.)
  held(b, b.low, 'sine', ch.root, 0, t0, BAR + 0.5, 0.07 + 0.05 * x, 0.4, 0.6);
  held(b, b.low, 'triangle', ch.root + 12, 0, t0, BAR + 0.5, 0.03 + 0.03 * x, 0.4, 0.6);
  for (const m of ch.pad) for (const cents of [-7, 7]) held(b, b.pad, 'sawtooth', m, cents, t0, BAR + 1.1, 0.02 + 0.03 * x, 0.9, 1.4);
  // The short strings: eight to the bar, the beats leaned on; later, more between them an octave up.
  const short = sm(x, 0.05, 0.4);
  const more = sm(x, 0.7, 0.88);
  for (let k = 0; k < 8; k++) {
    const t = t0 + (k * BEAT) / 2;
    const lean = k % 4 === 0 ? 1 : k % 2 === 0 ? 0.8 : 0.55;
    if (short > 0) {
      struck(b, b.short, 'sawtooth', ch.arp[PATTERN[k]], t, 0.07 * short * lean, 0.2);
      struck(b, b.short, 'triangle', ch.arp[PATTERN[k]] - 12, t, 0.05 * short * lean, 0.24);
    }
    if (more > 0) struck(b, b.short, 'sawtooth', ch.arp[PATTERN[(k + 3) % 8]] + 12, t + BEAT / 4, 0.03 * more, 0.14);
  }
  // The bass on the beat.
  const bass = sm(x, 0.2, 0.45);
  if (bass > 0) for (let k = 0; k < 4; k++) struck(b, b.low, 'sawtooth', ch.root + 12, t0 + k * BEAT, 0.16 * bass * (k === 0 ? 1 : 0.75), 0.34);
  // The drums: on the bar; on the half bar, with a pick-up; then driving.
  const d1 = sm(x, 0.32, 0.42), d2 = sm(x, 0.5, 0.6), d3 = sm(x, 0.74, 0.86);
  if (d1 > 0) drum(b, b.drums, t0, 0.5 * d1, 92, 38, 0.9);
  if (d2 > 0) {
    drum(b, b.drums, t0 + 2 * BEAT, 0.34 * d2, 88, 40, 0.7);
    drum(b, b.drums, t0 + 3.5 * BEAT, 0.26 * d2, 150, 74, 0.3);
  }
  if (d3 > 0) {
    drum(b, b.drums, t0 + 1.5 * BEAT, 0.24 * d3, 150, 74, 0.3);
    drum(b, b.drums, t0 + 3 * BEAT, 0.28 * d3, 130, 62, 0.34);
    // (A roll into the next bar.)
    for (let k = 0; k < 4; k++) hiss(b, b.drums, t0 + (3 + k / 4) * BEAT, 0.05 * d3 * (0.5 + k / 6), 'highpass', 1900, 1900, 0.003, 0.07);
  }
  // The theme on horns; an octave over it, late on.
  const theme = sm(x, 0.42, 0.58);
  const over = sm(x, 0.74, 0.9);
  if (theme > 0) {
    for (const [beat, len, m] of THEME[bar % 8]) {
      horn(b, b.brass, m, t0 + beat * BEAT, len * BEAT, 0.05 * theme);
      if (over > 0) for (const cents of [-8, 8]) held(b, b.high, 'sawtooth', m + 12, cents, t0 + beat * BEAT, len * BEAT + 0.1, 0.014 * over, 0.12, 0.2);
    }
  }
  // High strings, held.
  const high = sm(x, 0.6, 0.8);
  if (high > 0) for (const cents of [-9, 9]) held(b, b.high, 'sawtooth', ch.arp[2] + 12, cents, t0, BAR + 0.8, 0.016 * high, 1, 1.1);
  // A swell through every fourth bar, and a cymbal where it breaks.
  const swell = sm(x, 0.55, 0.8);
  if (swell > 0 && bar % 4 === 3) hiss(b, b.body, t0 + BAR - 2.4, 0.05 * swell, 'bandpass', 500, 6000, 2.4, 0.25);
  if (swell > 0 && bar % 4 === 0 && bar > 0) hiss(b, b.body, t0, 0.05 * swell, 'highpass', 5200, 5200, 0.004, 2.2);
}

/** The last chord, from t: the bars' music away under it, D major on everything, a drum and a cymbal. Rings for about 12 s. */
export function scoreEnd(b: ScoreBus, t: number): void {
  b.body.gain.setValueAtTime(1, t);
  b.body.gain.linearRampToValueAtTime(0, t + 0.3);
  b.tone.frequency.setTargetAtTime(6500, t, 0.2);
  const low = b.ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 2600;
  low.connect(b.end);
  held(b, b.end, 'sine', 38, 0, t, 11, 0.14, 0.05, 8);
  for (const m of [50, 57, 62, 66, 69, 74]) for (const cents of [-7, 7]) held(b, low, 'sawtooth', m, cents, t, 10, 0.03, 0.12, 7.5);
  for (const m of [66, 69, 74]) horn(b, low, m, t, 5.5, 0.03);
  drum(b, b.end, t, 0.6, 92, 36, 1.6);
  hiss(b, b.end, t, 0.07, 'highpass', 4800, 4800, 0.004, 3.2);
}

/** How hard the score plays for a way gone (0..1): everything in by the time the transport is through the gate. */
export const scoreLevel = (progress: number): number => Math.min(1, Math.max(0, progress) / 0.9);

export class RolloutScore {
  private ctx: AudioContext | null = null;
  private dest: AudioNode | null = null;
  /** This rollout's music: its own way out (so stopping one can't leave notes for the next), its mixer. */
  private out: GainNode | null = null;
  private bus: ScoreBus | null = null;
  private state: 'idle' | 'playing' | 'ending' = 'idle';
  private nextBar = 0;
  private bar = 0;
  private endsAt = 0;
  private held = false;
  private progress = 0;

  constructor(engine: AudioEngine) {
    engine.onStart((ctx, out) => {
      this.ctx = ctx;
      this.dest = out;
    }, 'world');
  }

  /** Each frame. tr: the vehicle rolling out (the snapshot's transport), if one is; paused: time stopped, or a menu up. */
  update(tr: { progress: number; arrived: boolean } | null | undefined, paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.dest) return;
    const now = ctx.currentTime;
    if (this.state === 'idle') {
      // (Also a flight loaded part of the way out: it starts where the road has got to.)
      if (tr && !tr.arrived && !paused) this.begin(now, tr.progress);
      return;
    }
    // A new flight, or the rollout begun again: this one's music is over.
    if (!tr || tr.progress < this.progress - 0.02) return this.stop(now, 0.25);
    this.progress = tr.progress;
    if (this.state === 'ending') {
      if (now > this.endsAt) this.stop(now, 0.5);
      return;
    }
    if (paused !== this.held) {
      this.held = paused;
      this.out!.gain.setTargetAtTime(paused ? 0 : LEVEL, now, paused ? 0.06 : 0.3);
    }
    if (paused) return;
    if (tr.arrived) {
      scoreEnd(this.bus!, now + 0.06);
      this.state = 'ending';
      this.endsAt = now + 13;
      return;
    }
    // The next bar, a little before it's due. (Frames stopped a while, the tab away: on from now.)
    if (this.nextBar < now) this.nextBar = now + 0.06;
    if (now > this.nextBar - 0.3) {
      scoreBar(this.bus!, this.nextBar, this.bar++, scoreLevel(tr.progress));
      this.nextBar += BAR;
    }
  }

  private begin(now: number, progress: number): void {
    const ctx = this.ctx!;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(LEVEL, now, 1.2);
    this.out.connect(this.dest!);
    this.bus = scoreBus(ctx, this.out);
    this.state = 'playing';
    this.held = false;
    this.progress = progress;
    this.bar = 0;
    this.nextBar = now + 0.15;
  }

  private stop(now: number, fade: number): void {
    const out = this.out;
    if (out) {
      out.gain.cancelScheduledValues(now);
      out.gain.setTargetAtTime(0, now, fade / 3);
      window.setTimeout(() => out.disconnect(), fade * 1000 + 300);
    }
    this.out = null;
    this.bus = null;
    this.state = 'idle';
  }
}
