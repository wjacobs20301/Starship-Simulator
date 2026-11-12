// The vehicles' meshes: made and dropped as the vehicles come and go (a fireball for one that
// blew up), the shaders built ahead, and each frame every vehicle placed and turned, the camera's
// target on the tracked one, and the camera kept on a blast for a while. (Moved out of main.ts:
// its "Vehicles" section, vehicleMid / lastMach, prewarmShaders, syncMeshes, midpoint, and the
// frame steps watchBlastStep and placeVehiclesStep.)

import * as THREE from 'three';
import type { Ambience } from '../audio/ambience';
import type { FlightView } from '../game/flightView';
import { workerCaughtUp } from '../game/flightView';
import type { PilotControls } from '../game/pilotControls';
import { BOOSTER_LENGTH, SHIP_LENGTH, STARLINK_V3, STARSHIP_V3, SUPER_HEAVY_V3 } from '../sim/config/starshipV3';
import type { V3 } from '../sim/math';
import type { Snapshot, VehicleSnapshot } from '../sim/simulation';
import type { CameraRig, CameraTarget } from './cameras';
import { type FloatingOrigin, enuToWorld, vehicleQuaternion } from './floatingOrigin';
import type { FrameMotion } from './frameMotion';
import { type FxVehicle, type LaunchFx, explosionRadius } from './fx/launchFx';
import type { ModelLibrary } from './models';
import type { World } from './scene';
import { VehicleMesh } from './vehicleMesh';

export type Blast = { at: V3; radius: number; since: number };

export interface VehicleMeshesDeps {
  world: World;
  origin: FloatingOrigin;
  rig: CameraRig;
  fx: LaunchFx;
  ambience: Ambience;
  /** The vehicles' models (null until they've loaded). */
  models(): ModelLibrary | null;
  /** The tracked vehicle and the Starlink the cameras follow (both changed here as vehicles go). */
  flight: FlightView;
  pilotCtl: Pick<PilotControls, 'set' | 'manualVehicles'>;
}

export interface VehicleMeshes {
  /** Each vehicle's mesh, by id. */
  readonly meshes: Map<string, VehicleMesh>;
  /** Each vehicle's mid-body (world) last frame. */
  readonly vehicleMid: Map<string, V3>;
  /** Vehicles that blew up: where, how big, and when (real ms), so the camera can stay on them. */
  readonly blasts: Map<string, Blast>;
  /** Shaders compiled and textures uploaded ahead, once (when the first scene's vehicles are up). */
  prewarmShaders(): void;
  /** Meshes made for new vehicles and dropped for gone ones (a fireball for one destroyed). */
  syncMeshes(vehicles: VehicleSnapshot[], simTime: number): void;
  /** The blast the camera is watching, if the tracked vehicle blew up (else on to what's still flying). */
  watchBlastStep(snap: Snapshot, now: number): Blast | null;
  /** The vehicles placed and turned for this frame (their sonic booms too), and the camera's target on the tracked one. */
  placeVehiclesStep(m: FrameMotion): { placements: FxVehicle[]; target: CameraTarget | null };
}

/** Mid-body of a vehicle along its axis, from the booster-base origin, m. */
function midpoint(v: VehicleSnapshot): number {
  const lo = v.stages.includes('booster') ? 0 : BOOSTER_LENGTH;
  const hi = v.stages.includes('ship') ? BOOSTER_LENGTH + SHIP_LENGTH : BOOSTER_LENGTH;
  return (lo + hi) / 2;
}

