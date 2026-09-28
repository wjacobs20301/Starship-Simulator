// SpaceX-webcast-style overlay along the bottom of the screen: each vehicle's engine map,
// attitude silhouette and ring gauges (speed, altitude) either side, and in the middle the
// mission timeline arc with its milestones sliding past, the mission clock and the flight's
// name. Milestones light up as they're reached and flash a caption; at stage separation the
// two vehicles' blocks split apart. Kept clean: no boxes, a soft shade behind it.

import { STARSHIP_V3, SUPER_HEAVY_V3 } from '../sim/config/starshipV3';
import type { Snapshot, VehicleSnapshot } from '../sim/simulation';
import type { StageDef, StageId } from '../sim/vehicle';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

export function formatClock(tm: number | null): string {
  if (tm === null) return 'T-00:00:10';
  const sign = tm < 0 ? '-' : '+';
  const s = Math.floor(Math.abs(tm));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `T${sign}${hh}:${mm}:${ss}`;
}

// --- Ring gauge ------------------------------------------------------------------------------

/** A 270 deg ring with the value in the middle, like the webcast's speed / altitude dials. */
export class Gauge {
  readonly el: HTMLElement;
  private arc: SVGPathElement;
  private value: HTMLElement;
  private len: number;

  constructor(
    label: string,
    private unit: string,
    private max: number,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'wc-gauge';
    const svg = svgEl('svg', { viewBox: '0 0 100 100' });
    const r = 42;
    // From 135 deg round to 405 deg (open at the bottom).
    const pt = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return `${50 + r * Math.cos(a)} ${50 + r * Math.sin(a)}`;
    };
    const d = `M ${pt(135)} A ${r} ${r} 0 1 1 ${pt(45)}`;
    svg.appendChild(svgEl('path', { d, class: 'track' }));
    this.arc = svgEl('path', { d, class: 'fill' });
    svg.appendChild(this.arc);
    this.len = (270 / 360) * 2 * Math.PI * r;
    this.arc.style.strokeDasharray = `${this.len} ${this.len}`;
    this.el.appendChild(svg);
    const text = document.createElement('div');
    text.className = 'wc-gauge-text';
    text.innerHTML = `<div class="wc-glabel">${label}</div><div class="wc-gvalue">0</div><div class="wc-gunit">${this.unit}</div>`;
    this.el.appendChild(text);
    this.value = text.querySelector('.wc-gvalue')!;
  }

  set(v: number, text: string): void {
    const f = Math.max(0, Math.min(1, v / this.max));
    this.arc.style.strokeDashoffset = String(this.len * (1 - f));
    if (this.value.textContent !== text) this.value.textContent = text;
  }
}

// --- Engine map and attitude silhouette ------------------------------------------------------

function engineMap(def: StageDef): { svg: SVGSVGElement; dots: SVGCircleElement[] } {
  const svg = svgEl('svg', { viewBox: '-5.2 -5.2 10.4 10.4', class: 'wc-engines' });
  svg.appendChild(svgEl('circle', { r: 4.9, class: 'ring' }));
  const dots = def.engines.map((e) => {
    const c = svgEl('circle', { cx: e.pos[1], cy: -e.pos[2], r: Math.sqrt(e.type.exitArea / Math.PI) * 0.66 });
    svg.appendChild(c);
    return c;
  });
  return { svg, dots };
}

/** Side-view silhouette turned to the vehicle's pitch (nose right = along the flight). */
function attitudeIcon(kind: 'booster' | 'ship'): { el: HTMLElement; body: SVGGElement } {
  const el = document.createElement('div');
  el.className = 'wc-attitude';
  const svg = svgEl('svg', { viewBox: '-50 -50 100 100' });
  svg.appendChild(svgEl('circle', { r: 46, class: 'ring' }));
  svg.appendChild(svgEl('line', { x1: -40, y1: 0, x2: 40, y2: 0, class: 'horizon' }));
  const n = svgEl('text', { x: 0, y: -34, class: 'north' });
  n.textContent = 'N';
  svg.appendChild(n);
  const body = svgEl('g', { class: 'body' });
  // Drawn nose to the right along +x.
  if (kind === 'booster') {
    body.appendChild(svgEl('rect', { x: -34, y: -5.5, width: 64, height: 11, rx: 1.5 }));
    body.appendChild(svgEl('rect', { x: 22, y: -8, width: 3, height: 16, class: 'fins' }));
    body.appendChild(svgEl('path', { d: 'M -34 -5.5 L -38 -4 L -38 4 L -34 5.5 Z', class: 'fins' }));
  } else {
    body.appendChild(svgEl('path', { d: 'M -30 -5.5 L 14 -5.5 Q 30 -4 36 0 Q 30 4 14 5.5 L -30 5.5 Z' }));
    body.appendChild(svgEl('path', { d: 'M 12 -5.5 L 24 -10 L 22 -5 Z M 12 5.5 L 24 10 L 22 5 Z', class: 'fins' }));
    body.appendChild(svgEl('path', { d: 'M -30 -5.5 L -24 -12 L -18 -5.5 Z M -30 5.5 L -24 12 L -18 5.5 Z', class: 'fins' }));
  }
  svg.appendChild(body);
  el.appendChild(svg);
  return { el, body };
}

