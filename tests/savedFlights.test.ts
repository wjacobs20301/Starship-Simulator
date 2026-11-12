import { describe, expect, it } from 'vitest';
import {
  AUTO_ID,
  FLIGHT_SAVE_UPGRADES,
  type FlightSaveContent,
  MAX_MANUAL,
  type SaveStore,
  VERSION,
  cleanName,
  deleteSave,
  formatSavedAt,
  latestSave,
  listSaves,
  manualTarget,
  markUnusable,
  readSave,
  writeAutosave,
  writeManualSave,
} from '../src/game/savedFlight';
import { MissionTracker, missionById } from '../src/game/missions';
import { SAVE_VERSION } from '../src/sim/saveVersion';
import type { SavedFlight } from '../src/worker/protocol';

/** localStorage as the browser has it: string values, and a size past which a write throws (and changes nothing). */
class FakeStore implements SaveStore {
  map = new Map<string, string>();
  constructor(public limit = Infinity) {}
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    let used = 0;
    for (const [key, val] of this.map) if (key !== k) used += key.length + val.length;
    if (used + k.length + v.length > this.limit) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const flight = (missionTime = 100): SavedFlight =>
  ({ version: SAVE_VERSION, t: missionTime + 10, missionTime, phase: 'coast', options: {}, pad: 0, boosterOcean: null, env: { gravity: true, aero: true, wind: false }, state: {}, weather: null, windMemory: null }) as unknown as SavedFlight;

const content = (missionTime = 100, extra: Partial<FlightSaveContent> = {}): FlightSaveContent => ({
  missionTime,
  mission: 'ift',
  title: 'Flight Test',
  finished: false,
  pad: 0,
  tracked: 'stack',
  manual: [],
  day: null,
  tracker: { record: {} },
  flight: flight(missionTime),
  ...extra,
});

/** A save as the build before several saves wrote it, at the one key there was. */
const versionOne = () => {
  const { finished: _f, ...rest } = content(321);
  return { ...rest, version: 1, savedAt: 1_000_000 };
};

describe('saved flights', () => {
  it('takes the single save of older builds as the autosave, converting it on first read', () => {
    const store = new FakeStore();
    store.setItem('starship-sim:flight', JSON.stringify(versionOne()));
    const list = listSaves(store);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: AUTO_ID, auto: true, title: 'Flight Test', missionTime: 321, savedAt: 1_000_000, finished: false, problem: null });
    // (Written back in this version's shape, so it's only converted once.)
    const stored = JSON.parse(store.getItem('starship-sim:flight')!);
    expect(stored.version).toBe(VERSION);
    expect(stored.name).toBe('');
    expect(stored.finished).toBe(false);
    const r = readSave(store, AUTO_ID);
    expect('save' in r && r.save.missionTime).toBe(321);
  });

  it('converts an old save step by step even when it can\'t be written back', () => {
    const store = new FakeStore();
    store.setItem('starship-sim:flight', JSON.stringify(versionOne()));
    store.limit = 0;
    const r = readSave(store, AUTO_ID);
    expect('save' in r && r.save.version).toBe(VERSION);
    expect(JSON.parse(store.getItem('starship-sim:flight')!).version).toBe(1);
  });

  it('has a step for every older page-side version', () => {
    for (let v = 1; v < VERSION; v++) expect(FLIGHT_SAVE_UPGRADES[v]).toBeTypeOf('function');
  });

  it('lists a damaged save (it can be deleted) and leaves the others alone', () => {
    const store = new FakeStore();
    store.setItem('starship-sim:flight:broken', '{"version": 2, "title": "Flight Te');
    store.setItem('starship-sim:flight:half', JSON.stringify({ version: 2, title: 'Booster Catch', savedAt: 5 }));
    expect(writeManualSave(store, content(50), { name: 'good' }, 2_000_000).ok).toBe(true);
    const list = listSaves(store);
    expect(list.map((e) => e.name || e.id)).toEqual(['good', 'half', 'broken']);
    expect(list[0].problem).toBeNull();
    expect(list[1]).toMatchObject({ title: 'Booster Catch', problem: expect.stringMatching(/damaged/) });
    expect(list[2].problem).toMatch(/damaged/);
    expect(readSave(store, 'broken')).toEqual({ problem: expect.stringMatching(/damaged/) });
    deleteSave(store, 'broken');
    expect(listSaves(store)).toHaveLength(2);
  });

