// Streamed Starbase terrain: a quadtree over Web Mercator tiles (z10..z18) built by
// scripts/terrain. Each tile is a 33x33 height grid (with skirts) whose vertices are placed
// exactly on the curved Earth in the pad's ENU frame (same math as the physics), textured with
// NAIP imagery. Water (by height) gets a reflective, animated surface in the shader. A tile's
// heights, vertices and image are made ready in a worker (tileWorker.ts); here they're only
// wrapped in a mesh.

import * as THREE from 'three';
import { SEA_GLSL, bindSea, sea as seaState } from './ocean';
import { SEA_MESH_GLSL, seaMeshUniforms } from './oceanSurface';
import { TRENCHES } from './launchSite';
import { DEG, PAD } from '../sim/constants';
import type { V3 } from '../sim/math';
import type { FloatingOrigin } from './floatingOrigin';
import { compressTiles, compressTilesFailed, compressedTileTexture, disposeTileTexture, loadTileTexture } from './tileTexture';
import { TileArray } from './tileArray';
import { M_PER_DEG_LAT, M_PER_DEG_LON, horizonDistance, tileXToLon, tileYToLat, toWorld } from './geo';
import { TERRAIN_GRID, type TileId } from './tileGeometry';
import { buildTerrainTile } from './tileWorker';

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
const GRID = TERRAIN_GRID; // vertices per tile edge
/**
 * Tiles kept built (each a 256 px image, 44 kB on the GPU compressed with its mipmaps, ~350 kB
 * where it can't be (tileTexture.ts), and a 33 x 33 grid); ~1000 are in use on the ground. Fewer
 * kept spare on a machine short of memory.
 */
const MAX_TILES = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4 ? 1100 : 1500;
/** A tile that failed to load is tried again this many times (waiting longer each time). */
const MAX_TRIES = 5;
const MAX_LOADS = 12;
/** Split when the tile would be drawn larger than ~1.3 texels per screen pixel. */
const SPLIT_PIXELS = 256 * 1.3;
/** How far past the camera's horizon the ground is still loaded in detail (m). */
const HORIZON_MARGIN_M = 15_000;


// --- Shared water-aware terrain material ----------------------------------------------

/** Gulf water color; also used where the aerial survey has no coverage (open sea). */
const WATER_COLOR = 0x46696e;
/** Half-size of the streamed region and the width of its fade into the low-res globe, m. */
const REGION_HALF_M = 100_000;
const EDGE_FADE_M = 40_000;
const placeholder = new THREE.DataTexture(new Uint8Array([70, 105, 110, 255]), 1, 1);
placeholder.needsUpdate = true;
const siteMaskPlaceholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
siteMaskPlaceholder.needsUpdate = true;
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
  // Built-up ground (setSiteMask): R = concrete / asphalt, G = lawn, over the area rect (min
  // east, min north, 1 / size east, 1 / size north).
  uSiteMask: { value: siteMaskPlaceholder as THREE.Texture },
  uSiteRect: { value: new THREE.Vector4(0, 0, 0, 0) },
};

/** The sea's colour, for the sea mesh (oceanSurface.ts) to match. */
export const seaColourUniforms = { uGlobe: uniforms.uGlobe, uWater: uniforms.uWater };

/**
 * Where the 3D buildings stand, the aerial photo shows them too (flat, leaning, with their
 * shadows, and some since rebuilt or gone): a mask of that ground, drawn as concrete or lawn
 * instead. rect: [min east, min north, size east, size north], pad-local m.
 */
export function setSiteMask(tex: THREE.Texture, rect: [number, number, number, number]): void {
  uniforms.uSiteMask.value = tex;
  uniforms.uSiteRect.value.set(rect[0], rect[1], 1 / rect[2], 1 / rect[3]);
}

/**
 * holes: the tile reaches a flame trench, so it cuts the openings out. Only those tiles use the
 * variant with the discard: a shader that can discard loses the GPU's early depth rejection.
 */
/**
 * array: the tiles' images as layers of one texture (tileArray.ts), the material shared by every
 * tile drawn from it (each vertex says which layer; -1: no image, open sea). Else a material of
 * the tile's own, with its own image (or none).
 */
