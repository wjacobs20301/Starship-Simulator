// Full-screen menus in the webcast style: the main menu (pick a mission, free roam, settings,
// controls, credits) over a slowly turning view of the pad, and the pause menu (Esc) over the
// frozen flight. One overlay: a column of big text items on the left, the chosen page beside it.

import { MISSIONS, type MissionDef, type MissionId } from '../game/missions';
import { FREE_WEATHER, type FreeWeather, WEATHER_AVAILABLE, WEATHER_NAME, onSettingsChange, settings, updateSettings } from '../settings';
import { loadBest } from './missionUi';
import { formatT, missionTimeline } from '../game/timelines';

export type MenuKind = 'main' | 'pause';

/** Free roam's weather picks: name and what it brings. */
const WEATHER_PICK: Record<FreeWeather, [string, string]> = {
  starbase: ['Starbase', 'Whatever the day brings, as the climate on the Texas Gulf coast deals it out: mostly sunny with a few clouds, sometimes overcast, rain, sea fog or thunderstorms. A new day each time.'],
  clear: [WEATHER_NAME.clear, 'Blue sky, not a cloud over the coast.'],
  fair: [WEATHER_NAME.fair, 'Blue sky and sun, a few small cumulus drifting in off the Gulf.'],
  partly: [WEATHER_NAME.partly, 'A field of fair-weather cumulus, in clusters and streets.'],
  overcast: [WEATHER_NAME.overcast, 'A grey stratus deck from horizon to horizon.'],
  rain: [WEATHER_NAME.rain, 'A cold front coming through: low cloud and steady rain.'],
  storm: [WEATHER_NAME.storm, 'Storms building inland and drifting toward the coast: towering clouds, downpours, lightning and thunder.'],
  fog: [WEATHER_NAME.fog, 'Fog rolling in off the Gulf, the tower fading into it.'],
};

const START_LABEL: Record<string, string> = {
  separation: 'at stage separation',
  boosterLanding: 'on the way down to the landing',
  entry: 'at the edge of the atmosphere',
};
type Page = 'free' | 'missions' | 'auto' | 'settings' | 'controls' | 'credits' | 'none';

interface Item {
  label: string;
  /** Opens a page beside the list... */
  page?: Page;
  /** ...or does something right away. */
  act?: 'resume' | 'restart' | 'main' | 'fullscreen';
}

const ITEMS: Record<MenuKind, Item[]> = {
  main: [
    { label: 'Free Roam', page: 'free' },
    { label: 'Missions', page: 'missions' },
    { label: 'Autopilot', page: 'auto' },
    { label: 'Settings', page: 'settings' },
    { label: 'Controls', page: 'controls' },
    { label: 'Credits', page: 'credits' },
  ],
  pause: [
    { label: 'Resume', act: 'resume' },
    { label: 'Restart', act: 'restart' },
    { label: 'Full Screen', act: 'fullscreen' },
    { label: 'Settings', page: 'settings' },
    { label: 'Controls', page: 'controls' },
    { label: 'Main Menu', act: 'main' },
  ],
};

export interface MenuHandlers {
  /** Set up a mission on the chosen pad (0 = Pad 1); Space starts the countdown. */
  launch(id: MissionId, pad: number): void;
  /** On the chosen pad with no objectives; launch whenever. */
  freeRoam(pad: number): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  /** Main menu: show the next backdrop. */
  nextScene(): void;
  /**
   * Main menu backdrop: the picked pad seen from the ground, in free roam's weather (while the Free
   * Roam page is up), or null for the rotating backdrops.
   */
  backdrop(pad: number | null): void;
}

export class GameMenu {
  private root: HTMLElement;
  private nav: HTMLElement;
  private page: HTMLElement;
  private head: HTMLElement;
  private foot: HTMLElement;
  kind: MenuKind | null = null;
  private current: Page = 'none';
  private mission: MissionId = 'ift';
  /** Launch pad picked (0 = Pad 1, 1 = Pad 2). */
  pad = 0;
  /** Pause screen line under the title (mission and clock). */
  private status = '';

