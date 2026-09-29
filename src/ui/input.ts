/** Time warp levels: up to 50x runs the full physics, beyond that on rails (coasting above the atmosphere). */
export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 1000, 10000];

export interface InputActions {
  /** Space: start the countdown before launch; stage when flying manually. */
  spaceBar(): void;
  reset(): void;
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
  /** Z: full throttle, X: cut throttle. */
  throttleFull(): void;
  throttleCut(): void;
}

const LIFT: Record<string, 1 | -1> = { arrowup: 1, arrowdown: -1 };
const SWING: Record<string, 1 | -1> = { arrowright: 1, arrowleft: -1 };
/** [ / ]: swing both arms (and what they hold) round the tower. */
const SLEW: Record<string, 1 | -1> = { '[': 1, ']': -1 };
/** Flight keys held down: attitude and throttle. */
const HELD = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift', 'control', 'alt']);

/** Keys currently held (lower-case e.key), for continuous flight inputs. */
export const held = new Set<string>();

/** Continuous flight inputs from the held keys: attitude -1..1 and throttle direction. */
export function flightAxes(): { pitch: number; yaw: number; roll: number; throttle: number } {
  const ax = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
  return {
    pitch: ax('w', 's'),
    yaw: ax('d', 'a'),
    roll: ax('e', 'q'),
    throttle: (held.has('shift') ? 1 : 0) - (held.has('control') || held.has('alt') ? 1 : 0),
  };
}

export function bindKeys(a: InputActions): void {
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    held.delete(k);
    if (k in LIFT) a.arms(0, null);
    else if (k in SWING) a.arms(null, 0);
    else if (k in SLEW) a.arms(null, null, 0);
  });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    // Typing in a menu field, or a menu is up: only Esc and F (full screen) get through.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (a.blocked()) {
      held.clear();
      if (k === 'escape' && !e.repeat) a.menu();
      if (k === 'f' && !e.repeat && !e.metaKey && !e.ctrlKey) a.toggleFullscreen();
      if (k === ' ' || k === 'tab') e.preventDefault();
      return;
    }
    if (HELD.has(k)) held.add(k);
    if (k in LIFT || k in SWING || k === ' ' || k === 'alt' || k === 'tab') e.preventDefault();
    if (e.repeat || e.metaKey) return;
    if (k in LIFT) return a.arms(LIFT[k], null);
    if (k in SWING) return a.arms(null, SWING[k]);
    if (k in SLEW) return a.arms(null, null, SLEW[k]);
    if (k === ' ') a.spaceBar();
    else if (k === 'backspace') a.reset();
    else if (k === 'c') a.cycleCamera();
    else if (k === 'tab') a.toggleMap();
    else if (k === 'v') a.cycleTarget();
    else if (k === 'p') a.togglePlot();
    else if (k === 'h') a.toggleHelp();
    else if (k === 'm') a.toggleMute();
    else if (k === 'f') a.toggleFullscreen();
    else if (k === 'u') a.cycleArmsPad();
    else if (k === 'j') a.toggleLog();
    else if (k === 'l') a.toggleManual();
    else if (k === 't') a.toggleSas();
    else if (k === 'g') a.cycleEngines();
    else if (k === 'z') a.throttleFull();
    else if (k === 'x') a.throttleCut();
    else if (k === 'escape') a.menu();
    else if (k === 'n') a.toggleNode();
    else if (k === 'o') a.toggleMissions();
    else if (k === ',' || k === '<') a.stepWarp(-1);
    else if (k === '.' || k === '>') a.stepWarp(1);
    else if (/^[1-8]$/.test(k)) a.setWarp(WARP_LEVELS[Number(k) - 1]);
  });
}
