// The flights kept for next time, as the page handles them: asking the worker for the flight as it
// is now (the autosave every so often, or one of the player's), writing its answer to the store
// (game/savedFlight.ts), and taking a saved flight up again. (Moved out of main.ts: its "The
// flights kept for next time" section; main.ts sets up the world for the flight taken up.)

import type { SaveReply, ToWorker } from '../worker/protocol';
import { type FlightSave, type FlightSaveContent, type SaveEntry, browserStore, deleteSave, listSaves, markUnusable, readSave, writeAutosave, writeManualSave } from './savedFlight';
import { type MissionDef, missionById } from './missions';

/** The page's side of a save: everything but the flight itself and its clock. */
export type SaveMeta = Omit<FlightSaveContent, 'missionTime' | 'flight'>;

/** Where a save of the player's goes: by name, in place of `replace` (or where savedFlight.ts puts it). */
export interface SaveTo {
  name: string;
  replace: string | null;
}

export interface SaveSessionDeps {
  send(m: ToWorker): void;
  /** Whether there's a flight to keep now (under way, loaded, not a replay). */
  canSave(): boolean;
  /** The page's side of the flight as it is now (mission, pad, vehicles, time of day...). */
  meta(): SaveMeta;
  showToast(text: string): void;
  /** The main menu's list of saves needs drawing again. */
  savesChanged(): void;
  /** The flight taken up has its whole log so far. */
  logEvents(events: Extract<SaveReply, { type: 'loaded' }>['events']): void;
  /** Its mission was already over. */
  missionOver(): boolean;
  openMainMenu(page: 'saves'): void;
  /**
   * Set the world up for a saved flight (its mission, pad, weather, time of day, vehicles) and send
   * it to the worker ('load').
   */
  takeUp(save: FlightSave, mission: MissionDef): void;
}

export interface SaveSession {
  /**
   * Ask the worker for the flight as it is now, to keep: as the autosave, or (`to`) as one of the
   * player's. False: there's no flight to keep now.
   */
  askSave(to?: SaveTo | null): boolean;
  /** The worker's answers to 'save' / 'load'. */
  onReply(m: SaveReply): void;
  /** Each frame: the autosave, if it's due. */
  autosave(now: number): void;
  /** Take up a saved flight: the same mission, vehicles, weather and time of day. */
  continueFlight(id: string): void;
  /** A new flight (or the menu's): kept again, and not one coming up from a save. */
  newFlight(): void;
  /** A saved flight is coming up: the controls are to be taken from its first snapshot. */
  adoptPending(): boolean;
  /** They have been. */
  adoptDone(): void;
  list(): SaveEntry[];
  delete(id: string): void;
}

export function createSaveSession(deps: SaveSessionDeps): SaveSession {
  /** A flight in progress is autosaved this often while it's flown, ms. */
  const AUTOSAVE_MS = 20000;
  let lastSaveAsk = 0;
  const saveStore = browserStore();
  /**
   * The saves the worker has been asked for and hasn't answered yet, in the order asked (it answers
   * in order): the page's side of each, and where it goes (null: the autosave; else one of the
   * player's, by name, in place of `replace` or where savedFlight.ts puts it).
   */
  const saveAsks: { meta: SaveMeta; to: SaveTo | null }[] = [];
  /** This flight isn't kept (it couldn't be taken up: the main menu replaces it). */
  let saveOff = false;
  /** The last autosave didn't fit (the player is told once, not every 20 s). */
  let autosaveFailed = false;
  /** A saved flight is coming up: the controls are taken from its first snapshot, as they were. */
  let adoptPilot = false;
  /** The save being taken up, until the worker says it has it (to mark it if it can't). */
  let loadingSave: string | null = null;

  /**
   * Ask the worker for the flight as it is now, to keep (its answer: onSaveReply): as the autosave,
   * or (`to`) as one of the player's. False: there's no flight to keep now. A flight whose mission
   * is over goes on being autosaved ("Keep watching" carries on with it), marked as over.
   */
  function askSave(to: SaveTo | null = null): boolean {
    if (saveOff || !deps.canSave()) return false;
    if (!to) lastSaveAsk = performance.now();
    saveAsks.push({ meta: deps.meta(), to });
    deps.send({ type: 'save' });
    return true;
  }

  function onSaveReply(m: SaveReply): void {
    if (m.type === 'saved') {
      const ask = saveAsks.shift();
      if (!ask) return;
      const content = { ...ask.meta, missionTime: m.data.missionTime, flight: m.data };
      if (ask.to) {
        const w = writeManualSave(saveStore, content, ask.to);
        if (!w.ok) deps.showToast(`Flight not saved: ${w.reason}`);
        else deps.showToast(w.replaced ? `Flight saved, in place of ${w.replaced.name || w.replaced.title}` : 'Flight saved');
      } else {
        const w = writeAutosave(saveStore, content);
        if (!w.ok && !autosaveFailed) deps.showToast(`Autosave not kept: ${w.reason}`);
        autosaveFailed = !w.ok;
      }
      deps.savesChanged();
    } else if (m.type === 'loaded') {
      loadingSave = null;
      deps.logEvents(m.events);
      deps.showToast(deps.missionOver() ? 'Flight continued · its mission was already over' : 'Flight continued from where you left it');
    } else {
      // (It couldn't be read: damaged, most likely, as one from another version is turned away
      // before it's sent. It stays in the list, saying why; the other saves are left alone.)
      console.warn('saved flight not loaded:', m.reason);
      if (loadingSave) markUnusable(saveStore, loadingSave, m.reason.replace(/^Can't load the flight: /, ''));
      loadingSave = null;
      deps.showToast('That saved flight can’t be continued in this version');
      saveOff = true;
      adoptPilot = false;
      deps.openMainMenu('saves');
    }
  }

  /** Take up a saved flight: the same mission, vehicles, weather and time of day. */
  function continueFlight(id: string): void {
    const r = readSave(saveStore, id);
    if (!('save' in r)) {
      deps.showToast('That saved flight can’t be continued');
      deps.savesChanged();
      return;
    }
    const s = r.save;
    let mission;
    try {
      mission = missionById(s.mission);
    } catch {
      markUnusable(saveStore, id, 'its mission isn’t in this version of the game');
      deps.showToast('That saved flight can’t be continued');
      deps.savesChanged();
      return;
    }
    // (The world set up for it, and the flight sent to the worker: main.ts.)
    deps.takeUp(s, mission);
    loadingSave = id;
    adoptPilot = true;
    saveOff = false;
    lastSaveAsk = performance.now();
  }

  return {
    askSave,
    onReply: onSaveReply,
    autosave: (now) => {
      if (now - lastSaveAsk > AUTOSAVE_MS) askSave();
    },
    continueFlight,
    newFlight: () => {
      saveOff = false;
      adoptPilot = false;
    },
    adoptPending: () => adoptPilot,
    adoptDone: () => {
      adoptPilot = false;
    },
    list: () => listSaves(saveStore),
    delete: (id) => deleteSave(saveStore, id),
  };
}
