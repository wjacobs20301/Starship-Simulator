// A mission's landing target in the world: a tall glowing beacon standing on the water with a
// pulsing ring around its foot, so it can be seen (and steered for) from far off. It grows with
// distance so it never shrinks to nothing.

import * as THREE from 'three';
import type { V3 } from '../sim/math';
import { toFxLayer } from './atmosphere';
import type { FloatingOrigin } from './floatingOrigin';
import { ecefToWorld, toWorld } from './geo';

const BEAM_HEIGHT = 3000;
const EARTH_CENTER = ecefToWorld([0, 0, 0]);

const beamVertex = /* glsl */ `
  varying float vH;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vH = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vH;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    float core = pow(abs(dot(normalize(vN), normalize(vView))), 1.5);
    float fade = pow(1.0 - vH, 1.6);
    float pulse = 0.75 + 0.25 * sin(uTime * 3.0 - vH * 18.0);
    float a = core * fade * pulse;
    gl_FragColor = vec4(uColor * a * 2.2, a);
  }
`;
const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    // vUv.x: 0 at the inner edge, 1 at the outer. A steady ring and a wave running outward.
    float r = vUv.x;
    float ring = smoothstep(0.0, 0.08, r) * (1.0 - smoothstep(0.1, 0.2, r));
    float w = fract(uTime * 0.35);
    float wave = (1.0 - smoothstep(0.0, 0.05, abs(r - w))) * (1.0 - w);
    float a = ring + wave * 0.8;
    gl_FragColor = vec4(uColor * a * 2.0, a);
  }
`;
const ringVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class TargetMarker {
  readonly group = new THREE.Group();
  private world: V3 | null = null;
  private uniforms = { uColor: { value: new THREE.Color(0.3, 0.85, 1.0) }, uTime: { value: 0 } };

  constructor() {
    const common = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;
    const beamGeo = new THREE.CylinderGeometry(14, 14, BEAM_HEIGHT, 24, 1, true);
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({ vertexShader: beamVertex, fragmentShader: beamFragment, uniforms: this.uniforms, side: THREE.DoubleSide, ...common }));
    // Ring: a flat annulus 0..600 m (uv.x along the radius), the steady band near its inside.
    const ringGeo = new THREE.RingGeometry(120, 600, 96, 1);
    const uv = ringGeo.attributes.uv as THREE.BufferAttribute;
    const pos = ringGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - 120) / 480, 0);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.translate(0, 2, 0);
    const ring = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({ vertexShader: ringVertex, fragmentShader: ringFragment, uniforms: this.uniforms, side: THREE.DoubleSide, ...common }));
    for (const m of [beam, ring]) m.frustumCulled = false;
    this.group.add(beam, ring);
    toFxLayer(this.group);
    this.group.visible = false;
  }

  /** Show the target at lat / lon (deg), or hide it (null). */
  set(target: { lat: number; lon: number } | null): void {
    this.world = target ? toWorld(target.lat, target.lon, 0) : null;
    this.group.visible = !!target;
    if (this.world) {
      // Stand it up along the local vertical there (the Earth curves away from the pad).
      const up = new THREE.Vector3(this.world[0] - EARTH_CENTER[0], this.world[1] - EARTH_CENTER[1], this.world[2] - EARTH_CENTER[2]).normalize();
      this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    }
  }

  update(origin: FloatingOrigin, time: number): void {
    if (!this.world) return;
    origin.place(this.group, this.world);
    this.uniforms.uTime.value = time;
    // Its real size up close; from farther off it grows, so it stays a clear mark on the water
    // from 100+ km up.
    this.group.scale.setScalar(Math.max(1, this.group.position.length() / 8000));
  }
}
