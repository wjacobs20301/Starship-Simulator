// Everything you hear besides the engines, synthesised with Web Audio:
//  - the site itself: coastal wind with gusts, and the Gulf surf rolling in;
//  - air rushing past a vehicle flying fast through the atmosphere, and the roar of reentry plasma;
//  - the tower machinery: motor whine and gear rumble while the carriage lifts, the arms swing
//    or slew round, or the QD arm moves, with a clunk as each motion starts and stops;
//  - the deluge water pouring over the launch mount around liftoff, and cryogenic venting hiss
//    from a fuelled stack on the pad;
//  - one-off sounds: the clang of a catch, a clank as the arms take a stage, touchdown thumps,
//    splashes, explosions and the double sonic boom of a stage coming home.
// Every source fades and dulls with distance (air soaks up the highs), and one-off sounds arrive
// late by the distance over the speed of sound.

import type { V3 } from '../sim/math';
import { type AudioEngine, brown, noiseBuffer, pink, white } from './engine';

const SPEED_OF_SOUND = 343;

/** A looping noise voice: source -> filter -> gain -> out. */
interface Voice {
  gain: GainNode;
  filter: BiquadFilterNode;
}

/** Tower machinery for one pad: motor tone and gear noise. */
interface Machine {
  whine: GainNode;
  whineOsc: OscillatorNode;
  whineOsc2: OscillatorNode;
  grind: Voice;
  /** Smoothed motion (0..1+) and whether it was moving last update (for start / stop clunks). */
  motion: number;
  moving: boolean;
}