function makeMaterial(map: THREE.Texture | null, holes: boolean, array: THREE.Texture | null = null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map,
    color: map || array ? 0xffffff : WATER_COLOR,
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
    shader.uniforms.uSiteMask = uniforms.uSiteMask;
    shader.uniforms.uSiteRect = uniforms.uSiteRect;
    bindSea(shader, seaState);
    shader.uniforms.uMaskN = seaMeshUniforms.uMaskN;
    shader.uniforms.uMaskNC = seaMeshUniforms.uMaskNC;
    shader.uniforms.uMaskNE = seaMeshUniforms.uMaskNE;
    shader.uniforms.uMaskNN = seaMeshUniforms.uMaskNN;
    shader.uniforms.uMaskNI = seaMeshUniforms.uMaskNI;
    if (array) shader.uniforms.uTiles = { value: array };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aHeight;\nattribute vec2 aEN;\nattribute float aWaterWeight;\nvarying float vHeight;\nvarying vec2 vEN;\nvarying float vWaterWeight;\nvarying vec3 vSeaRel;${array ? '\nattribute float aLayer;\nvarying float vLayer;\nvarying vec2 vTileUv;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvHeight = aHeight;\nvEN = aEN;\nvWaterWeight = aWaterWeight;\nvSeaRel = (modelMatrix * vec4(transformed, 1.0)).xyz;${array ? '\nvLayer = aLayer;\nvTileUv = uv;' : ''}`);
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
uniform sampler2D uSiteMask;
uniform vec4 uSiteRect;
${array ? 'uniform sampler2DArray uTiles;\nvarying float vLayer;\nvarying vec2 vTileUv;' : ''}
varying float vHeight;
varying vec2 vEN;
varying float vWaterWeight;
// Height-based water mask. Coarse tiles have their water colour baked into the imagery by the
// build (their sparse heights can't place the shoreline), so vWaterWeight = 0 turns off only
// the colour override there; gloss and waves still apply everywhere so all tiles match.
float waterMask() { return 1.0 - smoothstep(uWaterLevel - 0.12, uWaterLevel + 0.05, vHeight); }
varying vec3 vSeaRel;
${SEA_GLSL}
${SEA_MESH_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${array ? '// (The tile\'s image: its layer of the shared array; none: open sea.)\ndiffuseColor *= vLayer < -0.5 ? vec4(uWater, 1.0) : texture(uTiles, vec3(vTileUv, vLayer));' : ''}
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
// Built-up ground around the 3D buildings: concrete (slabs with joints, a little patchy) or lawn,
// over the aerial photo of the buildings themselves.
vec2 siteUv = (vEN - uSiteRect.xy) * uSiteRect.zw;
if (siteUv.x > 0.0 && siteUv.y > 0.0 && siteUv.x < 1.0 && siteUv.y < 1.0) {
  vec2 site = texture2D(uSiteMask, siteUv).rg * (1.0 - water);
  if (site.r + site.g > 0.003) {
    vec2 slab = floor(vEN / 7.5);
    float n = fract(sin(dot(slab, vec2(12.9898, 78.233))) * 43758.5453);
    float n2 = fract(sin(dot(floor(vEN / 31.0), vec2(39.3468, 11.135))) * 24634.6345);
    vec2 jd = abs(fract(vEN / 7.5 + 0.5) - 0.5) * 7.5;
    vec2 jw = max(fwidth(vEN), vec2(1e-3));
    float joint = max((1.0 - smoothstep(0.08 - jw.x, 0.08 + jw.x, jd.x)) * min(1.0, 0.08 / jw.x), (1.0 - smoothstep(0.08 - jw.y, 0.08 + jw.y, jd.y)) * min(1.0, 0.08 / jw.y));
    vec3 concrete = vec3(0.43, 0.43, 0.41) * (0.92 + 0.07 * n + 0.06 * n2) * (1.0 - 0.25 * joint);
    vec3 lawn = vec3(0.12, 0.16, 0.07) * (0.85 + 0.2 * n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, concrete, site.r);
    diffuseColor.rgb = mix(diffuseColor.rgb, lawn, site.g * (1.0 - site.r));
  }
}
// Fade out over the region's outer edge, revealing the streamed globe tiles underneath.
float edge = smoothstep(uEdge.x, uEdge.y, max(abs(vEN.x), abs(vEN.y)));
diffuseColor.a *= 1.0 - edge;
water *= 1.0 - edge;
// (Near the camera the sea mesh has the water, its waves rising and falling: oceanSurface.ts.)
if (water > 0.5 && seaMeshHere(vSeaRel)) discard;
// The sea's surface (ocean.ts): waves for the wind, whitecaps; darker in a gale.
vec2 seaP = seaPlane(vSeaRel);
vec4 seaJ = seaPixel(seaP);
gSeaFoam = 0.0;
if (water > 0.001) {
  seaSurface(vSeaRel, seaP, seaJ, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * gSeaBody, vec3(0.78, 0.8, 0.8), gSeaFoam), water);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
// As rough as the waves too fine to draw make it (ocean.ts), the foam matte.
if (water > 0.001) roughnessFactor = mix(roughnessFactor, mix(gSeaRough, 0.9, gSeaFoam), water);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (water > 0.001) {
  vec3 vn = normalize((viewMatrix * vec4(gSeaNormal, 0.0)).xyz);
  normal = normalize(mix(normal, vn, water * (1.0 - 0.6 * gSeaFoam)));
}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
// (Water, told to the atmosphere pass in the alpha: a cloud's shadow dims it far less than land.)
#ifdef OPAQUE
gl_FragColor.a = 1.0 - 0.5 * water * (1.0 - gSeaFoam);
#endif`,
      );
  };
  mat.customProgramCacheKey = () => `terrain-v16${holes ? '-holes' : ''}${array ? '-array' : ''}`;
  return mat;
}

