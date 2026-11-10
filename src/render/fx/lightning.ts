// Lightning in thunderstorms: where the weather has deep, raining convective cloud near the
// camera (a storm's cores: heavy rain, tops up past ~7 km), now and then a stroke. Most light the
// cloud from inside (the flash the atmosphere pass adds to the clouds round it); some come down
// to the ground as a bolt: a jagged, branching channel from the cloud base, flickering through a
// few return strokes in half a second. Each one's thunder (audio/ambience.ts) arrives late by
// its distance over the speed of sound.
//
// Strikes happen in real time (any warp: storms at 100x would be a strobe), never while paused.

import * as THREE from 'three';
import { toFxLayer } from '../atmosphere';
import { type Sample, type WeatherModel, newSample } from '../../weather/model';
import { centreDir, stormCells, weatherDir } from '../../weather/storms';

const DEG = Math.PI / 180;

/** A stroke: where (world, float64), how far from the camera, and whether it hit the ground. */
export interface Strike {
  world: [number, number, number];
  distance: number;
  ground: boolean;
}

/** A storm cell near the camera (one the renderer draws: weather/storms.ts): where, its tower's
 *  radius, base and top, and how active (0..1). */
interface Cell {
  lat: number;
  lon: number;
  rT: number;
  base: number;
  top: number;
  score: number;
}

const vertex = /* glsl */ `
  attribute vec3 aOther;   // the segment's other end
  attribute vec2 aSide;    // x: which side of the line (-1, 1); y: 1 at the segment's start, -1 at its end
  attribute vec2 aLook;    // x: width (relative), y: brightness
  uniform vec2 uScreen;
  uniform float uWidthPx;
  varying float vSide;
  varying float vBright;
  varying float vDist;
  void main() {
    vec4 mvA = modelViewMatrix * vec4(position, 1.0);
    vec4 a = projectionMatrix * mvA;
    vec4 b = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
    vec2 sa = a.xy / a.w * uScreen;
    vec2 sb = b.xy / b.w * uScreen;
    vec2 d = (sb - sa) * aSide.y;
    vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(0.0, 1.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // (A channel a few metres across glows wider than it is: never under a few pixels, the
    // white core about a third of that.)
    float dist = length(mvA.xyz);
    float w = max(uWidthPx, 12.0 / max(dist, 1.0) * uScreen.y / 1.2) * max(aLook.x, 0.5);
    a.xy += nrm * aSide.x * aSide.y * w / uScreen * a.w;
    gl_Position = a;
    vSide = aSide.x;
    vBright = aLook.y;
    vDist = dist;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLevel;
  varying float vSide;
  varying float vBright;
  varying float vDist;
  void main() {
    // (A white-hot core a pixel or two across, in a fainter glow.)
    float s2 = vSide * vSide;
    float core = exp(-s2 * 14.0);
    float glow = 0.12 * (1.0 - s2);
    // (Dimmed by the air between: the haze over tens of km.)
    float air = exp(-vDist / 45000.0);
    gl_FragColor = vec4(uColor * (0.5 + 0.5 * core), uLevel * vBright * (core + glow) * air);
  }
`;

export class Lightning {
  /** The bolt (one at a time). */
  readonly mesh: THREE.Mesh;
  /** The flash lighting the clouds: where (relative to the Earth's centre, world axes), how bright. */
  readonly flash = { pos: new THREE.Vector3(), level: 0 };
  /** Called with each stroke (its thunder). */
  onStrike: ((s: Strike) => void) | null = null;

