// Highway 4, painted on the ground. The aerial photo has the road, but near the launch site it is
// a pale smear a few pixels wide, and the ground added round the site (the fill, the concrete
// round the buildings) ran over it. Here the road is drawn itself, along OpenStreetMap's centre
// line (roadLines.ts), in the terrain's shader, AFTER everything else that paints the ground:
// asphalt two lanes wide, its double yellow line and white edge lines, a verge of packed sand
// fading into the photo. Nothing painted on the ground can cover it.
//
// How: a small texture of the distance to the nearest centre line (2 m a texel; a distance field
// reads back smoothly between texels, so the road's edges and its 12 cm lines are sharp at any
// zoom), with how strongly the road is drawn there (it fades into the photo's own road at the
// west end, where the production site's junctions begin, and into the sand at the beach) and
// whether it is the roundabout's lane (no centre line) or the island inside it (sand: the photo,
// older than the roundabout, has the road running straight through).

import * as THREE from 'three';
import { HIGHWAY_4_EAST, HIGHWAY_4_WEST, RING_PAVED_HALF, ROAD_PAVED_HALF, ROUNDABOUT } from './roadLines';

/** The ground the texture covers, pad east / north (m), and a texel's size. */
const RECT = { e0: -2700, n0: -640, w: 3120, h: 920 };
const TEXEL = 2;
/** The furthest distance stored, m. */
const RANGE = 16;
/** Where the painted road begins, coming east from the production site (m east): faded in over this stretch. */
const WEST_FADE: [number, number] = [-2640, -2520];

function build(): THREE.DataTexture {
  const [w, h] = [Math.ceil(RECT.w / TEXEL), Math.ceil(RECT.h / TEXEL)];
  // Per texel: the distance to the nearest centre line (m); the highway's SIDE of its centre
  // line too (signed distance: left of its direction +), for the line painted down its middle;
  // how strongly the road is drawn; and what it is (0 highway, up to 0.2 where it has no line
  // down its middle, 0.5 the roundabout's lane, 1 its island). Half floats: the distance is read
  // between texels to a few centimetres.
  // (Why the signed one: a distance that only ever counts up from zero has a crease along the
  // centre line, and read between texels it never quite gets back down to zero there except
  // where a texel happens to sit on the line: the double yellow line came out as dashes.)
  const dist = new Float32Array(w * h).fill(RANGE);
  const side = new Float32Array(w * h).fill(RANGE);
  const strength = new Float32Array(w * h);
  const kind = new Float32Array(w * h);
  const smooth = (x: number, a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const eastEnd = HIGHWAY_4_EAST[HIGHWAY_4_EAST.length - 1][0];
  const { center, radius } = ROUNDABOUT;
  const texels = (e0: number, e1: number, n0: number, n1: number, each: (k: number, e: number, n: number) => void) => {
    const i0 = Math.max(0, Math.floor((e0 - RANGE - RECT.e0) / TEXEL));
    const i1 = Math.min(w - 1, Math.ceil((e1 + RANGE - RECT.e0) / TEXEL));
    const j0 = Math.max(0, Math.floor((n0 - RANGE - RECT.n0) / TEXEL));
    const j1 = Math.min(h - 1, Math.ceil((n1 + RANGE - RECT.n0) / TEXEL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) each(j * w + i, RECT.e0 + (i + 0.5) * TEXEL, RECT.n0 + (j + 0.5) * TEXEL);
  };
  /** One stretch of the highway's centre line: every texel within RANGE of it takes its distance, if nearer. */
  const stroke = (a: readonly [number, number], b: readonly [number, number]) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy || 1e-9;
    texels(Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]), (k, e, n) => {
      const t = Math.min(1, Math.max(0, ((e - a[0]) * dx + (n - a[1]) * dy) / len2));
      const d = Math.hypot(e - a[0] - t * dx, n - a[1] - t * dy);
      if (d >= dist[k]) return;
      dist[k] = d;
      side[k] = Math.sign(dx * (n - a[1]) - dy * (e - a[0])) * d;
      strength[k] = smooth(e, WEST_FADE[0], WEST_FADE[1]) * (1 - smooth(e, eastEnd - 30, eastEnd - 4));
      // (No line down the middle within a few lengths of the roundabout: it ends short of one,
      // and there the two roads' sides don't agree. Up to 0.2 here says so.)
      kind[k] = 0.2 * (1 - smooth(Math.hypot(e - center[0], n - center[1]), radius + 12, radius + 22));
    });
  };
  for (const line of [HIGHWAY_4_WEST, HIGHWAY_4_EAST]) for (let i = 0; i + 1 < line.length; i++) stroke(line[i], line[i + 1]);
  // The roundabout's lane, and the island inside it.
  texels(center[0] - radius, center[0] + radius, center[1] - radius, center[1] + radius, (k, e, n) => {
    const r = Math.hypot(e - center[0], n - center[1]);
    const d = Math.abs(r - radius);
    if (d >= dist[k] && r > radius - RING_PAVED_HALF) return;
    dist[k] = Math.min(dist[k], d);
    side[k] = RANGE;
    strength[k] = 1;
    kind[k] = r < radius - RING_PAVED_HALF - 1 ? 1 : 0.5;
  });
  const data = new Uint16Array(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    data[k * 4] = THREE.DataUtils.toHalfFloat(dist[k]);
    data[k * 4 + 1] = THREE.DataUtils.toHalfFloat(side[k]);
    data[k * 4 + 2] = THREE.DataUtils.toHalfFloat(strength[k]);
    data[k * 4 + 3] = THREE.DataUtils.toHalfFloat(kind[k]);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const roadUniforms = {
  uRoad: { value: build() as THREE.Texture },
  /** Pad east / north of the texture's corner, 1 / its size. */
  uRoadRect: { value: new THREE.Vector4(RECT.e0, RECT.n0, 1 / RECT.w, 1 / RECT.h) },
};

export function bindRoads(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, roadUniforms);
}

