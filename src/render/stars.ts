// The night sky: the brightest real stars at their catalogue positions (so Orion, the Big Dipper,
// the Southern Cross and friends are where they should be), thousands of fainter stars crowding
// toward the Milky Way, and the Milky Way's own glow. All of it sits on a sphere that follows
// the camera, oriented so the celestial pole lines up with the Earth's axis and the (fixed) sun
// sits on the ecliptic at its place among the stars.
//
// It's drawn with the solid objects but writes no depth: the atmosphere pass treats those pixels
// as sky, so daylight scattering drowns the stars, the air dims them near the horizon, and the
// Earth (which does write depth) hides the ones behind it.

import * as THREE from 'three';
import { DEG, PAD } from '../sim/constants';
import { ecefToEnuMatrix } from '../sim/frames';
import { mat3Transpose, mat3Vec } from '../sim/math';

/** Radius of the sky sphere around the camera, m (inside the camera's far plane). */
const SKY_R = 4e7;
const FAINT_STARS = 9000;

/**
 * Bright stars: right ascension (hours), declination (deg), visual magnitude, colour index B-V.
 * Positions approximate (J2000, to a fraction of a degree).
 */
const BRIGHT: [number, number, number, number][] = [
  [6.752, -16.72, -1.46, 0.0], // Sirius
  [6.399, -52.7, -0.74, 0.15], // Canopus
  [14.66, -60.83, -0.27, 0.71], // Rigil Kentaurus
  [14.261, 19.18, -0.05, 1.23], // Arcturus
  [18.616, 38.78, 0.03, 0.0], // Vega
  [5.278, 46.0, 0.08, 0.8], // Capella
  [5.242, -8.2, 0.13, -0.03], // Rigel
  [7.655, 5.22, 0.34, 0.42], // Procyon
  [1.629, -57.24, 0.46, -0.16], // Achernar
  [5.919, 7.41, 0.5, 1.85], // Betelgeuse
  [14.064, -60.37, 0.61, -0.23], // Hadar
  [19.846, 8.87, 0.76, 0.22], // Altair
  [12.443, -63.1, 0.77, -0.24], // Acrux
  [4.599, 16.51, 0.86, 1.54], // Aldebaran
  [16.49, -26.43, 0.96, 1.83], // Antares
  [13.42, -11.16, 0.97, -0.23], // Spica
  [7.755, 28.03, 1.14, 1.0], // Pollux
  [22.961, -29.62, 1.16, 0.09], // Fomalhaut
  [20.69, 45.28, 1.25, 0.09], // Deneb
  [12.795, -59.69, 1.25, -0.23], // Mimosa
  [10.139, 11.97, 1.35, -0.11], // Regulus
  [6.977, -28.97, 1.5, -0.21], // Adhara
  [7.577, 31.89, 1.58, 0.03], // Castor
  [17.56, -37.1, 1.62, -0.22], // Shaula
  [12.519, -57.11, 1.63, 1.6], // Gacrux
  [5.419, 6.35, 1.64, -0.22], // Bellatrix
  [5.438, 28.61, 1.65, -0.13], // Elnath
  [9.22, -69.72, 1.67, 0.07], // Miaplacidus
  [5.604, -1.2, 1.69, -0.18], // Alnilam
  [22.137, -46.96, 1.74, -0.13], // Alnair
  [5.679, -1.94, 1.77, -0.21], // Alnitak
  [12.9, 55.96, 1.77, -0.02], // Alioth
  [11.062, 61.75, 1.79, 1.07], // Dubhe
  [3.405, 49.86, 1.79, 0.48], // Mirfak
  [7.14, -26.39, 1.83, 0.68], // Wezen
  [18.403, -34.38, 1.85, -0.03], // Kaus Australis
  [8.375, -59.51, 1.86, 1.28], // Avior
  [13.792, 49.31, 1.86, -0.19], // Alkaid
  [17.622, -43.0, 1.87, 0.4], // Sargas
  [5.992, 44.95, 1.9, 0.03], // Menkalinan
  [16.811, -69.03, 1.91, 1.45], // Atria
  [6.628, 16.4, 1.93, 0.0], // Alhena
  [20.427, -56.74, 1.94, -0.2], // Peacock
  [2.53, 89.26, 1.98, 0.6], // Polaris
  [6.378, -17.96, 1.98, -0.23], // Mirzam
  [9.46, -8.66, 1.98, 1.44], // Alphard
  [2.12, 23.46, 2.0, 1.15], // Hamal
  [0.727, -17.99, 2.04, 1.02], // Diphda
  [18.921, -26.3, 2.05, -0.13], // Nunki
  [14.111, -36.37, 2.06, 1.01], // Menkent
  [5.796, -9.67, 2.07, -0.18], // Saiph
  [0.14, 29.09, 2.06, -0.11], // Alpheratz
  [1.162, 35.62, 2.05, 1.58], // Mirach
  [14.845, 74.16, 2.08, 1.47], // Kochab
  [17.582, 12.56, 2.08, 0.15], // Rasalhague
  [3.136, 40.96, 2.1, -0.05], // Algol
  [2.065, 42.33, 2.1, 1.37], // Almach
  [11.818, 14.57, 2.13, 0.09], // Denebola
  [0.675, 56.54, 2.24, 1.17], // Schedar
  [13.399, 54.93, 2.23, 0.02], // Mizar
  [17.943, 51.49, 2.23, 1.52], // Eltanin
  [20.371, 40.26, 2.23, 0.67], // Sadr
  [5.533, -0.3, 2.23, -0.22], // Mintaka
  [0.153, 59.15, 2.27, 0.34], // Caph
  [16.006, -22.62, 2.29, -0.12], // Dschubba
  [11.031, 56.38, 2.37, -0.02], // Merak
  [0.945, 60.72, 2.47, -0.15], // Gamma Cassiopeiae
  [23.063, 28.08, 2.42, 1.67], // Scheat
  [21.736, 9.88, 2.39, 1.52], // Enif
  [23.079, 15.21, 2.49, -0.04], // Markab
  [11.897, 53.69, 2.44, 0.0], // Phecda
  [16.09, -19.81, 2.62, -0.07], // Acrab
  [12.263, -58.75, 2.79, -0.26], // Delta Crucis
  [1.43, 60.24, 2.68, 0.13], // Ruchbah
  [0.22, 15.18, 2.83, -0.23], // Algenib
  [12.257, 57.03, 3.31, 0.08], // Megrez
  [1.907, 63.67, 3.35, -0.15], // Segin
  [19.771, 10.61, 2.72, 1.5], // Tarazed
  [3.791, 24.11, 2.87, -0.09], // Alcyone (Pleiades)
  [4.477, 15.87, 3.53, 0.98], // Ain (Hyades)
  [8.159, -47.34, 1.83, -0.22], // Regor
  [9.285, -59.28, 2.21, -0.18], // Aspidiske
  [16.836, -34.29, 2.29, -0.21], // Epsilon Scorpii
  [17.708, -39.03, 2.39, -0.17], // Kappa Scorpii
  [19.162, -27.67, 2.6, 0.08], // Ascella
  [18.35, -29.83, 2.7, 1.38], // Kaus Media
  [13.911, 18.4, 2.68, 0.58], // Muphrid
  [15.578, 26.71, 2.23, -0.02], // Alphecca
  [20.771, 33.97, 2.48, 1.03], // Gienah Cygni
  [19.512, 27.96, 3.08, 1.13], // Albireo
  [17.244, 14.39, 3.1, 1.16], // Rasalgethi
];

