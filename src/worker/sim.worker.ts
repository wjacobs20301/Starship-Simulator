// Runs the simulation off the main thread at a fixed 100 Hz physics rate
// (times warp), and posts a snapshot ~60 times a second.

import { DT, PHYSICS_WARP_MAX, Simulation } from '../sim/simulation';
import type { FromWorker, ToWorker, WarpTarget } from './protocol';

const sim = new Simulation();
let warp = 1;
let sceneId = 0;
let paused = false;
let accumulator = 0;
let last = performance.now();
const MAX_STEPS_PER_TICK = 2000;
/** Real time between trajectory predictions, ms. */
const PREDICT_EVERY = 400;
let lastPredict = -Infinity;
/** Warping ahead to a point in the flight (the player asked), or null. */
let warpTo: WarpTarget | null = null;
/** Stop warping this long before a maneuver burn starts, s (time to line up and watch it). */
const NODE_LEAD = 30;

/** Sim time a warp-to should stop at, or null if there's nothing to go to. */
function warpToTime(target: WarpTarget): number | null {
  if (target === 'next') return sim.waitUntil;
  const n = sim.nodeSnapshot();
  if (!n) return null;
  return n.t - (Number.isFinite(n.burnTime) ? n.burnTime / 2 : 0) - NODE_LEAD;
}

/**
 * Warp for the time left: whatever leaves ~1.5 s of real time to get there (on a 1-2-5 scale),
 * so it closes in smoothly and gets anywhere in ~10-15 s.
 */
function warpFor(remaining: number): number {
  const want = Math.min(1e5, remaining / 1.5);
  let w = 1;
  for (let decade = 1; decade <= 1e5; decade *= 10) for (const m of [1, 2, 5]) if (m * decade <= want) w = m * decade;
  return w;
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'launch':
      sim.launch();
      break;
    case 'reset':
    case 'scene':
      if (msg.type === 'scene') {
        sim.scene(msg.kind);
        sceneId++;
      }
      else {
        if (msg.pad !== undefined) sim.launchPad = msg.pad;
        sim.boosterOcean = msg.boosterOcean ?? null;
        sim.reset();
        if (msg.start && msg.start !== 'pad') sim.startAt(msg.start);
        sceneId++;
      }
      warpTo = null;
      accumulator = 0;
      lastPredict = -Infinity;
      break;
    case 'warp':
      warp = msg.value;
      warpTo = null;
      break;
    case 'warpTo':
      warpTo = msg.target;
      break;
    case 'pause':
      paused = msg.value;
      break;
    case 'arms':
      sim.commandArms(msg.pad, msg.lift, msg.swing, msg.slew ?? null);
      break;
    case 'pilot':
      sim.pilot.set(msg.cmd);
      break;
    case 'stage':
      sim.stage();
      break;
    case 'node':
      sim.setNode(msg.node);
      lastPredict = -Infinity;
      break;
    case 'return':
      sim.commandReturn(msg.target);
      lastPredict = -Infinity;
      break;
  }
};

setInterval(() => {
  const now = performance.now();
  const real = Math.min((now - last) / 1000, 0.25);
  last = now;
  // Warping ahead: as fast as the time left allows, slowing on the way in, then back to 1x.
  let warpAt: number | null = null;
  if (warpTo && !paused) {
    warpAt = warpToTime(warpTo);
    if (warpAt === null || warpAt - sim.t <= 2) {
      warpTo = null;
      warpAt = null;
      warp = 1;
    } else warp = warpFor(warpAt - sim.t);
  }
  let effectiveWarp = warp;
  let rails = false;
  if (!paused && warp > PHYSICS_WARP_MAX && sim.railsAllowed()) {
    // On rails: coast along the orbits in big steps.
    rails = true;
    accumulator = 0;
    sim.railsStep(real * warp);
  } else if (!paused) {
    effectiveWarp = Math.min(warp, PHYSICS_WARP_MAX);
    accumulator += real * effectiveWarp;
    let n = 0;
    while (accumulator >= DT && n < MAX_STEPS_PER_TICK) {
      sim.step(DT);
      accumulator -= DT;
      n++;
    }
    if (n === MAX_STEPS_PER_TICK) accumulator = 0; // can't keep up: drop time rather than spiral
  }
  const out: FromWorker = { type: 'snapshot', snapshot: sim.snapshot(), warp, effectiveWarp, rails, paused, sceneId, warpTo: warpTo && warpAt !== null ? { target: warpTo, at: warpAt } : null };
  if (now - lastPredict >= PREDICT_EVERY) {
    lastPredict = now;
    out.trajectories = sim.predictTrajectories();
  }
  self.postMessage(out);
}, 1000 / 60);
