// Vehicle meshes: the Blender-built Super Heavy / Starship models (art/blender), plus
// exhaust plumes and tank frost. Mesh-local frame: +Y along the stack axis, y = 0 at the
// booster base, matching the physics body frame. Engine nodes are driven by the simulated gimbal.

import * as THREE from 'three';
import { BOOSTER_LENGTH, STARLINK_V3, STARSHIP_V3, SUPER_HEAVY_V3 } from '../sim/config/starshipV3';
import type { StageId } from '../sim/vehicle';
import { toFxLayer } from './atmosphere';
import { Frost } from './fx/frost';
import { Plasma, plasmaIntensity } from './fx/plasma';
import { type HeatUniforms, Sparks, heatMaterial, heatUniforms } from './fx/reentryHeat';
import { Plume } from './fx/plume';
import type { VehicleSnapshot } from '../sim/simulation';
import type { ShieldSnapshot } from '../sim/heatShield';
import { TileGaps } from './tileGaps';
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
  /** The payload bay's PEZ door (the ship model's "Cargo Door"), where it sits closed, and the dark bay behind it. */
  private door: { node: THREE.Object3D; closed: THREE.Vector3; bay: THREE.Mesh; lamp: THREE.PointLight } | null = null;
  /** The payload slot cut through the hull while the door is open (cutSlot), and the ship model it's in. */
  private slot = { uSlotFromWorld: { value: new THREE.Matrix4() }, uSlotOpen: { value: 0 } };
  private slotModel: THREE.Object3D | null = null;
  /** Gaps in the heat shield where tiles are missing (ship only). */
  private gaps: TileGaps | null = null;
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
      if (id === 'ship') this.door = payloadDoor(model);
      if (id === 'ship') {
        this.gaps = new TileGaps();
        this.root.add(this.gaps.group);
      }
      this.frostStages.set(id, this.frost.addStage(model, def));
      this.heatUp(model);
      if (id === 'ship' && this.door) {
        this.slotModel = model;
        cutSlot(model, this.slot);
      }
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

  /**
   * The payload door: 0 closed .. 1 open. It opens the way the PEZ door does on the flight
   * videos: in, then away along the hull's inside, leaving the slot open onto the dark bay.
   */
  setPayloadDoor(open: number, inside = false): void {
    const d = this.door;
    if (!d) return;
    const a = THREE.MathUtils.clamp(open / 0.35, 0, 1);
    const b = THREE.MathUtils.clamp((open - 0.35) / 0.65, 0, 1);
    // (Model axes: +X toward the axis from the door, +Y up the ship.)
    d.node.position.copy(d.closed).add(new THREE.Vector3(0.3 * a + 0.15 * b, 1.3 * b * b * (3 - 2 * b), 0));
    // The dark strip over the slot is for looking at it from outside; from the bay camera it would
    // block the view out.
    d.bay.visible = open > 0.002 && !inside;
    // (And the door, slid up inside the bay, would fill the bay camera's view: it isn't drawn there.)
    d.node.visible = !inside;
    // (The bay's lamps: on while the door is open. Never removed, only dimmed: taking a light out
    // of the scene would rebuild every shader.)
    d.lamp.intensity = open > 0.002 ? BAY_LAMP : 0;
    this.slot.uSlotOpen.value = open > 0.02 ? 1 : 0;
  }

  /** The heat shield's gaps (missing tiles) and how hot / charred they are. */
  setShield(s: ShieldSnapshot): void {
    this.gaps?.update(s);
  }

  /** Call once the root is placed for this frame (camera-relative, so its distance is the camera's). */
  afterPlace(): void {
    if (this.slotModel && this.slot.uSlotOpen.value > 0) {
      this.slotModel.updateMatrixWorld(true);
      this.slot.uSlotFromWorld.value.copy(this.slotModel.matrixWorld).invert();
    }
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
    this.gaps?.dispose();
    for (const list of this.engines.values()) for (const e of list) e.glow.dispose();
    for (const m of this.owned) m.dispose();
    this.frost.dispose();
  }
}

/**
 * The ship's PEZ door, and the bay behind its slot: a dark box just inside the hull, shown while
 * the door is open (the hull has a hole there, under the door).
 */
function payloadDoor(model: THREE.Object3D): { node: THREE.Object3D; closed: THREE.Vector3; bay: THREE.Mesh; lamp: THREE.PointLight } | null {
  // (three.js loads "Cargo Door" as "Cargo_Door".)
  const node = model.getObjectByName('Cargo_Door') ?? model.getObjectByName('Cargo Door');
  if (!node) return null;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  const local = box.clone().applyMatrix4(new THREE.Matrix4().copy(model.matrixWorld).invert());
  const size = local.getSize(new THREE.Vector3());
  // The open slot: a dark strip on the hull where the door was (a hair proud of the skin, so it
  // shows whether or not the hull is cut there), curved round with it. A satellite on its way
  // out is hidden behind it until it clears the skin: it slides out of the dark.
  const r = 4.58;
  const half = Math.asin(Math.min(0.99, (size.z * 0.5) / 4.5));
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = -half + (2 * half * i) / n;
    for (const y of [local.min.y + 0.02, local.max.y - 0.02]) pos.push(-r * Math.cos(t), y, r * Math.sin(t));
  }
  for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const bay = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide }));
  bay.visible = false;
  bay.name = 'PayloadBay';
  model.add(bay);
  const lamp = payloadBay(model, local, half);
  return { node, closed: node.position.clone(), bay, lamp };
}

/** The payload slot in the ship model's axes: its height range (m), half-angle round the hull from -X, and the skin's radius range. */
const SLOT = { y0: 34.66, y1: 35.51, half: Math.asin(3.76 / 4.5), r0: 4.15, r1: 4.85 };