/** Equatorial (J2000) -> galactic rotation. */
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

function galacticLatitude(d: THREE.Vector3): number {
  const z = EQ_TO_GAL[2][0] * d.x + EQ_TO_GAL[2][1] * d.y + EQ_TO_GAL[2][2] * d.z;
  return Math.asin(Math.max(-1, Math.min(1, z)));
}

function equatorial(raHours: number, decDeg: number): THREE.Vector3 {
  const ra = raHours * 15 * DEG;
  const dec = decDeg * DEG;
  return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

/** Star colour from B-V (blue-white hot stars to orange-red cool ones). */
function starColor(bv: number): THREE.Color {
  const stops: [number, number, number, number][] = [
    [-0.3, 0.62, 0.72, 1.0],
    [0.0, 0.8, 0.86, 1.0],
    [0.4, 1.0, 0.98, 0.95],
    [0.8, 1.0, 0.92, 0.78],
    [1.4, 1.0, 0.78, 0.55],
    [2.0, 1.0, 0.64, 0.4],
  ];
  const b = Math.max(-0.3, Math.min(2.0, bv));
  let i = 0;
  while (i < stops.length - 2 && b > stops[i + 1][0]) i++;
  const [x0, r0, g0, b0] = stops[i];
  const [x1, r1, g1, b1] = stops[i + 1];
  const t = (b - x0) / (x1 - x0);
  return new THREE.Color(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t);
}

/** Deterministic pseudo-random numbers (the same sky every time). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rotation from equatorial coordinates to the render world. The sim's sun is fixed in the
 * Earth-fixed world, so the sky is too: turned (about the pole) so the sun sits at its place on
 * the ecliptic for its declination.
 */
function celestialToWorld(sunWorld: THREE.Vector3): THREE.Matrix4 {
  const lat = PAD.latDeg * DEG;
  const lon = PAD.lonDeg * DEG;
  const enuToEcef = mat3Transpose(ecefToEnuMatrix(lat, lon));
  // World (x = E, y = U, z = -N) -> ECEF.
  const toEcef = (w: THREE.Vector3) => mat3Vec(enuToEcef, [w.x, -w.z, w.y]);
  const s = toEcef(sunWorld.clone().normalize());
  const eps = 23.44 * DEG;
  const dec = Math.asin(Math.max(-1, Math.min(1, s[2])));
  const lambda = Math.asin(Math.max(-1, Math.min(1, Math.sin(dec) / Math.sin(eps))));
  const raSun = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  // Earth rotation angle: equatorial RA -> ECEF longitude.
  const theta = raSun - Math.atan2(s[1], s[0]);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  // Equatorial -> ECEF: rotate by -theta about z. Then ECEF -> world.
  const ecefAxis = (x: number, y: number, z: number) => {
    const e = [c * x + sn * y, -sn * x + c * y, z];
    const enu = mat3Vec(ecefToEnuMatrix(lat, lon), e as [number, number, number]);
    return new THREE.Vector3(enu[0], enu[2], -enu[1]);
  };
  return new THREE.Matrix4().makeBasis(ecefAxis(1, 0, 0), ecefAxis(0, 1, 0), ecefAxis(0, 0, 1));
}

const starVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute vec3 color;
  attribute float phase;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uTwinkle;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    // Twinkling (seeing through the air only): a few quick, uneven flickers per second.
    float tw = 1.0 + uTwinkle * 0.35 * sin(uTime * (7.0 + 5.0 * phase) + phase * 40.0) * sin(uTime * 2.3 + phase * 17.0);
    vColor = color * tw;
    gl_PointSize = size * uPixelRatio;
  }
