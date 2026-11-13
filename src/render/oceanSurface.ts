// The sea's surface near the camera, as a mesh that rises and falls with the waves (ocean.ts's),
// at sea level: a disc of rings round the point under the camera, fine at the middle and
// coarser outward, out past the horizon. Drawn while the camera's low enough to see waves.
//
// Where the water is comes from a map of the sea drawn from above round the camera: the
// detailed ground's own water (terrain.ts: by height) and, beyond it, the Blue Marble's (by its
// colour). Two of them: a sharp one ~16 km across (the shore to a few metres), and a coarse one
// out to the mesh's edge. From the sharp one's mipmaps, the distance to the shore (the waves
// break into surf there and die out up the beach) and, looking upwind, how far the wind has
// blown over water (fetch: a lagoon gets a short chop, not the open sea's long waves, and no
// swell gets in). In the detailed region round Starbase the mesh is drawn only within the sharp
// map, the terrain giving up its water there to it (and keeping it beyond, flat); elsewhere out
// to its edge. With the mesh at sea level, the open sea isn't the globe tiles' (drawn sunk
// 40 m, under the detailed ground) any more near the camera.

import * as THREE from 'three';
import type { V3 } from '../sim/math';
import { SEA_COMMON, SEA_FRAG, SEA_N, bindSea, sea } from './ocean';

/** Rings and segments of the disc. */
const RINGS = 160;
const SEGS = 320;
/** The sharp map: its half size (m) and texels. */
const NEAR_HALF = 8000;
const NEAR_SIZE = 2048;
const FAR_SIZE = 1024;
/** The coarse map's sizes: each this many times the last. */
const FAR_RUNG = 1.5;
/** Drawn below this camera height (m). */
const MAX_ALT = 6000;
/** The detailed region (terrain.ts): its water is the terrain's out here (pad east / north, m). */
const REGION_INNER = 80_000;

/** Ground the sea's maps are drawn from: its tiles, and a way to draw with all of them shown. */
interface SeaSource {
  group: THREE.Group;
  /** Goes up whenever the set of tiles round the camera changes (one built, another level chosen). */
  readonly version: number;
  withAllShown(draw: () => void): void;
}

/** A map of the sea from above: 1 = water, 0 = land (R), mipmapped. */
class SeaMask {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4e5);
  /** Its centre (world, float64), axes (world), half size (m). */
  centre: V3 = [0, 0, 0];
  readonly E = new THREE.Vector3(1, 0, 0);
  readonly N = new THREE.Vector3(0, 0, -1);
  half = 1;
  at = -Infinity;
  valid = false;
  /** The ground it was drawn from (the sources' versions). */
  ver = -1;

  constructor(size: number) {
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  }
}

