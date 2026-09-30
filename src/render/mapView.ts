// Map view (Tab): the predicted trajectories drawn over the globe, KSP-style, with labels for the
// vehicles, the launch site, apoapsis / periapsis, the entry interface and the impact point.
//
// Paths come from the worker in Earth-fixed coordinates; they're drawn in a group sitting at the
// Earth's centre (floating origin), so vertices stay within a few thousand km of it.

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { V3 } from '../sim/math';
import type { Trajectory, TrajectoryMark } from '../sim/trajectory';
import { FX_LAYER } from './atmosphere';
import type { FloatingOrigin } from './floatingOrigin';
import { ecefToWorld, toWorld } from './geo';
import { MOON_DISTANCE, type Moon, phaseName } from './moon';

const EARTH_CENTER = ecefToWorld([0, 0, 0]);
/** Sphere that hides labels behind the Earth, m. */
const OCCLUDER_R = 6.35e6;

const COLORS = {
  node: new THREE.Color('#ffb040'),
  nodeAir: new THREE.Color('#ff6a3a'),
  tracked: new THREE.Color('#5fd4ff'),
  trackedAir: new THREE.Color('#ff7a3a'),
  other: new THREE.Color('#8494ad'),
  otherAir: new THREE.Color('#a8674a'),
};

export interface MapVehicle {
  id: string;
  name: string;
  /** World position, m. */
  world: V3;
  altitude: number;
}

interface Path {
  line: Line2;
  traj: Trajectory;
}

