// World around Starbase: the low-resolution whole Earth (globe.ts), lighting and sky, plus the
// Pad 1 / Pad 2 models. The 200 km region around Starbase is streamed by terrain.ts.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { V3 } from '../sim/math';
import { SceneAtmospherePass } from './atmosphere';
import { AutoExposurePass } from './exposure';
import { StarSky } from './stars';
import { TowerRigging } from './towerRigging';
import type { FloatingOrigin } from './floatingOrigin';
import { createGlobe } from './globe';
import { Pivot } from './models';

export const EARTH_RADIUS = 6371000;
/** Toward the sun at day angle 0 (world axes): a morning at Starbase, from the east-southeast. */
export const SUN_AT_DAY0 = new THREE.Vector3(0.7, 0.55, 0.3).normalize();
/**
 * Image-based lighting for polished stainless steel: a sky gradient with a bright
 * horizon, a sun hotspot, and sand-colored ground below (Boca Chica beach).
 */
function outdoorEnvironment(): { env: THREE.Scene; sunDir: THREE.Vector3; overcast: { value: number }; ground: THREE.Vector3; space: { value: number } } {
  const env = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { sunDir: { value: new THREE.Vector3(0.7, 0.55, 0.3).normalize() }, overcast: { value: 0 }, ground: { value: new THREE.Vector3(0.42, 0.37, 0.28) }, space: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 sunDir;
      uniform float overcast;
      uniform vec3 ground;   // what's below: sand, sea, or the Earth from high up
      uniform float space;   // 0 at the ground .. 1 above the air (a black sky)
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zenith = vec3(0.18, 0.36, 0.72) * (1.0 - space);
        vec3 horizon = mix(vec3(0.78, 0.86, 0.95), vec3(0.3, 0.45, 0.7), space);
        // (From high up the sky's blue is a thin band at the horizon, black above it.)
        vec3 sky = mix(horizon, zenith, pow(max(h, 0.0), mix(0.45, 0.12, space)));
        vec3 col = h >= 0.0 ? sky : mix(horizon * 0.8, ground, smoothstep(0.0, 0.08, -h));
        // Under an overcast: a grey deck overhead (a little brighter toward the zenith), no sun.
        vec3 deck = vec3(0.5, 0.52, 0.55) * mix(0.8, 1.0, max(h, 0.0));
        col = mix(col, h >= 0.0 ? deck : mix(deck * 0.8, ground * 0.55, smoothstep(0.0, 0.08, -h)), overcast);
        float s = max(dot(d, sunDir), 0.0);
        col += (1.0 - overcast) * vec3(1.0, 0.92, 0.8) * (pow(s, 600.0) * 40.0 + pow(s, 12.0) * 0.35);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  env.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat));
  return { env, sunDir: mat.uniforms.sunDir.value, overcast: mat.uniforms.overcast, ground: mat.uniforms.ground.value, space: mat.uniforms.space };
}

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Objects with fixed float64 world positions, re-placed every frame. */
  statics: THREE.Object3D[];
  sun: THREE.DirectionalLight;
  /** Render with bloom (HDR scene -> bloom -> tone mapping). */
  render(): void;
  bloom: UnrealBloomPass;
  /** The shadow map's largest size, texels across (4096; less on lower detail). */
  shadowMax: number;
  atmosphere: SceneAtmospherePass;
  exposure: AutoExposurePass;
  setSize(width: number, height: number): void;
  /** Render resolution: device pixels per CSS pixel (below the display's = rendered smaller and scaled up). */
  setPixelRatio(ratio: number): void;
  /** The clouds' resolution, pixels per point of the screen (1.25 normally; less under load). */
  setCloudDensity(px: number): void;
  /** Redraw the shadow map this frame (it's only redrawn when something that casts shadows moved). */
  shadowsDirty(): void;
  /** The post-processing chain (for tuning / debugging). */
  composer: EffectComposer;
  /**
   * cameraUp: local vertical at the camera (world axes); daylight follows the sun's height there.
   * earthCenter: Earth's center relative to the camera; groundRadius: ellipsoid radius below it.
   */
  updateSky(cameraAltitude: number, cameraUp: THREE.Vector3, earthCenter: THREE.Vector3, groundRadius: number): void;
  /**
   * Center the sun's shadow frustum on a point on the ground (render coordinates), `radius`
   * across; `reach`: how far up toward the sun from there casters can be (m).
   */
  updateShadow(focus: THREE.Vector3, radius: number, reach?: number): void;
  /**
   * The time of day: the Earth's rotation (rad) since day angle 0 (a morning at Starbase),
   * about its axis (world axes, unit). The sun and the stars turn the other way.
   */
  setDay(angle: number, earthAxis: THREE.Vector3): void;
  /**
   * How overcast it is where the camera is, 0 (clear) .. 1: the sky that lights and is reflected
   * in everything turns to a grey deck without a sun, and the ambient light grey.
   */
  setOvercast(k: number): void;
  /** Lightning's light on everything near: 0 (none) .. 1 (a stroke a km or two away). */
  setFlash(k: number): void;
  /**
   * What the reflections show below the horizon: sea (1) or land (0) under the camera, and its
   * height (m: the Earth from high up, under a black sky).
   */
  setSurroundings(sea: number, altitude: number): void;
  /** Direction to the sun (world axes, unit). */
  readonly sunDir: THREE.Vector3;
  /** Equatorial (celestial) -> world rotation now: the star sky's, turning with the day. */
  readonly skyRotation: THREE.Quaternion;
  /** Add the Pad 2 model; returns its animatable parts. */
  addPad(model: THREE.Object3D): PadRig;
}

