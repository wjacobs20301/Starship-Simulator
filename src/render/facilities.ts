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
import { PAD, PAD2 } from '../sim/constants';
import { SITE_OUTLINE, SLAB_TOP, TRENCHES, insideTrench } from './launchSite';
import { HIGHWAY_4, ROAD_HALF } from './siteOutline';
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
/** The high bays: mid-grey ribbed steel (every photo of them: Commons "Bays + ships.jpg", "0C8A5300.jpg"). */
const BAY_COLOR = 0x8d9195;
/** Their wind girts' steel, the sheds' sheet roofs, the houses' roofs. */
const GIRT_COLOR = 0xd9dcde;
const SHED_ROOF = 0xb4b8bb;
const HOUSE_ROOF = 0x4c4f53;
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
    // A darker cap along the top (the crane's level), and below it the glazed band: blue glass
    // split by mullions, round the top of the bay (the one thing on it that isn't grey steel).
    if (bH > bTop - 3.5) diffuseColor.rgb = vec3(0.3, 0.31, 0.33);
    float clere = step(bTop - 9.5, bH) * step(bH, bTop - 4.5);
    if (clere > 0.0) {
      float mullion = max(aaLine(bAlong, 3.05, 0.3), aaLine(bH - bTop, 2.5, 0.18));
      diffuseColor.rgb = mix(vec3(0.2, 0.36, 0.5), vec3(0.3, 0.31, 0.33), mullion);
      bGlass = 0.8 * (1.0 - mullion);
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
        diffuseColor.rgb = vec3(0.3, 0.31, 0.32) * (1.0 - 0.3 * max(section, split));
      } else {
        // The frame and the header box above it.
        diffuseColor.rgb = vec3(0.2, 0.2, 0.21);
      }
    }
  }
  if (bStyle == 0 && vDoor.w > 0.5) {
    // A working shed: roll-up doors along its walls (one in two of the 15 m stretches, slatted,
    // darker than the cladding, in a frame), a door for people beside some, a flashing along
    // the foot of the wall and a gutter under the eaves.
    float cell = floor(bAlong / 15.0);
    float cx = bAlong - (cell + 0.5) * 15.0;
    float pick = fract(sin(dot(vec2(cell, vInfo.w * 31.0), vec2(127.1, 311.7))) * 43758.5453);
    float doorH = min(4.8, bTop - 1.6);
    float fade = bDetail;
    if (pick > 0.5 && doorH > 3.0 && abs(cx) < 2.6 && bH < doorH + 0.35) {
      bRib = 0.0;
      if (abs(cx) < 2.3 && bH < doorH) {
        float slat = aaLine(bH, 0.42, 0.07);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.4, 0.42, 0.44) * (1.0 - 0.25 * slat), fade);
      } else diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.25, 0.26), fade);
    } else if (pick > 0.3 && pick < 0.75 && abs(cx - 4.4) < 0.55 && bH < 2.2) {
      bRib = 0.0;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.32, 0.35), fade);
    }
    if (bH < 0.5) diffuseColor.rgb *= 0.72;
    if (bH > bTop - 0.4) diffuseColor.rgb *= 0.7;
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
buildingMaterial.customProgramCacheKey = () => 'starbase-buildings-v7';

/**
 * The tank farm's tanks and its pipes: white insulation jackets, matte (as polished metal they
 * mirrored the sun, and bloomed into white blobs), with their girth bands, darker and yellowed
 * low down where the rain runs off, streaked. aTank per vertex: metres along the tank, height
 * across it (-1 bottom .. 1 top; 2: a standing tank, the first is then its height; 3: a pipe).
 */
function tankMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xe4e4df, metalness: 0, roughness: 0.62 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTank;\nvarying vec3 vTank;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTank = aTank;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTank;
float tankHash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float tankNoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(tankHash(i), tankHash(i + 1.0), f); }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  float along = vTank.x;
  float px = max(fwidth(along), 1e-3);
  // Girth bands (the jacket's joints): one every 5.8 m, a hand wide; flanges on a pipe.
  float pitch = vTank.y > 2.5 ? 9.0 : vTank.y > 1.5 ? 2.4 : 5.8;
  float ring = abs(fract(along / pitch + 0.5) - 0.5) * pitch;
  float band = (1.0 - smoothstep(0.09, 0.09 + px, ring)) * clamp(0.25 / px, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - 0.2 * band;
  if (vTank.y < 1.5) {
    // Lying down: darker and yellowed under its waist, in streaks from the bands and seams.
    float low = smoothstep(0.25, -0.95, vTank.y);
    float streak = 0.45 + 0.55 * tankNoise(along * 1.7 + 3.0) * (0.6 + 0.4 * tankNoise(along * 0.31));
    diffuseColor.rgb *= mix(1.0, 0.78, low * streak);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.95, 0.9, 0.8), 0.6 * low);
    // (And a little uneven panel to panel.)
    diffuseColor.rgb *= 0.95 + 0.05 * tankHash(floor(along / pitch + 0.5));
  } else if (vTank.y < 2.5) {
    // Standing: grimy toward its foot.
    diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 3.5, along));
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => 'starbase-tank-v1';
  return mat;
}

/** Tag a tank's (or a pipe's) vertices: see tankMaterial. `along`, `across`: from its position as built. */
function tankTag(g: THREE.BufferGeometry, along: (x: number, y: number, z: number) => number, across: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = ng.getAttribute('position');
  const a = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    a[i * 3] = along(pos.getX(i), pos.getY(i), pos.getZ(i));
    a[i * 3 + 1] = across(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  ng.setAttribute('aTank', new THREE.BufferAttribute(a, 3));
  return ng;
}

/**
 * A horizontal tank as built, along Y: a barrel with dished (2:1 elliptical) heads, as pressure
 * vessels have (hemispheres made each a sausage).
 */
function tankBarrel(r: number, len: number): THREE.BufferGeometry {
  const head = 0.5 * r;
  const barrel = new THREE.CylinderGeometry(r, r, Math.max(0.1, len - 2 * head), 32, 1, true);
  const top = new THREE.SphereGeometry(r, 32, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  top.scale(1, 0.5, 1);
  top.translate(0, (len - 2 * head) / 2, 0);
  const bottom = top.clone().rotateX(Math.PI);
  return mergeGeometries([barrel.toNonIndexed(), top.toNonIndexed(), bottom.toNonIndexed()])!;
}

/** A pipe from a to b (render world), radius r. */
function pipe(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
  const tagged = tankTag(g, (_x, y) => y + len / 2, () => 3);
  tagged.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  tagged.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tagged;
}

const MATERIALS = {
  buildings: buildingMaterial,
  tank: tankMaterial(),
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

/**
 * A footprint that's a plain rectangle (four corners, square to each other within a few
 * degrees): its short and long sides, m; else null.
 */
function rectangle(ring: number[][]): { short: number; long: number } | null {
  if (ring.length !== 5) return null;
  const side = (i: number) => [ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]];
  const len = [0, 1, 2, 3].map((i) => Math.hypot(...(side(i) as [number, number])));
  for (let i = 0; i < 4; i++) {
    const [a, b] = [side(i), side((i + 1) % 4)];
    if (Math.abs(a[0] * b[0] + a[1] * b[1]) > 0.2 * len[i] * len[(i + 1) % 4]) return null;
  }
  const [x, y] = [(len[0] + len[2]) / 2, (len[1] + len[3]) / 2];
  return { short: Math.min(x, y), long: Math.max(x, y) };
}

/**
 * A box laid along each side of a footprint (pad-local east / north ring), in the side's own
 * frame: `make(len)` gives the pieces for a side that long, built with x along it, y up from
 * the ground at `y0` and z out from the wall. Into `out`, tagged plain.
 */
function alongWalls(ring: number[][], y0: number, minLen: number, color: THREE.Color, seed: number, out: THREE.BufferGeometry[], make: (len: number) => THREE.BufferGeometry[]): void {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  const ccw = area > 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < minLen) continue;
    let [ne, nn] = [(by - ay) / len, -(bx - ax) / len];
    if (!ccw) [ne, nn] = [-ne, -nn];
    // (Turned so the piece's z looks out of the wall: x = E, z = -N.)
    const phi = Math.atan2(ne, -nn);
    for (const g of make(len)) {
      g.rotateY(phi);
      g.translate((ax + bx) / 2, y0, -(ay + by) / 2);
      out.push(tag(g, color, [y0, 1, STYLE.plain, seed]));
    }
  }
}

