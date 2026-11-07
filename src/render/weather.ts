// The weather on screen: the global weather model (weather/model.ts) baked into a world map of
// cloud fields (a few workers share the work), which the atmosphere pass draws clouds from, at
// every scale from the ground to orbit; and what it means where the camera is (rain, the
// sunlight dimmed under overcast, fog).
//
// The map is baked every STEP of simulation time a little ahead, and the renderer blends between
// the two bakes around now, so the weather moves smoothly at any warp.

import * as THREE from 'three';
import type { SceneAtmospherePass } from './atmosphere';
import { CloudNoise } from './cloudNoise';
import { Land, type Sample, type SiteWeather, type WeatherConfig, WeatherModel, calmSeed, newSample } from '../weather/model';
import type { FromBake, ToBake } from '../weather/bake.worker';
import BakeWorker from '../weather/bake.worker.ts?worker';

/** The weather map's size (~39 km per texel at the equator). */
export const WX_W = 1024;
export const WX_H = 512;
/** Simulation time between bakes, s. */
const STEP = 20 * 60;
const DAY_RATE = (2 * Math.PI) / 86400;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Slot {
  t: number;
  a: THREE.DataTexture;
  b: THREE.DataTexture;
}

function mapTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(WX_W * WX_H * 4), WX_W, WX_H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class Weather {
  readonly noise = new CloudNoise();
  enabled = true;
  /** The model as configured for this flight (null until the flight's first snapshot). */
  model: WeatherModel | null = null;
  /** Called with each new configuration and the land mask (the physics needs the same weather
   *  for its wind). */
  onConfig: ((cfg: WeatherConfig, land: Uint8Array | null) => void) | null = null;

  private land: Land | null = null;
  private landBytes: Uint8Array | null = null;
  private workers: Worker[] = [];
  /** [blend from, blend to, staged next]. */
  private slots: Slot[] = [0, 1, 2].map(() => ({ t: -Infinity, a: mapTexture(), b: mapTexture() }));
  private filled = 0;
  private pending: { id: number; t: number; left: number; slot: Slot } | null = null;
  private nextId = 1;
  private want: { seed: number; site: SiteWeather; season: number; calm: boolean } | null = null;
  private drift = new THREE.Vector3();
  private seedDrift = new THREE.Vector3(Math.random(), Math.random(), Math.random());
  private blend = 0;
  private t = 0;
  private sunEcef = [1, 0, 0];
  private local0 = { t: -Infinity, at: new THREE.Vector3(), sample: newSample() };
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(
    /** The Earth's axis (world, unit). */
    private axis: THREE.Vector3,
    /** Render world -> ECEF directions. */
    private worldToEcef: THREE.Matrix3,
    private siteLat: number,
    private siteLon: number,
  ) {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new BakeWorker();
      w.onmessage = (ev: MessageEvent<FromBake>) => this.onBaked(ev.data);
      this.workers.push(w);
    }
    fetch(`${import.meta.env.BASE_URL}data/landmask.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        this.landBytes = new Uint8Array(buf);
        this.land = new Land(this.landBytes);
        // (Configured before the land arrived: again, with it.)
        if (this.model) this.start(this.model.cfg);
      })
      .catch((e) => console.warn('weather: no land mask', e));
  }

  /**
   * New weather for a flight or a menu scene: the weather asked for over the site (or whatever
   * the day brings), a new random world around it. Takes effect at the next fresh snapshot.
   * calm: a world whose wind at the site stays light for the next few hours (missions).
   */
  configure(site: SiteWeather, season: number, calm = false, seed = Math.floor(Math.random() * 2 ** 31)): void {
    this.want = { seed, site, season, calm };
    this.seedDrift.set(Math.random(), Math.random(), Math.random());
  }

  private start(cfg: WeatherConfig): void {
    this.model = new WeatherModel(cfg, this.land);
    const msg: ToBake = { type: 'config', cfg, land: this.landBytes };
    for (const w of this.workers) w.postMessage(msg);
    this.filled = 0;
    this.pending = null;
    this.local0.t = -Infinity;
    this.onConfig?.(cfg, this.landBytes);
  }

  /** The sun's direction (ECEF) at sim time tb, from where it is now (world) at time t. */
  private sunAt(sunWorld: THREE.Vector3, t: number, tb: number): number[] {
    this.q.setFromAxisAngle(this.axis, -DAY_RATE * (tb - t));
    this.v.copy(sunWorld).applyQuaternion(this.q).applyMatrix3(this.worldToEcef).normalize();
    return [this.v.x, this.v.y, this.v.z];
  }

  private request(tb: number, slot: Slot, sunWorld: THREE.Vector3, t: number): void {
    const id = this.nextId++;
    const sun = this.sunAt(sunWorld, t, tb);
    const n = this.workers.length;
    this.pending = { id, t: tb, left: n, slot };
    for (let i = 0; i < n; i++) {
      const j0 = Math.floor((i * WX_H) / n);
      const j1 = Math.floor(((i + 1) * WX_H) / n);
      const msg: ToBake = { type: 'bake', id, t: tb, sun, W: WX_W, H: WX_H, j0, j1 };
      this.workers[i].postMessage(msg);
    }
  }

  private onBaked(m: FromBake): void {
    const p = this.pending;
    if (!p || m.id !== p.id) return;
    (p.slot.a.image.data as Uint8Array).set(m.a, m.j0 * WX_W * 4);
    (p.slot.b.image.data as Uint8Array).set(m.b, m.j0 * WX_W * 4);
    if (--p.left > 0) return;
    p.slot.t = p.t;
    p.slot.a.needsUpdate = true;
    p.slot.b.needsUpdate = true;
    this.pending = null;
    this.filled++;
  }

  /**
   * Each frame. t: sim time (s); sunWorld: direction to the sun now (world); fresh: the snapshot
   * is from the latest flight / scene (its time can start the configured weather).
   */
  update(t: number, sunWorld: THREE.Vector3, fresh: boolean): void {
    this.t = t;
    this.v.copy(sunWorld).applyMatrix3(this.worldToEcef).normalize();
    this.sunEcef = [this.v.x, this.v.y, this.v.z];
    if (this.want && fresh) {
      const { seed, site, season, calm } = this.want;
      this.want = null;
      const cfg: WeatherConfig = { seed, site, season, siteLat: this.siteLat, siteLon: this.siteLon, t0: t };
      if (calm) cfg.seed = calmSeed(cfg, this.land);
      this.start(cfg);
    }
    // Fine detail drifts ~3 m/s (in noise units: Earth radii).
    const k = 1.7e-3 / 3600;
    this.drift.set(this.seedDrift.x + t * k, this.seedDrift.y, this.seedDrift.z + t * k * 0.35);
    if (!this.model) return;
    const [s0, s1, s2] = this.slots;
    // Time jumped (a new flight, back to the pad): start over from now.
    if (this.filled >= 2 && (t < s0.t - 60 || t > s1.t + 12 * 3600)) this.filled = 0;
    if (this.filled === 0) {
      if (!this.pending || Math.abs(this.pending.t - t) > STEP) this.request(t, s0, sunWorld, t);
      return;
    }
    if (this.filled === 1) {
      if (!this.pending) this.request(Math.max(t, s0.t) + STEP, s1, sunWorld, t);
      this.blend = 0;
      return;
    }
    // Move on to the staged bake once its time comes.
    if (this.filled >= 3 && t >= s1.t) {
      this.slots = [s1, s2, s0];
      this.filled = 2;
    }
    const [a, b, c] = this.slots;
    if (!this.pending && this.filled === 2) this.request(Math.max(b.t + STEP, t + STEP * 0.5), c, sunWorld, t);
    this.blend = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t)));
  }

  /** Hand the clouds' settings to the atmosphere pass. */
  apply(pass: SceneAtmospherePass): void {
    const u = pass.uniforms;
    const [a, b] = this.slots;
    const on = this.enabled && this.model !== null && this.filled >= 1;
    u.tNoise.value = this.noise.texture;
    u.uClouds.value = on ? 1 : 0;
    u.tWxA0.value = a.a;
    u.tWxB0.value = a.b;
    u.tWxA1.value = this.filled >= 2 ? b.a : a.a;
    u.tWxB1.value = this.filled >= 2 ? b.b : a.b;
    u.uWxBlend.value = this.filled >= 2 ? this.blend : 0;
    u.uWorldToEcef.value.copy(this.worldToEcef);
    u.uPolar.value.copy(this.axis);
    u.uDrift.value.copy(this.drift);
    u.uFog.value = on ? this.fogHere : 0;
  }

  private fogHere = 0;

  /**
   * The weather where the camera is: rain (0..1), a factor for the sunlight (1 clear, down to
   * ~0.3 under thick overcast), and fog. camFromCentre: the camera relative to the Earth's
   * centre (world, m); height: above the ground.
   */
  local(camFromCentre: THREE.Vector3, height: number): { rain: number; sun: number; fog: number } {
    if (!this.enabled || !this.model || height > 16000) {
      this.fogHere = 0;
      return { rain: 0, sun: 1, fog: 0 };
    }
    const l = this.local0;
    if (Math.abs(this.t - l.t) > 20 || l.at.distanceToSquared(camFromCentre) > 2000 ** 2) {
      this.v.copy(camFromCentre).applyMatrix3(this.worldToEcef).normalize();
      const lat = (Math.asin(Math.max(-1, Math.min(1, this.v.z))) * 180) / Math.PI;
      const lon = (Math.atan2(this.v.y, this.v.x) * 180) / Math.PI;
      this.model.sample(lat, lon, this.t, this.sunEcef, l.sample);
      l.t = this.t;
      l.at.copy(camFromCentre);
    }
    const s: Sample = l.sample;
    const under = 1 - smooth(s.base, s.top, height);
    const rain = smooth(0.12, 0.5, s.precip) * smooth(s.top, s.base, height) * smooth(0.5, 0.8, s.cover);
    const dim = 0.7 * smooth(0.45, 0.95, s.cover) * (1 - 0.6 * s.broken) * under + 0.15 * s.high * (1 - smooth(8000, 11000, height));
    this.fogHere = s.fog * (1 - smooth(150, 600, height));
    return { rain, sun: 1 - Math.min(0.75, dim), fog: this.fogHere };
  }
}