/** A tower's state from the sim, as the rig animates it. */
export interface TowerView {
  offset: number;
  angle: number;
  broken?: { L: boolean; R: boolean };
  down?: boolean;
  /** Direction the tower falls when felled (pad ENU, horizontal). */
  fallDir?: V3;
  /** Both arms' swing round the tower (deg). */
  slew?: number;
  /** Ship QD arm swing (deg) and whether it's wrecked. */
  qd?: number;
  qdBroken?: boolean;
}

/** How far a wrecked arm sags off its hinge, and how far a felled tower goes over, rad. */
const ARM_SAG = THREE.MathUtils.degToRad(62);
const TOWER_FALL = THREE.MathUtils.degToRad(84);

interface ArmRig {
  pivot: Pivot;
  /** Axis (pivot-local) about which the arm sags: tip goes down. */
  sagAxis: THREE.Vector3;
  sag: number;
}

interface TowerRig {
  carriage: THREE.Object3D;
  home: number;
  left: ArmRig;
  right: ArmRig;
  /** Tower lattice, carriage and QD arm hang from this group, pivoting at the top of the tower base. */
  fall: THREE.Group;
  fallAngle: number;
  fallRate: number;
  /** Ship QD arm. */
  qd: ArmRig;
  /** The carriage's hoisting ropes and blocks. */
  rigging: TowerRigging;
}

/** Tower mechanisms: both towers' ship QD arms and catch arms (from the sim), and wreckage. */
export class PadRig {
  private towers: TowerRig[];
  private last = performance.now();
  private tmpQ = new THREE.Quaternion();

