// Menu sound: a slow, generative space-ambient score behind the main menu (warm detuned pads
// through a long reverb over a deep drone, chords drifting every ~9 s, the odd high bell note),
// soft ticks and clicks for the buttons, and a "go" sequence when a flight starts: a rising
// whoosh with a low swell and a few mission-control data chirps.

import { type AudioEngine, noiseBuffer, pink } from './engine';

/** Chords (MIDI notes), drifting A minor / F / C / G. */
const CHORDS = [
  [45, 57, 60, 64, 71],
  [41, 53, 57, 60, 67],
  [48, 55, 60, 64, 69],
  [43, 55, 59, 62, 69],
];
const BELLS = [76, 79, 81, 83, 84, 88];
const CHORD_SECONDS = 9;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A long, dark reverb tail (decaying noise impulse). */
function reverbImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.25 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * (1 - i / len) ** 2.5;
    }
  }
  return buf;
}

export class MenuAudio {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  /** Music bus (faded with the menu) and its reverb send. */
  private music: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private noise: AudioBuffer | null = null;
  private playing = false;
  private timer = 0;
  private chord = 0;
  private lastHover = 0;

  constructor(engine: AudioEngine) {
    engine.onStart((ctx, out) => this.start(ctx, out), 'ui');
  }

  private start(ctx: AudioContext, out: AudioNode): void {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(out);
    this.music = ctx.createGain();
    this.music.gain.value = 0;
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 2200;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = reverbImpulse(ctx, 6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.music.connect(warm).connect(this.out);
    warm.connect(this.reverb).connect(wet).connect(this.out);
    this.noise = noiseBuffer(ctx, pink);
    if (this.playing) this.begin();
  }

  /** Music on (main menu) or off. */
  setMusic(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    if (!this.ctx || !this.music) return;
    if (on) this.begin();
    else {
      this.music.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
      window.clearTimeout(this.timer);
    }
  }

  private begin(): void {
    const ctx = this.ctx!;
    this.music!.gain.cancelScheduledValues(ctx.currentTime);
    this.music!.gain.setTargetAtTime(0.16, ctx.currentTime, 1.5);
    window.clearTimeout(this.timer);
    this.nextChord();
  }

  /** Play the next chord (overlapping the last as it fades), and maybe a bell or two. */
  private nextChord(): void {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const notes = CHORDS[this.chord % CHORDS.length];
    this.chord++;
    const dur = CHORD_SECONDS * 1.6;
    notes.forEach((m, i) => {
      // Two detuned voices per note: a slow, breathing chorus.
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = hz(m);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        const g = ctx.createGain();
        const peak = (i === 0 ? 0.18 : 0.07) / (1 + i * 0.15);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 3.5);
        g.gain.setValueAtTime(peak, t + dur - 5);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g).connect(this.music!);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    });
    // A deep drone an octave under the root, and a breath of filtered noise (like air in a hall).
    const sub = ctx.createOscillator();
    sub.frequency.value = hz(notes[0] - 12);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.12, t + 4);
    sg.gain.setValueAtTime(0.12, t + dur - 5);
    sg.gain.linearRampToValueAtTime(0, t + dur);
    sub.connect(sg).connect(this.music!);
    sub.start(t);
    sub.stop(t + dur + 0.1);
    if (this.noise) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 500 + Math.random() * 500;
      f.Q.value = 0.6;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(0.03, t + 4);
      ng.gain.linearRampToValueAtTime(0, t + dur);
      n.connect(f).connect(ng).connect(this.music!);
      n.start(t, Math.random() * 3);
      n.stop(t + dur + 0.1);
    }
    // Now and then a soft bell from the chord's scale, ringing into the reverb.
    for (let k = 0; k < 3; k++) {
      if (Math.random() < 0.55) this.bell(BELLS[Math.floor(Math.random() * BELLS.length)], t + 1.5 + Math.random() * (CHORD_SECONDS - 2), 0.05);
    }
    this.timer = window.setTimeout(() => this.nextChord(), CHORD_SECONDS * 1000);
  }

  private bell(midi: number, at: number, peak: number, dest: AudioNode = this.music!): void {
    const ctx = this.ctx!;
    for (const [mult, amp] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {
      const o = ctx.createOscillator();
      o.frequency.value = hz(midi) * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak * amp, at + 0.01);
      g.gain.setTargetAtTime(0, at + 0.02, 1.2 / mult);
      o.connect(g).connect(dest);
      o.start(at);
      o.stop(at + 5);
    }
  }

  // --- Interface sounds ---------------------------------------------------------------------

  /** A short blip: frequency glide, length, loudness. */
  private blip(f0: number, f1: number, len: number, peak: number, type: OscillatorType = 'sine', at = 0): void {
    if (!this.ctx || !this.out) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  hover(): void {
    const now = performance.now();
    if (now - this.lastHover < 40) return;
    this.lastHover = now;
    this.blip(2400, 2200, 0.03, 0.02);
  }

  click(): void {
    this.blip(900, 1350, 0.06, 0.07, 'triangle');
    this.blip(1800, 1800, 0.04, 0.02, 'sine', 0.012);
  }

  /** Starting a flight: a rising whoosh over a low swell, and a few data chirps. */
  go(): void {
    if (!this.ctx || !this.out || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(250, t);
    f.frequency.exponentialRampToValueAtTime(3500, t + 0.9);
    f.frequency.exponentialRampToValueAtTime(800, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    n.connect(f).connect(g).connect(this.out);
    g.connect(this.reverb!);
    n.start(t, Math.random() * 2);
    n.stop(t + 2);
    // Low swell.
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 1.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.25, t + 0.7);
    og.gain.exponentialRampToValueAtTime(0.001, t + 2);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 2.1);
    // Data chirps, like a console acknowledging.
    [0.15, 0.27, 0.39, 0.62].forEach((dt, i) => this.blip(1200 + i * 300, 1250 + i * 300, 0.05, 0.05, 'square', dt));
    this.bell(81, t + 0.9, 0.08, this.out);
  }
}
