// Procedural launch sound with Web Audio: a deep brown-noise roar plus the ragged "crackle" of
// supersonic exhaust. Both follow the received level from the SoundField, so the sound arrives
// with the speed-of-sound delay, gets duller with distance (high frequencies die first) and
// fades out as the rocket climbs into thin air.

import { type AudioEngine, brown, noiseBuffer } from './engine';

/** Crackle: sparse, sharp, random-sign pops of varying size. */
function crackle(out: Float32Array, rate: number, sampleRate: number): void {
  out.fill(0);
  let i = 0;
  while (i < out.length) {
    i += Math.floor((-Math.log(1 - Math.random()) * sampleRate) / rate);
    const amp = (Math.random() < 0.5 ? -1 : 1) * Math.random() ** 2;
    const len = 40 + Math.floor(Math.random() * 200);
    for (let k = 0; k < len && i + k < out.length; k++) out[i + k] += amp * Math.exp(-k / (len * 0.2)) * (k % 2 ? -0.6 : 1);
  }
}

export class LaunchAudio {
  private ctx: AudioContext | null = null;
  private rumbleGain: GainNode | null = null;
  private rumbleFilter: BiquadFilterNode | null = null;
  private crackleGain: GainNode | null = null;
  private crackleFilter: BiquadFilterNode | null = null;

  constructor(engine: AudioEngine) {
    engine.onStart((ctx, out) => this.start(ctx, out));
  }

  private start(ctx: AudioContext, out: AudioNode): void {
    this.ctx = ctx;
    const rumble = ctx.createBufferSource();
    rumble.buffer = noiseBuffer(ctx, brown);
    rumble.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(this.rumbleFilter).connect(this.rumbleGain).connect(out);
    rumble.start();

    const pops = ctx.createBufferSource();
    pops.buffer = noiseBuffer(ctx, (o) => crackle(o, 260, ctx.sampleRate));
    pops.loop = true;
    this.crackleFilter = ctx.createBiquadFilter();
    this.crackleFilter.type = 'lowpass';
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    pops.connect(this.crackleFilter).connect(this.crackleGain).connect(out);
    pops.start();
  }

  /**
   * level: received sound level, dB; distance: to the source, m; listenerAir: air density ratio at
   * the listener (no air, no sound); paused: silence while the sim is paused.
   */
  update(level: number, distance: number, listenerAir: number, paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.rumbleGain || !this.crackleGain || !this.rumbleFilter || !this.crackleFilter) return;
    // Compress the huge dynamic range: -40 dB of real level -> -20 dB of output.
    const g = paused || !Number.isFinite(level) ? 0 : Math.min(1, 10 ** ((level - 150) / 40)) * Math.min(1, listenerAir);
    const crackleWeight = Math.min(1, Math.max(0, (level - 112) / 25));
    const now = ctx.currentTime;
    this.rumbleGain.gain.setTargetAtTime(g, now, 0.08);
    this.crackleGain.gain.setTargetAtTime(g * crackleWeight * 0.7, now, 0.08);
    // Air absorbs the highs first.
    const d = Number.isFinite(distance) ? distance : 1e5;
    this.rumbleFilter.frequency.setTargetAtTime(120 + 1400 / (1 + d / 800), now, 0.1);
    this.crackleFilter.frequency.setTargetAtTime(600 + 9000 / (1 + d / 1500), now, 0.1);
  }
}
