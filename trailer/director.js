// Hype trailer director: drives the game through a fast, beat-synced shot list and records it
// (1920x1080 MP4). The soundtrack is synthesized here (a driving 126 bpm track with risers,
// drops and impacts) and mixed with the game's own sound, tapped silently: the speakers stay
// muted. The music runs in its own AudioContext, suspended whenever the recording is paused, so
// it plays on seamlessly across the cuts.
const D = window.__debug;
const W = 1920;
const H = 1080;
const FONT = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (window.__trailer = { log: [], done: false, error: null });
const say = (m) => status.log.push(`${(performance.now() / 1000).toFixed(1)} ${m}`);

// --- The game ------------------------------------------------------------------------------
const game = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : undefined }));
const clickNav = (label) => [...document.querySelectorAll('[data-i]')].find((b) => b.textContent.trim() === label)?.click();
function clockText() {
  return document.querySelector('.wc-clock')?.textContent.replace(/\s+/g, '') ?? '';
}
function mt() {
  const m = clockText().match(/T([+-])(\d+):(\d+):(\d+)/);
  if (!m) return null;
  const s = +m[2] * 3600 + +m[3] * 60 + +m[4];
  return m[1] === '-' ? -s : s;
}
async function until(fn, timeout = 90000, step = 30) {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > timeout) throw new Error('timeout waiting');
    await sleep(step);
  }
}
const atMt = (t, timeout) => until(() => (mt() ?? -1e9) >= t, timeout);
const logHas = (re) => [...document.querySelectorAll('#log div')].some((d) => re.test(d.textContent));