  it('says plainly why a save from a newer build, or with a simulation it can\'t convert, can\'t be continued', () => {
    const store = new FakeStore();
    store.setItem('starship-sim:flight:new', JSON.stringify({ ...content(), version: VERSION + 1, savedAt: 3, name: 'x' }));
    store.setItem('starship-sim:flight:oldsim', JSON.stringify({ ...content(), version: VERSION, savedAt: 2, name: 'y', flight: { ...flight(), version: 0 } }));
    const [a, b] = listSaves(store);
    expect(a.problem).toMatch(/newer version of the game/);
    expect(b.problem).toMatch(/format version 0.*can't convert/);
  });

  it('marks a save the simulation refused, without touching the others', () => {
    const store = new FakeStore();
    writeAutosave(store, content(10), 1000);
    const w = writeManualSave(store, content(20), { name: 'mine' }, 2000);
    expect(w.ok).toBe(true);
    const id = (w as { id: string }).id;
    markUnusable(store, id, 'it can\'t be read by this version of the game');
    const list = listSaves(store);
    expect(list.find((e) => e.id === id)!.problem).toMatch(/can't be read/);
    expect(list.find((e) => e.auto)!.problem).toBeNull();
    expect(latestSave(list)!.id).toBe(AUTO_ID);
  });

  it('lists the newest first, and continues the newest that can be', () => {
    const store = new FakeStore();
    writeManualSave(store, content(1), { name: 'first' }, 1000);
    writeAutosave(store, content(2), 3000);
    writeManualSave(store, content(3), { name: 'second' }, 2000);
    const list = listSaves(store);
    expect(list.map((e) => (e.auto ? 'auto' : e.name))).toEqual(['auto', 'second', 'first']);
    expect(latestSave(list)!.auto).toBe(true);
    writeAutosave(store, content(4), 500);
    expect(latestSave(listSaves(store))!.name).toBe('second');
  });

  it('keeps one autosave, overwritten each time', () => {
    const store = new FakeStore();
    writeAutosave(store, content(1), 1);
    writeAutosave(store, content(2), 2);
    const list = listSaves(store);
    expect(list).toHaveLength(1);
    expect(list[0].missionTime).toBe(2);
  });

  it(`keeps at most ${MAX_MANUAL} of the player's saves: the next goes in place of the oldest`, () => {
    const store = new FakeStore();
    writeAutosave(store, content(0), 1);
    for (let i = 0; i < MAX_MANUAL; i++) expect(writeManualSave(store, content(i), { name: `save ${i}` }, 100 + i).ok).toBe(true);
    let list = listSaves(store);
    expect(list).toHaveLength(MAX_MANUAL + 1);
    // (The autosave doesn't count, and isn't replaced even though it's older.)
    expect(manualTarget(list).replaces!.name).toBe('save 0');
    const w = writeManualSave(store, content(99), { name: 'newest' }, 1000);
    expect(w).toMatchObject({ ok: true, replaced: { name: 'save 0' } });
    list = listSaves(store);
    expect(list).toHaveLength(MAX_MANUAL + 1);
    expect(list.map((e) => e.name)).not.toContain('save 0');
    expect(list[0].name).toBe('newest');
    expect(list.some((e) => e.auto)).toBe(true);
  });

  it('saves over one the player picks', () => {
    const store = new FakeStore();
    writeManualSave(store, content(1), { name: 'a' }, 1);
    const b = writeManualSave(store, content(2), { name: 'b' }, 2) as { id: string };
    const w = writeManualSave(store, content(3), { name: 'b again', replace: b.id }, 3);
    expect(w).toMatchObject({ ok: true, id: b.id, replaced: { name: 'b' } });
    expect(listSaves(store).map((e) => e.name)).toEqual(['b again', 'a']);
    // (Never the autosave: a pick that isn't one of the player's is a new save.)
    writeAutosave(store, content(4), 4);
    expect(manualTarget(listSaves(store), AUTO_ID)).toEqual({ id: null, replaces: null });
  });

  it('gives the readable ones and the unreadable ones a place in the count, unreadable going first', () => {
    const store = new FakeStore();
    for (let i = 0; i < MAX_MANUAL - 1; i++) writeManualSave(store, content(i), { name: `s${i}` }, 100 + i);
    store.setItem('starship-sim:flight:zzz', 'not json');
    expect(manualTarget(listSaves(store)).replaces!.id).toBe('zzz');
  });

  it('when the storage is full: says so, and loses nothing already kept', () => {
    const store = new FakeStore();
    writeAutosave(store, content(1), 1);
    const w1 = writeManualSave(store, content(2), { name: 'kept' }, 2) as { id: string };
    const before = new Map(store.map);
    store.limit = [...store.map].reduce((a, [k, v]) => a + k.length + v.length, 0) + 10;
    const bigger = content(3, { tracker: { record: {}, pad: 'x'.repeat(500) } });
    const w = writeManualSave(store, bigger, { name: 'new' }, 3);
    expect(w).toMatchObject({ ok: false, full: true, reason: expect.stringMatching(/full/) });
    expect(writeAutosave(store, bigger, 4)).toMatchObject({ ok: false, full: true });
    expect(writeManualSave(store, bigger, { name: 'over', replace: w1.id }, 5)).toMatchObject({ ok: false, full: true });
    expect(store.map).toEqual(before);
    expect(listSaves(store).map((e) => e.problem)).toEqual([null, null]);
  });

  it('when the browser keeps nothing at all: says that instead', () => {
    const store = new FakeStore();
    store.setItem = () => {
      throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    };
    expect(writeAutosave(store, content(), 1)).toMatchObject({ ok: false, full: false, reason: expect.stringMatching(/private window/) });
  });

  it('tidies a name', () => {
    expect(cleanName('  Before   the\nflip  ')).toBe('Before the flip');
    expect(cleanName('x'.repeat(100))).toHaveLength(40);
  });

  it('says when a save was made in plain words', () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime();
    expect(formatSavedAt(new Date(2026, 10, 11, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatSavedAt(new Date(2026, 10, 10, 23, 59).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatSavedAt(new Date(2026, 10, 3, 14, 5).getTime(), now)).not.toMatch(/Today|Yesterday|2026/);
    expect(formatSavedAt(new Date(2025, 10, 3, 14, 5).getTime(), now)).toMatch(/2025/);
  });
});

describe('a finished mission in a save', () => {
  /** A record that settles every objective of the hand-flown ascent (the stack lost). */
  const doneTracker = () => {
    const t = new MissionTracker(missionById('ascent'));
    t.record.liftoff = true;
    t.record.stackLost = true;
    return t;
  };

  it('is taken up as over, without its result being given out again', () => {
    const t = doneTracker();
    const snap = { events: [], vehicles: [] } as unknown as Parameters<MissionTracker['update']>[0];
    const result = t.update(snap);
    expect(result).not.toBeNull();
    const saved = JSON.parse(JSON.stringify(t.saveState()));
    expect(saved.finished).toBe(true);

    const loaded = new MissionTracker(missionById('ascent'));
    loaded.loadState(saved);
    expect(loaded.result).not.toBeNull();
    expect(loaded.result!.total).toBe(result!.total);
    // (The next snapshot doesn't announce it: no second results screen.)
    expect(loaded.update(snap)).toBeNull();
  });

  it('one that wasn\'t over (or saved by an older build) is still running', () => {
    const t = doneTracker();
    const saved = JSON.parse(JSON.stringify(t.saveState()));
    expect(saved.finished).toBe(false);
    const loaded = new MissionTracker(missionById('ascent'));
    loaded.loadState({ record: saved.record });
    expect(loaded.result).toBeNull();
  });
});
