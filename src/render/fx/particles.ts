// GPU smoke / steam / vapor particles. Each particle is written once at spawn (position,
// velocity, spawn time, lifetime, size, kind); the vertex shader integrates its motion
// analytically from simulation time, so the CPU only touches newly spawned slots and the effect
// follows time warp and pause for free. Positions are relative to an anchor object (placed with
// the floating origin), so float32 is plenty within the few km the effects span.
//
// Motion: velocity decays with drag k toward the wind, plus a constant acceleration
// (buoyancy for steam, sinking for cold vapor):  p = p0 + wind*t + (v0 - wind)(1 - e^{-kt})/k + a t^2/2.

import * as THREE from 'three';

export interface ParticleKind {
  /** Base colour (linear). */
  color: THREE.Color;
  /** Drag rate, 1/s. */
  drag: number;
  /** Constant vertical acceleration, m/s^2 (+ up). */
  lift: number;
  /** Peak opacity. */
  opacity: number;
  /** How much the particle glows orange near a running engine (0..1). */
  glowPickup: number;
  /**
   * Motion streak, seconds: > 0 draws a droplet stretched along its screen-space velocity (like
   * a camera's exposure), instead of a soft puff.
   */
  streak?: number;
}

/** Number of particle kinds the shaders support. */
const KINDS = 6;

export interface Spawn {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  size0: number;
  size1: number;
}

const vertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aPos;
  attribute vec3 aVel;
  // spawn time, life, size0, size1
  attribute vec4 aTime;
  // kind index, random seed
  attribute vec2 aKind;
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uGround;
  uniform vec3 uDrag[${KINDS}];   // drag, lift, opacity per kind
  uniform float uStreak[${KINDS}];
  varying vec2 vUv;
  varying float vStreak;
  varying float vAlpha;
  varying float vKind;
  varying float vSeed;
  varying vec3 vWorld;
  varying float vAge;
  varying vec3 vTurn;
  varying float vHigh;
  void main() {
    vTurn = vec3(1.0, 0.0, 0.0);
    vHigh = 1.0;
    float age = uTime - aTime.x;
    float life = aTime.y;
    int kind = int(aKind.x + 0.5);
    vec3 dl = uDrag[kind];
    if (age < 0.0 || age > life) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float k = dl.x;
    float decay = k > 0.0 ? (1.0 - exp(-k * age)) / k : age;
    vec3 p = aPos + uWind * age + (aVel - uWind) * decay + vec3(0.0, 0.5 * dl.y * age * age, 0.0);
    // Don't sink through the ground plane of the anchor (pad level), for effects anchored there.
    float ground = 0.3 * aTime.z;
    bool landed = uGround > 0.5 && p.y < ground;
    if (uGround > 0.5) p.y = max(p.y, ground);
    float f = age / life;
    // Puffs grow fast at first, then slowly.
    float size = mix(aTime.z, aTime.w, 1.0 - pow(1.0 - f, 2.2));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float streak = uStreak[kind];
    vStreak = streak;
    vec2 c = position.xy;
    float streakFade = 1.0;
    if (streak > 0.0) {
      // Droplet: stretched along its current velocity projected on the screen.
      vec3 vel = uWind + (aVel - uWind) * (k > 0.0 ? exp(-k * age) : 1.0) + vec3(0.0, dl.y * age, 0.0);
      vec2 sv = (modelViewMatrix * vec4(vel, 0.0)).xy;
      float sl = length(sv);
      vec2 along = sl > 1e-3 ? sv / sl : vec2(0.0, 1.0);
      // Right-handed with "along" (like x with y), so the quad keeps its winding (not culled).
      vec2 across = vec2(along.y, -along.x);
      // At least ~1.5 px wide on screen; thinner spray fades instead of vanishing into aliasing.
      float minW = 0.0025 * max(1.0, -mv.z);
      float wide = max(size, minW);
      streakFade = size / wide;
      mv.xy += across * c.x * wide * 0.6 + along * c.y * (size + sl * streak);
    } else {
      float rot = aKind.y * 6.2832 + age * (aKind.y - 0.5) * 0.3;
      vTurn.xy = vec2(cos(rot), sin(rot));
      c = vec2(c.x * vTurn.x - c.y * vTurn.y, c.x * vTurn.y + c.y * vTurn.x);
      mv.xy += c * size;
    }
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    vUv = position.xy + 0.5;
    vTurn.z = f;
    // (How high in its cloud, for one on the ground: 0 at the ground, 1 a few puffs up.)
    if (uGround > 0.5) vHigh = clamp(p.y / max(2.5 * size, 20.0), 0.0, 1.0);
    vAlpha = dl.z * smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.55, 1.0, f));
    // Water that has come down onto the ground is spent: only a faint splash remains.
    if (landed && streak > 0.0) vAlpha *= 0.25;
    vAlpha *= streakFade;
    vKind = aKind.x;
    vSeed = aKind.y;
    vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
    vAge = age;
  }
