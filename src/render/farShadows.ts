// Shadows on the ground at Starbase from anywhere: the towers', the bays', every building's and
// tank's. The shadow map (scene.ts) covers a few hundred metres round what the camera follows:
// the launch site while a vehicle is on or near it, or the patch under a climbing one. Beyond
// it nothing cast a shadow: the Mega Bays, 100 m tall, stood on their site without one, like
// models set down on a photo, and from a few km up, looking back at the pad, nor did the towers.
//
// Starbase is flat, so a shadow on its ground is the thing itself slid along the sun's rays down
// onto a plane: the casters are drawn from straight above with every point moved to where its
// shadow falls, into a map of the two sites (1.2 m a texel), which the ground's materials read.
// Drawn again when the sun has moved or a tower has; left out where the shadow map itself has
// the ground (the map's are sharper, and fall on the buildings too).

import * as THREE from 'three';
import type { V3 } from '../sim/math';

/** The ground covered, pad east / north (m): the launch site and the production site and village. */
const RECT = { e0: -4300, n0: -1900, w: 5000, h: 2600 };
const SIZE: [number, number] = [4096, 2048];
/** The ground's height there (m above the pad's: fill and building pads, a metre or two). */
const GROUND = 1.5;
/** As dark as the shadow map's shadows look on the ground at midday (the sky still lights them). */
const DEPTH = 0.5;

const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
placeholder.needsUpdate = true;

export const farShadowUniforms = {
  uFarShadow: { value: placeholder as THREE.Texture },
  /** Pad east / north of the map's corner, 1 / its size. */
  uFarShadowRect: { value: new THREE.Vector4(RECT.e0, RECT.n0, 1 / RECT.w, 1 / RECT.h) },
  /** Where the shadow map has the ground: pad east, north, radius (m; 0: nowhere). */
  uFarShadowNear: { value: new THREE.Vector3() },
  /** How dark (0: none: night, or the sun hidden). */
  uFarShadowK: { value: 0 },
};

/** For a ground material's fragment shader: farShadow(en): how much darker here (0..1), en pad east / north. */
export const FAR_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uFarShadow;
uniform vec4 uFarShadowRect;
uniform vec3 uFarShadowNear;
uniform float uFarShadowK;
float farShadow(vec2 en) {
  if (uFarShadowK <= 0.0) return 0.0;
  vec2 uv = (en - uFarShadowRect.xy) * uFarShadowRect.zw;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  // (Four taps half a texel apart: an edge a couple of metres soft, as a tall thing's is by the
  // time it reaches the ground, not the map's own stairs.)
  vec2 h = vec2(${(0.5 / SIZE[0]).toFixed(7)}, ${(0.5 / SIZE[1]).toFixed(7)});
  float s = 0.25 * (texture2D(uFarShadow, uv + h).r + texture2D(uFarShadow, uv - h).r + texture2D(uFarShadow, uv + vec2(h.x, -h.y)).r + texture2D(uFarShadow, uv + vec2(-h.x, h.y)).r);
  if (uFarShadowNear.z > 0.0) s *= smoothstep(0.88, 1.0, length(en - uFarShadowNear.xy) / uFarShadowNear.z);
  return s * uFarShadowK;
}`;

export function bindFarShadow(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, farShadowUniforms);
}

/** What casts: the buildings and tanks, the pads' model (each a group placed in the world). */
export const farShadowCasters: THREE.Object3D[] = [];

const target = new THREE.WebGLRenderTarget(SIZE[0], SIZE[1], {
  format: THREE.RedFormat,
  type: THREE.UnsignedByteType,
  minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter,
  generateMipmaps: true,
  depthBuffer: false,
  // (Each texel the share of it in shadow, from four points in it. With one, a mast's shadow,
  // narrower than a texel, fell on some texels' middles and missed others': a row of dots; a
  // tower's lattice was specks, and every edge a staircase.)
  samples: 4,
});
const camera = new THREE.OrthographicCamera(-RECT.w / 2, RECT.w / 2, RECT.h / 2, -RECT.h / 2, 1, 4000);
const flat = new THREE.ShaderMaterial({
  uniforms: { uSlide: { value: new THREE.Vector2() }, uGround: { value: 0 } },
  vertexShader: /* glsl */ `
    uniform vec2 uSlide;
    uniform float uGround;
    void main() {
      mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
      m = m * instanceMatrix;
      #endif
      vec4 wp = m * vec4(position, 1.0);
      // (Each thing a third of a metre stouter: a floodlight mast is under half a texel wide, and
      // its shadow, a real one a dark line across the concrete, came out a faint smear.)
      vec3 out3 = mat3(m) * normal;
      float ol = length(out3);
      if (ol > 1e-5) wp.xyz += out3 * (0.35 / ol);
      // (Down the sun's rays to the ground: where this point's shadow falls.)
      wp.xz -= uSlide * max(wp.y - uGround, 0.0);
      wp.y = uGround;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
});

