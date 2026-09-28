// Streamed Starbase terrain: a quadtree over Web Mercator tiles (z10..z18) built by
// scripts/terrain. Each tile is a 33x33 height grid (with skirts) whose vertices are placed
// exactly on the curved Earth in the pad's ENU frame (same math as the physics), textured with
// NAIP imagery. Water (by height) gets a reflective, animated surface in the shader.

import * as THREE from 'three';
import { TRENCHES } from './launchSite';
import { DEG, PAD } from '../sim/constants';
import type { V3 } from '../sim/math';
import type { FloatingOrigin } from './floatingOrigin';
import { M_PER_DEG_LAT, M_PER_DEG_LON, tileXToLon, tileYToLat, toWorld } from './geo';

interface Range { x0: number; x1: number; y0: number; y1: number }
interface TerrainIndex {
  minZoom: number;
  maxZoom: number;
  demMaxZoom: number;
  demGrid: number;
  waterLevel: number;
  ranges: Record<string, Range>;
  img: Record<string, string>;
  dem: Record<string, string>;
}

const BASE = `${import.meta.env.BASE_URL}terrain/`;
const GRID = 33; // vertices per tile edge
const MAX_TILES = 1200;
const MAX_LOADS = 12;
/** Split when the tile would be drawn larger than ~1.3 texels per screen pixel. */
const SPLIT_PIXELS = 256 * 1.3;


// --- Shared water-aware terrain material ----------------------------------------------

/** Gulf water color; also used where the aerial survey has no coverage (open sea). */
const WATER_COLOR = 0x46696e;
/** Half-size of the streamed region and the width of its fade into the low-res globe, m. */
const REGION_HALF_M = 100_000;
const EDGE_FADE_M = 40_000;
const placeholder = new THREE.DataTexture(new Uint8Array([70, 105, 110, 255]), 1, 1);
placeholder.needsUpdate = true;
const uniforms = {
  uTime: { value: 0 },
  uWaterLevel: { value: 0.25 },
  uWater: { value: new THREE.Color(WATER_COLOR) },
  uGlobe: { value: placeholder as THREE.Texture },
  uPadLatLon: { value: new THREE.Vector2(PAD.latDeg, PAD.lonDeg) },
  uMPerDeg: { value: new THREE.Vector2(M_PER_DEG_LAT, M_PER_DEG_LON) },
  uEdge: { value: new THREE.Vector2(REGION_HALF_M - EDGE_FADE_M, REGION_HALF_M) },
  // Flame-trench openings (center east/north, axis cos/sin) and half sizes: no ground there.
  uTrench: { value: TRENCHES.map((t) => new THREE.Vector4(t.center[0], t.center[1], t.axis[0], t.axis[1])) },
  uTrenchHalf: { value: TRENCHES.map((t) => new THREE.Vector2(t.half[0], t.half[1])) },
};

/**
 * holes: the tile reaches a flame trench, so it cuts the openings out. Only those tiles use the
 * variant with the discard: a shader that can discard loses the GPU's early depth rejection.
 */
