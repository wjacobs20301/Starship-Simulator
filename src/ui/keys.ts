// The keyboard's actions and their keys: the defaults, and the player's changes to them.
//
// A key is known by the name input.ts gives a key press (keyOf): the flight keys W A S D Q E by
// where they are on the keyboard, the rest by what they type, lower case ('m', ' ', 'tab',
// 'shift'). The settings keep only what the player changed: action -> key name, or '' for an
// action left with no key. No key is ever on two actions: binding one that's in use takes it
// from the action that had it, which is then shown as having none.
//
// Nothing here touches the page (tests/keys.test.ts): input.ts reads the keys through this,
// the menu's Controls page changes them, keyLabels.ts writes them into the help.

export type KeyAction =
  | 'pitchDown' | 'pitchUp' | 'yawLeft' | 'yawRight' | 'rollLeft' | 'rollRight' | 'throttleUp' | 'throttleDown' | 'throttleFull' | 'throttleCut'
  | 'launch' | 'manual' | 'sas' | 'engines' | 'deploy' | 'node'
  | 'camera' | 'vehicle' | 'map' | 'director' | 'replay' | 'photo' | 'plot' | 'log' | 'help'
  | 'warpDown' | 'warpUp' | 'armsPad' | 'mute' | 'fullscreen' | 'mainMenu';

export type KeyGroup = 'Fly' | 'Flight' | 'View' | 'Time and game';
export const KEY_GROUPS: readonly KeyGroup[] = ['Fly', 'Flight', 'View', 'Time and game'];

export interface KeyDef {
  id: KeyAction;
  label: string;
  group: KeyGroup;
  /** The default key (or keys: either does it). */
  keys: readonly string[];
  /** Held down to fly (attitude, throttle) rather than pressed once. */
  hold?: true;
}

/** Every action a key can be set for, in the order the Controls page lists them. */
export const KEY_ACTIONS: readonly KeyDef[] = [
  // (W pitches the nose down, as pushing a stick forward does.)
  { id: 'pitchDown', label: 'Pitch down', group: 'Fly', keys: ['w'], hold: true },
  { id: 'pitchUp', label: 'Pitch up', group: 'Fly', keys: ['s'], hold: true },
  { id: 'yawLeft', label: 'Yaw left', group: 'Fly', keys: ['a'], hold: true },
  { id: 'yawRight', label: 'Yaw right', group: 'Fly', keys: ['d'], hold: true },
  { id: 'rollLeft', label: 'Roll left', group: 'Fly', keys: ['q'], hold: true },
  { id: 'rollRight', label: 'Roll right', group: 'Fly', keys: ['e'], hold: true },
  { id: 'throttleUp', label: 'Throttle up', group: 'Fly', keys: ['shift'], hold: true },
  { id: 'throttleDown', label: 'Throttle down', group: 'Fly', keys: ['control', 'alt'], hold: true },
  { id: 'throttleFull', label: 'Full throttle', group: 'Fly', keys: ['z'] },
  { id: 'throttleCut', label: 'Cut throttle', group: 'Fly', keys: ['x'] },
  { id: 'launch', label: 'Launch · stage', group: 'Flight', keys: [' '] },
  { id: 'manual', label: 'Take control · autopilot', group: 'Flight', keys: ['l'] },
  { id: 'sas', label: 'SAS on / off', group: 'Flight', keys: ['t'] },
  { id: 'engines', label: 'Engine set', group: 'Flight', keys: ['g'] },
  { id: 'deploy', label: 'Deploy Starlinks', group: 'Flight', keys: ['b'] },
  { id: 'node', label: 'Maneuver node', group: 'Flight', keys: ['n'] },
  { id: 'camera', label: 'Next camera', group: 'View', keys: ['c'] },
  { id: 'vehicle', label: 'Next vehicle', group: 'View', keys: ['v'] },
  { id: 'map', label: 'Map', group: 'View', keys: ['tab'] },
  { id: 'director', label: 'Auto camera', group: 'View', keys: ['k'] },
  { id: 'replay', label: 'Instant replay', group: 'View', keys: ['r'] },
  { id: 'photo', label: 'Photo mode', group: 'View', keys: ['i'] },
  { id: 'plot', label: 'Plot', group: 'View', keys: ['p'] },
  { id: 'log', label: 'Event log', group: 'View', keys: ['j'] },
  { id: 'help', label: 'Help', group: 'View', keys: ['h'] },
  { id: 'warpDown', label: 'Time warp down', group: 'Time and game', keys: [','] },
  { id: 'warpUp', label: 'Time warp up', group: 'Time and game', keys: ['.'] },
  { id: 'armsPad', label: 'Tower arms: other pad', group: 'Time and game', keys: ['u'] },
  { id: 'mute', label: 'Sound', group: 'Time and game', keys: ['m'] },
  { id: 'fullscreen', label: 'Full screen', group: 'Time and game', keys: ['f'] },
  { id: 'mainMenu', label: 'Main menu (on the pad)', group: 'Time and game', keys: ['o'] },
];

