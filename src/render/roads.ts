// The roads, painted on the ground. The aerial photo has them, but near the launch site Highway 4
// is a pale smear a few pixels wide, and the ground added round the site (the fill, the concrete
// round the buildings) ran over it. Here the roads are drawn themselves, along OpenStreetMap's
// centre lines (roadLines.ts), in the terrain's shader, AFTER everything else that paints the
// ground: the highway from the edge of Brownsville to the beach, two lanes of asphalt with its
// double yellow line and white edge lines; the roundabout at the launch site's gate; the streets
// and drives that turn off it at the production site, the village and the launch site, plain
// asphalt; a verge of packed sand fading into the photo. Nothing painted on the ground can cover
// them.
//
// How: a texture of distances. Per texel, how far it is from the nearest road's EDGE (negative
// on the paving: with the edge, not the centre line, the paving of two roads that meet is one
// piece and a junction's mouth is open), which side of the highway's centre line it is on and
// how far (signed: for the line down its middle), how strongly the road is drawn there (it
// fades in at its far west end and out into the sand at the beach) and what it is (highway,
// side road, the roundabout's lane, its island). A distance read between texels is good to a
// few centimetres, so 2 m texels draw 12 cm lines sharply at any zoom.
//
// The highway is 26 km long and runs diagonally: one texture over all of it would be mostly
// empty and enormous. So the texture is an atlas of blocks: two upright ones over the two sites,
// where the side roads are (2 m texels), and a chain of long narrow strips laid along the
// highway itself for the rest (4 m texels: it bends gently enough).

import * as THREE from 'three';
import { HIGHWAY_4_EAST, HIGHWAY_4_WEST, RING_PAVED_HALF, ROAD_PAVED_HALF, ROUNDABOUT, SIDE_ROADS } from './roadLines';

/** The furthest distance stored, m. */
const RANGE = 16;
/** Texels left round each block in the atlas (nothing of one block reads into the next). */
const GUTTER = 2;
const ATLAS_W = 2048;
/** How far a strip may run, and how wide it is, m; its texel. */
const STRIP = { length: 5800, width: 128, texel: 4 };
/** The highway's far west end: faded in over this stretch (m east). */
const WEST_FADE: [number, number] = [HIGHWAY_4_WEST[0][0] + 20, HIGHWAY_4_WEST[0][0] + 260];

/** A block of the atlas: a rectangle of ground, its own way round. */
interface Block {
  /** Its corner (pad east, north), and the unit vector along its length. */
  origin: [number, number];
  axis: [number, number];
  /** Its size on the ground, m, and a texel's. */
  length: number;
  width: number;
  texel: number;
  /** Where it is in the atlas, texels, and its size there. */
  x: number;
  y: number;
  w: number;
  h: number;
}

type P = readonly [number, number];

