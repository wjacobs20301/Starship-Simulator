// The 404 page's scene (404.html), from the game's own assets: Starship (the ship model)
// tumbling out of control 404 km up, over the Blue Marble Earth with its atmosphere glowing on
// the limb, under the game's star sky (the real bright stars and the Milky Way). Loads only what
// it shows: the ship (~2.6 MB) and the Earth image (~2.3 MB), both shared with the game's cache.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { StarSky } from './render/stars';

const R_EARTH = 6.371e6;
const ALTITUDE = 404e3;
const SHIP_LENGTH = 52.1;
const BASE = import.meta.env.BASE_URL;

// --- The page's text: the address that wasn't found, the mission clock, a wandering speed ---
let where = location.pathname;
try {
  where = decodeURI(where);
} catch {
  // (A malformed address: show it as it came.)
}
document.getElementById('path')!.textContent = where || '/';
const clock = document.getElementById('clock')!;
const speed = document.getElementById('speed')!;
const pad = (n: number) => String(n).padStart(2, '0');
const t0 = performance.now();
// The ship's been up a while: the clock opens somewhere between 1h30 and 3h into the mission.
const elapsed0 = 5400 + Math.floor(Math.random() * 5400);
const tick = () => {
  const s = elapsed0 + Math.floor((performance.now() - t0) / 1000);
  clock.textContent = `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  speed.textContent = `${Math.round(27404 + Math.sin(s / 7) * 12).toLocaleString('en-US')} km/h`;
};
tick();
setInterval(tick, 250);

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;

/** A sky for the steel to reflect: black space above, the blue-white Earth below, the sun. */
function environment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.Texture {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSun;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 earth = mix(vec3(0.05, 0.12, 0.24), vec3(0.28, 0.4, 0.55), smoothstep(-0.05, -0.6, d.y));
        vec3 limb = vec3(0.35, 0.6, 1.0) * exp(-abs(d.y + 0.06) * 40.0);
        vec3 col = d.y < -0.06 ? earth : vec3(0.004);
        col += limb * 0.6;
        float s = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.95, 0.88) * (pow(s, 900.0) * 60.0 + pow(s, 24.0) * 0.4);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return env;
}

/**
 * The Earth's air: a shell that, for each line of sight, glows by how low it passes over the
 * ground (a thin bright band along the limb, fading out ~50 km up), and lays a light haze over
 * the ground itself. Only on the sunlit side.
 */
function atmosphere(center: THREE.Vector3, sunDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uSun: { value: sunDir }, uCenter: { value: center }, uR: { value: R_EARTH } },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uSun;
      uniform vec3 uCenter;
      uniform float uR;
      varying vec3 vWorld;
      void main() {
        vec3 rd = normalize(vWorld - cameraPosition);
        vec3 oc = cameraPosition - uCenter;
        float b = dot(oc, rd);
        float d = sqrt(max(dot(oc, oc) - b * b, 0.0));
        float h = d - uR;
        // Where the line of sight passes lowest, and how sunlit the air is there.
        vec3 low = normalize(oc - b * rd);
        float lit = smoothstep(-0.25, 0.35, dot(low, uSun));
        vec3 col;
        if (h > 0.0) {
          // Past the limb: the thin band of air, bright low down, blue fading to deep blue.
          float g = exp(-h / 9000.0);
          col = mix(vec3(0.08, 0.2, 0.75), vec3(0.55, 0.78, 1.0), g) * (g * 1.6 + exp(-h / 40000.0) * 0.25);
        } else {
          // Over the ground: a haze, thicker toward the horizon (looking through more air).
          vec3 n = normalize(cameraPosition + rd * (-b - sqrt(max(b * b - dot(oc, oc) + uR * uR, 0.0))) - uCenter);
          float graze = 1.0 - max(dot(n, -rd), 0.0);
          col = vec3(0.3, 0.5, 0.9) * (0.06 + 0.5 * pow(graze, 3.0));
        }
        gl_FragColor = vec4(col * lit, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(R_EARTH + 120e3, 256, 128), mat);
}

/** Where on the Earth a latitude / longitude sits on a three.js sphere (unit vector). */
function sphereDir(latDeg: number, lonDeg: number): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lonDeg + 180);
  const theta = THREE.MathUtils.degToRad(90 - latDeg);
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

async function start(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 1e8);

  // The sun: from the upper left, a little behind the camera.
  const sunDir = new THREE.Vector3(-0.62, 0.42, 0.66).normalize();
  const sun = new THREE.DirectionalLight(0xfff3e2, 3.2);
  sun.position.copy(sunDir);
  scene.add(sun, new THREE.HemisphereLight(0x1a2a44, 0x2d4d78, 0.25));
  scene.environment = environment(renderer, sunDir);
  scene.environmentIntensity = 0.9;

  // Stars (the game's sky: real catalogue positions, the Milky Way).
  const stars = new StarSky(sunDir);
  scene.add(stars.group);

  // The Earth below, turning slowly beneath the ship.
  const earth = new THREE.Group();
  earth.position.set(0, -(R_EARTH + ALTITUDE), 0);
  scene.add(earth);
  const globe = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH, 256, 128), new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 }));
  // Over the Gulf of Mexico, heading west: the Texas and Mexico coast (Starbase) on the horizon
  // ahead, open water below.
  {
    const down = sphereDir(25.3, -89.5);
    const west = sphereDir(25.3, -89.6).sub(down).normalize();
    const side = new THREE.Vector3().crossVectors(down, west.clone().negate());
    const basis = new THREE.Matrix4().makeBasis(side, down, west.clone().negate());
    globe.quaternion.setFromRotationMatrix(basis.transpose());
  }
  const spin = new THREE.Group();
  spin.add(globe);
  earth.add(spin, atmosphere(earth.position, sunDir));
  new THREE.TextureLoader().loadAsync(`${BASE}globe/earth.jpg`).then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    (globe.material as THREE.MeshStandardMaterial).map = tex;
    globe.material.needsUpdate = true;
  });

  // The ship, pivoting about its middle.
  const tumble = new THREE.Group();
  scene.add(tumble);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${BASE}models/ship.glb`);
  const ship = gltf.scene;
  ship.position.y = -SHIP_LENGTH / 2;
  tumble.add(ship);

  // Framing: the camera off to one side; the ship placed right of the text on a wide screen,
  // above it on a narrow one (by shifting the view, so the perspective stays natural).
  const camPos = new THREE.Vector3(78, 22, 112);
  camera.position.copy(camPos);
  camera.lookAt(0, 1, 0);
  function resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // (A tall, narrow screen sees less across: stand back so the whole ship fits.)
    const back = THREE.MathUtils.clamp(1.25 / camera.aspect, 1, 3.4);
    camera.position.copy(camPos).multiplyScalar(back);
    camera.lookAt(0, 1, 0);
    if (w > 760) camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
    else camera.setViewOffset(w, h, 0, h * 0.22, w, h);
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  // Out of control: a slow tumble about a skewed axis, with a little wobble, and the ground
  // sliding by underneath at orbital speed (~0.07 deg/s of the Earth's arc).
  const axis = new THREE.Vector3(0.35, 0.25, 1).normalize();
  const wobbleAxis = new THREE.Vector3(1, 0, 0);
  const q = new THREE.Quaternion();
  const ground = new THREE.Vector3(1, 0, 0);
  let last = performance.now();
  let t = 8;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!calm) t += dt;
    tumble.quaternion.setFromAxisAngle(axis, t * 0.16);
    tumble.quaternion.multiply(q.setFromAxisAngle(wobbleAxis, Math.sin(t * 0.21) * 0.35));
    tumble.position.set(Math.sin(t * 0.05) * 3, Math.sin(t * 0.07) * 2, 0);
    spin.quaternion.setFromAxisAngle(ground, -t * THREE.MathUtils.degToRad(0.07));
    stars.update(camera, 1, 0, now / 1000, renderer.getPixelRatio());
    renderer.render(scene, camera);
    if (!calm) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  if (calm) addEventListener('resize', () => requestAnimationFrame(frame));
  canvas.classList.add('on');
}

start().catch((err) => {
  // No WebGL, or a model that didn't load: the page still says what it needs to.
  console.warn('404 scene unavailable', err);
});
