// A game controller (the browser's standard mapping: Xbox / PlayStation layout), polled each
// frame. In flight:
//   left stick       pitch (forward: nose down, as W) and yaw
//   LB / RB          roll left / right
//   LT / RT          throttle down / up (the further pressed, the faster)
//   right stick      camera round the vehicle; click it in to zoom (stick up / down while held)
//   A                launch / stage           B   SAS on / off
//   X                engine set               Y   next camera
//   D-pad up / down  time warp up / down      D-pad left  next vehicle   D-pad right  manual / autopilot
//   View (Back)      map                      Menu (Start) pause menu
//   L3 (left click)  Starlink deploy
// In the menus: D-pad or left stick moves between buttons, A presses, B goes back.

import type { InputActions } from './input';

/** Standard-mapping button indices. */
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const DEAD = 0.14;

/** The controller's continuous flight inputs (merged with the keys in flightAxes). */
export const padAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0 };

/** Rescaled past the dead zone, curved for finer control near the middle. */
function axis(v: number): number {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  const t = (a - DEAD) / (1 - DEAD);
  return Math.sign(v) * t * (0.35 + 0.65 * t);
}

export interface PadCamera {
  /** Turn the view round its target (rad) and zoom (a factor). */
  orbit(dAzimuth: number, dElevation: number, zoom: number): void;
}

export class GamepadInput {
  private prev: boolean[] = [];
  /** Menus: when the stick was last moved to the next button (s), for auto-repeat. */
  private navAt = 0;
  private navDir = '';
  /** Whether a controller was there last poll (for the connect note). */
  connected = false;

  constructor(
    private a: InputActions,
    private camera: PadCamera,
    private onConnect: (name: string | null) => void,
  ) {
    window.addEventListener('gamepadconnected', (e) => this.onConnect((e as GamepadEvent).gamepad.id));
    window.addEventListener('gamepaddisconnected', () => this.onConnect(null));
  }

  /** Each frame. dt: real seconds. */
  poll(dt: number): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected) ?? null;
    padAxes.pitch = padAxes.yaw = padAxes.roll = padAxes.throttle = 0;
    this.connected = !!gp;
    if (!gp) return;
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const v = (i: number) => gp.buttons[i]?.value ?? 0;
    const pressed = (i: number) => b(i) && !this.prev[i];
    const blocked = this.a.blocked();

    if (blocked) {
      // The menus: move between buttons, press, back out.
      const lx = gp.axes[0] ?? 0, ly = gp.axes[1] ?? 0;
      const dir = b(BTN.UP) || ly < -0.6 ? 'up' : b(BTN.DOWN) || ly > 0.6 ? 'down' : b(BTN.LEFT) || lx < -0.6 ? 'left' : b(BTN.RIGHT) || lx > 0.6 ? 'right' : '';
      const now = performance.now() / 1000;
      if (dir && (dir !== this.navDir || now - this.navAt > 0.28)) {
        navigate(dir as 'up' | 'down' | 'left' | 'right');
        this.navAt = now + (dir !== this.navDir ? 0.2 : 0);
      }
      this.navDir = dir;
      if (pressed(BTN.A)) (document.activeElement as HTMLElement | null)?.click();
      if (pressed(BTN.B) || pressed(BTN.MENU)) this.a.menu();
    } else {
      this.navDir = '';
      // Flight.
      padAxes.pitch = -axis(gp.axes[1] ?? 0);
      padAxes.yaw = axis(gp.axes[0] ?? 0);
      padAxes.roll = (b(BTN.RB) ? 1 : 0) - (b(BTN.LB) ? 1 : 0);
      padAxes.throttle = v(BTN.RT) - v(BTN.LT);
      // The camera: the right stick turns it, or with the stick clicked in, zooms.
      const rx = axis(gp.axes[2] ?? 0), ry = axis(gp.axes[3] ?? 0);
      if (rx || ry) {
        if (b(BTN.R3)) this.camera.orbit(0, 0, Math.exp(ry * dt * 2.2));
        else this.camera.orbit(-rx * dt * 1.8, ry * dt * 1.4, 1);
      }
      if (pressed(BTN.A)) this.a.spaceBar();
      if (pressed(BTN.B)) this.a.toggleSas();
      if (pressed(BTN.X)) this.a.cycleEngines();
      if (pressed(BTN.Y)) this.a.cycleCamera();
      if (pressed(BTN.UP)) this.a.stepWarp(1);
      if (pressed(BTN.DOWN)) this.a.stepWarp(-1);
      if (pressed(BTN.LEFT)) this.a.cycleTarget();
      if (pressed(BTN.RIGHT)) this.a.toggleManual();
      if (pressed(BTN.VIEW)) this.a.toggleMap();
      if (pressed(BTN.MENU)) this.a.menu();
      if (pressed(BTN.L3)) this.a.deploy();
    }
    this.prev = gp.buttons.map((x) => x.pressed);
  }
}

/** Move the focus to the nearest button that way (the menus' buttons and cards). */
export function navigate(dir: 'up' | 'down' | 'left' | 'right'): void {
  // (Within what's up front: the menu, else the results screen.)
  const menu = document.querySelector<HTMLElement>('#menu:not(.closed)');
  const results = document.querySelector<HTMLElement>('.results:not(.hidden)');
  const scope: ParentNode = menu ?? results ?? document;
  const all = [...scope.querySelectorAll<HTMLElement>('button, .mn-card, [data-nav]')].filter((el) => {
    if (el.closest('.hidden') || (el as HTMLButtonElement).disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  if (!all.length) return;
  for (const el of all) if (!el.hasAttribute('tabindex') && el.tagName !== 'BUTTON') el.tabIndex = 0;
  const cur = document.activeElement as HTMLElement | null;
  const mark = (el: HTMLElement) => {
    for (const o of document.querySelectorAll('.gp-focus')) o.classList.remove('gp-focus');
    el.classList.add('gp-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  };
  if (!cur || !all.includes(cur)) {
    mark(all[0]);
    return;
  }
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    if (along <= 4) continue;
    const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    const score = along + across * 2.5;
    if (score < bestScore) [bestScore, best] = [score, el];
  }
  if (best) mark(best);
}