  constructor(model: THREE.Object3D) {
    model.updateMatrixWorld(true);
    this.towers = ['Pad1_', 'Pad2_'].map((p) => {
      const need = (name: string) => {
        const n = model.getObjectByName(name);
        if (!n) throw new Error(`model node "${name}" not found`);
        return n;
      };
      // A group at the top of the tower's base block for the tower to topple about.
      const base = new THREE.Box3().setFromObject(need(`${p}Tower_Base`));
      const pivotWorld = new THREE.Vector3((base.min.x + base.max.x) / 2, base.max.y, (base.min.z + base.max.z) / 2);
      const parent = need(`${p}Tower`).parent!;
      const fall = new THREE.Group();
      fall.name = `${p}TowerFall`;
      fall.position.copy(parent.worldToLocal(pivotWorld.clone()));
      parent.add(fall);
      fall.updateMatrixWorld(true);
      for (const name of [`${p}Tower`, `${p}Carriage`, `${p}ShipQD`, `${p}ShipQD_Hinge`]) {
        const n = model.getObjectByName(name);
        if (n) fall.attach(n);
      }
      const carriage = need(`${p}Carriage`);
      const rigOf = (pivotName: string, meshName: string): ArmRig => {
        const node = need(pivotName);
        // Sag axis: horizontal, square to the arm (up x tip direction), in the pivot's frame.
        const tip = new THREE.Box3().setFromObject(need(meshName)).getCenter(new THREE.Vector3());
        const local = node.worldToLocal(tip);
        local.y = 0;
        const sagAxis = new THREE.Vector3(0, 1, 0).cross(local.normalize()).normalize();
        return { pivot: new Pivot(node), sagAxis, sag: 0 };
      };
      const arm = (side: 'L' | 'R') => rigOf(`${p}Chopstick_${side}`, `${p}Chopstick_${side}_Arm`);
      const qd = rigOf(`${p}ShipQD`, `${p}ShipQD_Arm`);
      // The carriage's hoisting rigging (not in the kit), its crown under a clad shroud: Pad 1's
      // tower reeves 5 passes, its lines leaving the tower one section up; Pad 2's 6, two up.
      const front = new THREE.Box3().setFromObject(need(`${p}Chopstick_L_Arm`)).getCenter(new THREE.Vector3());
      const groundY = fall.worldToLocal(model.localToWorld(new THREE.Vector3())).y;
      const spec = p === 'Pad1_' ? { passes: 5, housing: true, exitSection: 1 } : { passes: 6, housing: true, exitSection: 2 };
      const rigging = new TowerRigging(fall, carriage, need(`${p}Chopstick_L_Arm`), need(`${p}Tower`), front, groundY, spec);
      return { carriage, home: carriage.position.y, left: arm('L'), right: arm('R'), fall, fallAngle: 0, fallRate: 0, qd, rigging };
    });
    this.update(null, []);
  }

  /** towers: per pad, carriage offset from home (m), arm opening (deg) and wreckage, from the sim. */
  update(missionTime: number | null, towers: TowerView[]): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    void missionTime;
    this.towers.forEach((rig, i) => {
      const state = towers[i] ?? { offset: 0, angle: 28 };
      rig.carriage.position.y = rig.home + state.offset;
      rig.rigging.update();
      const a = THREE.MathUtils.degToRad(state.angle);
      const slew = THREE.MathUtils.degToRad(state.slew ?? 0);
      // A wrecked arm sags off its hinge (quickly, with a little overshoot-free easing).
      const pose = (arm: ArmRig, hinge: number, broken: boolean) => {
        arm.sag = broken ? arm.sag + (ARM_SAG - arm.sag) * Math.min(1, dt * 2.5) : 0;
        arm.pivot.pose(hinge, this.tmpQ.setFromAxisAngle(arm.sagAxis, arm.sag));
      };
      pose(rig.left, a + slew, !!state.broken?.L);
      pose(rig.right, -a + slew, !!state.broken?.R);
      // The ship QD arm: swung by the sim; bent down off its hinge when a vehicle wrecks it.
      pose(rig.qd, THREE.MathUtils.degToRad(state.qd ?? 0), !!state.qdBroken);
      // A felled tower goes over like a falling mast: slowly at first, then faster.
      if (state.down && state.fallDir) {
        if (rig.fallAngle < TOWER_FALL) {
          rig.fallRate += 1.2 * Math.sin(rig.fallAngle + 0.05) * dt;
          rig.fallAngle = Math.min(TOWER_FALL, rig.fallAngle + rig.fallRate * dt);
        }
        const [e, n] = state.fallDir;
        // Pad ENU (e, n) -> model (x, z) = (e, -n); tip moves toward the fall direction.
        const axis = new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(e, 0, -n)).normalize();
        rig.fall.quaternion.setFromAxisAngle(axis, rig.fallAngle);
      } else {
        rig.fallAngle = 0;
        rig.fallRate = 0;
        rig.fall.quaternion.identity();
      }
    });
  }
}

// Past the far end of the shadow frustum is outside it: lit. (With a reversed depth buffer the
// shadow depth runs 1 at the light's near plane to 0 at the far one, so the stock test, which
// only rejects z > 1, took everything beyond the far plane as in shadow: a dark box on the
// ground under a vehicle whose shadow frustum doesn't reach down that far.)
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replaceAll(
  'shadowCoord.z <= 1.0;',
  'shadowCoord.z <= 1.0 && shadowCoord.z >= 0.0;',
);

