// Starbase buildings and tanks from OpenStreetMap (public/terrain/facilities.json, built by
// scripts/terrain/build-tiles.ts): extruded footprints and cylinders on top of the imagery.
// Positions are local east/north metres from the pad; the Earth's curvature drop is applied so
// distant buildings sit on the curved terrain.
//
// All the buildings share one mesh and one material (one draw call); what makes them look like
// Starbase is in the shader, from a few numbers per building (its ground height, height, style
// and a big door's place):
//   - SpaceX's white corrugated-steel sheds and bays: vertical ribs (in the lighting), panel
//     seams, weathering near the ground, flat grey roofs with a few rooftop units;
//   - the Mega Bays and Gigabay: a darker parapet band and their huge sectional doors;
//   - the Starbase village houses: painted black with white trim, and windows;
//   - the tank farm's horizontal tanks on concrete saddles; the rocket garden in stainless steel.
// Detail fades out with distance (no shimmer, and nothing to pay for far away).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD } from '../sim/constants';
import { TRENCHES, insideTrench } from './launchSite';
import { EXTRA_FACILITIES } from './facilitiesExtra';
import { setSiteMask } from './terrain';
import type { GardenVehicle } from './rocketGarden';

interface Facility {
  kind: 'building' | 'vtank' | 'htank';
  name?: string;
  ring?: number[][];
  center: number[];
  base: number;
  height: number;
  diameter?: number;
  length?: number;
  angle?: number;
  material: 'industrial' | 'bay' | 'house' | 'tank' | 'rocket';
  /** (Hand-added, facilitiesExtra.ts.) A gable roof rising this much above the eaves, m. */
  gable?: number;
  /** (Hand-added.) An office or parking structure: ribbons of windows / openings. */
  office?: boolean;
}

