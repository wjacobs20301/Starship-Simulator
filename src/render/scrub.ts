// Scrub and dune grass round the camera at Starbase. From the air the ground is NOAA's survey
// and needs nothing; from a camera standing on it, the same picture is a flat blur underfoot with
// nothing rising out of it. So, within a hundred metres of the camera, tufts stand on it wherever
// the survey shows scrub (public/media/starbase-scrub-2026.jpg, scripts/terrain/build-noaa.ts:
// the speckle of clumps on sand; none on mud, sand, water, paving or the sites).
//
// Fourteen thousand tufts drawn as one mesh, each three crossed cards of blades. Nothing is
// moved from here: each tuft has a fixed place in a 200 m square, and the vertex shader shifts it
// by whole squares to keep it by the camera (so the ground has the same tufts on it whenever
// the camera comes back), stands it on the ground (a small map of heights round the camera,
// from the terrain's tiles, redrawn as the camera travels) and shrinks it to nothing where no
// scrub grows or the distance is too great.

import * as THREE from 'three';
import { PAD } from '../sim/constants';
import type { V3 } from '../sim/math';
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './geo';
import type { Terrain } from './terrain';

/** The scrub map: pad east / north of its south-west corner and its size, m (build-noaa.ts prints them). */
const SCRUB_MAP = { e0: -4560.6, n0: -2338.2, w: 6252, h: 4152 };
/** How far from the camera tufts stand, m, and how many there are in the square about it. */
const REACH = 100;
const COUNT = 14000;
/** The heights' map: its side, m, and its cells per side. */
const GROUND = { side: 288, cells: 72 };
/** No tufts drawn with the camera above this, m: too small to see. */
const CEILING = 350;