// --- A vehicle's block -----------------------------------------------------------------------

/** How long a caught / landed vehicle's block stays up before it bows out, ms. */
const REST_LINGER_MS = 12000;

export class VehicleBlock {
  readonly el: HTMLElement;
  private dots: SVGCircleElement[];
  private speed = new Gauge('SPEED', 'KM/H', 30000);
  private alt = new Gauge('ALTITUDE', 'KM', 200);
  private body: SVGGElement;
  private name: HTMLElement;
  private tag: HTMLElement;
  private prop: HTMLElement;
  private shown = false;
  /** When it came to rest (caught / landed), real ms: the block bows out a few seconds later. */
  private restedAt: number | null = null;

  constructor(
    private stage: StageId,
    def: StageDef,
    title: string,
    mirror: boolean,
  ) {
    this.el = document.createElement('div');
    this.el.className = `wc-vehicle ${mirror ? 'right' : 'left'} gone`;
    const { svg, dots } = engineMap(def);
    this.dots = dots;
    const att = attitudeIcon(stage);
    this.body = att.body;
    const head = document.createElement('div');
    head.className = 'wc-head';
    head.innerHTML = `<span class="wc-name">${title}</span><span class="wc-tag"></span>`;
    this.name = head.querySelector('.wc-name')!;
    this.tag = head.querySelector('.wc-tag')!;
    const row = document.createElement('div');
    row.className = 'wc-row';
    const icons = document.createElement('div');
    icons.className = 'wc-icons';
    icons.append(svg, att.el);
    const gauges = document.createElement('div');
    gauges.className = 'wc-gauges';
    gauges.append(this.speed.el, this.alt.el);
    if (mirror) row.append(gauges, icons);
    else row.append(icons, gauges);
    const prop = document.createElement('div');
    prop.className = 'wc-prop';
    prop.innerHTML = '<span>PROP</span><div class="wc-bar"><i></i></div>';
    this.prop = prop.querySelector('i')!;
    this.el.append(head, row, prop);
  }

  /** Mark the block of the vehicle the player is flying; `extra` (the pilot's numbers) goes
   *  under it. */
  setFlying(on: boolean, extra?: HTMLElement): void {
    this.el.classList.toggle('flying', on);
    if (on && extra) this.el.appendChild(extra);
  }

  setTitle(text: string): void {
    this.name.textContent = text;
  }

  /** Show this vehicle (or hide the block when it's gone). */
  update(v: VehicleSnapshot | undefined): void {
    const rested = !!v && (v.status === 'caught' || v.status === 'landed');
    if (rested && this.restedAt === null) this.restedAt = performance.now();
    if (!rested) this.restedAt = null;
    const done = this.restedAt !== null && performance.now() - this.restedAt > REST_LINGER_MS;
    const show = !!v && v.status !== 'destroyed' && !done;
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('gone', !show);
    }
    if (!v) return;
    const t = v.telemetry;
    this.speed.set(t.speed * 3.6, Math.round(t.speed * 3.6).toLocaleString('en-US'));
    const km = t.altitude / 1000;
    this.alt.set(km, km < 10 ? km.toFixed(1) : Math.round(km).toString());
    const s = v.stageState[this.stage];
    if (s) {
      s.throttles.forEach((th, i) => this.dots[i]?.classList.toggle('on', th > 0.02));
      this.prop.style.transform = `scaleX(${s.propFrac.toFixed(3)})`;
    }
    // Pitch from the body axis (body -> local ENU, row-major: column 0 is the nose).
    const m = t.rotLocal;
    const e = m[0];
    const n = m[3];
    const u = m[6];
    const pitch = (Math.atan2(u, Math.hypot(e, n)) * 180) / Math.PI;
    // Flying west (back toward the pad) the silhouette faces the other way.
    const flip = e < -0.05 ? -1 : 1;
    this.body.setAttribute('transform', `scale(${flip} 1) rotate(${-pitch})`);
    const tag = v.status === 'caught' ? 'CAUGHT' : v.status === 'landed' ? 'LANDED' : this.el.classList.contains('flying') ? 'MANUAL' : '';
    if (this.tag.textContent !== tag) this.tag.textContent = tag;
  }

  /** The two blocks split apart at stage separation. */
  separate(): void {
    this.el.classList.remove('sep');
    void this.el.offsetWidth;
    this.el.classList.add('sep');
  }
}

