// KSP-style navball: a sky/ground ball in the vehicle's local horizon frame, seen from behind the
// vehicle so its centre is where the nose points. Screen up is body -y (so W, which pitches the
// nose toward +y, moves it "down"), screen right is body +z. Markers: prograde / retrograde
// (surface velocity below 36 km, orbital above) and the SAS target.

import type { M3, V3 } from '../sim/math';

const SURFACE_MODE_ALT = 36e3;

export interface NavballState {
  rotLocal: M3;
  vSurfLocal: V3;
  vOrbLocal: V3;
  /** Altitude above ground, m (picks surface vs orbital velocity). */
  altitude: number;
  sasDirLocal: V3 | null;
  /** Maneuver node burn direction (local ENU), if planned. */
  maneuverLocal?: V3 | null;
}

export class Navball {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private px: number;
  /** Heading and pitch of the nose, degrees (for the readout). */
  heading = 0;
  pitch = 0;

  /** size: CSS pixels. */
  constructor(parent: HTMLElement, private size = 118) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.px = Math.round(size * dpr);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.px;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.canvas.className = 'navball';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(this.px, this.px);
  }

  draw(s: NavballState): void {
    const m = s.rotLocal;
    // Body axes in local ENU (columns of body -> ENU).
    const xE: V3 = [m[0], m[3], m[6]];
    const yE: V3 = [m[1], m[4], m[7]];
    const zE: V3 = [m[2], m[5], m[8]];
    const upS: V3 = [-yE[0], -yE[1], -yE[2]]; // screen up
    this.pitch = (Math.asin(Math.max(-1, Math.min(1, xE[2]))) * 180) / Math.PI;
    this.heading = ((Math.atan2(xE[0], xE[1]) * 180) / Math.PI + 360) % 360;

    const n = this.px;
    const r = n / 2 - 1;
    const d = this.img.data;
    for (let j = 0; j < n; j++) {
      const sy = -(j + 0.5 - n / 2) / r;
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4;
        const sx = (i + 0.5 - n / 2) / r;
        const rr = sx * sx + sy * sy;
        if (rr > 1) {
          d[k + 3] = 0;
          continue;
        }
        const sz = Math.sqrt(1 - rr);
        // Screen -> ENU: p = sx * right + sy * up + sz * nose.
        const e = sx * zE[0] + sy * upS[0] + sz * xE[0];
        const nn = sx * zE[1] + sy * upS[1] + sz * xE[1];
        const u = sx * zE[2] + sy * upS[2] + sz * xE[2];
        const elev = (Math.asin(Math.max(-1, Math.min(1, u))) * 180) / Math.PI;
        const head = (Math.atan2(e, nn) * 180) / Math.PI;
        let cr: number, cg: number, cb: number;
        if (elev >= 0) {
          const t = elev / 90;
          cr = 78 - 40 * t;
          cg = 98 - 48 * t;
          cb = 124 - 54 * t;
        } else {
          const t = -elev / 90;
          cr = 62 - 30 * t;
          cg = 56 - 28 * t;
          cb = 50 - 25 * t;
        }
        // Pitch lines every 10 deg (stronger every 30), heading meridians every 30 deg.
        const pl = Math.abs(elev - Math.round(elev / 10) * 10);
        const major = Math.round(elev / 10) % 3 === 0;
        const line = elev === 0 ? 0 : pl < (major ? 0.55 : 0.3) ? (major ? 0.7 : 0.45) : 0;
        const hl = Math.abs(head - Math.round(head / 30) * 30) * Math.cos((elev * Math.PI) / 180);
        const mer = Math.abs(elev) < 80 && hl < 0.35 ? 0.3 : 0;
        const horizon = Math.abs(elev) < 0.6 ? 1 : 0;
        const w = Math.max(line, mer, horizon);
        cr += (255 - cr) * w;
        cg += (255 - cg) * w;
        cb += (255 - cb) * w;
        // Limb darkening for a 3D look.
        const shade = 0.55 + 0.45 * sz;
        d[k] = cr * shade;
        d[k + 1] = cg * shade;
        d[k + 2] = cb * shade;
        d[k + 3] = rr > 0.985 ? 255 * (1 - (rr - 0.985) / 0.015) : 255;
      }
    }
    const g = this.ctx;
    g.putImageData(this.img, 0, 0);

    // ENU direction -> canvas position (null if behind the ball).
    const toScreen = (p: V3): [number, number] | null => {
      const l = Math.hypot(p[0], p[1], p[2]);
      if (l < 1e-6) return null;
      const sx = (p[0] * zE[0] + p[1] * zE[1] + p[2] * zE[2]) / l;
      const sy = (p[0] * upS[0] + p[1] * upS[1] + p[2] * upS[2]) / l;
      const sz = (p[0] * xE[0] + p[1] * xE[1] + p[2] * xE[2]) / l;
      if (sz < 0.05) return null;
      return [n / 2 + sx * r, n / 2 - sy * r];
    };
    const k = n / this.size;
    g.lineWidth = 2 * k;
    // Compass letters on the horizon.
    g.font = `600 ${11 * k}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (const [label, dir] of [['N', [0, 1, 0]], ['E', [1, 0, 0]], ['S', [0, -1, 0]], ['W', [-1, 0, 0]]] as [string, V3][]) {
      const p = toScreen(dir);
      if (p) g.fillText(label, p[0], p[1] - 8 * k);
    }
    // Velocity markers.
    const vel = s.altitude < SURFACE_MODE_ALT ? s.vSurfLocal : s.vOrbLocal;
    if (Math.hypot(vel[0], vel[1], vel[2]) > 1) {
      const pro = toScreen(vel);
      if (pro) marker(g, pro, k, 'prograde');
      const retro = toScreen([-vel[0], -vel[1], -vel[2]]);
      if (retro) marker(g, retro, k, 'retrograde');
    }
    if (s.maneuverLocal) {
      const p = toScreen(s.maneuverLocal);
      if (p) marker(g, p, k, 'maneuver');
    }
    if (s.sasDirLocal) {
      const p = toScreen(s.sasDirLocal);
      if (p) marker(g, p, k, 'sas');
    }
    // The nose: fixed at the centre.
    g.strokeStyle = '#ffcc33';
    g.lineWidth = 3 * k;
    g.beginPath();
    g.moveTo(n / 2 - 22 * k, n / 2);
    g.lineTo(n / 2 - 8 * k, n / 2);
    g.lineTo(n / 2, n / 2 + 7 * k);
    g.lineTo(n / 2 + 8 * k, n / 2);
    g.lineTo(n / 2 + 22 * k, n / 2);
    g.stroke();
    g.beginPath();
    g.arc(n / 2, n / 2, 2 * k, 0, Math.PI * 2);
    g.fillStyle = '#ffcc33';
    g.fill();
  }
}

function marker(g: CanvasRenderingContext2D, [x, y]: [number, number], k: number, kind: 'prograde' | 'retrograde' | 'sas' | 'maneuver'): void {
  const r = 7 * k;
  g.lineWidth = 2 * k;
  if (kind === 'maneuver') {
    // KSP's burn marker: a blue ring with three prongs.
    g.strokeStyle = '#3fa9ff';
    g.lineWidth = 2.5 * k;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    for (const a of [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]) {
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      g.lineTo(x + Math.cos(a) * (r + 6 * k), y + Math.sin(a) * (r + 6 * k));
      g.stroke();
    }
    return;
  }
  if (kind === 'sas') {
    g.strokeStyle = '#ff5fd2';
    g.beginPath();
    g.arc(x, y, r + 3 * k, 0, Math.PI * 2);
    g.stroke();
    return;
  }
  g.strokeStyle = '#c8f25a';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  if (kind === 'prograde') {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1]]) {
      g.beginPath();
      g.moveTo(x + dx * r, y + dy * r);
      g.lineTo(x + dx * (r + 6 * k), y + dy * (r + 6 * k));
      g.stroke();
    }
    g.beginPath();
    g.arc(x, y, 1.5 * k, 0, Math.PI * 2);
    g.fillStyle = '#c8f25a';
    g.fill();
  } else {
    const q = r * 0.7;
    g.beginPath();
    g.moveTo(x - q, y - q);
    g.lineTo(x + q, y + q);
    g.moveTo(x + q, y - q);
    g.lineTo(x - q, y + q);
    g.stroke();
  }
}