function layout(): { blocks: Block[]; height: number } {
  const upright = (e0: number, n0: number, w: number, h: number): Omit<Block, 'x' | 'y'> => ({ origin: [e0, n0], axis: [1, 0], length: w, width: h, texel: 2, w: Math.ceil(w / 2), h: Math.ceil(h / 2) });
  // The production site and the village; the launch site.
  const blocks: Omit<Block, 'x' | 'y'>[] = [upright(-3770, -1690, 1020, 1560), upright(-860, 0, 1280, 270)];
  // Strips along the highway west of the launch site: as long as they may be while the road
  // stays inside.
  const line: P[] = [];
  const west = HIGHWAY_4_WEST.filter(([e]) => e < -800);
  west.push(HIGHWAY_4_WEST[west.length]);
  for (let i = 0; i + 1 < west.length; i++) {
    const [a, b] = [west[i], west[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 400));
    for (let k = 0; k < n; k++) line.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  line.push(west[west.length - 1]);
  const pad = 3 * STRIP.texel;
  const room = STRIP.width / 2 - RANGE - 2 * STRIP.texel;
  const fits = (i: number, j: number) => {
    const [a, b] = [line[i], line[j]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > STRIP.length - 2 * pad) return false;
    for (let k = i + 1; k < j; k++) if (Math.abs((line[k][0] - a[0]) * (b[1] - a[1]) - (line[k][1] - a[1]) * (b[0] - a[0])) / len > room) return false;
    return true;
  };
  for (let i = 0; i + 1 < line.length; ) {
    let j = i + 1;
    while (j + 1 < line.length && fits(i, j + 1)) j++;
    const [a, b] = [line[i], line[j]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    blocks.push({
      origin: [a[0] - u[0] * pad + u[1] * (STRIP.width / 2), a[1] - u[1] * pad - u[0] * (STRIP.width / 2)],
      axis: u,
      length: len + 2 * pad,
      width: STRIP.width,
      texel: STRIP.texel,
      w: Math.ceil((len + 2 * pad) / STRIP.texel),
      h: STRIP.width / STRIP.texel,
    });
    i = j;
  }
  // Packed: the production site's block down the left, and beside it the launch site's, then
  // the strips one under another.
  const placed: Block[] = [{ ...blocks[0], x: GUTTER, y: GUTTER }];
  const x = blocks[0].w + 3 * GUTTER;
  let y = GUTTER;
  for (const b of blocks.slice(1)) {
    if (x + b.w + GUTTER > ATLAS_W) throw new Error('road atlas: a block is too long');
    placed.push({ ...b, x, y });
    y += b.h + 2 * GUTTER;
  }
  return { blocks: placed, height: Math.max(y, blocks[0].h + 2 * GUTTER) };
}

const { blocks: BLOCKS, height: ATLAS_H } = layout();

function build(): THREE.DataTexture {
  const [w, h] = [ATLAS_W, ATLAS_H];
  // Per texel: the distance to the nearest road's edge, m (negative on its paving); the
  // highway's SIDE of its centre line and how far (signed: left of its direction +); how
  // strongly the road is drawn; and what it is (0 highway, 0.15 highway with no line down its
  // middle, 0.4 a side road, 0.7 the roundabout's lane, 1 its island). Half floats.
  // (Why the signed one: a distance that only ever counts up from zero has a crease along the
  // centre line, and read between texels it never quite gets back down to zero there except
  // where a texel happens to sit on the line: the double yellow line came out as dashes.)
  const edge = new Float32Array(w * h).fill(RANGE);
  const side = new Float32Array(w * h).fill(RANGE);
  const centre = new Float32Array(w * h).fill(RANGE);
  const strength = new Float32Array(w * h);
  const kind = new Float32Array(w * h);
  const smooth = (x: number, a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const eastEnd = HIGHWAY_4_EAST[HIGHWAY_4_EAST.length - 1][0];
  const { center, radius } = ROUNDABOUT;
  for (const blk of BLOCKS) {
    const [ux, uy] = blk.axis;
    /** A point of the ground in this block's own frame: along it, across it (m). */
    const local = (p: P): [number, number] => [(p[0] - blk.origin[0]) * ux + (p[1] - blk.origin[1]) * uy, -(p[0] - blk.origin[0]) * uy + (p[1] - blk.origin[1]) * ux];
    /** Every texel of the block within `reach` of a box (in its own frame): its index, and where it is on the ground. */
    const texels = (x0: number, x1: number, y0: number, y1: number, reach: number, each: (k: number, e: number, n: number) => void) => {
      const i0 = Math.max(0, Math.floor((x0 - reach) / blk.texel));
      const i1 = Math.min(blk.w - 1, Math.ceil((x1 + reach) / blk.texel));
      const j0 = Math.max(0, Math.floor((y0 - reach) / blk.texel));
      const j1 = Math.min(blk.h - 1, Math.ceil((y1 + reach) / blk.texel));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const [lx, ly] = [(i + 0.5) * blk.texel, (j + 0.5) * blk.texel];
          each((blk.y + j) * w + blk.x + i, blk.origin[0] + lx * ux - ly * uy, blk.origin[1] + lx * uy + ly * ux);
        }
      }
    };
    /** One stretch of a road's centre line, the road `half` wide either side of it. */
    const stroke = (a: P, b: P, half: number, highway: boolean) => {
      const [la, lb] = [local(a), local(b)];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len2 = dx * dx + dy * dy || 1e-9;
      texels(Math.min(la[0], lb[0]), Math.max(la[0], lb[0]), Math.min(la[1], lb[1]), Math.max(la[1], lb[1]), RANGE + half, (k, e, n) => {
        const t = Math.min(1, Math.max(0, ((e - a[0]) * dx + (n - a[1]) * dy) / len2));
        const d = Math.hypot(e - a[0] - t * dx, n - a[1] - t * dy);
        if (highway && d < centre[k]) {
          centre[k] = d;
          side[k] = (dx * (n - a[1]) - dy * (e - a[0]) < 0 ? -1 : 1) * d;
        }
        if (d - half >= edge[k]) return;
        edge[k] = d - half;
        strength[k] = highway ? smooth(e, WEST_FADE[0], WEST_FADE[1]) * (1 - smooth(e, eastEnd - 30, eastEnd - 4)) : 1;
        // (No line down the highway's middle within a few lengths of the roundabout: it ends
        // short of one.)
        kind[k] = highway ? 0.15 * (1 - smooth(Math.hypot(e - center[0], n - center[1]), radius + 12, radius + 22)) : 0.4;
      });
    };
    for (const line of [HIGHWAY_4_WEST, HIGHWAY_4_EAST]) for (let i = 0; i + 1 < line.length; i++) stroke(line[i], line[i + 1], ROAD_PAVED_HALF, true);
    for (const [half, line] of SIDE_ROADS) for (let i = 0; i + 1 < line.length; i++) stroke(line[i], line[i + 1], half, false);
    // The roundabout's lane, and the island inside it.
    const lc = local(center);
    texels(lc[0] - radius, lc[0] + radius, lc[1] - radius, lc[1] + radius, RANGE + RING_PAVED_HALF, (k, e, n) => {
      const r = Math.hypot(e - center[0], n - center[1]);
      const d = Math.abs(r - radius) - RING_PAVED_HALF;
      const island = r < radius - RING_PAVED_HALF - 1;
      if (d >= edge[k] && !island) return;
      edge[k] = island ? Math.min(edge[k], d) : d;
      strength[k] = 1;
      kind[k] = island ? 1 : 0.7;
    });
  }
  const data = new Uint16Array(w * h * 4);
  const half = THREE.DataUtils.toHalfFloat;
  for (let k = 0; k < w * h; k++) {
    data[k * 4] = half(edge[k]);
    data[k * 4 + 1] = half(side[k]);
    data[k * 4 + 2] = half(strength[k]);
    data[k * 4 + 3] = half(kind[k]);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The ground the roads are on: its east / north limits (m), a little over. */
const BOUNDS = (() => {
  let [e0, n0, e1, n1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of BLOCKS) {
    for (const [l, c] of [[0, 0], [b.length, 0], [0, b.width], [b.length, b.width]]) {
      const [e, n] = [b.origin[0] + l * b.axis[0] - c * b.axis[1], b.origin[1] + l * b.axis[1] + c * b.axis[0]];
      [e0, n0, e1, n1] = [Math.min(e0, e), Math.min(n0, n), Math.max(e1, e), Math.max(n1, n)];
    }
  }
  return new THREE.Vector4(e0, n0, e1, n1);
})();

export const roadUniforms = {
  uRoad: { value: build() as THREE.Texture },
  /** Every road is inside this: min east, min north, max east, max north. */
  uRoadBounds: { value: BOUNDS },
  /** Per block: its corner (east, north) and the unit vector along it; its length and width (m) and where it is in the atlas (texels). */
  uRoadFrame: { value: BLOCKS.map((b) => new THREE.Vector4(b.origin[0], b.origin[1], b.axis[0], b.axis[1])) },
  uRoadPlace: { value: BLOCKS.map((b) => new THREE.Vector4(b.length, b.width, b.x, b.y)) },
  uRoadTexel: { value: BLOCKS.map((b) => b.texel) },
};

export function bindRoads(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, roadUniforms);
}

/**
 * For a ground material's fragment shader (after siteVNoise is declared): roadPaint(en, colour)
 * paints the roads over `colour` where they run, en pad east / north. Returns how much of the
 * fragment is paved (0..1), for whatever else wants to keep off it.
 */
export const ROAD_GLSL = /* glsl */ `
uniform sampler2D uRoad;
uniform vec4 uRoadBounds;
uniform vec4 uRoadFrame[${BLOCKS.length}];
uniform vec4 uRoadPlace[${BLOCKS.length}];
uniform float uRoadTexel[${BLOCKS.length}];
float roadLine(float d, float fw, float at, float width) {
  // (A painted line: its share of the pixel, fading out once it is far thinner than one.)
  return clamp((0.5 * width - abs(d - at)) / fw + 0.5, 0.0, 1.0) * min(1.0, 2.5 * width / fw);
}
float roadPaint(vec2 en, inout vec3 colour) {
  float fw = max(length(fwidth(en)) * 0.7071, 1e-3);
  if (en.x < uRoadBounds.x || en.y < uRoadBounds.y || en.x > uRoadBounds.z || en.y > uRoadBounds.w) return 0.0;
  // Which block of the atlas has this ground (the first that does: where two overlap they say
  // the same), a texel in from its edge.
  vec4 r = vec4(${RANGE.toFixed(1)}, ${RANGE.toFixed(1)}, 0.0, 0.0);
  for (int i = 0; i < ${BLOCKS.length}; i++) {
    vec2 p = en - uRoadFrame[i].xy;
    vec2 u = uRoadFrame[i].zw;
    vec2 q = vec2(dot(p, u), dot(p, vec2(-u.y, u.x)));
    float t = uRoadTexel[i];
    if (q.x <= t || q.y <= t || q.x >= uRoadPlace[i].x - t || q.y >= uRoadPlace[i].y - t) continue;
    r = textureLod(uRoad, (uRoadPlace[i].zw + q / t) / vec2(${ATLAS_W.toFixed(1)}, ${ATLAS_H.toFixed(1)}), 0.0);
    break;
  }
  float e = r.r;
  float island = smoothstep(0.82, 0.94, r.a);
  if ((e > 5.5 && island < 0.01) || r.b < 0.004) return 0.0;
  // (What it is: the highway and the roundabout's lane have a white line along each edge, a
  // side road none.)
  float lined = 1.0 - smoothstep(0.22, 0.34, r.a) * (1.0 - smoothstep(0.5, 0.62, r.a));
  float highway = 1.0 - smoothstep(0.2, 0.34, r.a);
  // The verge: packed sand and caliche, ragged where it gives way to the photo.
  float ragged = e + 1.1 * (siteVNoise(en / 6.0 + 21.0) - 0.5) + 0.5 * (siteVNoise(en / 1.7 + 4.0) - 0.5);
  float verge = max(island, 1.0 - smoothstep(0.7, 2.6, ragged));
  // (Taking some of the ground's own colour: pale in the flats, greener through the scrub.)
  vec3 sand = mix(vec3(0.50, 0.455, 0.37), colour, 0.35 * (1.0 - island)) * (0.86 + 0.26 * siteVNoise(en / 2.1 + 9.0)) * (0.92 + 0.16 * siteVNoise(en / 23.0 + 2.0));
  // The asphalt: sun-bleached, patched, a shade darker along the highway's wheel tracks.
  float d = e + ${ROAD_PAVED_HALF.toFixed(2)};
  float tracks = highway * (exp(-pow((d - 1.0) / 0.42, 2.0)) + exp(-pow((d - 2.75) / 0.42, 2.0)));
  vec3 asphalt = vec3(0.150, 0.150, 0.156) * (0.84 + 0.22 * siteVNoise(en / 9.0 + 13.0) + 0.12 * siteVNoise(en / 0.9 + 5.0)) * (1.0 - 0.13 * tracks);
  // (Sand blown in over its edges.)
  asphalt = mix(asphalt, sand, 0.5 * smoothstep(-0.9, 0.0, e) * siteVNoise(en / 3.3 + 30.0));
  // The double yellow line down the highway's middle (by which side of it this is, and how
  // far), the white line along each edge.
  float yellow = roadLine(abs(r.g), fw, 0.17, 0.11) * (1.0 - smoothstep(0.03, 0.12, r.a));
  float white = lined * roadLine(e, fw, -0.32, 0.12);
  vec3 paved = mix(asphalt, vec3(0.62, 0.47, 0.08), 0.85 * yellow);
  paved = mix(paved, vec3(0.66, 0.66, 0.64), 0.85 * white);
  float pavedK = (1.0 - smoothstep(-0.5 * fw, 0.5 * fw, e)) * (1.0 - island);
  colour = mix(colour, mix(sand, paved, pavedK), max(pavedK, verge) * r.b);
  return pavedK * r.b;
}`;
