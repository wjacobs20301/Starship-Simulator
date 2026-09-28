// Reentry plasma: a glowing sheath hugging the vehicle, brightest where the air hits (the heat
// shield in a belly-first entry, the engines on a returning booster), and a long faint wake
// streaming behind. Both scale with the simulated stagnation heating, so the glow builds from
// ~80 km, peaks with the heating and fades as the vehicle slows.

import * as THREE from 'three';

const sheathVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vLocalN;
  void main() {
    vLocalN = normalize(normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const sheathFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uIntensity;
  uniform vec3 uMotion;   // direction of travel through the air, mesh-local
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vLocalN;
  void main() {
    #include <logdepthbuf_fragment>
    float windward = max(0.0, dot(vLocalN, uMotion));
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vView)));
    float flicker = 0.85 + 0.15 * sin(uTime * 23.0 + vLocalN.y * 40.0) * sin(uTime * 17.0 + vLocalN.x * 31.0);
    float g = uIntensity * flicker * (pow(windward, 2.5) * 0.55 + pow(rim, 3.0) * 0.12 * windward);
    // Pinkish-orange (hot air: N2 / O emission) where the flow hits, deeper orange-red elsewhere.
    vec3 col = mix(vec3(1.0, 0.35, 0.12), vec3(1.0, 0.45, 0.65), windward);
    gl_FragColor = vec4(col * 2.0, clamp(g, 0.0, 1.0));
  }
`;

const wakeVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vS = -position.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const wakeFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uIntensity;
  uniform float uTime;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    #include <logdepthbuf_fragment>
    float facing = abs(dot(normalize(vN), normalize(vView)));
    float along = exp(-vS * 4.5);
    float flicker = 0.8 + 0.2 * sin(uTime * 13.0 - vS * 30.0);
    float a = uIntensity * along * pow(facing, 2.0) * flicker * 0.18;
    vec3 col = mix(vec3(1.0, 0.3, 0.15), vec3(1.0, 0.5, 0.7), along);
    gl_FragColor = vec4(col * 1.6, clamp(a, 0.0, 1.0));
  }
`;

/** Visible glow vs heat flux (W/m^2): starts at a couple of W/cm^2, full by ~25 W/cm^2. */
export function plasmaIntensity(heatFlux: number): number {
  const t = THREE.MathUtils.clamp((heatFlux - 2e4) / 2.3e5, 0, 1);
  return t * t * (3 - 2 * t);
}

export class Plasma {
  readonly group = new THREE.Group();
  private sheathMat: THREE.ShaderMaterial;
  private wakeMat: THREE.ShaderMaterial;
  private wake: THREE.Mesh;
  private center: THREE.Vector3;
  private down = new THREE.Vector3(0, -1, 0);

  /** yLo..yHi: the vehicle's extent along the mesh-local axis. */
  constructor(yLo: number, yHi: number, radius = 4.5) {
    const length = yHi - yLo;
    this.center = new THREE.Vector3(0, (yLo + yHi) / 2, 0);
    const uniforms = { uIntensity: { value: 0 }, uMotion: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 } };
    const common = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
    this.sheathMat = new THREE.ShaderMaterial({ vertexShader: sheathVertex, fragmentShader: sheathFragment, uniforms, ...common });
    const sheath = new THREE.Mesh(new THREE.CapsuleGeometry(radius + 1.4, length, 8, 32), this.sheathMat);
    sheath.position.copy(this.center);
    sheath.frustumCulled = false;

    this.wakeMat = new THREE.ShaderMaterial({
      vertexShader: wakeVertex,
      fragmentShader: wakeFragment,
      uniforms: { uIntensity: uniforms.uIntensity, uTime: uniforms.uTime },
      ...common,
      side: THREE.DoubleSide,
    });
    // Unit-length cone hanging down from y = 0, widening a little downstream.
    const wakeGeo = new THREE.CylinderGeometry(radius + 0.5, radius + 6, 1, 32, 16, true);
    wakeGeo.translate(0, -0.5, 0);
    this.wake = new THREE.Mesh(wakeGeo, this.wakeMat);
    this.wake.frustumCulled = false;
    this.wake.position.copy(this.center);
    this.group.add(sheath, this.wake);
    this.group.visible = false;
  }

  /**
   * heatFlux: W/m^2; motionLocal: unit direction of travel through the air in mesh-local axes.
   * Returns the glow intensity (0..1) so other effects (tiles) can follow it.
   */
  update(heatFlux: number, motionLocal: THREE.Vector3, time: number): number {
    const i = plasmaIntensity(heatFlux);
    this.group.visible = i > 0.001;
    if (!this.group.visible) return 0;
    const u = this.sheathMat.uniforms;
    u.uIntensity.value = i;
    u.uMotion.value.copy(motionLocal);
    u.uTime.value = time;
    // The wake streams opposite the motion, from the middle of the vehicle.
    this.wake.quaternion.setFromUnitVectors(this.down, motionLocal.clone().negate());
    this.wake.scale.set(1, 80 + 700 * i, 1);
    return i;
  }
}
