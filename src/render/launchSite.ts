// The Starbase launch site's ground: one concrete surface over the whole compound (both pads,
// the tank farm and GSE), replacing the aerial imagery there. The imagery is from 2022, before
// Pad 2 and the V3 rebuilds, so it can't show today's pads; the 3D pads, trenches and
// facilities are built on top of this surface.
//
// The slab sits on fill a little above the flattened terrain, with a sloped edge down to the
// surrounding ground, like the built-up pad sites. Coordinates: pad-local east/north metres
// (origin at the Pad 1 launch mount, ground level).

import * as THREE from 'three';
import { PAD, PAD2, type Trench } from '../sim/constants';
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './geo';

/** Launch-site outline, (east, north) m, counter-clockwise. Traced over the imagery / OSM. */
export const SITE_OUTLINE: [number, number][] = [
  [-445, -18],
  [-285, -18],
  [-78, -22],
  [-78, -82],
  [130, -82],
  [130, 118],
  [60, 136],
  [-55, 166],
  [-200, 205],
  [-334, 228],
  [-445, 212],
];

/** A pad's flame-trench opening in the ground, pad-local metres. */
export interface TrenchOpening {
  /** Mount center (east, north), m. */
  center: [number, number];
  /** Unit vector along the trench (east, north). */
  axis: [number, number];
  /** Half length / half width of the opening at grade (including the wall caps), m. */
  half: [number, number];
  trench: Trench;
}

/** Trench wall thickness at grade (art/blender/pad_v3.py WALL): 19 m inside + walls = OSM 23.5 m. */
const TRENCH_WALL = 2.25;

export const TRENCHES: TrenchOpening[] = [PAD, PAD2].map((p) => {
  const a = (p.trench.axisDeg * Math.PI) / 180;
  return {
    center: [(p.lonDeg - PAD.lonDeg) * M_PER_DEG_LON, (p.latDeg - PAD.latDeg) * M_PER_DEG_LAT],
    axis: [Math.cos(a), Math.sin(a)],
    half: [p.trench.length / 2, p.trench.width / 2 + TRENCH_WALL],
    trench: p.trench,
  };
});

/** Corners of a trench opening, counter-clockwise (east, north). */
export function trenchCorners(t: TrenchOpening): [number, number][] {
  const [ax, ay] = t.axis;
  const [hl, hw] = t.half;
  const p = (u: number, v: number): [number, number] => [t.center[0] + ax * u - ay * v, t.center[1] + ay * u + ax * v];
  return [p(-hl, -hw), p(hl, -hw), p(hl, hw), p(-hl, hw)];
}

/** Whether a pad-local point (east, north) lies inside a trench opening. */
export function insideTrench(t: TrenchOpening, e: number, n: number): boolean {
  const de = e - t.center[0];
  const dn = n - t.center[1];
  const u = de * t.axis[0] + dn * t.axis[1];
  const v = -de * t.axis[1] + dn * t.axis[0];
  return Math.abs(u) < t.half[0] && Math.abs(v) < t.half[1];
}

/** Top of the concrete above the pad ground level, m. */
export const SLAB_TOP = 0.3;
/** Width of the sloped fill edge around the slab, m. */
const EDGE = 4;
const EDGE_DROP = 3;

/** Render world (x = E, y = U, z = -N) from pad-local east/north/up. */
const w = (e: number, n: number, u: number) => new THREE.Vector3(e, u, -n);

/**
 * Concrete: large poured slabs with sawn joints, subtle tone differences between pours, grime
 * and tyre marks. Drawn into a canvas once; tiled in world space every TILE metres.
 */
const TILE = 24;
const SLAB = 6;