export class MapView {
  readonly group = new THREE.Group();
  private paths = new Map<string, Path>();
  private material: LineMaterial;
  private dimMaterial: LineMaterial;
  private labels: HTMLElement;
  private pool: HTMLElement[] = [];
  private used = 0;
  private v = new THREE.Vector3();
  visible = false;
  /** The Sun (world unit vector toward it) and the Moon, shown with the Moon's orbit. */
  bodies: { sunDir: THREE.Vector3; moon: Moon } | null = null;
  private moonOrbit: Line2;
  private orbitNormal = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.group.visible = false;
    this.material = new LineMaterial({ linewidth: 2.6, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
    this.dimMaterial = new LineMaterial({ linewidth: 1.6, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false });
    // The Moon's orbit: a thin grey ring (it's 60 Earth radii out).
    this.moonOrbit = new Line2(new LineGeometry(), new LineMaterial({ linewidth: 1.2, color: 0x8d96a6, transparent: true, opacity: 0.55, depthWrite: false }));
    this.moonOrbit.frustumCulled = false;
    this.moonOrbit.layers.set(FX_LAYER);
    this.group.add(this.moonOrbit);
    this.labels = document.createElement('div');
    this.labels.id = 'map-labels';
    parent.appendChild(this.labels);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.group.visible = on;
    this.labels.style.display = on ? '' : 'none';
    document.body.classList.toggle('map-mode', on);
  }

  setSize(w: number, h: number): void {
    this.material.resolution.set(w, h);
    this.dimMaterial.resolution.set(w, h);
    (this.moonOrbit.material as LineMaterial).resolution.set(w, h);
  }

  /** New predictions from the worker (replaces all paths). */
  setTrajectories(list: Trajectory[]): void {
    const seen = new Set<string>();
    for (const traj of list) {
      seen.add(traj.id);
      let p = this.paths.get(traj.id);
      if (!p) {
        const line = new Line2(new LineGeometry(), this.material);
        line.frustumCulled = false;
        line.layers.set(FX_LAYER);
        line.renderOrder = 10;
        this.group.add(line);
        p = { line, traj };
        this.paths.set(traj.id, p);
      }
      p.traj = traj;
      this.rebuild(p);
    }
    for (const [id, p] of this.paths) {
      if (seen.has(id)) continue;
      this.group.remove(p.line);
      p.line.geometry.dispose();
      this.paths.delete(id);
    }
  }

  private tracked = '';

  private rebuild(p: Path): void {
    // A maneuver's path is drawn from the burn on (before it, it's the same as the coast).
    const isNode = p.traj.id.endsWith(':node');
    const from = isNode ? Math.max(0, p.traj.nodeIndex) : 0;
    const points = p.traj.points.slice(from);
    const entryIndex = p.traj.entryIndex >= 0 ? p.traj.entryIndex - from : -1;
    const owner = isNode ? p.traj.id.slice(0, -5) : p.traj.id;
    if (points.length < 2 || (isNode && owner !== this.tracked)) {
      p.line.visible = false;
      return;
    }
    p.line.visible = true;
    const mine = owner === this.tracked;
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const w = ecefToWorld(points[i]);
      pos[i * 3] = w[0] - EARTH_CENTER[0];
      pos[i * 3 + 1] = w[1] - EARTH_CENTER[1];
      pos[i * 3 + 2] = w[2] - EARTH_CENTER[2];
      const air = entryIndex >= 0 ? i >= entryIndex : false;
      const c = isNode ? (air ? COLORS.nodeAir : COLORS.node) : mine ? (air ? COLORS.trackedAir : COLORS.tracked) : air ? COLORS.otherAir : COLORS.other;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    // A fresh geometry each time: LineGeometry's instanced buffers are sized on first use.
    p.line.geometry.dispose();
    const g = new LineGeometry();
    g.setPositions(pos);
    g.setColors(col);
    p.line.geometry = g;
    p.line.material = mine ? this.material : this.dimMaterial;
    p.line.computeLineDistances();
  }

  update(
    origin: FloatingOrigin,
    camera: THREE.PerspectiveCamera,
    simTime: number,
    vehicles: MapVehicle[],
    trackedId: string,
    /** Extra markers (e.g. the ship's return target): lat/lon (deg), class, label HTML. */
    extra: { lat: number; lon: number; cls: string; html: string }[] = [],
  ): void {
    if (trackedId !== this.tracked) {
      this.tracked = trackedId;
      for (const p of this.paths.values()) this.rebuild(p);
    }
    if (!this.visible) return;
    origin.place(this.group, EARTH_CENTER);
    camera.updateMatrixWorld();
    this.used = 0;
    const cam = origin.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const label = (world: V3, cls: string, html: string) => {
      const rel = this.v.set(world[0] - cam[0], world[1] - cam[1], world[2] - cam[2]);
      if (occluded(rel, cam)) return;
      rel.project(camera);
      if (rel.z > 1 || Math.abs(rel.x) > 1.1 || Math.abs(rel.y) > 1.1) return;
      const el = this.next();
      el.className = `map-label ${cls}`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.style.transform = `translate(${((rel.x + 1) / 2) * w}px, ${((1 - rel.y) / 2) * h}px)`;
    };

    label([0, 0, 0], 'site', '<i></i><span>Starbase</span>');
    if (this.bodies) {
      const { sunDir, moon } = this.bodies;
      // The Sun, far off in its direction; the Moon, and its orbit (rebuilt as its plane turns).
      label([cam[0] + sunDir.x * 1e12, cam[1] + sunDir.y * 1e12, cam[2] + sunDir.z * 1e12], 'body sun', '<i></i><span>Sun</span>');
      label(moon.world, 'body', `<i></i><span>Moon<br><b>${phaseName(moon.illuminated, moon.waxing)} · ${Math.round(moon.illuminated * 100)}%</b></span>`);
      if (this.orbitNormal.dot(moon.orbitNormal) < 0.999999) {
        this.orbitNormal.copy(moon.orbitNormal);
        const u = moon.dir.clone();
        const v = new THREE.Vector3().crossVectors(moon.orbitNormal, u);
        const pts: number[] = [];
        for (let i = 0; i <= 256; i++) {
          const a = (i / 256) * Math.PI * 2;
          const p = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)).multiplyScalar(MOON_DISTANCE);
          pts.push(p.x, p.y, p.z);
        }
        this.moonOrbit.geometry.dispose();
        const g = new LineGeometry();
        g.setPositions(pts);
        this.moonOrbit.geometry = g;
      }
    }
    for (const m of extra) label(toWorld(m.lat, m.lon, 0), m.cls, m.html);
    for (const v of vehicles) {
      label(v.world, v.id === trackedId ? 'vehicle tracked' : 'vehicle', `<i></i><span>${v.name}<br><b>${fmtAlt(v.altitude)}</b></span>`);
    }
    const p = this.paths.get(trackedId);
    if (p) {
      const t = p.traj;
      const age = simTime - t.t;
      const mark = (m: TrajectoryMark | null, cls: string, text: string) => {
        if (!m || m.dt - age < 0) return;
        label(ecefToWorld(m.ecef), `mark ${cls}`, `<i></i><span>${text}<br><b>${fmtTime(m.dt - age)}</b></span>`);
      };
      mark(t.apoapsis, 'ap', `Ap ${fmtAlt(t.apoapsis?.alt ?? 0)}`);
      mark(t.periapsis, 'pe', `Pe ${fmtAlt(t.periapsis?.alt ?? 0)}`);
      mark(t.entry, 'entry', 'Entry 100 km');
      if (t.impact) mark(t.impact, 'impact', `Impact ${fmtLatLon(t.impact.lat, t.impact.lon)}`);
    }
    // The planned orbit after the maneuver.
    const n = this.paths.get(`${trackedId}:node`);
    if (n && n.traj.nodeIndex >= 0) {
      const t = n.traj;
      const age = simTime - t.t;
      const mark = (m: TrajectoryMark | null, cls: string, text: string) => {
        if (!m || m.dt - age < 0) return;
        label(ecefToWorld(m.ecef), `mark node ${cls}`, `<i></i><span>${text}<br><b>${fmtTime(m.dt - age)}</b></span>`);
      };
      label(ecefToWorld(t.points[t.nodeIndex]), 'mark node burn', '<i></i><span>Maneuver</span>');
      mark(t.apoapsis, 'ap', `Ap ${fmtAlt(t.apoapsis?.alt ?? 0)} (planned)`);
      mark(t.periapsis, 'pe', `Pe ${fmtAlt(t.periapsis?.alt ?? 0)} (planned)`);
      if (t.impact) mark(t.impact, 'impact', `Impact ${fmtLatLon(t.impact.lat, t.impact.lon)} (planned)`);
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  private next(): HTMLElement {
    let el = this.pool[this.used];
    if (!el) {
      el = document.createElement('div');
      this.labels.appendChild(el);
      this.pool.push(el);
    }
    el.style.display = '';
    this.used++;
    return el;
  }
}

/** Whether the Earth hides a point (camera-relative) from the camera. */
function occluded(rel: THREE.Vector3, cam: V3): boolean {
  // Ray from the camera (origin) toward rel; Earth centre relative to the camera.
  const cx = EARTH_CENTER[0] - cam[0];
  const cy = EARTH_CENTER[1] - cam[1];
  const cz = EARTH_CENTER[2] - cam[2];
  const len = rel.length();
  if (len < 1) return false;
  const dx = rel.x / len;
  const dy = rel.y / len;
  const dz = rel.z / len;
  const along = cx * dx + cy * dy + cz * dz;
  if (along <= 0) return false;
  const d2 = cx * cx + cy * cy + cz * cz - along * along;
  if (d2 > OCCLUDER_R * OCCLUDER_R) return false;
  const enter = along - Math.sqrt(OCCLUDER_R * OCCLUDER_R - d2);
  return enter < len;
}

export function fmtAlt(m: number): string {
  return m >= 1e5 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m))} m`;
}

export function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return hh ? `in ${hh}:${p(mm)}:${p(ss)}` : `in ${mm}:${p(ss)}`;
}

function fmtLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}
