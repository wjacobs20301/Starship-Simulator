// Methalox exhaust for one stage: per-engine bright cores (driven by each engine's throttle, so
// engine-outs and hot staging read correctly) plus a cluster plume whose radius is fixed at the
// nozzles and only expands downstream as the ambient pressure drops: a tight, bright column with
// shock diamonds at sea level, a huge faint blue-violet bell in near-vacuum. `glowPower` drives
// the shared plume lights (launchFx.ts) that throw the exhaust's orange glow on the surroundings.

import * as THREE from 'three';
import { P0 } from '../../sim/constants';
import type { StageDef } from '../../sim/vehicle';

const vertexCommon = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uLength;
  uniform float uR0;
  uniform float uExpand;
  uniform float uTime;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
`;

// The geometry is a unit open cylinder: y in [0, -1] (nozzle -> tail), radius 1.
const clusterVertex = /* glsl */ `${vertexCommon}
  void main() {
    float s = -position.y;
    vS = s;
    float flicker = 1.0 + 0.04 * sin(uTime * 37.0 + s * 23.0) + 0.03 * sin(uTime * 61.0 - s * 41.0);
    float r = uR0 * (1.0 + uExpand * pow(s, 0.55)) * flicker;
    vec3 p = vec3(position.x * r, -s * uLength, position.z * r);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * normalize(vec3(position.x, 0.15 * uExpand, position.z)));
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const clusterFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uIntensity;
  uniform float uVacuum;
  uniform float uLength;
  uniform float uTime;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    #include <logdepthbuf_fragment>
    float s = vS;
    float rim = pow(abs(dot(normalize(vN), normalize(vView))), 1.4);
    // Brightness falls off downstream; much faster (and fainter) in vacuum.
    float core = exp(-s * mix(2.2, 3.5, uVacuum));
    // Shock diamonds: a few bright bands near the nozzle, only in dense air.
    float spacing = 9.0 / uLength;
    float diamonds = (1.0 - uVacuum) * pow(0.5 + 0.5 * cos(6.2832 * s / spacing), 10.0) * exp(-s * 5.0);
    vec3 hot = mix(vec3(1.0, 0.86, 0.6), vec3(0.8, 0.8, 1.0), uVacuum);
    vec3 flame = mix(vec3(1.0, 0.42, 0.1), vec3(0.45, 0.4, 1.0), uVacuum);
    vec3 col = mix(flame, hot, core * core) * (1.0 + 2.5 * diamonds);
    float a = uIntensity * rim * mix(0.22 + 0.78 * core, 0.03 + 0.5 * core, uVacuum) * (1.0 - 0.8 * uVacuum) * smoothstep(1.0, 0.65, s);
    // Additive: HDR colour so the bloom pass picks it up.
    gl_FragColor = vec4(col * (1.1 + 2.2 * core), clamp(a, 0.0, 1.0));
  }
`;

// Per-engine cores: short, very bright cones, instanced, with a per-instance throttle.
const coreVertex = /* glsl */ `${vertexCommon}
  attribute float aThrottle;
  varying float vThrottle;
  void main() {
    float s = -position.y;
    vS = s;
    vThrottle = aThrottle;
    float r = uR0 * (1.0 - 0.55 * s) * (1.0 + uExpand * 0.15 * s);
    vec3 p = vec3(position.x * r, -s * uLength, position.z * r);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * mat3(instanceMatrix) * vec3(position.x, 0.0, position.z));
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const coreFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uVacuum;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  varying float vThrottle;
  void main() {
    #include <logdepthbuf_fragment>
    if (vThrottle < 0.02) discard;
    float rim = pow(abs(dot(normalize(vN), normalize(vView))), 1.2);
    float fade = exp(-vS * 3.0);
    vec3 col = mix(vec3(1.0, 0.95, 0.85), vec3(0.8, 0.8, 1.0), uVacuum);
    float a = vThrottle * rim * fade * (1.0 - 0.6 * uVacuum);
    gl_FragColor = vec4(col * 5.0, clamp(a, 0.0, 1.0));
  }
