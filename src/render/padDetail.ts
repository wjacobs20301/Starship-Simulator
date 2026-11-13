// The pads' surfaces as years of launches leave them. The model's materials (art/blender) are one
// even tone each: fresh from the mould. Here, when the model is loaded, each kind gets its wear,
// in the shader:
//   - concrete (the mounts, the tower bases, the trench's caps): pours of slightly different
//     tone, rain streaks down the faces, and soot, heaviest on the mount and fading away from it;
//   - the trench's steel lining and the diverter: scorched dark under the mount, heat-tinted and
//     rusting toward the ends;
//   - the mount's steel deck: soot and scale;
//   - the towers' steel: a darker grey than the model's (dark grey steel in every photo), rust
//     streaks from the joints, a little difference section to section, soot up the lower third.
// The wear is placed by where each vertex stands on the site (aSite, the model's own frame, set
// once here): it stays put when the tower falls, and whatever the floating origin does.

import * as THREE from 'three';
import { TRENCHES } from './launchSite';

type Wear = 'concrete' | 'trench' | 'deck' | 'tower' | 'column' | 'arm';

/** Which wear each of the model's materials (by name) gets. */
const WEAR: Record<string, Wear> = {
  MountConcrete: 'concrete',
  Concrete: 'concrete',
  TrenchSteel: 'trench',
  DiverterPipe: 'trench',
  SteelSooty: 'deck',
  TowerSteel: 'tower',
  TowerColumn: 'column',
  TowerSteelLight: 'deck',
  Chopstick: 'arm',
};

const COMMON = /* glsl */ `
varying vec3 vSite;
uniform vec4 uPadAt[${TRENCHES.length}];
float padHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float padNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(padHash(i), padHash(i + vec3(1, 0, 0)), f.x), mix(padHash(i + vec3(0, 1, 0)), padHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(padHash(i + vec3(0, 0, 1)), padHash(i + vec3(1, 0, 1)), f.x), mix(padHash(i + vec3(0, 1, 1)), padHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// How far from the nearest mount's axis, m (x), and along its trench (y).
vec2 padNear(vec3 p) {
  vec2 best = vec2(1e9, 0.0);
  for (int i = 0; i < ${TRENCHES.length}; i++) {
    vec2 d = p.xz - uPadAt[i].xy;
    float r = length(d);
    if (r < best.x) best = vec2(r, dot(d, uPadAt[i].zw));
  }
  return best;
}`;

