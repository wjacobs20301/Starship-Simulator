// Lamplight on the ground at Starbase by night: the pools under the yard lamps and street lights
// (yardLights.ts), as a map of the two sites that the ground's materials read (the terrain, the
// launch site's slab, the buildings' walls near their feet). A map, not lights: there are
// hundreds of lamps, and a light in the scene costs every material a term.

import * as THREE from 'three';

const dark = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
dark.needsUpdate = true;

export const siteLightUniforms = {
  uSiteLight: { value: dark as THREE.Texture },
  /** Pad east / north of the map's south-west corner, 1 / its size. */
  uSiteLightRect: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** How strong: 0 by day (padLights.ts sets it with the night). */
  uSiteLightK: { value: 0 },
};

/** For a fragment shader: siteLight(en), the lamplight (warm white) at pad east / north en. */
export const SITE_LIGHT_GLSL = /* glsl */ `
uniform sampler2D uSiteLight;
uniform vec4 uSiteLightRect;
uniform float uSiteLightK;
vec3 siteLight(vec2 en) {
  if (uSiteLightK <= 0.0) return vec3(0.0);
  vec2 uv = (en - uSiteLightRect.xy) * uSiteLightRect.zw;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec3(0.0);
  return vec3(1.0, 0.8, 0.52) * texture2D(uSiteLight, uv).r * uSiteLightK;
}`;
