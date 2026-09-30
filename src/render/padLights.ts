// The pads at night: floodlight poles round each launch mount and red obstruction lights on the
// towers, like Starbase's. Real light (a few spotlights, no shadows) falls only on Pad 1's stack,
// where the launches are: from two poles on the beach side and one on the tower's front corner.
// Every lamp, near or far, is also a glowing point that stays visible from kilometres away
// (floodlights brightest looking into them; the tower beacons' tops flash, ~30 a minute).
//
// The spotlights stay in the scene by day at zero intensity: switching them on and off would
// change the light count, and recompile every material mid-flight.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD, PAD2 } from '../sim/constants';
import { toFxLayer } from './atmosphere';
import { buildingUniforms } from './facilities';
import { SLAB_TOP, TRENCHES } from './launchSite';

/** Pole height (to the lamp head), m. */
const POLE = 40;
/** The towers' lattice: centre to corner, m (15.2 m square, a corner toward the mount; art/blender/tower_kit.py). */
const TOWER_CORNER = 10.75;
/** How high on the stack the floodlights aim, m. */
const AIM_UP = 60;
/** How brightly the floodlights light the stack (the sun is 2.6), each set for its distance. */
const SPOT_LIGHTING = 1.1;

const LAMP_COLOR = new THREE.Color(1.0, 0.94, 0.84);
const RED = new THREE.Color(1.0, 0.08, 0.04);

interface PadSpec {
  /** Mount (east, north), pad-local m. */
  mount: [number, number];
  tower: { e: number; n: number; height: number };
  /** Floodlight poles, relative to the mount (east, north); `spot`: casts real light. */
  poles: { at: [number, number]; spot?: boolean }[];
  /** A real spotlight from the tower's front corner, this high. */
  towerSpot?: number;
}

const PADS: PadSpec[] = [
  {
    mount: TRENCHES[0].center,
    tower: PAD.tower,
    // Clear of the flame trench (axis 48 deg, NE / SW) and the tower (west).
    poles: [{ at: [75, -55], spot: true }, { at: [85, 35], spot: true }, { at: [-45, 70] }, { at: [-40, -60] }],
    towerSpot: 62,
  },
  {
    mount: TRENCHES[1].center,
    tower: PAD2.tower,
    // Clear of its trench (axis -37 deg, SE / NW) and its tower (north).
    poles: [{ at: [42, 56] }, { at: [-42, -56] }, { at: [67, 34] }, { at: [-68, -26] }],
  },
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
    const poles: THREE.BufferGeometry[] = [];
    const lamps: THREE.BufferGeometry[] = [];
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
      const aimAt = w(me, mn, AIM_UP);

      for (const pole of pad.poles) {
        const [pe, pn] = [me + pole.at[0], mn + pole.at[1]];
        const yaw = Math.atan2(-(mn - pn), me - pe); // render-world heading toward the mount
        // A tapered galvanized mast with a ladder cage's worth of bulk near the top.
        const mast = new THREE.CylinderGeometry(0.32, 0.6, POLE, 10, 1);
        mast.translate(pe, SLAB_TOP + POLE / 2, -pn);
        poles.push(mast);
        // The lamp head: a frame across the pole, two rows of three floods tilted at the stack.
        const frame = new THREE.BoxGeometry(0.5, 3.2, 7);
        frame.rotateY(-yaw);
        frame.translate(pe, SLAB_TOP + POLE + 0.6, -pn);
        poles.push(frame);
        const head = w(pe, pn, SLAB_TOP + POLE + 0.6);
        const dir = aimAt.clone().sub(head).normalize();
        const side = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        for (const row of [-0.8, 0.8])
          for (const col of [-2.3, 0, 2.3]) {
            const lamp = new THREE.BoxGeometry(1.1, 0.9, 0.5);
            const at = head.clone().addScaledVector(side, col).add(new THREE.Vector3(0, row, 0)).addScaledVector(dir, 0.5);
            lamp.lookAt(dir);
            lamp.translate(at.x, at.y, at.z);
            lamps.push(lamp);
          }
        addGlow(head.clone().addScaledVector(dir, 1.0), LAMP_COLOR.clone().multiplyScalar(2.2), 7, dir, false);
        if (pole.spot) this.addSpot(head.clone().addScaledVector(dir, 1.5), aimAt);
      }

      // Tower obstruction lights: flashing red on top at each corner, steady red at a third and
      // two thirds of the height.
      const [tc_e, tc_n] = [me + pad.tower.e, mn + pad.tower.n];
      const d = new THREE.Vector2(-pad.tower.e, -pad.tower.n).normalize();
      const corners = [0, 1, 2, 3].map((k) => {
        const a = (k * Math.PI) / 2;
        const r = TOWER_CORNER + 0.4;
        return [tc_e + r * (d.x * Math.cos(a) - d.y * Math.sin(a)), tc_n + r * (d.x * Math.sin(a) + d.y * Math.cos(a))];
      });
      for (const [ce, cn] of corners) {
        addGlow(w(ce, cn, pad.tower.height + 0.6), RED.clone().multiplyScalar(3), 2.2, null, true);
        for (const f of [1 / 3, 2 / 3]) addGlow(w(ce, cn, pad.tower.height * f), RED.clone().multiplyScalar(1.6), 1.4, null, false);
      }
      // Work lights down the front corner (toward the mount) that the ship and booster are stacked by.
      const [fe, fn] = corners[0];
      for (const h of [20, 45, 62, 90, 118]) {
        const p = w(fe, fn, h);
        const dir = aimAt.clone().setY(h).sub(p).normalize();
        addGlow(p.clone().addScaledVector(dir, 0.6), LAMP_COLOR.clone().multiplyScalar(1.6), 2.5, dir, false);
        if (pad.towerSpot === h) this.addSpot(p.clone().addScaledVector(dir, 1), w(me, mn, AIM_UP + 10));
      }
    }

    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9a9c9e, roughness: 0.55, metalness: 0.6 });
    const poleMesh = new THREE.Mesh(mergeGeometries(poles.map((g) => g.toNonIndexed()))!, poleMat);
    const lampMesh = new THREE.Mesh(mergeGeometries(lamps.map((g) => g.toNonIndexed()))!, this.lampMat);
    for (const m of [poleMesh, lampMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }

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
    const s = new THREE.SpotLight(LAMP_COLOR, 0, 900, 0.62, 0.55, 2);
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