`;

function unitCylinder(radial: number, lengthSegs: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, radial, lengthSegs, true);
  g.translate(0, -0.5, 0);
  return g;
}

export class Plume {
  readonly group = new THREE.Group();
  /** Where the glow comes from (group-local) and how bright it is (candela-ish). */
  readonly glowPoint = new THREE.Vector3();
  glowPower = 0;
  private cluster: THREE.Mesh;
  private cores: THREE.InstancedMesh;
  private throttleAttr: THREE.InstancedBufferAttribute;
  private clusterMat: THREE.ShaderMaterial;
  private coreMat: THREE.ShaderMaterial;
  private clusterRadius: number;

  /**
   * @param def stage definition (engine layout from the sim config)
   * @param exitY mesh-local y of the cluster's nozzle exit plane
   */
  constructor(def: StageDef, exitY: number) {
    this.clusterRadius = Math.max(...def.engines.map((e) => Math.hypot(e.pos[1], e.pos[2]) + Math.sqrt(e.type.exitArea / Math.PI)));
    const shared = { uTime: { value: 0 }, uVacuum: { value: 0 } };
    this.clusterMat = new THREE.ShaderMaterial({
      vertexShader: clusterVertex,
      fragmentShader: clusterFragment,
      uniforms: { ...shared, uIntensity: { value: 0 }, uLength: { value: 100 }, uR0: { value: this.clusterRadius }, uExpand: { value: 0.5 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.clusterMat.uniforms.uTime = shared.uTime;
    this.clusterMat.uniforms.uVacuum = shared.uVacuum;
    this.cluster = new THREE.Mesh(unitCylinder(48, 64), this.clusterMat);
    this.cluster.frustumCulled = false;
    this.cluster.position.y = exitY;

    this.coreMat = new THREE.ShaderMaterial({
      vertexShader: coreVertex,
      fragmentShader: coreFragment,
      uniforms: { uTime: shared.uTime, uVacuum: shared.uVacuum, uLength: { value: 8 }, uR0: { value: 0.6 }, uExpand: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const coreGeo = unitCylinder(16, 8);
    this.throttleAttr = new THREE.InstancedBufferAttribute(new Float32Array(def.engines.length), 1);
    coreGeo.setAttribute('aThrottle', this.throttleAttr);
    this.cores = new THREE.InstancedMesh(coreGeo, this.coreMat, def.engines.length);
    this.cores.frustumCulled = false;
    const m = new THREE.Matrix4();
    def.engines.forEach((e, i) => {
      // Body (x, y, z) -> mesh (y, x, -z); the core starts at this engine's nozzle exit.
      const exitX = e.pos[0] - e.type.length;
      const r = Math.sqrt(e.type.exitArea / Math.PI);
      m.makeScale(r / 0.6, 1, r / 0.6).setPosition(e.pos[1], exitX, -e.pos[2]);
      this.cores.setMatrixAt(i, m);
    });

    this.glowPoint.set(0, exitY - 15, 0);
    this.group.add(this.cluster, this.cores);
  }

  /** throttles: per engine 0..1; pAmb: ambient pressure (Pa); time: seconds (animation). */
  update(throttles: number[], pAmb: number, time: number): void {
    const n = throttles.length;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < n; i++) {
      const t = throttles[i] > 0.02 ? throttles[i] : 0;
      this.throttleAttr.setX(i, t);
      sum += t;
      if (t > 0) lit++;
    }
    this.throttleAttr.needsUpdate = true;
    const on = lit > 0;
    this.group.visible = on;
    if (!on) {
      this.glowPower = 0;
      return;
    }
    const vac = 1 - Math.min(1, pAmb / P0);
    const frac = lit / n;
    const mean = sum / lit;
    const u = this.clusterMat.uniforms;
    u.uTime.value = time;
    u.uVacuum.value = vac;
    u.uIntensity.value = Math.min(1, 0.35 + 0.65 * mean);
    // Few engines lit: a narrower column (area scales with the number of engines).
    u.uR0.value = 1.1 * this.clusterRadius * Math.max(0.35, Math.sqrt(frac));
    u.uLength.value = (150 + 220 * vac * vac) * (0.55 + 0.45 * mean) * (0.6 + 0.4 * Math.sqrt(frac));
    u.uExpand.value = 0.6 + 5 * vac ** 1.6;
    const cu = this.coreMat.uniforms;
    cu.uLength.value = 7 + 25 * vac;
    cu.uExpand.value = vac * 3;
    // Glow on the surroundings (33 engines at full throttle ~ 13000 cd: about sunlight at 50 m).
    this.glowPower = 400 * sum * (1 - 0.9 * vac);
  }
}
