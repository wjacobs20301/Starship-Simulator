// The page round the game: the corner buttons, not losing a flight by accident (closing the tab,
// hiding it), the keyboard in full screen, and the graphics context taken away. (Moved out of
// main.ts: the end of it, from "Corner buttons" to the WebGL context-lost overlay.)

import { onSettingsChange, settings } from '../settings';
import type { ToWorker } from '../worker/protocol';
import type { GameMenu } from './gameMenu';
import { toggleFullscreen } from './gameMenu';
import { held } from './input';
import { withKeyNames } from './keyLabels';
import { keyCodes } from './keys';

export interface WindowChromeDeps {
  canvas: HTMLCanvasElement;
  menu: Pick<GameMenu, 'isOpen'>;
  openPauseMenu(): void;
  /** A flight is under way (not a menu backdrop, not the stack waiting on the pad). */
  inFlight(): boolean;
  /** Keep the flight as it is now (the autosave). */
  askSave(): void;
  send(m: ToWorker): void;
  /** The sim is paused (as the worker last said). */
  paused(): boolean;
  /** A replay is playing, or photo mode is up. */
  replayActive(): boolean;
  inPhoto(): boolean;
}

/** Puts the corner buttons up and the window's listeners on, in that order (once, at load). */
export function installWindowChrome(deps: WindowChromeDeps): void {
  const { canvas, menu, openPauseMenu, inFlight, askSave, send } = deps;
  // Corner buttons: pause menu and full screen (for the mouse; Esc and F do the same).
  {
    const corner = document.createElement('div');
    corner.id = 'corner';
    corner.innerHTML =
      '<button data-act="pause" title="Pause menu (Esc)"><svg viewBox="0 0 16 16"><rect x="4" y="3" width="2.6" height="10"/><rect x="9.4" y="3" width="2.6" height="10"/></svg></button>' +
      '<button data-act="fs" data-tip="Full screen ({key:fullscreen})"><svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>';
    // (The tooltip names the key as the player has it now.)
    const fs = corner.querySelector<HTMLElement>('[data-act="fs"]')!;
    const tip = (): void => { fs.title = withKeyNames(fs.dataset.tip!); };
    tip();
    onSettingsChange(tip);
    corner.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'pause' && !menu.isOpen) openPauseMenu();
      else if (act === 'fs') toggleFullscreen();
    });
    document.body.appendChild(corner);
  }

  // --- Not losing a flight by accident -------------------------------------------------------
  // Closing or reloading the tab mid-flight asks first. (Ctrl is the throttle and W pitches: on
  // Windows and Linux Ctrl+W closes the tab, and no page can stop that key itself.)
  if (!import.meta.env.DEV) {
    window.addEventListener('beforeunload', (e) => {
      if (!inFlight()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }
  // In full screen the browser leaves its shortcuts to the game, where it can (Chrome, Edge).
  document.addEventListener('fullscreenchange', () => {
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
    // (The keys as the player has them now: Ctrl+W with W a flight key is the one that matters.)
    if (document.fullscreenElement) void kb?.lock?.(keyCodes(settings.keys))?.catch(() => {});
    else kb?.unlock?.();
  });
  // The tab hidden or the window minimised: the flight waits behind the pause menu. (The sim runs
  // in a worker, which keeps flying while the page isn't being drawn.)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    held.clear();
    askSave();
    if (inFlight() && !menu.isOpen && !deps.replayActive() && !deps.inPhoto() && !deps.paused()) openPauseMenu();
  });
  // The browser took the graphics context away (a driver restart, too many 3D pages): say so,
  // rather than a frozen picture. (The flight waits; the page has to be loaded again.)
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    // (The flight kept first: it can be taken up again after the reload.)
    askSave();
    if (!deps.paused()) send({ type: 'pause', value: true });
    if (document.querySelector('#gl-lost')) return;
    const box = document.createElement('div');
    box.id = 'gl-lost';
    box.innerHTML =
      '<div class="gl-card"><div class="gl-title">Graphics were reset</div>' +
      '<p>The browser took the graphics card away from this page (a driver restart, or too many 3D tabs open). The flight can’t be drawn any more, but it has been kept: reload the page and choose Continue.</p>' +
      '<button>Reload</button></div>';
    box.querySelector('button')!.addEventListener('click', () => location.reload());
    document.body.append(box);
  });
}
