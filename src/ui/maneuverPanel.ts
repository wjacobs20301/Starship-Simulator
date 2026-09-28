// Maneuver planner (KSP-style node): pick when to burn and how much prograde / normal / radial
// delta-v; the map shows the orbit that burn would give, the navball where to point, and this
// panel the burn time and when to light the engines.

import type { ManeuverNode, Snapshot } from '../sim/simulation';
import type { Trajectory } from '../sim/trajectory';
import type { FromWorker } from '../worker/protocol';

const AXES = ['Prograde', 'Normal', 'Radial'] as const;
/** After a click, trust the local copy over the sim's echo for this long (ms). */
const EDIT_HOLD = 400;

export class ManeuverPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private node: ManeuverNode | null = null;
  private editedAt = 0;
  private lastHtml = '';
  private snap: Snapshot | null = null;
  private trackedId = '';
  private traj: Trajectory | null = null;

  constructor(
    parent: HTMLElement,
    private onChange: (node: ManeuverNode | null) => void,
    /** Warp ahead to just before the burn (true) or stop warping (false). */
    private onWarp: (go: boolean) => void,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'maneuver';
    this.root.className = 'hud hidden';
    this.body = document.createElement('div');
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.act) this.act(b.dataset.act, e.shiftKey);
    });
  }

  /** N: add a node on the tracked vehicle, or delete the one there is. */
  toggle(): void {
    if (this.node) this.set(null);
    else this.add();
  }

  private add(): void {
    const s = this.snap;
    const v = s?.vehicles.find((x) => x.id === this.trackedId);
    if (!s || !v || v.status !== 'flight') return;
    // At the next apoapsis if there is one ahead, else two minutes from now.
    const ap = this.traj?.apoapsis;
    const t = ap && this.traj && this.traj.t + ap.dt > s.t + 10 ? this.traj.t + ap.dt : s.t + 120;
    this.set({ vehicle: v.id, t, dv: [0, 0, 0] });
  }

  private set(node: ManeuverNode | null): void {
    this.node = node;
    this.editedAt = performance.now();
    this.onChange(node);
  }

  private act(act: string, big: boolean): void {
    if (act === 'add') return this.add();
    if (act === 'warp' || act === 'stopwarp') return this.onWarp(act === 'warp');
    const n = this.node;
    const s = this.snap;
    if (!n || !s) return;
    if (act === 'delete') return this.set(null);
    const [kind, arg] = act.split(':');
    if (kind === 'dv') {
      const [axis, step] = arg.split('/').map(Number);
      const dv: ManeuverNode['dv'] = [...n.dv];
      dv[axis] = Math.round((dv[axis] + step * (big ? 10 : 1)) * 10) / 10;
      this.set({ ...n, dv });
    } else if (kind === 'time') {
      this.set({ ...n, t: Math.max(s.t + 5, n.t + Number(arg) * (big ? 10 : 1)) });
    } else if (kind === 'ap' || kind === 'pe') {
      const m = kind === 'ap' ? this.traj?.apoapsis : this.traj?.periapsis;
      if (m && this.traj) this.set({ ...n, t: Math.max(s.t + 5, this.traj.t + m.dt) });
    }
  }

  update(s: Snapshot, trackedId: string, traj: Trajectory | null, mapOn: boolean, warpTo: FromWorker['warpTo']): void {
    this.snap = s;
    this.trackedId = trackedId;
    this.traj = traj;
    // The sim is the source of truth (a node clears itself when the burn is done), except just
    // after a local edit that hasn't echoed back yet.
    if (performance.now() - this.editedAt > EDIT_HOLD) this.node = s.node ? { vehicle: s.node.vehicle, t: s.node.t, dv: [...s.node.dv] } : null;
    const tracked = s.vehicles.find((v) => v.id === trackedId);
    const canPlan = tracked?.status === 'flight';
    const show = !!this.node || (mapOn && canPlan);
    this.root.classList.toggle('hidden', !show);
    if (!show) return;

    let html: string;
    if (!this.node) {
      html = `<div class="mn-title">MANEUVER</div><button data-act="add" class="mn-add">+ Add maneuver node <kbd>N</kbd></button>`;
    } else {
      const n = this.node;
      const name = s.vehicles.find((v) => v.id === n.vehicle)?.name ?? n.vehicle;
      const total = Math.hypot(...n.dv);
      const live = s.node && s.node.vehicle === n.vehicle ? s.node : null;
      const burn = live?.burnTime ?? Infinity;
      const toNode = n.t - s.t;
      const start = toNode - (Number.isFinite(burn) ? burn / 2 : 0);
      const rows = AXES.map(
        (label, i) =>
          `<div class="mn-row"><span class="mn-l">${label}</span>` +
          `<button data-act="dv:${i}/-10">−10</button><button data-act="dv:${i}/-1">−1</button>` +
          `<b>${fmtSigned(n.dv[i])}</b>` +
          `<button data-act="dv:${i}/1">+1</button><button data-act="dv:${i}/10">+10</button></div>`,
      ).join('');
      html =
        `<div class="mn-title">MANEUVER · ${name.toUpperCase()}</div>${rows}` +
        `<div class="mn-row"><span class="mn-l">Node</span>` +
        `<button data-act="time:-60">−1m</button><button data-act="time:-10">−10s</button>` +
        `<b>${toNode >= 0 ? `in ${fmtDur(toNode)}` : `${fmtDur(-toNode)} ago`}</b>` +
        `<button data-act="time:10">+10s</button><button data-act="time:60">+1m</button></div>` +
        `<div class="mn-row mn-snap"><button data-act="ap">At Ap</button><button data-act="pe">At Pe</button><button data-act="delete" class="mn-del">Delete</button></div>` +
        `<div class="mn-info">Δv <b>${total.toFixed(1)}</b> m/s` +
        (live ? ` · left <b>${live.remaining.toFixed(1)}</b>` : '') +
        ` · burn ${Number.isFinite(burn) ? fmtDur(burn) : '—'}` +
        `<br>${start > 0 ? `Start burn in <b>${fmtDur(start)}</b> · SAS ⊕ MNV` : '<b class="go">BURN NOW</b> · SAS ⊕ MNV'}</div>` +
        (warpTo?.target === 'node'
          ? `<div class="mn-row mn-warp"><button data-act="stopwarp" class="warping">■ Stop warp · ${fmtDur(warpTo.at - s.t)} to go</button></div>`
          : start > 35
            ? `<div class="mn-row mn-warp"><button data-act="warp">⏩ Warp to burn</button></div>`
            : '') +
        `<div class="mn-hint">Shift-click ×10 · <kbd>N</kbd> delete · <kbd>.</kbd> warp</div>`;
    }
    if (html !== this.lastHtml) {
      this.body.innerHTML = html;
      this.lastHtml = html;
    }
  }
}

function fmtSigned(x: number): string {
  return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
}

export function fmtDur(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
