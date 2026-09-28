// Full-screen menus in the webcast style: the main menu (pick a mission, free roam, settings,
// controls, credits) over a slowly turning view of the pad, and the pause menu (Esc) over the
// frozen flight. One overlay: a column of big text items on the left, the chosen page beside it.

import { MISSIONS, type MissionId } from '../game/missions';
import { type Settings, WEATHER_AVAILABLE, onSettingsChange, settings, updateSettings } from '../settings';
import { loadBest } from './missionUi';

export type MenuKind = 'main' | 'pause';

const WEATHER_LABEL: Record<Settings['weather'], string> = { clear: 'Clear', partly: 'Partly', overcast: 'Overcast', rain: 'Rain', fog: 'Fog', natural: 'Random' };

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
        updateSettings({ weather: button.dataset.weather as Settings['weather'] });
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
        return;
      }
      const act = button?.dataset.act;
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

  private pageHtml(page: Page): string {
    switch (page) {
      case 'missions':
      case 'auto': {
        // Two pages: the hand-flown missions (you fly them, no autopilot) and the autopilot
        // flights (it flies the profile, you can take over).
        const best = loadBest();
        const list = MISSIONS.filter((x) => x.group === (page === 'missions' ? 'manual' : 'auto'));
        const m = list.find((x) => x.id === this.mission) ?? list[0];
        this.mission = m.id;
        const card = (x: (typeof list)[number]) =>
          `<div class="mn-card${x.id === m.id ? ' on' : ''}" data-mission="${x.id}"><span>${x.title}</span>` +
          `<em>${best[x.id] !== undefined ? `BEST ${best[x.id]}` : ''}</em></div>`;
        const cards = list.map(card).join('');
        const objectives = m.objectives.map((o) => `<li>${o.label}</li>`).join('');
        const midFlight = !!m.setup.start && m.setup.start !== 'pad';
        return (
          (page === 'missions'
            ? `<div class="mn-title">Missions<small>Hand-flown · you fly it, no autopilot</small></div>`
            : `<div class="mn-title">Autopilot<small>It flies the profile · <kbd>L</kbd> to take over</small></div>`) +
          `<div class="mn-missions"><div class="mn-list">${cards}</div>` +
          `<div class="mn-detail" data-key="${m.id}"><div class="mn-kind">${m.group === 'manual' ? 'Hand-flown' : 'Autopilot'}${m.setup.start && m.setup.start !== 'pad' ? ` · starts ${START_LABEL[m.setup.start]}` : ''}</div>` +
          `<div class="mn-dname">${m.title}</div><p>${m.brief}</p>` +
          (objectives ? `<div class="mn-label">Objectives</div><ul>${objectives}</ul>` : '') +
          (midFlight
            ? (m.setup.start === 'boosterLanding' ? this.padPicker() : '') +
              `<button class="mn-go" data-act="launch">Start mission <b>›</b></button>` +
              `<div class="mn-hint">Starts ${START_LABEL[m.setup.start!]}${m.group === 'manual' ? ', you at the controls' : ''}.</div></div></div>`
            : this.padPicker() +
              `<button class="mn-go" data-act="launch">Go to the pad <b>›</b></button>` +
              `<div class="mn-hint">Then press <kbd>Space</kbd> to start the countdown.</div></div></div>`)
        );
      }
      case 'free':
        return (
          `<div class="mn-title">Free Roam</div><div class="mn-detail solo">` +
          `<p>Starship stacked on the pad with nothing to score. Look around, work the tower arms, destack and restack, ` +
          `launch whenever you like with <kbd>Space</kbd>. You're at the controls from the start (manual). After staging you fly the ship; ` +
          `the booster flies itself home to the tower unless you take it over (<kbd>V</kbd> to switch to it, <kbd>L</kbd> for the controls).</p>` +
          this.padPicker() +
          `<button class="mn-go" data-act="free">Go to the pad <b>›</b></button></div>`
        );
      case 'settings':
        return (
          `<div class="mn-title">Settings</div><div class="mn-settings">` +
          `<div class="mn-row"><span>Full screen <kbd>F</kbd></span><button class="mn-toggle${document.fullscreenElement ? ' on' : ''}" data-act="fullscreen"><i></i></button></div>` +
          `<div class="mn-row"><span>Sound</span><button class="mn-toggle${settings.muted ? '' : ' on'}" data-act="sound"><i></i></button></div>` +
          (WEATHER_AVAILABLE ?
          `<div class="mn-row"><span>Clouds</span><button class="mn-toggle${settings.clouds ? ' on' : ''}" data-act="clouds"><i></i></button></div>` +
          `<div class="mn-row"><span>Starbase weather</span><div class="mn-seg">` +
          (['clear', 'partly', 'overcast', 'rain', 'fog', 'natural'] as const)
            .map((w) => `<button data-weather="${w}"${settings.weather === w ? ' class="on"' : ''}>${WEATHER_LABEL[w]}</button>`)
            .join('') +
          `</div></div>` : '') +
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
