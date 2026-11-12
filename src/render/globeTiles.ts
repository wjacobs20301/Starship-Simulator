// Streamed whole-Earth imagery: NASA Blue Marble (500 m source) as a Web Mercator tile quadtree
// z0..z7 (~1.2 km/px), built by scripts/globe/build-globe.ts. Tiles sit a little below sea level
// so the detailed Starbase terrain always draws on top; the single-texture globe (globe.ts)
// stays underneath to cover the poles, which Web Mercator doesn't reach.

import * as THREE from 'three';
import { DEG } from '../sim/constants';
import type { V3 } from '../sim/math';
import type { FloatingOrigin } from './floatingOrigin';
import { horizonDistance, tileXToLon, tileYToLat, toWorld } from './geo';
import { SEA_GLSL, bindSea, sea } from './ocean';
import { compressTiles, compressTilesFailed, compressedTileTexture, disposeTileTexture, loadTileTexture } from './tileTexture';
import { buildGlobeTile } from './tileWorker';

const BASE = `${import.meta.env.BASE_URL}globe/tiles/`;
const SINK_M = -40;
const MAX_TILES = 400;
const MAX_LOADS = 8;
const SPLIT_PIXELS = 256 * 1.2;

/**
 * A tile's material: the Blue Marble, its sea (told by its colour: bluer than it is green or red,
 * which no land or ice is) with the waves and whitecaps for the wind (ocean.ts).
 */
function tileMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    bindSea(shader, sea);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeaRel;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaRel = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSeaRel;\nfloat gWater = 0.0;\n${SEA_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec3 srgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
gWater = smoothstep(0.08, 0.2, (srgb.b - max(srgb.r, srgb.g)) / max(srgb.b, 0.01));
vec2 seaP = seaPlane(vSeaRel);
vec4 seaJ = seaPixel(seaP);
gSeaFoam = 0.0;
if (gWater > 0.001) {
  seaSurface(vSeaRel, seaP, seaJ, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * gSeaBody, vec3(0.78, 0.8, 0.8), gSeaFoam), gWater);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
if (gWater > 0.001) roughnessFactor = mix(roughnessFactor, mix(gSeaRough, 0.9, gSeaFoam), gWater);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (gWater > 0.001) normal = normalize(mix(normal, normalize((viewMatrix * vec4(gSeaNormal, 0.0)).xyz), gWater * (1.0 - 0.6 * gSeaFoam)));`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
// (Water, told to the atmosphere pass in the alpha: a cloud's shadow dims it far less than land.)
#ifdef OPAQUE
gl_FragColor.a = 1.0 - 0.5 * gWater * (1.0 - gSeaFoam);
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'globe-sea-v3';
  return mat;
}

class GlobeTile {
  mesh: THREE.Mesh | null = null;
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  children: GlobeTile[] | null = null;
  lastUsed = 0;
  /** The last frame it was in the camera's view (lastUsed: wanted, in view or not). */
  lastSeen = 0;
  /** Loads that failed so far, and the frame it may be tried again. */
  fails = 0;
  retryAt = 0;
  center: V3;
  radius: number;
  size: number;

  constructor(readonly z: number, readonly x: number, readonly y: number) {
    // Bounds from a 3x3 sample of the tile (low-zoom tiles are hugely curved).
    const pts: V3[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push(toWorld(tileYToLat(y + j / 2, z), tileXToLon(x + i / 2, z), 0));
    this.center = pts[4];
    this.radius = Math.max(...pts.map((p) => Math.hypot(p[0] - pts[4][0], p[1] - pts[4][1], p[2] - pts[4][2]))) * 1.1 + 1000;
    // Diagonal / sqrt(2): the top edge of the z0 tile is degenerate (both corners on +-180).
    this.size = Math.hypot(pts[8][0] - pts[0][0], pts[8][1] - pts[0][1], pts[8][2] - pts[0][2]) / Math.SQRT2;
  }

  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

export class GlobeTiles {
  readonly group = new THREE.Group();
  private root = new GlobeTile(0, 0, 0);
  private tiles = new Map<string, GlobeTile>([['0/0/0', this.root]]);
  private queue: GlobeTile[] = [];
  private loading = 0;
  private frame = 0;
  private maxZoom = 7;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private origin: FloatingOrigin,
  ) {
    this.group.name = 'GlobeTiles';
  }

  update(camera: THREE.PerspectiveCamera, cam: V3): void {
    this.frame++;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const focal = this.renderer.domElement.clientHeight / 2 / Math.tan((camera.fov * DEG) / 2);
    // The Earth all round the camera, out to its horizon, at the detail its distance calls for,
    // whichever way the camera looks: only those in view are drawn, the rest loaded and ready for
    // when it turns. (Only what was in view, each turn showed the sea and land coarse first.)
    // (And past the horizon a way: mountains stand up over it.)
    const reach = horizonDistance(cam) + 250e3;
    const visible: GlobeTile[] = [];
    const sphere = new THREE.Sphere();
    const visit = (t: GlobeTile) => {
      sphere.center.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
      sphere.radius = t.radius;
      const dist = Math.max(1, sphere.center.length() - t.radius);
      const seen = this.frustum.intersectsSphere(sphere);
      // (Over the horizon: in view, as coarse as it is, out of sight; out of view, left alone.)
      const beyond = dist > reach;
      if (!seen && beyond) return;
      t.lastUsed = this.frame;
      if (seen) t.lastSeen = this.frame;
      if (!beyond && (t.size / dist) * focal > SPLIT_PIXELS && t.z < this.maxZoom) {
        const kids = this.childrenOf(t);
        kids.forEach((k) => {
          k.lastUsed = this.frame;
          if (seen) k.lastSeen = this.frame;
          this.request(k);
        });
        // (All four there: one that failed is tried again, this tile drawn meanwhile, not a hole.)
        if (kids.every((k) => k.state === 'ready')) {
          kids.forEach(visit);
          return;
        }
      }
      if (t.state === 'ready') visible.push(t);
      else this.request(t);
    };
    visit(this.root);
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    this.around.length = 0;
    let key = visible.length;
    for (const t of visible) {
      t.mesh!.visible = t.lastSeen === this.frame;
      this.origin.place(t.mesh!, t.center);
      this.around.push(t.mesh!);
      key = (Math.imul(key, 31) + t.mesh!.id) | 0;
    }
    if (key !== this.aroundKey) {
      this.aroundKey = key;
      this.version++;
    }
    this.pump(cam);
    this.evict();
  }

  /** The tiles round the camera at the detail they're seen at, in view or not. */
  private around: THREE.Mesh[] = [];

  /** Goes up whenever the set of tiles round the camera changes (the sea's map is redrawn then). */
  version = 0;
  private aroundKey = 0;

  /** Draw with all of them shown, not only those in view (the sea's map: oceanSurface.ts). */
  withAllShown(draw: () => void): void {
    const was = this.around.map((m) => m.visible);
    for (const m of this.around) m.visible = true;
    draw();
    this.around.forEach((m, i) => (m.visible = was[i]));
  }

  private childrenOf(t: GlobeTile): GlobeTile[] {
    if (!t.children) {
      t.children = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const k = new GlobeTile(t.z + 1, 2 * t.x + dx, 2 * t.y + dy);
          this.tiles.set(k.key, k);
          t.children.push(k);
        }
      }
    }
    return t.children;
  }

  private request(t: GlobeTile): void {
    if (t.state === 'failed' && t.fails < 5 && this.frame >= t.retryAt) t.state = 'idle';
    if (t.state === 'idle' && !this.queue.includes(t)) this.queue.push(t);
  }

  private pump(cam: V3): void {
    this.queue = this.queue.filter((t) => t.state === 'idle' && t.lastUsed >= this.frame - 1);
    const d = (t: GlobeTile) => (t.center[0] - cam[0]) ** 2 + (t.center[1] - cam[1]) ** 2 + (t.center[2] - cam[2]) ** 2;
    // (What's in view first.)
    const unseen = (t: GlobeTile) => (t.lastSeen >= this.frame - 1 ? 0 : 1);
    this.queue.sort((a, b) => unseen(a) - unseen(b) || a.z - b.z || d(a) - d(b));
    while (this.loading < MAX_LOADS && this.queue.length) {
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
          console.warn(`globe tile ${t.key} failed`, err);
          t.state = 'failed';
          t.retryAt = this.frame + 120 * 2 ** ++t.fails;
        })
        .finally(() => this.loading--);
    }
  }

  private evict(): void {
    // (By the tiles built, not all those ever looked at.)
    if (this.frame % 30) return;
    const built = [...this.tiles.values()].filter((t) => t.mesh);
    if (built.length <= MAX_TILES) return;
    const old = built.filter((t) => t.z > 1 && t.lastUsed < this.frame - 60).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, built.length - MAX_TILES + 50)) {
      const m = t.mesh!;
      this.group.remove(m);
      m.geometry.dispose();
      const mat = m.material as THREE.MeshStandardMaterial;
      disposeTileTexture(mat.map);
      mat.dispose();
      (m.userData.seaMask as THREE.Material | undefined)?.dispose();
      m.userData.seaMask = undefined;
      t.mesh = null;
      t.state = 'idle';
    }
  }

  private async build(t: GlobeTile): Promise<void> {
    const url = `${BASE}${t.key}.jpg`;
    // The image: compressed by the worker where the GPU takes that; else loaded here as before,
    // alongside. (Its failure is the tile's, further down; not unhandled meanwhile.)
    const compress = compressTiles(this.renderer);
    const raw = compress ? null : loadTileTexture(url);
    raw?.catch(() => {});
    // The vertices, in the worker (tileGeometry.ts). Low-zoom tiles span a large part of the
    // globe: more segments keep them round.
    const built = await buildGlobeTile({
      shape: { z: t.z, x: t.x, y: t.y, center: t.center, grid: t.z <= 2 ? 129 : 33, height: SINK_M },
      image: compress ? url : null,
    }).catch((err) => {
      // (No tile: nor its image, if that did load.)
      raw?.then(disposeTileTexture, () => {});
      throw err;
    });
    if (built.imageSkipped) compressTilesFailed();
    const tex = built.image ? compressedTileTexture(built.image) : await (raw ?? loadTileTexture(url));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const geo = built.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(geo.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(geo.uv, 2));
    g.setIndex(new THREE.BufferAttribute(geo.index, 1));
    const mesh = new THREE.Mesh(g, tileMaterial(tex));
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = `globe ${t.key}`;
    t.mesh = mesh;
    this.group.add(mesh);
  }
}
