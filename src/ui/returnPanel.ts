// "Go home" for the ship: send it back to a launch tower (caught by the chopsticks) or to a point
// in the ocean, on autopilot, and follow what it's doing. Shift-click the globe in the map view to
// pick the ocean point.

import { SPLASH_TARGET } from '../game/missions';
import type { ReturnTarget } from '../sim/shipReturn';
import type { Snapshot } from '../sim/simulation';
import type { FromWorker } from '../worker/protocol';

export class ReturnPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private lastHtml = '';
  /** Ocean point to use (map shift-click), degrees. */
  ocean = { ...SPLASH_TARGET };

  constructor(
    parent: HTMLElement,
    private send: (target: ReturnTarget | null) => void,
    /** Warp ahead to the autopilot's next event (true) or stop warping (false). */
    private onWarp: (go: boolean) => void,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'return';
    this.root.className = 'hud hidden';
    this.body = document.createElement('div');
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'tower') this.send({ kind: 'tower', pad: -1 });
      else if (act === 'ocean') this.send({ kind: 'ocean', lat: this.ocean.lat, lon: this.ocean.lon });
      else if (act === 'cancel') this.send(null);
      else if (act === 'warp' || act === 'stopwarp') this.onWarp(act === 'warp');
    });
  }

  setOcean(lat: number, lon: number): void {
    this.ocean = { lat, lon };
    this.lastHtml = '';
  }

  update(s: Snapshot, trackedId: string, mapOn: boolean, warpTo: FromWorker['warpTo']): void {
    const ship = s.vehicles.find((v) => v.id === 'ship');
    const r = s.shipReturn;
    const canCommand = !!ship && ship.status === 'flight' && s.phase === 'coast';
    const show = !!r || (canCommand && (trackedId === 'ship' || mapOn));
    this.root.classList.toggle('hidden', !show);
    if (!show) return;
    const fmt = (sec: number) => {
      const t = Math.max(0, Math.round(sec));
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const p = (n: number) => String(n).padStart(2, '0');
      return h ? `${h}:${p(m)}:${p(t % 60)}` : `${m}:${p(t % 60)}`;
    };
    const oceanLabel = `${Math.abs(this.ocean.lat).toFixed(1)}°${this.ocean.lat >= 0 ? 'N' : 'S'} ${Math.abs(this.ocean.lon).toFixed(1)}°${this.ocean.lon >= 0 ? 'E' : 'W'}`;
    let html = `<div class="rt-title">RETURN SHIP</div>`;
    if (!r) {
      html +=
        `<div class="rt-buttons"><button data-act="tower">⌂ Tower catch</button><button data-act="ocean">≈ Ocean ${oceanLabel}</button></div>` +
        `<div class="rt-hint">Autopilot plans the burns, entry and landing. Shift-click the globe (Tab map) to pick the ocean point.</div>`;
    } else {
      const where = r.target.kind === 'tower' ? `Pad ${r.target.pad + 1} tower` : r.target.kind === 'ground' ? 'ground beside the pad (diverted)' : `ocean ${oceanLabel}`;
      const burns = r.burns
        .filter((b) => b.t > s.t - 5)
        .map((b) => `${b.label} ${b.dv.toFixed(0)} m/s in ${fmt(b.t - s.t)}`)
        .join('<br>');
      html +=
        `<div class="rt-where">→ ${where} · <span>${r.phase}</span></div>` +
        `<div class="rt-status">${r.paused ? pausedText(r) : r.status}</div>` +
        (burns ? `<div class="rt-burns">${burns}</div>` : '') +
        `<div class="rt-dv">Δv ${Math.round(r.dvNeeded)} of ${Math.round(r.dvAvailable)} m/s` +
        (r.predicted ? ` · predicted miss ${r.predicted.missKm < 10 ? r.predicted.missKm.toFixed(1) : r.predicted.missKm.toFixed(0)} km` : '') +
        `</div>` +
        (['caught', 'landed', 'lost'].includes(r.phase)
          ? ''
          : `<div class="rt-buttons">` +
            (warpTo?.target === 'next'
              ? `<button data-act="stopwarp" class="warping">■ Stop warp · ${fmt(warpTo.at - s.t)} to go</button>`
              : s.waitUntil !== null && s.waitUntil - s.t > 60
                ? `<button data-act="warp">⏩ Warp to ${r.phase === 'burn' ? 'next burn' : 'entry'} (${fmt(s.waitUntil - s.t)})</button>`
                : '') +
            `<button data-act="cancel">✕ Cancel</button></div>`);
    }
    if (html !== this.lastHtml) {
      this.body.innerHTML = html;
      this.lastHtml = html;
    }
  }
}

/** Status while the player flies: how to hand back, and (falling) by what height. */
function pausedText(r: NonNullable<Snapshot['shipReturn']>): string {
  let text = '<b>Paused: you have the controls.</b> Press <kbd>L</kbd> to hand back to the autopilot.';
  if (r.handBackBy !== null && r.height !== null) {
    const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
    text +=
      r.height < r.handBackBy
        ? `<br><b class="warn">Below ${km(r.handBackBy)}: too low for the planned approach. Hand back now: it will divert, or may not stop in time.</b>`
        : `<br>Hand back above <b>${km(r.handBackBy)}</b> to make the approach (now ${km(r.height)}).`;
  }
  return text;
}
