// Render resolution and frame pacing: how many pixels a frame is drawn at, and how often one is
// drawn, to hold a steady rate on this machine and display.
//
// The GPU work is mostly per pixel (the scene, atmosphere, bloom), so resolution is the big
// lever. Auto: start at the display's full density and adjust every ~45 frames to hold the
// frame rate (down quickly when frames are late, back up slowly, not retrying a level that
// failed for a while).
//
// What "late" is: more than an eighth of the frames taking over the time they have (the slower
// frames, not the median: on a 120 Hz display, frames alternating 8 and 25 ms have a fine median
// and judder all the same). Whether fewer pixels would help can't be told from the script's time
// (drawing blocks on the GPU when it's behind, so a GPU-bound frame looks script-bound too), so
// the steps down are simply tried, and all undone for a while if the bottom is reached and the
// frames are still late (a slow script, or a browser holding the page to a lower rate).
//
// On a display faster than 60 Hz that the frames can't keep up with, they're drawn every second
// refresh (or as many as make ~60 a second) instead: evenly spaced, rather than whenever each
// one is done.

import { onSettingsChange, settings } from '../settings';
import type { World } from './scene';

export interface FramePacing {
  /** Each animation frame, drawn or not. ts: its time (ms). */
  watchRefresh(ts: number): void;
  /** Whether this animation frame is one to leave out (sinceLast: ms since the last frame drawn). */
  skip(sinceLast: number): boolean;
  /**
   * After each frame drawn. gapMs: since the one before; cpuMs: the last frame's script time
   * (drawing included, which waits on the GPU when it's behind); otherMs: that without the drawing.
   */
  govern(gapMs: number, cpuMs: number, otherMs: number, now: number): void;
  /** A new flight or scene is settling in: its first frames aren't judged. */
  settle(ms?: number): void;
  /** For the debug console. */
  state(): { vsyncMs: number; frameEvery: number; cloudLevel: number; pixelRatio: number };
}