// --- Music ---------------------------------------------------------------------------------
const BPM = 126;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const mctx = new AudioContext({ sampleRate: 48000 });
const mdest = mctx.createMediaStreamDestination();
const mbus = mctx.createGain();
mbus.gain.value = 0.85;
const mcomp = mctx.createDynamicsCompressor();
mcomp.threshold.value = -10;
mcomp.ratio.value = 3;
mbus.connect(mcomp).connect(mdest);
const verb = mctx.createConvolver();
{
  const len = mctx.sampleRate * 2.8;
  const b = mctx.createBuffer(2, len, mctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  verb.buffer = b;
}
const verbOut = mctx.createGain();
verbOut.gain.value = 0.35;
verb.connect(verbOut).connect(mbus);
const noise = (() => {
  const b = mctx.createBuffer(1, mctx.sampleRate * 2, mctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
})();
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
function env(g, t, a, peak, dec, sustain = 0) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + dec);
}
function noiseSrc(t, dur) {
  const n = mctx.createBufferSource();
  n.buffer = noise;
  n.loop = true;
  n.start(t, Math.random());
  n.stop(t + dur);
  return n;
}
const sfx = {
  kick(t, v = 1) {
    const o = mctx.createOscillator();
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = mctx.createGain();
    env(g, t, 0.003, 1.0 * v, 0.38);
    o.connect(g).connect(mbus);
    o.start(t);
    o.stop(t + 0.45);
  },
  clap(t) {
    const n = noiseSrc(t, 0.3);
    const f = mctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1600;
    f.Q.value = 0.9;
    const g = mctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (const k of [0, 0.011, 0.022]) {
      g.gain.setValueAtTime(0.5, t + k);
      g.gain.exponentialRampToValueAtTime(0.08, t + k + 0.009);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(f).connect(g);
    g.connect(mbus);
    g.connect(verb);
  },
  hat(t, open = false) {
    const n = noiseSrc(t, 0.25);
    const f = mctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 8000;
    const g = mctx.createGain();
    env(g, t, 0.002, 0.16, open ? 0.18 : 0.035);
    n.connect(f).connect(g).connect(mbus);
  },
  bass(t, midi, len) {
    const f = mctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(220, t + len);
    f.Q.value = 4;
    const g = mctx.createGain();
    // (Ducked under the kick: silent at the beat, up by the off-beat.)
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    for (const [type, mult, det] of [['sawtooth', 1, -7], ['sawtooth', 1, 7], ['square', 0.5, 0]]) {
      const o = mctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(midi) * mult;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + len + 0.02);
    }
    f.connect(g).connect(mbus);
  },
  pad(t, notes, len, level = 0.05) {
    // (Swells in and fades out over the next chord's start: legato, no hard edge each bar.)
    const f = mctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g = mctx.createGain();
    const end = len + 0.9;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.9);
    g.gain.setValueAtTime(level, t + len - 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + end);
    len = end;
    for (const m of notes) {
      for (const det of [-9, 0, 9]) {
        const o = mctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + len + 0.05);
      }
    }
    f.connect(g);
    g.connect(mbus);
    g.connect(verb);
  },
  braam(t, root = 33, len = 3.2) {
    const f = mctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(150, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.14);
    f.frequency.exponentialRampToValueAtTime(420, t + len);
    const g = mctx.createGain();
    env(g, t, 0.02, 0.5, len);
    for (const iv of [-12, 0, 7, 12, 15]) {
      for (const det of [-12, 12]) {
        const o = mctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(root + 12 + iv);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + len + 0.1);
      }
    }
    f.connect(g);
    g.connect(mbus);
    g.connect(verb);
  },
  impact(t, v = 1) {
    const o = mctx.createOscillator();
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 1.4);
    const g = mctx.createGain();
    env(g, t, 0.005, 1.1 * v, 2.2);
    o.connect(g).connect(mbus);
    o.start(t);
    o.stop(t + 2.4);
    const n = noiseSrc(t, 1.2);
    const f = mctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5000, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.9);
    const ng = mctx.createGain();
    env(ng, t, 0.002, 0.7 * v, 0.9);
    n.connect(f).connect(ng);
    ng.connect(mbus);
    ng.connect(verb);
  },
  riser(t, dur, v = 1) {
    const n = noiseSrc(t, dur + 0.05);
    const f = mctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(250, t);
    f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = mctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45 * v, t + dur);
    g.gain.setValueAtTime(0.0001, t + dur + 0.01);
    n.connect(f).connect(g).connect(mbus);
    const o = mctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(900, t + dur);
    const of = mctx.createBiquadFilter();
    of.type = 'lowpass';
    of.frequency.value = 2500;
    const og = mctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.09 * v, t + dur);
    og.gain.setValueAtTime(0.0001, t + dur + 0.01);
    o.connect(of).connect(og).connect(mbus);
    o.start(t);
    o.stop(t + dur + 0.05);
    // A snare roll speeding up into the drop.
    let k = t + dur * 0.5;
    let step = BEAT / 2;
    while (k < t + dur - 0.02) {
      sfx.clap(k);
      k += step;
      if (k > t + dur * 0.75) step = BEAT / 4;
    }
  },
  crash(t, v = 0.5) {
    const n = noiseSrc(t, 2.2);
    const f = mctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 5000;
    const g = mctx.createGain();
    env(g, t, 0.004, v, 2.0);
    n.connect(f).connect(g);
    g.connect(mbus);
    g.connect(verb);
  },
  whoosh(t) {
    const n = noiseSrc(t, 0.9);
    const f = mctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(6000, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.8);
    const g = mctx.createGain();
    env(g, t, 0.05, 0.35, 0.75);
    n.connect(f).connect(g).connect(mbus);
  },
  tick(t) {
    const o = mctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 2200;
    const g = mctx.createGain();
    env(g, t, 0.001, 0.12, 0.03);
    o.connect(g).connect(mbus);
    o.start(t);
    o.stop(t + 0.06);
  },
  drone(t, dur) {
    const f = mctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const lfo = mctx.createOscillator();
    lfo.frequency.value = BPM / 60 / 2;
    const lg = mctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(f.frequency);
    lfo.start(t);
    lfo.stop(t + dur);
    const g = mctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 1.5);
    g.gain.setValueAtTime(0.28, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [m, det] of [[21, -6], [21, 6], [33, 0]]) {
      const o = mctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(m);
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    f.connect(g).connect(mbus);
  },
};
// The groove: four on the floor, claps on 2 and 4, off-beat hats, a driving 8th-note bass over
// Am - F - C - G. 'half' is the breakdown (kick on 1 and 3, pads up).
const CHORDS = [
  { root: 33, notes: [57, 60, 64] },
  { root: 29, notes: [53, 57, 60] },
  { root: 36, notes: [55, 60, 64] },
  { root: 31, notes: [55, 59, 62] },
];
const groove = { on: false, t0: 0, n: 0, mode: 'full' };
function grooveStart(t, mode = 'full') {
  groove.on = true;
  groove.t0 = t;
  groove.n = 0;
  groove.mode = mode;
}
setInterval(() => {
  if (!groove.on || mctx.state !== 'running') return;
  for (;;) {
    const t = groove.t0 + groove.n * (BEAT / 2);
    if (t > mctx.currentTime + 0.15) break;
    const eighth = groove.n % 8;
    const beat = Math.floor(eighth / 2);
    const bar = Math.floor(groove.n / 8);
    const ch = CHORDS[bar % 4];
    if (t >= mctx.currentTime - 0.02) {
      const full = groove.mode === 'full';
      if (eighth % 2 === 0 && (full || beat % 2 === 0)) sfx.kick(t, full ? 1 : 0.8);
      if (full && eighth % 2 === 0 && beat % 2 === 1) sfx.clap(t);
      if (eighth % 2 === 1) sfx.hat(t, beat === 3 && full);
      if (full) sfx.bass(t, ch.root, BEAT / 2 - 0.01);
      if (eighth === 0) sfx.pad(t, ch.notes, BAR, full ? 0.022 : 0.035);
    }
    groove.n++;
  }
}, 25);
/** The music time of the next bar line (with the groove on). */
function nextBar(after = mctx.currentTime) {
  const k = Math.ceil((after - groove.t0) / BAR - 1e-6);
  return groove.t0 + k * BAR;
}
const atMusic = (t) => until(() => mctx.currentTime >= t, 60000, 10);