export function createVehicleMeshes(deps: VehicleMeshesDeps): VehicleMeshes {
  const { world, origin, rig, fx, ambience, flight, pilotCtl } = deps;
  /** Each vehicle's mid-body (world) last frame, and its Mach number (for the sonic boom). */
  const vehicleMid = new Map<string, V3>();
  const lastMach = new Map<string, number>();
  const meshes = new Map<string, VehicleMesh>();
  /** Vehicles that blew up: where, how big, and when (real ms), so the camera can stay on them. */
  const blasts = new Map<string, Blast>();
  /** How long the camera watches a blast before moving to a stage that's still flying, ms. */
  const WATCH_BLAST_MS = 12000;
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const up = new THREE.Vector3();

  /**
   * Compile every shader and upload every texture ahead, once the first scene's vehicles are up
   * (behind the loading screen): else each is built the first time it's drawn (the plume at
   * ignition, the plasma, frost, rain, lightning, a fireball, the satellites...), and the frame
   * it happens in stalls for a moment. Hidden parts are shown just for the compile (it collects
   * what to build at once; they're hidden again before any frame is drawn).
   */
  let prewarmed = false;
  function prewarmShaders(): void {
    if (prewarmed || !deps.models() || meshes.size === 0) return;
    prewarmed = true;
    const r = world.renderer;
    const shown: THREE.Object3D[] = [];
    world.scene.traverse((o) => {
      if (!o.visible) {
        o.visible = true;
        shown.push(o);
      }
    });
    const extra = fx.warmObjects();
    for (const o of extra) fx.group.add(o);

    const seen = new Set<THREE.Texture>();
    world.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        for (const v of Object.values(m)) {
          if (v && (v as THREE.Texture).isTexture && !seen.has(v as THREE.Texture) && (v as THREE.Texture).image) {
            seen.add(v as THREE.Texture);
            r.initTexture(v as THREE.Texture);
          }
        }
      }
    });
    // (Pass by pass, as the frame draws each: see compileAhead.)
    world.atmosphere.compileAhead(r).catch(() => {});
    // (Their material kept, not disposed: that would drop the program just built.)
    for (const o of extra) fx.group.remove(o);
    for (const o of shown) o.visible = false;
  }

  function syncMeshes(vehicles: VehicleSnapshot[], simTime: number): void {
    const models = deps.models();
    if (!models) return;
    const alive = new Set(vehicles.filter((v) => v.status !== 'destroyed').map((v) => v.id));
    for (const [id, m] of meshes) {
      if (!alive.has(id)) {
        // Broke up or crashed (rather than just gone, like the stack at staging): fireball.
        const v = vehicles.find((x) => x.id === id);
        const at = m.root.userData.world as V3 | undefined;
        if (v?.status === 'destroyed' && at) {
          const [e, n, u] = v.telemetry.vAirEnu;
          const length = v.stages.length === 2 ? BOOSTER_LENGTH + SHIP_LENGTH : v.stages[0] === 'ship' ? SHIP_LENGTH : BOOSTER_LENGTH;
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.root.quaternion);
          const mid = midpoint(v);
          const where: V3 = [at[0] + up.x * mid, at[1] + up.y * mid, at[2] + up.z * mid];
          // As big as the propellant still aboard and the impact make it.
          const propellant = v.stages.reduce((sum, id) => sum + (v.stageState[id]?.propFrac ?? 0) * (id === 'booster' ? SUPER_HEAVY_V3 : STARSHIP_V3).propMass, 0);
          const air = Math.exp(-Math.max(0, v.telemetry.altitude) / 8500);
          const radius = explosionRadius(propellant, v.telemetry.mass, Math.hypot(e, n, u), length);
          fx.explode(where, new THREE.Vector3(e, u, -n), simTime, radius, air);
          ambience.play('explosion', where, origin.camera, radius / 60);
          blasts.set(id, { at: where, radius: radius * (air > 0.05 ? 1 : 0.4), since: performance.now() });
        }
        world.scene.remove(m.root);
        m.dispose();
        meshes.delete(id);
      }
    }
    for (const v of vehicles) {
      if (alive.has(v.id) && !meshes.has(v.id)) {
        const m = new VehicleMesh(v.stages, models);
        meshes.set(v.id, m);
        world.scene.add(m.root);
      }
    }
  }

  function watchBlastStep(snap: Snapshot, now: number): Blast | null {
    // The tracked vehicle blew up: watch the explosion for a while (V switches sooner), then go
    // over to whatever is still flying.
    let watching: Blast | null = null;
    if (workerCaughtUp(flight) && !snap.vehicles.some((v) => v.id === flight.trackedId && v.status !== 'destroyed')) {
      const blast = blasts.get(flight.trackedId);
      if (blast && now - blast.since < WATCH_BLAST_MS) watching = blast;
      else {
        const next = snap.vehicles.find((v) => v.id === 'ship' && v.status !== 'destroyed')?.id
          ?? snap.vehicles.find((v) => v.status !== 'destroyed')?.id
          ?? flight.trackedId;
        if (next !== flight.trackedId) {
          flight.trackedId = next;
          pilotCtl.set({ manual: pilotCtl.manualVehicles.has(next) });
        }
      }
    }
    return watching;
  }

  function placeVehiclesStep(m: FrameMotion): { placements: FxVehicle[]; target: CameraTarget | null } {
    const { snap, from, to, alpha, simTime, placeAt, satWorld } = m;
    const placements: FxVehicle[] = [];
    let target: CameraTarget | null = null;
    if (flight.satFocus !== null && !snap.payload?.sats.some((x) => x.n === flight.satFocus)) flight.satFocus = null;
    const sats = snap.payload?.sats ?? [];
    const camSat = flight.satFocus ?? (sats.length ? sats[sats.length - 1].n : null);
    for (const v of snap.vehicles) {
      const mesh = meshes.get(v.id);
      if (!mesh) continue;
      // (Its place and attitude: as the two snapshots the clock is between have them.)
      const q = to === snap ? v : to.vehicles.find((x) => x.id === v.id);
      const p = q && from?.vehicles.find((x) => x.id === v.id);
      const pos = placeAt(p ? p.pos : undefined, (q ?? v).pos, v.telemetry.vAirEnu, (q ? to.t : snap.t) - simTime);
      vehicleQuaternion((q ?? v).rot, qb);
      if (p) qb.copy(vehicleQuaternion(p.rot, qa).slerp(qb, alpha));
      mesh.root.quaternion.copy(qb);
      mesh.update(v, simTime);
      if (v.stages.includes('ship')) {
        mesh.setPayloadDoor(snap.payload?.door ?? 0, (rig.mode === 'bay' || rig.mode === 'baytop') && !rig.map && v.id === flight.trackedId);
        mesh.setShield(snap.shield);
      }
      const w = enuToWorld(pos);
      placements.push({ snap: v, mesh, world: w });
      {
        up.set(0, 1, 0).applyQuaternion(qb);
        const mid = midpoint(v);
        const m: V3 = [w[0] + up.x * mid, w[1] + up.y * mid, w[2] + up.z * mid];
        vehicleMid.set(v.id, m);
        // A stage slowing through Mach 1 on its way down: its double sonic boom.
        const was = lastMach.get(v.id) ?? 0;
        const mach = v.telemetry.mach;
        if (v.status === 'flight' && was >= 1.02 && mach < 1 && v.telemetry.vAirEnu[2] < 0 && v.telemetry.altitude < 30e3) ambience.play('boom', m, origin.camera);
        lastMach.set(v.id, mach);
      }
      if (v.id === flight.trackedId) {
        up.set(0, 1, 0).applyQuaternion(qb);
        // (Dev-only: __focusAlong, m, moves the aim along the tracked vehicle's axis from its base.)
        const along = import.meta.env.DEV ? (window as unknown as { __focusAlong?: number }).__focusAlong : undefined;
        const mid = along ?? midpoint(v);
        target = {
          center: [w[0] + up.x * mid, w[1] + up.y * mid, w[2] + up.z * mid],
          axis: [up.x, up.y, up.z],
          size: v.stages.length === 2 ? BOOSTER_LENGTH + SHIP_LENGTH : v.stages[0] === 'ship' ? SHIP_LENGTH : BOOSTER_LENGTH,
          belly: ((b) => [b.x, b.y, b.z] as V3)(new THREE.Vector3(1, 0, 0).applyQuaternion(qb)),
        };
        if (v.stages.length === 1 && v.stages[0] === 'ship') {
          // The payload door (Starlink flights): on the leeward side (mesh -x), doorX above the ship's base.
          if (snap.payload) {
            const out = new THREE.Vector3(-1, 0, 0).applyQuaternion(qb);
            const h = BOOSTER_LENGTH + STARLINK_V3.doorX;
            const side = new THREE.Vector3(0, 0, -1).applyQuaternion(qb);
            target.door = { at: [w[0] + up.x * h + out.x * 4.5, w[1] + up.y * h + out.y * 4.5, w[2] + up.z * h + out.z * 4.5], out: [out.x, out.y, out.z], side: [side.x, side.y, side.z] };
          }
          if (camSat !== null) target.sat = satWorld(camSat) ?? undefined;
        }
      }
    }
    return { placements, target };
  }

  return { meshes, vehicleMid, blasts, prewarmShaders, syncMeshes, watchBlastStep, placeVehiclesStep };
}
