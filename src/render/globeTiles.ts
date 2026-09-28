// Streamed whole-Earth imagery: NASA Blue Marble (500 m source) as a Web Mercator tile quadtree
// z0..z7 (~1.2 km/px), built by scripts/globe/build-globe.ts. Tiles sit a little below sea level
// so the detailed Starbase terrain always draws on top; the single-texture globe (globe.ts)
// stays underneath to cover the poles, which Web Mercator doesn't reach.

import * as THREE from 'three';
import { DEG } from '../sim/constants';
import type { V3 } from '../sim/math';
import type { FloatingOrigin } from './floatingOrigin';
import { ecefToWorld, tileXToLon, tileYToLat, toWorld } from './geo';

const BASE = `${import.meta.env.BASE_URL}globe/tiles/`;
const SINK_M = -40;
const MAX_TILES = 500;
const MAX_LOADS = 8;
const SPLIT_PIXELS = 256 * 1.2;
const EARTH_CENTER = ecefToWorld([0, 0, 0]);

class GlobeTile {
  mesh: THREE.Mesh | null = null;
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  children: GlobeTile[] | null = null;
  lastUsed = 0;
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
  private loader = new THREE.TextureLoader();
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
    const visible: GlobeTile[] = [];
    const sphere = new THREE.Sphere();
    const visit = (t: GlobeTile) => {
      sphere.center.set(t.center[0] - cam[0], t.center[1] - cam[1], t.center[2] - cam[2]);
      sphere.radius = t.radius;
      if (!this.frustum.intersectsSphere(sphere)) return;
      t.lastUsed = this.frame;
      const dist = Math.max(1, sphere.center.length() - t.radius);
      if ((t.size / dist) * focal > SPLIT_PIXELS && t.z < this.maxZoom) {
        const kids = this.childrenOf(t);
        kids.forEach((k) => {
          k.lastUsed = this.frame;
          this.request(k);
        });
        if (kids.every((k) => k.state === 'ready' || k.state === 'failed')) {
          kids.forEach(visit);
          return;
        }
      }
      if (t.state === 'ready') visible.push(t);
      else this.request(t);
    };
    visit(this.root);
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    for (const t of visible) {
      t.mesh!.visible = true;
      this.origin.place(t.mesh!, t.center);
    }
    this.pump(cam);
    this.evict();
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
    if (t.state === 'idle' && !this.queue.includes(t)) this.queue.push(t);
  }

  private pump(cam: V3): void {
    this.queue = this.queue.filter((t) => t.state === 'idle' && t.lastUsed >= this.frame - 1);
    const d = (t: GlobeTile) => (t.center[0] - cam[0]) ** 2 + (t.center[1] - cam[1]) ** 2 + (t.center[2] - cam[2]) ** 2;
    this.queue.sort((a, b) => a.z - b.z || d(a) - d(b));
    while (this.loading < MAX_LOADS && this.queue.length) {
      const t = this.queue.shift()!;
      t.state = 'loading';
      this.loading++;
      this.build(t)
        .then(() => (t.state = 'ready'))
        .catch(() => (t.state = 'failed'))
        .finally(() => this.loading--);
    }
  }

  private evict(): void {
    if (this.tiles.size < MAX_TILES) return;
    const old = [...this.tiles.values()].filter((t) => t.mesh && t.z > 1 && t.lastUsed < this.frame - 60).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.tiles.size - MAX_TILES + 50)) {
      const m = t.mesh!;
      this.group.remove(m);
      m.geometry.dispose();
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
      t.mesh = null;
      t.state = 'idle';
    }
  }

  private async build(t: GlobeTile): Promise<void> {
    const tex = await this.loader.loadAsync(`${BASE}${t.key}.jpg`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // Low-zoom tiles span a large part of the globe: more segments keep them round.
    const grid = t.z <= 2 ? 129 : 33;
    const pos = new Float32Array(grid * grid * 3);
    const nrm = new Float32Array(grid * grid * 3);
    const uv = new Float32Array(grid * grid * 2);
    const c = t.center;
    for (let j = 0; j < grid; j++) {
      const v = j / (grid - 1);
      const lat = tileYToLat(t.y + v, t.z);
      for (let i = 0; i < grid; i++) {
        const u = i / (grid - 1);
        const k = j * grid + i;
        const p = toWorld(lat, tileXToLon(t.x + u, t.z), SINK_M);
        pos.set([p[0] - c[0], p[1] - c[1], p[2] - c[2]], k * 3);
        const n = [p[0] - EARTH_CENTER[0], p[1] - EARTH_CENTER[1], p[2] - EARTH_CENTER[2]];
        const l = Math.hypot(n[0], n[1], n[2]);
        nrm.set([n[0] / l, n[1] / l, n[2] / l], k * 3);
        uv.set([u, 1 - v], k * 2);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < grid - 1; j++) {
      for (let i = 0; i < grid - 1; i++) {
        const a = j * grid + i, b = a + 1, d = a + grid, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = `globe ${t.key}`;
    t.mesh = mesh;
    this.group.add(mesh);
  }
}