// --- The frame -----------------------------------------------------------------------------------
const out = document.createElement('canvas');
out.dataset.trailer = '';
out.width = W;
out.height = H;
const g = out.getContext('2d');
const fx = { black: 1, flash: 0, shake: 0, shakeBase: 0, bars: 1, titles: [] };
let move = null;
let last = performance.now();
const easeOut = (k) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;
function spaced(text, x, y, font, spacing, align = 'center') {
  g.font = font;
  g.letterSpacing = `${spacing}px`;
  g.textAlign = align;
  g.fillText(text, x, y);
  g.letterSpacing = '0px';
}
/**
 * A title: a small label slides in over a growing rule, the title eases up under it, holds, and
 * both fade. where: 'left' (lower left), 'top' (over the game's interface), 'center'.
 */
function title(kicker, main, { hold = 3, where = 'left', size = 96 } = {}) {
  fx.titles.push({ kicker, main, where, size, hold, t0: performance.now() });
}
function drawTitle(ti, now) {
  const t = (now - ti.t0) / 1000;
  const inK = easeOut(t / 0.8);
  const outK = t > ti.hold ? easeOut((t - ti.hold) / 0.7) : 0;
  const a = inK * (1 - outK);
  if (a <= 0.001) return;
  const center = ti.where !== 'left' && ti.where !== 'right';
  const x = center ? W / 2 : ti.where === 'right' ? W - 120 : 120;
  const y = ti.where === 'left' || ti.where === 'right' ? H - 250 : ti.where === 'top' ? 250 : ti.where === 'end' ? H / 2 + 215 : ti.where === 'foot' ? H - 175 : ti.where === 'foot2' ? H - 143 : H / 2 - 30;
  const align = center ? 'center' : ti.where === 'right' ? 'right' : 'left';
  g.save();
  g.shadowColor = center ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.55)';
  g.shadowBlur = center ? 36 : 24;
  if (ti.kicker) {
    g.globalAlpha = easeOut((t - 0.05) / 0.6) * (1 - outK);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    const slide = center ? 0 : (1 - inK) * (align === 'right' ? 24 : -24);
    spaced(ti.kicker, x + slide, y, `600 23px ${FONT}`, 8, align);
    const lw = (center ? 260 : 200) * easeOut((t - 0.15) / 0.9);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.shadowBlur = 0;
    g.fillRect(center ? x - lw / 2 : align === 'right' ? x - lw : x, y + 18, lw, 2);
    g.shadowBlur = 24;
  }
  g.globalAlpha = easeOut((t - 0.2) / 0.8) * (1 - outK);
  g.fillStyle = '#fff';
  const rise = (1 - easeOut((t - 0.2) / 0.9)) * 28;
  spaced(ti.main, x, y + 18 + ti.size * 0.95 + rise, `700 ${ti.size}px ${FONT}`, ti.size * 0.07, align);
  g.restore();
}