`;

const starFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uFade;
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // A sharp core with a soft halo.
    float a = exp(-r2 * 4.0) + 0.2 * exp(-r2 * 1.2);
    gl_FragColor = vec4(vColor * a * uFade, 1.0);
  }
`;

const milkyVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const milkyFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uFade;
  uniform mat3 uEqToGal;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 g = uEqToGal * normalize(vDir);
    float b = asin(clamp(g.z, -1.0, 1.0));
    float l = atan(g.y, g.x);
    // A thin bright band and a wider faint one, swelling toward the galactic centre (l = 0).
    float core = exp(-l * l / (2.0 * 0.55 * 0.55));
    float band = exp(-b * b / (2.0 * 0.075 * 0.075)) * (0.55 + 1.3 * core) + 0.35 * exp(-b * b / (2.0 * 0.22 * 0.22)) * (0.5 + core);
    band += 0.8 * core * exp(-b * b / (2.0 * 0.16 * 0.16));
    // Mottled star clouds, and the dark dust lanes along the middle of the band.
    float clouds = 0.45 + 0.9 * fbm(g * 7.0);
    float dust = smoothstep(0.35, 0.75, fbm(g * 11.0 + 3.1)) * exp(-b * b / (2.0 * 0.05 * 0.05));
    float i = band * clouds * (1.0 - 0.75 * dust);
    vec3 col = mix(vec3(0.75, 0.8, 1.0), vec3(1.0, 0.9, 0.75), core);
    gl_FragColor = vec4(col * i * 0.035 * uFade, 1.0);
  }
