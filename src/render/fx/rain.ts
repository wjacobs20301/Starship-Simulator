// Rain: streaks falling through a box of air around the camera. Each drop's place is fixed in
// the world (the box wraps round the camera as it moves), so flying through the rain streams it
// past; the streaks slant with the wind and stretch with the fall (a camera's exposure).

import * as THREE from 'three';
import { toFxLayer } from '../atmosphere';

const COUNT = 9000;
const BOX = 44;
const FALL = new THREE.Vector3(-1.8, -9, 1.2); // m/s: down, with the sea breeze

const vertex = /* glsl */ `
  attribute vec4 aDrop; // position in the box (0..1)^3, and 0 = head / 1 = tail
  uniform float uTime;
  uniform vec3 uCamera;   // camera world position mod BOX
  uniform vec3 uFall;
  uniform float uStreak;
  varying float vTail;
  void main() {
    vec3 p = mod(aDrop.xyz * ${BOX}.0 + uFall * uTime - uCamera, ${BOX}.0) - ${BOX / 2}.0;
    p -= uFall * uStreak * aDrop.w;
    vTail = aDrop.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform float uRain;
  uniform vec3 uColor;
  varying float vTail;
  void main() {
    float a = uRain * 0.5 * (1.0 - 0.75 * vTail);
    gl_FragColor = vec4(uColor, a);
  }
`;

export class Rain {
  readonly lines: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const drops = new Float32Array(COUNT * 2 * 4);
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      drops.set([x, y, z, 0, x, y, z, 1], i * 8);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
    g.setAttribute('aDrop', new THREE.BufferAttribute(drops, 4));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uFall: { value: FALL.clone() },
        uStreak: { value: 0.09 },
        uRain: { value: 0 },
        uColor: { value: new THREE.Color(0.84, 0.87, 0.92) },
      },
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    toFxLayer(this.lines);
  }

  /**
   * amount: 0..1; cam: camera world position (float64); up: local vertical there; time: s
   * (real time: rain keeps falling at any time warp, and freezes only when paused).
   */
  update(amount: number, cam: readonly number[], up: THREE.Vector3, time: number): void {
    this.lines.visible = amount > 0.01;
    if (!this.lines.visible) return;
    const u = this.mat.uniforms;
    u.uRain.value = amount;
    u.uTime.value = time;
    (u.uCamera.value as THREE.Vector3).set(cam[0] % BOX, cam[1] % BOX, cam[2] % BOX);
    // (The camera sits at the floating origin: the box is drawn around 0.)
    this.lines.position.set(0, 0, 0);
    this.lines.quaternion.setFromUnitVectors(this.up, up);
  }
}
