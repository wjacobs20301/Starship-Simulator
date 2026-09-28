// Frost on the propellant tanks. Subcooled LOX and methane freeze the humid Gulf air onto the
// steel wherever liquid is behind the wall, so the frost band shows each tank's fill level. When
// the level drops the ice above it lingers for a while before subliming / shedding, which gives
// the familiar frost line creeping down the booster during ascent.
//
// Works by patching the hull steel materials (per vehicle clone) with a mask in stage-local
// height: y along the stack axis from the booster base, as in the physics body frame.

import * as THREE from 'three';
import type { StageDef } from '../../sim/vehicle';

/** Hull steel materials that frost (booster, ship). The tiles, flaps, decals and fins don't. */
const FROST_MATERIALS = new Set(['Material.003', 'Cryo Section3', 'Material.008', 'Material.461']);

/** Seconds for exposed frost to disappear once the liquid level has dropped below it. */
const FROST_LINGER = 25;

interface Tank {
  bottom: number;
  /** Full-load liquid height, m. */
  full: number;
  density: number;
  /** Mass fraction of the propellant load in this tank. */
  share: number;
}

function tanks(d: StageDef): Tank[] {
  const area = Math.PI * d.radius ** 2;
  const loxShare = d.mixtureRatio / (1 + d.mixtureRatio);
  const loxFull = (d.propMass * loxShare) / (d.loxDensity * area);
  const ch4Full = (d.propMass * (1 - loxShare)) / (d.ch4Density * area);
  const loxBottom = d.xBase + d.tankStart;
  const ch4Bottom = loxBottom + loxFull + 1.5; // common-dome gap, as in sim/vehicle.ts
  return [
    { bottom: loxBottom, full: loxFull, density: d.loxDensity, share: loxShare },
    { bottom: ch4Bottom, full: ch4Full, density: d.ch4Density, share: 1 - loxShare },
  ];
}

const vertexHead = /* glsl */ `
  uniform mat4 uFrostWorldToLocal;
  varying vec3 vFrostLocal;
`;
const vertexBody = /* glsl */ `
  vFrostLocal = (uFrostWorldToLocal * modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const fragmentHead = /* glsl */ `
  uniform vec4 uFrostA; // tank A: bottom, liquid top, frost top, unused
  uniform vec4 uFrostB;
  uniform float uFrostOn;
  varying vec3 vFrostLocal;
  float frostHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float frostNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(frostHash(i), frostHash(i + vec2(1, 0)), f.x), mix(frostHash(i + vec2(0, 1)), frostHash(i + vec2(1, 1)), f.x), f.y);
  }
  float frostBand(vec4 t, float y, float n) {
    // Solid below the liquid level; thinning, patchy frost up to the lingering frost top.
    float wavy = y + (n - 0.5) * 1.6;
    float solid = smoothstep(t.x - 0.3, t.x + 0.6, wavy) * (1.0 - smoothstep(t.y - 0.4, t.y + 0.4, wavy));
    float lingering = smoothstep(t.x, t.x + 0.6, wavy) * (1.0 - smoothstep(t.z - 1.0, t.z, wavy)) * step(t.y, wavy);
    return max(solid, lingering * smoothstep(0.35, 0.75, n));
  }
`;
const fragmentBody = /* glsl */ `
  float frost = 0.0;
  if (uFrostOn > 0.5) {
    // Mesh-local frame: +Y along the stack, XZ around it. Streaky noise: stretched vertically.
    float ang = atan(vFrostLocal.z, vFrostLocal.x) * 4.5;
    float y = vFrostLocal.y;
    vec2 q = vec2(ang * 2.2, y * 0.35);
    float n = 0.55 * frostNoise(q) + 0.3 * frostNoise(q * 3.1 + 7.0) + 0.15 * frostNoise(vec2(ang * 18.0, y * 1.1));
    frost = max(frostBand(uFrostA, y, n), frostBand(uFrostB, y, n));
    frost *= 0.75 + 0.25 * n;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.9), frost);
  }
`;

class StageFrost {
  readonly tanks: Tank[];
  /** Lingering frost top per tank, m. */
  private frostTop: number[];
  private lastTime: number | null = null;

  constructor(
    def: StageDef,
    readonly uniforms: { uFrostA: { value: THREE.Vector4 }; uFrostB: { value: THREE.Vector4 } },
  ) {
    this.tanks = tanks(def);
    this.frostTop = this.tanks.map((t) => t.bottom + t.full);
  }

  update(propFrac: number, time: number): void {
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    // Reset (time went backwards) or first frame: frost matches the level.
    const snap = this.lastTime === null || dt < 0;
    this.lastTime = time;
    const vecs = [this.uniforms.uFrostA.value, this.uniforms.uFrostB.value];
    this.tanks.forEach((t, i) => {
      const top = t.bottom + t.full * Math.max(0, Math.min(1, propFrac));
      if (snap || top > this.frostTop[i]) this.frostTop[i] = top;
      else this.frostTop[i] += (top - this.frostTop[i]) * (1 - Math.exp(-dt / FROST_LINGER));
      vecs[i].set(t.bottom, top, this.frostTop[i], 0);
    });
  }
}

/**
 * Clones the frosting materials of one stage model and patches them. The returned controller
 * updates the fill levels; `root` is the vehicle root whose local frame the mask uses.
 */
export class Frost {
  private stages: StageFrost[] = [];
  private worldToLocal = { value: new THREE.Matrix4() };
  private on = { value: 1 };

  constructor(private root: THREE.Object3D) {}

  addStage(model: THREE.Object3D, def: StageDef): { update(propFrac: number, time: number): void } {
    const uniforms = { uFrostA: { value: new THREE.Vector4() }, uFrostB: { value: new THREE.Vector4() } };
    const clones = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const swap = (m: THREE.Material) => {
        if (!FROST_MATERIALS.has(m.name)) return m;
        let c = clones.get(m);
        if (!c) {
          c = this.patch(m as THREE.MeshStandardMaterial, uniforms);
          clones.set(m, c);
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    const s = new StageFrost(def, uniforms);
    this.stages.push(s);
    return s;
  }

  private patch(src: THREE.MeshStandardMaterial, uniforms: StageFrost['uniforms']): THREE.MeshStandardMaterial {
    const m = src.clone();
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, { uFrostWorldToLocal: this.worldToLocal, uFrostOn: this.on });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${vertexHead}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${vertexBody}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${fragmentHead}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${fragmentBody}`)
        // Ice is a rough, non-metallic white.
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, frost);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, frost);');
    };
    m.customProgramCacheKey = () => 'frost-v1';
    return m;
  }

  /** Call after the root's world matrix is current. */
  updateMatrix(): void {
    this.worldToLocal.value.copy(this.root.matrixWorld).invert();
  }

  dispose(): void {
    // Cloned materials are owned by this vehicle's meshes.
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material) && FROST_MATERIALS.has(o.material.name)) o.material.dispose();
    });
  }
}
