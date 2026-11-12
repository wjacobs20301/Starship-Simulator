// What's behind the main menu: the backdrop scenes (game/menuScenes.ts) changing through a fade to
// black, and the Free Roam page's view of the pad picked, gliding from one tower to the other.
// (Moved out of main.ts: its main menu backdrops, from randomScene to padCaption, and the parts
// of frame() that turn and frame the view behind the menu.)

import * as THREE from 'three';
import type { CameraRig } from '../render/cameras';
import { type StarbaseWeather, WEATHER_AVAILABLE, WEATHER_NAME, settings } from '../settings';
import { MOUNTS } from '../sim/padCollision';
import type { GameMenu } from '../ui/gameMenu';
import type { ToWorker } from '../worker/protocol';
import { MENU_SCENES, SCENE_SECONDS } from './menuScenes';

export interface MenuBackdropDeps {
  menu: Pick<GameMenu, 'kind' | 'setCaption'>;
  rig: CameraRig;
  /** A new scene is settling in (the frame pacing doesn't judge its first frames). */
  settle(): void;
  /** Ask the worker for a scene (counted: workerReady says when it has it). */
  sendScene(m: ToWorker): void;
  /** The worker has caught up with the last scene / mission set-up asked for. */
  workerReady(): boolean;
  /**
   * Set the world up for a scene: its weather over Starbase (null: the setting's), a new day, no
   * blasts, normal speed, the camera on `track` (autopilot), orbiting it.
   */
  enter(weather: StarbaseWeather | null, track: string): void;
  /** The last flight's plot, log, mission and results cleared. */
  cleared(): void;
  /** The weather over Starbase now (named in the caption). */
  weatherToday(): StarbaseWeather;
  /** Free roam's weather pick as a day's weather ('Starbase' rolls one). */
  pickFreeWeather(): StarbaseWeather;
  /** A scene's own weather over Starbase, blended into from the sky there is (morph). */
  setWeather(weather: StarbaseWeather, morph: boolean): void;
}

export interface MenuBackdrop {
  /** Show backdrop scene i (MENU_SCENES) at once. */
  showScene(i: number): void;
  /** Fade to black, swap the backdrop, fade back in (the menu's › button, and every so often). */
  changeScene(): void;
  /** The Free Roam page's pad (null: the rotating backdrops). */
  backdrop(pad: number | null): void;
  /** A flight is starting: no pad on view. */
  clearPadView(): void;
  /** Free roam's weather setting changed: true if the menu's pad view took it (else it's the flight's). */
  freeWeatherChanged(): boolean;
  /** Each frame: the view turning round behind the main menu, the scenes changing, the glide between towers. */
  tick(frameDt: number, now: number): void;
  /** Where the camera aims in the menu's pad view (null: not on view). */
  aim(now: number): THREE.Vector3 | null;
  /** How far right of centre (fraction of the width) the view is framed, clear of the main menu. */
  shift(): number;
}