// --- Tiles ---------------------------------------------------------------------------

class Tile {
  mesh: THREE.Mesh | null = null;
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  children: Tile[] | null = null;
  lastUsed = 0;
  /** The last frame it was in the camera's view (lastUsed: wanted, in view or not). */
  lastSeen = 0;
  /** Loads that failed so far, and the frame it may be tried again. */
  fails = 0;
  retryAt = 0;
  /** Its image's layer in the shared array (tileArray.ts); -1: none there (its own texture, or no image). */
  layer = -1;
  /** Drawn with a shared material (not to be disposed with the tile). */
  shared = false;
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
  private queue: Tile[] = [];
  private loading = 0;
  private frame = 0;
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

  /** The sea's level (world height near the pad, m). */
  get waterLevelWorld(): number {
    return uniforms.uWaterLevel.value;
  }

  /**
   * Per-frame: choose tiles for this camera, place them with the floating origin, stream.
   * orbit: how far ahead the point is that the camera turns about (m; 0: it doesn't): the ground
   * is loaded for wherever turning about it takes the camera.
   */
  update(camera: THREE.PerspectiveCamera, cameraWorld: V3, time: number, orbit = 0): void {
    if (!this.ready) return;
    this.frame++;
    uniforms.uTime.value = time;
    const around = this.select(camera, cameraWorld, orbit);
    // (How many tiles this view still waits for: the loading screen holds for them.)
    let pending = 0;
    for (const t of this.tiles.values()) if (t.lastSeen === this.frame && (t.state === 'idle' || t.state === 'loading')) pending++;
    this.pendingInView = pending;

    // Drawn: those in view. (The rest, all round the camera, are loaded and placed, ready the
    // moment the camera turns to them.)
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    this.around.length = 0;
    let key = around.length;
    for (const t of around) {
      const m = t.mesh!;
      m.visible = t.lastSeen === this.frame;
      this.origin.place(m, t.center);
      this.around.push(m);
      key = (Math.imul(key, 31) + m.id) | 0;
    }
    if (key !== this.aroundKey) {
      this.aroundKey = key;
      this.version++;
    }
    this.pump(cameraWorld);
    this.evict();
  }

  /** Tiles the current view is still waiting for (0: it's all there at full detail). */
  pendingInView = Infinity;

  /** The ground all round the camera at the detail it's seen at, in view or not. */
  private around: THREE.Mesh[] = [];

