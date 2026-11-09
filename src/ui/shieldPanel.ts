// The heat shield map: the ship's windward half unrolled flat (flaps on the left, nose on the
// right, the belly's centreline across the middle), each patch shaded by its missing tiles, how
// far their backing has charred and how hot they glow right now. Shown in the inspection camera
// view, and through the entry when there are gaps.

import { SHIELD, type ShieldSnapshot } from '../sim/heatShield';

const CELL_W = 9;
const CELL_H = 8;

export class ShieldPanel {
  private el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private caption: HTMLDivElement;
  private shown = false;
  private last = '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'shield-panel';
    this.el.innerHTML = '<div class="sp-title">HEAT SHIELD</div>';
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = SHIELD.rows * CELL_W * dpr;
    this.canvas.height = SHIELD.cols * CELL_H * dpr;
    this.canvas.style.width = `${SHIELD.rows * CELL_W}px`;
    this.canvas.style.height = `${SHIELD.cols * CELL_H}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.caption = document.createElement('div');
    this.caption.className = 'sp-cap';
    const axis = document.createElement('div');
    axis.className = 'sp-axis';
    axis.innerHTML = '<span>flaps</span><span>belly</span><span>nose ›</span>';
    this.el.append(this.canvas, axis, this.caption);
    parent.appendChild(this.el);
  }

  update(s: ShieldSnapshot, show: boolean): void {
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('on', show);
    }
    if (!show) return;
    // (Redrawn only when something on it changes.)
    const key = `${s.missing.join()}|${s.char.join()}|${s.glow.map((g) => Math.round(g / 2e4)).join()}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx;
    c.clearRect(0, 0, SHIELD.rows * CELL_W, SHIELD.cols * CELL_H);
    for (let row = 0; row < SHIELD.rows; row++) {
      for (let col = 0; col < SHIELD.cols; col++) {
        const i = row * SHIELD.cols + col;
        const m = s.missing[i];
        const x = row * CELL_W;
        // (Body +z, the left side, at the top.)
        const y = (SHIELD.cols - 1 - col) * CELL_H;
        let fill = '#1b1d21';
        if (m > 0) {
          const ch = Math.min(1, s.char[i]);
          const hot = Math.min(1, s.glow[i] / 3e5);
          const a = 0.35 + 0.65 * Math.min(1, m / 12);
          // Pale backing -> charred brown; hot: orange; burned through: red.
          const r = Math.round(200 - 120 * ch + 55 * hot);
          const g = Math.round(195 - 150 * ch + 20 * hot);
          const b = Math.round(185 - 170 * ch - 60 * hot);
          fill = s.char[i] >= 1 ? '#e0443a' : `rgba(${r},${g},${Math.max(0, b)},${a.toFixed(2)})`;
        }
        c.fillStyle = fill;
        c.fillRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1);
      }
    }
    const burned = s.char.filter((x) => x >= 1).length;
    const worst = Math.max(0, ...s.char);
    this.caption.innerHTML =
      (s.lost ? `${s.lost} tile${s.lost > 1 ? 's' : ''} missing` : 'All tiles in place') +
      (worst > 0.05 ? ` · worst gap ${Math.round(Math.min(1, worst) * 100)}% charred` : '') +
      (burned ? ` · <b>${burned} burn-through${burned > 1 ? 's' : ''}</b>` : '') +
      (s.verdict ? ` · ${s.verdict === 'go' ? 'inspection GO' : '<b>inspection NO-GO</b>'}` : '');
  }
}