const TERRAIN_MASK = new THREE.ShaderMaterial({
  uniforms: { uWL: { value: -1.25 } },
  vertexShader: /* glsl */ `
    attribute float aHeight;
    varying float vH;
    void main() { vH = aHeight; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uWL;
    varying float vH;
    void main() { gl_FragColor = vec4(1.0 - smoothstep(uWL - 0.12, uWL + 0.05, vH), 0.0, 0.0, 1.0); }`,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** A globe tile's sea, by colour (as globeTiles.ts tells it). */
function globeMask(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec3 s = pow(max(texture2D(map, vUv).rgb, vec3(0.0)), vec3(1.0 / 2.2));
        gl_FragColor = vec4(smoothstep(0.08, 0.2, (s.b - max(s.r, s.g)) / max(s.b, 0.01)), 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Sampling the maps (vertex or fragment). */
const MASK_GLSL = /* glsl */ `
uniform sampler2D uMaskN;
uniform sampler2D uMaskF;
// Each map: centre (from the camera, world), axes (world), 1 / its half size; .w of C: on.
uniform vec4 uMaskNC;
uniform vec3 uMaskNE;
uniform vec3 uMaskNN;
uniform float uMaskNI;
uniform vec4 uMaskFC;
uniform vec3 uMaskFE;
uniform vec3 uMaskFN;
uniform float uMaskFI;
vec2 maskUvN(vec3 rel) { vec3 d = rel - uMaskNC.xyz; return vec2(dot(d, uMaskNE), dot(d, uMaskNN)) * uMaskNI * 0.5 + 0.5; }
vec2 maskUvF(vec3 rel) { vec3 d = rel - uMaskFC.xyz; return vec2(dot(d, uMaskFE), dot(d, uMaskFN)) * uMaskFI * 0.5 + 0.5; }
// (How far inside the sharp map, 0 at its middle, 1 at its edge.)
float maskEdgeN(vec2 uv) { vec2 a = abs(uv - 0.5) * 2.0; return max(a.x, a.y); }
// Water here (1) or land (0): the sharp map, else the coarse one, else (no map) water.
float seaWater(vec3 rel) {
  if (uMaskNC.w > 0.0) {
    vec2 uv = maskUvN(rel);
    if (maskEdgeN(uv) < 0.985) return textureLod(uMaskN, uv, 0.0).r;
  }
  if (uMaskFC.w > 0.0) {
    vec2 uv = maskUvF(rel);
    if (maskEdgeN(uv) < 0.995) return textureLod(uMaskF, uv, 0.0).r;
  }
  return 1.0;
}
`;

/**
 * How far to the shore (m; 1e4: none near), from the sharp map's mipmaps: the share of water in
 * a box of ground is 0.5 + distance / the box's size (for a straight shore), so each level
 * measures out to half its texel, the finer ones taking over as the shore comes near. (Two
 * levels alone left the distance in terraces, and the breakers, drawn along its contours, in
 * rectangular patches.)
 */
const SHORE_GLSL = /* glsl */ `
float seaShoreDist(vec2 muv) {
  float c = textureLod(uMaskN, muv, 7.0).r;
  if (c > 0.999) return 1e4;
  float d = (c - 0.5) * 1000.000;
  for (int L = 6; L >= 1; L--) {
    float s = 7.81250 * exp2(float(L));
    float dl = (textureLod(uMaskN, muv, float(L)).r - 0.5) * s;
    d = mix(dl, d, smoothstep(0.28 * s, 0.45 * s, abs(d)));
  }
  return d;
}
`;

/** The terrain's side (terrain.ts): whether the mesh has the water here instead. */
export const SEA_MESH_GLSL = /* glsl */ `
uniform sampler2D uMaskN;
uniform vec4 uMaskNC;
uniform vec3 uMaskNE;
uniform vec3 uMaskNN;
uniform float uMaskNI;
bool seaMeshHere(vec3 rel) {
  if (uMaskNC.w <= 0.0) return false;
  vec3 d = rel - uMaskNC.xyz;
  vec2 uv = vec2(dot(d, uMaskNE), dot(d, uMaskNN)) * uMaskNI * 0.5 + 0.5;
  vec2 a = abs(uv - 0.5) * 2.0;
  return max(a.x, a.y) < 0.985 && textureLod(uMaskN, uv, 0.0).r > 0.35;
}
`;

const nearMask = new SeaMask(NEAR_SIZE);
const farMask = new SeaMask(FAR_SIZE);

/** The maps and the disc's placing: shared with the terrain's material (terrain.ts) and the mesh's. */
export const seaMeshUniforms = {
  uMaskN: { value: nearMask.rt.texture as THREE.Texture },
  uMaskF: { value: farMask.rt.texture as THREE.Texture },
  uMaskNC: { value: new THREE.Vector4() },
  uMaskNE: { value: new THREE.Vector3() },
  uMaskNN: { value: new THREE.Vector3() },
  uMaskNI: { value: 1 },
  uMaskFC: { value: new THREE.Vector4() },
  uMaskFE: { value: new THREE.Vector3() },
  uMaskFN: { value: new THREE.Vector3() },
  uMaskFI: { value: 1 },
  /** The disc: inner radius, outer radius, curvature (1 / 2R), the camera's height (m). */
  uRing: { value: new THREE.Vector4(1, 1000, 1 / (2 * 6.371e6), 10) },
  /** World -> the disc's own axes. */
  uToLocal: { value: new THREE.Matrix3() },
  /** The camera (world: pad east, up, -north; float). */
  uCamW: { value: new THREE.Vector3() },
  /** Hulls afloat (fx/afloat.ts): from the camera (world), radius (0: none). */
  uHull: { value: [new THREE.Vector4(), new THREE.Vector4()] },
};

export class OceanSurface {
  readonly mesh: THREE.Mesh;
  private near = nearMask;
  private far = farMask;
  private frame = 0;
  private v = new THREE.Vector3();
  private m = new THREE.Matrix4();
  readonly uniforms = seaMeshUniforms;

  constructor(
    seaColour: { uGlobe: THREE.IUniform; uWater: THREE.IUniform; uWorldToEcef: THREE.IUniform },
  ) {
    // The disc: a middle point, then rings (s = 0..1 out along them, the angle).
    const n = 1 + RINGS * SEGS;
    const polar = new Float32Array(n * 2);
    polar[0] = -1;
    for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEGS; j++) polar.set([i / (RINGS - 1), (j / SEGS) * 2 * Math.PI], (1 + i * SEGS + j) * 2);
    const idx: number[] = [];
    // (Counter-clockwise seen from above: the angle runs east to north.)
    for (let j = 0; j < SEGS; j++) idx.push(0, 1 + j, 1 + ((j + 1) % SEGS));
    for (let i = 0; i < RINGS - 1; i++) {
      for (let j = 0; j < SEGS; j++) {
        const a = 1 + i * SEGS + j, b = 1 + i * SEGS + ((j + 1) % SEGS);
        const c = a + SEGS, d = b + SEGS;
        idx.push(a, c, d, a, d, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('aPolar', new THREE.BufferAttribute(polar, 2));
    g.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      bindSea(shader, sea);
      Object.assign(shader.uniforms, this.uniforms, seaColour);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec2 aPolar;
uniform vec4 uRing;
uniform mat3 uToLocal;
uniform vec3 uCamW;
varying vec3 vSeaRel;
varying vec2 vSeaP;
// (x: distance to the shore (m, 1e4: none near: the mesh's own, for the waves' heights; the
// surf takes it afresh at each pixel), y: the fetch's peak frequency limit, z: swell's share.)
varying vec3 vShore;
${SEA_COMMON}
${MASK_GLSL}
${SHORE_GLSL}
// How far over water upwind (m: 3e4 = open), from here along dir (world): the nearest land
// among a few points out along it, then closed in on between that one and the last of water.
// (Left at the points' own distances it went up in jumps, 300 m to 780 m to 2 km, and the mesh
// drew each jump as a ramp between two of its points: the chop of a bay changed in bands that
// moved with the camera.)
float seaFetch(vec3 rel, vec3 dir) {
  float f = 3e4;
  for (int k = 4; k >= 0; k--) {
    float d = 300.0 * pow(2.6, float(k));
    if (seaWater(rel + dir * d) < 0.5) f = d;
  }
  if (f > 2.9e4) return f;
  float lo = f > 350.0 ? f / 2.6 : 0.0;
  for (int k = 0; k < 4; k++) {
    float mid = 0.5 * (lo + f);
    if (seaWater(rel + dir * mid) < 0.5) f = mid;
    else lo = mid;
  }
  return max(f, 40.0);
}`,
        )
        .replace(
          '#include <begin_vertex>',
          `float r = aPolar.x < 0.0 ? 0.0 : uRing.x * pow(uRing.y / uRing.x, aPolar.x);
vec3 transformed = vec3(r * cos(aPolar.y), -r * r * uRing.z, -r * sin(aPolar.y));
vec3 rel0 = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec2 p = seaPlane(rel0);
// (The mesh's spacing here: the waves finer than it are left to the shading.)
float spacing = max(0.25, max(r * ${((2 * Math.PI) / SEGS).toFixed(6)}, r * log(uRing.y / uRing.x) / ${RINGS - 1}.0));
// The shore: how far (from the sharp map's mipmaps: the share of water round about), and the
// fetch up the wind and the swell.
float shore = 1e4;
float wpLim = 0.0;
float swellK = 1.0;
float edgeFade = 1.0;
if (uMaskNC.w > 0.0) {
  vec2 muv = maskUvN(rel0);
  float e = maskEdgeN(muv);
  if (e < 0.985) {
    shore = seaShoreDist(muv);
  }
  // (In the detailed region the terrain has the water past the sharp map: flat there.)
  vec2 en = vec2(rel0.x + uCamW.x, -(rel0.z + uCamW.z));
  if (max(abs(en.x), abs(en.y)) < ${REGION_INNER}.0) edgeFade = 1.0 - smoothstep(0.8, 0.95, e);
}
vec3 wdir = -(uSeaE * uSea2.x + uSeaN * uSea2.y);
float fetch = seaFetch(rel0, wdir);
if (fetch < 2.9e4) wpLim = 22.0 * pow(96.2 / (max(uSea.x, 0.5) * fetch), 1.0 / 3.0);
vec4 sw = uSeaW[${SEA_N - 2}];
swellK = smoothstep(1500.0, 9000.0, seaFetch(rel0, -(uSeaE * sw.x + uSeaN * sw.y)));
vShore = vec3(shore, wpLim, swellK);
// Waves die out into the surf and up the beach; flat right under the camera (no crest over it).
float surfW = clamp(40.0 * uSea3.x + 30.0 * uSea3.y * swellK, 20.0, 250.0);
float k = smoothstep(0.0, surfW, shore) * edgeFade * mix(1.0, smoothstep(0.5 * uRing.w, 3.0 * uRing.w, r), 1.0 - smoothstep(5.0, 30.0, uRing.w));
vec2 chop;
float h = seaHeight(p, spacing, wpLim, swellK, chop) * k;
vec3 dw = (uSeaE * chop.x + uSeaN * chop.y) * k;
transformed += vec3(0.0, h, 0.0) + uToLocal * dw;
vSeaRel = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSeaP = p;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uGlobe;
uniform vec3 uWater;
uniform mat3 uWorldToEcef;
uniform vec3 uCamW;
uniform vec4 uHull[2];
varying vec3 vSeaRel;
varying vec2 vSeaP;
varying vec3 vShore;
${SEA_COMMON}
${SEA_FRAG}
${MASK_GLSL}
${SHORE_GLSL}`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
vec4 seaJ = seaPixel(vSeaP);
// Only on water; in the detailed region only within the sharp map (the terrain has the rest).
vec2 en = vec2(vSeaRel.x + uCamW.x, -(vSeaRel.z + uCamW.z));
bool region = max(abs(en.x), abs(en.y)) < ${REGION_INNER}.0;
float water = 1.0;
// (The shore's distance here, at the pixel: carried from the mesh's points it was a zig-zag
// between them, the breakers' lines kinked along it, and every kink moved as the camera did,
// the mesh being laid out round the camera.)
float shoreD = 1e4;
vec2 muvN = maskUvN(vSeaRel);
if (uMaskNC.w > 0.0 && maskEdgeN(muvN) < 0.985) {
  water = textureLod(uMaskN, muvN, 0.0).r;
  shoreD = seaShoreDist(muvN);
} else if (region) water = 0.0;
else water = seaWater(vSeaRel);
if (water < 0.35) discard;
seaSurface(vSeaRel, vSeaP, seaJ, vShore.y, vShore.z);
// The water's colour: the Blue Marble's sea (as the terrain mixes it, near Starbase; as the
// globe tiles draw it elsewhere).
vec3 ec = normalize(uWorldToEcef * (vSeaRel - uSeaCentre));
vec3 globe = texture2D(uGlobe, vec2(atan(ec.y, ec.x) / 6.2832 + 0.5, asin(clamp(ec.z, -1.0, 1.0)) / 3.1416 + 0.5)).rgb;
vec3 terr = pow(mix(pow(uWater, vec3(1.0 / 2.2)), pow(globe, vec3(1.0 / 2.2)), 0.75), vec3(2.2));
vec3 col = mix(globe, terr, 1.0 - smoothstep(60000.0, 100000.0, max(abs(en.x), abs(en.y))));
// Surf: the waves breaking in lines toward the beach, white water at its edge.
float surf = 0.0;
// (The wind's waves only as high as the fetch here lets it raise them: their height goes as the
// square of the peak's period, and in a lagoon a mile across that's a few inches, not the open
// Gulf's metres. Every bay and pond had ocean breakers along its banks, lines of them.)
float surfHs = uSea3.x * (vShore.y > 0.0 ? clamp(pow(8.63 / (max(uSea.x, 1.0) * vShore.y), 2.0), 0.0, 1.0) : 1.0) + uSea3.y * vShore.z;
float surfW = clamp(40.0 * surfHs, 3.0, 250.0);
if (surfHs > 0.08 && shoreD < surfW + 30.0) {
  float d = max(shoreD, 0.0);
  // (Closer together than the swell offshore: waves shorten as the water shoals.)
  float ks = uSea3.z * 2.4;
  vec2 q = seaDownwind(vSeaP);
  float wob = 8.0 * (seaNoise(q / 40.0) - 0.5) + 3.0 * (seaNoise(q / 9.0) - 0.5);
  float phs = (d + wob) * ks - uSea3.w;
  float line = sin(phs);
  // (Each breaker breaks in stretches along the shore (its own: they come in with it), a bright
  // crest and lacy foam behind it.)
  float wave = floor((phs + 1.5708) / 6.2832);
  float along = seaGNoise(vec2(q.y / 120.0, wave * 7.3)) * 0.7 + 0.3 * seaGNoise(vec2(q.y / 17.0, wave * 3.1 + 3.0));
  // (Faded to its average where finer than the pixels.)
  float pxs = max(length(seaJ.xy), length(seaJ.zw));
  // (Foam's lace: two layers of smooth noise turned against each other, drifting in with the swash.)
  vec2 ql = q + uSea2.xy * 0.4 * sin(uSea3.w + d * 0.05);
  // (Patches a few metres across with finer ones in them, thinner between but never bare
  // water: cut hard at one or two metres they were a field of dark specks in grey, static on a
  // screen, from a few hundred metres up.)
  float laceA = seaGNoise(mat2(0.6, 0.8, -0.8, 0.6) * ql / 5.5 + 9.0);
  float laceB = seaGNoise(mat2(0.8, -0.6, 0.6, 0.8) * ql / 1.9 + 4.0);
  float lace = mix(0.6, 0.3 + 0.7 * smoothstep(0.3, 0.7, 0.62 * laceA + 0.38 * laceB), 1.0 - smoothstep(0.3, 1.2, pxs));
  float inZone = 1.0 - smoothstep(surfW * 0.6, surfW + 30.0, d);
  float crest = smoothstep(0.95 - 0.08 * along, 0.995, line) * smoothstep(0.28, 0.5, along) * (0.6 + 0.4 * lace);
  float trail = smoothstep(0.1, 0.9, line) * (0.15 + 0.4 * along) * lace;
  float brk = max(crest, trail) * inZone;
  float swash = (1.0 - smoothstep(2.0, 10.0 + 0.1 * surfW, d)) * (0.6 + 0.4 * lace);
  float zone = 0.22 * (1.0 - smoothstep(surfW * 0.3, surfW, d)) * lace;
  surf = clamp(max(max(brk, zone), swash * 0.85) * (0.6 + 0.4 * smoothstep(0.3, 1.2, surfHs)) * smoothstep(0.08, 0.35, surfHs), 0.0, 1.0);
}
gSeaFoam = max(gSeaFoam, surf);
// Round a hull afloat: the water churned white where the waves break on it, thinning outward,
// streaked downwind.
for (int i = 0; i < 2; i++) {
  if (uHull[i].w <= 0.0) continue;
  vec3 dh = vSeaRel - uHull[i].xyz;
  vec3 hu = normalize(vSeaRel - uSeaCentre);
  vec3 side = dh - hu * dot(dh, hu);
  float rr = length(side) - uHull[i].w;
  if (rr > 40.0) continue;
  vec2 q = seaDownwind(vSeaP);
  float lee = 0.5 + 0.5 * dot(normalize(vec2(dot(side, uSeaE), dot(side, uSeaN)) + 1e-5), uSea2.xy);
  float ring = (1.0 - smoothstep(0.0, 2.5 + 10.0 * lee, rr)) * (0.55 + 0.45 * seaNoise(q / 1.2 + float(i) * 7.0));
  float trail = (1.0 - smoothstep(0.0, 35.0, rr)) * lee * smoothstep(0.55, 0.8, seaNoise(vec2(q.x / 6.0, q.y / 1.5)));
  gSeaFoam = max(gSeaFoam, max(ring * 0.9, trail * 0.5) * step(-0.5, rr));
}
diffuseColor.rgb = mix(col * gSeaBody, vec3(0.78, 0.8, 0.8), gSeaFoam);
diffuseColor.a = 1.0;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor = mix(gSeaRough, 0.9, gSeaFoam);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
normal = normalize((viewMatrix * vec4(mix(gSeaNormal, normalize(vSeaRel - uSeaCentre), 0.6 * gSeaFoam), 0.0)).xyz);`,
        )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
// (Water, told to the atmosphere pass in the alpha: a cloud's shadow dims it far less than land.)
#ifdef OPAQUE
gl_FragColor.a = 1.0 - 0.5 * (1.0 - gSeaFoam);
#endif`,
      );
    };
    mat.customProgramCacheKey = () => 'sea-mesh-v7';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'Sea';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /**
   * Each frame, before rendering. cam: the camera (world, float64); centre: the Earth's centre
   * (world); up / east / north: the local axes under the camera; alt: the camera's height over
   * the sea (m); waterLevel: the sea's height above the ellipsoid (m); groundAt(h): the point
   * under the camera at that height (world); groups: what the maps are drawn from.
   */
  update(
    renderer: THREE.WebGLRenderer,
    cam: V3,
    alt: number,
    up: THREE.Vector3,
    east: THREE.Vector3,
    north: THREE.Vector3,
    ground: V3,
    on: boolean,
    terrain: (SeaSource & { waterLevelWorld: number }) | null,
    globe: SeaSource,
    hulls: readonly { at: V3; r: number }[] = [],
  ): void {
    this.frame++;
    const u = this.uniforms;
    u.uHull.value.forEach((h, i) => {
      const hl = hulls[i];
      if (hl) h.set(hl.at[0] - cam[0], hl.at[1] - cam[1], hl.at[2] - cam[2], hl.r);
      else h.set(0, 0, 0, 0);
    });
    const show = on && alt < MAX_ALT;
    this.mesh.visible = show;
    u.uCamW.value.set(cam[0], cam[1], cam[2]);
    if (!show) {
      u.uMaskNC.value.w = 0;
      u.uMaskFC.value.w = 0;
      this.near.valid = this.far.valid = false;
      return;
    }
    // The disc: under the camera, at sea level, out past the horizon.
    const h = Math.max(1, alt);
    const horizon = Math.sqrt(2 * 6.371e6 * h + h * h);
    const outer = Math.min(400e3, Math.max(12e3, 1.4 * horizon));
    u.uRing.value.set(Math.max(0.3, 0.004 * h), outer, 1 / (2 * 6.371e6), h);
    this.mesh.position.set(ground[0] - cam[0], ground[1] - cam[1], ground[2] - cam[2]);
    this.m.makeBasis(east, up, this.v.copy(north).negate());
    this.mesh.quaternion.setFromRotationMatrix(this.m);
    this.mesh.updateMatrixWorld();
    u.uToLocal.value.setFromMatrix4(this.m).transpose();

    // The maps: redrawn when the camera's moved on, and when the ground they're drawn from has
    // changed (tiles streaming in), a few times a second at most. (Not on a timer: each redraw
    // draws every tile round the camera, ~10 ms, a late frame each time.)
    if (terrain) TERRAIN_MASK.uniforms.uWL.value = terrain.waterLevelWorld;
    const ver = (terrain ? terrain.version : -1) * 65536 + globe.version;
    const moved = (mk: SeaMask, frac: number) => Math.hypot(ground[0] - mk.centre[0], ground[1] - mk.centre[1], ground[2] - mk.centre[2]) > mk.half * frac;
    // (The coarse map's size: one of a ladder of sizes, the next up from the disc's reach, kept
    // till the disc outgrows it or would fit one two rungs down: the same map again and again
    // while the camera climbs, not a new one of another scale each time.)
    let farHalf = this.far.half;
    if (!this.far.valid || outer > farHalf || outer < farHalf / (FAR_RUNG * FAR_RUNG)) farHalf = 12e3 * FAR_RUNG ** Math.ceil(Math.log(outer / 12e3) / Math.log(FAR_RUNG) + 1e-9);
    if (!this.near.valid || moved(this.near, 0.15) || (this.near.ver !== ver && this.frame - this.near.at > 15)) this.draw(renderer, this.near, NEAR_HALF, NEAR_HALF / 8, cam, ground, terrain, globe, ver);
    else if (!this.far.valid || moved(this.far, 0.1) || farHalf !== this.far.half || (this.far.ver !== ver && this.frame - this.far.at > 90)) {
      this.draw(renderer, this.far, farHalf, farHalf / 32, cam, ground, terrain, globe, ver);
    }
    for (const [mk, C, E, N, I] of [
      [this.near, u.uMaskNC, u.uMaskNE, u.uMaskNN, u.uMaskNI],
      [this.far, u.uMaskFC, u.uMaskFE, u.uMaskFN, u.uMaskFI],
    ] as const) {
      C.value.set(mk.centre[0] - cam[0], mk.centre[1] - cam[1], mk.centre[2] - cam[2], mk.valid ? 1 : 0);
      E.value.copy(mk.E);
      N.value.copy(mk.N);
      I.value = 1 / mk.half;
    }
  }

  /**
   * Draw a map afresh round the camera: `half` its half size, its centre the point of a grid
   * `grid` apart on the sea's plane (ocean.ts) nearest the ground under the camera, its axes
   * the plane's. (Laid wherever the camera stood, on the axes there, each new map had its
   * texels across the shore somewhere else than the last: the shore's distance, read off the
   * map, shifted a few metres at every redraw, and the surf's lines with it: a jump along the
   * whole beach each time the camera had moved on or a tile had come in. On a grid of whole
   * texels of the coarsest level read, the same shore comes out the same every time.)
   */
  private draw(
    renderer: THREE.WebGLRenderer,
    mk: SeaMask,
    half: number,
    grid: number,
    cam: V3,
    ground: V3,
    terrain: SeaSource | null,
    globe: SeaSource,
    ver: number,
  ): void {
    mk.ver = ver;
    const up = sea.onGrid(ground, grid, mk.centre, mk.E, mk.N, this.v);
    const centre = mk.centre;
    const north = mk.N;
    mk.half = half;
    mk.at = this.frame;
    mk.valid = true;
    const c = mk.cam;
    c.left = -half;
    c.right = half;
    c.top = half;
    c.bottom = -half;
    c.near = 1;
    c.far = 4e5;
    c.position.set(centre[0] - cam[0] + up.x * 2e5, centre[1] - cam[1] + up.y * 2e5, centre[2] - cam[2] + up.z * 2e5);
    c.up.copy(north);
    c.lookAt(centre[0] - cam[0], centre[1] - cam[1], centre[2] - cam[2]);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevShadows = renderer.shadowMap.enabled;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.shadowMap.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(mk.rt);
    // (Nothing drawn: taken as sea.)
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, false, false);
    // (All the ground round the camera, not only what it's looking at: the map is from above,
    // and one drawn from what's in view had the land behind the camera down as sea until the
    // next redraw after a turn: waves over it, then gone.)
    const swap = (src: SeaSource, pick: (m: THREE.Mesh) => THREE.Material) => {
      src.withAllShown(() => {
        const saved: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
        for (const o of src.group.children) {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.visible) continue;
          saved.push([m, m.material]);
          m.material = pick(m);
        }
        renderer.render(src.group, c);
        for (const [m, mat] of saved) m.material = mat;
      });
    };
    swap(globe, (m) => {
      const ud = m.userData as { seaMask?: THREE.ShaderMaterial };
      const map = (m.material as THREE.MeshStandardMaterial).map;
      if (!ud.seaMask && map) ud.seaMask = globeMask(map);
      return ud.seaMask ?? TERRAIN_MASK;
    });
    if (terrain) swap(terrain, () => TERRAIN_MASK);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadows;
    renderer.setClearColor(prevColor, prevAlpha);
  }
}
