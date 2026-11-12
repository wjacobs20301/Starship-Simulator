import { onSettingsChange } from '../settings';
import { navigate, padAxes } from './gamepad';
import { KEY_ACTIONS, type KeyAction, type KeyOverrides, keyMap, keysOf } from './keys';

/** Time warp levels: up to 50x runs the full physics, beyond that on rails (coasting above the atmosphere). */
export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 1000, 10000];

// Which key does what is the player's to change (keys.ts has the defaults, settings.keys the
// changes); the keys named in the comments below are the defaults. Esc, Enter, the arrows,
// [ ] and 1-8 are fixed.

export interface InputActions {
  /** Space: start the countdown before launch; stage when flying manually. */
  spaceBar(): void;
  cycleCamera(): void;
  /** Tab: map view on / off. */
  toggleMap(): void;
  cycleTarget(): void;
  setWarp(w: number): void;
  /** , / . : step the warp down / up a level. */
  stepWarp(dir: -1 | 1): void;
  /** O: main menu (before launch). */
  toggleMissions(): void;
  /** N: add a maneuver node / delete it. */
  toggleNode(): void;
  /** Esc: the pause menu (or back out of a menu page). */
  menu(): void;
  /** True while a full-screen menu is up: game keys are ignored. */
  blocked(): boolean;
  togglePlot(): void;
  toggleHelp(): void;
  toggleMute(): void;
  /** F: full screen on / off. */
  toggleFullscreen(): void;
  /**
   * Tower arms: lift +1 up / -1 down / 0 stop, swing +1 open / -1 close / 0 stop, slew (both
   * arms round the tower) +1 counter-clockwise / -1 clockwise / 0 stop.
   */
  arms(lift: -1 | 0 | 1 | null, swing: -1 | 0 | 1 | null, slew?: -1 | 0 | 1 | null): void;
  /** Switch which pad's arms the arrow keys drive. */
  cycleArmsPad(): void;
  /** J: the full event log on / off. */
  toggleLog(): void;
  /** L: take manual control / hand back to the autopilot. */
  toggleManual(): void;
  /** T: SAS on (hold attitude) / off. */
  toggleSas(): void;
  /** G: cycle the active stage's engine set. */
  cycleEngines(): void;
  /** B: deploy the Starlinks (or hold / resume a deployment). */
  deploy(): void;
  /** K: the auto camera (a broadcast director) on / off. */
  toggleDirector(): void;
  /** R: instant replay of the last minutes (or back to live). */
  toggleReplay(): void;
  /** I: photo mode (time frozen, no HUD); Enter saves a picture. */
  togglePhoto(): void;
  savePhoto(): void;
  /** Z: full throttle, X: cut throttle. */
  throttleFull(): void;
  throttleCut(): void;
}

const LIFT: Record<string, 1 | -1> = { arrowup: 1, arrowdown: -1 };
const SWING: Record<string, 1 | -1> = { arrowright: 1, arrowleft: -1 };
/** [ / ]: swing both arms (and what they hold) round the tower. */
const SLEW: Record<string, 1 | -1> = { '[': 1, ']': -1 };
/** What a key pressed once does (the actions held to fly are read each frame instead: flightAxes). */
const PRESS: Partial<Record<KeyAction, (a: InputActions) => void>> = {
  launch: (a) => a.spaceBar(),
  camera: (a) => a.cycleCamera(),
  map: (a) => a.toggleMap(),
  vehicle: (a) => a.cycleTarget(),
  plot: (a) => a.togglePlot(),
  help: (a) => a.toggleHelp(),
  mute: (a) => a.toggleMute(),
  fullscreen: (a) => a.toggleFullscreen(),
  armsPad: (a) => a.cycleArmsPad(),
  log: (a) => a.toggleLog(),
  manual: (a) => a.toggleManual(),
  sas: (a) => a.toggleSas(),
  engines: (a) => a.cycleEngines(),
  deploy: (a) => a.deploy(),
  director: (a) => a.toggleDirector(),
  replay: (a) => a.toggleReplay(),
  photo: (a) => a.togglePhoto(),
  throttleFull: (a) => a.throttleFull(),
  throttleCut: (a) => a.throttleCut(),
  node: (a) => a.toggleNode(),
  mainMenu: (a) => a.toggleMissions(),
  warpDown: (a) => a.stepWarp(-1),
  warpUp: (a) => a.stepWarp(1),
};
/** The actions held down to fly: attitude and throttle. */
const HOLD = new Set<KeyAction>(KEY_ACTIONS.filter((d) => d.hold).map((d) => d.id));