const R_EARTH = 6371000;
/** Local (east, north, up) -> render world (x = E, y = U, z = -N). */
const ENU_TO_WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** Building styles (the shader's aInfo.z). */
export const STYLE = { shed: 0, house: 1, bay: 2, plain: 3, office: 4 } as const;

/** Wall colours (sRGB): mostly SpaceX white and light grey, some older tan and blue-grey sheds. */
const SHED_COLORS = [0xe9ebec, 0xe2e4e6, 0xd9dcdf, 0xeceae4, 0xcfd4d9, 0xd8cfbd, 0xc5ccd3];
const HOUSE_COLOR = 0x26282b;
const BAY_COLOR = 0xeef0f1;
const CONCRETE = 0xb3b1ab;
const ROOFTOP = 0xc4c7ca;

/** Shared by every building: how dark it is (0 day .. 1 night), for their lit windows. */
export const buildingUniforms = { uNight: { value: 0 } };

/** Set from the sun's direction (render world, y up at the pad) each frame. */
export function setBuildingNight(sunUp: number): void {
  buildingUniforms.uNight.value = 1 - THREE.MathUtils.smoothstep(sunUp, -0.1, 0.03);
}

export const buildingMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.62 });
buildingMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute vec4 aInfo;
attribute vec4 aDoor;
varying vec3 vObj;
varying vec3 vObjN;
varying vec4 vInfo;
varying vec4 vDoor;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vObj = position;
vObjN = normal;
vInfo = aInfo;
vDoor = aDoor;`,
    );
  shader.uniforms.uNight = buildingUniforms.uNight;
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
uniform float uNight;
varying vec3 vObj;
varying vec3 vObjN;
varying vec4 vInfo;
varying vec4 vDoor;
// A line of the given width every period along x, anti-aliased: far away it becomes the average
// tint of the lines instead of shimmering.
float aaLine(float x, float period, float width) {
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  float w = max(fwidth(x), 1e-4);
  return (1.0 - smoothstep(width * 0.5 - w, width * 0.5 + w, d)) * min(1.0, width / (2.0 * w)) + max(0.0, 1.0 - width / (2.0 * w)) * (width / period);
}`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
// --- Starbase building surfaces (object space = pad-local world axes: x = E, y = U, z = -N) ---
float bDetail = 1.0 - smoothstep(300.0, 1100.0, length(vViewPosition));
vec3 bN = normalize(vObjN);
float bWall = 1.0 - smoothstep(0.35, 0.7, abs(bN.y));
vec2 bT = normalize(vec2(-bN.z, bN.x) + vec2(1e-6));
float bAlong = dot(vObj.xz, bT);
float bH = vObj.y - vInfo.x;
float bTop = vInfo.y;
int bStyle = int(vInfo.z + 0.5);
float bRib = 0.0;
float bGlass = 0.0;
// Light from inside at night (windows, the bays' clerestories): colour, intensity.
vec3 bLight = vec3(0.0);
if (bWall > 0.5) {
  if (bStyle == 0 || bStyle == 2) {
    // Corrugated steel: vertical ribs (in the lighting, below), panel seams every ~6 m. Each
    // fades out before it gets finer than a couple of pixels (it would shimmer into moire).
    float ribFade = 1.0 - smoothstep(0.08, 0.2, fwidth(bAlong) / 0.4);
    bRib = sin(bAlong * 6.2832 / 0.4) * ribFade;
    // Horizontal girts every ~6 m and vertical panel joints every ~9 m (the bays' big panels).
    float girt = aaLine(bH, 6.1, 0.35);
    float joint = aaLine(bAlong, bStyle == 2 ? 9.2 : 12.0, 0.45);
    diffuseColor.rgb *= 1.0 - 0.13 * max(girt, joint);
  }
  if (bStyle == 2) {
    // The high bays. Structural columns every ~9 m show through the cladding as darker lines.
    float column = aaLine(bAlong, 9.2, 0.9);
    diffuseColor.rgb *= 1.0 - 0.12 * column;
    // A parapet band along the top, and below it a clerestory: a band of translucent panels
    // (light, a little blue, glossy) split by mullions, that lets daylight into the bay.
    if (bH > bTop - 3.5) diffuseColor.rgb = vec3(0.62, 0.64, 0.66);
    float clere = step(bTop - 11.0, bH) * step(bH, bTop - 5.0);
    if (clere > 0.0) {
      float mullion = aaLine(bAlong, 3.05, 0.35);
      diffuseColor.rgb = mix(vec3(0.7, 0.76, 0.8), vec3(0.45, 0.47, 0.49), mullion);
      bGlass = 0.6 * (1.0 - mullion);
      // The bays work round the clock: their clerestories glow white.
      bLight = vec3(0.9, 0.95, 1.0) * 0.9 * (1.0 - mullion);
      bRib = 0.0;
    }
    // A concrete plinth round the base.
    if (bH < 3.2) { diffuseColor.rgb = vec3(0.52, 0.51, 0.48); bRib = 0.0; }
    // The big sectional door (and its header), on the wall facing the launch site.
    float doorTop = min(bTop * 0.84, bTop - 14.0);
    float across = abs(bAlong - vDoor.z);
    if (dot(bN.xz, vDoor.xy) > 0.9 && across < vDoor.w * 0.5 + 2.5 && bH < doorTop + 5.0) {
      bRib = 0.0;
      if (across < vDoor.w * 0.5 && bH < doorTop) {
        // Horizontal door sections, a vertical split down the middle.
        float section = aaLine(bH, 2.6, 0.18);
        float split = aaLine(bAlong - vDoor.z, vDoor.w, 0.5);
        diffuseColor.rgb = vec3(0.5, 0.52, 0.53) * (1.0 - 0.3 * max(section, split));
      } else {
        // The frame and the header box above it.
        diffuseColor.rgb = vec3(0.33, 0.34, 0.35);
      }
    }
  }
  if (bStyle == 1 || bStyle == 4) {
    // Houses and offices: a ribbon of windows along each floor (3 m), split by mullions.
    float wy = fract(bH / 3.0);
    float mull = step(0.08, fract(bAlong / 1.6));
    float win = mull * step(0.38, wy) * step(wy, 0.72) * step(bH, bTop - 0.8) * step(0.8, bH);
    float winFade = 1.0 - smoothstep(0.1, 0.25, fwidth(bAlong) / 1.6);
    bGlass = win * bDetail * winFade;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.12, 0.14), bGlass);
    // At night about half the windows are lit, warm (each 1.6 m pane of each floor on its own);
    // far away, where panes merge, the wall glows with their average.
    float room = fract(sin(dot(vec3(floor(bH / 3.0), floor(bAlong / 4.8), vInfo.w * 97.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    // (A quarter of the buildings are dark: shut, or everyone's asleep.)
    float occupied = step(0.25, fract(vInfo.w * 7.31));
    float lit = step(0.55, room) * (0.7 + 0.6 * fract(room * 13.1)) * occupied;
    float near = win * lit;
    // Far off (panes smaller than a pixel): a sparse scatter of lit rooms, 6 m x 1 floor each, so a
    // distant town at night is points of light (a twinkle as they come and go at the pixel size).
    float cell = fract(sin(dot(vec3(floor(bH / 3.0), floor(bAlong / 6.0), vInfo.w * 53.0), vec3(39.35, 11.13, 83.17))) * 24634.63);
    float far = step(0.7, cell) * 0.45 * occupied * step(0.8, bH) * step(bH, bTop - 0.8);
    bLight = vec3(1.0, 0.72, 0.42) * 2.0 * mix(far, near, winFade);
  }
  if (bStyle == 1) {
    // Painted black, with white fascia and skirting.
    if (bH > bTop - 0.45 || bH < 0.35) diffuseColor.rgb = vec3(0.85);
  }
  // Weathering: dirt and splash near the ground.
  if (bStyle != 3) diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 2.2, bH));
} else if (bN.y > 0.5) {
  // Flat roofs: a little darker, with faint sheet lines.
  diffuseColor.rgb *= 0.86 - 0.05 * (1.0 - smoothstep(0.0, 0.08, abs(fract(vObj.x / 1.5) - 0.5))) * bDetail;
}`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.1, bGlass);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
totalEmissiveRadiance += bLight * uNight;`,
    )
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
if (bRib != 0.0) {
  vec3 bTv = normalize((viewMatrix * vec4(bT.x, 0.0, bT.y, 0.0)).xyz);
  normal = normalize(normal + bTv * bRib * 0.22);
}`,
    );
};
buildingMaterial.customProgramCacheKey = () => 'starbase-buildings-v6';

const MATERIALS = {
  buildings: buildingMaterial,
  tank: new THREE.MeshStandardMaterial({ color: 0xeef0f2, metalness: 0.3, roughness: 0.35 }),
  // The rocket garden: stainless steel (a little less mirror-like than the flight vehicles, so it
  // doesn't just reflect the brown marsh).
  steel: new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 0.45, roughness: 0.3 }),
};

/** A deterministic 0..1 value from a building's centre. */
export const hash = (e: number, n: number) => {
  const s = Math.sin(e * 12.9898 + n * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Put the per-building attributes on a geometry: colour, (ground, height, style, seed) and the door. */
export function tag(g: THREE.BufferGeometry, color: THREE.Color, info: [number, number, number, number], door: [number, number, number, number] = [0, 0, 0, 0]): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const n = ng.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const inf = new Float32Array(n * 4);
  const dr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col.set([color.r, color.g, color.b], i * 3);
    inf.set(info, i * 4);
    dr.set(door, i * 4);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aInfo', new THREE.BufferAttribute(inf, 4));
  ng.setAttribute('aDoor', new THREE.BufferAttribute(dr, 4));
  ng.deleteAttribute('uv');
  return ng;
}

/**
 * A bay's big door: on its longest wall facing the launch site (east), centred on it; as
 * (outward normal x, z in world axes, position along the wall, width).
 */
function doorFor(ring: number[][]): [number, number, number, number] {
  // Signed area: counter-clockwise rings have their outward normal to the right of each edge.
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  const ccw = area > 0;
  let best: { score: number; door: [number, number, number, number] } | null = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 15) continue;
    // Outward normal in east / north.
    let [ne, nn] = [(by - ay) / len, -(bx - ax) / len];
    if (!ccw) [ne, nn] = [-ne, -nn];
    const score = len * (1.2 + ne);
    if (best && score <= best.score) continue;
    // World axes: x = east, z = -north. The shader's "along" axis is (-n.z, n.x) in (x, z).
    const [nx, nz] = [ne, -nn];
    const [tx, tz] = [-nz, nx];
    const [mx, mz] = [(ax + bx) / 2, -(ay + by) / 2];
    best = { score, door: [nx, nz, mx * tx + mz * tz, Math.min(len * 0.62, 60)] };
  }
  return best?.door ?? [0, 0, 0, 0];
}

export async function loadFacilities(): Promise<THREE.Group> {
  const res = await fetch(`${import.meta.env.BASE_URL}terrain/facilities.json`);
  const facilities: Facility[] = [...((await res.json()) as { facilities: Facility[] }).facilities, ...EXTRA_FACILITIES];
  const parts: Record<keyof typeof MATERIALS, THREE.BufferGeometry[]> = { buildings: [], tank: [], steel: [] };
  /** Vehicles on display (drawn with the real models, rocketGarden.ts, once they're loaded). */
  const garden: GardenVehicle[] = [];
  const color = new THREE.Color();

  /** Boxy rooftop units (air handling, vents) on a flat roof at height `top`. */
  const roofUnits = (shape: THREE.Shape, e: number, n: number, top: number, count: number, size: number) => {
    const box = new THREE.Box2().setFromPoints(shape.getPoints());
    for (let k = 0; k < count; k++) {
      const u = hash(e + k * 7.1, n - k * 3.3);
      const w = hash(e - k, n + k);
      const [x, y] = [box.min.x + (box.max.x - box.min.x) * (0.25 + 0.5 * u), box.min.y + (box.max.y - box.min.y) * (0.25 + 0.5 * w)];
      const s = size * (1 + 1.2 * u);
      const h = size * (0.7 + 0.5 * w);
      const unit = new THREE.BoxGeometry(s, h, s * (0.7 + 0.6 * w));
      unit.translate(e + x, top + h / 2, -(n + y));
      parts.buildings.push(tag(unit, new THREE.Color(ROOFTOP), [top, h, STYLE.plain, u]));
    }
  };

  for (const f of facilities) {
    const [e, n] = f.center;
    // The V3 flame trenches and launch mounts are part of the pad model (OSM maps them as buildings).
    if (TRENCHES.some((t) => insideTrench(t, e, n))) continue;
    // Ground in render space: terrain height above the pad ground, minus curvature drop.
    const y0 = f.base - PAD.groundAlt - (e * e + n * n) / (2 * R_EARTH);
    const seed = hash(e, n);
    if (f.kind === 'building' && f.ring) {
      const shape = new THREE.Shape(f.ring.map(([x, y]) => new THREE.Vector2(x - e, y - n)));
      // Extrude along +Z (up in local ENU), sinking 1 m into the ground to hide terrain gaps.
      const g = new THREE.ExtrudeGeometry(shape, { depth: f.height + 1, bevelEnabled: false });
      g.translate(0, 0, -1);
      g.applyMatrix4(ENU_TO_WORLD);
      g.translate(e, y0, -n);
      if (f.material === 'rocket') {
        // A booster (B..) or ship (S..) on display: the real model; anything else (Starhopper)
        // stays a steel shape.
        const kind = /^B\d/.test(f.name ?? '') ? 'booster' : /^S\d/.test(f.name ?? '') ? 'ship' : null;
        if (kind) garden.push({ kind, pos: [e, y0, -n] });
        else parts.steel.push(g.index ? g.toNonIndexed() : g);
        continue;
      }
      let style: number = STYLE.shed;
      let door: [number, number, number, number] = [0, 0, 0, 0];
      if (f.material === 'bay') {
        style = STYLE.bay;
        color.setHex(BAY_COLOR);
        door = doorFor(f.ring);
        roofUnits(shape, e, n, y0 + f.height, 6, 4);
      } else if (f.material === 'house' && Math.abs(shape.getPoints().reduce((a, p, i, ps) => a + p.x * ps[(i + 1) % ps.length].y - ps[(i + 1) % ps.length].x * p.y, 0) / 2) > 400) {
        // A big residential block (apartments): light walls, windows.
        style = STYLE.office;
        color.setHex(0xd9d4ca);
      } else if (f.material === 'house') {
        style = STYLE.house;
        color.setHex(HOUSE_COLOR);
      } else {
        // Small buildings are mostly offices and trailers (windows); the rest are sheds.
        const footprint = Math.abs(shape.getPoints().reduce((a, p, i, ps) => a + p.x * ps[(i + 1) % ps.length].y - ps[(i + 1) % ps.length].x * p.y, 0) / 2);
        style = f.office || (footprint < 250 && f.height <= 7 && seed < 0.55) ? STYLE.office : STYLE.shed;
        if (f.office) color.setHex(0xc9c8c3);
        color.setHex(SHED_COLORS[Math.floor(seed * SHED_COLORS.length)]);
        // Rooftop units on the bigger sheds.
        if (footprint > 700 && f.height >= 5) roofUnits(shape, e, n, y0 + f.height, 2 + Math.floor(seed * 4), 2);
      }
      parts.buildings.push(tag(g, color, [y0, f.height, style, seed], door));
      if (f.gable) parts.buildings.push(tag(gableRoof(f.ring, y0 + f.height, f.gable), color, [y0, f.height + f.gable, STYLE.shed, seed]));
    } else if (f.kind === 'vtank') {
      const r = f.diameter! / 2;
      let g: THREE.BufferGeometry = new THREE.CylinderGeometry(r, r, f.height + 1, 24);
      g.translate(0, (f.height + 1) / 2 - 1, 0);
      // Domed top.
      const dome = new THREE.SphereGeometry(r, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.35, 1);
      dome.translate(0, f.height, 0);
      g = mergeGeometries([g.toNonIndexed(), dome.toNonIndexed()])!;
      g.translate(e, y0, -n);
      parts.tank.push(g);
    } else {
      const r = f.diameter! / 2;
      const len = f.length!;
      const g = new THREE.CapsuleGeometry(r, Math.max(0.1, len - 2 * r), 6, 16);
      // Capsule is along Y: lay it along the footprint's long axis (angle from east).
      g.rotateZ(Math.PI / 2);
      g.rotateY(f.angle!);
      g.translate(e, y0 + r + 0.6, -n);
      parts.tank.push(g.toNonIndexed());
      // Concrete saddles under it, a third of the way in from each end.
      for (const s of [-1, 1]) {
        const saddle = new THREE.BoxGeometry(1.2, 0.6 + r * 0.9, r * 1.7);
        const d = (s * (len - 2 * r)) / 3;
        saddle.rotateY(f.angle!);
        saddle.translate(e + Math.cos(f.angle!) * d, y0 + (0.6 + r * 0.9) / 2, -n - Math.sin(f.angle!) * d);
        parts.buildings.push(tag(saddle, new THREE.Color(CONCRETE), [y0, 0.6 + r * 0.9, STYLE.plain, seed]));
      }
    }
  }

  paintSiteMask(facilities);

  const group = new THREE.Group();
  group.name = 'Facilities';
  group.userData.garden = garden;
  for (const [m, geos] of Object.entries(parts) as [keyof typeof MATERIALS, THREE.BufferGeometry[]][]) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)))!;
    merged.computeVertexNormals();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, MATERIALS[m]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `facilities ${m}`;
    group.add(mesh);
  }
  return group;
}

/** Ground mask resolution, m per pixel, and how far out from the pad it covers (Starbase itself). */
const MASK_RES = 2;
const MASK_REACH: [number, number] = [5000, 3000];

/**
 * The built-up ground under and around the buildings (the aerial photo shows them there, flat,
 * leaning out with height and with their shadows): concrete round the site's buildings and
 * tanks, lawn round the village houses. The margin grows with the building's height.
 */
function paintSiteMask(facilities: Facility[]): void {
  const near = facilities.filter((f) => Math.abs(f.center[0]) < MASK_REACH[0] && Math.abs(f.center[1]) < MASK_REACH[1]);
  if (!near.length) return;
  const pad = 80;
  const minE = Math.min(...near.map((f) => f.center[0])) - pad - 150;
  const maxE = Math.max(...near.map((f) => f.center[0])) + pad + 150;
  const minN = Math.min(...near.map((f) => f.center[1])) - pad - 150;
  const maxN = Math.max(...near.map((f) => f.center[1])) + pad + 150;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((maxE - minE) / MASK_RES);
  canvas.height = Math.ceil((maxN - minN) / MASK_RES);
  const ctx = canvas.getContext('2d')!;
  const px = (e: number, n: number): [number, number] => [(e - minE) / MASK_RES, (maxN - n) / MASK_RES];
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const shape = (f: Facility) => {
    ctx.beginPath();
    if (f.kind === 'building' && f.ring) {
      f.ring.forEach(([e, n], i) => (i ? ctx.lineTo(...px(e, n)) : ctx.moveTo(...px(e, n))));
      ctx.closePath();
    } else if (f.kind === 'vtank') {
      ctx.arc(...px(f.center[0], f.center[1]), f.diameter! / 2 / MASK_RES, 0, Math.PI * 2);
    } else {
      const [c, s] = [Math.cos(f.angle!), Math.sin(f.angle!)];
      const [hl, hw] = [f.length! / 2, f.diameter! / 2];
      const corners = [[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]].map(([a, b]) => px(f.center[0] + a * c - b * s, f.center[1] + a * s + b * c));
      corners.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
    }
  };
  // Houses first (lawn, green), then everything else over them (concrete, red).
  for (const pass of ['house', 'rest'] as const) {
    for (const f of near) {
      if ((f.material === 'house') !== (pass === 'house')) continue;
      const margin = pass === 'house' ? 5 : Math.min(22, 4 + 0.18 * f.height);
      ctx.fillStyle = ctx.strokeStyle = pass === 'house' ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
      ctx.lineWidth = (2 * margin) / MASK_RES;
      shape(f);
      ctx.fill();
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  setSiteMask(tex, [minE, minN, maxE - minE, maxN - minN]);
}

/**
 * A gable roof over a rectangular footprint (ring of 4 corners + the closing point, pad-local
 * east / north): two slopes meeting at a ridge along the long axis, `rise` above the eaves at
 * `eave` (render height), and the gable-end triangles. In render world (x = E, y = U, z = -N).
 */
function gableRoof(ring: number[][], eave: number, rise: number): THREE.BufferGeometry {
  const [a, b, c, d] = ring.slice(0, 4).map(([e, n]) => new THREE.Vector3(e, eave, -n));
  // The long sides: ab and cd if ab is longer than bc.
  const [p0, p1, p2, p3] = a.distanceTo(b) >= b.distanceTo(c) ? [a, b, c, d] : [b, c, d, a];
  // Ridge endpoints over the middle of the short ends (p1-p2 and p3-p0).
  const r0 = p1.clone().add(p2).multiplyScalar(0.5).setY(eave + rise);
  const r1 = p3.clone().add(p0).multiplyScalar(0.5).setY(eave + rise);
  const tri = (...v: THREE.Vector3[]) => v.flatMap((q) => [q.x, q.y, q.z]);
  const pos = [
    // Slope along p0-p1, and the one along p2-p3 (each two triangles).
    ...tri(p0, p1, r0), ...tri(p0, r0, r1),
    ...tri(p2, p3, r1), ...tri(p2, r1, r0),
    // Gable ends.
    ...tri(p1, p2, r0), ...tri(p3, p0, r1),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // (Wound either way depending on the ring's direction: make every face point outward/up.)
  g.computeVertexNormals();
  const centre = a.clone().add(c).multiplyScalar(0.5);
  const P = g.getAttribute('position');
  const N = g.getAttribute('normal');
  for (let i = 0; i < P.count; i += 3) {
    const f = new THREE.Vector3().fromBufferAttribute(P, i).add(new THREE.Vector3().fromBufferAttribute(P, i + 1)).add(new THREE.Vector3().fromBufferAttribute(P, i + 2)).divideScalar(3);
    const n = new THREE.Vector3().fromBufferAttribute(N, i);
    const out = f.clone().sub(centre).setY(Math.max(0, f.y - eave));
    if (n.dot(out) < 0) {
      // Swap two vertices of this triangle.
      for (let k = 0; k < 3; k++) {
        const t = P.getComponent(i + 1, k);
        P.setComponent(i + 1, k, P.getComponent(i + 2, k));
        P.setComponent(i + 2, k, t);
      }
    }
  }
  g.computeVertexNormals();
  return g;
}