export function createMenuBackdrop(deps: MenuBackdropDeps): MenuBackdrop {
  const { menu, rig } = deps;
  // Main menu backdrops: the sim sets each one up (Simulation.scene); the camera frames it and turns
  // slowly round it. They change every so often (or on the menu's › button) through a fade to black.
  let sceneIndex = -1;
  let sceneTime = 0;
  let sceneChanging = false;
  let sceneHold = 0;
  const sceneFade = document.createElement('div');
  sceneFade.id = 'scene-fade';
  document.body.appendChild(sceneFade);

  function randomScene(): number {
    const others = MENU_SCENES.map((_, i) => i).filter((i) => i !== sceneIndex);
    return others[Math.floor(Math.random() * others.length)];
  }

  function showScene(i: number): void {
    deps.settle();
    const sc = MENU_SCENES[i];
    sceneIndex = i;
    sceneTime = 0;
    deps.sendScene({ type: 'scene', kind: sc.kind });
    deps.enter(sc.weather ?? null, sc.track);
    const [a0, a1] = sc.azimuth ?? [0, Math.PI * 2];
    rig.azimuth = a0 + Math.random() * (a1 - a0);
    rig.elevation = sc.elevation;
    rig.distance = sc.distance;
    // (Hold the framing for a moment: until the new scene's snapshots arrive, the camera may be
    // aiming at the old one and get pushed up out of the ground.)
    sceneHold = performance.now() + 1500;
    deps.cleared();
    // (With the weather off, a caption's weather part (after a '·' naming it) is dropped.)
    menu.setCaption((WEATHER_AVAILABLE ? sc.caption : sc.caption.replace(/ · (rain|morning fog).*$/, '')).toUpperCase());
  }

  /** Fade to black, swap the backdrop, fade back in. */
  function changeScene(): void {
    fadeTo(() => showScene(randomScene()));
  }

  /** Fade to black, put up a backdrop (`show`), and fade back in once the worker has it. */
  function fadeTo(show: () => void): void {
    if (menu.kind !== 'main') return;
    if (sceneChanging) {
      // (Mid-fade: whatever is asked for last goes up.)
      fadeNext = show;
      return;
    }
    sceneChanging = true;
    fadeNext = show;
    sceneFade.classList.add('on');
    window.setTimeout(() => {
      if (menu.kind === 'main') fadeNext?.();
      fadeNext = null;
      // Fade back in once the worker has the new scene up (some take a moment to compute), plus a
      // moment for its first frames to arrive.
      const started = performance.now();
      const wait = () => {
        if (!deps.workerReady() && performance.now() - started < 8000) return void window.setTimeout(wait, 100);
        window.setTimeout(() => {
          sceneFade.classList.remove('on');
          sceneChanging = false;
        }, 350);
      };
      wait();
    }, 900);
  }

  let fadeNext: (() => void) | null = null;

  // The main menu's Free Roam page: the pad picked, seen from the ground, in the weather picked.
  // Picking the other pad glides the camera over to its tower; picking other weather blends the sky
  // into it (WeatherSystem's transition).
  /** The pad on view (null: the rotating backdrops). */
  let padView: number | null = null;
  const PAD_GLIDE_MS = 2600;
  const padAim = { from: new THREE.Vector3(), to: new THREE.Vector3(), start: 0, sent: true, pad: 0 };
  /** A pad's launch mount, half way up the stack (world). */
  const mountWorld = (pad: number) => {
    const [e, n] = MOUNTS[pad] ?? [0, 0];
    return new THREE.Vector3(e, 95, -n);
  };
  /** Where the camera aims now, gliding from one tower to the other. */
  function padAimNow(now: number): THREE.Vector3 {
    const f = Math.min(1, Math.max(0, (now - padAim.start) / PAD_GLIDE_MS));
    return padAim.from.clone().lerp(padAim.to, f * f * (3 - 2 * f));
  }

  function menuBackdrop(pad: number | null): void {
    if (pad === null) {
      if (padView === null) return;
      padView = null;
      changeScene();
      return;
    }
    if (padView === null) {
      padView = pad;
      fadeTo(() => showPadScene(padView ?? pad));
      return;
    }
    if (pad === padView) return;
    // Over to the other tower: the camera glides; the stack moves there half way.
    padView = pad;
    const now = performance.now();
    padAim.from.copy(padAimNow(now));
    padAim.to.copy(mountWorld(pad));
    padAim.start = now;
    padAim.sent = false;
    padAim.pad = pad;
    padCaption();
  }

  function showPadScene(pad: number): void {
    deps.settle();
    sceneIndex = -1;
    sceneTime = 0;
    deps.sendScene({ type: 'scene', kind: 'pad', pad });
    deps.enter(deps.pickFreeWeather(), 'stack');
    // (From the ground, ~30 m up, looking up at the tower and the stack against the sky.)
    rig.azimuth = -2.3 + (Math.random() - 0.5) * 0.6;
    rig.elevation = -0.072;
    rig.distance = 900;
    padAim.from.copy(mountWorld(pad));
    padAim.to.copy(padAim.from);
    padAim.start = 0;
    padAim.sent = true;
    padAim.pad = pad;
    deps.cleared();
    padCaption();
  }

  function padCaption(): void {
    if (padView === null) return;
    menu.setCaption(`PAD ${padView + 1}${WEATHER_AVAILABLE && settings.clouds ? ` · ${WEATHER_NAME[deps.weatherToday()]}` : ''}`.toUpperCase());
  }

  return {
    showScene,
    changeScene,
    backdrop: menuBackdrop,
    clearPadView: () => {
      padView = null;
    },
    freeWeatherChanged: () => {
      if (menu.kind === 'main' && padView !== null && !sceneChanging) {
        // The menu's pad view: the sky turns into the weather picked.
        deps.setWeather(deps.pickFreeWeather(), true);
        padCaption();
        return true;
      }
      return false;
    },
    tick: (frameDt, now) => {
      // Main menu: the view turns slowly round the pad behind it.
      if (menu.kind === 'main' && !rig.map && rig.mode === 'orbit') rig.azimuth += frameDt * 0.035;
      if (menu.kind === 'main' && padView === null && (sceneTime += frameDt) > (MENU_SCENES[sceneIndex]?.seconds ?? SCENE_SECONDS)) changeScene();
      if (menu.kind === 'main' && padView !== null && !padAim.sent && now - padAim.start > PAD_GLIDE_MS * 0.45) {
        padAim.sent = true;
        deps.sendScene({ type: 'scene', kind: 'pad', pad: padAim.pad });
      }
      if (menu.kind === 'main' && now < sceneHold && sceneIndex >= 0) rig.elevation = MENU_SCENES[sceneIndex].elevation;
    },
    // (The menu's pad view: on the tower picked, gliding between them.)
    aim: (now) => (menu.kind === 'main' && padView !== null ? padAimNow(now) : null),
    shift: () => (padView !== null ? 0.26 : ((sceneIndex >= 0 ? MENU_SCENES[sceneIndex].shift : undefined) ?? 0.4)),
  };
}