/** pendingTiles: how many of the ground's tiles in view are still loading (frames are late then for that). */
export function createFramePacing(world: World, pendingTiles: () => number): FramePacing {
  const NATIVE_PR = Math.min(window.devicePixelRatio || 1, 2);
  const MIN_PR = Math.max(0.6, NATIVE_PR * 0.5);
  let pixelRatio = NATIVE_PR;
  const frameGaps: number[] = [];
  const frameCpu: number[] = [];
  const frameOther: number[] = [];
  let goodWindows = 0;
  let failedPr = Infinity;
  let failedUntil = 0;
  /** No steps down until then (they didn't help: see above), ms. */
  let holdUntil = 0;
  /** How late the frames were at the full picture, when the steps down began (ms). */
  let lateAtBest = Infinity;
  /** When the resolution was last stepped back up, and how long a failed level waits for its next try (ms). */
  let raisedAt = -Infinity;
  let retryWait = 60000;
  /** A new flight or scene is settling in until then (its first frames aren't judged), ms. */
  let settleUntil = 0;

  /** The display's refresh interval, ms: the shortest spacing of the animation frames seen. */
  let vsyncMs = 1000 / 60;
  const rafGaps: number[] = [];
  /** The last window's reading of it (see watchRefresh). */
  let vsyncSeen = 0;
  let lastRaf = 0;
  /** A frame is drawn every this many refreshes (1, or what makes ~60 a second on a faster display). */
  let frameEvery = 1;
  /** When the display's full rate may be tried again, and how long to wait after the next failure, ms. */
  let fullRateAt = 0;
  let fullRateWait = 30000;
  /** Refreshes per frame at about 60 frames a second (1 on a 60 - 90 Hz display, 2 at 120 - 144). */
  const sixtyEvery = () => Math.max(1, Math.round(1000 / 60 / vsyncMs - 0.01));

  /** Each animation frame, drawn or not. ts: its time (ms). */
  function watchRefresh(ts: number): void {
    if (lastRaf && !document.hidden) {
      const g = ts - lastRaf;
      if (g > 2 && g < 100) rafGaps.push(g);
      if (rafGaps.length >= 90) {
        rafGaps.sort((x, y) => x - y);
        // The display's own interval: animation frames come a whole number of refreshes apart
        // (a late frame spans two or three), so it's the longest interval that divides nearly
        // all the spacings seen: 16.7 and 25 ms apart is a 120 Hz display missing refreshes, not
        // a 60 Hz one. Taken once two windows running agree, and afresh each time, never only
        // downward: a throttled or hidden page delivers its frames in bursts, a few close
        // together, which read as a faster display than there is; kept, that held the game to a
        // third of its frames once the page was back in view.
        const base = Math.max(4, rafGaps[27]);
        let seen = base;
        for (const k of [1, 2, 3, 4]) {
          const v = base / k;
          const fits = rafGaps.reduce((n, g) => n + (Math.abs(g - Math.round(g / v) * v) < 0.15 * v ? 1 : 0), 0);
          if (fits >= 0.9 * rafGaps.length) {
            seen = v;
            break;
          }
        }
        if (seen >= 4 && Math.abs(seen - vsyncSeen) < 0.1 * seen) vsyncMs = 0.5 * (seen + vsyncSeen);
        vsyncSeen = seen;
        rafGaps.length = 0;
        if (frameEvery > sixtyEvery()) frameEvery = sixtyEvery();
      }
    }
    lastRaf = ts;
  }

  /** The clouds' resolution levels (pixels per screen point): the governor's first lever. */
  // (The last two for the heaviest skies, a thunderstorm overhead: soft, dark cloud that shows it least.)
  const CLOUD_LEVELS = [1.25, 1.0, 0.8, 0.65, 0.5];
  let cloudLevel = 0;
  /** The best cloud level the Settings' detail allows (0 on 'high'). */
  let cloudBest = 0;
  // The Settings' detail: coarser clouds and shadows on 'medium'; no shadows or glow on 'low'.
  onSettingsChange((s) => {
    cloudBest = s.detail === 'high' ? 0 : s.detail === 'medium' ? 1 : 2;
    cloudLevel = Math.max(cloudLevel, cloudBest);
    world.setCloudDensity(CLOUD_LEVELS[cloudLevel]);
    world.shadowMax = s.detail === 'high' ? 4096 : 2048;
    world.sun.castShadow = s.detail !== 'low';
    world.bloom.enabled = s.detail !== 'low';
    world.shadowsDirty();
  });

  /**
   * gapMs: since the last frame drawn; cpuMs: the last frame's script time (drawing included, which
   * waits on the GPU when it's behind); otherMs: that without the drawing.
   */
  function governResolution(gapMs: number, cpuMs: number, otherMs: number, now: number): void {
    const fixed = settings.renderScale;
    const auto = fixed === 'auto';
    if (!auto) {
      pixelRatio = Math.max(0.5, NATIVE_PR * fixed);
      world.setPixelRatio(pixelRatio);
      cloudLevel = cloudBest;
      world.setCloudDensity(CLOUD_LEVELS[cloudLevel]);
    }
    // (Not while a new scene is settling or its ground still streaming in: those frames are late
    // for their own reasons, and stepping the resolution down for them takes minutes to undo.)
    if (document.hidden || gapMs > 250) return;
    if (now < settleUntil || pendingTiles() > 0) {
      frameGaps.length = frameCpu.length = frameOther.length = 0;
      return;
    }
    frameGaps.push(gapMs);
    frameCpu.push(cpuMs);
    frameOther.push(otherMs);
    if (frameGaps.length < 45) return;
    const at = (a: number[], f: number) => a.sort((x, y) => x - y)[Math.floor(a.length * f)];
    // (The slower frames: late if more than about one in eight is. At one in five, a view just over
    // budget dropped a frame every half second and was let be.)
    const late = at(frameGaps, 0.88);
    const cpu = at(frameCpu, 0.5);
    const other = at(frameOther, 0.5);
    frameGaps.length = 0;
    frameCpu.length = 0;
    frameOther.length = 0;
    const target = frameEvery * vsyncMs;
    if (late > target * 1.25) {
      goodWindows = 0;
      if (frameEvery < sixtyEvery()) {
        // A fast display the frames can't keep up with: every second refresh, evenly.
        frameEvery = sixtyEvery();
        fullRateAt = now + fullRateWait;
        fullRateWait = Math.min(600000, fullRateWait * 2);
        return;
      }
      // (The script alone over the time there is: fewer pixels can't help.)
      if (!auto || now < holdUntil || other > target * 0.75) return;
      // Fewer pixels. The clouds' first (soft, they show a lower resolution least, and they're a
      // third of the frame or more), then the screen's. (Not retried for a minute: every change of
      // resolution resizes the buffers and restarts the clouds' history, a visible hitch, so it
      // shouldn't bounce between two levels.)
      // (A step back up that didn't hold: twice as long before the next try, up to ten minutes.
      // At a view that just fits, a try every minute was a hitch every minute.)
      if (now - raisedAt < 20000) retryWait = Math.min(600000, retryWait * 2);
      failedUntil = now + retryWait;
      if (pixelRatio >= NATIVE_PR - 1e-3 && cloudLevel === cloudBest) lateAtBest = late;
      // (Well short of the rate, a bigger step: at one small step a window, a view twice too
      // heavy took ten seconds to come right.)
      const far = late > target * 1.6;
      const last = CLOUD_LEVELS.length - 1;
      if (cloudLevel < last) cloudLevel = Math.min(last, cloudLevel + (far ? 2 : 1));
      else if (pixelRatio > MIN_PR + 1e-3) {
        failedPr = pixelRatio;
        pixelRatio = Math.max(MIN_PR, pixelRatio * (far ? 0.72 : 0.85));
      } else if (late > lateAtBest * 0.85) {
        // At the bottom and no better for it: it isn't the pixels (a slow script, a browser
        // holding the page to a lower rate). Back to the full picture for a while.
        pixelRatio = NATIVE_PR;
        cloudLevel = cloudBest;
        failedPr = Infinity;
        holdUntil = now + 300000;
      }
      // (Else: better, if still short of the rate. The fewest pixels there are: it stays there.
      // Going back to the full picture then, as this once did, gave up a frame rate twice as good.)
    } else if (late < target * 1.1) {
      if (++goodWindows >= 6) {
        // Room to spare: the screen's resolution back first, then the clouds', then the display's
        // full rate (if a frame's work looks to fit in one refresh).
        const next = Math.min(NATIVE_PR, pixelRatio * 1.12);
        if (auto && next > pixelRatio && !(next >= failedPr && now < failedUntil)) {
          pixelRatio = next;
          raisedAt = now;
          goodWindows = 0;
        } else if (auto && next <= pixelRatio && cloudLevel > cloudBest && now >= failedUntil) {
          cloudLevel--;
          raisedAt = now;
          goodWindows = 0;
        } else if (frameEvery > 1 && now >= fullRateAt && cpu < vsyncMs * 0.6 && (!auto || (next <= pixelRatio && cloudLevel === cloudBest))) {
          frameEvery = 1;
          goodWindows = 0;
        } else if (frameEvery === 1 && goodWindows >= 60) fullRateWait = 30000;
      }
    } else goodWindows = 0;
    if (auto) {
      world.setPixelRatio(pixelRatio);
      world.setCloudDensity(CLOUD_LEVELS[cloudLevel]);
    }
  }
  world.setPixelRatio(pixelRatio);

  return {
    watchRefresh,
    skip: (sinceLast) => frameEvery > 1 && sinceLast < (frameEvery - 0.5) * vsyncMs,
    govern: governResolution,
    settle: (ms = 4000) => {
      settleUntil = performance.now() + ms;
      // (A new scene is a new load: what failed or was given up on in the last one is tried again.)
      holdUntil = 0;
      failedUntil = 0;
      failedPr = Infinity;
      retryWait = 60000;
    },
    state: () => ({ vsyncMs, frameEvery, cloudLevel, pixelRatio }),
  };
}