/** A parapet round a flat roof at `top` (m above y0): a low wall along every side, just inside it. */
function parapet(ring: number[][], y0: number, top: number, color: THREE.Color, seed: number, out: THREE.BufferGeometry[], h = 0.7): void {
  alongWalls(ring, y0, 1.5, color, seed, out, (len) => {
    const g = new THREE.BoxGeometry(len, h, 0.3);
    g.translate(0, top + h / 2, -0.15);
    return [g];
  });
}

/**
 * A high bay's wind girts: the ledges of white steel truss that run round it every 14 m of its
 * height, standing off the cladding on raked struts (plain on every photo of the bays: Commons
 * "Bays + ships.jpg", "Booster 10 (cropped).jpg"), each with its rail.
 */
function bayGirts(ring: number[][], y0: number, height: number, seed: number, out: THREE.BufferGeometry[]): void {
  const color = new THREE.Color(GIRT_COLOR);
  const out_ = 1.8;
  alongWalls(ring, y0, 8, color, seed, out, (len) => {
    const parts: THREE.BufferGeometry[] = [];
    for (let h = 14; h < height - 13; h += 14) {
      const ledge = new THREE.BoxGeometry(len + 2 * out_, 0.3, out_);
      ledge.translate(0, h, out_ / 2);
      const rail = new THREE.BoxGeometry(len + 2 * out_, 0.1, 0.1);
      rail.translate(0, h + 1.1, out_ - 0.05);
      parts.push(ledge, rail);
      const n = Math.max(1, Math.round(len / 6.5));
      for (let k = 0; k <= n; k++) {
        const strut = new THREE.BoxGeometry(0.22, Math.hypot(out_, 2.4), 0.22);
        strut.rotateX(Math.atan2(out_, 2.4));
        strut.translate(-len / 2 + (len * k) / n, h - 1.2, out_ / 2);
        parts.push(strut);
      }
    }
    return parts;
  });
}