/**
 * For a ground material's fragment shader (after siteVNoise is declared): roadPaint(en, colour)
 * paints the road over `colour` where it runs, en pad east / north. Returns how much of the
 * fragment is paved (0..1), for whatever else wants to keep off it.
 */
export const ROAD_GLSL = /* glsl */ `
uniform sampler2D uRoad;
uniform vec4 uRoadRect;
float roadLine(float d, float fw, float at, float width) {
  // (A painted line: its share of the pixel, fading out once it is far thinner than one.)
  return clamp((0.5 * width - abs(d - at)) / fw + 0.5, 0.0, 1.0) * min(1.0, 2.5 * width / fw);
}
float roadPaint(vec2 en, inout vec3 colour) {
  vec2 uv = (en - uRoadRect.xy) * uRoadRect.zw;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  vec4 r = texture2D(uRoad, uv);
  float d = r.r;
  float island = smoothstep(0.7, 0.9, r.a);
  if ((d > 9.5 && island < 0.01) || r.b < 0.004) return 0.0;
  float ring = step(0.35, r.a);
  float half_ = mix(${ROAD_PAVED_HALF.toFixed(2)}, ${RING_PAVED_HALF.toFixed(2)}, ring);
  float fw = max(length(fwidth(en)) * 0.7071, 1e-3);
  // The verge: packed sand and caliche, ragged where it gives way to the photo.
  float ragged = d + 1.1 * (siteVNoise(en / 6.0 + 21.0) - 0.5) + 0.5 * (siteVNoise(en / 1.7 + 4.0) - 0.5);
  float verge = max(island, 1.0 - smoothstep(half_ + 1.0, half_ + 3.4, ragged));
  vec3 sand = vec3(0.50, 0.455, 0.37) * (0.86 + 0.26 * siteVNoise(en / 2.1 + 9.0)) * (0.92 + 0.16 * siteVNoise(en / 23.0 + 2.0));
  // The asphalt: sun-bleached, patched, a shade darker along the wheel tracks.
  float tracks = (1.0 - ring) * (exp(-pow((d - 1.0) / 0.42, 2.0)) + exp(-pow((d - 2.75) / 0.42, 2.0)));
  vec3 asphalt = vec3(0.150, 0.150, 0.156) * (0.84 + 0.22 * siteVNoise(en / 9.0 + 13.0) + 0.12 * siteVNoise(en / 0.9 + 5.0)) * (1.0 - 0.13 * tracks);
  // (Sand blown in over its edges.)
  asphalt = mix(asphalt, sand, 0.5 * smoothstep(half_ - 0.9, half_, d) * siteVNoise(en / 3.3 + 30.0));
  // The double yellow line down the highway's middle (by which side of it this is: roads.ts
  // build), the white line along each edge.
  float yellow = roadLine(abs(r.g), fw, 0.17, 0.11) * (1.0 - smoothstep(0.02, 0.12, r.a));
  float white = roadLine(d, fw, half_ - 0.32, 0.12);
  vec3 paved = mix(asphalt, vec3(0.62, 0.47, 0.08), 0.85 * yellow);
  paved = mix(paved, vec3(0.66, 0.66, 0.64), 0.85 * white);
  float pavedK = (1.0 - smoothstep(half_ - 0.5 * fw, half_ + 0.5 * fw, d)) * (1.0 - island);
  colour = mix(colour, mix(sand, paved, pavedK), max(pavedK, verge) * r.b);
  return pavedK * r.b;
}`;