function makeMaterial(map: THREE.Texture | null, holes: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map,
    color: map ? 0xffffff : WATER_COLOR,
    roughness: 0.93,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWaterLevel = uniforms.uWaterLevel;
    shader.uniforms.uWater = uniforms.uWater;
    shader.uniforms.uGlobe = uniforms.uGlobe;
    shader.uniforms.uPadLatLon = uniforms.uPadLatLon;
    shader.uniforms.uMPerDeg = uniforms.uMPerDeg;
    shader.uniforms.uEdge = uniforms.uEdge;
    shader.uniforms.uTrench = uniforms.uTrench;
    shader.uniforms.uTrenchHalf = uniforms.uTrenchHalf;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeight;\nattribute vec2 aEN;\nattribute float aWaterWeight;\nvarying float vHeight;\nvarying vec2 vEN;\nvarying float vWaterWeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeight = aHeight;\nvEN = aEN;\nvWaterWeight = aWaterWeight;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uWater;
uniform sampler2D uGlobe;
uniform vec2 uPadLatLon;
uniform vec2 uMPerDeg;
uniform vec2 uEdge;
uniform vec4 uTrench[${TRENCHES.length}];
uniform vec2 uTrenchHalf[${TRENCHES.length}];
varying float vHeight;
varying vec2 vEN;
varying float vWaterWeight;
// Height-based water mask. Coarse tiles have their water colour baked into the imagery by the
// build (their sparse heights can't place the shoreline), so vWaterWeight = 0 turns off only
// the colour override there; gloss and waves still apply everywhere so all tiles match.
float waterMask() { return 1.0 - smoothstep(uWaterLevel - 0.12, uWaterLevel + 0.05, vHeight); }
vec2 waveSlope(vec2 p, float t, float dist) {
  // Directional swell components (Gulf waves roll in from the east-southeast). Each one fades
  // out before it gets finer than a pixel, which would otherwise shimmer as moire.
  vec2 s = vec2(0.0);
  const int N = 6;
  vec2 dirs[N] = vec2[N](vec2(0.957, 0.29), vec2(0.8, 0.6), vec2(0.99, -0.14), vec2(0.35, 0.94), vec2(-0.6, 0.8), vec2(0.7, -0.71));
  float lens[N] = float[N](38.0, 23.0, 14.0, 8.5, 5.1, 3.1);
  for (int i = 0; i < N; i++) {
    float k = 6.2832 / lens[i];
    float fade = 1.0 - smoothstep(lens[i] * 25.0, lens[i] * 80.0, dist);
    float phase = dot(p, dirs[i]) * k - t * sqrt(9.81 * k);
    s += fade * 0.09 * cos(phase + float(i) * 1.7) * dirs[i];
  }
  return s;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${
  holes
    ? `// The flame trenches are open to the sky (their lining is part of the pad model).
for (int i = 0; i < ${TRENCHES.length}; i++) {
  vec2 d = vEN - uTrench[i].xy;
  vec2 uv = vec2(dot(d, uTrench[i].zw), dot(d, vec2(-uTrench[i].w, uTrench[i].z)));
  if (abs(uv.x) < uTrenchHalf[i].x - 0.3 && abs(uv.y) < uTrenchHalf[i].y - 0.3) discard;
}`
    : ''
}
float water = waterMask();
vec2 ll = uPadLatLon + vec2(vEN.y / uMPerDeg.x, vEN.x / uMPerDeg.y);
vec3 globe = texture2D(uGlobe, vec2((ll.y + 180.0) / 360.0, (ll.x + 90.0) / 180.0)).rgb;
// Water takes the Blue Marble's sea colour (shelf shading included), so the streamed region
// matches the globe offshore. Mixed in sRGB exactly as scripts/terrain bakes it into coarse
// tiles, so baked and live water match. vWaterWeight: 0 = baked tile, 1 = live water keeping a
// little of the photo for surf lines, 2 = no imagery (open sea).
vec3 sea = pow(mix(pow(uWater, vec3(1.0 / 2.2)), pow(globe, vec3(1.0 / 2.2)), 0.75), vec3(2.2));
diffuseColor.rgb = mix(diffuseColor.rgb, sea, water * (0.92 * min(vWaterWeight, 1.0) + 0.08 * max(vWaterWeight - 1.0, 0.0)));
// Fade out over the region's outer edge, revealing the streamed globe tiles underneath.
float edge = smoothstep(uEdge.x, uEdge.y, max(abs(vEN.x), abs(vEN.y)));
diffuseColor.a *= 1.0 - edge;
water *= 1.0 - edge;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
// Glossy up close; matte like the globe from far away (so the region blends in from orbit).
roughnessFactor = mix(roughnessFactor, mix(0.07, 0.8, smoothstep(15000.0, 80000.0, length(vViewPosition))), water);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (water > 0.001) {
  vec2 sl = waveSlope(vEN, uTime, length(vViewPosition));
  // Perturb in world space (x = east, z = -north), then move to view space.
  vec3 wn = normalize(vec3(-sl.x, 1.0, sl.y));
  vec3 vn = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  normal = normalize(mix(normal, vn, water));
}`,
      );
  };
  mat.customProgramCacheKey = () => (holes ? 'terrain-v10-holes' : 'terrain-v10');
  return mat;
}

// --- Tiles ---------------------------------------------------------------------------

class Tile {
  mesh: THREE.Mesh | null = null;
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  children: Tile[] | null = null;
  lastUsed = 0;
  /** Ground heights (m above the ellipsoid), GRID x GRID, once built. */
  heights: Float32Array | null = null;
  /** Render-world center (float64) and bounding radius, from the tile corners. */
  center: V3;
  radius: number;
  size: number;

  constructor(readonly z: number, readonly x: number, readonly y: number, readonly hasImagery: boolean) {
    const c = toWorld(tileYToLat(y + 0.5, z), tileXToLon(x + 0.5, z), 0);
    const a = toWorld(tileYToLat(y, z), tileXToLon(x, z), 0);
    const b = toWorld(tileYToLat(y + 1, z), tileXToLon(x + 1, z), 0);
    this.center = c;
    this.size = Math.hypot(b[0] - a[0], b[2] - a[2]) / Math.SQRT2;
    this.radius = this.size * 0.75 + 30;
  }

  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

export class Terrain {
  readonly group = new THREE.Group();
  private index!: TerrainIndex;
  private bits: Record<number, { img: Uint8Array; dem: Uint8Array | null }> = {};
  private roots: Tile[] = [];
  private tiles = new Map<string, Tile>();
  private demCache = new Map<string, Promise<Int16Array | null>>();
  private queue: Tile[] = [];
  private loading = 0;
  private frame = 0;
  private texLoader = new THREE.TextureLoader();
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  ready = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private origin: FloatingOrigin,
  ) {
    this.group.name = 'Terrain';
  }

  async load(): Promise<void> {
    new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}globe/earth.jpg`).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      uniforms.uGlobe.value = tex;
    });
    this.index = (await (await fetch(`${BASE}index.json`)).json()) as TerrainIndex;
    uniforms.uWaterLevel.value = this.index.waterLevel - PAD.groundAlt;
    for (let z = this.index.minZoom; z <= this.index.maxZoom; z++) {
      const dem = this.index.dem[z];
      this.bits[z] = {
        img: Uint8Array.from(atob(this.index.img[z] ?? ''), (c) => c.charCodeAt(0)),
        dem: dem ? Uint8Array.from(atob(dem), (c) => c.charCodeAt(0)) : null,
      };
    }
    const z = this.index.minZoom;
    const r = this.index.ranges[z];
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) this.roots.push(this.tile(z, x, y));
    this.ready = true;
  }

  private has(kind: 'img' | 'dem', z: number, x: number, y: number): boolean {
    const r = this.index.ranges[z];
    if (!r || x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
    const b = this.bits[z]?.[kind];
    if (!b) return false;
    const i = (y - r.y0) * (r.x1 - r.x0 + 1) + (x - r.x0);
    return ((b[i >> 3] >> (i & 7)) & 1) === 1;
  }

  private tile(z: number, x: number, y: number): Tile {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Tile(z, x, y, this.has('img', z, x, y));
      this.tiles.set(key, t);
    }
    return t;
  }

  /** Per-frame: choose tiles for this camera, place them with the floating origin, stream. */
  update(camera: THREE.PerspectiveCamera, cameraWorld: V3, time: number): void {
    if (!this.ready) return;
    this.frame++;
    uniforms.uTime.value = time;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const focal = this.renderer.domElement.clientHeight / 2 / Math.tan((camera.fov * DEG) / 2);

    const visible: Tile[] = [];
    const sphere = new THREE.Sphere();
    const visit = (t: Tile) => {
      sphere.center.set(t.center[0] - cameraWorld[0], t.center[1] - cameraWorld[1], t.center[2] - cameraWorld[2]);
      sphere.radius = t.radius;
      if (!this.frustum.intersectsSphere(sphere)) return;
      t.lastUsed = this.frame;
      const dist = Math.max(1, sphere.center.length() - t.radius);
      const pixels = (t.size / dist) * focal;
      if (pixels > SPLIT_PIXELS && t.z < this.index.maxZoom && t.hasImagery) {
        const kids = this.childrenOf(t);
        if (kids.some((k) => k.hasImagery)) {
          for (const k of kids) {
            k.lastUsed = this.frame;
            this.request(k);
          }
          if (kids.every((k) => k.state === 'ready' || k.state === 'failed')) {
            kids.forEach(visit);
            return;
          }
        }
      }
      if (t.state === 'ready') visible.push(t);
      else this.request(t);
    };
    this.roots.forEach(visit);

    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    for (const t of visible) {
      const m = t.mesh!;
      m.visible = true;
      this.origin.place(m, t.center);
    }
    this.pump(cameraWorld);
    this.evict();
  }

  private childrenOf(t: Tile): Tile[] {
    if (!t.children) {
      t.children = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) t.children.push(this.tile(t.z + 1, 2 * t.x + dx, 2 * t.y + dy));
    }
    return t.children;
  }

  /**
   * Ground height (m above the ellipsoid) at a latitude / longitude, from the finest loaded tile
   * there, or null outside the streamed region (open sea / the low-res globe).
   */
  groundHeight(lat: number, lon: number): number | null {
    if (!this.ready) return null;
    const n0 = (lon + 180) / 360;
    const r = (lat * Math.PI) / 180;
    const m0 = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    for (let z = this.index.maxZoom; z >= this.index.minZoom; z--) {
      const fx = n0 * 2 ** z;
      const fy = m0 * 2 ** z;
      const t = this.tiles.get(`${z}/${Math.floor(fx)}/${Math.floor(fy)}`);
      const h = t?.heights;
      if (!h) continue;
      // Bilinear within the tile's grid.
      const u = (fx - Math.floor(fx)) * (GRID - 1);
      const v = (fy - Math.floor(fy)) * (GRID - 1);
      const i = Math.min(GRID - 2, Math.floor(u));
      const j = Math.min(GRID - 2, Math.floor(v));
      const a = u - i;
      const b = v - j;
      const k = j * GRID + i;
      return (h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + GRID] * (1 - a) + h[k + GRID + 1] * a) * b;
    }
    return null;
  }

  private request(t: Tile): void {
    if (t.state === 'idle' && !this.queue.includes(t)) this.queue.push(t);
  }

  private pump(cam: V3): void {
    // Nearest, coarsest first.
    this.queue = this.queue.filter((t) => t.state === 'idle' && t.lastUsed >= this.frame - 1);
    this.queue.sort((a, b) => a.z - b.z || distSq(a.center, cam) - distSq(b.center, cam));
    while (this.loading < MAX_LOADS && this.queue.length) {
      const t = this.queue.shift()!;
      t.state = 'loading';
      this.loading++;
      this.build(t)
        .then(() => (t.state = 'ready'))
        .catch((err) => {
          console.warn(`terrain tile ${t.key} failed`, err);
          t.state = 'failed';
        })
        .finally(() => this.loading--);
    }
  }

  private evict(): void {
    if (this.tiles.size < MAX_TILES) return;
    const old = [...this.tiles.values()]
      .filter((t) => t.mesh && t.lastUsed < this.frame - 60 && t.z > this.index.minZoom)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.tiles.size - MAX_TILES + 50)) {
      const m = t.mesh!;
      this.group.remove(m);
      m.geometry.dispose();
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
      t.mesh = null;
      t.heights = null;
      t.state = 'idle';
    }
  }

  /** Heights (m, NAVD88) for a tile at GRID x GRID, from its own or an ancestor's DEM tile. */
  private async heights(t: Tile): Promise<Float32Array> {
    const out = new Float32Array(GRID * GRID);
    let zd = Math.min(t.z, this.index.demMaxZoom);
    let dx = t.x >> (t.z - zd);
    let dy = t.y >> (t.z - zd);
    // Walk up until a DEM tile exists (missing = open sea at 0 m).
    while (zd >= this.index.minZoom && !this.has('dem', zd, dx, dy)) {
      zd--;
      dx >>= 1;
      dy >>= 1;
    }
    if (zd < this.index.minZoom) return out;
    const dem = await this.dem(zd, dx, dy);
    if (!dem) return out;
    const G = this.index.demGrid;
    const scale = 2 ** (t.z - zd);
    for (let j = 0; j < GRID; j++) {
      const gy = ((t.y + j / (GRID - 1)) / scale - dy) * (G - 1);
      const y0 = Math.min(G - 2, Math.floor(gy));
      const fy = gy - y0;
      for (let i = 0; i < GRID; i++) {
        const gx = ((t.x + i / (GRID - 1)) / scale - dx) * (G - 1);
        const x0 = Math.min(G - 2, Math.floor(gx));
        const fx = gx - x0;
        const h00 = dem[y0 * G + x0], h10 = dem[y0 * G + x0 + 1];
        const h01 = dem[(y0 + 1) * G + x0], h11 = dem[(y0 + 1) * G + x0 + 1];
        out[j * GRID + i] = ((h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy) / 100;
      }
    }
    return out;
  }

  private dem(z: number, x: number, y: number): Promise<Int16Array | null> {
    const key = `${z}/${x}/${y}`;
    let p = this.demCache.get(key);
    if (!p) {
      p = fetch(`${BASE}dem/${key}.bin`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? new Int16Array(b) : null));
      this.demCache.set(key, p);
      if (this.demCache.size > 400) this.demCache.delete(this.demCache.keys().next().value!);
    }
    return p;
  }

  private async build(t: Tile): Promise<void> {
    const [hts, tex] = await Promise.all([
      this.heights(t),
      t.hasImagery ? this.texLoader.loadAsync(`${BASE}img/${t.key}.jpg`) : Promise.resolve(null),
    ]);
    t.heights = hts;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    }
    const n = GRID * GRID;
    const skirt = 4 * GRID - 4;
    const pos = new Float32Array((n + skirt) * 3);
    const uv = new Float32Array((n + skirt) * 2);
    const hAttr = new Float32Array(n + skirt);
    const en = new Float32Array((n + skirt) * 2);
    // Runtime water colour on tiles fine enough to resolve the shoreline (z15+, ~40 m spacing).
    // Coarser imagery has its water colour baked in by the build; tiles without imagery are sea.
    const waterWeight = new Float32Array(n + skirt).fill(!t.hasImagery ? 2 : t.z >= 15 ? 1 : 0);
    const c = t.center;
    for (let j = 0; j < GRID; j++) {
      const v = j / (GRID - 1);
      const lat = tileYToLat(t.y + v, t.z);
      for (let i = 0; i < GRID; i++) {
        const u = i / (GRID - 1);
        const k = j * GRID + i;
        const h = hts[k];
        const w = toWorld(lat, tileXToLon(t.x + u, t.z), h);
        pos.set([w[0] - c[0], w[1] - c[1], w[2] - c[2]], k * 3);
        uv.set([u, 1 - v], k * 2);
        hAttr[k] = h - PAD.groundAlt;
        en.set([w[0], -w[2]], k * 2);
      }
    }
    // Skirts hang below the tile edges to hide cracks between detail levels.
    const drop = Math.max(2, t.size * 0.02);
    const edge: number[] = [];
    for (let i = 0; i < GRID; i++) edge.push(i);
    for (let j = 1; j < GRID; j++) edge.push(j * GRID + GRID - 1);
    for (let i = GRID - 2; i >= 0; i--) edge.push((GRID - 1) * GRID + i);
    for (let j = GRID - 2; j >= 1; j--) edge.push(j * GRID);
    edge.forEach((src, s) => {
      const k = n + s;
      pos.set([pos[src * 3], pos[src * 3 + 1] - drop, pos[src * 3 + 2]], k * 3);
      uv.set([uv[src * 2], uv[src * 2 + 1]], k * 2);
      hAttr[k] = hAttr[src];
      en.set([en[src * 2], en[src * 2 + 1]], k * 2);
    });
    const idx: number[] = [];
    for (let j = 0; j < GRID - 1; j++) {
      for (let i = 0; i < GRID - 1; i++) {
        const a = j * GRID + i, b = a + 1, d = a + GRID, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const surfaceCount = idx.length;
    for (let s = 0; s < edge.length; s++) {
      const a = edge[s], b = edge[(s + 1) % edge.length];
      const a2 = n + s, b2 = n + ((s + 1) % edge.length);
      idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2); // both windings: skirts are seen from either side
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aHeight', new THREE.BufferAttribute(hAttr, 1));
    g.setAttribute('aEN', new THREE.BufferAttribute(en, 2));
    g.setAttribute('aWaterWeight', new THREE.BufferAttribute(waterWeight, 1));
    // Normals from the surface only (skirt faces would tilt the edge normals and shade every
    // tile border differently), then copied down onto the skirt.
    g.setIndex(idx.slice(0, surfaceCount));
    g.computeVertexNormals();
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    edge.forEach((src, s) => nrm.setXYZ(n + s, nrm.getX(src), nrm.getY(src), nrm.getZ(src)));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius + drop);
    // (Tile centre in pad east / north: world x = east, z = -north.)
    const holes = TRENCHES.some((tr) => Math.hypot(tr.center[0] - c[0], tr.center[1] + c[2]) < t.size * 0.75 + Math.hypot(tr.half[0], tr.half[1]) + 5);
    const material = makeMaterial(tex, holes);
    // Tiles reaching into the region's fade band blend with the globe below.
    const reach = Math.max(Math.abs(c[0]), Math.abs(c[2])) + t.size * 0.75;
    if (reach > REGION_HALF_M - EDGE_FADE_M) material.transparent = true;
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `terrain ${t.key}`;
    mesh.visible = false;
    t.mesh = mesh;
    this.group.add(mesh);
  }
}

const distSq = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
