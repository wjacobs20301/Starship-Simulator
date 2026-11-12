import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The keyboard handling (ui/input.ts) run against a stand-in for the page: just enough of
// window and document for bindKeys to listen, and key events made by hand.

type Listener = (e: FakeKey) => void;
const listeners: Record<string, Listener[]> = {};
/** Calls into the page's focus handling (the menus' arrow keys). */
let navigated = 0;

vi.stubGlobal('window', { addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn) });
vi.stubGlobal('document', {
  activeElement: null,
  body: null,
  querySelector: () => null,
  querySelectorAll: () => (navigated++, []),
});
class FakeElement {}
vi.stubGlobal('HTMLElement', FakeElement);
vi.stubGlobal('HTMLInputElement', class extends FakeElement {});
vi.stubGlobal('HTMLTextAreaElement', class extends FakeElement {});

interface FakeKey {
  code: string;
  key: string;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: unknown;
  prevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function key(type: 'keydown' | 'keyup', code: string, k: string, mods: Partial<FakeKey> = {}): FakeKey {
  const e: FakeKey = {
    code, key: k, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: null, prevented: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() {},
    ...mods,
  };
  for (const fn of listeners[type] ?? []) fn(e);
  return e;
}
const down = (code: string, k: string, mods: Partial<FakeKey> = {}) => key('keydown', code, k, mods);
const up = (code: string, k: string, mods: Partial<FakeKey> = {}) => key('keyup', code, k, mods);
/** A key pressed and let go. */
const tap = (code: string, k: string) => (down(code, k), up(code, k));

const { bindKeys, captureKey, flightAxes, held } = await import('../src/ui/input');
const { updateSettings } = await import('../src/settings');
const { bind } = await import('../src/ui/keys');
type KeyOverrides = import('../src/ui/keys').KeyOverrides;
type InputActions = import('../src/ui/input').InputActions;

/** Every action called, by name, in order. */
let calls: string[] = [];
let blocked = false;
const actions = new Proxy({} as InputActions, {
  get: (_, name: string) => (name === 'blocked' ? () => blocked : (...args: unknown[]) => void calls.push(args.length ? `${name}(${args.join(',')})` : name)),
});

const setKeys = (...binds: [Parameters<typeof bind>[1], string][]) => {
  let keys: KeyOverrides = {};
  for (const [action, k] of binds) keys = bind(keys, action, k).keys;
  updateSettings({ keys });
};

beforeAll(() => bindKeys(actions));
beforeEach(() => {
  updateSettings({ keys: {} });
  held.clear();
  calls = [];
  blocked = false;
  navigated = 0;
});

describe('keys to actions', () => {
  it('the default keys', () => {
    tap('KeyM', 'm');
    tap('Tab', 'Tab');
    tap('Space', ' ');
    tap('Comma', ',');
    tap('Period', '>'); // (Shift down for the throttle: still the warp key, by its place)
    tap('KeyX', 'x');
    expect(calls).toEqual(['toggleMute', 'toggleMap', 'spaceBar', 'stepWarp(-1)', 'stepWarp(1)', 'throttleCut']);
  });

  it('a key that has been changed does the new action, and the old key nothing', () => {
    setKeys(['map', 'y'], ['camera', 'm']); // the sound, which had M, has no key now
    tap('KeyY', 'y');
    tap('Tab', 'Tab');
    tap('KeyM', 'm');
    tap('KeyC', 'c');
    expect(calls).toEqual(['toggleMap', 'cycleCamera']);
  });

  it('the fixed keys stay, whatever is changed', () => {
    setKeys(['map', '9'], ['launch', 'y']);
    tap('Digit3', '3');
    tap('Enter', 'Enter');
    tap('Escape', 'Escape');
    tap('ArrowUp', 'ArrowUp');
    tap('BracketLeft', '[');
    tap('Digit9', '9');
    expect(calls).toEqual(['setWarp(5)', 'savePhoto', 'menu', 'arms(1,)', 'arms(0,)', 'arms(,,1)', 'arms(,,0)', 'toggleMap']);
  });

  it('held keys fly: by their place on the keyboard, on any layout', () => {
    // (An AZERTY keyboard: the key where W is types z.)
    down('KeyW', 'z');
    down('KeyD', 'd');
    expect(flightAxes()).toMatchObject({ pitch: 1, yaw: 1, roll: 0, throttle: 0 });
    expect(calls).toEqual([]); // (not full throttle, which is on the key that types z on QWERTY)
    up('KeyW', 'z');
    down('ShiftLeft', 'Shift', { shiftKey: true });
    expect(flightAxes()).toMatchObject({ pitch: 0, yaw: 1, throttle: 1 });
    down('ControlLeft', 'Control', { shiftKey: true, ctrlKey: true });
    expect(flightAxes().throttle).toBe(0);
    up('ShiftLeft', 'Shift', { ctrlKey: true });
    expect(flightAxes().throttle).toBe(-1);
    up('ControlLeft', 'Control');
    up('KeyD', 'd');
    expect(flightAxes()).toMatchObject({ pitch: 0, yaw: 0, roll: 0, throttle: 0 });
  });

  it('the flight keys can be moved, the throttle off Shift / Ctrl / Alt too', () => {
    setKeys(['pitchDown', 'i'], ['pitchUp', 'k'], ['throttleUp', 'r'], ['throttleDown', 'f'], ['rollLeft', 'alt']);
    down('KeyI', 'i');
    down('KeyR', 'r');
    expect(flightAxes()).toMatchObject({ pitch: 1, throttle: 1 });
    up('KeyI', 'i');
    up('KeyR', 'r');
    // Their old keys and jobs: W nothing, Shift and Ctrl nothing, R no replay, K no auto camera.
    down('KeyW', 'w');
    down('ShiftLeft', 'Shift', { shiftKey: true });
    down('ControlLeft', 'Control', { shiftKey: true, ctrlKey: true });
    expect(flightAxes()).toMatchObject({ pitch: 0, throttle: 0 });
    up('ControlLeft', 'Control');
    up('ShiftLeft', 'Shift');
    up('KeyW', 'w');
    down('KeyK', 'k');
    expect(flightAxes().pitch).toBe(-1);
    up('KeyK', 'k');
    down('AltLeft', 'Alt', { altKey: true });
    expect(flightAxes().roll).toBe(-1);
    up('AltLeft', 'Alt');
    expect(calls).toEqual([]);
    // (Ctrl and Alt both were the throttle down: neither is now.)
    expect(flightAxes()).toMatchObject({ pitch: 0, yaw: 0, roll: 0, throttle: 0 });
  });

  it('a held key named by what it types comes up as it went down, though Shift changed its name', () => {
    setKeys(['yawRight', ';']);
    down('Semicolon', ';');
    expect(flightAxes().yaw).toBe(1);
    down('ShiftLeft', 'Shift', { shiftKey: true });
    up('Semicolon', ':', { shiftKey: true });
    expect(flightAxes().yaw).toBe(0);
    expect(flightAxes().throttle).toBe(1);
    up('ShiftLeft', 'Shift');
  });

  it('with a menu up the game keys do nothing (but Esc and full screen), and nothing stays held', () => {
    down('KeyW', 'w');
    blocked = true;
    tap('KeyM', 'm');
    expect(flightAxes().pitch).toBe(0);
    tap('KeyF', 'f');
    tap('Escape', 'Escape');
    down('ArrowDown', 'ArrowDown');
    expect(calls).toEqual(['toggleFullscreen', 'menu']);
    expect(navigated).toBeGreaterThan(0);
    // (An arrow let go stops the tower arms wherever it's let go: it may have gone down before the menu came up.)
    up('ArrowDown', 'ArrowDown');
    // (Full screen on the key the player gave it.)
    setKeys(['fullscreen', 'y']);
    calls = [];
    tap('KeyF', 'f');
    tap('KeyY', 'y');
    expect(calls).toEqual(['toggleFullscreen']);
  });

  it('typing in a menu field is typing', () => {
    const field = new (globalThis as unknown as { HTMLInputElement: new () => unknown }).HTMLInputElement();
    down('KeyM', 'm', { target: field });
    expect(calls).toEqual([]);
  });
});

describe('choosing a key (the Controls page)', () => {
  it('the next key goes to the chooser and does nothing else: not its action, not the menu', () => {
    for (const menuUp of [true, false]) {
      blocked = menuUp;
      calls = [];
      navigated = 0;
      const got: (string | null)[] = [];
      captureKey((k) => (got.push(k), true));
      const e = down('KeyM', 'm');
      expect(got).toEqual(['m']);
      expect(e.prevented).toBe(true);
      up('KeyM', 'm');
      expect(calls).toEqual([]);
      // Taken: the next press is an ordinary one again.
      tap('KeyM', 'm');
      expect(got).toEqual(['m']);
      expect(calls).toEqual(menuUp ? [] : ['toggleMute']);
    }
  });

  it('the menu keys too (arrows, Enter, Space), and it waits on while a key is refused', () => {
    blocked = true;
    const got: (string | null)[] = [];
    // (Refuses the fixed keys, as the Controls page does; takes Space.)
    captureKey((k) => (got.push(k), k === ' '));
    for (const [code, k] of [['ArrowDown', 'ArrowDown'], ['Enter', 'Enter'], ['Digit1', '1']] as const) {
      expect(down(code, k).prevented).toBe(true);
      expect(up(code, k).prevented).toBe(true);
    }
    expect(got).toEqual(['arrowdown', 'enter', '1']);
    expect(navigated).toBe(0);
    // Space: prevented going down and coming up, so it can't also press the focused button.
    expect(down('Space', ' ').prevented).toBe(true);
    expect(up('Space', ' ').prevented).toBe(true);
    expect(got).toEqual(['arrowdown', 'enter', '1', ' ']);
    expect(calls).toEqual([]);
    // Done: the arrows are the menu's again.
    tap('ArrowDown', 'ArrowDown');
    expect(navigated).toBeGreaterThan(0);
  });

  it('Esc cancels (null), and is not the menu’s way out', () => {
    blocked = true;
    const got: (string | null)[] = [];
    captureKey((k) => (got.push(k), true));
    tap('Escape', 'Escape');
    expect(got).toEqual([null]);
    expect(calls).toEqual([]);
    tap('Escape', 'Escape');
    expect(calls).toEqual(['menu']);
  });

  it('a key held down, or pressed with Shift / Ctrl / Alt, is not taken; the modifier on its own is', () => {
    const got: (string | null)[] = [];
    const off = captureKey((k) => (got.push(k), false));
    down('KeyM', 'm', { repeat: true });
    down('Semicolon', ':', { shiftKey: true });
    down('KeyR', 'r', { ctrlKey: true });
    down('KeyR', 'r', { metaKey: true });
    expect(got).toEqual([]);
    down('ShiftLeft', 'Shift', { shiftKey: true });
    down('ControlLeft', 'Control', { ctrlKey: true });
    down('AltLeft', 'Alt', { altKey: true });
    expect(got).toEqual(['shift', 'control', 'alt']);
    expect(calls).toEqual([]);
    expect(held.size).toBe(0);
    // Called off: keys are keys again.
    off();
    up('AltLeft', 'Alt');
    tap('KeyM', 'm');
    expect(calls).toEqual(['toggleMute']);
  });

  it('the key just chosen is not held or stuck afterwards', () => {
    captureKey(() => true);
    down('KeyW', 'w');
    up('KeyW', 'w');
    expect(flightAxes().pitch).toBe(0);
    down('KeyW', 'w');
    expect(flightAxes().pitch).toBe(1);
    up('KeyW', 'w');
    expect(flightAxes().pitch).toBe(0);
    // (Its release never seen, the window lost focus: the next press and release still count.)
    captureKey(() => true);
    down('KeyW', 'w');
    down('KeyW', 'w');
    expect(flightAxes().pitch).toBe(1);
    up('KeyW', 'w');
    expect(flightAxes().pitch).toBe(0);
  });
});
