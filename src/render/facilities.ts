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
}

const R_EARTH = 6371000;
/** Local (east, north, up) -> render world (x = E, y = U, z = -N). */
const ENU_TO_WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** Building styles (the shader's aInfo.z). */
const STYLE = { shed: 0, house: 1, bay: 2, plain: 3, office: 4 } as const;

/** Wall colours (sRGB): mostly SpaceX white and light grey, some older tan and blue-grey sheds. */
const SHED_COLORS = [0xe9ebec, 0xe2e4e6, 0xd9dcdf, 0xeceae4, 0xcfd4d9, 0xd8cfbd, 0xc5ccd3];
const HOUSE_COLOR = 0x26282b;
const BAY_COLOR = 0xeef0f1;
const CONCRETE = 0xb3b1ab;
const ROOFTOP = 0xc4c7ca;

const buildingMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.62 });
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
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
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
    // The bays: a darker band along the top, and the big sectional door.
    if (bH > bTop - 4.0) diffuseColor.rgb *= 0.82;
    if (dot(bN.xz, vDoor.xy) > 0.9 && abs(bAlong - vDoor.z) < vDoor.w * 0.5 && bH < bTop * 0.86) {
      bRib = 0.0;
      float panel = 1.0 - smoothstep(0.0, 0.08, abs(fract(bH / 2.6) - 0.5) * 2.0 - 0.9);
      float panelFade = 1.0 - smoothstep(0.1, 0.3, fwidth(bH) / 2.6);
      diffuseColor.rgb = vec3(0.47, 0.49, 0.5) * (1.0 - 0.25 * panel * panelFade);
      // (Its frame.)
      if (abs(bAlong - vDoor.z) > vDoor.w * 0.5 - 1.2 || bH > bTop * 0.86 - 1.2) diffuseColor.rgb = vec3(0.3, 0.31, 0.32);
    }
  }
  if (bStyle == 1 || bStyle == 4) {
    // Houses and offices: a ribbon of windows along each floor (3 m), split by mullions.
    float wy = fract(bH / 3.0);
    float mull = step(0.08, fract(bAlong / 1.6));
    float win = mull * step(0.38, wy) * step(wy, 0.72) * step(bH, bTop - 0.8) * step(0.8, bH);
    bGlass = win * bDetail * (1.0 - smoothstep(0.1, 0.25, fwidth(bAlong) / 1.6));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.12, 0.14), bGlass);
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
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
if (bRib != 0.0) {
  vec3 bTv = normalize((viewMatrix * vec4(bT.x, 0.0, bT.y, 0.0)).xyz);
  normal = normalize(normal + bTv * bRib * 0.22);
}`,
    );
};
buildingMaterial.customProgramCacheKey = () => 'starbase-buildings-v2';

const MATERIALS = {
  buildings: buildingMaterial,
  tank: new THREE.MeshStandardMaterial({ color: 0xeef0f2, metalness: 0.3, roughness: 0.35 }),
  // The rocket garden: stainless steel (a little less mirror-like than the flight vehicles, so it
  // doesn't just reflect the brown marsh).
  steel: new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 0.45, roughness: 0.3 }),
};

/** A deterministic 0..1 value from a building's centre. */
const hash = (e: number, n: number) => {
  const s = Math.sin(e * 12.9898 + n * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Put the per-building attributes on a geometry: colour, (ground, height, style, seed) and the door. */
function tag(g: THREE.BufferGeometry, color: THREE.Color, info: [number, number, number, number], door: [number, number, number, number] = [0, 0, 0, 0]): THREE.BufferGeometry {
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
  const { facilities } = (await res.json()) as { facilities: Facility[] };
  const parts: Record<keyof typeof MATERIALS, THREE.BufferGeometry[]> = { buildings: [], tank: [], steel: [] };
  /** Vehicles on display (drawn with the real models, rocketGarden.ts, once they're loaded). */
  const garden: GardenVehicle[] = [];
  const color = new THREE.Color();

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
      } else if (f.material === 'house') {
        style = STYLE.house;
        color.setHex(HOUSE_COLOR);
      } else {
        // Small buildings are mostly offices and trailers (windows); the rest are sheds.
        const footprint = Math.abs(shape.getPoints().reduce((a, p, i, ps) => a + p.x * ps[(i + 1) % ps.length].y - ps[(i + 1) % ps.length].x * p.y, 0) / 2);
        style = footprint < 250 && f.height <= 7 && seed < 0.55 ? STYLE.office : STYLE.shed;
        color.setHex(SHED_COLORS[Math.floor(seed * SHED_COLORS.length)]);
        // Rooftop units on the bigger sheds.
        if (footprint > 700 && f.height >= 5) {
          const units = 2 + Math.floor(seed * 4);
          const box = new THREE.Box2().setFromPoints(shape.getPoints());
          for (let k = 0; k < units; k++) {
            const u = hash(e + k * 7.1, n - k * 3.3);
            const w = hash(e - k, n + k);
            const [x, y] = [box.min.x + (box.max.x - box.min.x) * (0.25 + 0.5 * u), box.min.y + (box.max.y - box.min.y) * (0.25 + 0.5 * w)];
            const s = 2 + 2.5 * u;
            const unit = new THREE.BoxGeometry(s, 1.4 + w, s * (0.7 + 0.6 * w));
            unit.translate(e + x, y0 + f.height + (1.4 + w) / 2, -(n + y));
            parts.buildings.push(tag(unit, new THREE.Color(ROOFTOP), [y0 + f.height, 1.4 + w, STYLE.plain, u]));
          }
        }
      }
      parts.buildings.push(tag(g, color, [y0, f.height, style, seed], door));
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