let drawnKey = NaN;
let drawnAt = -Infinity;
let drawnCasters = 0;
const prevColor = new THREE.Color();

/**
 * Each frame. sunDir: toward the sun (world); cam: the camera (world, float64); strength: the
 * sun's light now, 0..1 (night, overcast); near: where the shadow map has the ground (world x, z
 * and radius; null: nowhere); key: changes when a tower moves, or one of `extra` does: what else
 * casts just now (vehicles standing on the ground or near it).
 */
export function updateFarShadows(
  renderer: THREE.WebGLRenderer,
  sunDir: THREE.Vector3,
  cam: V3,
  strength: number,
  near: { x: number; z: number; r: number } | null,
  key: number,
  now: number,
  extra: readonly THREE.Object3D[] = [],
): void {
  const u = farShadowUniforms;
  // (No shadows to speak of with the sun on the horizon: they run for km, off the map.)
  const k = DEPTH * strength * THREE.MathUtils.smoothstep(sunDir.y, 0.1, 0.22);
  u.uFarShadowK.value = k;
  if (near) u.uFarShadowNear.value.set(near.x, -near.z, near.r);
  else u.uFarShadowNear.value.set(0, 0, 0);
  const casters = extra.length ? [...farShadowCasters, ...extra] : farShadowCasters;
  if (k <= 0 || !casters.length) return;
  // Drawn again once the sun's moved a little (a quarter of a degree: a tower's shadow tip by
  // under a metre), a tower has, or something new casts; a second apart at the least.
  const full = key * 31 + Math.round(Math.atan2(sunDir.z, sunDir.x) * 230) * 7 + Math.round(Math.asin(sunDir.y) * 230);
  if ((full === drawnKey && drawnCasters === casters.length) || now - drawnAt < 1000) return;
  drawnKey = full;
  drawnAt = now;
  drawnCasters = casters.length;

  flat.uniforms.uSlide.value.set(sunDir.x / sunDir.y, sunDir.z / sunDir.y);
  flat.uniforms.uGround.value = GROUND - cam[1];
  // From straight above the map's middle, north up (camera-relative, as the world is).
  const cx = RECT.e0 + RECT.w / 2 - cam[0];
  const cz = -(RECT.n0 + RECT.h / 2) - cam[2];
  camera.position.set(cx, GROUND - cam[1] + 2000, cz);
  camera.up.set(0, 0, -1);
  camera.lookAt(cx, GROUND - cam[1], cz);
  camera.updateMatrixWorld();

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevShadows = renderer.shadowMap.enabled;
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  for (const root of casters) {
    // (Shown for this, whatever the far-off culling has done with it; every caster in its own
    // material's place.)
    const hidden: THREE.Object3D[] = [];
    const saved: [THREE.Mesh, THREE.Material | THREE.Material[], boolean][] = [];
    const others: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = root; o; o = o.parent) {
      if (!o.visible) {
        o.visible = true;
        hidden.push(o);
      }
    }
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      // (Lamps' glows, lines: not in this.)
      if (!m.isMesh) {
        const r = o as { isSprite?: boolean; isLine?: boolean; isPoints?: boolean };
        if ((r.isSprite || r.isLine || r.isPoints) && o.visible) {
          o.visible = false;
          others.push(o);
        }
        return;
      }
      saved.push([m, m.material, m.frustumCulled]);
      if (m.castShadow) {
        m.material = flat;
        m.frustumCulled = false;
      } else m.material = HIDE;
    });
    root.updateMatrixWorld(true);
    renderer.render(root, camera);
    for (const [m, mat, cull] of saved) {
      m.material = mat;
      m.frustumCulled = cull;
    }
    for (const o of others) o.visible = true;
    for (const o of hidden) o.visible = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.enabled = prevShadows;
  renderer.setClearColor(prevColor, prevAlpha);
  u.uFarShadow.value = target.texture;
}

/** For what casts nothing: drawn, but into no channel. */
const HIDE = new THREE.MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false });