const BODY: Record<Wear, string> = {
  concrete: /* glsl */ `
  vec2 pn = padNear(vSite);
  // (Pours and patches; streaks where the rain runs down; a tide mark near the ground.)
  float mott = 0.55 * padNoise(vSite / 9.0) + 0.3 * padNoise(vSite / 2.4 + 7.0) + 0.15 * padNoise(vSite / 0.6 + 2.0);
  float run = padNoise(vec3(vSite.x * 2.6, vSite.y * 0.06, vSite.z * 2.6) + 3.0);
  diffuseColor.rgb *= vec3(1.0, 0.975, 0.93) * (0.86 + 0.2 * mott) * (1.0 - 0.14 * smoothstep(0.5, 0.85, run));
  diffuseColor.rgb *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 2.5, vSite.y)) * padNoise(vSite / 2.0 + 11.0);
  // (Soot: thick on the mount, its inner faces most; thinning out over ~60 m.)
  float soot = (0.75 * exp(-pn.x * pn.x / 500.0) + 0.3 * exp(-pn.x / 45.0)) * (0.6 + 0.4 * padNoise(vSite / 3.0 + 5.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.24, 0.23, 0.22), clamp(soot, 0.0, 0.8));`,
  trench: /* glsl */ `
  vec2 pn = padNear(vSite);
  // (Under the mount: scorched black. Out along the trench: heat tint, blue-brown, then rust.)
  float along = abs(pn.y);
  float n1 = padNoise(vSite / 2.2 + 2.0);
  float scorch = (1.0 - smoothstep(8.0, 30.0, along)) * (0.7 + 0.3 * n1);
  vec3 tint = mix(vec3(0.36, 0.3, 0.27), vec3(0.3, 0.33, 0.4), padNoise(vSite / 6.0 + 9.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * tint * 1.6, 0.7 * smoothstep(10.0, 34.0, along));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.11, 0.07), 0.45 * smoothstep(0.55, 0.8, padNoise(vSite / 1.7 + 4.0)) * smoothstep(18.0, 40.0, along));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.033, 0.032), 0.85 * scorch);`,
  deck: /* glsl */ `
  float n1 = 0.6 * padNoise(vSite / 2.0 + 1.0) + 0.4 * padNoise(vSite / 0.5 + 8.0);
  diffuseColor.rgb *= 0.62 + 0.4 * n1;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.09, 0.06), 0.25 * smoothstep(0.6, 0.85, padNoise(vSite / 0.9 + 14.0)));`,
  tower: /* glsl */ `
  vec2 pn = padNear(vSite);
  // (Dark steel, a little different section to section; rust weeping from the joints; soot up
  // its lower third from the pad below.)
  float section = padHash(vec3(floor((vSite.y - 10.7) / 14.2), 3.0, 7.0));
  float streak = padNoise(vec3(vSite.x * 2.3, vSite.y * 0.11, vSite.z * 2.3) + 6.0);
  diffuseColor.rgb *= 0.74 + 0.1 * section + 0.12 * padNoise(vSite / 3.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.115, 0.07), 0.32 * smoothstep(0.58, 0.85, streak));
  diffuseColor.rgb *= 1.0 - 0.3 * (1.0 - smoothstep(8.0, 55.0, vSite.y)) * exp(-pn.x / 70.0);`,
  column: /* glsl */ `
  vec2 pn = padNear(vSite);
  // (The corner columns: a paler, galvanized steel; rust weeping down from each joint; the
  // pad's soot up their lower third.)
  float joint = fract((vSite.y - 10.7) / 14.2);
  float streak = padNoise(vec3(vSite.x * 3.1, vSite.y * 0.09, vSite.z * 3.1) + 2.0);
  diffuseColor.rgb *= 0.86 + 0.14 * padNoise(vSite / 2.5 + 5.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.115, 0.07), 0.3 * smoothstep(0.55, 0.85, streak) * smoothstep(0.45, 1.0, joint));
  diffuseColor.rgb *= 1.0 - 0.3 * (1.0 - smoothstep(8.0, 55.0, vSite.y)) * exp(-pn.x / 70.0);`,
  arm: /* glsl */ `
  float streak = padNoise(vec3(vSite.x * 1.6, vSite.y * 0.2, vSite.z * 1.6) + 12.0);
  diffuseColor.rgb *= 0.78 + 0.22 * padNoise(vSite / 1.5 + 3.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.115, 0.07), 0.2 * smoothstep(0.62, 0.86, streak));`,
};

/**
 * Give the pad model's surfaces their wear. `model`: the pads as loaded, standing (before the
 * towers are put in their toppling groups).
 */
export function weatherPads(model: THREE.Object3D): void {
  model.updateMatrixWorld(true);
  const toSite = new THREE.Matrix4().copy(model.matrixWorld).invert();
  // (Each mount in the model's frame, and its trench's heading: x east, z south.)
  const padAt = TRENCHES.map((t) => new THREE.Vector4(t.center[0], -t.center[1], t.axis[0], -t.axis[1]));
  const done = new Set<THREE.Material>();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    const wear = WEAR[mat.name];
    if (!wear) return;
    // Where each vertex stands on the site.
    const pos = o.geometry.getAttribute('position');
    if (!o.geometry.getAttribute('aSite')) {
      m.multiplyMatrices(toSite, o.matrixWorld);
      const site = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        site[i * 3] = v.x;
        site[i * 3 + 1] = v.y;
        site[i * 3 + 2] = v.z;
      }
      o.geometry.setAttribute('aSite', new THREE.BufferAttribute(site, 3));
    }
    if (done.has(mat)) return;
    done.add(mat);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPadAt = { value: padAt };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aSite;\nvarying vec3 vSite;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSite = aSite;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${COMMON}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n{${BODY[wear]}\n}`);
    };
    mat.customProgramCacheKey = () => `pad-wear-v5-${wear}`;
    mat.needsUpdate = true;
  });
}
