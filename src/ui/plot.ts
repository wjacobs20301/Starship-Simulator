// Altitude and speed vs time: simulation traces over the reference profile.

import { REFERENCE_ASCENT, REFERENCE_NAME } from '../sim/reference/ift';
import type { Snapshot } from '../sim/simulation';

interface Sample {
  t: number;
  altKm: number;
  speedKmh: number;
}

const T_MAX = 600;
const ALT_MAX = 200;
const SPD_MAX = 28000;

export class TelemetryPlot {
  private ctx: CanvasRenderingContext2D;
  private upper: Sample[] = [];
  private booster: Sample[] = [];
  private nextT = 0;
  visible = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  reset(): void {
    this.upper = [];
    this.booster = [];
    this.nextT = 0;
  }

  record(s: Snapshot): void {
    const tm = s.missionTime;
    if (tm === null || tm < this.nextT) return;
    this.nextT = tm + 1;
    const sample = (id: string) => {
      const v = s.vehicles.find((x) => x.id === id);
      return v && v.status !== 'destroyed'
        ? { t: tm, altKm: v.telemetry.altitude / 1000, speedKmh: v.telemetry.speed * 3.6 }
        : null;
    };
    const up = sample('stack') ?? sample('ship');
    if (up) this.upper.push(up);
    const b = sample('booster');
    if (b) this.booster.push(b);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.draw();
  }

  draw(): void {
    if (!this.visible) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pad = { l: 44, r: 12, t: 24, b: 22 };
    const ph = (h - pad.t - pad.b - 18) / 2;
    const panels = [
      { key: 'altKm' as const, max: ALT_MAX, label: 'Altitude (km)', y0: pad.t },
      { key: 'speedKmh' as const, max: SPD_MAX, label: 'Speed (km/h)', y0: pad.t + ph + 18 },
    ];
    const x = (t: number) => pad.l + (t / T_MAX) * (w - pad.l - pad.r);
    c.font = '500 11.5px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    c.fillStyle = '#e8ecf2';
    c.fillText(`Sim (solid) vs ${REFERENCE_NAME} (dots) · booster dashed`, pad.l, 14);
    for (const p of panels) {
      const y = (v: number) => p.y0 + ph - (v / p.max) * ph;
      c.strokeStyle = 'rgba(255,255,255,0.1)';
      c.lineWidth = 1;
      c.beginPath();
      for (let t = 0; t <= T_MAX; t += 60) {
        c.moveTo(x(t), p.y0);
        c.lineTo(x(t), p.y0 + ph);
      }
      for (let i = 0; i <= 4; i++) {
        c.moveTo(pad.l, p.y0 + (i * ph) / 4);
        c.lineTo(w - pad.r, p.y0 + (i * ph) / 4);
      }
      c.stroke();
      c.fillStyle = 'rgba(232,236,242,0.75)';
      c.fillText(p.label.toUpperCase(), pad.l + 4, p.y0 + 12);
      c.fillText(String(p.max), 4, p.y0 + 10);
      c.fillText('0', 30, p.y0 + ph);
      c.fillStyle = 'rgba(255,255,255,0.4)';
      for (const r of REFERENCE_ASCENT) {
        c.beginPath();
        c.arc(x(r.t), y(r[p.key]), 2.5, 0, Math.PI * 2);
        c.fill();
      }
      const line = (data: Sample[], color: string, dash: number[]) => {
        c.strokeStyle = color;
        c.setLineDash(dash);
        c.lineWidth = 1.8;
        c.beginPath();
        data.forEach((d, i) => (i ? c.lineTo(x(d.t), y(d[p.key])) : c.moveTo(x(d.t), y(d[p.key]))));
        c.stroke();
        c.setLineDash([]);
      };
      line(this.booster, 'rgba(255,255,255,0.7)', [5, 4]);
      line(this.upper, '#ffffff', []);
    }
    c.fillStyle = 'rgba(232,236,242,0.75)';
    for (let t = 0; t <= T_MAX; t += 120) c.fillText(`${t}s`, x(t) - 8, h - 6);
  }
}