const DEFS = new Map<string, KeyDef>(KEY_ACTIONS.map((d) => [d.id, d]));

/** The player's changes: an action's one key, or '' for none. Actions not in it have their defaults. */
export type KeyOverrides = Partial<Record<KeyAction, string>>;

/**
 * Keys that stay what they are: Esc (the pause menu, and out of anything), Enter (saves the
 * picture in photo mode, presses a menu button), the arrows and [ ] (the tower arms; the menus;
 * a replay's steps; photo mode's zoom) and 1-8 (the warp levels).
 */
const FIXED = new Set(['escape', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '[', ']', '1', '2', '3', '4', '5', '6', '7', '8']);
/** The fixed keys, for the Controls page: what's on the key, what it does. */
export const FIXED_KEYS: readonly (readonly [string, string])[] = [
  ['Esc', 'Pause menu · back'],
  ['Enter', 'Save the picture (photo mode)'],
  ['↑ ↓ ← →', 'Tower arms · replay: 5 s back / on'],
  ['[ ]', 'Swing the arms round · photo mode: zoom'],
  ['1–8', 'Time warp levels'],
];
const MODIFIERS = new Set(['shift', 'control', 'alt']);
/** Keys with names (not a character) that can be used. */
const NAMED = new Set(['tab', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown']);

/**
 * Why a key can't be this action's (for the player), or null if it can. Shift, Ctrl and Alt
 * only for what's held to fly: as a key pressed once they'd go off with every browser shortcut,
 * and Shift changes what the other keys type.
 */
export function whyNot(key: string, action: KeyAction): string | null {
  if (FIXED.has(key)) return 'Esc, Enter, the arrow keys, [ ] and 1–8 are fixed';
  if (MODIFIERS.has(key)) return DEFS.get(action)?.hold ? null : 'Shift, Ctrl and Alt can only be held flight controls';
  // (One character, as typed without Shift; or one of the named keys. Not Cmd / Win, the F keys, Caps Lock...)
  if (NAMED.has(key) || ([...key].length === 1 && key === key.toLowerCase())) return null;
  return 'That key can’t be used';
}

/** The keys an action is on now (none: []). */
export function keysOf(action: KeyAction, overrides: KeyOverrides): readonly string[] {
  const o = overrides[action];
  if (o === undefined) return DEFS.get(action)!.keys;
  return o === '' ? [] : [o];
}

/** Every key in use and its action. (After bind / cleanKeys no key is on two; if one were, the first listed has it.) */
export function keyMap(overrides: KeyOverrides): Map<string, KeyAction> {
  const map = new Map<string, KeyAction>();
  for (const d of KEY_ACTIONS) for (const k of keysOf(d.id, overrides)) if (!map.has(k)) map.set(k, d.id);
  return map;
}

/** The action a key does, or null. */
export function actionOf(key: string, overrides: KeyOverrides): KeyAction | null {
  return keyMap(overrides).get(key) ?? null;
}

/** Whether an action's keys are other than its defaults. */
export function isChanged(action: KeyAction, overrides: KeyOverrides): boolean {
  return overrides[action] !== undefined;
}

/** An action that lost a key to another, and the keys it has left. */
export interface KeyLoss {
  action: KeyAction;
  left: readonly string[];
}

export interface KeyChange {
  keys: KeyOverrides;
  /** The actions the key was taken from (to tell the player). */
  lost: KeyLoss[];
}

/** Take `key` from whichever other action has it. */
function take(keys: KeyOverrides, key: string, forAction: KeyAction, lost: KeyLoss[]): void {
  for (const d of KEY_ACTIONS) {
    if (d.id === forAction) continue;
    const had = keysOf(d.id, keys);
    if (!had.includes(key)) continue;
    const left = had.filter((k) => k !== key);
    keys[d.id] = left[0] ?? '';
    lost.push({ action: d.id, left: keysOf(d.id, keys) });
  }
}

/** Drop the changes that say what the defaults say. */
function tidy(keys: KeyOverrides): KeyOverrides {
  for (const d of KEY_ACTIONS) if (d.keys.length === 1 && keys[d.id] === d.keys[0]) delete keys[d.id];
  return keys;
}

/**
 * Put an action on a key. The key must be one whyNot allows (else nothing changes). An action
 * that had the key loses it: it keeps its other key if it had two, otherwise it has none.
 */
export function bind(overrides: KeyOverrides, action: KeyAction, key: string): KeyChange {
  const keys = { ...overrides };
  const lost: KeyLoss[] = [];
  if (whyNot(key, action) !== null) return { keys, lost };
  take(keys, key, action, lost);
  keys[action] = key;
  return { keys: tidy(keys), lost };
}

/** An action back on its default key(s), taking them from any action they were given to since. */
export function resetKey(overrides: KeyOverrides, action: KeyAction): KeyChange {
  const keys = { ...overrides };
  const lost: KeyLoss[] = [];
  delete keys[action];
  for (const k of DEFS.get(action)!.keys) take(keys, k, action, lost);
  return { keys: tidy(keys), lost };
}

/**
 * The changes as read from storage, made safe: unknown actions and keys that can't be used are
 * dropped, and a key claimed twice goes to the later action in the list (as if bound in order).
 */
export function cleanKeys(raw: unknown): KeyOverrides {
  let keys: KeyOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return keys;
  const stored = raw as Record<string, unknown>;
  // (Those left with no key first; then the keys, each taking its own from whoever else has it.)
  for (const d of KEY_ACTIONS) if (stored[d.id] === '') keys[d.id] = '';
  for (const d of KEY_ACTIONS) {
    const k = stored[d.id];
    if (typeof k === 'string' && k !== '' && whyNot(k, d.id) === null) keys = bind(keys, d.id, k).keys;
  }
  return keys;
}

const LABELS: Record<string, string> = {
  ' ': 'Space', shift: '⇧', control: 'Ctrl', alt: 'Alt', tab: 'Tab', backspace: 'Bksp', delete: 'Del', insert: 'Ins', home: 'Home', end: 'End',
  pageup: 'PgUp', pagedown: 'PgDn',
};

/** What to print on a key (as the help does: W, Space, ⇧, Ctrl). spelled: Shift by its name. */
/**
 * The keys in use as the browser names them by position (KeyboardEvent.code), for those it has
 * such a name for: what full screen asks the browser to leave to the game (main.ts).
 */
export function keyCodes(overrides: KeyOverrides): string[] {
  const NAMED: Record<string, string> = { ' ': 'Space', tab: 'Tab', ',': 'Comma', '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', '/': 'Slash', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote' };
  const codes = new Set<string>();
  for (const key of keyMap(overrides).keys()) {
    if (/^[a-z]$/.test(key)) codes.add(`Key${key.toUpperCase()}`);
    else if (/^[0-9]$/.test(key)) codes.add(`Digit${key}`);
    else if (key in NAMED) codes.add(NAMED[key]);
  }
  return [...codes].sort();
}

export function keyLabel(key: string, spelled = false): string {
  if (spelled && key === 'shift') return 'Shift';
  return LABELS[key] ?? key.toUpperCase();
}