`;

export class StarSky {
  readonly group = new THREE.Group();
  private starMat: THREE.ShaderMaterial;
  private milkyMat: THREE.ShaderMaterial;

  constructor(sunWorld: THREE.Vector3) {
    this.group.name = 'StarSky';
    this.group.matrixAutoUpdate = false;
    const rot = celestialToWorld(sunWorld);
    this.rotation.setFromRotationMatrix(rot);
    this.rotation0.copy(this.rotation);

    // Stars: the bright catalogue ones, then the faint ones (more toward the Milky Way; about
    // three times as many per magnitude fainter).
    const dirs: THREE.Vector3[] = [];
    const mags: number[] = [];
    const cols: THREE.Color[] = [];
    for (const [ra, dec, mag, bv] of BRIGHT) {
      dirs.push(equatorial(ra, dec));
      mags.push(mag);
      cols.push(starColor(bv));
    }
    const rand = rng(20251225);
    const lo = 10 ** (0.5 * 3.2);
    const hi = 10 ** (0.5 * 7.0);
    while (dirs.length < BRIGHT.length + FAINT_STARS) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const d = new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z);
      const b = galacticLatitude(d);
      if (rand() > 0.3 + 0.7 * Math.exp(-(b * b) / (2 * 0.2 * 0.2))) continue;
      dirs.push(d);
      mags.push(Math.log10(lo + rand() * (hi - lo)) / 0.5);
      // Mostly white and yellowish, some blue, some orange.
      cols.push(starColor(-0.2 + 1.9 * rand() ** 1.6));
    }
    const n = dirs.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set([dirs[i].x * SKY_R, dirs[i].y * SKY_R, dirs[i].z * SKY_R], i * 3);
      // Brightness from magnitude (compressed a little, as the eye / a camera sees a star
      // field): size carries some of it for the brightest.
      const m = mags[i];
      // (Strongly compressed: after tone mapping a true-to-flux 6th-magnitude star is invisible.)
      const bright = Math.min(3.0, 2.3 * 10 ** (-0.4 * m * 0.36));
      const c = cols[i];
      col.set([c.r * bright, c.g * bright, c.b * bright], i * 3);
      size[i] = 2.6 + Math.max(0, 3 - m) * 1.2;
      phase[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: { uFade: { value: 1 }, uPixelRatio: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: 0 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const points = new THREE.Points(geo, this.starMat);
    points.frustumCulled = false;
    points.renderOrder = -9;

    const eqToGal = new THREE.Matrix3().set(...(EQ_TO_GAL.flat() as [number, number, number, number, number, number, number, number, number]));
    this.milkyMat = new THREE.ShaderMaterial({
      vertexShader: milkyVertex,
      fragmentShader: milkyFragment,
      uniforms: { uFade: { value: 1 }, uEqToGal: { value: eqToGal } },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const milky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R * 1.02, 64, 32), this.milkyMat);
    milky.frustumCulled = false;
    milky.renderOrder = -10;

    this.group.add(milky, points);
  }

  private rotation = new THREE.Quaternion();
  /** The sky's orientation at day angle 0 (see spin). */
  private rotation0 = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);

  /** Turn the sky with the day: `turn` is the Earth's rotation since day angle 0 (world axes). */
  spin(turn: THREE.Quaternion): void {
    this.rotation.multiplyQuaternions(turn, this.rotation0);
  }

  /**
   * Follow the camera and set how visible the sky is.
   * dark: 0 in daylight (the eye / camera is adapted to the bright scene), 1 at night or in the
   * Earth's shadow. air: 0 in space, 1 at the ground (twinkling).
   */
  update(camera: THREE.Camera, dark: number, air: number, time: number, pixelRatio: number): void {
    this.group.matrix.compose(camera.position, this.rotation, this.one);
    this.group.matrixWorldNeedsUpdate = true;
    this.starMat.uniforms.uFade.value = dark;
    this.starMat.uniforms.uTwinkle.value = air;
    this.starMat.uniforms.uTime.value = time;
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
    this.milkyMat.uniforms.uFade.value = dark * dark;
    this.group.visible = dark > 0.003;
  }
}
