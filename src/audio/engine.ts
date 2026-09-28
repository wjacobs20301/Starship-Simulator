// The one Web Audio graph everything plays through: two buses, the world (engines, wind, the
// tower...) and the interface (menu music, button sounds), into a master gain (mute) and a
// limiter. The world bus is faded out behind the main menu. Browsers only allow audio after a
// user gesture, so it starts on the first key press or click; sound modules register with
// onStart() and build their part of the graph then.

export type AudioSetup = (ctx: AudioContext, out: AudioNode) => void;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private world: GainNode | null = null;
  private ui: GainNode | null = null;
  private muted = false;
  private worldLevel = 1;
  private pending: { setup: AudioSetup; bus: 'world' | 'ui' }[] = [];

  constructor() {
    const start = () => {
      this.start();
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
  }

  /** Run `setup` once the audio is running (now, if it already is). */
  onStart(setup: AudioSetup, bus: 'world' | 'ui' = 'world'): void {
    if (this.ctx && this.world && this.ui) setup(this.ctx, bus === 'world' ? this.world : this.ui);
    else this.pending.push({ setup, bus });
  }

  /** Fade the world's sounds (0 behind the main menu, 1 in the game). */
  setWorldLevel(level: number, seconds = 0.6): void {
    this.worldLevel = level;
    if (this.ctx && this.world) this.world.gain.setTargetAtTime(level, this.ctx.currentTime, seconds / 3);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  private start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    // Keep the peaks from clipping when you're right under it.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 12;
    this.master.connect(limiter).connect(ctx.destination);
    this.world = ctx.createGain();
    this.world.gain.value = this.worldLevel;
    this.world.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.connect(this.master);
    for (const { setup, bus } of this.pending) setup(ctx, bus === 'world' ? this.world : this.ui);
    this.pending = [];
  }
}

// --- Shared noise sources ------------------------------------------------------------------

/** Loop length, s: long enough that the repeat isn't heard (a crackle pattern every few seconds is). */
const SECONDS = 12;
/** The crossfade that joins a loop's end to its start, s. */
const JOIN = 0.25;

/**
 * `length` samples of a signal that loops without a seam: `fill` makes `join` samples more than
 * that, and the overrun is crossfaded (equal power: the noise either side is uncorrelated) into
 * the start. So the last sample runs straight on into the first, with no dip or click at the join.
 */
export function seamlessLoop(fill: (out: Float32Array) => void, length: number, join: number): Float32Array<ArrayBuffer> {
  const raw = new Float32Array(length + join);
  fill(raw);
  const out = raw.slice(0, length);
  for (let i = 0; i < join; i++) {
    const k = ((i + 0.5) / join) * (Math.PI / 2);
    out[i] = raw[i] * Math.sin(k) + raw[length + i] * Math.cos(k);
  }
  return out;
}

/** A looping noise buffer (stereo, decorrelated channels) with a seamless join. */
export function noiseBuffer(ctx: AudioContext, fill: (out: Float32Array) => void): AudioBuffer {
  const length = Math.round(ctx.sampleRate * SECONDS);
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) buf.copyToChannel(seamlessLoop(fill, length, Math.round(ctx.sampleRate * JOIN)), c);
  return buf;
}

export function white(out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
}

/** Pink noise (Paul Kellet's filter): equal energy per octave, like wind and surf. */
export function pink(out: Float32Array): void {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

/** Brown (random-walk) noise: most energy in the lows. */
export function brown(out: Float32Array): void {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    out[i] = last * 3.5;
  }
}
