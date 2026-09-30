// The pads at night, as in SpaceX's own photos of a stack at dusk: warm floodlights on the launch
// tower itself (on the corners that see the rocket), a ring of lights round the launch table
// shining up the booster, and red obstruction lights (a flashing beacon on the mast on top,
// steady red down the corners). Real light (a few spotlights, no shadows) falls only on Pad 1's
// stack, where the launches are: from three of its tower's floods. Every lamp,
// near or far, is also a glowing point that stays visible from kilometres away (floods brightest
// looking into them; the beacon flashes ~30 a minute).
//
// The spotlights stay in the scene by day at zero intensity: switching them on and off would
// change the light count, and recompile every material mid-flight.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD, PAD2 } from '../sim/constants';
import { toFxLayer } from './atmosphere';
import { buildingUniforms } from './facilities';
import { TRENCHES } from './launchSite';

/** The towers' lattice: centre to corner, m (a corner toward the mount; measured on the pad model). */
const TOWER_CORNER = 8.4;
/** Top of the towers' lattice in the pad model, m. */
const TOWER_TOP = 148.9;
/** Heights of the floodlights on the tower corners, m. */
const FLOOD_LEVELS = [30, 56, 84, 112];
/** The launch table's ring of lights: radius round the booster, m, and how many. */
const RING_R = 7.3;
const RING_COUNT = 12;
/** The lightning / beacon mast on the tower top, m. */
const MAST = 10;
/** How brightly the floodlights light the stack (the sun is 2.6), each set for its distance. */
const SPOT_LIGHTING = 1.6;

/** Warm floodlight white (the photos show the booster lit gold). */
const LAMP_COLOR = new THREE.Color(1.0, 0.8, 0.52);
const RED = new THREE.Color(1.0, 0.08, 0.04);

interface PadSpec {
  /** Mount (east, north), pad-local m. */
  mount: [number, number];
  tower: { e: number; n: number };
  /** Real spotlights: which tower corner (0 facing the mount, 1 / 3 beside it) and height. */
  spots: { corner: number; h: number }[];
}

const PADS: PadSpec[] = [
  { mount: TRENCHES[0].center, tower: PAD.tower, spots: [{ corner: 0, h: 30 }, { corner: 1, h: 56 }, { corner: 3, h: 84 }] },
  { mount: TRENCHES[1].center, tower: PAD2.tower, spots: [] },
];

const glowVertex = /* glsl */ `
  #include <common>
  attribute vec3 color;
  attribute float size;
  attribute vec3 aim;
  attribute float blink;
  uniform float uNight;
  uniform float uTime;
  uniform float uScale;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 1.0);
    // Size on screen: the lamp's own, but never under ~3 px (seen from afar, dimmer).
    float px = size * uScale / dist;
    float minPx = 3.0 * uPixelRatio;
    gl_PointSize = clamp(px, minPx, 90.0 * uPixelRatio);
    float far = clamp(pow(px / minPx, 0.5), 0.5, 1.0);
    // Floodlights: bright looking into them, dim from behind (aim = 0: all round).
    vec3 toCam = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
    float facing = dot(aim, aim) > 0.5 ? 0.15 + 0.85 * smoothstep(-0.3, 0.7, dot(toCam, aim)) : 1.0;
    // Flashing beacons: ~30 flashes a minute, all together (a quick rise, a slower fade).
    float ph = fract(uTime / 2.0);
    float flash = blink > 0.5 ? smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.25, 0.45, ph)) : 1.0;
    vColor = color * uNight * far * facing * flash;
  }
`;

const glowFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // A hot core (it blooms) and a soft halo.
    float a = exp(-r2 * 9.0) * 3.0 + 0.25 * exp(-r2 * 2.5);
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

/** Render world (x = E, y = U, z = -N). */
const w = (e: number, n: number, u: number) => new THREE.Vector3(e, u, -n);

export class PadLights {
  readonly group = new THREE.Group();
  readonly spots: THREE.SpotLight[] = [];
  private lampMat = new THREE.MeshStandardMaterial({ color: 0x3a3c3f, roughness: 0.4, metalness: 0.3, emissive: LAMP_COLOR, emissiveIntensity: 0 });
  private glowMat: THREE.ShaderMaterial;

