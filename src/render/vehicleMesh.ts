// Vehicle meshes: the Blender-built Super Heavy / Starship models (art/blender), plus
// exhaust plumes and tank frost. Mesh-local frame: +Y along the stack axis, y = 0 at the
// booster base, matching the physics body frame. Engine nodes are driven by the simulated gimbal.

import * as THREE from 'three';
import { BOOSTER_LENGTH, STARSHIP_V3, SUPER_HEAVY_V3 } from '../sim/config/starshipV3';
import type { StageId } from '../sim/vehicle';
import { toFxLayer } from './atmosphere';
import { Frost } from './fx/frost';
import { Plasma, plasmaIntensity } from './fx/plasma';
import { type HeatUniforms, Sparks, heatMaterial, heatUniforms } from './fx/reentryHeat';
import { Plume } from './fx/plume';
import type { VehicleSnapshot } from '../sim/simulation';
import { DETAIL_LEVELS, type ModelLibrary, Pivot } from './models';

// --- Vehicle assembly ------------------------------------------------------------

interface EngineNode {
  node: THREE.Object3D;
  glow: THREE.MeshStandardMaterial;
}

const DOWN = new THREE.Vector3(0, -1, 0);
/**
 * A flap / grid fin node, shown at the sim's angle for it: node hinge angle = sense x (sim angle
 * - rest), where rest is the sim angle the model was built at.
 */
interface Surface {
  name: string;
  pivot: Pivot;
  sense: 1 | -1;
  rest: number;
}
const GLOW = new THREE.Color(1.0, 0.45, 0.15);

export class VehicleMesh {
  readonly root = new THREE.Group();
  readonly plumes = new Map<StageId, Plume>();
  private engines = new Map<StageId, EngineNode[]>();
  private frost: Frost;
  private frostStages = new Map<StageId, { update(propFrac: number, time: number): void }>();
  private nozzle = new THREE.Vector3();
  private plasma: Plasma;
  /** Reentry heating: the tiles' and bare steel's glow (shared by this vehicle's materials). */
  private heat: HeatUniforms = heatUniforms();
  private sparks: Sparks;
  /** Bare-steel and tile temperatures (0..1), with thermal lag, and the sim time last updated. */
  private steelTemp = 0;
  private tileTemp = 0;
  private lastTime: number | null = null;
  /** Materials this vehicle owns (patched copies), for dispose. */
  private owned: THREE.Material[] = [];
  /** Screen pixels per metre at 1 m, and the pixel ratio (set by the renderer each frame). */
  static screenScale = 1000;
  static pixelRatio = 1;
  private motion = new THREE.Vector3();
  private surfaces: Surface[] = [];
  private qInv = new THREE.Quaternion();
  /** Meshes with simpler versions for when the camera is far off (models.ts). */
  private detailed: { mesh: THREE.Mesh; full: THREE.BufferGeometry; levels: { distance: number; geometry: THREE.BufferGeometry }[] }[] = [];

  constructor(stages: StageId[], models: ModelLibrary) {
    this.frost = new Frost(this.root);
    const lo = stages.includes('booster') ? 0 : BOOSTER_LENGTH;
    const hi = stages.includes('ship') ? STARSHIP_V3.xBase + STARSHIP_V3.length : BOOSTER_LENGTH;
    this.plasma = new Plasma(lo, hi);
    this.root.add(this.plasma.group);
    toFxLayer(this.plasma.group);
    this.sparks = new Sparks(lo, hi);
    this.root.add(this.sparks.points);
    toFxLayer(this.sparks.points);
    for (const id of stages) {
      const def = id === 'booster' ? SUPER_HEAVY_V3 : STARSHIP_V3;
      const model = (id === 'booster' ? models.booster : models.ship).clone(true);
      if (id === 'ship') model.position.y = BOOSTER_LENGTH;
      this.root.add(model);
      model.traverse((o) => {
        const levels = o instanceof THREE.Mesh ? DETAIL_LEVELS.get(o.geometry) : undefined;
        if (levels) this.detailed.push({ mesh: o as THREE.Mesh, full: (o as THREE.Mesh).geometry, levels });
      });
      this.engines.set(id, collectEngines(model));
      this.surfaces.push(...(id === 'ship' ? flaps(model) : gridFins(model)));
      this.frostStages.set(id, this.frost.addStage(model, def));
      this.heatUp(model);
      // The cluster plume starts at the stage's nozzle exit plane (booster base / RVac exits).
      const plume = new Plume(def, id === 'booster' ? 0 : BOOSTER_LENGTH);
      this.plumes.set(id, plume);
      this.root.add(plume.group);
      toFxLayer(plume.group);
    }
  }

