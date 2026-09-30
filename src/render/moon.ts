// The Moon: a true-scale sphere (radius 1,737 km) at its mean distance (384,400 km), with NASA's
// LRO colour map (CGI Moon Kit, public domain) and the near side turned toward the Earth. It's
// lit by the sun whatever the time of day at the pad (so its phase shows), seen in the sky and on
// the map, where its orbit is drawn too. At night it lights the ground a little, by its phase and
// height in the sky. (It's only drawn: the sim's physics has no lunar gravity.)
//
// Where it is: the sim's sun sits at a fixed place among the stars (stars.ts), so the Moon is
// placed from it by elongation, taken from the real Moon's phase today (days since a known new
// moon) and running on with sim time, 5.1 deg off the ecliptic by its (regressing) node.

import * as THREE from 'three';
import type { V3 } from '../sim/math';
import type { FloatingOrigin } from './floatingOrigin';
import { toFxLayer } from './atmosphere';
import { ecefToWorld } from './geo';

export const MOON_RADIUS = 1.7374e6;
export const MOON_DISTANCE = 3.844e8;
const SYNODIC_DAYS = 29.530588853;
/** A new moon: 2000 Jan 6, 18:14 UTC (Julian date). */
const NEW_MOON_JD = 2451550.26;
const J2000 = 2451545.0;
/** How far from the camera the halo is drawn, m. */
const HALO_AT = 3e7;
const OBLIQUITY = 23.44 * (Math.PI / 180);
const INCLINATION = 5.145 * (Math.PI / 180);

const EARTH_CENTER = ecefToWorld([0, 0, 0]);
/** Julian date when the page loaded (sim time runs on from it). */
const JD0 = Date.now() / 86400000 + 2440587.5;

const vertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSun;
  uniform float uBoost;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float mu0 = max(dot(n, uSun), 0.0);
    float mu = max(dot(n, normalize(vView)), 0.0);
    // Lommel-Seeliger (dusty regolith): the full moon is evenly bright to its edge, not a
    // Lambertian ball. A trace of earthshine on the night side.
    float lit = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu + 1e-4) : 0.0;
    vec3 albedo = texture2D(uMap, vUv).rgb;
    gl_FragColor = vec4(albedo * (lit * 1.25 * uBoost + 0.006), 1.0);
  }