// The game's own interface, drawn over the 3D view in gameplay shots.
const hud = { on: false, img: null, hide: [] };
let snap = null;
(async function hudLoop() {
  for (;;) {
    if (hud.on && snap) {
      const a = performance.now();
      try {
        const img = await snap(hud.hide, W / innerWidth);
        if (hud.on) hud.img = img;
      } catch (e) {
        say(`hud ${e}`);
      }
      await sleep(Math.max(0, 200 - (performance.now() - a)));
    } else await sleep(60);
  }
})();
async function hudOn(hide = []) {
  hud.hide = hide;
  hud.img = null;
  hud.on = true;
  await until(() => hud.img, 5000);
}
function hudOff() {
  hud.on = false;
  hud.img = null;
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (move) move(dt);
  fx.flash = Math.max(0, fx.flash - dt * 2.5);
  fx.shake = Math.max(fx.shakeBase, fx.shake * Math.exp(-dt / 0.45));
  const sh = fx.shake;
  const zoom = 1 + 0.03 * Math.min(1, sh * 2) + 0.005;
  const ox = (Math.random() - 0.5) * 26 * sh;
  const oy = (Math.random() - 0.5) * 26 * sh;
  const s = Math.max(W / game.width, H / game.height) * zoom;
  const dw = game.width * s;
  const dh = game.height * s;
  g.filter = 'contrast(1.08) saturate(1.12)';
  g.drawImage(game, (W - dw) / 2 + ox, (H - dh) / 2 + oy, dw, dh);
  g.filter = 'none';
  if (hud.on && hud.img) g.drawImage(hud.img, 0, 0, W, H);
  if (!hud.on) {
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }
  fx.titles = fx.titles.filter((ti) => (now - ti.t0) / 1000 < ti.hold + 0.8);
  for (const ti of fx.titles) drawTitle(ti, now);
  if (fx.bars > 0 && !hud.on) {
    g.fillStyle = '#000';
    const b = 80 * fx.bars;
    g.fillRect(0, 0, W, b);
    g.fillRect(0, H - b, W, b);
  }
  if (fx.flash > 0) {
    g.fillStyle = `rgba(255,255,255,${Math.min(1, fx.flash)})`;
    g.fillRect(0, 0, W, H);
  }
  if (fx.black > 0) {
    g.fillStyle = `rgba(0,0,0,${fx.black})`;
    g.fillRect(0, 0, W, H);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
async function tween(set, from, to, ms) {
  const t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms);
    set(from + (to - from) * k * k * (3 - 2 * k));
    if (k >= 1) return;
    await sleep(16);
  }
}
/** A big moment: a soft white flash and a shake; crash: a cymbal crash on it (no pitched boom). */
function hit({ flash = 0.55, shake = 0.8, crash = 0 } = {}) {
  fx.flash = flash;
  fx.shake = shake;
  if (crash) sfx.crash(mctx.currentTime + 0.01, crash);
}