  constructor(
    parent: HTMLElement,
    private handlers: MenuHandlers,
    /** Controls and credits pages are built from the in-game help panel's content. */
    private help: HTMLElement,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.className = 'closed';
    this.root.innerHTML = `
      <div class="mn-side">
        <div class="mn-head"></div>
        <nav class="mn-nav"></nav>
        <div class="mn-foot"><button title="Next view">›</button><span></span></div>
      </div>
      <div class="mn-page"></div>`;
    parent.appendChild(this.root);
    this.head = this.root.querySelector('.mn-head')!;
    this.nav = this.root.querySelector('.mn-nav')!;
    this.page = this.root.querySelector('.mn-page')!;
    this.foot = this.root.querySelector('.mn-foot span')!;
    this.root.querySelector('.mn-foot button')!.addEventListener('click', () => handlers.nextScene());

    this.nav.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!b || !this.kind) return;
      const item = ITEMS[this.kind][Number(b.dataset.i)];
      if (item.page) this.show(item.page === this.current && this.kind === 'pause' ? 'none' : item.page);
      else if (item.act === 'resume') handlers.resume();
      else if (item.act === 'restart') handlers.restart();
      else if (item.act === 'main') handlers.mainMenu();
      else if (item.act === 'fullscreen') toggleFullscreen();
    });
    this.page.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('[data-mission]');
      if (card && !t.closest('button')) {
        this.mission = card.dataset.mission as MissionId;
        this.render();
      }
      const button = t.closest<HTMLElement>('button');
      if (button?.dataset.weather) {
        updateSettings({ freeWeather: button.dataset.weather as FreeWeather });
        if (this.current === 'free') this.render();
        return;
      }
      if (button?.dataset.res) {
        const r = button.dataset.res;
        updateSettings({ renderScale: r === 'auto' ? 'auto' : Number(r) });
        return;
      }
      if (button?.dataset.pad) {
        this.pad = Number(button.dataset.pad);
        this.render();
        if (this.kind === 'main' && this.current === 'free') handlers.backdrop(this.pad);
        return;
      }
      const act = button?.dataset.act;
      if (act === 'starlink') {
        updateSettings({ freeStarlink: !settings.freeStarlink });
        this.render();
        return;
      }
      if (act === 'faults' || act === 'tiles') {
        updateSettings(act === 'faults' ? { engineFailures: !settings.engineFailures } : { tileLoss: !settings.tileLoss });
        this.render();
        return;
      }
      if (act === 'launch') handlers.launch(this.mission, this.pad);
      else if (act === 'free') handlers.freeRoam(this.pad);
      else if (act === 'sound') updateSettings({ muted: !settings.muted });
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'clouds') updateSettings({ clouds: !settings.clouds });
    });
    this.page.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === 'serial') {
        const v = input.value.trim().toUpperCase().slice(0, 6);
        if (v) updateSettings({ shipSerial: v });
      }
    });
    onSettingsChange(() => {
      if (this.current === 'settings') this.render();
    });
    document.addEventListener('fullscreenchange', () => {
      if (this.current === 'settings') this.render();
      if (this.kind) this.nav.querySelectorAll<HTMLElement>('[data-i]').forEach((b) => {
        if (b.textContent?.startsWith('Full') || b.textContent?.startsWith('Exit')) b.textContent = fullscreenLabel();
      });
    });
  }

  /** Caption for the backdrop, bottom left (main menu). */
  setCaption(text: string): void {
    this.foot.classList.remove('in');
    void this.foot.offsetWidth;
    this.foot.textContent = text;
    this.foot.classList.add('in');
  }

  get isOpen(): boolean {
    return this.kind !== null;
  }

  open(kind: MenuKind, opts: { mission?: MissionId; status?: string } = {}): void {
    this.kind = kind;
    if (opts.mission) this.mission = opts.mission === 'free' ? 'ift' : opts.mission;
    this.status = opts.status ?? '';
    this.root.className = kind;
    document.body.classList.add('menu-open');
    this.head.innerHTML =
      kind === 'main'
        ? '<div class="mn-word">STARSHIP</div><div class="mn-sub">FLIGHT SIMULATOR</div>'
        : `<div class="mn-word">PAUSED</div><div class="mn-sub">${this.status}</div>`;
    this.nav.innerHTML = ITEMS[kind]
      .map((it, i) => `<button data-i="${i}" style="animation-delay:${80 + i * 55}ms">${it.act === 'fullscreen' ? fullscreenLabel() : it.label}</button>`)
      .join('');
    this.show(kind === 'main' ? 'free' : 'none');
  }

  close(): void {
    this.kind = null;
    this.root.className = 'closed';
    document.body.classList.remove('menu-open');
  }

  /** Esc inside the menu: back out of a page, or (paused) resume. */
  back(): void {
    if (this.kind === 'pause') {
      if (this.current !== 'none') this.show('none');
      else this.handlers.resume();
    } else if (this.kind === 'main' && this.current !== 'free') this.show('free');
  }

  private show(page: Page): void {
    this.current = page;
    if (this.kind === 'main') this.handlers.backdrop(page === 'free' ? this.pad : null);
    if (this.kind) {
      ITEMS[this.kind].forEach((it, i) => this.nav.children[i]?.classList.toggle('on', it.page === page));
    }
    this.render();
    // Re-run the page's entrance.
    this.page.classList.remove('enter');
    void this.page.offsetWidth;
    this.page.classList.add('enter');
  }

  private render(): void {
    this.page.innerHTML = this.pageHtml(this.current);
  }

  private padPicker(): string {
    const b = (n: number) => `<button data-pad="${n}"${this.pad === n ? ' class="on"' : ''}>Pad ${n + 1}</button>`;
    return `<div class="mn-pads"><div class="mn-label">Launch pad</div><div class="mn-seg">${b(0)}${b(1)}</div></div>`;
  }

  /**
   * What can go wrong: Raptors failing (an engine out, one that won't relight) and heat shield
   * tiles shaking loose. A replay has its own engine failures, as they happened.
   */
  private realism(m?: MissionDef): string {
    const row = (act: string, label: string, on: boolean, hint: string) =>
      `<div class="mn-row"><span>${label}<small>${hint}</small></span><button class="mn-toggle${on ? ' on' : ''}" data-act="${act}"><i></i></button></div>`;
    return (
      `<div class="mn-real"><div class="mn-label">What can go wrong</div>` +
      (m?.setup.faults
        ? `<div class="mn-hint">Engine failures as on the real flight</div>`
        : row('faults', 'Engine failures', settings.engineFailures, 'An engine out on the way up, one that won\'t relight')) +
      row('tiles', 'Heat shield tile loss', settings.tileLoss, 'Tiles shaken loose; the gaps run hot in the entry') +
      `</div>`
    );
  }

  /** Free roam's weather over Starbase (as the climate deals it out, or one picked). */
  private weatherPicker(): string {
    if (!WEATHER_AVAILABLE || !settings.clouds) return '';
    const w = settings.freeWeather;
    const b = (x: FreeWeather) => `<button data-weather="${x}"${w === x ? ' class="on"' : ''}>${WEATHER_PICK[x][0]}</button>`;
    return `<div class="mn-wx"><div class="mn-label">Weather</div><div class="mn-wx-grid">${FREE_WEATHER.map(b).join('')}</div>` +
      `<div class="mn-wx-note">${WEATHER_PICK[w][1]}</div></div>`;
  }

  private pageHtml(page: Page): string {
    switch (page) {
      case 'missions':
      case 'auto': {
        // Two pages: the hand-flown missions (you fly them, no autopilot) and the autopilot
        // flights (it flies the profile, you can take over). Three columns: the list, the
        // mission, and its flight plan with what's needed to start it.
        const best = loadBest();
        const list = MISSIONS.filter((x) => x.group === (page === 'missions' ? 'manual' : 'auto'));
        const m = list.find((x) => x.id === this.mission) ?? list[0];
        this.mission = m.id;
        const card = (x: (typeof list)[number]) =>
          `<div class="mn-card${x.id === m.id ? ' on' : ''}" data-mission="${x.id}"><span>${x.title}</span>` +
          `<em>${best[x.id] !== undefined ? `BEST ${best[x.id]}` : ''}</em></div>`;
        const objectives = m.objectives.map((o) => `<li>${o.label}</li>`).join('');
        const midFlight = !!m.setup.start && m.setup.start !== 'pad';
        const lead = m.summary ?? m.brief;
        const detail =
          `<div class="mn-detail" data-key="${m.id}">` +
          `<div class="mn-kind">${m.group === 'manual' ? 'Hand-flown' : 'Autopilot'}${midFlight ? ` · starts ${START_LABEL[m.setup.start!]}` : ''}</div>` +
          `<div class="mn-dname">${m.title}</div>` +
          `<div class="mn-facts">${missionFacts(m).map((f) => `<span>${f}</span>`).join('')}</div>` +
          `<p>${lead}</p>` +
          (m.summary ? `<details class="mn-more"><summary>About this flight</summary><p>${m.brief}</p></details>` : '') +
          (objectives ? `<div class="mn-label">Objectives</div><ul class="mn-obj">${objectives}</ul>` : '') +
          (midFlight ? '' : this.realism(m)) +
          `</div>`;
        const plan = missionTimeline(m.id);
        const start =
          midFlight
            ? (m.setup.start === 'boosterLanding' ? this.padPicker() : '') +
              `<button class="mn-go" data-act="launch">Start mission <b>›</b></button>` +
              `<div class="mn-hint">Starts ${START_LABEL[m.setup.start!]}${m.group === 'manual' ? ', you at the controls' : ''}.</div>`
            : (m.setup.pad !== undefined ? `<div class="mn-pads"><div class="mn-label">Launch pad</div><div class="mn-fixed">Pad ${m.setup.pad + 1}, as the real flight</div></div>` : this.padPicker()) +
              `<button class="mn-go" data-act="launch">Go to the pad <b>›</b></button>` +
              `<div class="mn-hint">Then <kbd>Space</kbd> starts the countdown.</div>`;
        return (
          (page === 'missions'
            ? `<div class="mn-title">Missions<small>Hand-flown · you fly it, no autopilot</small></div>`
            : `<div class="mn-title">Autopilot<small>It flies the profile · <kbd>L</kbd> to take over</small></div>`) +
          `<div class="mn-missions"><div class="mn-list">${list.map(card).join('')}</div>${detail}` +
          `<div class="mn-aside"><div class="mn-label">Flight plan</div><ol class="mn-plan">` +
          plan.map((x) => `<li><b>T+${formatT(x.at)}</b><span>${x.label}</span></li>`).join('') +
          `</ol><div class="mn-launch">${start}</div></div></div>`
        );
      }
      case 'free':
        return (
          `<div class="mn-title">Free Roam<small>No objectives · launch whenever you like</small></div><div class="mn-free">` +
          `<p>Starship stacked on the pad, nothing to score. Look around, work the tower arms, launch with <kbd>Space</kbd> when you like. ` +
          `You fly from the start; after staging the booster flies itself home unless you take it over (<kbd>V</kbd>, then <kbd>L</kbd>).</p>` +
          this.padPicker() +
          this.weatherPicker() +
          `<div class="mn-real"><div class="mn-label">Payload</div>` +
          `<div class="mn-row"><span>Starlink V3 satellites<small>26 in the bay: <kbd>B</kbd> above 120 km to deploy, again to hold</small></span>` +
          `<button class="mn-toggle${settings.freeStarlink ? ' on' : ''}" data-act="starlink"><i></i></button></div></div>` +
          this.realism() +
          `<div class="mn-foot2"><button class="mn-go" data-act="free">Go to the pad <b>›</b></button></div></div>`
        );
      case 'settings':
        return (
          `<div class="mn-title">Settings</div><div class="mn-settings">` +
          `<div class="mn-row"><span>Full screen <kbd>F</kbd></span><button class="mn-toggle${document.fullscreenElement ? ' on' : ''}" data-act="fullscreen"><i></i></button></div>` +
          `<div class="mn-row"><span>Sound</span><button class="mn-toggle${settings.muted ? '' : ' on'}" data-act="sound"><i></i></button></div>` +
          (WEATHER_AVAILABLE ?
          `<div class="mn-row"><span>Clouds and weather</span><button class="mn-toggle${settings.clouds ? ' on' : ''}" data-act="clouds"><i></i></button></div>` : '') +
          `<div class="mn-row"><span>Resolution</span><div class="mn-seg">` +
          ([1, 0.75, 0.5, 'auto'] as const)
            .map((r) => `<button data-res="${r}"${settings.renderScale === r ? ' class="on"' : ''}>${r === 'auto' ? 'Auto' : r === 1 ? 'Full' : `${r * 100}%`}</button>`)
            .join('') +
          `</div></div>` +
          `<div class="mn-note">Full looks best. Lower settings (or Auto, which drops the resolution only when frames are missed) run smoother on slower machines.</div>` +
          `<div class="mn-row"><span>Ship serial</span><input name="serial" maxlength="6" value="${settings.shipSerial}" spellcheck="false" /></div>` +
          `</div>`
        );
      case 'controls': {
        const clone = this.help.cloneNode(true) as HTMLElement;
        clone.querySelector('.credits')?.remove();
        return `<div class="mn-title">Controls</div><div class="mn-controls">${clone.innerHTML}</div>`;
      }
      case 'credits':
        return `<div class="mn-title">Credits</div><div class="mn-credits">${this.help.querySelector('.credits')?.innerHTML ?? ''}</div>`;
      default:
        return '';
    }
  }
}