`;

export class Moon {
  readonly mesh: THREE.Mesh;
  /** The glow round it in the night air (a few degrees across). */
  readonly halo: THREE.Sprite;
  /** Faint moonlight at night (none by day, or with the Moon down or new). */
  readonly light = new THREE.DirectionalLight(0xbfcbe6, 0);
  /** World position of the Moon's centre, m (float64). */
  readonly world: V3 = [0, 0, 0];
  /** Unit vector from the Earth's centre toward the Moon (world axes). */
  readonly dir = new THREE.Vector3(1, 0, 0);
  /** Unit normal of its orbit's plane (world axes), for the map. */
  readonly orbitNormal = new THREE.Vector3(0, 1, 0);
  /** Fraction of the disc lit, 0 (new) .. 1 (full). */
  illuminated = 0.5;
  /** Growing toward full (else shrinking toward new). */
  waxing = true;
  private uniforms = { uMap: { value: null as THREE.Texture | null }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uBoost: { value: 1 } };
  private basis = new THREE.Matrix4();
  private inv = new THREE.Quaternion();

  constructor() {
    const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 96, 48), mat);
    this.mesh.name = 'Moon';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}globe/moon.jpg`).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.uniforms.uMap.value = tex;
      this.mesh.visible = true;
    });
    this.light.castShadow = false;

    // Radial falloff, drawn once.
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.12, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.08)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color: 0xdfe6f5, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }),
    );
    this.halo.frustumCulled = false;
    toFxLayer(this.halo);
  }

  /** Ecliptic longitude / latitude -> equatorial unit vector. */
  private static eq(lambda: number, beta: number, out: THREE.Vector3): THREE.Vector3 {
    const x = Math.cos(beta) * Math.cos(lambda);
    const y = Math.cos(beta) * Math.sin(lambda);
    const z = Math.sin(beta);
    return out.set(x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY));
  }

  /**
   * Per frame. simTime: s; sky: equatorial -> world rotation (the star sky's, turning with the
   * day); sunDir: world unit vector to the sun; padUp: the pad's local vertical (world); dark: how
   * dark it is at the ground (0 day .. 1 night).
   */
  update(simTime: number, sky: THREE.Quaternion, sunDir: THREE.Vector3, origin: FloatingOrigin, padUp: THREE.Vector3, dark: number): void {
    const jd = JD0 + simTime / 86400;
    // The sun's ecliptic longitude, from its place in the (equatorial) sky.
    const s = sunDir.clone().applyQuaternion(this.inv.copy(sky).invert());
    const lambdaSun = Math.atan2(s.y * Math.cos(OBLIQUITY) + s.z * Math.sin(OBLIQUITY), s.x);
    const elong = 2 * Math.PI * ((((jd - NEW_MOON_JD) / SYNODIC_DAYS) % 1) + 1);
    const node = (125.04 - 0.0529539 * (jd - J2000)) * (Math.PI / 180);
    const at = (e: number, out: THREE.Vector3) => {
      const lambda = lambdaSun + e;
      return Moon.eq(lambda, INCLINATION * Math.sin(lambda - node), out).applyQuaternion(sky);
    };
    at(elong, this.dir);
    const ahead = at(elong + 0.01, new THREE.Vector3());
    this.orbitNormal.crossVectors(this.dir, ahead).normalize();
    this.illuminated = (1 - Math.cos(elong)) / 2;
    this.waxing = elong % (2 * Math.PI) < Math.PI;

    for (let i = 0; i < 3; i++) this.world[i] = EARTH_CENTER[i] + this.dir.getComponent(i) * MOON_DISTANCE;
    origin.place(this.mesh, this.world);
    const cam = origin.camera;
    // The halo: on the line from the camera to the Moon, nearer (its scale stays in float range).
    const toMoon = new THREE.Vector3(this.world[0] - cam[0], this.world[1] - cam[1], this.world[2] - cam[2]).normalize();
    this.halo.position.copy(toMoon).multiplyScalar(HALO_AT);
    this.halo.scale.setScalar(HALO_AT * 0.12);
    // Tidally locked: the near side (the map's centre, local +x) toward the Earth, north up.
    const x = this.dir.clone().negate();
    const north = new THREE.Vector3(0, 0, 1).applyQuaternion(sky);
    const y = north.addScaledVector(x, -north.dot(x)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    this.mesh.quaternion.setFromRotationMatrix(this.basis.makeBasis(x, y, z));
    this.uniforms.uSun.value.copy(sunDir);
    // Against a night sky it's dazzling (the eye adapted to the dark): bright enough to glow.
    this.uniforms.uBoost.value = 1 + 3 * dark;

    // Moonlight: a full moon high up is enough to see by; a crescent, or one low down, barely.
    const up = this.dir.dot(padUp);
    const risen = THREE.MathUtils.smoothstep(up, -0.02, 0.15);
    this.light.intensity = 0.22 * dark * this.illuminated ** 1.5 * risen;
    // (The halo is the air's: none seen from high up, or out on the map.)
    const alt = Math.hypot(cam[0] - EARTH_CENTER[0], cam[1] - EARTH_CENTER[1], cam[2] - EARTH_CENTER[2]) - 6.371e6;
    const inAir = 1 - THREE.MathUtils.smoothstep(alt, 15000, 40000);
    (this.halo.material as THREE.SpriteMaterial).opacity = 0.5 * dark * this.illuminated ** 1.5 * risen * inAir;
    this.halo.visible = this.halo.material.opacity > 0.002;
    this.light.position.copy(this.dir);
    this.light.target.position.set(0, 0, 0);
    this.light.updateMatrixWorld();
    this.light.target.updateMatrixWorld();
  }
}

/** The phase's everyday name: new, waxing crescent, first quarter, ... */
export function phaseName(illuminated: number, waxing: boolean): string {
  if (illuminated < 0.03) return 'New moon';
  if (illuminated > 0.97) return 'Full moon';
  if (Math.abs(illuminated - 0.5) < 0.06) return waxing ? 'First quarter' : 'Last quarter';
  return `${waxing ? 'Waxing' : 'Waning'} ${illuminated < 0.5 ? 'crescent' : 'gibbous'}`;
}
