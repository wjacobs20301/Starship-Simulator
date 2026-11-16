// The ways of watching a flight other than flying it: instant replay (ui/replay.ts), photo mode,
// and the auto camera (render/director.ts) cutting between shots. (Moved out of main.ts: its
// startReplay / endReplay, startPhoto / endPhoto, runDirector / stopDirector and the keys for them.)

import { type CameraRig, SAT_CAMERA_AGE } from '../render/cameras';
import type { Director, Shot } from '../render/director';
import type { World } from '../render/scene';
import { enuToWorld } from '../render/floatingOrigin';
import { rolloutRoute, routeAt, routeLength } from '../sim/rollout';
import type { V3 } from '../sim/math';
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
  /** A title over the picture for a few seconds: a heading and a line under it. */
  showTitle(head: string, sub: string): void;
  /** The worker's count of jumps within a scene (a rollout's film skipping up the road: protocol.ts cuts). */
  cuts(): number;
  /** A new flight isn't ready to look at yet (its screen is over it). */
  busy(): boolean;
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
  /** A film's next clip: where its camera will be and what it will look at (world), for its ground to be loaded ahead; null: none. */
  warmView(): { pos: V3; look: V3 } | null;
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
  /** The auto camera's shot now: its slow move (render/director.ts Shot.drift), and when the frame before this was (ms). */
  let drift: { azimuth?: number; elevation?: number; zoom?: number } | null = null;
  let driftAt = 0;
  /** The flight wasn't ready to look at last frame (deps.busy). */
  let covered = false;

  /** A shot was cut to under the loading screen: nothing more until it's off. */
  let coveredShot = false;
  /** A film's clip waiting on the transport's jump up the road to it (the worker's count of jumps when it was asked for, and when: ms). */
  let pending: { shot: Shot; cuts: number; at: number } | null = null;
  /** How fast a film has time running (1: as it is). */
  let filmPace = 1;
  /** A film's next clip: its view, for its ground to be loaded ahead. */
  let warm: { pos: V3; look: V3 } | null = null;

  /** Nothing of the last shot left on the camera: its move, its aim, the roadside tripod. */
  function clearShot(): void {
    drift = null;
    rig.aimShift = 0;
    rig.fixedAt = null;
    rig.fixedFov = null;
    if (rig.mode === 'roadside') rig.mode = 'orbit';
  }

  /** The camera as the player has it, and time as it goes: nothing of a film left running. */
  function release(): void {
    clearShot();
    pending = null;
    warm = null;
    if (filmPace !== 1) send({ type: 'warp', value: 1 });
    filmPace = 1;
  }

  /** The roadside camera's tripod (world): up the road from a vehicle `gone` metres along its way, off to one side of it. */
  function tripod(route: [number, number][], gone: number, r: NonNullable<Shot['roadside']>): V3 {
    const at = routeAt(route, Math.min(routeLength(route), gone + r.ahead));
    return enuToWorld([at.e - Math.sin(at.heading) * r.side, at.n + Math.cos(at.heading) * r.side, r.up]);
  }

  /** Where a shot's camera will be and what it will look at (world), the vehicle `gone` metres along its way. Null: one of Starbase's own cameras. */
  function shotView(shot: Shot, route: [number, number][], gone: number): { pos: V3; look: V3 } | null {
    const at = routeAt(route, gone);
    const look = enuToWorld([at.e, at.n, 30 + (shot.aim ?? 0)]);
    let pos: V3;
    if (shot.roadside) pos = tripod(route, gone, shot.roadside);
    else if (shot.mode === 'orbit' && shot.orbit) {
      const az = shot.orbit.azimuth + (shot.orbit.ahead ? at.heading + Math.PI / 2 : 0);
      const ce = Math.cos(shot.orbit.elevation) * shot.orbit.distance;
      pos = [look[0] + ce * Math.sin(az), look[1] + Math.sin(shot.orbit.elevation) * shot.orbit.distance, look[2] + ce * Math.cos(az)];
    } else return null;
    return { pos: [pos[0], Math.max(2, pos[1]), pos[2]], look };
  }

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
      driftAt = now;
      return;
    }
    // A flight comes out from under its loading screen on its first shot, at that shot's start
    // (it was cut to under the screen, so the ground it sees was loaded there), and with its title.
    const busy = deps.busy();
    if (covered && !busy) director.reset();
    covered = busy;
    if (!busy) coveredShot = false;
    else if (coveredShot) return;
    // The shot's slow move: round, over and in on the vehicle as it's held.
    const dt = Math.min(0.1, Math.max(0, (now - driftAt) / 1000));
    driftAt = now;
    if (drift && rig.mode === 'orbit' && !deps.paused() && !busy) {
      rig.azimuth += (drift.azimuth ?? 0) * dt;
      if (drift.elevation) rig.elevation = Math.min(1.5, Math.max(-0.2, rig.elevation + drift.elevation * dt));
      rig.distance = Math.min(2e6, Math.max(40, rig.distance * Math.exp((drift.zoom ?? 0) * dt)));
    }
    // A film's clip that begins further up the road: cut to once the transport is there (the
    // worker has jumped it on; or it hasn't in half a second, and won't).
    if (pending) {
      if (deps.cuts() === pending.cuts && now - pending.at < 500) return;
      const p = pending;
      pending = null;
      return applyShot(p.shot, snap, busy);
    }
    const shot = director.update(now / 1000, {
      transport: transportView(snap),
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
      sats: !!snap.payload?.sats.some((x) => x.age > SAT_CAMERA_AGE),
      manual: deps.manual(),
      tracked: deps.tracked(),
    });
    if (!shot) return;
    if (shot.skipTo !== undefined && snap.transport && !busy) {
      send({ type: 'rolloutSkip', gone: shot.skipTo });
      pending = { shot, cuts: deps.cuts(), at: now };
      return;
    }
    applyShot(shot, snap, busy);
  }

  /** A rollout as the auto camera is told of it: how far along its way the transport is, and what's left. */
  function transportView(snap: Snapshot): { id: string; pad: number; gone: number; left: number; arrived: boolean } | null {
    const tr = snap.transport;
    if (!tr) return null;
    const length = routeLength(rolloutRoute(tr.pad));
    return { id: tr.id, pad: tr.pad, gone: tr.progress * length, left: (1 - tr.progress) * length, arrived: tr.arrived };
  }

  function applyShot(shot: Shot, snap: Snapshot, busy: boolean): void {
    const tr = snap.transport ?? null;
    const route = tr ? rolloutRoute(tr.pad) : null;
    const gone = tr && route ? tr.progress * routeLength(route) : 0;
    if (shot.track && shot.track !== deps.tracked() && snap.vehicles.some((v) => v.id === shot.track && v.status !== 'destroyed')) {
      deps.setTracked(shot.track);
      deps.setSatFocus(null);
    }
    clearShot();
    coveredShot = busy;
    if (shot.roadside) {
      if (!route) return;
      rig.fixedAt = tripod(route, gone, shot.roadside);
      rig.fixedFov = shot.roadside.fov ?? null;
    }
    rig.mode = shot.mode;
    rig.aimShift = shot.aim ?? 0;
    drift = shot.drift ?? null;
    if (shot.orbit) {
      // (Round from dead ahead of a vehicle on its transport: from the way it's going there.)
      rig.azimuth = shot.orbit.azimuth + (shot.orbit.ahead && tr ? tr.heading + Math.PI / 2 : 0);
      rig.elevation = shot.orbit.elevation;
      rig.distance = shot.orbit.distance;
    }
    // A film's clip: time as fast as it runs it; and the next one's ground asked for now.
    if (shot.pace !== undefined && shot.pace !== filmPace && !busy) {
      send({ type: 'warp', value: shot.pace });
      filmPace = shot.pace;
    }
    const next = director.upcoming(transportView(snap));
    warm = next && route ? shotView(next.shot, route, Math.max(gone, next.at)) : null;
    if (shot.title && !busy) {
      deps.showTitle(...shot.title);
      if (tr && !tr.arrived) showToast(`A drag, or ${keyText('director')}, takes the camera: the rollout then runs at its own pace`);
    }
    // (A rollout's last shot: the camera is the player's again, where the stacking is seen from.)
    if (shot.last) {
      director.enabled = false;
      release();
      showToast(`The camera is yours · ${keyText('director')} for the auto camera`);
    }
  }

  /** The player took the camera: the auto camera stands down. */
  function stopDirector(): void {
    if (!director.enabled) return;
    director.enabled = false;
    release();
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
    warmView: () => (director.enabled ? warm : null),
    toggleDirector: () => {
      director.enabled = !director.enabled;
      director.reset();
      release();
      showToast(director.enabled ? `Auto camera on · ${keyText('director')} to turn off` : 'Auto camera off');
    },
    noteEvents: (events) => {
      for (const e of events) directorEvents.push(e.text);
    },
    restartDirector: (enabled) => {
      director.reset();
      director.enabled = enabled;
      release();
      directorEvents.length = 0;
    },
  };
}