/** Flight keys currently held (as keyOf names them), for continuous flight inputs. */
export const held = new Set<string>();
/**
 * The name each held key went down under, by its place on the keyboard. A key named by what it
 * types has another name once Shift is down (; becomes :): it must come up as what it went down as.
 */
const wentDown = new Map<string, string>();

/** The keys as the player has them: each key's action, and each flight action's keys. */
let keyActions = keyMap({});
const flightKeys = {} as Record<KeyAction, readonly string[]>;
let keysFrom: KeyOverrides | null = null;
onSettingsChange((s) => {
  // (Only when the keys themselves change: a key held to fly stays held through, say, M muting the sound.)
  if (s.keys === keysFrom) return;
  keysFrom = s.keys;
  keyActions = keyMap(s.keys);
  for (const d of KEY_ACTIONS) flightKeys[d.id] = keysOf(d.id, s.keys);
  held.clear();
});

/**
 * Rebinding (the menu's Controls page): the next key pressed goes to `take` instead of doing
 * anything, as keyOf names it, or null for Esc (cancel). It returns whether that settles it
 * (false: keep waiting, for a key that can't be used). Returns a way to call it off.
 */
export function captureKey(take: (key: string | null) => boolean): () => void {
  capture = take;
  return () => {
    if (capture === take) capture = null;
  };
}
let capture: ((key: string | null) => boolean) | null = null;
/** The key just taken for a binding: its release isn't a key press either (Space would press the focused button). */
let swallowUp: string | null = null;

/** The flight keys, by where they are on the keyboard (so WASD / QE sit together on any layout). */
const FLIGHT_CODES: Record<string, string> = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e' };
/** Keys told by position whatever Shift or the layout makes of them (the warp keys, the tower's). */
const PLACED: Record<string, string> = { Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', Space: ' ' };
const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };

/**
 * A key press's name: the flight keys, digits and a few others by their position (an AZERTY or
 * Dvorak keyboard flies with the same fingers, and Shift held for the throttle doesn't turn the
 * warp keys into ! and @), the rest by what's printed on them (M mutes wherever M is).
 */