/**
 * Cut the payload slot through the ship's hull while the door is open (the model's skin has no
 * hole under the door): the hull's pixels in the slot are discarded, so from the bay the slot
 * opens onto space. Only a thin shell at the hull's radius is cut, so nothing else in the model
 * (the door itself, the flaps) is touched.
 */
function cutSlot(model: THREE.Object3D, u: { uSlotFromWorld: { value: THREE.Matrix4 }; uSlotOpen: { value: number } }): void {
  const done = new Set<THREE.Material>();
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name === 'PayloadBay' || o.parent?.name === 'PayloadBayInside') return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (done.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      done.add(m);
      const prev = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? m.onBeforeCompile.bind(m) : null;
      const prevKey = prev ? m.customProgramCacheKey() : '';
      m.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
        prev?.(shader, renderer);
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vSlotWorld;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlotWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform mat4 uSlotFromWorld;\nuniform float uSlotOpen;\nvarying vec3 vSlotWorld;')
          .replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
if (uSlotOpen > 0.5) {
  vec3 sp = (uSlotFromWorld * vec4(vSlotWorld, 1.0)).xyz;
  float sr = length(sp.xz);
  if (sp.y > ${SLOT.y0.toFixed(3)} && sp.y < ${SLOT.y1.toFixed(3)} && sr > ${SLOT.r0.toFixed(3)} && sr < ${SLOT.r1.toFixed(3)} && abs(atan(sp.z, -sp.x)) < ${SLOT.half.toFixed(4)}) discard;
}`,
          );
      };
      m.customProgramCacheKey = () => `${prevKey}|pez-slot-v1`;
      m.needsUpdate = true;
    }
  });
}

/** The bay lamps' brightness (the sun is 2.6): a dim working light a few metres out. */
const BAY_LAMP = 25;

/**
 * Inside the payload bay (seen only from the bay camera: the hull hides it from outside): a dark
 * wall just inside the skin all round, open where the slot is, closed top and bottom, two
 * dispenser rails the satellites stack along, and a lamp over the slot. slot: the door's box in
 * model axes; half: the slot's half-angle round the hull.
 */
function payloadBay(model: THREE.Object3D, slot: THREE.Box3, half: number): THREE.PointLight {
  const group = new THREE.Group();
  group.name = 'PayloadBayInside';
  // From just below the slot (the model's tank dome is the floor there) to just over the stack's
  // top, up in the nose: the wall just inside the skin, following the nose's taper.
  const bottom = slot.min.y - 0.6;
  const top = STARLINK_V3.doorX + STARLINK_V3.count * STARLINK_V3.pitch + 0.5;
  const radius = (y: number) => Math.min(4.32, hullRadiusAt(y) - 0.12);
  // (Unlit: the sun's light doesn't stop at the hull (no shadow reaches in here), so a lit wall
  // would glare. A dim grey, lighter near the slot where the daylight spills in.)
  const wall = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const shade = (x: number, y: number, z: number) => {
    const d = Math.hypot(x + 4.5, (y - STARLINK_V3.doorX) * 1.6, z * 0.35);
    return 0.05 + 0.13 * Math.exp(-d / 2.2);
  };
  // The wall: a grid round the hull and up it, without the cells over the slot.
  const rows = [bottom, slot.min.y, slot.max.y];
  for (let y = Math.ceil(slot.max.y + 0.01); y < top; y += 0.5) rows.push(y);
  rows.push(top);
  const n = 72;
  const pos: number[] = [];
  const idx: number[] = [];
  const angle = (i: number) => -Math.PI + (2 * Math.PI * i) / n;
  for (const y of rows) for (let i = 0; i <= n; i++) pos.push(-radius(y) * Math.cos(angle(i)), y, radius(y) * Math.sin(angle(i)));
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      // (The door side, -X, is at angle 0.)
      if (r === 1 && Math.abs(angle(i + 0.5)) < half + 0.01) continue;
      const k = r * (n + 1) + i;
      idx.push(k, k + n + 1, k + 1, k + 1, k + n + 1, k + n + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  const shadeOf = (p: number[]) => {
    const c: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
      const v = shade(p[i], p[i + 1], p[i + 2]);
      c.push(v, v, v * 1.06);
    }
    return new THREE.Float32BufferAttribute(c, 3);
  };
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', shadeOf(pos));
  g.setIndex(idx);
  group.add(new THREE.Mesh(g, wall));
  for (const y of [bottom, top]) {
    const cg = new THREE.CircleGeometry(radius(y), n);
    cg.rotateX(-Math.PI / 2);
    cg.translate(0, y, 0);
    cg.setAttribute('color', shadeOf(Array.from(cg.attributes.position.array)));
    group.add(new THREE.Mesh(cg, wall));
  }
  // The dispenser's rails, at either end of the stack (on the ship's axis, across the slot).
  const rail = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.45, metalness: 0.8 });
  const len = top - slot.min.y;
  for (const z of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.3, len, 0.14), rail);
    r.position.set(0, slot.min.y + len / 2, z * (STARLINK_V3.length / 2 + 0.12));
    group.add(r);
  }
  const lamp = new THREE.PointLight(0xfff2e0, 0, 30, 2);
  lamp.position.set(2.9, slot.max.y + 1.5, 0);
  group.add(lamp);
  model.add(group);
  return lamp;
}

/** The ship's hull radius at a height above its base (m): the barrel, then the nose's taper. */
function hullRadiusAt(y: number): number {
  if (y <= 38) return 4.5;
  const t = Math.min(1, (y - 38) / (52.1 - 38));
  return Math.max(0.6, 4.5 * Math.pow(1 - t * t, 0.62));
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
