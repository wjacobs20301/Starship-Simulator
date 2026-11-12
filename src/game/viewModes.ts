// The ways of watching a flight other than flying it: instant replay (ui/replay.ts), photo mode,
// and the auto camera (render/director.ts) cutting between shots. (Moved out of main.ts: its
// startReplay / endReplay, startPhoto / endPhoto, runDirector / stopDirector and the keys for them.)

import type { CameraRig } from '../render/cameras';
import type { Director } from '../render/director';
import type { World } from '../render/scene';
import type { Snapshot } from '../sim/simulation';
import type { GameMenu } from '../ui/gameMenu';
import { keyText } from '../ui/keyLabels';
import type { Replay } from '../ui/replay';
import type { ToWorker } from '../worker/protocol';

/** A snapshot from the worker, and when it came (performance.now(), ms). */
export interface Received {
  snap: Snapshot;
  at: number;
}

export interface ViewModesDeps {
  replay: Replay;
  director: Director;
  menu: Pick<GameMenu, 'isOpen'>;
  rig: CameraRig;
  world: World;
  send(m: ToWorker): void;
  showToast(text: string): void;
  /** The two newest snapshots the frame draws from (main.ts prev, curr), and replacing them. */
  live(): { prev: Received | null; curr: Received | null };
  setLive(prev: Received | null, curr: Received | null): void;
  /** The sim is paused (as the worker last said). */
  paused(): boolean;
  /** The player has the controls of the tracked vehicle. */
  manual(): boolean;
  /** The vehicle on screen, and changing it; the Starlink the cameras follow instead (V). */
  tracked(): string;
  setTracked(id: string): void;
  setSatFocus(n: number | null): void;
}

export interface ViewModes {
  startReplay(): void;
  endReplay(): void;
  /**
   * A snapshot from the worker while a replay plays: kept for the return (true), the live flight
   * waiting. False: not replaying, it's the live flight's.
   */
  holdLive(r: Received): boolean;
  /** Each frame while replaying: the recorded snapshots either side of the playback time, as if just received. */
  replayFrame(now: number): void;
  startPhoto(): void;
  endPhoto(): void;
  inPhoto(): boolean;
  savePhoto(): void;
  /** The auto camera's cut, if it makes one now: camera, framing and which vehicle it follows. */
  runDirector(now: number, snap: Snapshot): void;
  /** The player took the camera: the auto camera stands down. */
  stopDirector(): void;
  toggleDirector(): void;
  /** What the flight logged (the auto camera cuts to some of it). */
  noteEvents(events: readonly { text: string }[]): void;
  /** A new flight: the auto camera starts afresh, on or off. */
  restartDirector(enabled: boolean): void;
}

export function createViewModes(deps: ViewModesDeps): ViewModes {
  const { replay, director, menu, rig, world, send, showToast } = deps;
  /** The log lines the auto camera hasn't seen yet. */
  const directorEvents: string[] = [];
  /** Instant replay: the live snapshots while it plays. */
  let liveHeld: { prev: Received | null; curr: Received | null } | null = null;
  /** Photo mode: time frozen (if it wasn't), the HUD hidden, a field of view of its own. */
  let photo: { paused: boolean } | null = null;

  function startReplay(): void {
    const { prev, curr } = deps.live();
    if (!curr || menu.isOpen || !replay.available) {
      if (!replay.available) showToast('Nothing to replay yet');
      return;
    }
    if (photo) endPhoto();
    liveHeld = { prev, curr };
    replay.start(performance.now());
    send({ type: 'pause', value: true });
    stopDirector();
  }

  function endReplay(): void {
    replay.stop();
    if (liveHeld) {
      deps.setLive(liveHeld.prev, liveHeld.curr);
      liveHeld = null;
    }
    send({ type: 'pause', value: false });
  }

  function startPhoto(): void {
    if (!deps.live().curr || menu.isOpen) return;
    photo = { paused: !deps.paused() };
    if (photo.paused && !replay.active) send({ type: 'pause', value: true });
    if (replay.active) replay.playing = false;
    rig.fovOverride = world.camera.fov;
    stopDirector();
    document.body.classList.add('photo');
    showToast(`Photo mode · drag and scroll to frame · [ ] zoom · Enter saves · ${keyText('photo')} to leave`);
  }

  function endPhoto(): void {
    if (!photo) return;
    if (photo.paused && !replay.active) send({ type: 'pause', value: false });
    photo = null;
    rig.fovOverride = null;
    document.body.classList.remove('photo');
  }

  /** The auto camera's cut, if it makes one now: camera, framing and which vehicle it follows. */
  function runDirector(now: number, snap: Snapshot): void {
    if (!director.enabled || menu.isOpen || rig.map) {
      directorEvents.length = 0;
      return;
    }
    const shot = director.update(now / 1000, {
      missionTime: snap.missionTime,
      vehicles: snap.vehicles.map((v) => ({
        id: v.id,
        status: v.status,
        altitude: v.telemetry.altitude,
        speed: Math.hypot(...v.telemetry.vAirEnu),
        nearPad: v.telemetry.downrange < 60e3,
      })),
      events: directorEvents.splice(0),
      door: !!snap.payload && (snap.payload.door ?? 0) > 0.5,
      sats: !!snap.payload?.sats.length,
      manual: deps.manual(),
      tracked: deps.tracked(),
    });
    if (!shot) return;
    if (shot.track && shot.track !== deps.tracked() && snap.vehicles.some((v) => v.id === shot.track && v.status !== 'destroyed')) {
      deps.setTracked(shot.track);
      deps.setSatFocus(null);
    }
    rig.mode = shot.mode;
    if (shot.orbit) {
      rig.azimuth = shot.orbit.azimuth;
      rig.elevation = shot.orbit.elevation;
      rig.distance = shot.orbit.distance;
    }
  }

  /** The player took the camera: the auto camera stands down. */
  function stopDirector(): void {
    if (!director.enabled) return;
    director.enabled = false;
    showToast(`Auto camera off · ${keyText('director')} to turn it back on`);
  }

  return {
    startReplay,
    endReplay,
    holdLive: (r) => {
      // Replaying: the live flight waits (paused); its snapshots are kept for the return.
      if (replay.active && liveHeld) {
        liveHeld = { prev: liveHeld.curr, curr: r };
        return true;
      }
      return false;
    },
    replayFrame: (now) => {
      // Replaying: the recorded snapshots either side of the playback time, as if just received.
      if (replay.active) {
        const r = replay.frame(now);
        if (r) {
          const span = 1000 / 30;
          const curr = { snap: r.b, at: now - r.f * span };
          deps.setLive({ snap: r.a, at: curr.at - span }, curr);
        }
      }
    },
    startPhoto,
    endPhoto,
    inPhoto: () => photo !== null,
    savePhoto: () => {
      if (!photo) return;
      // (Drawn now and read at once: the canvas keeps no copy once it's on screen.)
      world.render();
      const a = document.createElement('a');
      a.href = world.renderer.domElement.toDataURL('image/png');
      a.download = `starship-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      a.click();
      showToast('Picture saved');
    },
    runDirector,
    stopDirector,
    toggleDirector: () => {
      director.enabled = !director.enabled;
      director.reset();
      showToast(director.enabled ? `Auto camera on · ${keyText('director')} to turn off` : 'Auto camera off');
    },
    noteEvents: (events) => {
      for (const e of events) directorEvents.push(e.text);
    },
    restartDirector: (enabled) => {
      director.reset();
      director.enabled = enabled;
      directorEvents.length = 0;
    },
  };
}