export async function loadFacilities(): Promise<THREE.Group> {
  const res = await fetch(`${import.meta.env.BASE_URL}terrain/facilities.json`);
  const facilities: Facility[] = [...((await res.json()) as { facilities: Facility[] }).facilities, ...EXTRA_FACILITIES];
  const parts: Record<keyof typeof MATERIALS, THREE.BufferGeometry[]> = { buildings: [], tank: [], steel: [] };
  /** The launch site's big horizontal tanks, for the wall and the pipes round them. */
  const farm: { e: number; n: number; r: number; len: number; angle: number; y0: number }[] = [];
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
      const quad = rectangle(f.ring);
      const footprint = Math.abs(shape.getPoints().reduce((a, p, i, ps) => a + p.x * ps[(i + 1) % ps.length].y - ps[(i + 1) % ps.length].x * p.y, 0) / 2);
      // (What's put on top of the box, so a building isn't one: a pitched roof where its plan is
      // a plain rectangle, a parapet round a flat one.)
      let roofRise = 0;
      let roofColor = SHED_ROOF;
      let flatTop = false;
      if (f.material === 'bay') {
        style = STYLE.bay;
        color.setHex(BAY_COLOR);
        door = doorFor(f.ring);
        roofUnits(shape, e, n, y0 + f.height, 6, 4);
        bayGirts(f.ring, y0, f.height, seed, parts.buildings);
        parapet(f.ring, y0, f.height, new THREE.Color(0x4a4c4f), seed, parts.buildings, 1.6);
      } else if (f.material === 'house' && Math.abs(shape.getPoints().reduce((a, p, i, ps) => a + p.x * ps[(i + 1) % ps.length].y - ps[(i + 1) % ps.length].x * p.y, 0) / 2) > 400) {
        // A big residential block (apartments): light walls, windows.
        style = STYLE.office;
        color.setHex(0xd9d4ca);
        flatTop = true;
      } else if (f.material === 'house') {
        style = STYLE.house;
        color.setHex(HOUSE_COLOR);
        // (A house's roof: pitched some 20 degrees, darker than the walls' trim: a gable over a
        // plain rectangle, hipped in from every side over any other plan.)
        if (quad) {
          roofRise = 0.19 * quad.short;
          roofColor = HOUSE_ROOF;
        } else {
          parts.buildings.push(tag(hipRoof(f.ring, y0 + f.height, THREE.MathUtils.clamp(0.07 * Math.sqrt(footprint), 1.2, 2.6)), new THREE.Color(HOUSE_ROOF), [y0, f.height + 2, STYLE.plain, seed]));
        }
      } else {
        // Small buildings are mostly offices and trailers (windows); the rest are sheds.
        style = f.office || (footprint < 250 && f.height <= 7 && seed < 0.55) ? STYLE.office : STYLE.shed;
        if (f.office) color.setHex(0xc9c8c3);
        color.setHex(SHED_COLORS[Math.floor(seed * SHED_COLORS.length)]);
        // (The Starfactory: grey panels and long ribbons of glass, not a white shed.)
        if (f.name === 'Starfactory') {
          style = STYLE.office;
          color.setHex(0x80848a);
        }
        const tent = /tent/i.test(f.name ?? '');
        // A steel shed's roof: sheet, pitched a few degrees to a ridge along its length; a
        // fabric tent's steep. The working sheds get their doors (the shader's, by the flag).
        if (quad && !f.gable && style === STYLE.shed && footprint > 60) {
          roofRise = tent ? 0.3 * quad.short : THREE.MathUtils.clamp(0.07 * quad.short, 0.4, 3.5);
          if (tent) roofColor = color.getHex();
        }
        if (style === STYLE.shed && !tent && footprint > 150 && f.height >= 4.5) door = [0, 0, 0, 1];
        flatTop = !roofRise && !f.gable;
        // Rooftop units on the bigger flat-roofed ones.
        if (flatTop && footprint > 700 && f.height >= 5) roofUnits(shape, e, n, y0 + f.height, 2 + Math.floor(seed * 4), 2);
      }
      parts.buildings.push(tag(g, color, [y0, f.height, style, seed], door));
      if (f.gable) parts.buildings.push(tag(gableRoof(f.ring, y0 + f.height, f.gable), color, [y0, f.height + f.gable, STYLE.shed, seed]));
      if (roofRise) {
        // (Its two slopes in the roof's colour, its gable ends in the wall's.)
        const roof = gableRoof(f.ring, y0 + f.height, roofRise, style === STYLE.house ? 0.45 : 0.3);
        const pos = roof.getAttribute('position').array as Float32Array;
        const piece = (from: number, to: number) => {
          const part = new THREE.BufferGeometry();
          part.setAttribute('position', new THREE.Float32BufferAttribute(pos.slice(from * 3, to * 3), 3));
          part.computeVertexNormals();
          return part;
        };
        parts.buildings.push(tag(piece(0, 12), new THREE.Color(roofColor), [y0, f.height + roofRise, STYLE.plain, seed]));
        parts.buildings.push(tag(piece(12, 18), color, [y0, f.height + roofRise, STYLE.plain, seed]));
      }
      // (A coping a little darker than the wall, round the flat roofs big enough to show one.)
      if (flatTop && footprint > 120 && f.height >= 3.5) parapet(f.ring, y0, f.height, color.clone().multiplyScalar(0.82), seed, parts.buildings);
    } else if (f.kind === 'vtank') {
      const r = f.diameter! / 2;
      let g: THREE.BufferGeometry = new THREE.CylinderGeometry(r, r, f.height + 1, 24);
      g.translate(0, (f.height + 1) / 2 - 1, 0);
      // Domed top.
      const dome = new THREE.SphereGeometry(r, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.35, 1);
      dome.translate(0, f.height, 0);
      g = tankTag(mergeGeometries([g.toNonIndexed(), dome.toNonIndexed()])!, (_x, y) => y, () => 2);
      g.translate(e, y0, -n);
      parts.tank.push(g);
    } else {
      const r = f.diameter! / 2;
      const len = f.length!;
      // (Built along Y, its top toward +X: laid along the footprint's long axis, angle from east.)
      const g = tankTag(tankBarrel(r, len), (_x, y) => y + len / 2, (x) => x / r);
      g.rotateZ(Math.PI / 2);
      g.rotateY(f.angle!);
      g.translate(e, y0 + r + 0.6, -n);
      parts.tank.push(g);
      if (r > 3 && Math.abs(e) < 700 && Math.abs(n) < 500) farm.push({ e, n, r, len, angle: f.angle!, y0 });
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

  farmWorks(farm, parts);
  siteDressing(facilities, parts);
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
/**
 * Round the launch site's tank farm: the blast wall along the ends of the tanks that face the
 * pads, with a return at each end of it (the farm is walled off from the mounts: dark concrete,
 * plain in every overhead photo), the propellant lines along its foot on their stands, and a
 * run from there to each tower's base.
 */
function farmWorks(farm: { e: number; n: number; r: number; len: number; angle: number; y0: number }[], parts: { buildings: THREE.BufferGeometry[]; tank: THREE.BufferGeometry[] }): void {
  if (farm.length < 4) return;
  // The tanks' common heading (they lie side by side), and across it.
  const th = farm.reduce((s, t) => s + t.angle, 0) / farm.length;
  const a = [Math.cos(th), Math.sin(th)];
  const c = [-a[1], a[0]];
  const u = (t: { e: number; n: number }) => t.e * a[0] + t.n * a[1];
  const v = (t: { e: number; n: number }) => t.e * c[0] + t.n * c[1];
  // (The pads are to the south: the wall on that end of the tanks.)
  const south = a[1] > 0 ? -1 : 1;
  const y0 = farm[0].y0;
  const at = (uu: number, vv: number, h: number) => new THREE.Vector3(uu * a[0] + vv * c[0], y0 + h, -(uu * a[1] + vv * c[1]));
  const WALL = new THREE.Color(0x5a5b5c);
  const STAND = new THREE.Color(0x8d8f90);
  const box = (uu: number, vv: number, du: number, dv: number, h: number, color: THREE.Color) => {
    const g = new THREE.BoxGeometry(du, h, dv);
    // (Box x along the tanks' heading: turned from east by th about the vertical.)
    g.rotateY(th);
    const p = at(uu, vv, h / 2);
    g.translate(p.x, p.y, p.z);
    parts.buildings.push(tag(g, color, [y0, h, STYLE.plain, 0.5]));
  };
  // Rows: tanks whose centres are within a tank's breadth and a bit of each other, across.
  const sorted = [...farm].sort((p, q) => v(p) - v(q));
  const rows: (typeof farm)[] = [];
  for (const t of sorted) {
    const row = rows[rows.length - 1];
    if (row && v(t) - v(row[row.length - 1]) < 14 && Math.abs(u(t) - u(row[0])) < 25) row.push(t);
    else rows.push([t]);
  }
  for (const row of rows) {
    if (row.length < 3) continue;
    const v0 = v(row[0]) - row[0].r - 3;
    const v1 = v(row[row.length - 1]) + row[row.length - 1].r + 3;
    const end = Math[south < 0 ? 'min' : 'max'](...row.map((t) => u(t) + (south * t.len) / 2));
    const uw = end + south * 4;
    box(uw, (v0 + v1) / 2, 1.2, v1 - v0, 5.5, WALL);
    for (const vv of [v0, v1]) box(uw - south * 6, vv, 12, 1.2, 5.5, WALL);
    // The lines along the wall's pad side: three, on stands every 8 m.
    const up = uw + south * 3.2;
    for (let k = 0; k < 3; k++) parts.tank.push(pipe(at(up + south * 0.75 * k, v0, 1.6 + 0.35 * (k % 2)), at(up + south * 0.75 * k, v1, 1.6 + 0.35 * (k % 2)), 0.28));
    for (let vv = v0 + 2; vv < v1; vv += 8) box(up + south * 0.75, vv, 2.6, 0.3, 1.3, STAND);
  }
  // From the lines to each tower's base: the nearest point of the nearest row's run, straight.
  const towers = [
    [TRENCHES[0].center[0] + PAD.tower.e, TRENCHES[0].center[1] + PAD.tower.n],
    [TRENCHES[1].center[0] + PAD2.tower.e, TRENCHES[1].center[1] + PAD2.tower.n],
  ];
  for (const [te, tn] of towers) {
    let best: { d: number; uu: number; vv: number } | null = null;
    for (const row of rows) {
      if (row.length < 3) continue;
      const end = Math[south < 0 ? 'min' : 'max'](...row.map((t) => u(t) + (south * t.len) / 2));
      const uu = end + south * 7.2;
      const tv = te * c[0] + tn * c[1];
      const vv = Math.min(Math.max(tv, v(row[0])), v(row[row.length - 1]));
      const d = Math.hypot(te - (uu * a[0] + vv * c[0]), tn - (uu * a[1] + vv * c[1]));
      if (!best || d < best.d) best = { d, uu, vv };
    }
    if (!best || best.d > 400) continue;
    const from = at(best.uu, best.vv, 1.6);
    const to = new THREE.Vector3(te, y0 + 1.6, -tn);
    const side = new THREE.Vector3().subVectors(to, from).normalize().cross(new THREE.Vector3(0, 1, 0));
    for (let k = -1; k <= 1; k++) parts.tank.push(pipe(from.clone().addScaledVector(side, 0.75 * k), to.clone().addScaledVector(side, 0.75 * k), 0.28));
    const n = Math.floor(best.d / 8);
    for (let i = 1; i < n; i++) {
      const p = from.clone().lerp(to, i / n);
      const g = new THREE.BoxGeometry(0.3, 1.3, 2.6);
      g.rotateY(Math.atan2(-(to.z - from.z), to.x - from.x));
      g.translate(p.x, y0 + 0.65, p.z);
      parts.buildings.push(tag(g, STAND, [y0, 1.3, STYLE.plain, 0.5]));
    }
  }
}

/**
 * What stands about a working launch site, where there's room for it: floodlight masts round
 * its edge (the pads are lit from all sides at night), and rows of shipping containers and
 * equipment skids in the open ground between the buildings, clear of the mounts, the trenches,
 * the towers and the tanks. Placed by a fixed scatter: the same every run.
 */
function siteDressing(facilities: Facility[], parts: { buildings: THREE.BufferGeometry[] }): void {
  const y0 = SLAB_TOP;
  const n = SITE_OUTLINE.length;
  /** How far inside the site's outline (east, north) is, m (< 0 outside). */
  const inside = (e: number, nn: number): number => {
    let d = Infinity;
    let within = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, ay] = SITE_OUTLINE[i];
      const [bx, by] = SITE_OUTLINE[j];
      if (ay > nn !== by > nn && e < ((bx - ax) * (nn - ay)) / (by - ay) + ax) within = !within;
      const t = Math.max(0, Math.min(1, ((e - ax) * (bx - ax) + (nn - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      d = Math.min(d, Math.hypot(e - ax - t * (bx - ax), nn - ay - t * (by - ay)));
    }
    return within ? d : -d;
  };
  // What's already there, as circles to keep clear of.
  const taken: [number, number, number][] = [];
  for (const f of facilities) {
    if (Math.abs(f.center[0]) > 700 || Math.abs(f.center[1]) > 500) continue;
    const reach = f.kind === 'htank' ? f.length! / 2 : f.kind === 'vtank' ? f.diameter! / 2 : Math.max(...(f.ring ?? [f.center]).map(([e, nn]) => Math.hypot(e - f.center[0], nn - f.center[1])));
    taken.push([f.center[0], f.center[1], reach + 5]);
  }
  const pads: [number, number, number][] = [
    [TRENCHES[0].center[0], TRENCHES[0].center[1], 62],
    [TRENCHES[1].center[0], TRENCHES[1].center[1], 62],
    [TRENCHES[0].center[0] + PAD.tower.e, TRENCHES[0].center[1] + PAD.tower.n, 34],
    [TRENCHES[1].center[0] + PAD2.tower.e, TRENCHES[1].center[1] + PAD2.tower.n, 34],
  ];
  const free = (e: number, nn: number, r: number) => inside(e, nn) > r + 6 && [...taken, ...pads].every(([x, y, rr]) => Math.hypot(e - x, nn - y) > rr + r);
  const box = (e: number, nn: number, up: number, size: [number, number, number], heading: number, color: number, seed = 0.5) => {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    g.rotateY(heading);
    g.translate(e, y0 + up + size[1] / 2, -nn);
    parts.buildings.push(tag(g, new THREE.Color(color), [y0 + up, size[1], STYLE.plain, seed]));
  };

  // Floodlight masts: one every ~130 m round the edge, 10 m in; a pole, a cross-arm, a bank of lamps.
  let carried = 60;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = SITE_OUTLINE[i];
    const [bx, by] = SITE_OUTLINE[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    // (Counter-clockwise outline: inward is to the left of each edge.)
    const [ie, inn] = [-(by - ay) / len, (bx - ax) / len];
    for (; carried < len; carried += 130) {
      const [e, nn] = [ax + ((bx - ax) * carried) / len + ie * 10, ay + ((by - ay) * carried) / len + inn * 10];
      if (!free(e, nn, 2)) continue;
      const heading = Math.atan2(inn, ie);
      box(e, nn, 0, [0.9, 1.2, 0.9], heading, 0x9c9a94);
      box(e, nn, 1.2, [0.45, 27, 0.45], heading, 0x8f9396);
      box(e, nn, 28.2, [0.3, 0.3, 3.6], heading, 0x8f9396);
      box(e + Math.cos(heading) * 0.35, nn + Math.sin(heading) * 0.35, 28.5, [0.35, 1.3, 3.2], heading, 0x3d4043);
      taken.push([e, nn, 3]);
    }
    carried -= len;
  }

  // Containers and skids: rows of them, a few stacked two high.
  const COLORS = [0xd9d9d4, 0xd9d9d4, 0x3f5f8a, 0x8a4a35, 0x9aa0a6, 0x2f6b55, 0xc9c2ae];
  let placed = 0;
  for (let k = 0; k < 400 && placed < 9; k++) {
    const e = -440 + 570 * hash(k * 3.17, 1.3);
    const nn = -80 + 300 * hash(2.9, k * 5.71);
    const count = 3 + Math.floor(5 * hash(k, 7.7));
    // (Squared up to the site, as everything parked on it is: along its long side or across.)
    const heading = -0.26 + (hash(k * 1.9, 4.4) < 0.5 ? 0 : Math.PI / 2);
    const [ce, cn] = [Math.cos(heading + Math.PI / 2), Math.sin(heading + Math.PI / 2)];
    const row = Array.from({ length: count }, (_, i) => [e + ce * 3.0 * (i - (count - 1) / 2), nn + cn * 3.0 * (i - (count - 1) / 2)] as const);
    if (!row.every(([x, y]) => free(x, y, 7))) continue;
    row.forEach(([x, y], i) => {
      const h = hash(x, y);
      const long = h < 0.6 ? 12.2 : 6.1;
      box(x, y, 0, [long, 2.6, 2.44], heading, COLORS[Math.floor(hash(y, x) * COLORS.length)], h);
      if (hash(x + 9, y - 4) < 0.22) box(x, y, 2.6, [long, 2.6, 2.44], heading, COLORS[Math.floor(hash(x - 3, y + 8) * COLORS.length)], h);
      void i;
    });
    taken.push([e, nn, 3.0 * count * 0.5 + 9]);
    placed++;
  }
}

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
  // The launch site's fill, round its slab (blue, added to what's there): the compacted ground
  // the pads were built up on, spreading out past the concrete and thinning into the flats
  // (blurred over ~25 m here; the terrain's shader frays its edge). Without it the slab was a
  // sheet of card laid on the marsh.
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${9 / MASK_RES}px)`;
  ctx.fillStyle = ctx.strokeStyle = 'rgb(0,0,255)';
  ctx.lineWidth = (2 * 9) / MASK_RES;
  ctx.beginPath();
  SITE_OUTLINE.forEach(([e, n], i) => (i ? ctx.lineTo(...px(e, n)) : ctx.moveTo(...px(e, n))));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.filter = 'none';
  // Highway 4 stays as the photo has it: none of this painted ground on the road (the fill's
  // apron, and the concrete round the buildings that stand along it, reached over it).
  ctx.globalCompositeOperation = 'destination-out';
  ctx.filter = `blur(${2 / MASK_RES}px)`;
  ctx.strokeStyle = 'rgb(0,0,0)';
  ctx.lineWidth = (2 * ROAD_HALF + 2) / MASK_RES;
  ctx.beginPath();
  HIGHWAY_4.forEach(([e, n], i) => (i ? ctx.lineTo(...px(e, n)) : ctx.moveTo(...px(e, n))));
  ctx.stroke();
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  setSiteMask(tex, [minE, minN, maxE - minE, maxN - minN]);
}

/**
 * A hipped roof over any footprint (pad-local east / north ring): every side slopes in to a
 * smaller copy of the plan, `rise` above the eaves at `eave` (render height), which stand out a
 * little past the walls. In render world (x = E, y = U, z = -N).
 */
function hipRoof(ring: number[][], eave: number, rise: number): THREE.BufferGeometry {
  const pts = ring.slice(0, -1);
  const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  const at = (p: number[], k: number, y: number) => new THREE.Vector3(c[0] + (p[0] - c[0]) * k, y, -(c[1] + (p[1] - c[1]) * k));
  const outer = pts.map((p) => at(p, 1.05, eave));
  const inner = pts.map((p) => at(p, 0.45, eave + rise));
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3) => {
    // (Facing up, whichever way the ring runs.)
    const up = b.clone().sub(a).cross(d.clone().sub(a)).y > 0;
    for (const q of up ? [a, b, d] : [a, d, b]) pos.push(q.x, q.y, q.z);
  };
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    tri(outer[i], outer[j], inner[j]);
    tri(outer[i], inner[j], inner[i]);
  }
  // The flat top, as a fan from its middle.
  const mid = at(c, 1, eave + rise);
  for (let i = 0; i < pts.length; i++) tri(mid, inner[i], inner[(i + 1) % pts.length]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A gable roof over a rectangular footprint (ring of 4 corners + the closing point, pad-local
 * east / north): two slopes meeting at a ridge along the long axis, `rise` above the eaves at
 * `eave` (render height), and the gable-end triangles. In render world (x = E, y = U, z = -N).
 */
function gableRoof(ring: number[][], eave: number, rise: number, overhang = 0): THREE.BufferGeometry {
  const [a, b, c, d] = ring.slice(0, 4).map(([e, n]) => new THREE.Vector3(e, eave, -n));
  if (overhang > 0) {
    // (The eaves and verges stand out past the walls: each corner moved out along both sides.)
    const mid = a.clone().add(b).add(c).add(d).multiplyScalar(0.25);
    const u = b.clone().sub(a).normalize();
    const v = c.clone().sub(b).normalize();
    for (const p of [a, b, c, d]) {
      const r = p.clone().sub(mid);
      p.addScaledVector(u, Math.sign(r.dot(u)) * overhang).addScaledVector(v, Math.sign(r.dot(v)) * overhang);
    }
  }
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
