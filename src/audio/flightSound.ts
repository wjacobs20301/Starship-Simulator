// What's heard of the flight: the main menu's music in place of the world's sounds, one-off sounds
// for what happened (catches, touchdowns, splashdowns), the towers' machinery, the engines as heard
// at the camera, and everything else ambient. (Moved out of main.ts: its menuMusic and towerMotion,
// the sound parts of worker.onmessage, and the frame steps menuMusicStep, soundStep and audioStep.)

import type { FlightView } from '../game/flightView';
import type { Received } from '../game/viewModes';
import type { CameraRig } from '../render/cameras';
import { type FloatingOrigin, enuToWorld } from '../render/floatingOrigin';
import { type FxVehicle, vehicleNoise } from '../render/fx/launchFx';
import { PAD } from '../sim/constants';
import type { V3 } from '../sim/math';
import { MOUNTS, TOWERS } from '../sim/padCollision';
import type { Snapshot } from '../sim/simulation';
import type { GameMenu } from '../ui/gameMenu';
import type { Ambience } from './ambience';
import type { AudioEngine } from './engine';
import type { LaunchAudio } from './launchAudio';
import type { MenuAudio } from './menuAudio';
import { type Heard, type SoundField, plumePower } from './soundField';

export interface FlightSoundDeps {
  sound: SoundField;
  audio: LaunchAudio;
  ambience: Ambience;
  menuAudio: MenuAudio;
  audioEngine: AudioEngine;
  menu: Pick<GameMenu, 'kind'>;
  rig: CameraRig;
  origin: FloatingOrigin;
  /** The tracked vehicle, paused, and the launch pad (its deluge). */
  flight: FlightView;
  /** Each vehicle's mid-body (world) last frame (render/vehicleMeshes.ts). */
  vehicleMid: Map<string, V3>;
}

export interface FlightSound {
  /** A new snapshot: the towers' machinery's rates, from it and the one before. */
  noteTowers(prev: Received | null, curr: Received): void;
  /** A new snapshot: one-off sounds from what happened. */
  eventSounds(snap: Snapshot): void;
  /** Behind the main menu: its music, not the world's sounds. */
  menuMusicStep(): void;
  /** The engines' sound as heard at the camera (late, with the distance). */
  soundStep(placements: FxVehicle[], simTime: number, cam: V3): Heard;
  /** The engines' roar, and everything else heard (ambience.ts). */
  audioStep(snap: Snapshot, placements: FxVehicle[], heard: Heard, cam: V3, camAlt: number, simTime: number, frameDt: number, wx: { rain: number }): void;
}

export function createFlightSound(deps: FlightSoundDeps): FlightSound {
  const { sound, audio, ambience, menuAudio, audioEngine, menu, rig, origin, flight, vehicleMid } = deps;
  /** Whether the main menu's music (rather than the world's sounds) is playing. */
  let menuMusic: boolean | null = null;
  /** How fast each pad's arms are moving (0 = still, 1 ~ a full-speed motion), from the snapshots. */
  const towerMotion = [0, 0];

  function noteTowers(prev: Received | null, curr: Received): void {
    // Tower machinery: rates of the carriage, arms, slew and QD arm, per sim second.
    if (prev && curr.snap.t > prev.snap.t) {
      const dt = curr.snap.t - prev.snap.t;
      curr.snap.towers.forEach((a, i) => {
        const b = prev!.snap.towers[i];
        if (!b) return;
        const m = (Math.abs(a.top - b.top) / 2.5 + Math.abs(a.angle - b.angle) / 8 + Math.abs(a.slew - b.slew) / 2.5 + Math.abs(a.qd - b.qd) / 16) / dt;
        // (A jump far faster than the drives can go is a reset / new scene, not motion.)
        towerMotion[i] = m > 4 ? 0 : m;
      });
    }
  }

  function eventSounds(snap: Snapshot): void {
    // One-off sounds from what happened.
    for (const e of snap.events) {
      const at = (id: string) => vehicleMid.get(id) ?? null;
      const where = (e.who && at(e.who)) ?? at(flight.trackedId);
      if (!where) continue;
      if (e.kind === 'boosterCaught' || e.kind === 'shipCaught') ambience.play('catch', where, origin.camera);
      else if (e.kind === 'grab' || e.kind === 'stacked') ambience.play('grab', where, origin.camera);
      else if (e.kind === 'touchdown') ambience.play('touchdown', where, origin.camera);
      else if (e.kind === 'splashdown') ambience.play('splash', where, origin.camera);
    }
  }

  function menuMusicStep(): void {
    if ((menu.kind === 'main') !== menuMusic) {
      menuMusic = menu.kind === 'main';
      menuAudio.setMusic(menuMusic);
      audioEngine.setWorldLevel(menuMusic ? 0 : 1, menuMusic ? 0.4 : 1.5);
    }
  }

  function soundStep(placements: FxVehicle[], simTime: number, cam: V3): Heard {
    // Sound: every vehicle is a source (silent ones too, so a cut-off is heard late as well).
    for (const pl of placements) {
      const n = vehicleNoise(pl);
      sound.record(pl.snap.id, simTime, n.pos, plumePower(n.thrust, n.pressureRatio));
    }
    sound.prune(simTime);
    return sound.hear(simTime, cam);
  }

  function audioStep(snap: Snapshot, placements: FxVehicle[], heard: Heard, cam: V3, camAlt: number, simTime: number, frameDt: number, wx: { rain: number }): void {
    audio.update(heard.level, heard.distance, Math.exp(-Math.max(0, camAlt) / 8500), flight.paused);
    // Everything else you hear: wind, surf, air rush, tower machinery, deluge, venting.
    const mt = snap.missionTime;
    const sm = (x: number, a: number, b: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const [me, mn] = MOUNTS[flight.launchPad];
    const heldStack = placements.find((pl) => pl.snap.status === 'held' && pl.snap.stages.length === 2);
    ambience.update({
      dt: frameDt,
      paused: flight.paused || menu.kind === 'pause',
      cam,
      camAlt,
      listenerAir: Math.exp(-Math.max(0, camAlt) / 8500),
      time: simTime,
      vehicles: placements
        .filter((pl) => pl.snap.status === 'flight')
        .map((pl) => ({ world: vehicleMid.get(pl.snap.id) ?? pl.world, q: pl.snap.telemetry.q, mach: pl.snap.telemetry.mach, heatFlux: pl.snap.telemetry.heatFlux })),
      towers: snap.towers.map((a, i) => ({ world: enuToWorld([TOWERS[i][0], TOWERS[i][1], a.top]), motion: towerMotion[i] })),
      deluge: mt === null ? null : { world: enuToWorld([me, mn, PAD.mountHeight]), level: sm(mt, -6, -4.5) * (1 - sm(mt, 12, 16)) },
      vent: heldStack && (snap.phase === 'prelaunch' || snap.phase === 'countdown') ? (vehicleMid.get(heldStack.snap.id) ?? null) : null,
      rain: rig.map ? 0 : wx.rain,
    });
  }

  return { noteTowers, eventSounds, menuMusicStep, soundStep, audioStep };
}
