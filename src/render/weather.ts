// The weather: planet-wide clouds (drawn by the atmosphere pass, atmosphere.ts) and what they
// mean where the camera is: rain under a heavy deck, and dimmer sunlight under overcast.
// Each flight gets a new weather map (a random offset into the noise: systems in new places).
// Asking for particular weather over Starbase picks, among many random maps, one whose own
// pattern gives it there: the shapes stay natural, nothing is painted on. Fog is added around
// Starbase. The whole field drifts slowly with sim time.

import * as THREE from 'three';
import { CLOUD_SHELL_HI, type SceneAtmospherePass } from './atmosphere';
import { CloudNoise } from './cloudNoise';
import type { StarbaseWeather } from '../settings';

/** Fog around Starbase with each weather (0..1). */
const WEATHER_FOG: Record<Exclude<StarbaseWeather, 'natural'>, number> = { clear: 0, partly: 0, overcast: 0.15, rain: 0.25, fog: 1 };


const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Weather {
  readonly noise = new CloudNoise();
  /** Ground fog around Starbase, 0..1. */
  fog = 0;
  enabled = true;
  /** This flight's weather map (noise offset), and the slow drift on top of it. */
  private seed = new THREE.Vector3(Math.random(), Math.random(), Math.random());
  private drift = new THREE.Vector3();
  private localR = new THREE.Vector2(Math.cos(300e3 / 6.371e6), Math.cos(150e3 / 6.371e6));

  constructor(
    /** The Earth's axis and the direction to Starbase from its centre, world axes (unit). */
    private axis: THREE.Vector3,
    private localDir: THREE.Vector3,
  ) {}

  /** simTime: s. Weather systems move ~30 km/h. */
  update(simTime: number): void {
    const k = 1.7e-3 / 3600;
    this.drift.set(this.seed.x + simTime * k, this.seed.y, this.seed.z + simTime * k * 0.35);
  }

  /**
   * A new weather map, with this weather over Starbase: tries random maps until one's own
   * pattern gives it there (at the start of a flight, before the drift).
   */
  set(w: Exclude<StarbaseWeather, 'natural'> | 'any'): void {
    this.fog = w === 'any' ? 0 : WEATHER_FOG[w];
    const want = (s: { cover: number; rain: number; clearAround: boolean }): number => {
      switch (w) {
        case 'any': return 0;
        case 'clear': return s.clearAround ? 0 : 1 + s.cover;
        case 'partly': return Math.abs(s.cover - 0.45) < 0.15 && s.rain < 0.05 ? 0 : Math.abs(s.cover - 0.45) + s.rain;
        case 'overcast': return s.cover > 0.8 && s.rain < 0.1 ? 0 : Math.max(0, 0.8 - s.cover) + s.rain;
        case 'rain': return s.rain > 0.7 ? 0 : 1 - s.rain;
        case 'fog': return s.cover < 0.3 && s.rain === 0 ? 0 : s.cover;
      }
    };
    let best = this.seed.clone();
    let bestScore = Infinity;
    const around = this.aroundStarbase();
    for (let i = 0; i < 1500 && bestScore > 0; i++) {
      this.seed.set(Math.random(), Math.random(), Math.random());
      this.drift.copy(this.seed);
      const here = this.weatherAt(this.localDir);
      const rain = this.rainFrom(here, 0);
      const clearAround = here.cover < 0.02 && around.every((n) => this.weatherAt(n).cover < 0.05);
      const score = want({ cover: here.cover, rain, clearAround });
      if (score < bestScore) {
        bestScore = score;
        best = this.seed.clone();
      }
    }
    this.seed.copy(best);
    this.drift.copy(best);
  }

  /** Points ~40 km around Starbase (for "clear": clear sky, not just a hole overhead). */
  private aroundStarbase(): THREE.Vector3[] {
    const up = this.localDir;
    const e = new THREE.Vector3().crossVectors(this.axis, up).normalize();
    const nn = new THREE.Vector3().crossVectors(up, e);
    const a = 40e3 / 6.371e6;
    return [e, nn, e.clone().negate(), nn.clone().negate()].map((d) => up.clone().addScaledVector(d, a).normalize());
  }

  /** Hand the clouds' settings to the atmosphere pass. */
  apply(pass: SceneAtmospherePass): void {
    const u = pass.uniforms;
    u.tNoise.value = this.noise.texture;
    u.uClouds.value = this.enabled ? 1 : 0;
    u.uAxis.value.copy(this.axis);
    u.uLocalDir.value.copy(this.localDir);
    u.uLocalR.value.copy(this.localR);
    u.uLocalCover.value = -1;
    u.uDrift.value.copy(this.drift);
    u.uFog.value = this.fog;
  }

  /**
   * The weather over a point on the globe (n: unit direction from the Earth's centre): cloud
   * cover 0..1, base and top (m). Mirrors the shader's weatherAt().
   */
  weatherAt(n: THREE.Vector3): { cover: number; base: number; top: number } {
    const t = (x: number, y: number, z: number, ch: 0 | 1 = 0) => this.noise.sample(x, y, z, ch);
    const m = n.clone().add(this.drift);
    const w1 = [t(m.x * 1.1 + 0.1, m.y * 1.1 + 0.2, m.z * 1.1 + 0.3), t(m.x * 1.1 + 0.6, m.y * 1.1 + 0.9, m.z * 1.1 + 0.4), t(m.x * 1.1 + 0.35, m.y * 1.1 + 0.05, m.z * 1.1 + 0.8)];
    const q1 = new THREE.Vector3(m.x + (w1[0] - 0.5) * 0.7, m.y + (w1[1] - 0.5) * 0.7, m.z + (w1[2] - 0.5) * 0.7);
    const w2 = [t(q1.x * 2.7 + 0.8, q1.y * 2.7 + 0.15, q1.z * 2.7 + 0.55), t(q1.x * 2.7 + 0.25, q1.y * 2.7 + 0.65, q1.z * 2.7 + 0.05), t(q1.x * 2.7 + 0.45, q1.y * 2.7 + 0.35, q1.z * 2.7 + 0.95)];
    const q = new THREE.Vector3(q1.x + (w2[0] - 0.5) * 0.28, q1.y + (w2[1] - 0.5) * 0.28, q1.z + (w2[2] - 0.5) * 0.28);
    const c =
      0.4 * t(q.x * 1.9, q.y * 1.9, q.z * 1.9) +
      0.28 * t(q.x * 4.7 + 0.4, q.y * 4.7 + 0.1, q.z * 4.7 + 0.7) +
      0.18 * t(q.x * 11.3 + 0.2, q.y * 11.3 + 0.8, q.z * 11.3 + 0.5) +
      0.14 * t(q.x * 27 + 0.6, q.y * 27 + 0.3, q.z * 27 + 0.9, 1);
    const cs = (c - 0.5) * 2.4 + 0.5 + (t(q.x * 120 + 0.2, q.y * 120 + 0.4, q.z * 120 + 0.6) - 0.5) * 0.35;
    const lat = (Math.asin(Math.max(-1, Math.min(1, n.dot(this.axis)))) * 180) / Math.PI;
    const al = Math.abs(lat);
    const band =
      0.42 + 0.3 * Math.exp((-lat * lat) / 80) - 0.26 * Math.exp(-((al - 24) ** 2) / 90) + 0.18 * Math.exp(-((al - 55) ** 2) / 140) - 0.08 * Math.exp(-((al - 78) ** 2) / 100);
    const cover = smoothstep(0.85, 1.07, cs + (band - 0.45) * 0.45);
    const conv = t(q.x * 9 + 0.7, q.y * 9 + 0.3, q.z * 9 + 0.1, 1);
    const base = 650 + 1000 * t(q.x * 4 + 0.9, q.y * 4 + 0.5, q.z * 4 + 0.2);
    const depth = 350 + 3000 * cover * cover + 7000 * smoothstep(0.62, 0.85, conv) * smoothstep(0.6, 0.9, cover);
    return { cover, base, top: Math.min(base + depth, CLOUD_SHELL_HI - 200) };
  }

  /**
   * The weather where the camera is: rain (0..1) under a heavy deck, below the cloud tops; and a
   * factor for the sunlight (1 clear, down to ~0.3 under thick overcast). camFromCentre: the
   * camera's position relative to the Earth's centre (world axes, m); height: above the ground.
   */
  local(camFromCentre: THREE.Vector3, height: number): { rain: number; sun: number } {
    if (!this.enabled || height > CLOUD_SHELL_HI) return { rain: 0, sun: 1 };
    const w = this.weatherAt(camFromCentre.clone().normalize());
    // Under the cloud tops the sun is dimmed by the cover.
    const under = 1 - smoothstep(w.base, w.top, height);
    return { rain: this.rainFrom(w, height), sun: 1 - 0.7 * smoothstep(0.45, 0.92, w.cover) * under };
  }

  /** Rain falls from a heavy, deep deck (0..1), below its top. */
  private rainFrom(w: { cover: number; base: number; top: number }, height: number): number {
    const deep = smoothstep(2500, 4000, w.top - w.base);
    return smoothstep(0.82, 0.95, w.cover) * deep * (height < w.top ? 1 : 0);
  }


}