/** The mission at a glance: where from, what it carries, how long, how each stage comes home. */
function missionFacts(m: MissionDef): string[] {
  const f: string[] = [];
  const st = m.setup;
  if (st.start === 'separation') f.push('From stage separation');
  else if (st.start === 'boosterLanding') f.push('From 20 km up');
  else if (st.start === 'entry') f.push('From entry interface');
  else f.push(st.pad !== undefined ? `Pad ${st.pad + 1}` : 'Pad 1 or 2');
  if (st.fly) f.push(`You fly the ${st.fly === 'stack' ? 'stack' : st.fly === 'booster' ? 'booster' : 'ship'}`);
  if (st.payload === 'starlink') f.push('26 Starlink V3');
  const plan = missionTimeline(m.id);
  const span = plan.length > 1 ? plan[plan.length - 1].at - Math.max(0, plan[0].at) : 0;
  if (span > 0) f.push(span >= 3600 ? `≈ ${Math.floor(span / 3600)} h ${Math.round((span % 3600) / 60)} min` : `≈ ${Math.max(1, Math.round(span / 60))} min`);
  const labels = plan.map((x) => x.label);
  if (labels.includes('BOOSTER CATCH')) f.push('Booster: tower catch');
  else if (labels.includes('BOOSTER SPLASHDOWN')) f.push('Booster: Gulf splashdown');
  if (labels.includes('SHIP CATCH')) f.push('Ship: tower catch');
  else if (labels.includes('SPLASHDOWN')) f.push(m.id === 'flight14' ? 'Ship: Pacific splashdown' : 'Ship: ocean splashdown');
  if (st.faults) f.push('Real engine failures');
  return f;
}

/** Full screen on / off (the whole page, so the HUD and menus come along). */
export function toggleFullscreen(): void {
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || doc.webkitFullscreenElement) {
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
  else el.webkitRequestFullscreen?.();
}

function fullscreenLabel(): string {
  return document.fullscreenElement ? 'Exit Full Screen' : 'Full Screen';
}