export function createWorld(canvas: HTMLCanvasElement, origin: FloatingOrigin): World {
  // Depth over 0.5 m .. 50,000 km: a reversed-Z float depth buffer (depth 1 at the near plane,
  // 0 at the far one) keeps precision everywhere. (A logarithmic depth buffer does too, but it
  // writes every fragment's depth from the shader, which switches off the GPU's early depth
  // test and hidden-surface removal: far slower.)
  // (No multisampling on the canvas itself: everything is drawn into the passes' own targets, the
  // solids multisampled there, and only a full-screen copy reaches the canvas.)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, reversedDepthBuffer: true, logarithmicDepthBuffer: false });
  if (!renderer.capabilities.reversedDepthBuffer) console.warn('EXT_clip_control unavailable: depth precision will suffer far from the camera');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // The shadow map is redrawn only when asked (shadowsDirty): the pad mostly stands still.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // (Soft-edged: three's percentage-closer filter. Its separate "soft" kind is gone from three,
  // and asking for it was a warning in the console at every start.)
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const outdoor = outdoorEnvironment();
  let envTarget = pmrem.fromScene(outdoor.env, 0.02);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.75;
  const redrawEnv = () => {
    const next = pmrem.fromScene(outdoor.env, 0.02);
    scene.environment = next.texture;
    envTarget.dispose();
    envTarget = next;
  };

  // (Far enough for the Moon, and the map zoomed out to its orbit.)
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2e9);

  // At day angle 0, a morning sun from the east-southeast (like many Starbase launch windows);
  // it turns with the day about the Earth's axis (setDay).
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  const sunDir = SUN_AT_DAY0.clone();
  const dayTurn = new THREE.Quaternion();
  /** The day angle the environment map was last drawn for, and when (ms). */
  let envAngle = 0;
  let envAt = 0;
  const envGround = new THREE.Vector3();
  // (The sea as the waves' own reflections see it: other water, itself mostly reflected sky.)
  const ENV_SEA = new THREE.Vector3(0.2, 0.28, 0.36);
  const ENV_EARTH = new THREE.Vector3(0.26, 0.36, 0.5);
  sun.position.copy(sunDir);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);
  const HEMI_SKY = new THREE.Color(0xbcd7ff);
  const HEMI_OVERCAST = new THREE.Color(0xc4c8cc);
  const hemi = new THREE.HemisphereLight(HEMI_SKY, 0x8a7a5c, 0.3);
  scene.add(hemi);
  // Night: faint cool starlight from the whole sky, so a vehicle in the dark still shows its shape.
  const starlight = new THREE.HemisphereLight(0x9fb4e6, 0x1c2230, 0);
  scene.add(starlight);
  // Lightning: a blue-white flash from the whole sky (the cloud lit from inside).
  const flash = new THREE.HemisphereLight(0xd8e2ff, 0x404650, 0);
  scene.add(flash);
  const stars = new StarSky(sunDir);
  scene.add(stars.group);

  const statics: THREE.Object3D[] = [];
  const add = (o: THREE.Object3D, world: V3) => {
    origin.place(o, world);
    scene.add(o);
    statics.push(o);
  };

  // The whole Earth at low resolution; the streamed terrain covers the 200 km around Starbase.
  new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}globe/earth.jpg`).then((tex) => {
    const globe = createGlobe(tex);
    add(globe, [0, 0, 0]);
    atmosphere.setBackground(globe);
  });

  // The sky is drawn by the atmosphere pass over a black background (space).
  scene.background = null;

  // HDR render targets so the exhaust and hot nozzles bloom; tone mapping happens in the output
  // pass. (The scene itself is drawn multisampled inside the atmosphere pass; these carry the
  // resolved image, and a depth buffer for the effects drawn over it.)
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const composer = new EffectComposer(renderer, target);
  const atmosphere = new SceneAtmospherePass(scene, camera);
  atmosphere.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(atmosphere);
  // (The background, the clouds drawn against it; the Moon and the map tiles join it from main.)
  atmosphere.setBackground(stars.group);
  // (Threshold over the brightest sunlit cloud, ~1.7: clouds blooming would wash the whole view
  // into a milky haze from above them.)
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.3, 2.0);
  // (At half the screen's resolution (its blur chain at a quarter): it's a soft glow, and the
  // full-resolution one cost ~1.5 ms a frame at 2x pixel density.)
  const bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w: number, h: number) => bloomSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  composer.addPass(bloom);
  // (The view's exposure, down over a bright cloud field: see exposure.ts.)
  const exposure = new AutoExposurePass();
  composer.addPass(exposure);
  const output = new OutputPass();
  exposure.attachTo(output);
  composer.addPass(output);

  return {
    renderer,
    scene,
    camera,
    statics,
    sun,
    bloom,
    shadowMax: 4096,
    exposure,
    atmosphere,
    composer,
    render() {
      composer.render();
    },
    setSize(w: number, h: number) {
      renderer.setSize(w, h, false);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    setCloudDensity(px: number) {
      if (Math.abs(atmosphere.cloudDensity - px) < 1e-3) return;
      atmosphere.cloudDensity = px;
      atmosphere.setPixelRatio(renderer.getPixelRatio());
      const size = renderer.getSize(new THREE.Vector2());
      composer.setSize(size.x, size.y);
    },
    setPixelRatio(ratio: number) {
      const size = renderer.getSize(new THREE.Vector2());
      if (Math.abs(renderer.getPixelRatio() - ratio) < 1e-3) return;
      renderer.setPixelRatio(ratio);
      renderer.setSize(size.x, size.y, false);
      atmosphere.setPixelRatio(ratio);
      composer.setPixelRatio(ratio);
      composer.setSize(size.x, size.y);
    },
    shadowsDirty() {
      renderer.shadowMap.needsUpdate = true;
    },
    updateSky(alt: number, up: THREE.Vector3, earthCenter: THREE.Vector3, groundRadius: number) {
      atmosphere.setFrame(earthCenter, groundRadius, sunDir);
      const t2 = THREE.MathUtils.clamp((alt - 25000) / 60000, 0, 1);
      // Sun height above this place's horizon; from altitude the sun stays up a little longer
      // (the horizon dips by acos(R / (R + h))).
      const elev = Math.asin(THREE.MathUtils.clamp(up.dot(sunDir), -1, 1));
      const dip = Math.acos(EARTH_RADIUS / (EARTH_RADIUS + Math.max(0, alt)));
      const sunUp = THREE.MathUtils.smoothstep(elev + dip, -0.05, 0.03);
      const day = THREE.MathUtils.smoothstep(elev, -0.2, 0.05);
      sun.intensity = 2.6 * sunUp;
      // (Low in the sky its light comes through far more air: yellow, then orange at the horizon,
      // as the sky's own shader has it for the clouds.)
      const low = THREE.MathUtils.smoothstep(elev + dip, -0.02, 0.32) ** 0.7;
      sun.color.setRGB(1, THREE.MathUtils.lerp(0.52, 0.945, low), THREE.MathUtils.lerp(0.26, 0.863, low), THREE.SRGBColorSpace);
      // The sky's light on the ground: falling away fast as the sun nears the horizon and all but
      // gone a few degrees under it, as the sky itself is drawn. (On the stars' slower curve, the
      // ground at dawn stood bright as day under a sky still nearly black.)
      const skyLight = THREE.MathUtils.smoothstep(elev, -0.1, 0.1) ** 2;
      hemi.intensity = 0.3 * (1 - 0.7 * t2) * (0.04 + 0.96 * skyLight);
      // How dark it is here: the sun's height at the ground, whether the sun is in sight up high.
      const dark = 1 - THREE.MathUtils.lerp(day, sunUp, t2);
      // (Dim at the ground, where the eye is on lit things and a night away from them is dark;
      // brighter up high, so a vehicle in the Earth's shadow still shows its shape.)
      starlight.intensity = THREE.MathUtils.lerp(0.14, 0.6, t2) * dark;
      // Above the air the black sky shows its stars even in sunlight (dimmer: the eye is
      // adapted to the sunlit ship and Earth); fully in the Earth's shadow.
      const starsShow = Math.max(dark, 0.4 * t2);
      // (Its sky is a daytime one: at night only a trace of it, least at the ground.)
      scene.environmentIntensity = 0.75 * (1 - 0.6 * t2) * (THREE.MathUtils.lerp(0.02, 0.06, t2) + (1 - THREE.MathUtils.lerp(0.02, 0.06, t2)) * THREE.MathUtils.lerp(skyLight, day, t2)) + THREE.MathUtils.lerp(0.03, 0.08, t2) * dark;
      stars.update(camera, starsShow, 1 - t2, performance.now() / 1000, renderer.getPixelRatio());
    },
    sunDir,
    skyRotation: stars.rotation,
    setDay(angle: number, earthAxis: THREE.Vector3) {
      // The Earth turns east: in its (the world's) frame the sky turns west about the axis.
      dayTurn.setFromAxisAngle(earthAxis, -angle);
      sunDir.copy(SUN_AT_DAY0).applyQuaternion(dayTurn);
      stars.spin(dayTurn);
      // The reflections' sky, redrawn now and then as the sun moves (a few degrees at a time).
      const now = performance.now();
      if (Math.abs(angle - envAngle) > 0.06 && now - envAt > 1000) {
        envAngle = angle;
        envAt = now;
        // (Its sky is the pad's: up is the world's y.)
        outdoor.sunDir.copy(sunDir);
        redrawEnv();
      }
    },
    setFlash(k: number) {
      flash.intensity = 2.5 * k;
    },
    setSurroundings(sea: number, altitude: number) {
      // Sand at Starbase; out at sea, dark water (a stage afloat reflected beach sand, and came
      // out beige); from high up the blue-white Earth, under a sky gone black.
      const high = THREE.MathUtils.smoothstep(altitude, 5000, 50000);
      const space = THREE.MathUtils.smoothstep(altitude, 20000, 80000);
      envGround.set(0.42, 0.37, 0.28).lerp(ENV_SEA, sea).lerp(ENV_EARTH, high);
      const now = performance.now();
      if ((envGround.distanceTo(outdoor.ground) > 0.03 || Math.abs(space - outdoor.space.value) > 0.06) && now - envAt > 1000) {
        envAt = now;
        outdoor.ground.copy(envGround);
        outdoor.space.value = space;
        redrawEnv();
      }
    },
    setOvercast(k: number) {
      hemi.color.copy(HEMI_SKY).lerp(HEMI_OVERCAST, k);
      const now = performance.now();
      if (Math.abs(k - outdoor.overcast.value) > 0.06 && now - envAt > 1000) {
        envAt = now;
        outdoor.overcast.value = k;
        redrawEnv();
      }
    },
    updateShadow(focus: THREE.Vector3, radius: number, reach = 0) {
      const cam = sun.shadow.camera;
      const r = THREE.MathUtils.clamp(radius, 60, 700);
      // The map's resolution: 4096 texels for the whole launch site (~0.3 m each), 2048 for a
      // vehicle alone (its few hundred metres: ~0.15 m), a quarter of the cost each time it's
      // redrawn (every frame while something moves).
      const size = Math.min(this.shadowMax, r > 250 ? 4096 : 2048);
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        renderer.shadowMap.needsUpdate = true;
      }
      // The light sits above everything that can cast onto this patch (the tall towers, a
      // climbing rocket up to `reach`), and the frustum runs down to below the ground.
      const up = Math.max(2 * r + 200, reach + 200);
      const far = up + 2 * r + 200;
      if (cam.right !== r || cam.far !== far) {
        cam.left = -r;
        cam.right = r;
        cam.top = r;
        cam.bottom = -r;
        cam.near = 1;
        cam.far = far;
        cam.updateProjectionMatrix();
      }
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(sunDir, up);
      sun.target.updateMatrixWorld();
      // (Everything, the light included, moves with the floating origin: a shadow map drawn
      // earlier still holds, as long as its matrices follow along.)
      sun.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
    },
    addPad(model: THREE.Object3D) {
      add(model, [0, 0, 0]);
      return new PadRig(model);
    },
  };
}