  /** time: simulation time, s (drives flicker and frost). Call after setting root.quaternion. */
  update(snap: VehicleSnapshot, time: number): void {
    // Reentry plasma: direction of travel through the air, ENU -> world -> mesh-local.
    const [e, n, u] = snap.telemetry.vAirEnu;
    this.motion.set(e, u, -n);
    if (this.motion.lengthSq() > 1) this.motion.normalize().applyQuaternion(this.qInv.copy(this.root.quaternion).invert());
    this.plasma.update(snap.telemetry.heatFlux, this.motion, time);
    this.updateHeat(snap, time, e, n, u);

    // Flaps and grid fins at the angles the sim's actuators have them.
    for (const f of this.surfaces) {
      const ang = snap.surfaces.find((x) => x.name === f.name);
      if (ang) f.pivot.angle = f.sense * (ang.angle - f.rest);
    }

    for (const [id, plume] of this.plumes) {
      const s = snap.stageState[id];
      if (!s) continue;
      plume.update(s.throttles, snap.telemetry.pAmb, time);
      this.frostStages.get(id)?.update(s.propFrac, time);

      // Gimbal: thrust along body (1, gy, gz) means the nozzle points along -(1, gy, gz);
      // body (x, y, z) -> mesh (y, x, -z).
      const [gy, gz] = s.gimbal;
      this.nozzle.set(-gy, -1, gz).normalize();
      this.engines.get(id)?.forEach((e, i) => {
        if (s.gimbals[i]) e.node.quaternion.setFromUnitVectors(DOWN, this.nozzle);
        e.glow.emissiveIntensity = s.throttles[i] > 0.02 ? 2 + 4 * s.throttles[i] : 0;
      });
    }
  }

  /** Call once the root is placed for this frame (camera-relative, so its distance is the camera's). */
  afterPlace(): void {
    // Level of detail from the camera's distance to the vehicle's middle.
    const d = Math.max(0, this.root.position.length() - 40);
    for (const m of this.detailed) {
      let g = m.full;
      for (const l of m.levels) if (d >= l.distance) g = l.geometry;
      if (m.mesh.geometry !== g) m.mesh.geometry = g;
    }
    this.root.updateMatrixWorld();
    this.frost.updateMatrix();
  }