  constructor() {
    this.group.name = 'Pad lights';
    const lamps: THREE.BufferGeometry[] = [];
    const masts: THREE.BufferGeometry[] = [];
    const glow = { pos: [] as number[], color: [] as number[], size: [] as number[], aim: [] as number[], blink: [] as number[] };
    const addGlow = (p: THREE.Vector3, c: THREE.Color, size: number, aim: THREE.Vector3 | null, blink: boolean) => {
      glow.pos.push(p.x, p.y, p.z);
      glow.color.push(c.r, c.g, c.b);
      glow.size.push(size);
      const a = aim ?? new THREE.Vector3();
      glow.aim.push(a.x, a.y, a.z);
      glow.blink.push(blink ? 1 : 0);
    };

    for (const pad of PADS) {
      const [me, mn] = pad.mount;
      // The tower's corners (0 toward the mount, then round), just outside the lattice.
      const [tc_e, tc_n] = [me + pad.tower.e, mn + pad.tower.n];
      const d = new THREE.Vector2(-pad.tower.e, -pad.tower.n).normalize();
      const corners = [0, 1, 2, 3].map((k) => {
        const a = (k * Math.PI) / 2;
        const r = TOWER_CORNER + 0.4;
        return [tc_e + r * (d.x * Math.cos(a) - d.y * Math.sin(a)), tc_n + r * (d.x * Math.sin(a) + d.y * Math.cos(a))];
      });

      // Obstruction lights: a flashing beacon on the mast on top, steady red down the corners.
      const mast = new THREE.CylinderGeometry(0.25, 0.45, MAST, 8);
      mast.translate(tc_e, TOWER_TOP + MAST / 2, -tc_n);
      masts.push(mast);
      addGlow(w(tc_e, tc_n, TOWER_TOP + MAST + 0.5), RED.clone().multiplyScalar(4), 2.6, null, true);
      for (const [ce, cn] of corners)
        for (const f of [1 / 3, 2 / 3, 1]) addGlow(w(ce, cn, TOWER_TOP * f + (f === 1 ? 0.6 : 0)), RED.clone().multiplyScalar(1.6), 1.4, null, false);

      // The launch table's ring of lights, on the deck round the booster, shining up it.
      const deck = PAD.mountHeight + 0.4;
      for (let i = 0; i < RING_COUNT; i++) {
        const a = (i / RING_COUNT) * Math.PI * 2 + 0.2;
        const p = w(me + RING_R * Math.cos(a), mn + RING_R * Math.sin(a), deck);
        const dir = w(me, mn, deck + 40).sub(p).normalize();
        const lamp = new THREE.BoxGeometry(0.8, 0.6, 0.5);
        lamp.lookAt(dir);
        lamp.translate(p.x, p.y, p.z);
        lamps.push(lamp);
        addGlow(p.clone().addScaledVector(dir, 0.5), LAMP_COLOR.clone().multiplyScalar(1.8), 1.6, dir, false);
      }

      // Floodlights on the three corners that see the rocket, aimed at the stack level with them.
      for (const k of [0, 1, 3]) {
        const [ce, cn] = corners[k];
        for (const h of FLOOD_LEVELS) {
          const p = w(ce, cn, h);
          const target = w(me, mn, h - 4);
          const dir = target.clone().sub(p).normalize();
          const lamp = new THREE.BoxGeometry(1.2, 0.9, 0.6);
          lamp.lookAt(dir);
          lamp.translate(p.x + dir.x * 0.4, p.y, p.z + dir.z * 0.4);
          lamps.push(lamp);
          addGlow(p.clone().addScaledVector(dir, 0.8), LAMP_COLOR.clone().multiplyScalar(2), 3, dir, false);
          if (pad.spots.some((s) => s.corner === k && s.h === h)) this.addSpot(p.clone().addScaledVector(dir, 1.2), target);
        }
      }
    }

    const lampMesh = new THREE.Mesh(mergeGeometries(lamps.map((g) => g.toNonIndexed()))!, this.lampMat);
    lampMesh.castShadow = true;
    lampMesh.receiveShadow = true;
    this.group.add(lampMesh);
    const mastMesh = new THREE.Mesh(mergeGeometries(masts.map((g) => g.toNonIndexed()))!, new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.5, metalness: 0.5 }));
    this.group.add(mastMesh);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(glow.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(glow.color, 3));
    geo.setAttribute('size', new THREE.Float32BufferAttribute(glow.size, 1));
    geo.setAttribute('aim', new THREE.Float32BufferAttribute(glow.aim, 3));
    geo.setAttribute('blink', new THREE.Float32BufferAttribute(glow.blink, 1));
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uScale: { value: 500 }, uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const points = new THREE.Points(geo, this.glowMat);
    points.frustumCulled = false;
    toFxLayer(points);
    this.group.add(points);
  }

  private addSpot(from: THREE.Vector3, to: THREE.Vector3): void {
    const s = new THREE.SpotLight(LAMP_COLOR, 0, 600, 1.0, 0.6, 2);
    s.castShadow = false;
    s.userData.candela = SPOT_LIGHTING * from.distanceToSquared(to);
    s.position.copy(from);
    s.target.position.copy(to);
    this.group.add(s, s.target);
    this.spots.push(s);
  }

  /** Per frame: on with the night (the buildings' own lights' measure), beacons flashing by real time. */
  update(realTime: number, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const night = buildingUniforms.uNight.value as number;
    const u = this.glowMat.uniforms;
    u.uNight.value = night;
    u.uTime.value = realTime;
    u.uPixelRatio.value = renderer.getPixelRatio();
    u.uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.lampMat.emissiveIntensity = 3 * night;
    for (const s of this.spots) s.intensity = s.userData.candela * night;
  }
}
