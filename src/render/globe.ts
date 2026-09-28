// Fallback whole-Earth sphere: NASA Blue Marble at ~7 km/px (2.3 MB) on a geodetically placed
// globe. It covers the poles (beyond Web Mercator) and anything before the streamed globe tiles
// (globeTiles.ts, ~1.2 km/px) load. The region shader also samples this texture for sea colour.

import * as THREE from 'three';
import { ecefToWorld, toWorld } from './geo';

/** Fallback sphere (poles, and before tiles load): below the streamed globe tiles (-40 m, whose
 *  low-zoom chords sag up to ~2 km) and the terrain. */
const SINK_M = -3000;
const LON_SEGMENTS = 720;
const LAT_SEGMENTS = 360;

export function createGlobe(texture: THREE.Texture): THREE.Mesh {
  const cols = LON_SEGMENTS + 1;
  const rows = LAT_SEGMENTS + 1;
  const pos = new Float32Array(cols * rows * 3);
  const nrm = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const earthCenter = ecefToWorld([0, 0, 0]);
  for (let j = 0; j < rows; j++) {
    const lat = 90 - (180 * j) / LAT_SEGMENTS;
    for (let i = 0; i < cols; i++) {
      const lon = -180 + (360 * i) / LON_SEGMENTS;
      const k = j * cols + i;
      const p = toWorld(lat, lon, SINK_M);
      pos.set(p, k * 3);
      const n = [p[0] - earthCenter[0], p[1] - earthCenter[1], p[2] - earthCenter[2]];
      const len = Math.hypot(n[0], n[1], n[2]);
      nrm.set([n[0] / len, n[1] / len, n[2] / len], k * 3);
      uv.set([i / LON_SEGMENTS, 1 - j / LAT_SEGMENTS], k * 2);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < LAT_SEGMENTS; j++) {
    for (let i = 0; i < LON_SEGMENTS; i++) {
      const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 }));
  mesh.name = 'Globe';
  mesh.frustumCulled = false;
  return mesh;
}
