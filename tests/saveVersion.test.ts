import { afterEach, describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SAVE_UPGRADES, SAVE_VERSION, type SaveUpgrade, upgradeProblem, upgradeSave } from '../src/sim/saveVersion';

describe('save format versions', () => {
  // A made-up format at version 3, with steps from 1 to 2 and 2 to 3.
  const table: Record<number, SaveUpgrade> = {
    1: (s) => ({ ...s, version: 2, renamed: s.old, old: undefined, steps: [...((s.steps as number[]) ?? []), 1] }),
    2: (s) => ({ ...s, version: 3, added: 'filled in', steps: [...(s.steps as number[]), 2] }),
  };

  it('brings an older save up one step at a time, leaving the original as it was', () => {
    const old = { version: 1, old: 'x' };
    const up = upgradeSave<{ version: number; renamed: string; added: string; steps: number[] }>(old, 3, table);
    expect(up).toMatchObject({ version: 3, renamed: 'x', added: 'filled in', steps: [1, 2] });
    expect(old).toEqual({ version: 1, old: 'x' });
    expect(upgradeSave<{ version: number; steps: number[] }>({ version: 2, steps: [] } as { version: number }, 3, table).steps).toEqual([2]);
  });

  it('hands a current save back untouched', () => {
    const s = { version: 3 };
    expect(upgradeSave(s, 3, table)).toBe(s);
    expect(upgradeProblem(3, 3, table)).toBeNull();
  });

  it('refuses, saying why, a save with a step missing, from a newer build, or not a save at all', () => {
    expect(upgradeProblem(0, 3, table)).toMatch(/format version 0.*can't convert/);
    expect(() => upgradeSave({ version: 0 }, 3, table)).toThrow(/Can't load the flight: .*format version 0/);
    expect(upgradeProblem(4, 3, table)).toMatch(/newer version of the game/);
    expect(upgradeProblem('2', 3, table)).toMatch(/isn't a saved flight/);
    // (A gap in the middle stops it too.)
    expect(upgradeProblem(1, 3, { 2: table[2] })).toMatch(/can't convert/);
  });

  it('refuses a step that doesn\'t say it made the next version', () => {
    expect(() => upgradeSave({ version: 1 }, 2, { 1: (s) => ({ ...s }) })).toThrow(/converting it from format version 1 went wrong/);
  });

  it('has a step for every version the simulation can still read (none to convert yet)', () => {
    for (const v of Object.keys(SAVE_UPGRADES).map(Number)) expect(v).toBeLessThan(SAVE_VERSION);
  });
});

describe('Simulation.load and the upgrade table', () => {
  afterEach(() => {
    delete SAVE_UPGRADES[SAVE_VERSION - 1];
  });

  it('runs a save of a lower version through the table, then loads it', () => {
    const sim = new Simulation();
    const saved = JSON.parse(JSON.stringify(sim.save()));
    const older = { ...saved, version: SAVE_VERSION - 1, oldName: true };
    // (Refused while there's no step from it...)
    expect(() => new Simulation().load(older)).toThrow(/format version .*can't convert/);
    // (...and loaded once there is one.)
    const seen: unknown[] = [];
    SAVE_UPGRADES[SAVE_VERSION - 1] = (s) => {
      seen.push(s.version);
      const { oldName: _, ...rest } = s;
      return { ...rest, version: SAVE_VERSION };
    };
    const other = new Simulation();
    other.load(older);
    expect(seen).toEqual([SAVE_VERSION - 1]);
    expect(JSON.parse(JSON.stringify(other.save()))).toEqual(saved);
  });

  it('refuses a save of a newer version with a clear reason, leaving the flight alone', () => {
    const sim = new Simulation();
    const saved = JSON.parse(JSON.stringify(sim.save()));
    const other = new Simulation();
    other.launch();
    const before = JSON.stringify(other.save());
    expect(() => other.load({ ...saved, version: SAVE_VERSION + 1 })).toThrow(/newer version of the game/);
    expect(JSON.stringify(other.save())).toBe(before);
  });
});
