import { describe, expect, it } from 'vitest';
import { FIXED_KEYS, KEY_ACTIONS, KEY_GROUPS, type KeyAction, type KeyOverrides, actionOf, bind, cleanKeys, isChanged, keyLabel, keyMap, keysOf, resetKey, whyNot } from '../src/ui/keys';

/** No key on two actions, and every action's keys ones it may have. */
function expectConsistent(keys: KeyOverrides): void {
  const seen = new Map<string, KeyAction>();
  for (const d of KEY_ACTIONS) {
    for (const k of keysOf(d.id, keys)) {
      expect(seen.get(k), `'${k}' on both ${seen.get(k)} and ${d.id}`).toBeUndefined();
      seen.set(k, d.id);
      expect(whyNot(k, d.id)).toBeNull();
    }
  }
  expect(keyMap(keys).size).toBe(seen.size);
}

describe('the keys and their actions', () => {
  it('the defaults: every action once, in a group, on keys of its own that it may have', () => {
    expect(new Set(KEY_ACTIONS.map((d) => d.id)).size).toBe(KEY_ACTIONS.length);
    for (const d of KEY_ACTIONS) {
      expect(KEY_GROUPS).toContain(d.group);
      expect(d.keys.length).toBeGreaterThan(0);
    }
    expectConsistent({});
    expect(FIXED_KEYS.length).toBeGreaterThan(0);
  });

  it('the defaults are the keys the game has always had', () => {
    const def = (k: string) => actionOf(k, {});
    expect([def('w'), def('s'), def('a'), def('d'), def('q'), def('e')]).toEqual(['pitchDown', 'pitchUp', 'yawLeft', 'yawRight', 'rollLeft', 'rollRight']);
    expect([def('shift'), def('control'), def('alt'), def('z'), def('x')]).toEqual(['throttleUp', 'throttleDown', 'throttleDown', 'throttleFull', 'throttleCut']);
    expect([def(' '), def('tab'), def('c'), def('v'), def('m'), def('f'), def('h')]).toEqual(['launch', 'map', 'camera', 'vehicle', 'mute', 'fullscreen', 'help']);
    expect([def('l'), def('t'), def('g'), def('b'), def('n'), def('o')]).toEqual(['manual', 'sas', 'engines', 'deploy', 'node', 'mainMenu']);
    expect([def('k'), def('r'), def('i'), def('p'), def('j'), def('u'), def(','), def('.')]).toEqual(['director', 'replay', 'photo', 'plot', 'log', 'armsPad', 'warpDown', 'warpUp']);
    // The fixed keys, and keys nothing is on: no action.
    for (const k of ['escape', 'enter', 'arrowup', '[', '1', '8', 'y', '9']) expect(def(k)).toBeNull();
  });

  it('a key moves to another action; only the change is kept', () => {
    const { keys, lost } = bind({}, 'map', 'y');
    expect(keys).toEqual({ map: 'y' });
    expect(lost).toEqual([]);
    expect(actionOf('y', keys)).toBe('map');
    expect(actionOf('tab', keys)).toBeNull();
    expect(isChanged('map', keys)).toBe(true);
    expect(isChanged('camera', keys)).toBe(false);
    // Back on its default: nothing left to keep.
    expect(bind(keys, 'map', 'tab').keys).toEqual({});
    // The key it already has: nothing changes.
    expect(bind({}, 'map', 'tab')).toEqual({ keys: {}, lost: [] });
  });

  it('a key in use is taken from the action that had it, which is left with none', () => {
    const { keys, lost } = bind({}, 'map', 'm');
    expect(actionOf('m', keys)).toBe('map');
    expect(keysOf('mute', keys)).toEqual([]);
    expect(keys).toEqual({ map: 'm', mute: '' });
    expect(lost).toEqual([{ action: 'mute', left: [] }]);
    expectConsistent(keys);
    // Tab is free now: the sound can have it.
    const next = bind(keys, 'mute', 'tab');
    expect(next.keys).toEqual({ map: 'm', mute: 'tab' });
    expect(next.lost).toEqual([]);
    expectConsistent(next.keys);
  });

  it('an action with two keys keeps the other', () => {
    const { keys, lost } = bind({}, 'rollLeft', 'alt');
    expect(keysOf('throttleDown', keys)).toEqual(['control']);
    expect(lost).toEqual([{ action: 'throttleDown', left: ['control'] }]);
    expect(actionOf('alt', keys)).toBe('rollLeft');
    expect(actionOf('q', keys)).toBeNull();
    expectConsistent(keys);
    // Both back with a reset of the throttle (the roll, which had Alt, has none now).
    const back = resetKey(keys, 'throttleDown');
    expect(keysOf('throttleDown', back.keys)).toEqual(['control', 'alt']);
    expect(back.lost).toEqual([{ action: 'rollLeft', left: [] }]);
    expectConsistent(back.keys);
  });

  it('reset: an action back on its default, taken back from whoever has it since', () => {
    let keys = bind({}, 'map', 'm').keys; // sound: none
    keys = bind(keys, 'camera', 'tab').keys; // camera on the map's old key
    const r = resetKey(keys, 'map');
    expect(keysOf('map', r.keys)).toEqual(['tab']);
    expect(r.lost).toEqual([{ action: 'camera', left: [] }]);
    expect(keysOf('mute', r.keys)).toEqual([]); // still none: M is free, but it isn't given back unasked
    expectConsistent(r.keys);
    const all = resetKey(resetKey(r.keys, 'camera').keys, 'mute').keys;
    expect(all).toEqual({});
  });

  it('what a key can be: not the fixed ones; Shift, Ctrl, Alt only held to fly', () => {
    for (const k of ['escape', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '[', ']', '1', '5', '8']) {
      expect(whyNot(k, 'map')).toMatch(/fixed/);
      expect(whyNot(k, 'pitchUp')).toMatch(/fixed/);
    }
    for (const k of ['shift', 'control', 'alt']) {
      expect(whyNot(k, 'pitchUp')).toBeNull();
      expect(whyNot(k, 'throttleDown')).toBeNull();
      expect(whyNot(k, 'map')).toMatch(/held/);
      expect(whyNot(k, 'throttleFull')).toMatch(/held/); // (pressed once, not held)
    }
    for (const k of ['y', ' ', 'tab', ';', '9', '0', 'ö', 'backspace', 'home']) expect(whyNot(k, 'map')).toBeNull();
    for (const k of ['meta', 'f5', 'capslock', 'dead', 'unidentified', 'altgraph', 'M', '']) expect(whyNot(k, 'map')).not.toBeNull();
    // A key that can't be used changes nothing.
    expect(bind({ map: 'y' }, 'map', 'escape')).toEqual({ keys: { map: 'y' }, lost: [] });
    expect(bind({}, 'mute', 'shift')).toEqual({ keys: {}, lost: [] });
  });

  it('stored keys are made safe on load', () => {
    expect(cleanKeys(undefined)).toEqual({});
    expect(cleanKeys('w')).toEqual({});
    expect(cleanKeys(['w'])).toEqual({});
    expect(cleanKeys({ map: 'y', mute: '' })).toEqual({ map: 'y', mute: '' });
    // Unknown actions, values that aren't keys, fixed keys, a modifier on a key pressed once: dropped.
    expect(cleanKeys({ warpSpeed: 'y', map: 7, camera: null, vehicle: 'escape', plot: 'shift', log: 'F5', help: ['h'], sas: 'y' })).toEqual({ sas: 'y' });
    // A change that only says what the default says: dropped.
    expect(cleanKeys({ map: 'tab' })).toEqual({});
    // A key another action has by default: that action has none.
    const a = cleanKeys({ map: 'm' });
    expect(a).toEqual({ map: 'm', mute: '' });
    expectConsistent(a);
    // The same key twice: the later in the list gets it, the other has none.
    const b = cleanKeys({ map: 'y', camera: 'y' });
    expect([keysOf('camera', b), keysOf('map', b)]).toEqual([[], ['y']]);
    expectConsistent(b);
    // Not thrown by inherited or odd properties.
    expect(cleanKeys(JSON.parse('{"__proto__":{"map":"y"},"constructor":"x","toString":"y"}'))).toEqual({});
  });

  it('whatever is bound, in whatever order, no key ends up on two actions', () => {
    // (A fixed sequence of pseudo-random binds and resets.)
    let seed = 12345;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const pool = ['w', 'a', 's', 'd', 'q', 'e', 'shift', 'control', 'alt', ' ', 'tab', 'm', 'y', ',', '.', 'z', 'x', ';', '9', 'escape', '1', 'arrowup'];
    let keys: KeyOverrides = {};
    for (let i = 0; i < 2000; i++) {
      const d = KEY_ACTIONS[rand(KEY_ACTIONS.length)];
      const change = rand(5) === 0 ? resetKey(keys, d.id) : bind(keys, d.id, pool[rand(pool.length)]);
      keys = change.keys;
      expectConsistent(keys);
      for (const l of change.lost) expect(keysOf(l.action, keys)).toEqual(l.left);
      // What's stored reads back as it is.
      expect(cleanKeys(JSON.parse(JSON.stringify(keys)))).toEqual(keys);
    }
    // And resetting every one gets back to the defaults.
    for (const d of KEY_ACTIONS) keys = resetKey(keys, d.id).keys;
    expect(keys).toEqual({});
  });

  it('what is printed on a key', () => {
    expect([keyLabel('w'), keyLabel(' '), keyLabel('tab'), keyLabel('control'), keyLabel('alt'), keyLabel(','), keyLabel('ö')]).toEqual(['W', 'Space', 'Tab', 'Ctrl', 'Alt', ',', 'Ö']);
    expect([keyLabel('shift'), keyLabel('shift', true)]).toEqual(['⇧', 'Shift']);
  });
});

describe('key codes for full screen', () => {
  it('names the keys in use by position, following the overrides', async () => {
    const { keyCodes } = await import('../src/ui/keys');
    const codes = keyCodes({});
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'Tab', 'Comma', 'Period']) expect(codes, c).toContain(c);
    // (Sound moved to Y: Y is asked for, M no longer.)
    const moved = keyCodes({ mute: 'y' });
    expect(moved).toContain('KeyY');
    expect(moved).not.toContain('KeyM');
  });
});
