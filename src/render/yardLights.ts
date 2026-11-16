// Starbase's working lights, beyond the pads' own (padLights.ts): the floodlight masts round the
// launch site, the lamps along the Starfactory's walls, the high bays' floods, and the street
// lights of the production site and the village: Highway 4 through them and the streets off it.
// (The highway across the flats to the launch site is unlit, as it is.)
//
// Each lamp is a point of light seen from any distance (padLights.ts's glows), a pool of light
// on the ground under it (siteLight.ts: a map the ground's materials read), and, for the street
// lights, a pole. No lights in the scene.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toFxLayer } from './atmosphere';
import { glowField } from './padLights';
import { HIGHWAY_4_WEST, SIDE_ROADS } from './roadLines';
import { siteLightUniforms } from './siteLight';

/** A lamp: pad east / north, height above the ground (m), and how far its pool reaches (m). */
export interface YardLamp { e: number; n: number; h: number; reach: number; kind: 'mast' | 'wall' | 'street' }

/** The ground the light map covers (pad east / north, m) and its pixel, m. */
const MAP = { e0: -3950, n0: -1850, w: 4400, h: 2350, px: 4 };
/** The Earth's curve under a lamp that far from the pad (it stands on the ground there). */
const drop = (e: number, n: number) => (e * e + n * n) / (2 * 6371000);

/** Street lights along a road's line: one every `pitch` m, `side` m off its centre, alternate sides. */
function along(line: readonly (readonly [number, number])[], pitch: number, side: number, keep: (e: number, n: number) => boolean, out: YardLamp[], h: number): void {
  let carried = pitch / 2;
  let k = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (; carried < len; carried += pitch, k++) {
      const s = k % 2 ? side : -side;
      const [e, n] = [a[0] + ((b[0] - a[0]) * carried) / len - ((b[1] - a[1]) / len) * s, a[1] + ((b[1] - a[1]) * carried) / len + ((b[0] - a[0]) / len) * s];
      if (keep(e, n)) out.push({ e, n, h, reach: 3.4 * h, kind: 'street' });
    }
    carried -= len;
  }
}

/** The lamps of `given` (the buildings' and masts': facilities.ts) with the street lights added. */
export function createYardLights(given: YardLamp[]): THREE.Group {
  const lamps = [...given];
  // The production site and the village: between the bay shore and the east end of the village.
  const built = (e: number, n: number) => e > -3900 && e < -2620 && n > -1800 && n < -150;
  along(HIGHWAY_4_WEST, 46, 7.5, built, lamps, 10);
  for (const [half, line] of SIDE_ROADS) if (half >= 2.9) along(line, 42, half + 1.6, built, lamps, 7.5);

  // The pools on the ground.
  const c = document.createElement('canvas');
  c.width = Math.ceil(MAP.w / MAP.px);
  c.height = Math.ceil(MAP.h / MAP.px);
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(0,0,0)';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'lighter';
  for (const l of lamps) {
    const [x, y] = [(l.e - MAP.e0) / MAP.px, (MAP.n0 + MAP.h - l.n) / MAP.px];
    const r = l.reach / MAP.px;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const peak = l.kind === 'mast' ? 0.62 : 0.5;
    grad.addColorStop(0, `rgba(255,255,255,${peak})`);
    grad.addColorStop(0.35, `rgba(255,255,255,${peak * 0.42})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  siteLightUniforms.uSiteLight.value = map;
  siteLightUniforms.uSiteLightRect.value.set(MAP.e0, MAP.n0, 1 / MAP.w, 1 / MAP.h);

  const group = new THREE.Group();
  group.name = 'Yard lights';
  // The points of light.
  const points = glowField(
    lamps.map((l) => ({
      pos: new THREE.Vector3(l.e, l.h - drop(l.e, l.n), -l.n),
      brightness: l.kind === 'mast' ? 2 : l.kind === 'wall' ? 1.1 : 1.3,
      size: l.kind === 'mast' ? 2.4 : 1.1,
      haze: l.kind === 'mast' ? 24 : 11,
    })),
  );
  toFxLayer(points);
  group.add(points);
  // The street lights' poles, each with its arm and head.
  const poles: THREE.BufferGeometry[] = [];
  for (const l of lamps) {
    if (l.kind !== 'street') continue;
    const y = -drop(l.e, l.n);
    const pole = new THREE.BoxGeometry(0.16, l.h, 0.16);
    pole.translate(l.e, y + l.h / 2, -l.n);
    const head = new THREE.BoxGeometry(0.7, 0.14, 0.3);
    head.translate(l.e, y + l.h - 0.1, -l.n);
    poles.push(pole.toNonIndexed(), head.toNonIndexed());
  }
  if (poles.length) {
    const mesh = new THREE.Mesh(mergeGeometries(poles)!, new THREE.MeshStandardMaterial({ color: 0x8b8f93, roughness: 0.6, metalness: 0.4 }));
    mesh.name = 'Street lights';
    group.add(mesh);
  }
  return group;
}
