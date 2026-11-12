// Full-screen menus in the webcast style: the main menu (pick a mission, free roam, settings,
// controls, credits) over a slowly turning view of the pad, and the pause menu (Esc) over the
// frozen flight. One overlay: a column of big text items on the left, the chosen page beside it.

import { MISSIONS, type MissionDef, type MissionId } from '../game/missions';
import { MAX_MANUAL, NAME_MAX, type SaveEntry, latestSave, manualTarget } from '../game/savedFlight';
import { FREE_WEATHER, type FreeWeather, WEATHER_AVAILABLE, WEATHER_NAME, onSettingsChange, settings, updateSettings } from '../settings';
import { loadBest } from './missionUi';
import { formatT, missionTimeline } from '../game/timelines';
import { captureKey } from './input';
import { FIXED_KEYS, KEY_ACTIONS, KEY_GROUPS, type KeyAction, type KeyDef, type KeyLoss, bind, isChanged, keyLabel, keysOf, resetKey, whyNot } from './keys';
import { escapeHtml, kbd, paintKeys, withKeys } from './keyLabels';

export type MenuKind = 'main' | 'pause';

/** Free roam's weather picks: name and what it brings. */
const WEATHER_PICK: Record<FreeWeather, [string, string]> = {
  starbase: ['Starbase', 'Whatever the day brings, as the climate on the Texas Gulf coast deals it out: mostly sunny with a few clouds, sometimes overcast, rain, sea fog or thunderstorms. A new day each time.'],
  clear: [WEATHER_NAME.clear, 'Blue sky, hardly a cloud over the coast.'],
  fair: [WEATHER_NAME.fair, 'Blue sky and sun, a few small cumulus drifting in off the Gulf: a quarter of the sky at most.'],
  partly: [WEATHER_NAME.partly, 'A field of fair-weather cumulus, in clusters and streets: about half the sky.'],
  mostly: [WEATHER_NAME.mostly, 'A broken deck of stratocumulus and cumulus over most of the sky, lanes of blue between.'],
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
type Page = 'free' | 'missions' | 'auto' | 'settings' | 'controls' | 'credits' | 'saves' | 'save' | 'none';

/** A saved flight as the menus show it: the save, its flight clock and when it was made, in words. */
export interface SaveRow extends SaveEntry {
  clock: string;
  when: string;
}

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
    { label: 'Save Flight', page: 'save' },
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
  /** The saved flights, newest first (game/savedFlight.ts). */
  saves(): SaveRow[];
  /** Take a saved flight up again where it was left. */
  continueFlight(id: string): void;
  deleteSave(id: string): void;
  /** Why the flight can't be saved now (null: it can). */
  canSave(): string | null;
  /** Save the flight as one of the player's, named, in place of `replace` (or where manualTarget puts it). Says how it went itself. */
  saveFlight(name: string, replace: string | null): void;
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
  /** Controls page: the action waiting for its new key (the next key pressed: input.ts hands it over), and how to call that off. */
  private rebinding: KeyAction | null = null;
  private cancelCapture: (() => void) | null = null;
  /** Controls page: what the last change did to another action, or why a key wasn't taken. */
  private keyNote = '';

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
      if ((e.target as HTMLElement).closest('[data-continue]')) {
        this.disarm();
        return this.show('saves');
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!b || !this.kind) return;
      const item = ITEMS[this.kind][Number(b.dataset.i)];
      // (Restart and Main Menu end the flight: a second press, within a few seconds, does it.)
      if ((item.act === 'restart' || item.act === 'main') && this.armed?.button !== b) {
        this.disarm();
        const timer = window.setTimeout(() => this.disarm(), 4000);
        this.armed = { button: b, label: b.textContent ?? '', timer };
        b.textContent = item.act === 'restart' ? 'Restart: sure?' : 'Leave flight: sure?';
        b.classList.add('arm');
        return;
      }
      this.disarm();
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
      // The saved flights. Deleting one, or saving over one, takes a second press.
      if (button?.dataset.load) {
        handlers.continueFlight(button.dataset.load);
        return;
      }
      const twice = button?.dataset.del ? `del:${button.dataset.del}` : button?.dataset.over ? `over:${button.dataset.over}` : null;
      if (twice) {
        if (this.pageArmed?.key !== twice) return this.armPage(twice);
        this.disarmPage();
        if (button!.dataset.del) handlers.deleteSave(button!.dataset.del);
        else {
          handlers.saveFlight(this.saveName, button!.dataset.over!);
          this.saveName = '';
        }
        this.savesChanged();
        return;
      }
      if (button?.dataset.act === 'save') return this.saveNow();
      // The keys (Controls). Waiting for one and something else is clicked: that's called off.
      const rebind = button?.dataset.rebind as KeyAction | undefined;
      if (this.rebinding && rebind !== this.rebinding) {
        this.endRebind();
        this.render();
      }
      if (rebind) {
        // (Its own button again: never mind.)
        if (this.rebinding === rebind) this.endRebind();
        else this.startRebind(rebind);
        this.render();
        return;
      }
      if (button?.dataset.keyreset) {
        const which = button.dataset.keyreset;
        if (which === 'all') {
          this.keyNote = '';
          updateSettings({ keys: {} });
        } else {
          const change = resetKey(settings.keys, which as KeyAction);
          this.keyNote = lossNote(change.lost);
          // (This button goes with the change: the focus to the key beside it.)
          this.page.querySelector<HTMLElement>(`[data-rebind="${which}"]`)?.focus({ preventScroll: true });
          updateSettings({ keys: change.keys });
        }
        this.render();
        return;
      }
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
      if (button?.dataset.ui) {
        updateSettings({ uiScale: Number(button.dataset.ui) });
        return;
      }
      if (button?.dataset.detail) {
        updateSettings({ detail: button.dataset.detail as 'high' | 'medium' | 'low' });
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
    // (Waiting for a key, and a click anywhere else in the menu: called off too.)
    this.root.addEventListener('click', (e) => {
      // (By the click's path, not where its target is now: a click on the page rebuilds it, and
      // the button clicked is no longer in it by the time the click gets here.)
      if (!this.rebinding || e.composedPath().includes(this.page)) return;
      this.endRebind();
      this.render();
    });
    // (The name of a save being made: kept as it's typed, as the page may be rebuilt meanwhile.
    // Enter saves.)
    this.page.addEventListener('keydown', (e) => {
      if ((e.target as HTMLInputElement).name === 'savename' && e.key === 'Enter') this.saveNow();
    });
    this.page.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === 'serial') {
        const v = input.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 6);
        if (v) updateSettings({ shipSerial: v });
      }
    });
    // (The sliders: as they're dragged.)
    this.page.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === 'savename') this.saveName = input.value;
      if (input.name === 'volume') updateSettings({ volume: Number(input.value) / 100, muted: Number(input.value) === 0 });
      else if (input.name === 'camera') updateSettings({ cameraSpeed: Number(input.value) / 100 });
      const out = input.parentElement?.querySelector('output');
      if (out && input.type === 'range') out.textContent = `${input.value}%`;
    });
    onSettingsChange(() => {
      // (Not under a slider being dragged: rebuilding the page would let go of it.)
      if ((this.current === 'settings' || this.current === 'controls') && (document.activeElement as HTMLInputElement | null)?.type !== 'range') this.render();
    });
    document.addEventListener('fullscreenchange', () => {
      if (this.current === 'settings') this.render();
      if (this.kind) this.nav.querySelectorAll<HTMLElement>('[data-i]').forEach((b) => {
        if (b.textContent?.startsWith('Full') || b.textContent?.startsWith('Exit')) b.textContent = fullscreenLabel();
      });
    });
  }

  /** A pause-menu item pressed once that ends the flight, waiting for the second press. */
  private armed: { button: HTMLElement; label: string; timer: number } | null = null;
  private disarm(): void {
    if (!this.armed) return;
    clearTimeout(this.armed.timer);
    this.armed.button.textContent = this.armed.label;
    this.armed.button.classList.remove('arm');
    this.armed = null;
  }

  /** A saved flight's Delete or Save over pressed once, waiting for the second press (as Restart does). */
  private pageArmed: { key: string; timer: number } | null = null;
  private armPage(key: string): void {
    this.disarmPage();
    const timer = window.setTimeout(() => {
      this.pageArmed = null;
      this.render();
    }, 4000);
    this.pageArmed = { key, timer };
    this.render();
  }
  private disarmPage(): void {
    if (!this.pageArmed) return;
    clearTimeout(this.pageArmed.timer);
    this.pageArmed = null;
  }

  /** Save flight: the name typed so far. */
  private saveName = '';
  private saveNow(): void {
    if (this.handlers.canSave() !== null) return;
    this.disarmPage();
    this.handlers.saveFlight(this.saveName, null);
    this.saveName = '';
    this.render();
  }

  /**
   * The saved flights changed (one written, deleted, found unusable): the main menu's Continue and
   * a page listing them are brought up to date.
   */
  savesChanged(): void {
    if (!this.kind) return;
    if (this.kind === 'main') {
      const html = this.continueHtml();
      const old = this.nav.querySelector('[data-continue]');
      if (!old) {
        if (html) this.nav.insertAdjacentHTML('afterbegin', html);
      } else if (!html) old.remove();
      else if (old.outerHTML !== html) old.outerHTML = html;
      this.nav.querySelector('[data-continue]')?.classList.toggle('on', this.current === 'saves');
    }
    if (this.current === 'saves' || this.current === 'save') this.render();
  }

  /** Main menu: Continue, first, when there's a flight to continue (it shows the newest; it opens the list of them all). */
  private continueHtml(): string {
    const latest = latestSave(this.handlers.saves());
    return latest ? `<button data-continue class="mn-continue">Continue<small>${escapeHtml(latest.title)} · ${latest.clock}</small></button>` : '';
  }

  /** Controls: the next key pressed is this action's (Esc: leave it as it was). */
  private startRebind(action: KeyAction): void {
    this.endRebind();
    this.rebinding = action;
    this.keyNote = '';
    this.cancelCapture = captureKey((key) => {
      const why = key === null ? null : whyNot(key, action);
      if (why) {
        // (Not a key it can have: say so, and go on waiting.)
        this.keyNote = `${why}.`;
        this.render();
        return false;
      }
      this.endRebind();
      if (key !== null) {
        const change = bind(settings.keys, action, key);
        this.keyNote = lossNote(change.lost);
        updateSettings({ keys: change.keys });
      }
      this.render();
      return true;
    });
  }

  private endRebind(): void {
    this.cancelCapture?.();
    this.cancelCapture = null;
    this.rebinding = null;
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

  open(kind: MenuKind, opts: { mission?: MissionId; status?: string; page?: 'saves' } = {}): void {
    this.disarm();
    this.disarmPage();
    this.keyNote = '';
    this.kind = kind;
    if (opts.mission) this.mission = opts.mission === 'free' ? 'ift' : opts.mission;
    this.status = opts.status ?? '';
    this.root.className = kind;
    document.body.classList.add('menu-open');
    this.head.innerHTML =
      kind === 'main'
        ? '<div class="mn-word">STARSHIP</div><div class="mn-sub">FLIGHT SIMULATOR</div>'
        : `<div class="mn-word">PAUSED</div><div class="mn-sub">${this.status}</div>`;
    // (A flight kept from last time: first in the main menu.)
    this.nav.innerHTML = (kind === 'main' ? this.continueHtml() : '') + ITEMS[kind]
      .map((it, i) => `<button data-i="${i}" style="animation-delay:${80 + i * 55}ms">${it.act === 'fullscreen' ? fullscreenLabel() : it.label}</button>`)
      .join('');
    this.show(kind === 'main' ? (opts.page ?? 'free') : 'none');
  }

  close(): void {
    this.disarm();
    this.disarmPage();
    this.endRebind();
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
    this.endRebind();
    this.disarmPage();
    if (page !== this.current) this.keyNote = '';
    this.current = page;
    if (this.kind === 'main') this.handlers.backdrop(page === 'free' ? this.pad : null);
    if (this.kind) {
      ITEMS[this.kind].forEach((it, i) => this.nav.querySelector(`[data-i="${i}"]`)?.classList.toggle('on', it.page === page));
      this.nav.querySelector('[data-continue]')?.classList.toggle('on', page === 'saves');
    }
    this.render();
    // (The list of saves: the newest ready to continue, so Continue then Enter takes it up.)
    if (page === 'saves') this.page.querySelector<HTMLElement>('.mn-save-go.first')?.focus({ preventScroll: true });
    // Re-run the page's entrance.
    this.page.classList.remove('enter');
    void this.page.offsetWidth;
    this.page.classList.add('enter');
  }

  private render(): void {
    // (The page is rebuilt whole: put the keyboard's focus back on what had it.)
    const had = document.activeElement instanceof HTMLElement && this.page.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    this.page.innerHTML = this.pageHtml(this.current);
    if (had) this.page.querySelector<HTMLElement>(had)?.focus({ preventScroll: true });
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

  /** One saved flight in a list: what it is, when, and its buttons. */
  private saveRow(r: SaveRow, buttons: string): string {
    const name = r.name ? ` · ${escapeHtml(r.name)}` : '';
    const facts = [r.auto ? 'Autosave' : '', r.clock, r.when, r.finished ? 'Mission over' : ''].filter(Boolean).join(' · ');
    return (
      `<div class="mn-save${r.problem ? ' bad' : ''}"><div class="mn-save-text"><span>${escapeHtml(r.title)}${name}</span><small>${facts}</small>` +
      (r.problem ? `<small class="mn-save-why">Can’t be continued: ${escapeHtml(r.problem)}</small>` : '') +
      `</div><div class="mn-save-acts">${buttons}</div></div>`
    );
  }

  /** A button that takes a second press (Delete, Save over), as it stands. */
  private twiceButton(data: 'del' | 'over', id: string, label: string, armedLabel: string): string {
    const armed = this.pageArmed?.key === `${data}:${id}`;
    return `<button data-${data}="${escapeHtml(id)}"${armed ? ' class="arm"' : ''}>${armed ? armedLabel : label}</button>`;
  }

  /** Main menu, Continue: every saved flight, newest first, to continue or delete. */
  private savesPage(): string {
    const rows = this.handlers.saves();
    const latest = latestSave(rows);
    const list = rows
      .map((r) =>
        this.saveRow(
          r,
          (r.problem ? '' : `<button class="mn-save-go${r === latest ? ' first' : ''}" data-load="${escapeHtml(r.id)}">Continue <b>›</b></button>`) +
            this.twiceButton('del', r.id, 'Delete', 'Delete: sure?'),
        ),
      )
      .join('');
    return (
      `<div class="mn-title">Saved flights<small>Newest first · kept in this browser</small></div><div class="mn-saves">` +
      (list || '<div class="mn-note">No saved flights.</div>') +
      `<div class="mn-hint">The autosave is the flight you were flying last: it’s kept up to date every 20 seconds while you fly. ` +
      `Save your own from the pause menu, up to ${MAX_MANUAL}.</div></div>`
    );
  }

  /** Pause menu, Save Flight: a name and Save, and the player's saves to save over or delete. */
  private savePage(): string {
    const rows = this.handlers.saves();
    const mine = rows.filter((r) => !r.auto);
    const cant = this.handlers.canSave();
    const target = manualTarget(rows);
    const label = (r: SaveRow) => `${escapeHtml(r.name || r.title)} (${r.when})`;
    const make = cant
      ? `<div class="mn-note">${escapeHtml(cant)}</div>`
      : `<div class="mn-save-new"><input name="savename" maxlength="${NAME_MAX}" placeholder="Name (if you like)" value="${escapeHtml(this.saveName)}" spellcheck="false" autocomplete="off" />` +
        `<button class="mn-go" data-act="save">${target.replaces ? 'Save over the oldest' : 'Save'} <b>›</b></button></div>` +
        (target.replaces ? `<div class="mn-hint mn-save-full">All ${MAX_MANUAL} places are taken: this replaces the oldest, ${label(target.replaces)}. Or save over another below.</div>` : '');
    const list = mine
      .map((r) => this.saveRow(r, (cant ? '' : this.twiceButton('over', r.id, 'Save over', 'Save over: sure?')) + this.twiceButton('del', r.id, 'Delete', 'Delete: sure?')))
      .join('');
    return (
      `<div class="mn-title">Save flight<small>Kept in this browser · ${mine.length} of ${MAX_MANUAL} places used</small></div><div class="mn-saves">` +
      make +
      `<div class="mn-label">Your saves</div>${list || '<div class="mn-note">None yet.</div>'}` +
      `<div class="mn-hint">The autosave is kept besides these: the flight is written to it every 20 seconds while you fly.</div></div>`
    );
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
          `<div class="mn-card${x.id === m.id ? ' on' : ''}" data-mission="${x.id}" tabindex="0" role="button"><span>${x.title}</span>` +
          `<em>${best[x.id] !== undefined ? `BEST ${best[x.id]}` : ''}</em></div>`;
        const objectives = m.objectives.map((o) => `<li>${o.label}</li>`).join('');
        const midFlight = !!m.setup.start && m.setup.start !== 'pad';
        const lead = withKeys(m.summary ?? m.brief);
        const detail =
          `<div class="mn-detail" data-key="${m.id}">` +
          `<div class="mn-kind">${m.group === 'manual' ? 'Hand-flown' : 'Autopilot'}${midFlight ? ` · starts ${START_LABEL[m.setup.start!]}` : ''}</div>` +
          `<div class="mn-dname">${m.title}</div>` +
          `<div class="mn-facts">${missionFacts(m).map((f) => `<span>${f}</span>`).join('')}</div>` +
          `<p>${lead}</p>` +
          (m.summary ? `<details class="mn-more"><summary>About this flight</summary><p>${withKeys(m.brief)}</p></details>` : '') +
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
              `<div class="mn-hint">Then ${kbd('launch')} starts the countdown.</div>`;
        return (
          (page === 'missions'
            ? `<div class="mn-title">Missions<small>Hand-flown · you fly it, no autopilot</small></div>`
            : `<div class="mn-title">Autopilot<small>It flies the profile · ${kbd('manual')} to take over</small></div>`) +
          `<div class="mn-missions"><div class="mn-list">${list.map(card).join('')}</div>${detail}` +
          `<div class="mn-aside"><div class="mn-label">Flight plan</div><ol class="mn-plan">` +
          plan.map((x) => `<li><b>T+${formatT(x.at)}</b><span>${x.label}</span></li>`).join('') +
          `</ol><div class="mn-launch">${start}</div></div></div>`
        );
      }
      case 'free':
        return (
          `<div class="mn-title">Free Roam<small>No objectives · launch whenever you like</small></div><div class="mn-free">` +
          `<p>Starship stacked on the pad, nothing to score. Look around, work the tower arms, launch with ${kbd('launch')} when you like. ` +
          `You fly from the start; after staging the booster flies itself home unless you take it over (${kbd('vehicle')}, then ${kbd('manual')}).</p>` +
          this.padPicker() +
          this.weatherPicker() +
          `<div class="mn-real"><div class="mn-label">Payload</div>` +
          `<div class="mn-row"><span>Starlink V3 satellites<small>26 in the bay: ${kbd('deploy')} above 120 km to deploy, again to hold</small></span>` +
          `<button class="mn-toggle${settings.freeStarlink ? ' on' : ''}" data-act="starlink"><i></i></button></div></div>` +
          this.realism() +
          `<div class="mn-foot2"><button class="mn-go" data-act="free">Go to the pad <b>›</b></button></div></div>`
        );
      case 'settings':
        return (
          `<div class="mn-title">Settings</div><div class="mn-settings">` +
          `<div class="mn-row"><span>Full screen ${kbd('fullscreen')}</span><button class="mn-toggle${document.fullscreenElement ? ' on' : ''}" data-act="fullscreen"><i></i></button></div>` +
          `<div class="mn-row"><span>Sound ${kbd('mute')}</span><button class="mn-toggle${settings.muted ? '' : ' on'}" data-act="sound"><i></i></button></div>` +
          `<div class="mn-row"><span>Volume</span><span class="mn-slide"><input type="range" name="volume" min="0" max="100" step="5" value="${Math.round(settings.volume * 100)}" /><output>${Math.round(settings.volume * 100)}%</output></span></div>` +
          (WEATHER_AVAILABLE ?
          `<div class="mn-row"><span>Clouds and weather</span><button class="mn-toggle${settings.clouds ? ' on' : ''}" data-act="clouds"><i></i></button></div>` : '') +
          `<div class="mn-row"><span>Resolution</span><div class="mn-seg">` +
          ([1, 0.75, 0.5, 'auto'] as const)
            .map((r) => `<button data-res="${r}"${settings.renderScale === r ? ' class="on"' : ''}>${r === 'auto' ? 'Auto' : r === 1 ? 'Full' : `${r * 100}%`}</button>`)
            .join('') +
          `</div></div>` +
          `<div class="mn-note">Full looks best. Lower settings (or Auto, which drops the resolution only when frames are missed) run smoother on slower machines.</div>` +
          `<div class="mn-row"><span>Graphics detail</span><div class="mn-seg">` +
          (['high', 'medium', 'low'] as const).map((d) => `<button data-detail="${d}"${settings.detail === d ? ' class="on"' : ''}>${d}</button>`).join('') +
          `</div></div>` +
          `<div class="mn-note">Medium draws coarser clouds and shadows; Low also drops the shadows and the glow round bright things.</div>` +
          `<div class="mn-row"><span>Display size</span><div class="mn-seg">` +
          ([[1, 'Normal'], [1.15, 'Large'], [1.3, 'Larger']] as const).map(([u, n]) => `<button data-ui="${u}"${settings.uiScale === u ? ' class="on"' : ''}>${n}</button>`).join('') +
          `</div></div>` +
          `<div class="mn-row"><span>Camera speed</span><span class="mn-slide"><input type="range" name="camera" min="25" max="300" step="5" value="${Math.round(settings.cameraSpeed * 100)}" /><output>${Math.round(settings.cameraSpeed * 100)}%</output></span></div>` +
          `<div class="mn-row"><span>Ship serial</span><input name="serial" maxlength="6" value="${settings.shipSerial.replace(/[^A-Za-z0-9 -]/g, '')}" spellcheck="false" /></div>` +
          `</div>`
        );
      case 'controls': {
        // The keyboard: every action with the key it's on. The key is a button: press it, then
        // the key it should be (Esc leaves it); ↺ puts a changed one back. Then what's fixed, and
        // the rest of the help panel (the controller, the tower's keys) as it stands.
        const keys = settings.keys;
        const cap = (k: string) => `<kbd>${escapeHtml(keyLabel(k, true))}</kbd>`;
        const row = (d: KeyDef) => {
          const on = keysOf(d.id, keys);
          const waiting = this.rebinding === d.id;
          const changed = isChanged(d.id, keys);
          return (
            `<div class="mn-key${changed ? ' changed' : ''}${on.length ? '' : ' unbound'}"><span>${d.label}</span>` +
            `<button class="mn-keycap${waiting ? ' wait' : ''}" data-rebind="${d.id}" title="Change this key">` +
            `${waiting ? 'Press a key…' : on.length ? on.map(cap).join('') : 'No key'}</button>` +
            `<button class="mn-key-reset" data-keyreset="${d.id}" title="Back to ${escapeHtml(d.keys.map((k) => keyLabel(k, true)).join(' / '))}"${changed ? '' : ' hidden'}>↺</button></div>`
          );
        };
        const group = (g: (typeof KEY_GROUPS)[number]) =>
          `<div class="mn-keys-group"><div class="mn-label">${g}</div>${KEY_ACTIONS.filter((d) => d.group === g).map(row).join('')}</div>`;
        const clone = this.help.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.credits, .kb').forEach((el) => el.remove());
        paintKeys(clone);
        return (
          `<div class="mn-title">Controls<small>Press a key’s button, then the key it should be · Esc leaves it as it was</small></div>` +
          `<div class="mn-keys-head"><div class="mn-label">Keys</div><button data-keyreset="all">Reset all</button></div>` +
          `<div class="mn-keys-note">${escapeHtml(this.keyNote)}</div>` +
          `<div class="mn-keys">${KEY_GROUPS.map(group).join('')}</div>` +
          `<div class="mn-keys-fixed"><span class="mn-label">Fixed</span>${FIXED_KEYS.map(([k, what]) => `<kbd>${k}</kbd>${what}`).join('')}</div>` +
          `<div class="mn-controls">${clone.innerHTML}</div>`
        );
      }
      case 'saves':
        return this.savesPage();
      case 'save':
        return this.savePage();
      case 'credits':
        return `<div class="mn-title">Credits</div><div class="mn-credits">${this.help.querySelector('.credits')?.innerHTML ?? ''}</div>`;
      default:
        return '';
    }
  }
}

/** A selector for a page's button or card, by what it does (to find it again in a rebuilt page). */
function focusKey(el: HTMLElement): string | null {
  for (const k of ['mission', 'weather', 'res', 'pad', 'act', 'ui', 'detail', 'rebind', 'keyreset', 'load', 'del', 'over'] as const) {
    if (el.dataset[k] !== undefined) return `[data-${k}="${el.dataset[k]}"]`;
  }
  return el instanceof HTMLInputElement && el.name ? `input[name="${el.name}"]` : null;
}

/** What a change of key did to the actions that had it (Controls page). */
function lossNote(lost: KeyLoss[]): string {
  const label = (a: KeyAction) => KEY_ACTIONS.find((d) => d.id === a)!.label;
  return lost
    .map((l) => (l.left.length ? `${label(l.action)} is on ${l.left.map((k) => keyLabel(k, true)).join(' / ')} only now.` : `${label(l.action)} had that key: it has none now.`))
    .join(' ');
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