export interface AmbienceState {
  /** Real seconds since the last update. */
  dt: number;
  paused: boolean;
  /** Camera world position (float64), its height above the sea, and the air density ratio there. */
  cam: V3;
  camAlt: number;
  listenerAir: number;
  /** The fastest-moving vehicle nearby as the camera hears it. */
  vehicles: { world: V3; q: number; mach: number; heatFlux: number }[];
  /** Per pad: where its arms are (world), and how fast they're moving (0 = still, ~1 = full speed). */
  towers: { world: V3; motion: number }[];
  /** Deluge: world position of the launch mount and how hard it's pouring (0..1). */
  deluge: { world: V3; level: number } | null;
  /** A fuelled stack venting on the pad: its world position. */
  vent: V3 | null;
  /** Sim time, s (for the vent bursts, the swell). */
  time: number;
  /** Rain where the camera is, 0..1. */
  rain: number;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private wind: Voice | null = null;
  private surf: Voice | null = null;
  private rush: Voice | null = null;
  private plasma: Voice | null = null;
  private deluge: Voice | null = null;
  private vent: Voice | null = null;
  private rain: Voice | null = null;
  private rainPatter: Voice | null = null;
  private machines: Machine[] = [];
  private buffers: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } | null = null;
  /** Gust: a slow random walk around 1. */
  private gust = 1;
  private gustTarget = 1;

  constructor(engine: AudioEngine) {
    engine.onStart((ctx, out) => this.start(ctx, out));
  }

  private start(ctx: AudioContext, out: AudioNode): void {
    this.ctx = ctx;
    this.out = out;
    this.buffers = { white: noiseBuffer(ctx, white), pink: noiseBuffer(ctx, pink), brown: noiseBuffer(ctx, brown) };
    const b = this.buffers;
    this.wind = this.voice(b.pink, 'bandpass', 420, 0.7);
    this.surf = this.voice(b.brown, 'lowpass', 700, 0.5);
    this.rush = this.voice(b.pink, 'bandpass', 600, 0.8);
    this.plasma = this.voice(b.brown, 'lowpass', 300, 0.7);
    this.deluge = this.voice(b.white, 'bandpass', 1800, 0.45);
    this.vent = this.voice(b.white, 'highpass', 2500, 0.7);
    // Rain: a soft broadband hiss, and a lower patter of drops hitting things.
    this.rain = this.voice(b.white, 'lowpass', 5500, 0.5);
    this.rainPatter = this.voice(b.pink, 'bandpass', 900, 0.8);
    for (let i = 0; i < 2; i++) {
      const whine = ctx.createGain();
      whine.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      // A geared electric drive: a buzzy fundamental and a detuned harmonic beating against it.
      const whineOsc = ctx.createOscillator();
      whineOsc.type = 'sawtooth';
      whineOsc.frequency.value = 90;
      const whineOsc2 = ctx.createOscillator();
      whineOsc2.type = 'triangle';
      whineOsc2.frequency.value = 272;
      const mix2 = ctx.createGain();
      mix2.gain.value = 0.5;
      whineOsc.connect(lp);
      whineOsc2.connect(mix2).connect(lp);
      lp.connect(whine).connect(out);
      whineOsc.start();
      whineOsc2.start();
      const grind = this.voice(b.brown, 'bandpass', 160, 1.2);
      this.machines.push({ whine, whineOsc, whineOsc2, grind, motion: 0, moving: false });
    }
  }

  private voice(buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number): Voice {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // Start each voice at a different point of the shared buffer (no two sound alike).
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.out!);
    src.start(0, Math.random() * buffer.duration);
    return { gain, filter };
  }

  private set(p: AudioParam, v: number, tc = 0.12): void {
    p.setTargetAtTime(Number.isFinite(v) ? v : 0, this.ctx!.currentTime, tc);
  }

  update(s: AmbienceState): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind || !this.surf || !this.rush || !this.plasma || !this.deluge || !this.vent) return;
    const quiet = s.paused ? 0 : Math.min(1, s.listenerAir);
    const dist = (w: V3) => Math.hypot(w[0] - s.cam[0], w[1] - s.cam[1], w[2] - s.cam[2]);
    /** Loudness falloff past a reference distance, and the air's treble cut with distance. */
    const fall = (d: number, ref: number) => 1 / (1 + (d / ref) ** 1.3);
    const dull = (d: number, f0: number) => 180 + f0 / (1 + d / 900);

    // --- Wind: near the ground, in gusts ---
    if (Math.random() < s.dt * 0.3) this.gustTarget = 0.55 + Math.random() * 0.9;
    this.gust += (this.gustTarget - this.gust) * Math.min(1, s.dt * 0.6);
    const low = Math.max(0, 1 - s.camAlt / 2500);
    this.set(this.wind.gain.gain, 0.05 * low * this.gust * quiet, 0.4);
    this.set(this.wind.filter.frequency, 300 + 260 * this.gust, 0.4);

    // --- Surf: the Gulf beach a couple of km east; waves every ~9 s ---
    const swell = Math.max(0, Math.sin((s.time / 9) * Math.PI * 2)) ** 2 * 0.7 + 0.3 + 0.2 * Math.max(0, Math.sin((s.time / 5.3) * Math.PI * 2 + 1)) ** 3;
    const nearGround = Math.max(0, 1 - s.camAlt / 1200);
    this.set(this.surf.gain.gain, 0.045 * nearGround * swell * quiet, 0.5);
    this.set(this.surf.filter.frequency, 380 + 420 * swell, 0.5);

    // --- Air rushing past a vehicle, and reentry plasma ---
    let rush = 0;
    let rushFreq = 400;
    let plasma = 0;
    for (const v of s.vehicles) {
      const d = dist(v.world);
      const near = fall(d, 250);
      const r = Math.min(1, v.q / 35000) * near;
      if (r > rush) {
        rush = r;
        rushFreq = 350 + 1500 * Math.min(1, v.mach / 3);
      }
      plasma = Math.max(plasma, Math.min(1, v.heatFlux / 6e5) * fall(d, 400));
    }
    this.set(this.rush.gain.gain, 0.35 * rush * quiet);
    this.set(this.rush.filter.frequency, rushFreq, 0.3);
    this.set(this.plasma.gain.gain, 0.5 * plasma * quiet, 0.3);

    // --- Deluge water ---
    if (s.deluge && s.deluge.level > 0.001) {
      const d = dist(s.deluge.world);
      this.set(this.deluge.gain.gain, 0.5 * s.deluge.level * fall(d, 200) * quiet, 0.25);
      this.set(this.deluge.filter.frequency, dull(d, 2600), 0.3);
    } else this.set(this.deluge.gain.gain, 0, 0.4);

    // --- Venting hiss from a fuelled stack, in bursts ---
    if (s.vent) {
      const d = dist(s.vent);
      const burst = Math.max(0, 0.5 + 0.5 * Math.sin((s.time / 9) * Math.PI * 2) * 1.6 - 0.3) + 0.25;
      this.set(this.vent.gain.gain, 0.05 * Math.min(1.2, burst) * fall(d, 150) * quiet, 0.3);
      this.set(this.vent.filter.frequency, 1500 + 2500 / (1 + d / 400), 0.3);
    } else this.set(this.vent.gain.gain, 0, 0.5);

    // --- Rain ---
    if (this.rain && this.rainPatter) {
      const r = s.rain * (s.paused ? 0 : 1);
      this.set(this.rain.gain.gain, 0.06 * r, 0.6);
      this.set(this.rainPatter.gain.gain, 0.05 * r * (0.8 + 0.4 * Math.random()), 0.3);
    }

    // --- Tower machinery ---
    s.towers.forEach((t, i) => {
      const m = this.machines[i];
      if (!m) return;
      m.motion += (Math.min(1.3, t.motion) - m.motion) * Math.min(1, s.dt * 4);
      const d = dist(t.world);
      const near = fall(d, 90) * quiet;
      const moving = t.motion > 0.02;
      // A clunk as a drive engages or stops.
      if (moving !== m.moving && !s.paused) this.clunk(d, moving ? 0.5 : 0.35);
      m.moving = moving;
      this.set(m.whine.gain, 0.05 * Math.min(1, m.motion) * near, 0.15);
      this.set(m.whineOsc.frequency, 70 + 60 * m.motion, 0.3);
      this.set(m.whineOsc2.frequency, 215 + 170 * m.motion, 0.3);
      this.set(m.grind.gain.gain, 0.16 * Math.min(1, m.motion) * near, 0.15);
      this.set(m.grind.filter.frequency, Math.min(dull(d, 400), 120 + 90 * m.motion), 0.3);
    });
  }

  // --- One-off sounds -----------------------------------------------------------------------

  /** When a sound made at `world` reaches the camera, and how loud / bright it is there. */
  private heard(d: number, ref: number): { at: number; gain: number; cutoff: number } {
    const ctx = this.ctx!;
    return { at: ctx.currentTime + d / SPEED_OF_SOUND, gain: 1 / (1 + (d / ref) ** 1.3), cutoff: 200 + 12000 / (1 + d / 700) };
  }

  /** A burst of noise through a filter with an attack / decay envelope. */
  private burst(buffer: AudioBuffer, at: number, peak: number, decay: number, type: BiquadFilterType, freq: number, sweepTo?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), at + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.01);
    g.gain.setTargetAtTime(0, at + 0.02, decay / 3);
    src.loop = true; // (long decays outlast the buffer)
    src.connect(f).connect(g).connect(this.out!);
    src.start(at, Math.random() * buffer.duration * 0.9);
    src.stop(at + decay * 2 + 0.2);
  }

  /** Struck steel: a handful of inharmonic partials ringing down, plus the hit. */
  private ring(at: number, peak: number, base: number, decay: number, cutoff: number): void {
    const ctx = this.ctx!;
    const partials = [1, 2.32, 3.87, 5.41, 7.13];
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    f.connect(this.out!);
    partials.forEach((k, i) => {
      if (base * k > cutoff * 1.5) return;
      const o = ctx.createOscillator();
      o.frequency.value = base * k * (1 + (Math.random() - 0.5) * 0.02);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak / (1 + i * 0.7), at + 0.005);
      g.gain.setTargetAtTime(0, at + 0.01, decay / (1 + i * 0.6) / 3);
      o.connect(g).connect(f);
      o.start(at);
      o.stop(at + decay * 1.5 + 0.1);
    });
  }

  private clunk(d: number, strength: number): void {
    if (!this.ctx || !this.buffers) return;
    const h = this.heard(d, 90);
    if (h.gain < 0.01) return;
    this.burst(this.buffers.brown, h.at, 0.5 * strength * h.gain, 0.25, 'lowpass', Math.min(h.cutoff, 500));
    this.ring(h.at, 0.08 * strength * h.gain, 118, 0.5, h.cutoff);
  }

  /** Something big made a sound at `world` (camera-relative distance computed by the caller). */
  play(kind: 'catch' | 'grab' | 'touchdown' | 'splash' | 'explosion' | 'boom', world: V3, cam: V3, size = 1): void {
    if (!this.ctx || !this.buffers) return;
    const d = Math.hypot(world[0] - cam[0], world[1] - cam[1], world[2] - cam[2]);
    const b = this.buffers;
    switch (kind) {
      case 'catch': {
        // Tonnes of steel landing on the rails: a heavy thud and a long metallic ring.
        const h = this.heard(d, 250);
        this.burst(b.brown, h.at, 0.9 * h.gain, 0.6, 'lowpass', Math.min(h.cutoff, 400));
        this.ring(h.at, 0.35 * h.gain, 64, 3.5, h.cutoff);
        this.ring(h.at + 0.03, 0.2 * h.gain, 151, 2.2, h.cutoff);
        break;
      }
      case 'grab': {
        const h = this.heard(d, 150);
        this.burst(b.brown, h.at, 0.5 * h.gain, 0.35, 'lowpass', Math.min(h.cutoff, 450));
        this.ring(h.at, 0.18 * h.gain, 97, 1.6, h.cutoff);
        break;
      }
      case 'touchdown': {
        const h = this.heard(d, 250);
        this.burst(b.brown, h.at, 0.8 * h.gain, 0.7, 'lowpass', Math.min(h.cutoff, 300), 60);
        break;
      }
      case 'splash': {
        const h = this.heard(d, 400);
        this.burst(b.white, h.at, 0.5 * h.gain, 2.5, 'lowpass', Math.min(h.cutoff, 3500), 300);
        this.burst(b.brown, h.at, 0.7 * h.gain, 1.2, 'lowpass', Math.min(h.cutoff, 250), 50);
        break;
      }
      case 'explosion': {
        const h = this.heard(d, 600 * size);
        this.burst(b.brown, h.at, 1.2 * h.gain, 4 + size, 'lowpass', Math.min(h.cutoff, 900), 40);
        this.burst(b.white, h.at, 0.5 * h.gain, 1.2, 'lowpass', Math.min(h.cutoff, 5000), 200);
        break;
      }
      case 'boom': {
        // The double sonic boom (nose and tail shocks), a fraction of a second apart.
        const h = this.heard(d, 8000);
        for (const dt of [0, 0.28]) {
          this.burst(b.brown, h.at + dt, 0.9 * Math.max(0.15, h.gain), 0.35, 'lowpass', 900, 80);
          this.burst(b.white, h.at + dt, 0.25 * Math.max(0.15, h.gain), 0.08, 'lowpass', 4000);
        }
        break;
      }
    }
  }
}