`;

const fragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uPuff;
  uniform vec3 uColor[${KINDS}];
  uniform float uGlowPickup[${KINDS}];
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uGlowPos[2];
  uniform float uGlowPower[2];
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  varying float vSeed;
  varying vec3 vWorld;
  varying float vAge;
  varying float vStreak;
  // (The puff's turn on the screen: cos, sin; how far through its life it is.)
  varying vec3 vTurn;
  varying float vHigh;
  void main() {
    #include <logdepthbuf_fragment>
    int kind = int(vKind + 0.5);
    if (vStreak > 0.0) {
      // Droplet streak: a soft, rounded teardrop, brightest along its middle, with a little
      // per-droplet variation so a jet reads as many drops rather than one smear.
      vec2 q = (vUv - 0.5) * 2.0;
      float core = pow(clamp(1.0 - length(q), 0.0, 1.0), 1.4);
      float a = core * vAlpha * (0.6 + 0.4 * fract(vSeed * 91.7));
      if (a < 0.004) discard;
      // Water scatters sunlight forward: glints when looking toward the sun.
      vec3 view = normalize(-vWorld);
      float glint = pow(max(0.0, dot(-view, uSunDir)), 6.0);
      vec3 col = uColor[kind] * (uAmbient * 1.3 + uSunColor * (0.75 + 1.8 * glint));
      vec3 glow = vec3(0.0);
      for (int i = 0; i < 2; i++) {
        vec3 d = uGlowPos[i] - vWorld;
        glow += vec3(1.0, 0.55, 0.22) * uGlowPower[i] / (dot(d, d) + 400.0);
      }
      col += uColor[kind] * glow * uGlowPickup[kind];
      gl_FragColor = vec4(col, a);
      return;
    }
    // One of four puff shapes in a 2x2 atlas, either way round.
    vec2 cell = vec2(step(0.5, fract(vSeed * 7.13)), step(0.5, fract(vSeed * 3.71)));
    float flip = step(0.5, fract(vSeed * 13.37));
    vec2 puv = vec2(mix(vUv.x, 1.0 - vUv.x, flip), vUv.y);
    vec4 puff = texture2D(uPuff, (puv + cell) * 0.5);
    // It thins from its edges inward as it ages, the lumps of its middle the last to go: breaking
    // up into wisps, not one round shape fading all at once.
    float gone = 0.5 * pow(vTurn.z, 1.8);
    float a = puff.a * smoothstep(gone, gone + 0.3, puff.b + 0.05) * vAlpha;
    if (a < 0.004) discard;
    // Lit as the lumpy thing it is: its surface's slope (the texture's, turned as the puff is)
    // against the sun, as the camera sees it. Sunlit on the sun's side, in its own shade on the
    // other; the sky lights the rest, more from above. (No glow at its thin edges with the sun
    // behind: that drew a bright line round every puff, each one cut out of the cloud.)
    vec3 n = vec3(puff.rg * 2.0 - 1.0, 0.0);
    n.x *= 1.0 - 2.0 * flip;
    n.xy = vec2(n.x * vTurn.x - n.y * vTurn.y, n.x * vTurn.y + n.y * vTurn.x);
    n.z = sqrt(max(0.04, 1.0 - dot(n.xy, n.xy)));
    vec3 sunV = normalize(mat3(viewMatrix) * uSunDir);
    vec3 upV = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
    float facing = clamp((dot(n, sunV) + 0.45) / 1.45, 0.0, 1.0);
    // (And as part of its cloud: down among the others little sun gets in, and less sky.)
    float deep = mix(0.55, 1.0, vHigh);
    float lit = mix(0.5, 1.0, facing) * deep * (0.6 + 0.4 * max(uSunDir.y, 0.0));
    float sky = (0.88 + 0.12 * dot(n, upV)) * mix(0.8, 1.0, vHigh);
    vec3 col = uColor[kind] * (uAmbient * sky + uSunColor * lit) * mix(1.0, 0.9, smoothstep(0.55, 0.95, puff.b));
    // Orange glow from nearby running engines.
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      vec3 d = uGlowPos[i] - vWorld;
      glow += vec3(1.0, 0.55, 0.22) * uGlowPower[i] / (dot(d, d) + 400.0);
    }
    col += uColor[kind] * glow * uGlowPickup[kind];
    gl_FragColor = vec4(col, a);
  }
`;