// --- Recording -------------------------------------------------------------------------------
const ae = D.audioEngine;
const actx = ae.ctx;
const dest = actx.createMediaStreamDestination();
const tap = actx.createGain();
tap.gain.value = 0;
const GAME_LEVEL = 0.6;
const comp = actx.createDynamicsCompressor();
comp.threshold.value = -12;
comp.ratio.value = 4;
ae.world.connect(tap);
tap.connect(comp).connect(dest);
const musicIn = actx.createMediaStreamSource(mdest.stream);
const musicGain = actx.createGain();
musicGain.gain.value = 1.0;
musicIn.connect(musicGain).connect(comp);
const stream = new MediaStream([...out.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
const rec = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', videoBitsPerSecond: 24e6, audioBitsPerSecond: 256e3 });
const chunks = [];
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
/** Start (or resume) recording; the game's sound fades up rather than cutting in. */
async function roll(gameLevel = GAME_LEVEL) {
  await mctx.resume();
  tap.gain.cancelScheduledValues(actx.currentTime);
  tap.gain.setValueAtTime(0, actx.currentTime);
  tap.gain.linearRampToValueAtTime(gameLevel, actx.currentTime + 0.35);
  if (rec.state === 'inactive') rec.start(1000);
  else if (rec.state === 'paused') rec.resume();
}
/** Pause: the game's sound fades out first, then recording and the music stop. */
async function cut() {
  tap.gain.cancelScheduledValues(actx.currentTime);
  tap.gain.setValueAtTime(tap.gain.value, actx.currentTime);
  tap.gain.linearRampToValueAtTime(0, actx.currentTime + 0.12);
  await sleep(140);
  if (rec.state === 'recording') rec.pause();
  await mctx.suspend();
  hudOff();
}
async function finish(name) {
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/mp4' });
  say(`recorded ${(blob.size / 1e6).toFixed(1)} MB`);
  await fetch(`http://127.0.0.1:8765/save?name=${name}`, { method: 'POST', body: blob });
  say('saved');
}

// --- Scenes & cameras ---------------------------------------------------------------------------
let sceneAt = 0;
async function menuScene(i, settle = 2500) {
  D.menu.open('main');
  await sleep(300);
  D.showScene(i);
  sceneAt = performance.now();
  await sleep(200);
  D.menu.close();
  await sleep(settle);
  say(`scene ${i}`);
}
const sinceScene = (s) => until(() => performance.now() - sceneAt >= s * 1000, 120000);
function cam(mode, az, el, dist) {
  D.rig.mode = mode;
  if (az !== undefined) D.rig.azimuth = az;
  if (el !== undefined) D.rig.elevation = el;
  if (dist !== undefined) D.rig.distance = dist;
}
const drift = (daz = 0.04, ddist = 0) => (move = (dt) => {
  D.rig.azimuth += dt * daz;
  D.rig.distance += dt * ddist;
});
const fadeIn = (ms = 500) => tween((v) => (fx.black = v), fx.black, 0, ms);
const fadeOut = (ms = 450) => tween((v) => (fx.black = v), fx.black, 1, ms);

// --- The trailer --------------------------------------------------------------------------------
async function run() {
  const mod = await import(URL.createObjectURL(new Blob([await fetch('http://127.0.0.1:8765/domsnap.js?' + Date.now()).then((r) => r.text())], { type: 'text/javascript' })));
  snap = await mod.makeSnapper(game);
  D.updateSettings({ muted: true, renderScale: 0.6 });
  // (No metallic ring from the game at the catches: the tower's catch clang and the arms' clank
  // are left out of the trailer's sound; everything else the game makes is kept.)
  const play = D.ambience.play.bind(D.ambience);
  D.ambience.play = (kind, ...rest) => (kind === 'catch' || kind === 'grab' ? undefined : play(kind, ...rest));
  await mctx.suspend();
  say('start');

  // 1. Opening: Starbase at dawn, a low drone; the title.
  await menuScene(0);
  cam('orbit', -2.7, 0.03, 230);
  drift(0.04, 4);
  await roll();
  let t = mctx.currentTime + 0.05;
  sfx.drone(t, 21.5);
  fadeIn(1500);
  await sleep(700);
  title('A STARSHIP FLIGHT SIMULATOR', 'STARSHIP', { where: 'center', size: 150, hold: 4.2 });
  await atMusic(t + BAR * 3.2);
  await fadeOut(700);
  await cut();
  move = null;

  // 2. The game: picking a mission in the main menu.
  D.menu.open('main');
  await sleep(300);
  D.showScene(5);
  await sleep(2600);
  await hudOn();
  await roll(0);
  t = mctx.currentTime;
  fadeIn(400);
  title('9 MISSIONS · FREE ROAM', 'PICK A MISSION', { where: 'right', size: 88, hold: 5.2 });
  await sleep(1300);
  clickNav('Missions');
  await sleep(1400);
  [...document.querySelectorAll('[data-mission]')].find((c) => /catch the booster/i.test(c.textContent))?.click();
  await sleep(1500);
  clickNav('Autopilot');
  await sleep(1400);
  [...document.querySelectorAll('[data-mission]')].find((c) => /flight test/i.test(c.textContent))?.click();
  await atMusic(t + BAR * 4);
  await fadeOut(350);
  await cut();

  // 3. Countdown with the controls in your hands, and the drop at liftoff.
  document.querySelector('.mn-go[data-act="launch"]').click();
  await sleep(4500);
  if (D.menu.isOpen) D.menu.close();
  D.updateSettings({ muted: true });
  cam('orbit', 0.95, 0.02, 190);
  for (let i = 0; i < 20 && (mt() ?? -10) <= -10; i++) {
    if (D.menu.isOpen) D.menu.close();
    key(' ');
    await sleep(1500);
  }
  key('l'); // take manual control: the cockpit comes up at liftoff
  say(`countdown ${mt()}`);
  await hudOn();
  await until(() => clockText() === 'T-00:00:07', 30000, 5);
  await until(() => clockText() === 'T-00:00:06', 5000, 5);
  await roll();
  t = mctx.currentTime;
  const drop = t + 6;
  sfx.riser(t + 1.5, 4.5, 0.9);
  fadeIn(400);
  move = (dt) => (D.rig.distance += dt * 8);
  title('HAND-FLY IT, OR LET THE AUTOPILOT FLY', 'YOU HAVE THE CONTROLS', { where: 'top', size: 80, hold: 4.6 });
  await atMusic(drop - 2);
  fx.shakeBase = 0.08;
  await atMusic(drop);
  grooveStart(drop);
  hit({ flash: 0.45, shake: 0.9, crash: 0.45 });
  await atMusic(drop + BAR * 1.5);
  // Cinematic angles, a cut on each bar.
  hudOff();
  move = null;
  fx.shakeBase = 0.06;
  const angles = [
    () => cam('orbit', 2.5, 0.05, 620),
    () => cam('pad'),
    () => cam('orbit', -0.6, 0.06, 240),
    () => cam('orbit', 1.4, 1.0, 520),
    () => cam('spectator'),
  ];
  angles[0]();
  title('REAL STARBASE · REAL 6-DOF PHYSICS', 'LIFTOFF', { hold: 3.4 });
  for (let i = 1; i < angles.length; i++) {
    await atMusic(drop + BAR * (i + 1.5));
    angles[i]();
  }
  await atMusic(drop + BAR * 6.5);
  // Back in the cockpit: the navball, the throttle, your readouts.
  cam('chase');
  fx.shakeBase = 0.03;
  await hudOn();
  await atMusic(drop + BAR * 8.5);
  fx.shakeBase = 0;
  key('l'); // hand back to the autopilot
  await fadeOut(300);
  await cut();

  // 4. Max-Q and hot staging.
  key('4');
  await atMt(38);
  key('1');
  await atMt(43);
  cam('chase');
  await hudOn();
  await roll();
  fadeIn(300);
  title('LIVE TELEMETRY, JUST LIKE THE WEBCAST', 'THROUGH MAX-Q', { where: 'top', size: 80, hold: 3.2 });
  await atMusic(nextBar() + BAR);
  await fadeOut(300);
  await cut();
  key('4');
  await atMt(126);
  key('1');
  await atMt(133);
  cam('orbit', 1.3, 0.08, 230);
  drift(0.05);
  await roll();
  fadeIn(300);
  title('SHIP ENGINES LIGHT BEFORE SEPARATION', 'HOT STAGING', { hold: 4.2 });
  await atMusic(nextBar() + BAR * 2);
  move = null;
  await fadeOut(300);
  await cut();

  // 5. Super Heavy comes home: the landing burn, then the catch.
  await menuScene(5, 2200);
  cam('orbit', -2.4, 0.1, 420);
  drift(0.04);
  await roll();
  fadeIn(300);
  title('BOOSTBACK · GRID FINS · LANDING BURN', 'CATCH THE BOOSTER', { hold: 4.6 });
  await atMusic(nextBar() + BAR * 1.5);
  await fadeOut(300);
  await cut();
  await sinceScene(26.5);
  cam('orbit', 0.9, 0.55, 230);
  drift(0.03);
  await roll();
  fadeIn(300);
  sfx.riser(mctx.currentTime, 4.2, 0.6);
  await until(() => logHas(/Booster caught/), 20000, 20);
  hit();
  title('ON THE CHOPSTICKS', 'CAUGHT', { where: 'center', size: 150, hold: 2.4 });
  await atMusic(nextBar() + BAR);
  await fadeOut(350);
  move = null;
  await cut();

  // 6. Breakdown: orbit, and a day turning to night.
  groove.mode = 'half';
  await menuScene(3);
  cam('orbit', 0.8, 0.13, 150);
  drift(0.06);
  await roll();
  fadeIn(600);
  title('A REAL EARTH BELOW, DAY AND NIGHT', 'REACH ORBIT', { hold: 3.6 });
  await atMusic(nextBar() + BAR * 1.5);
  await fadeOut(400);
  await cut();
  await menuScene(0);
  cam('orbit', 0.7, 0.22, 900);
  drift(0.06);
  key('8');
  await roll(0.3);
  fadeIn(400);
  title('THE EARTH TURNS: A FULL 24-HOUR DAY', 'SUNRISE TO NIGHTFALL', { hold: 3.2 });
  await atMusic(nextBar() + BAR * 1.5);
  key('1');
  await fadeOut(400);
  move = null;
  await cut();

  // 7. Reentry: back to full, building.
  await menuScene(4);
  cam('orbit', 0.4, -0.35, 95);
  drift(0.08);
  await roll();
  const r0 = nextBar();
  groove.mode = 'full';
  fadeIn(300);
  fx.shakeBase = 0.08;
  title('KEEP THE HEAT SHIELD INTO THE FLOW', 'SURVIVE REENTRY', { hold: 4.4 });
  sfx.riser(r0 + BAR, BAR * 2, 0.7);
  await atMusic(r0 + BAR * 3);
  fx.shakeBase = 0;
  await fadeOut(300);
  move = null;
  await cut();

  // 8. The ship comes home: the flip, then the catch.
  await menuScene(6, 2200);
  await sinceScene(10.5);
  cam('orbit', 1.0, 0.08, 330);
  drift(0.05);
  await roll();
  fadeIn(300);
  title('BELLY FLOP · FLIP · LANDING BURN', 'BRING THE SHIP HOME', { hold: 4.6 });
  await atMusic(nextBar() + BAR * 2.5);
  await fadeOut(300);
  await cut();
  await sinceScene(51);
  cam('orbit', 0.6, 0.3, 240);
  drift(0.04);
  groove.mode = 'half';
  await roll();
  fadeIn(400);
  const caughtWait = until(() => logHas(/Ship caught/), 30000, 15);
  t = mctx.currentTime;
  sfx.riser(t + 2, 5.5, 0.8);
  await caughtWait;
  groove.mode = 'full';
  const caughtAt = mctx.currentTime;
  hit({ flash: 0.6, shake: 1 });
  title('SHIP CAUGHT BY THE TOWER', 'BOTH STAGES HOME', { where: 'center', size: 120, hold: 3 });
  await atMusic(caughtAt + BAR * 2);
  groove.mode = 'half';
  await fadeOut(400);
  move = null;
  await cut();

  // 9. End card.
  await menuScene(0);
  cam('orbit', 0.4, 0.2, 800);
  drift(0.03);
  await roll(0.3);
  t = mctx.currentTime;
  fadeIn(700);
  title('A STARSHIP FLIGHT SIMULATOR', 'STARSHIP', { where: 'center', size: 170, hold: 5.2 });
  await sleep(1800);
  title('', 'MISSIONS  ·  FREE ROAM  ·  HAND-FLOWN OR AUTOPILOT', { where: 'end', size: 34, hold: 3.2 });
  // Credits (the models are CC BY; the imagery and elevation data ask for these lines too).
  title('', 'MODELS: MIKENOTBRICK, CLARENCE365 (CC BY 4.0)  ·  IMAGERY: USDA NAIP, COPERNICUS SENTINEL, NASA BLUE MARBLE', { where: 'foot', size: 19, hold: 3.2 });
  title('', 'ELEVATION: USGS 3DEP, COPERNICUS DEM  ·  © OPENSTREETMAP CONTRIBUTORS  ·  FAN-MADE, NOT AFFILIATED WITH SPACEX', { where: 'foot2', size: 19, hold: 3.2 });
  await sleep(3800);
  mbus.gain.setValueAtTime(mbus.gain.value, mctx.currentTime);
  mbus.gain.linearRampToValueAtTime(0.0001, mctx.currentTime + 2.6);
  await tween((v) => (fx.black = v), 0, 1, 1200);
  await sleep(1600);
  groove.on = false;
  await cut();
  move = null;
  D.ambience.play = play;
  await finish('starship-trailer.mp4');
  D.menu.open('main');
}

run()
  .catch((e) => {
    status.error = String(e?.stack ?? e);
    say(`error ${e}`);
  })
  .finally(() => (status.done = true));