function keyOf(e: KeyboardEvent): string {
  const c = e.code;
  if (c in FLIGHT_CODES) return FLIGHT_CODES[c];
  if (/^Digit\d$/.test(c)) return c[5];
  if (c in PLACED) return PLACED[c];
  const k = e.key.toLowerCase();
  // (A key that types a flight letter on this layout but isn't one of the flight keys: by its position.)
  if (k.length === 1 && 'wasdqe'.includes(k) && /^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  return k;
}

/** Continuous flight inputs from the held keys and a controller (gamepad.ts): attitude -1..1 and throttle rate. */
export function flightAxes(): { pitch: number; yaw: number; roll: number; throttle: number } {
  const down = (a: KeyAction) => (flightKeys[a].some((k) => held.has(k)) ? 1 : 0);
  const ax = (plus: KeyAction, minus: KeyAction) => down(plus) - down(minus);
  const mix = (k: number, pad: number) => Math.max(-1, Math.min(1, k + pad));
  return {
    pitch: mix(ax('pitchDown', 'pitchUp'), padAxes.pitch),
    yaw: mix(ax('yawRight', 'yawLeft'), padAxes.yaw),
    roll: mix(ax('rollRight', 'rollLeft'), padAxes.roll),
    throttle: mix(ax('throttleUp', 'throttleDown'), padAxes.throttle),
  };
}

export function bindKeys(a: InputActions): void {
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('keyup', (e) => {
    if (swallowUp === e.code) {
      swallowUp = null;
      e.preventDefault();
      return;
    }
    const k = wentDown.get(e.code) ?? keyOf(e);
    wentDown.delete(e.code);
    held.delete(k);
    if (k in LIFT) a.arms(0, null);
    else if (k in SWING) a.arms(null, 0);
    else if (k in SLEW) a.arms(null, null, 0);
  });
  window.addEventListener('keydown', (e) => {
    const k = keyOf(e);
    // A key being chosen for an action (the Controls page): it goes there, and does nothing
    // else: not its action, not the menu's arrows / Enter / Space, not Esc's way out.
    if (capture) {
      // (Cmd / Win shortcuts are the system's, as everywhere here.)
      if (e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // (With Shift, Ctrl or Alt down a key isn't itself: ; types :. Only on its own.)
      const alone = (!e.shiftKey || k === 'shift') && (!e.ctrlKey || k === 'control') && (!e.altKey || k === 'alt');
      if (!alone) return;
      const take = capture;
      if (take(k === 'escape' ? null : k) && capture === take) capture = null;
      swallowUp = e.code;
      return;
    }
    // (Pressed again: the release that was to be passed over never came.)
    if (swallowUp === e.code && !e.repeat) swallowUp = null;
    // Typing in a menu field, or a menu is up: only Esc and full screen get through.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const act = keyActions.get(k);
    if (a.blocked()) {
      held.clear();
      if (k === 'escape' && !e.repeat) a.menu();
      if (act === 'fullscreen' && !e.repeat && !e.metaKey && !e.ctrlKey) a.toggleFullscreen();
      // The menus by keyboard: the arrows move between the buttons and cards (Tab does too),
      // Enter or Space presses the one in focus.
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      if (k in ARROWS) {
        navigate(ARROWS[k]);
        e.preventDefault();
      } else if ((k === 'enter' || k === ' ') && active && active.tagName !== 'BUTTON') {
        // (A card, not a button: the browser doesn't press those itself.)
        if (!e.repeat) active.click();
        e.preventDefault();
      } else if (k === ' ' && !active) e.preventDefault();
      return;
    }
    const flying = act !== undefined && HOLD.has(act);
    if (flying) {
      held.add(k);
      wentDown.set(e.code, k);
    }
    // (What the browser would do with a game key: scroll, move the focus, open its menu, find in page.)
    if (k in LIFT || k in SWING || k === ' ' || k === 'alt' || k === 'tab' || (act && !e.ctrlKey && !e.altKey && !e.metaKey)) e.preventDefault();
    // (Ctrl / Alt are the throttle: with a flight key they're also the browser's save page,
    // bookmark, address bar... Those that can be stopped are. Ctrl+W can't: see main.ts.)
    if ((e.ctrlKey || e.altKey) && !e.metaKey && flying) e.preventDefault();
    if (e.repeat || e.metaKey) return;
    if (k in LIFT) return a.arms(LIFT[k], null);
    if (k in SWING) return a.arms(null, SWING[k]);
    if (k in SLEW) return a.arms(null, null, SLEW[k]);
    if (k === 'enter') a.savePhoto();
    else if (k === 'escape') a.menu();
    else if (/^[1-8]$/.test(k)) a.setWarp(WARP_LEVELS[Number(k) - 1]);
    else if (act) PRESS[act]?.(a);
    // (A keyboard with < > on a key of their own: the warp, as on , and . when nothing else has them.)
    else if (k === '<' || k === '>') a.stepWarp(k === '<' ? -1 : 1);
  });
}
