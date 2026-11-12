// The screen over the start of a flight until it's ready to look at, and the launch pad's ground
// loaded ahead while the main menu is up. (Moved out of main.ts: its preparing screen,
// framesDrawn, showPreparing and warmPad.)

import * as THREE from 'three';
import { type FlightView, workerCaughtUp } from '../game/flightView';
import type { MissionDef } from '../game/missions';
import type { ModelLibrary } from '../render/models';
import type { World } from '../render/scene';
import type { Terrain } from '../render/terrain';
import { MOUNTS } from '../sim/padCollision';

export interface PreparingDeps {
  /** The mission (named on the screen). */
  tracker: { readonly mission: MissionDef };
  /** The worker's count of scenes (ready when it has the new flight) and the launch pad (its ground warmed). */
  flight: FlightView;
  terrain: Terrain;
  world: World;
  /** The vehicles' models (null until they've loaded). */
  models(): ModelLibrary | null;
}

export interface Preparing {
  /** Cover the start of a new flight until it's ready (midFlight: a mission starting part-way through, shown at once). */
  showPreparing(midFlight: boolean): void;
  /** A frame was drawn. */
  frameDrawn(): void;
  /** Load the launch pad's ground ahead, as the launch camera will see it. */
  warmPad(): void;
}

/** Puts the screen up (hidden) in the page now. */
export function createPreparing(deps: PreparingDeps): Preparing {
  const { tracker, flight, terrain, world } = deps;
  // A screen covers the start of a flight until it's ready to look at: a mission starting part-way
  // through a flight (the worker runs one ahead to there, a second or two), and the ground around
  // the camera streamed in at full detail (the first time, a few seconds).
  const preparing = document.createElement('div');
  preparing.id = 'preparing';
  preparing.innerHTML = '<div class="pp-title"></div><div class="pp-name"></div><div class="pp-bar"><i></i></div><div class="pp-sub"></div>';
  document.body.appendChild(preparing);
  /** Frames drawn so far (the loading screen waits for the camera to have moved to the new flight). */
  let framesDrawn = 0;
  /** Longest the screen waits for the ground (a slow connection flies with it still arriving), ms. */
  const PREPARING_MAX_MS = 20000;
  let preparingRun = 0;

  function showPreparing(midFlight: boolean): void {
    const run = ++preparingRun;
    preparing.querySelector('.pp-title')!.textContent = midFlight ? 'Preparing mission' : 'Loading';
    preparing.querySelector('.pp-name')!.textContent = tracker.mission.title;
    const sub = preparing.querySelector<HTMLElement>('.pp-sub')!;
    sub.textContent = '';
    const started = performance.now();
    let settled = 0;
    let shown = false;
    /** Frames drawn once the worker had the new flight (the camera takes a few to get there). */
    let readyAt: number | null = null;
    const wait = () => {
      if (run !== preparingRun) return;
      const waited = performance.now() - started;
      if (readyAt === null && workerCaughtUp(flight)) readyAt = framesDrawn;
      const ground = terrain.ready ? terrain.pendingInView : Infinity;
      const ready = readyAt !== null && framesDrawn >= readyAt + 5 && deps.models() !== null && ground === 0;
      // (Ready at once, as when the ground is already loaded: no screen at all.)
      settled = ready ? settled + 1 : 0;
      if (settled >= 3 || waited > PREPARING_MAX_MS) {
        if (shown) window.setTimeout(() => preparing.classList.remove('on'), 300);
        return;
      }
      if (!shown && (midFlight || waited > 150)) {
        shown = true;
        preparing.classList.add('on');
      }
      sub.textContent = !workerCaughtUp(flight) ? '' : deps.models() === null ? 'Loading models' : Number.isFinite(ground) && ground > 0 ? `Loading terrain · ${ground} tile${ground === 1 ? '' : 's'}` : 'Loading terrain';
      window.setTimeout(wait, 100);
    };
    wait();
  }

  /**
   * While the main menu is up: load the launch pad's ground ahead (as the launch camera will see it),
   * so a launch starts with it there.
   */
  const warmCam = new THREE.PerspectiveCamera(50, 1, 1, 5e6);
  function warmPad(): void {
    const [e, n] = MOUNTS[flight.launchPad] ?? [0, 0];
    const target = new THREE.Vector3(e, 70, -n);
    const [az, el, d] = [-2.3, 0.12, 420]; // (the orbit camera's starting view, cameras.ts)
    const pos = target.clone().add(new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(d));
    warmCam.aspect = world.camera.aspect;
    warmCam.updateProjectionMatrix();
    warmCam.position.set(0, 0, 0);
    warmCam.lookAt(target.clone().sub(pos));
    terrain.warm(warmCam, [pos.x, pos.y, pos.z]);
  }

  return {
    showPreparing,
    frameDrawn: () => {
      framesDrawn++;
    },
    warmPad,
  };
}