// --- Mission timeline ------------------------------------------------------------------------

interface Milestone {
  label: string;
  /** Nominal mission time, s (until the event happens; then its real time). */
  at: number;
  match: RegExp;
  /** Caption shown when it happens. */
  caption: string;
}

const MILESTONES = (): Milestone[] => [
  { label: 'LIFTOFF', at: 0, match: /^Liftoff/, caption: 'LIFTOFF' },
  { label: 'MAX Q', at: 62, match: /^Max-Q/, caption: 'MAX Q' },
  { label: 'STAGE SEP', at: 138, match: /^Stage separation/, caption: 'STAGE SEPARATION' },
  { label: 'BOOSTBACK', at: 145, match: /^Boostback burn startup/, caption: 'BOOSTBACK BURN' },
  { label: 'SUPER HEAVY LANDING', at: 420, match: /^Booster caught|^Super Heavy (touchdown|splashdown)/, caption: 'SUPER HEAVY CATCH' },
  { label: 'SECO', at: 466, match: /^SECO/, caption: 'SHIP ENGINE CUTOFF' },
  { label: 'ENTRY', at: 2800, match: /^Entry interface/, caption: 'ATMOSPHERIC ENTRY' },
  { label: 'STARSHIP LANDING', at: 3960, match: /^Splashdown|^Ship caught/, caption: 'STARSHIP LANDING' },
];

/** The arc: a wide, shallow curve; x across 0..W, rising to the middle. */
const ARC_W = 640;
const ARC_H = 64;
/** Space above the arc's box for the milestone labels (viewBox units). */
const LABEL_ROOM = 26;
const ARC_R = 1400;
const arcY = (x: number) => ARC_H - 6 - (Math.sqrt(ARC_R * ARC_R - (x - ARC_W / 2) ** 2) - Math.sqrt(ARC_R * ARC_R - (ARC_W / 2) ** 2));
/** Where "now" sits along the arc, and the stretch of time the arc shows either side, s. */
const NOW_X = 0.42 * ARC_W;
const PAST_S = 240;
const AHEAD_S = 420;

class Timeline {
  readonly el: HTMLElement;
  private past: SVGPathElement;
  private items: { m: Milestone; g: SVGGElement; dot: SVGCircleElement; done: boolean }[] = [];