/**
 * Four puffs in a 2x2 atlas: billowing smoke, not a ball. a: how thick it is; b: how deep into
 * it (the lumps of its middle high, its wisps low: what's left as it thins); r, g: its surface's
 * slope across and up (0.5: facing the camera), to light it by.
 *
 * (They were clusters of round blobs shaded from the top: lit the same from every side and all
 * of a shape, a launch's exhaust was a pile of cotton wool.)
 */
function puffTexture(): THREE.DataTexture {
  const N = 256;
  const W = N * 2;
  const data = new Uint8Array(W * W * 4);
  // Smooth noise on a lattice of hashed values, and sums of it.
  const hash = (x: number, y: number, s: number): number => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483629) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x: number, y: number, s: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  /** Billows: rounded lumps, finer ones on the larger. */
  const billow = (x: number, y: number, s: number): number => {
    let sum = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 5; o++) {
      // (Rounded: creased where two lumps meet, it lit like crumpled paper.)
      const v = noise(x * f, y * f, s + o * 17);
      sum += amp * v * v * (3 - 2 * v);
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / 0.96875;
  };
  const height = new Float32Array(N * N);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * N;
    const oy = Math.floor(cell / 2) * N;
    const seed = 101 + cell * 37;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 - 1;
        const y = ((j + 0.5) / N) * 2 - 1;
        // (Its outline pushed in and out, so no two are round the same way.)
        const wx = x + 0.4 * (noise(x * 1.7 + 3, y * 1.7, seed + 5) - 0.5);
        const wy = y + 0.4 * (noise(x * 1.7, y * 1.7 + 9, seed + 6) - 0.5);
        const r = Math.hypot(wx, wy);
        const body = 1 - THREE.MathUtils.smoothstep(r, 0.0, 0.98);
        height[j * N + i] = body * (0.6 + 0.4 * billow(x * 2.2 + 11, y * 2.2 + 7, seed));
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 - 1;
        const y = ((j + 0.5) / N) * 2 - 1;
        const h = height[j * N + i];
        const hx = height[j * N + Math.min(N - 1, i + 1)] - height[j * N + Math.max(0, i - 1)];
        const hy = height[Math.min(N - 1, j + 1) * N + i] - height[Math.max(0, j - 1) * N + i];
        // (The slope of its lumps, on a ball's: facing out toward its rim.)
        let nx = -hx * N * 0.04 + 0.3 * x;
        let ny = -hy * N * 0.04 + 0.3 * y;
        const nl = Math.hypot(nx, ny);
        if (nl > 0.96) {
          nx *= 0.96 / nl;
          ny *= 0.96 / nl;
        }
        // (Nothing at the quad's edge, whatever the noise says.)
        const rim = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y), 0.82, 0.99);
        const k = ((oy + j) * W + ox + i) * 4;
        data[k] = Math.round(255 * (nx * 0.5 + 0.5));
        data[k + 1] = Math.round(255 * (ny * 0.5 + 0.5));
        data[k + 2] = Math.round(255 * Math.min(1, h * 1.15));
        // (Thick only well inside: a soft edge, so a crowd of them is one cloud and not a pile.)
        data[k + 3] = Math.round(255 * THREE.MathUtils.smoothstep(h, 0.02, 0.58) * rim);
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aTime: THREE.InstancedBufferAttribute;
  private aKind: THREE.InstancedBufferAttribute;
  private next = 0;
  private lastTime = -Infinity;
  private dirty = { lo: Infinity, hi: -Infinity };
  readonly uniforms;

  constructor(
    private capacity: number,
    kinds: ParticleKind[],
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = attr(3);
    this.aVel = attr(3);
    this.aTime = attr(4);
    this.aKind = attr(2);
    // Mark every slot long dead.
    for (let i = 0; i < capacity; i++) this.aTime.setXYZW(i, -1e9, 1, 0, 0);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aVel', this.aVel);
    this.geo.setAttribute('aTime', this.aTime);
    this.geo.setAttribute('aKind', this.aKind);
    this.geo.instanceCount = capacity;

    const pad = <T>(list: T[], fill: T) => [...list, ...Array(KINDS - list.length).fill(fill)].slice(0, KINDS);
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      /** 1: particles stay above the anchor's ground plane (y = 0); 0: no ground (a vehicle-anchored effect). */
      uGround: { value: 1 },
      uDrag: { value: pad(kinds.map((k) => new THREE.Vector3(k.drag, k.lift, k.opacity)), new THREE.Vector3()) },
      uColor: { value: pad(kinds.map((k) => k.color), new THREE.Color()) },
      uGlowPickup: { value: pad(kinds.map((k) => k.glowPickup), 0) },
      uStreak: { value: pad(kinds.map((k) => k.streak ?? 0), 0) },
      uPuff: { value: puffTexture() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.3, 0.33, 0.38) },
      uGlowPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uGlowPower: { value: [0, 0] },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    // Draw after the plumes' additive pass so smoke can occlude the exhaust a little.
    this.mesh.renderOrder = 2;
  }

  /** Advance to simulation time t. Going backwards (reset) clears everything. */
  setTime(t: number): void {
    if (t < this.lastTime - 1e-6) this.clear();
    this.lastTime = t;
    this.uniforms.uTime.value = t;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.aTime.setXYZW(i, -1e9, 1, 0, 0);
    this.aTime.clearUpdateRanges();
    this.aTime.needsUpdate = true;
    this.dirty = { lo: Infinity, hi: -Infinity };
  }

  /** Spawn one particle of `kind` at time t (within the current frame's interval). */
  emit(kind: number, s: Spawn, t: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.aPos.setXYZ(i, s.pos.x, s.pos.y, s.pos.z);
    this.aVel.setXYZ(i, s.vel.x, s.vel.y, s.vel.z);
    this.aTime.setXYZW(i, t, s.life, s.size0, s.size1);
    this.aKind.setXY(i, kind, Math.random());
    this.dirty.lo = Math.min(this.dirty.lo, i);
    this.dirty.hi = Math.max(this.dirty.hi, i);
  }

  /** Upload the slots written since the last flush. */
  flush(): void {
    if (this.dirty.hi < 0) return;
    const { lo, hi } = this.dirty;
    for (const [a, n] of [[this.aPos, 3], [this.aVel, 3], [this.aTime, 4], [this.aKind, 2]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * n, (hi - lo + 1) * n);
      a.needsUpdate = true;
    }
    this.dirty = { lo: Infinity, hi: -Infinity };
  }
}