function concreteTexture(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const N = 1024;
  const px = N / TILE;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const r = document.createElement('canvas');
  r.width = r.height = N;
  const gr = r.getContext('2d')!;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // Base tone per slab: pours differ slightly.
  for (let i = 0; i < TILE / SLAB; i++) {
    for (let j = 0; j < TILE / SLAB; j++) {
      const v = 176 + Math.round((rnd() - 0.5) * 18);
      g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      g.fillRect(i * SLAB * px, j * SLAB * px, SLAB * px, SLAB * px);
      const rv = 205 + Math.round((rnd() - 0.5) * 20);
      gr.fillStyle = `rgb(${rv},${rv},${rv})`;
      gr.fillRect(i * SLAB * px, j * SLAB * px, SLAB * px, SLAB * px);
    }
  }
  // Fine aggregate speckle.
  const img = g.getImageData(0, 0, N, N);
  for (let k = 0; k < img.data.length; k += 4) {
    const d = (rnd() - 0.5) * 22;
    img.data[k] += d;
    img.data[k + 1] += d;
    img.data[k + 2] += d;
  }
  g.putImageData(img, 0, 0);
  // Grime blotches and a few darker stains.
  for (let i = 0; i < 140; i++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const rad = 10 + rnd() * 70;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.03 + rnd() * 0.08;
    grd.addColorStop(0, `rgba(70,64,56,${a})`);
    grd.addColorStop(1, 'rgba(70,64,56,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Tyre tracks: long faint strokes.
  g.strokeStyle = 'rgba(40,38,36,0.06)';
  for (let i = 0; i < 18; i++) {
    g.lineWidth = 6 + rnd() * 8;
    g.beginPath();
    const x = rnd() * N;
    const y = rnd() * N;
    g.moveTo(x, y);
    g.bezierCurveTo(x + (rnd() - 0.5) * 600, y + (rnd() - 0.5) * 600, x + (rnd() - 0.5) * 900, y + (rnd() - 0.5) * 900, rnd() * N, rnd() * N);
    g.stroke();
  }
  // Sawn joints between slabs (dark, and rougher).
  g.fillStyle = 'rgba(60,58,55,0.8)';
  gr.fillStyle = 'rgb(255,255,255)';
  for (let i = 0; i <= TILE / SLAB; i++) {
    const p = Math.round(i * SLAB * px);
    g.fillRect(p - 1, 0, 2, N);
    g.fillRect(0, p - 1, N, 2);
    gr.fillRect(p - 1, 0, 2, N);
    gr.fillRect(0, p - 1, N, 2);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(r);
  for (const t of [map, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, rough };
}

export function createLaunchSite(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'LaunchSite';
  const { map, rough } = concreteTexture();
  // Large-scale tone variation in world space so the tiling doesn't show from the air.
  const mat = new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSiteXZ;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSiteXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vSiteXZ;
        float siteHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float siteNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(siteHash(i), siteHash(i + vec2(1, 0)), f.x), mix(siteHash(i + vec2(0, 1)), siteHash(i + vec2(1, 1)), f.x), f.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float big = 0.6 * siteNoise(vSiteXZ / 90.0) + 0.4 * siteNoise(vSiteXZ / 23.0 + 5.0);
        diffuseColor.rgb *= 0.86 + 0.24 * big;`,
      );
  };
  mat.customProgramCacheKey = () => 'site-concrete-v1';

  // Slab top: the outline, UVs in world metres / TILE.
  const shape = new THREE.Shape(SITE_OUTLINE.map(([e, n]) => new THREE.Vector2(e, n)));
  // The flame trenches open through the slab (holes wind clockwise).
  for (const t of TRENCHES) shape.holes.push(new THREE.Path(trenchCorners(t).reverse().map(([e, n]) => new THREE.Vector2(e, n))));
  const top = new THREE.ShapeGeometry(shape);
  const pos = top.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const e = pos.getX(i);
    const n = pos.getY(i);
    const v = w(e, n, SLAB_TOP);
    out.set([v.x, v.y, v.z], i * 3);
    uv.set([e / TILE, n / TILE], i * 2);
  }
  top.setAttribute('position', new THREE.BufferAttribute(out, 3));
  top.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  top.computeVertexNormals();

  // Sloped fill edge: from the slab outline outward and down into the surrounding ground.
  const edgePos: number[] = [];
  const edgeUv: number[] = [];
  const m = SITE_OUTLINE.length;
  const outward = (i: number): [number, number] => {
    // Average of the two adjacent edge normals (outline is counter-clockwise: outward = right).
    const [a, b, c] = [SITE_OUTLINE[(i - 1 + m) % m], SITE_OUTLINE[i], SITE_OUTLINE[(i + 1) % m]];
    const n1 = [b[1] - a[1], -(b[0] - a[0])];
    const n2 = [c[1] - b[1], -(c[0] - b[0])];
    const l1 = Math.hypot(n1[0], n1[1]);
    const l2 = Math.hypot(n2[0], n2[1]);
    const nx = n1[0] / l1 + n2[0] / l2;
    const ny = n1[1] / l1 + n2[1] / l2;
    const l = Math.hypot(nx, ny);
    return [nx / l, ny / l];
  };
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const [ai, aj] = [outward(i), outward(j)];
    const p0 = SITE_OUTLINE[i];
    const p1 = SITE_OUTLINE[j];
    const q0: [number, number] = [p0[0] + ai[0] * EDGE, p0[1] + ai[1] * EDGE];
    const q1: [number, number] = [p1[0] + aj[0] * EDGE, p1[1] + aj[1] * EDGE];
    const verts = [w(p0[0], p0[1], SLAB_TOP), w(q0[0], q0[1], -EDGE_DROP), w(p1[0], p1[1], SLAB_TOP), w(q1[0], q1[1], -EDGE_DROP)];
    for (const k of [0, 1, 2, 2, 1, 3]) {
      edgePos.push(verts[k].x, verts[k].y, verts[k].z);
      edgeUv.push(verts[k].x / TILE, verts[k].y / 4);
    }
  }
  const edge = new THREE.BufferGeometry();
  edge.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
  edge.setAttribute('uv', new THREE.Float32BufferAttribute(edgeUv, 2));
  edge.computeVertexNormals();
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xb8ad98, roughness: 1, metalness: 0, side: THREE.DoubleSide });

  const slab = new THREE.Mesh(top, mat);
  slab.receiveShadow = true;
  slab.name = 'Concrete';
  const fill = new THREE.Mesh(edge, edgeMat);
  fill.receiveShadow = true;
  fill.name = 'FillEdge';
  group.add(slab, fill);
  return group;
}