  constructor(private onCaption: (text: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'wc-timeline';
    // (Room above the arc for the upper row of labels: the timeline's box clips what spills out.)
    const svg = svgEl('svg', { viewBox: `0 ${-LABEL_ROOM} ${ARC_W} ${ARC_H + LABEL_ROOM}` });
    const path = (x0: number, x1: number) => {
      let d = '';
      for (let x = x0; x <= x1; x += 8) d += `${d ? 'L' : 'M'} ${x.toFixed(1)} ${arcY(x).toFixed(1)} `;
      return d;
    };
    svg.appendChild(svgEl('path', { d: path(0, ARC_W), class: 'arc' }));
    this.past = svgEl('path', { d: path(0, NOW_X), class: 'arc past' });
    svg.appendChild(this.past);
    svg.appendChild(svgEl('circle', { cx: NOW_X, cy: arcY(NOW_X), r: 4.5, class: 'now' }));
    MILESTONES().forEach((m, i) => {
      const g = svgEl('g', { class: 'wc-ms' });
      const dot = svgEl('circle', { r: 3.2 });
      // Alternate label heights so neighbours close in time don't overlap.
      const text = svgEl('text', { y: i % 2 ? -21 : -9 });
      text.textContent = m.label;
      g.append(dot, text);
      svg.appendChild(g);
      this.items.push({ m, g, dot, done: false });
    });
    this.el.appendChild(svg);
  }

  reset(): void {
    const fresh = MILESTONES();
    this.items.forEach((it, i) => {
      it.m = fresh[i];
      it.done = false;
      it.g.classList.remove('done', 'hit');
    });
  }

  update(s: Snapshot, now: number | null): void {
    // New events (each snapshot carries those since the last): milestones reached, at their
    // real times, with a caption.
    for (const e of s.events) {
      for (const it of this.items) {
        if (it.done || !it.m.match.test(e.text)) continue;
        it.done = true;
        if (e.missionTime !== null) it.m.at = e.missionTime;
        it.g.classList.add('done', 'hit');
        this.onCaption(it.m.caption);
      }
    }
    const tNow = now ?? -10;
    // Milestones still to come but already overdue slide along with "now" until they happen.
    for (const it of this.items) {
      const at = it.done ? it.m.at : Math.max(it.m.at, tNow);
      const x = NOW_X + ((at - tNow) / (at >= tNow ? AHEAD_S : PAST_S)) * (at >= tNow ? ARC_W - NOW_X : NOW_X);
      const visible = x > -20 && x < ARC_W + 20;
      it.g.style.display = visible ? '' : 'none';
      if (!visible) continue;
      it.g.setAttribute('transform', `translate(${x.toFixed(1)} ${arcY(Math.max(0, Math.min(ARC_W, x))).toFixed(1)})`);
      // Fade out toward the arc's ends.
      const edge = Math.min(x, ARC_W - x) / 70;
      it.g.style.opacity = String(Math.max(0, Math.min(1, edge)));
    }
  }
}

// --- The overlay -------------------------------------------------------------------------------

export class Webcast {
  private root: HTMLElement;
  private booster: VehicleBlock;
  private ship: VehicleBlock;
  private timeline: Timeline;
  private clock: HTMLElement;
  private title: HTMLElement;
  private mode: HTMLElement;
  /** Slot for the flight controls (see FlightPanel). */
  readonly cockpit: HTMLElement;
  private caption: HTMLElement;
  private captionTimer = 0;
  private lastClock = '';
  private wasStack = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'webcast';
    this.booster = new VehicleBlock('booster', SUPER_HEAVY_V3, 'SUPER HEAVY', false);
    this.ship = new VehicleBlock('ship', STARSHIP_V3, 'STARSHIP', true);
    this.timeline = new Timeline((text) => this.showCaption(text));
    const center = document.createElement('div');
    center.className = 'wc-center';
    // While the player flies, the timeline arc and the title fold away and the middle becomes the
    // "cockpit" (throttle, navball, SAS) with the clock, small, under the navball.
    center.innerHTML =
      '<div class="wc-cockpit"></div>' +
      '<div class="wc-clock"><span class="t">T+</span><span class="v">00:00:00</span></div><div class="wc-title"></div><div class="wc-mode"></div>';
    center.prepend(this.timeline.el);
    this.cockpit = center.querySelector('.wc-cockpit')!;
    this.clock = center.querySelector('.wc-clock')!;
    this.title = center.querySelector('.wc-title')!;
    this.mode = center.querySelector('.wc-mode')!;
    this.root.append(this.booster.el, center, this.ship.el);
    parent.appendChild(this.root);
    this.caption = document.createElement('div');
    this.caption.id = 'wc-caption';
    parent.appendChild(this.caption);
  }

  /** The block for a stage (for the flight controls to dock into). */
  block(stage: StageId): VehicleBlock {
    return stage === 'booster' ? this.booster : this.ship;
  }

  /** The player is flying: open the cockpit in the middle (animated). */
  setPiloting(on: boolean): void {
    this.root.classList.toggle('piloting', on);
  }

  /** Who's flying, under the flight's name (e.g. "AUTOPILOT · L TO TAKE CONTROL"). */
  setMode(html: string): void {
    if (this.mode.innerHTML !== html) this.mode.innerHTML = html;
  }

  setShipName(name: string): void {
    this.ship.setTitle(name);
  }

  setMission(title: string): void {
    const text = `STARSHIP ${title.toUpperCase()}`;
    if (this.title.textContent !== text) this.title.textContent = text;
  }

  reset(): void {
    this.timeline.reset();
    this.wasStack = true;
    this.caption.classList.remove('show');
  }

  update(s: Snapshot): void {
    const tm = s.missionTime;
    const c = formatClock(tm);
    if (c !== this.lastClock) {
      this.lastClock = c;
      this.clock.innerHTML = `<span class="t">${c.slice(0, 2)}</span><span class="v">${c.slice(2)}</span>`;
    }
    const stack = s.vehicles.find((v) => v.id === 'stack');
    this.booster.update(stack ?? s.vehicles.find((v) => v.id === 'booster'));
    this.ship.update(stack ?? s.vehicles.find((v) => v.id === 'ship'));
    // Stage separation: the stack's two halves go their own ways.
    if (this.wasStack && !stack && s.vehicles.some((v) => v.id === 'booster')) {
      this.booster.separate();
      this.ship.separate();
    }
    this.wasStack = !!stack;
    this.timeline.update(s, tm);
  }

  private showCaption(text: string): void {
    this.caption.textContent = text;
    this.caption.classList.remove('show');
    void this.caption.offsetWidth;
    this.caption.classList.add('show');
    window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.caption.classList.remove('show'), 4200);
  }
}