/** A clump of blades, for the cards' cut-out: opaque where there's a blade. */
function bladeTexture(): THREE.CanvasTexture {
  const N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = 'rgb(255,255,255)';
  for (let k = 0; k < 22; k++) {
    const x = N / 2 + (rnd() - 0.5) * 44;
    const lean = (rnd() - 0.5) * 90;
    const top = N * (0.05 + 0.6 * rnd() * rnd());
    const w = 3.5 + 3 * rnd();
    g.beginPath();
    g.moveTo(x - w, N);
    g.quadraticCurveTo(x + lean * 0.3, N * 0.55, x + lean, top);
    g.quadraticCurveTo(x + lean * 0.3 + w, N * 0.55, x + w, N);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export class Scrub {
  readonly mesh: THREE.Mesh;
  private heights = new Uint16Array(GROUND.cells * GROUND.cells);
  private ground = new THREE.DataTexture(this.heights, GROUND.cells, GROUND.cells, THREE.RedFormat, THREE.HalfFloatType);
  private uniforms = {
    uScrub: { value: null as THREE.Texture | null },
    uScrubRect: { value: new THREE.Vector4(SCRUB_MAP.e0, SCRUB_MAP.n0, 1 / SCRUB_MAP.w, 1 / SCRUB_MAP.h) },
    uGround: { value: this.ground as THREE.Texture },
    /** Pad east / north of the heights' south-west corner, 1 / their side. */
    uGroundRect: { value: new THREE.Vector3(1e9, 1e9, 1 / GROUND.side) },
    uScrubTime: { value: 0 },
  };
  /** Where the heights' map is centred (pad east / north). */
  private centre: [number, number] = [1e9, 1e9];
  private ready = false;
  /** When to take the heights again (s; 0: not waiting), some of the ground's tiles not yet in. */
  private retry = 0;

  constructor(private terrain: Terrain) {
    this.ground.magFilter = this.ground.minFilter = THREE.LinearFilter;
    this.ground.wrapS = this.ground.wrapT = THREE.ClampToEdgeWrapping;
    new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}media/starbase-scrub-2026.jpg`, (t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      this.uniforms.uScrub.value = t;
      this.ready = true;
    });

    // A tuft: three cards crossed about the vertical, a metre wide and high, standing on y = 0.
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3;
      const [cx, cz] = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
      const b = pos.length / 3;
      pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const seeds = new Float32Array(COUNT * 4);
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < COUNT; i++) seeds.set([rnd() * 2 * REACH, rnd() * 2 * REACH, rnd(), rnd()], i * 4);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = COUNT;

    const mat = new THREE.MeshLambertMaterial({ map: bladeTexture(), alphaTest: 0.4, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aSeed;
uniform sampler2D uScrub;
uniform vec4 uScrubRect;
uniform sampler2D uGround;
uniform vec3 uGroundRect;
uniform float uScrubTime;
varying vec3 vTint;`,
        )
        .replace(
          '#include <begin_vertex>',
          `// (Its place: its own in the square, moved by whole squares to be by the camera. In the
// mesh's frame: pad-local, x east, z south.)
vec3 camL = cameraPosition - modelMatrix[3].xyz;
vec2 at = aSeed.xy + ${(2 * REACH).toFixed(1)} * floor((camL.xz - aSeed.xy) / ${(2 * REACH).toFixed(1)} + 0.5);
vec2 en = vec2(at.x, -at.y);
vec2 suv = (en - uScrubRect.xy) * uScrubRect.zw;
float veg = suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0 ? texture2D(uScrub, suv).r : 0.0;
float far = distance(at, camL.xz);
// (Where scrub is thin, fewer tufts and smaller; none past the reach.)
float grow = step(aSeed.z, veg * 1.2) * (0.55 + 0.45 * veg) * (1.0 - smoothstep(${(0.7 * REACH).toFixed(1)}, ${REACH.toFixed(1)}, far));
float size = grow * mix(0.55, 1.5, aSeed.w);
float turn = aSeed.w * 39.0;
vec2 flat2 = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * position.xz * 1.5 * size;
// (A little sway in the sea breeze, at the tips.)
flat2 += position.y * size * 0.07 * vec2(sin(uScrubTime * 1.7 + at.x * 0.31), cos(uScrubTime * 1.3 + at.y * 0.27));
float ground = texture2D(uGround, (en - uGroundRect.xy) * uGroundRect.z).r;
vec3 transformed = vec3(at.x + flat2.x, ground - 0.06 + position.y * size * mix(0.5, 0.95, fract(aSeed.w * 7.3)), at.y + flat2.y);
// Grey-green clump to straw, each its own; darker toward the root.
// (Dark, as the clumps are in the survey: pale sage and straw, they stood out of their own
// picture on the ground like paper cut-outs.)
float straw = fract(aSeed.z * 13.7);
vTint = mix(vec3(0.075, 0.09, 0.06), vec3(0.2, 0.185, 0.125), straw * straw) * (0.45 + 0.75 * position.y);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
        .replace(
          '#include <map_fragment>',
          `// (The picture is only the blades' outline.)
diffuseColor.a *= texture2D(map, vMapUv).r;
diffuseColor.rgb = vTint;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
// (Lit as the ground it stands on is, from either side: a card lit by its own facing went
// black whenever the sun was behind it.)
normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`,
        );
    };
    mat.customProgramCacheKey = () => 'starbase-scrub-v2';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Scrub';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Each frame. cam: the camera (pad-local render world, float64); time: seconds. */
  update(cam: V3, time: number): void {
    const [e, n] = [cam[0], -cam[2]];
    const near = this.ready && this.terrain.ready && cam[1] < CEILING && e > SCRUB_MAP.e0 - REACH && e < SCRUB_MAP.e0 + SCRUB_MAP.w + REACH && n > SCRUB_MAP.n0 - REACH && n < SCRUB_MAP.n0 + SCRUB_MAP.h + REACH;
    this.mesh.visible = near;
    if (!near) return;
    this.uniforms.uScrubTime.value = time;
    // The heights round the camera: again once it has gone a fair way from where they were taken.
    const slack = GROUND.side / 2 - REACH - 8;
    if (Math.abs(e - this.centre[0]) < slack && Math.abs(n - this.centre[1]) < slack && !(this.retry && time > this.retry)) return;
    this.retry = 0;
    const cell = GROUND.side / GROUND.cells;
    this.centre = [Math.round(e / cell) * cell, Math.round(n / cell) * cell];
    const [e0, n0] = [this.centre[0] - GROUND.side / 2, this.centre[1] - GROUND.side / 2];
    let missing = false;
    for (let j = 0; j < GROUND.cells; j++) {
      const pn = n0 + (j + 0.5) * cell;
      for (let i = 0; i < GROUND.cells; i++) {
        const pe = e0 + (i + 0.5) * cell;
        const h = this.terrain.groundHeight(PAD.latDeg + pn / M_PER_DEG_LAT, PAD.lonDeg + pe / M_PER_DEG_LON);
        if (h === null) missing = true;
        // (In the render world: above the pad's ground, less the Earth's curve out to there.)
        this.heights[j * GROUND.cells + i] = THREE.DataUtils.toHalfFloat((h ?? PAD.groundAlt) - PAD.groundAlt - (pe * pe + pn * pn) / (2 * 6371000));
      }
    }
    this.ground.needsUpdate = true;
    this.uniforms.uGroundRect.value.set(e0, n0, 1 / GROUND.side);
    // (Tiles still coming in: taken again in a second.)
    if (missing) this.retry = time + 1;
  }
}
