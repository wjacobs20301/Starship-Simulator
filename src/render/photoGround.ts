// Ground drawn with an aerial photograph (the terrain, the launch site's slab) is drawn with
// light that is already in the picture: the photo was taken in sunlight under an open sky. Lit
// again by the whole sky here, it came out twice as sky-lit as anything else: warm sand and
// concrete turned a flat bluish white from any low camera (measured: sand the photo has at
// 192, 184, 168 drawn 194, 195, 195, and 165, 156, 139 with no sky light at all).
//
// So such ground takes only part of the sky's light (the sun's in full: that is what gives it
// its shadows and its time of day).

import type * as THREE from 'three';

/** The share of the sky's light that photographed ground takes. */
const PHOTO_SKY = 0.45;

/** For a photographed ground's material, in its onBeforeCompile: the sky's light on it turned down. */
export function photoLit(shader: { fragmentShader: string } & Pick<THREE.WebGLProgramParametersWithUniforms, 'uniforms'>): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_maps>',
    `#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectDiffuse )
  iblIrradiance *= ${PHOTO_SKY.toFixed(2)};
#endif`,
  );
}