  /** Give this stage's materials the reentry glow (tiles, or bare steel for the rest). */
  private heatUp(model: THREE.Object3D): void {
    const engineGlow = new Set<THREE.Material>();
    for (const list of this.engines.values()) for (const e of list) engineGlow.add(e.glow);
    const done = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const swap = (m: THREE.Material): THREE.Material => {
        if (engineGlow.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
        let c = done.get(m);
        if (!c) {
          // Materials already patched for this vehicle (the frost) are its own: patch in place.
          const own = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
          c = own ? m : m.clone();
          heatMaterial(c as THREE.MeshStandardMaterial, this.heat, m.name === 'Heatshield Tiles');
          done.set(m, c);
          if (!own) this.owned.push(c);
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  }

  /**
   * Tile and steel temperatures from the sim's heating: the tiles follow the plasma heating
   * closely; bare steel in the flow warms over a few seconds and cools over tens, and glows
   * white-hot as the heat damage nears burn-through.
   */
  private updateHeat(snap: VehicleSnapshot, time: number, e: number, n: number, u: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(1, time - this.lastTime));
    this.lastTime = time;
    const h = snap.health;
    const hasTiles = snap.stages.includes('ship');
    const tileTarget = hasTiles ? plasmaIntensity(h.flux) * h.shielded : 0;
    const bare = h.flux * (1 - h.shielded);
    // Steel in the flow glows red-orange at once (a thin wall); the heat damage it's taken keeps
    // it glowing and drives it yellow-white toward burn-through.
    const steelTarget = Math.min(1, THREE.MathUtils.clamp((bare - 1.5e4) / 2e5, 0, 0.45) + 0.55 * h.heat ** 0.8);
    this.tileTemp += (tileTarget - this.tileTemp) * Math.min(1, dt / 1.5);
    const tau = steelTarget > this.steelTemp ? 1.2 : 20;
    this.steelTemp += (steelTarget - this.steelTemp) * Math.min(1, dt / tau);
    const speed = Math.hypot(e, n, u);
    if (speed > 1) this.heat.uHeatFlow.value.set(e / speed, u / speed, -n / speed);
    this.heat.uTileHeat.value = this.tileTemp;
    this.heat.uSteelHeat.value = this.steelTemp;
    this.heat.uHeatTime.value = time;
    // Sparks off hot steel (and a few off the tiles at the height of the heating).
    const rate = Math.max(0, (this.steelTemp - 0.35) / 0.5) + Math.max(0, this.tileTemp - 0.75) * 0.3;
    this.sparks.update(rate, this.motion, speed, time, VehicleMesh.pixelRatio, VehicleMesh.screenScale);
  }

  dispose(): void {
    for (const list of this.engines.values()) for (const e of list) e.glow.dispose();
    for (const m of this.owned) m.dispose();
    this.frost.dispose();
  }
}

/** Engine nodes in simulation order, each with its own glowing nozzle-interior material. */
function collectEngines(model: THREE.Object3D): EngineNode[] {
  const nodes: THREE.Object3D[] = [];
  model.traverse((o) => {
    if (/^Engine_\d+$/.test(o.name)) nodes[Number(o.name.slice(7))] = o;
  });
  return nodes.map((node) => {
    const inner = node.children.find((c) => c.name.endsWith('_Inner')) as THREE.Mesh | undefined;
    const glow = ((inner?.material as THREE.MeshStandardMaterial | undefined)?.clone() ??
      new THREE.MeshStandardMaterial()) as THREE.MeshStandardMaterial;
    glow.emissive = GLOW;
    glow.emissiveIntensity = 0;
    if (inner) inner.material = glow;
    return { node, glow };
  });
}

/**
 * Starship's four flaps. The sim measures a flap's angle from folded back against the leeward
 * (body -y) side (0) to straight out sideways (90 deg); here each node's rest angle in those terms
 * comes from the model, and the hinge sense from which way turning it swings the tip leeward.
 * (Mesh axes: +Y = body x, +X = body y, -Z = body z.)
 */
function flaps(model: THREE.Object3D): Surface[] {
  const out: Surface[] = [];
  model.updateMatrixWorld(true);
  const leewardWorld = new THREE.Vector3(-1, 0, 0).transformDirection(model.matrixWorld);
  for (const fwd of [1, -1]) {
    for (const side of [1, -1] as const) {
      const name = `Flap_${fwd > 0 ? 'Fwd' : 'Aft'}_${side > 0 ? 'L' : 'R'}`;
      const node = model.getObjectByName(name);
      if (!node) continue;
      const mesh = node.children[0] ?? node;
      const tipWorld = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      // Rest angle: the flap's span direction (hinge to tip, square to the body axis).
      const span = tipWorld.clone().sub(node.getWorldPosition(new THREE.Vector3()));
      const rest = Math.atan2(side * -span.z, -span.x);
      // Hinge sense: turning the node by +angle about its Y moves the tip by Y x tip.
      const tip = node.worldToLocal(tipWorld.clone());
      tip.y = 0;
      const q = node.getWorldQuaternion(new THREE.Quaternion()).invert();
      const lee = leewardWorld.clone().applyQuaternion(q);
      const retracts = new THREE.Vector3(0, 1, 0).cross(tip).dot(lee) > 0;
      out.push({ name, pivot: new Pivot(node), sense: retracts ? -1 : 1, rest });
    }
  }
  return out;
}

/**
 * Super Heavy's three grid fins. Each node turns about its outward radial axis, the same axis
 * and sense as the sim's fin angle (0 = the fin's plane along the booster).
 */
function gridFins(model: THREE.Object3D): Surface[] {
  const out: Surface[] = [];
  for (const name of ['GridFin_Catch_A', 'GridFin_Catch_B', 'GridFin_Rudder']) {
    const node = model.getObjectByName(name);
    if (node) out.push({ name, pivot: new Pivot(node), sense: 1, rest: 0 });
  }
  return out;
}
