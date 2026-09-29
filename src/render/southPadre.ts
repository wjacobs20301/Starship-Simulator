// South Padre Island and Port Isabel, across the channel north of Starbase: the skyline behind
// every launch view from the pad. From OpenStreetMap (public/data/spi.json, built by
// scripts/terrain/build-spi.py): ~3,800 footprints, mostly beach houses in pastel colours, the
// condo and hotel towers along the beachfront, the Queen Isabella Causeway and the Port Isabel
// Lighthouse. All one merged mesh in the Starbase buildings' material (one draw call), with the
// Earth's curvature drop applied (~8 m at 10 km).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD } from '../sim/constants';
import { STYLE, buildingMaterial, hash, tag } from './facilities';

interface SpiData {
  /** Per building: height (m), style (0 house, 1 tower, 2 commercial), then the ring's east/north pairs. */
  buildings: number[][];
  causeway: number[][][];
  lighthouse: [number, number] | null;
}

const R_EARTH = 6371000;
/** Ground height of the island and the town (above the ellipsoid), m. */
const GROUND = 2;
/** Beach-house colours (sRGB): white, sand, pale blues and greens, coral, yellow. */
const HOUSE_COLORS = [0xf2efe8, 0xe8dcc4, 0xc9dde6, 0xcfe3d4, 0xeec9b8, 0xf1e3b0, 0xdedfe2, 0xb9cfe0];
/** Towers and hotels: white and cream concrete, some with blue glass. */
const TOWER_COLORS = [0xf0eee8, 0xe9e4d8, 0xdfe3e6, 0xe6ddcc];
const COMMERCIAL_COLORS = [0xe4e0d8, 0xd6d0c4, 0xcdd2d6];

/** Render height of the ground at (east, north): its height above the pad, less the curvature drop. */
const groundY = (e: number, n: number) => GROUND - PAD.groundAlt - (e * e + n * n) / (2 * R_EARTH);

export async function loadSouthPadre(): Promise<THREE.Group> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/spi.json`);
  const data = (await res.json()) as SpiData;
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();

  for (const b of data.buildings) {
    const [h, kind] = b;
    const ring: [number, number][] = [];
    for (let i = 2; i + 1 < b.length; i += 2) ring.push([b[i], b[i + 1]]);
    if (ring.length < 3) continue;
    const e = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const n = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x - e, y - n)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h + 1, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -1);
    // Local (east, north, up) -> render world (x = E, y = U, z = -N).
    g.rotateX(-Math.PI / 2);
    const y0 = groundY(e, n);
    g.translate(e, y0, -n);
    const seed = hash(e, n);
    const palette = kind === 1 ? TOWER_COLORS : kind === 2 ? COMMERCIAL_COLORS : HOUSE_COLORS;
    color.setHex(palette[Math.floor(seed * palette.length)]);
    const style = kind === 1 ? STYLE.office : kind === 2 ? STYLE.shed : STYLE.house;
    parts.push(tag(g, color, [y0, h, style, seed]));
  }

  // The Queen Isabella Causeway (its longest mapped span): a deck on piers, humped over the channel.
  const way = [...data.causeway].sort((a, b) => length(b) - length(a))[0];
  if (way) {
    const L = length(way);
    let s = 0;
    const deck = new THREE.Color(0xbdbab2);
    for (let i = 0; i + 1 < way.length; i++) {
      const [e0, n0] = way[i];
      const [e1, n1] = way[i + 1];
      const seg = Math.hypot(e1 - e0, n1 - n0);
      // Split into ~30 m pieces so the deck follows the hump.
      const pieces = Math.max(1, Math.ceil(seg / 30));
      for (let k = 0; k < pieces; k++) {
        const a = k / pieces;
        const c = (k + 0.5) / pieces;
        const [ea, na] = [e0 + (e1 - e0) * a, n0 + (n1 - n0) * a];
        const [ec, nc] = [e0 + (e1 - e0) * c, n0 + (n1 - n0) * c];
        const along = s + seg * c;
        // Low over the flats, rising to ~25 m over the main channel near the middle.
        const rise = 4 + 21 * Math.exp(-(((along / L - 0.5) / 0.14) ** 2));
        const y = groundY(ec, nc) + rise;
        const len = seg / pieces;
        const box = new THREE.BoxGeometry(len + 0.4, 1.8, 16);
        box.rotateY(Math.atan2(n1 - n0, e1 - e0));
        box.translate(ec, y, -nc);
        parts.push(tag(box, deck, [y - 0.9, 1.8, STYLE.plain, 0]));
        // A pier at the start of each piece, down to the water.
        const py = groundY(ea, na) - 2;
        const ph = y - 0.9 - py;
        if (ph > 1) {
          const pier = new THREE.BoxGeometry(2.2, ph, 9);
          pier.rotateY(Math.atan2(n1 - n0, e1 - e0));
          pier.translate(ea, py + ph / 2, -na);
          parts.push(tag(pier, deck, [py, ph, STYLE.plain, 0]));
        }
      }
      s += seg;
    }
  }

  // The Port Isabel Lighthouse (1852): a white tapered brick tower with a black lantern.
  if (data.lighthouse) {
    const [e, n] = data.lighthouse;
    const y0 = groundY(e, n) + 2;
    const tower = new THREE.CylinderGeometry(2.3, 3.4, 18, 16, 1, true);
    tower.translate(e, y0 + 9, -n);
    parts.push(tag(tower, new THREE.Color(0xf4f2ec), [y0, 18, STYLE.plain, 0]));
    const lantern = new THREE.CylinderGeometry(1.7, 1.7, 3.2, 12);
    lantern.translate(e, y0 + 19.6, -n);
    parts.push(tag(lantern, new THREE.Color(0x1d1f22), [y0 + 18, 3.2, STYLE.plain, 0]));
    const cap = new THREE.ConeGeometry(2.1, 1.8, 12);
    cap.translate(e, y0 + 22.1, -n);
    parts.push(tag(cap, new THREE.Color(0x1d1f22), [y0 + 21.2, 1.8, STYLE.plain, 0]));
  }

  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, buildingMaterial);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'South Padre Island';
  const group = new THREE.Group();
  group.name = 'South Padre Island';
  group.add(mesh);
  return group;
}

function length(way: number[][]): number {
  let l = 0;
  for (let i = 0; i + 1 < way.length; i++) l += Math.hypot(way[i + 1][0] - way[i][0], way[i + 1][1] - way[i][1]);
  return l;
}