  private mat: THREE.ShaderMaterial;
  private cells: Cell[] = [];
  private probedAt = { time: -Infinity, at: new THREE.Vector3() };
  private probe: Sample = newSample();
  private v = new THREE.Vector3();
  /** The stroke under way: its start (real time, s), pulses (times and strengths), whether a bolt. */
  private stroke: { t: number; pulses: [number, number][]; ground: boolean; decay: number } | null = null;
  private clock = 0;
  /** The bolt's anchor (world, float64): the mesh is drawn relative to it. */
  private anchor: [number, number, number] = [0, 0, 0];
  private ecefToWorld = new THREE.Matrix3();
  private worldToEcef = new THREE.Matrix3();

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uScreen: { value: new THREE.Vector2(1, 1) },
        uWidthPx: { value: 5 },
        uColor: { value: new THREE.Color(0.8, 0.86, 1.0).multiplyScalar(40) },
        uLevel: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    toFxLayer(this.mesh);
  }

  /**
   * Each frame. dt: real seconds; model: the weather (null: none); time: sim time; cam: the
   * camera (world, float64); camFromCentre: it from the Earth's centre (world axes, m); camAlt:
   * its height; worldToEcef: world -> Earth-fixed directions; screen: the drawing buffer's size.
   */
  update(
    dt: number,
    paused: boolean,
    model: WeatherModel | null,
    time: number,
    cam: readonly number[],
    camFromCentre: THREE.Vector3,
    camAlt: number,
    worldToEcef: THREE.Matrix3,
    screen: THREE.Vector2,
  ): void {
    this.worldToEcef.copy(worldToEcef);
    this.ecefToWorld.copy(worldToEcef).transpose();
    (this.mat.uniforms.uScreen.value as THREE.Vector2).copy(screen);
    if (!paused) this.clock += dt;
    if (!model || camAlt > 20000) {
      this.cells = [];
      this.end();
      return;
    }
    // Where the storms are: the weather round the camera now and then (to ~95 km).
    const pr = this.probedAt;
    // (And at once for new weather: a thunderstorm day picked shouldn't wait half a minute.)
    if (Math.abs(time - pr.time) > 30 || pr.at.distanceToSquared(camFromCentre) > 5000 ** 2 || model !== this.probedModel) {
      this.probedModel = model;
      pr.time = time;
      pr.at.copy(camFromCentre);
      this.findCells(model, time, camFromCentre, worldToEcef);
    }
    // A new stroke now and then: a storm's core every ten seconds or so.
    if (!paused && !this.stroke && this.cells.length) {
      let rate = 0;
      for (const c of this.cells) rate += c.score * 0.11;
      if (this.forced !== null || Math.random() < Math.min(0.5, rate * dt)) this.strike(cam, camFromCentre, camAlt, rate);
    }
    // The stroke under way: its flicker.
    const s = this.stroke;
    if (!s) return;
    const age = this.clock - s.t;
    let level = 0;
    for (const [t0, a] of s.pulses) if (age >= t0) level += a * Math.exp(-(age - t0) / s.decay);
    if (age > 1.5 || (age > s.pulses[s.pulses.length - 1][0] && level < 0.01)) {
      this.end();
      return;
    }
    this.flash.level = level * (s.ground ? 1 : 0.7);
    this.mat.uniforms.uLevel.value = level;
    if (this.mesh.visible) this.mesh.position.set(this.anchor[0] - cam[0], this.anchor[1] - cam[1], this.anchor[2] - cam[2]);
  }

  private end(): void {
    this.stroke = null;
    this.flash.level = 0;
    this.mesh.visible = false;
  }

  /** The thunderstorm cells round the camera (to ~100 km): the towers the renderer draws. */
  private probedModel: WeatherModel | null = null;

  private findCells(model: WeatherModel, time: number, camFromCentre: THREE.Vector3, worldToEcef: THREE.Matrix3): void {
    this.v.copy(camFromCentre).applyMatrix3(worldToEcef);
    const e = weatherDir(this.v.x, this.v.y, this.v.z);
    const s = this.probe;
    const at = (d: readonly number[]) => model.sample(Math.asin(d[2]) / DEG, Math.atan2(d[1], d[0]) / DEG, time, undefined, s);
    at(e);
    // (Any deep convection near at all? Else no cells to look for.)
    const any = [0, 1, 2, 3, 4, 5, 6, 7, 8].some((k) => {
      if (k === 0) return s.conv > 0.02;
      const az = (k / 8) * 2 * Math.PI;
      const lat = Math.asin(e[2]) + (60e3 / 6.371e6) * Math.cos(az);
      const lon = Math.atan2(e[1], e[0]) + ((60e3 / 6.371e6) * Math.sin(az)) / Math.max(0.2, Math.cos(lat));
      return at([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]).conv > 0.02;
    });
    const cells: Cell[] = [];
    if (any) {
      // (Their tops as a share of the weather's depth there: base 0, top 1.)
      for (const c of stormCells(e, 6378137, 100e3, (d) => at(d).conv, 0, 1, time)) {
        at(c.dir);
        const cellTop = s.base + (s.top - s.base) * c.top;
        // (Only the towers that reach high are thunderstorms.)
        if (cellTop - s.base < 6000) continue;
        cells.push({ lat: Math.asin(c.dir[2]) / DEG, lon: Math.atan2(c.dir[1], c.dir[0]) / DEG, rT: c.rT, base: s.base, top: cellTop, score: smooth(6000, 10000, cellTop - s.base) * (c.rA > 0 ? 1 : 0.4) });
      }
    }
    this.cells = cells;
  }

  /** A stroke from one of the storm cells. */
  private strike(cam: readonly number[], camFromCentre: THREE.Vector3, camAlt: number, rate: number): void {
    // Which cell (the more active, the likelier), and where under its tower.
    let x = Math.random() * rate;
    let cell = this.cells[0];
    for (const c of this.cells) if ((x -= c.score * 0.11) < 0) { cell = c; break; }
    if (this.forced !== null) {
      // (Debug: the nearest.)
      const ce = this.v.copy(camFromCentre).applyMatrix3(this.worldToEcef);
      const cd = weatherDir(ce.x, ce.y, ce.z);
      const camLat = Math.asin(cd[2]) / DEG, camLon = Math.atan2(cd[1], cd[0]) / DEG;
      const d = (c: Cell) => (c.lat - camLat) ** 2 + ((c.lon - camLon) * Math.cos(camLat * DEG)) ** 2;
      cell = this.cells.reduce((a, b) => (d(b) < d(a) ? b : a));
    }
    const rr = cell.rT * 0.7 * Math.sqrt(Math.random());
    const ra = Math.random() * 2 * Math.PI;
    const lat = cell.lat + (rr * Math.cos(ra)) / 6.371e6 / DEG;
    const lon = cell.lon + (rr * Math.sin(ra)) / (6.371e6 * Math.cos(cell.lat * DEG)) / DEG;
    const base = cell.base;
    // (Most flashes stay in the cloud; about a third come to the ground.)
    const ground = this.forced ?? Math.random() < 0.35;
    this.forced = null;
    // Where it is (world): up through (lat, lon) (geodetic: on the line from the Earth's centre to
    // the ground there), the ground's radius under the camera.
    const groundR = camFromCentre.length() - camAlt;
    const up = new THREE.Vector3()
      .fromArray(centreDir([Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)]))
      .applyMatrix3(this.ecefToWorld)
      .normalize();
    const centre = [cam[0] - camFromCentre.x, cam[1] - camFromCentre.y, cam[2] - camFromCentre.z];
    const pointAt = (h: number): [number, number, number] => [centre[0] + up.x * (groundR + h), centre[1] + up.y * (groundR + h), centre[2] + up.z * (groundR + h)];
    const flashH = ground ? base + 1500 + 1500 * Math.random() : base + (cell.top - base) * (0.3 + 0.5 * Math.random());
    // (Up in the tower, which leans downwind, east, as it rises: as the renderer draws it.)
    const east = new THREE.Vector3(-Math.sin(lon * DEG), Math.cos(lon * DEG), 0).applyMatrix3(this.ecefToWorld).normalize();
    this.flash.pos.copy(up).multiplyScalar(groundR + flashH).addScaledVector(east, 0.1 * Math.max(0, flashH - base));
    const hit = pointAt(0);
    const distance = Math.hypot(hit[0] - cam[0], hit[1] - cam[1], hit[2] - cam[2]);
    // The flicker: a stroke or a few (return strokes tens of ms apart), each fading fast.
    const n = ground ? 1 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 3);
    const pulses: [number, number][] = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      pulses.push([t, (i === 0 ? 1 : 0.4 + 0.5 * Math.random()) * (ground ? 1 : 0.5 + 0.5 * Math.random())]);
      t += 0.04 + 0.12 * Math.random();
    }
    this.stroke = { t: this.clock, pulses, ground, decay: ground ? 0.05 : 0.09 };
    if (ground) {
      this.anchor = hit;
      this.buildBolt(up, base + 300 + 900 * Math.random());
      this.mesh.visible = true;
      this.mesh.position.set(hit[0] - cam[0], hit[1] - cam[1], hit[2] - cam[2]);
    } else this.mesh.visible = false;
    this.onStrike?.({ world: ground ? hit : pointAt(flashH), distance: ground ? distance : Math.hypot(...pointAt(flashH).map((v, i) => v - cam[i]) as [number, number, number]), ground });
  }

  /** A new bolt from height top (m) down to the ground at the anchor: the channel and its branches. */
  private buildBolt(up: THREE.Vector3, top: number): void {
    const e = new THREE.Vector3(0, 0, 1).cross(up);
    if (e.lengthSq() < 1e-6) e.set(1, 0, 0);
    e.normalize();
    const nn = new THREE.Vector3().crossVectors(up, e);
    const pos: number[] = [];
    const other: number[] = [];
    const side: number[] = [];
    const look: number[] = [];
    const index: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, width: number, bright: number) => {
      const i0 = pos.length / 3;
      for (const [p, q, dir] of [[a, b, 1], [b, a, -1]] as const) {
        for (const sd of [-1, 1]) {
          pos.push(p.x, p.y, p.z);
          other.push(q.x, q.y, q.z);
          side.push(sd, dir);
          look.push(width, bright);
        }
      }
      index.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    };
    const local = (x: number, y: number, h: number) => new THREE.Vector3().addScaledVector(e, x).addScaledVector(nn, y).addScaledVector(up, h);
    // A channel from (x, y, h) down (or out), in kinks every few tens of metres to a few hundred.
    const channel = (x: number, y: number, h: number, hEnd: number, width: number, bright: number, depth: number, lean: number) => {
      const steps = Math.max(4, Math.round((h - hEnd) / 70));
      const dh = (h - hEnd) / steps;
      let px = x, py = y, ph = h;
      let dx = lean * Math.cos(Math.random() * 6.28), dy = lean * Math.sin(Math.random() * 6.28);
      for (let i = 0; i < steps; i++) {
        // (Wandering: each kink turns the channel a little, the whole leaning one way and another.)
        dx = 0.7 * dx + (Math.random() - 0.5) * 1.6;
        dy = 0.7 * dy + (Math.random() - 0.5) * 1.6;
        const nx = px + dx * dh * 0.8;
        const ny = py + dy * dh * 0.8;
        const nh = i === steps - 1 ? hEnd : ph - dh * (0.6 + 0.8 * Math.random());
        const k = 1 - 0.5 * (i / steps) * (depth > 0 ? 1 : 0);
        seg(local(px, py, ph), local(nx, ny, nh), width * k, bright * k);
        // Branches: forking off and down, dying out in the air.
        if (depth < 2 && Math.random() < (depth === 0 ? 0.09 : 0.04)) {
          const len = (ph - hEnd) * (0.15 + 0.35 * Math.random());
          channel(nx, ny, nh, Math.max(hEnd + 30, nh - len), width * 0.55, bright * 0.45, depth + 1, 1.2);
        }
        px = nx;
        py = ny;
        ph = nh;
      }
    };
    channel(0, 0, top, 0, 1, 1, 0, 0.4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aOther', new THREE.Float32BufferAttribute(other, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 2));
    g.setAttribute('aLook', new THREE.Float32BufferAttribute(look, 2));
    g.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Debug: a stroke as soon as there's a storm near (ground: a bolt). */
  test(ground = true): void {
    this.forced = ground;
  }
  private forced: boolean | null = null;
  /** The storm cells found round the camera (debug). */
  get storms(): number {
    return this.cells.length;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