  /** The tiles' images as one texture, and the materials every tile drawn from it shares (by holes / fading). */
  private array: TileArray | null = null;
  private sharedMaterials: (THREE.MeshStandardMaterial | undefined)[] = [];
  /** The array, made for the first compressed image's size (null: none could be made). */
  private tileArray(first: { width: number; height: number } | null): TileArray | null {
    if (!this.array && first && first.width === first.height) {
      this.array = new TileArray(MAX_TILES + 200, first.width, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    }
    return this.array;
  }

  /** Goes up whenever the set of tiles round the camera changes (the sea's map is redrawn then). */
  version = 0;
  private aroundKey = 0;

  /**
   * Draw with all the ground round the camera shown, not only what's in view (the sea's map,
   * from above: oceanSurface.ts).
   */
  withAllShown(draw: () => void): void {
    const was = this.around.map((m) => m.visible);
    for (const m of this.around) m.visible = true;
    draw();
    this.around.forEach((m, i) => (m.visible = was[i]));
  }

  /**
   * Load ahead the tiles another view will want (the launch pad's while the menu is up), without
   * showing them. Call after update() in the same frame.
   */
  warm(camera: THREE.PerspectiveCamera, cameraWorld: V3): number {
    if (!this.ready) return Infinity;
    this.select(camera, cameraWorld);
    let pending = 0;
    for (const t of this.tiles.values()) if (t.lastSeen === this.frame && (t.state === 'idle' || t.state === 'loading')) pending++;
    this.pump(cameraWorld);
    return pending;
  }

  /**
   * The tiles for this camera: the ground all round it at the detail its distance calls for,
   * whichever way the camera looks (marking every tile wanted as in use, those in view as seen,
   * and asking for any not loaded). (Only what was in view, each turn of the camera showed the
   * ground coarse and sharpened it level by level as its tiles came in.)
   */
  private select(camera: THREE.PerspectiveCamera, cameraWorld: V3, orbit = 0): Tile[] {
    camera.updateMatrixWorld();
    // (The point the camera turns about: straight ahead of it.)
    const e = camera.matrixWorld.elements;
    const target: V3 = [cameraWorld[0] - e[8] * orbit, cameraWorld[1] - e[9] * orbit, cameraWorld[2] - e[10] * orbit];
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const focal = this.renderer.domElement.clientHeight / 2 / Math.tan((camera.fov * DEG) / 2);

    const reach = horizonDistance(cameraWorld) + HORIZON_MARGIN_M;
    const visible: Tile[] = [];
    const sphere = new THREE.Sphere();
    const visit = (t: Tile) => {
      sphere.center.set(t.center[0] - cameraWorld[0], t.center[1] - cameraWorld[1], t.center[2] - cameraWorld[2]);
      sphere.radius = t.radius;
      const dist = Math.max(1, sphere.center.length() - t.radius);
      const seen = this.frustum.intersectsSphere(sphere);
      // (Not what's over the horizon: out of sight whichever way the camera turns. In view,
      // that's drawn as coarse as it is, under the horizon; out of view, not at all.)
      const beyond = dist > reach;
      if (!seen && beyond) return;
      t.lastUsed = this.frame;
      if (seen) t.lastSeen = this.frame;
      let pixels = (t.size / dist) * focal;
      // (And as near as the camera could come to it, turned about its target: dragged round a
      // vehicle on the pad, the camera crosses hundreds of metres of ground, and the ground there
      // was coarse until its tiles came in. Not tiles much smaller than the circle it moves on:
      // from far out that's too many.)
      if (orbit > 0 && t.size > orbit / 2) {
        const dT = Math.hypot(t.center[0] - target[0], t.center[1] - target[1], t.center[2] - target[2]);
        pixels = Math.max(pixels, (t.size / Math.max(1, Math.abs(dT - orbit) - t.radius)) * focal);
      }
      if (!beyond && pixels > SPLIT_PIXELS && t.z < this.index.maxZoom && t.hasImagery) {
        const kids = this.childrenOf(t);
        if (kids.some((k) => k.hasImagery)) {
          for (const k of kids) {
            k.lastUsed = this.frame;
            if (seen) k.lastSeen = this.frame;
            this.request(k);
          }
          // (All four there: a tile that failed to load is tried again, this one drawn meanwhile.
          // Going down to the three that did load would leave a hole where the fourth should be.)
          if (kids.every((k) => k.state === 'ready')) {
            kids.forEach(visit);
            return;
          }
        }
      }
      if (t.state === 'ready') visible.push(t);
      else this.request(t);
    };
    this.roots.forEach(visit);
    return visible;
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
    if (t.state === 'failed' && t.fails < MAX_TRIES && this.frame >= t.retryAt) t.state = 'idle';
    if (t.state === 'idle' && !this.queue.includes(t)) this.queue.push(t);
  }

  private pump(cam: V3): void {
    // What's in view first; then nearest, coarsest first.
    this.queue = this.queue.filter((t) => t.state === 'idle' && t.lastUsed >= this.frame - 1);
    const unseen = (t: Tile) => (t.lastSeen >= this.frame - 1 ? 0 : 1);
    this.queue.sort((a, b) => unseen(a) - unseen(b) || a.z - b.z || distSq(a.center, cam) - distSq(b.center, cam));
    while (this.loading < MAX_LOADS && this.queue.length) {
      // (What's out of view a few at a time: it's in no hurry, and each tile built is work between
      // frames.)
      if (unseen(this.queue[0]) && this.loading >= 3) break;
      const t = this.queue.shift()!;
      t.state = 'loading';
      this.loading++;
      this.build(t)
        .then(() => {
          t.state = 'ready';
          t.fails = 0;
        })
        .catch((err) => {
          console.warn(`terrain tile ${t.key} failed`, err);
          t.state = 'failed';
          // (Again in a few seconds, then longer: 4, 8, 16... s at 60 frames a second.)
          t.retryAt = this.frame + 120 * 2 ** ++t.fails;
        })
        .finally(() => this.loading--);
    }
  }

  private evict(): void {
    // (By the tiles built, not all those ever looked at: counting those, once past the limit
    // every tile out of use for a second was dropped, and loaded again on the way back.)
    if (this.frame % 30) return;
    const built = [...this.tiles.values()].filter((t) => t.mesh);
    if (built.length <= MAX_TILES) return;
    const old = built.filter((t) => t.lastUsed < this.frame - 60 && t.z > this.index.minZoom).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, built.length - MAX_TILES + 50)) {
      const m = t.mesh!;
      this.group.remove(m);
      m.geometry.dispose();
      if (t.shared) this.array?.release(t.layer);
      else {
        const mat = m.material as THREE.MeshStandardMaterial;
        disposeTileTexture(mat.map);
        mat.dispose();
      }
      t.layer = -1;
      t.shared = false;
      t.mesh = null;
      t.heights = null;
      t.state = 'idle';
    }
    this.forget();
  }

  /** Drop the records of tiles long out of use (four children at a time, from the leaves up). */
  private forget(): void {
    const stale = (t: Tile) => !t.mesh && !t.children && t.state !== 'loading' && t.lastUsed < this.frame - 1800;
    for (const t of this.tiles.values()) {
      if (!t.children || !t.children.every(stale)) continue;
      for (const k of t.children) this.tiles.delete(k.key);
      t.children = null;
    }
  }

  /**
   * The DEM tile a tile's heights come from: its own, or (finer than the DEM goes, or none there)
   * the nearest ancestor's. null: none above it (open sea, 0 m).
   */
  private demFor(t: Tile): { url: string; at: TileId; grid: number } | null {
    let zd = Math.min(t.z, this.index.demMaxZoom);
    let dx = t.x >> (t.z - zd);
    let dy = t.y >> (t.z - zd);
    // Walk up until a DEM tile exists (missing = open sea at 0 m).
    while (zd >= this.index.minZoom && !this.has('dem', zd, dx, dy)) {
      zd--;
      dx >>= 1;
      dy >>= 1;
    }
    if (zd < this.index.minZoom) return null;
    return { url: `${BASE}dem/${zd}/${dx}/${dy}.bin`, at: { z: zd, x: dx, y: dy }, grid: this.index.demGrid };
  }

  /**
   * The imagery for a tile: its own, or, where the fine aerial survey has none (its edges, across
   * the border, offshore), the matching part of the nearest coarser tile with imagery, shown just
   * as that tile shows it (its water is baked in), so the two meet without a seam. (Drawn as
   * open sea, those tiles showed as blue strips along the survey's edge, even over land and
   * flats.) Only where nothing above has imagery is it left to the water shader. Returns the
   * image's address and where the tile sits in it (uv offset and scale).
   */
  private imagery(t: Tile): { url: string | null; off: [number, number]; scale: number } {
    if (t.hasImagery) return { url: `${BASE}img/${t.key}.jpg`, off: [0, 0], scale: 1 };
    for (let d = 1; t.z - d >= this.index.minZoom; d++) {
      const ax = t.x >> d, ay = t.y >> d;
      if (!this.has('img', t.z - d, ax, ay)) continue;
      const scale = 2 ** -d;
      return { url: `${BASE}img/${t.z - d}/${ax}/${ay}.jpg`, off: [(t.x - (ax << d)) * scale, (t.y - (ay << d)) * scale], scale };
    }
    return { url: null, off: [0, 0], scale: 1 };
  }

  private async build(t: Tile): Promise<void> {
    const { url, off, scale: texScale } = this.imagery(t);
    const c = t.center;
    // Skirts hang below the tile edges to hide cracks between detail levels.
    const drop = Math.max(2, t.size * 0.02);
    // Tiles reaching into the region's fade band blend with the globe below. (No skirts there:
    // they showed through the part-transparent ground as dark lines along the tile edges.)
    const reach = Math.max(Math.abs(c[0]), Math.abs(c[2])) + t.size * 0.75;
    const fading = reach > REGION_HALF_M - EDGE_FADE_M;
    // The image: compressed by the worker where the GPU takes that; else loaded here as before,
    // alongside. (Its failure is the tile's, further down; not unhandled meanwhile.)
    const compress = compressTiles(this.renderer);
    const raw = url && !compress ? loadTileTexture(url) : null;
    raw?.catch(() => {});
    const built = await buildTerrainTile({
      shape: {
        z: t.z,
        x: t.x,
        y: t.y,
        center: c,
        drop,
        skirts: !fading,
        uvOff: off,
        uvScale: texScale,
        // Runtime water colour on tiles fine enough to resolve the shoreline (z15+, ~40 m spacing).
        // Coarser imagery has its water colour baked in by the build; tiles without imagery are sea.
        // (No imagery anywhere above: all water. A coarser tile's imagery: as that tile draws it.)
        waterWeight: !url ? 2 : t.z >= 15 && t.hasImagery ? 1 : 0,
      },
      dem: this.demFor(t),
      image: compress ? url : null,
    }).catch((err) => {
      // (No tile: nor its image, if that did load.)
      raw?.then(disposeTileTexture, () => {});
      throw err;
    });
    // Its image: a layer of the shared array where it's compressed (and the tile drawn with the
    // material every such tile shares); else a texture and a material of its own.
    const array = compress ? this.tileArray(built.image) : null;
    const layer = array && built.image ? array.add(built.image) : -1;
    const shared = !!array && (layer >= 0 || !url);
    let tex: THREE.Texture | null = null;
    if (shared) tex = null;
    else if (built.image) tex = compressedTileTexture(built.image);
    else if (url) {
      if (built.imageSkipped) compressTilesFailed();
      tex = await (raw ?? loadTileTexture(url));
    }
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    }
    t.heights = built.heights;
    const geo = built.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(geo.uv, 2));
    g.setAttribute('aHeight', new THREE.BufferAttribute(geo.aHeight, 1));
    g.setAttribute('aEN', new THREE.BufferAttribute(geo.aEN, 2));
    g.setAttribute('aWaterWeight', new THREE.BufferAttribute(geo.aWaterWeight, 1));
    g.setAttribute('normal', new THREE.BufferAttribute(geo.normal, 3));
    g.setIndex(new THREE.BufferAttribute(geo.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius + drop);
    // (Tile centre in pad east / north: world x = east, z = -north.)
    const holes = TRENCHES.some((tr) => Math.hypot(tr.center[0] - c[0], tr.center[1] + c[2]) < t.size * 0.75 + Math.hypot(tr.half[0], tr.half[1]) + 5);
    let material: THREE.MeshStandardMaterial;
    if (shared) {
      g.setAttribute('aLayer', new THREE.BufferAttribute(new Float32Array(geo.position.length / 3).fill(layer), 1));
      const k = (holes ? 1 : 0) + (fading ? 2 : 0);
      material = this.sharedMaterials[k] ??= Object.assign(makeMaterial(null, holes, array!.texture), fading ? { transparent: true } : {});
    } else {
      material = makeMaterial(tex, holes);
      if (fading) material.transparent = true;
    }
    t.layer = layer;
    t.shared = shared;
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
