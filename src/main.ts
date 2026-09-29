import * as THREE from 'three';
import { BOOSTER_LENGTH, SHIP_LENGTH, STARSHIP_V3, SUPER_HEAVY_V3 } from './sim/config/starshipV3';
import type { V3 } from './sim/math';
import type { MenuScene, Snapshot, VehicleSnapshot } from './sim/simulation';
import { CAMERA_LABELS, CameraRig } from './render/cameras';
import { FloatingOrigin, enuToWorld, vehicleQuaternion } from './render/floatingOrigin';
import { type ModelLibrary, loadModels } from './render/models';
import { applyShipSerial } from './render/decals';
import { loadFacilities } from './render/facilities';
import { createLaunchSite } from './render/launchSite';
import { type StarbaseWeather, WEATHER_AVAILABLE, onSettingsChange, settings, updateSettings } from './settings';
import { type PadRig, SUN_AT_DAY0, createWorld } from './render/scene';
import { PAD, RE, RP } from './sim/constants';
import { GlobeTiles } from './render/globeTiles';
import { ecefToWorld, toWorld, worldToGeodetic } from './render/geo';
import { Terrain } from './render/terrain';
import { type MapVehicle, MapView } from './render/mapView';
import type { Trajectory } from './sim/trajectory';
import { VehicleMesh } from './render/vehicleMesh';
import { TargetMarker } from './render/targetMarker';
import { Weather } from './render/weather';
import { Rain } from './render/fx/rain';
import { type FxVehicle, LaunchFx, explosionRadius, vehicleNoise } from './render/fx/launchFx';
import { LaunchAudio } from './audio/launchAudio';
import { AudioEngine } from './audio/engine';
import { Ambience } from './audio/ambience';
import { MenuAudio } from './audio/menuAudio';
import { MOUNTS, TOWERS } from './sim/padCollision';
import { SoundField, plumePower } from './audio/soundField';
import { Hud, formatClock } from './ui/hud';
import { WARP_LEVELS, bindKeys, flightAxes } from './ui/input';
import { ManeuverPanel } from './ui/maneuverPanel';
import { BOOSTER_OCEAN_ENU, type MissionTarget, MissionTracker, SPLASH_TARGET, missionById } from './game/missions';
import { MissionUi } from './ui/missionUi';
import { GameMenu, toggleFullscreen } from './ui/gameMenu';
import { ReturnPanel } from './ui/returnPanel';
import { FlightPanel } from './ui/flightPanel';
import { type PilotCommand, activeStageId } from './sim/pilot';
import { TelemetryPlot } from './ui/plot';
import type { FromWorker, ToWorker } from './worker/protocol';
import SimWorker from './worker/sim.worker.ts?worker';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const origin = new FloatingOrigin();
const world = createWorld(canvas, origin);
const rig = new CameraRig(canvas);
const hud = new Hud();
const plot = new TelemetryPlot(document.querySelector<HTMLCanvasElement>('#plot')!);

const globeTiles = new GlobeTiles(world.renderer, origin);
world.scene.add(globeTiles.group);
const terrain = new Terrain(world.renderer, origin);
world.scene.add(terrain.group);
terrain.load().catch((err) => console.error('terrain failed to load', err));
rig.groundHeight = (lat, lon) => terrain.groundHeight(lat, lon);
const mapView = new MapView(document.body);
world.scene.add(mapView.group);
/** Latest predicted trajectories, by vehicle id. */
const trajectories = new Map<string, Trajectory>();
const fx = new LaunchFx(origin);
world.scene.add(fx.group, ...fx.lights);
const sound = new SoundField();
const audioEngine = new AudioEngine();
const audio = new LaunchAudio(audioEngine);
const ambience = new Ambience(audioEngine);
const menuAudio = new MenuAudio(audioEngine);
// Interface sounds: a tick when the pointer comes onto a button or card, a click when pressed.
document.addEventListener('pointerover', (e) => {
  const b = (e.target as HTMLElement).closest?.('button, .mn-card');
  if (b && !(e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) menuAudio.hover();
});
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest?.('button, .mn-card')) menuAudio.click();
});
/** Whether the main menu's music (rather than the world's sounds) is playing. */
let menuMusic: boolean | null = null;
onSettingsChange((s) => audioEngine.setMuted(s.muted));
/** How fast each pad's arms are moving (0 = still, 1 ~ a full-speed motion), from the snapshots. */
const towerMotion = [0, 0];
/** Each vehicle's mid-body (world) last frame, and its Mach number (for the sonic boom). */
const vehicleMid = new Map<string, V3>();
const lastMach = new Map<string, number>();
const launchSite = createLaunchSite();
world.scene.add(launchSite);
world.statics.push(launchSite);
origin.place(launchSite, [0, 0, 0]);
loadFacilities()
  .then((g) => {
    world.scene.add(g);
    world.statics.push(g);
    origin.place(g, [0, 0, 0]);
  })
  .catch((err) => console.error('facilities failed to load', err));

let models: ModelLibrary | null = null;
let padRig: PadRig | null = null;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingBar = loading.querySelector<HTMLElement>('.ld-bar i')!;
const loadingText = loading.querySelector<HTMLElement>('.ld-text')!;
loadModels(world.renderer, (f) => (loadingBar.style.transform = `scaleX(${f})`))
  .then((lib) => {
    models = lib;
    // Vehicle meshes clone the model and share its materials, so this updates every ship.
    onSettingsChange((s) => applyShipSerial(lib.ship, s.shipSerial));
    padRig = world.addPad(lib.pad);
    loadingBar.style.transform = 'scaleX(1)';
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 1000);
    if (import.meta.env.DEV) Object.assign(window, { __debug: { models, padRig, world, meshes, terrain, settings, updateSettings, rig, fx, sound, showScene, pr: () => pixelRatio, frame, globeTiles, mapView, flightPanel, hud, plot, ambience, audioEngine, menu, menuAudio, weather } });
  })
  .catch((err) => {
    loadingText.textContent = import.meta.env.DEV
      ? `Failed to load models: ${err.message}. Run \`npm run models\`.`
      : 'Couldn’t load the simulator. Check your connection and reload the page.';
    console.error(err);
  });

const worker = new SimWorker();
const send = (m: ToWorker) => worker.postMessage(m);

interface Received {
  snap: Snapshot;
  at: number;
}
let prev: Received | null = null;
let curr: Received | null = null;
let warp = 1;
/** Warping ahead to a maneuver / the autopilot's next event (the worker drives it). */
let warpTo: FromWorker['warpTo'] = null;
let effectiveWarp = 1;
let rails = false;
let paused = false;
let trackedId = 'stack';
/** Which pad's tower arms the arrow keys drive (0 = Pad 1). */
let armsPad = 0;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  prev = curr;
  curr = { snap: ev.data.snapshot, at: performance.now() };
  warp = ev.data.warp;
  effectiveWarp = ev.data.effectiveWarp;
  rails = ev.data.rails;
  paused = ev.data.paused;
  warpTo = ev.data.warpTo;
  workerSceneId = ev.data.sceneId;
  plot.record(curr.snap);
  // Tower machinery: rates of the carriage, arms, slew and QD arm, per sim second.
  if (prev && curr.snap.t > prev.snap.t) {
    const dt = curr.snap.t - prev.snap.t;
    curr.snap.towers.forEach((a, i) => {
      const b = prev!.snap.towers[i];
      if (!b) return;
      const m = (Math.abs(a.top - b.top) / 2.5 + Math.abs(a.angle - b.angle) / 8 + Math.abs(a.slew - b.slew) / 2.5 + Math.abs(a.qd - b.qd) / 16) / dt;
      // (A jump far faster than the drives can go is a reset / new scene, not motion.)
      towerMotion[i] = m > 4 ? 0 : m;
    });
  }
  // One-off sounds from what happened.
  for (const e of curr.snap.events) {
    const at = (id: string) => vehicleMid.get(id) ?? null;
    const who = /^Super Heavy|^Booster/.test(e.text) ? 'booster' : /^Starship|^Ship/.test(e.text) ? 'ship' : null;
    const where = (who && at(who)) ?? at(trackedId);
    if (!where) continue;
    if (/caught/i.test(e.text) && /!/.test(e.text)) ambience.play('catch', where, origin.camera);
    else if (/chopsticks lifting|stacked on/.test(e.text)) ambience.play('grab', where, origin.camera);
    else if (/touchdown/.test(e.text)) ambience.play('touchdown', where, origin.camera);
    else if (/splashdown/.test(e.text)) ambience.play('splash', where, origin.camera);
  }
  followMission(curr.snap);
  if (ev.data.trajectories) {
    trajectories.clear();
    for (const t of ev.data.trajectories) trajectories.set(t.id, t);
    mapView.setTrajectories(ev.data.trajectories);
  }
  // Hot staging hands the player a fresh stage: full throttle, all engines.
  if (prev && prev.snap.phase === 'hotstaging' && curr.snap.phase === 'shipburn' && pilot.manual) setPilot({ throttle: 1, engines: 0 });
  const shipOrbit = trajectories.get('ship')?.orbit ?? null;
  hud.update(curr.snap, { camera: rig.map ? 'Map' : CAMERA_LABELS[rig.mode], tracked: trackedName(), warp: warpLabel(), paused, armsPad, orbit: shipOrbit });
};

// --- Missions -------------------------------------------------------------------------

const tracker = new MissionTracker(missionById('ift'));
const missionUi = new MissionUi(document.body, {
  select: (id) => {
    tracker.reset(missionById(id));
    hud.setMission(tracker.mission.title);
  },
  retry: () => {
    // Back on the pad: Space starts the countdown again.
    resetFlight();
  },
  menu: () => openMainMenu(),
});
hud.setMission(tracker.mission.title);

// --- Main menu and pause menu ------------------------------------------------------------

/** Whether the pause menu paused the sim (so resuming unpauses it). */
let menuPaused = false;
const menu = new GameMenu(
  document.body,
  {
    // (From a clean reset: a backdrop scene is running behind the main menu.)
    // On the pad, waiting: Space starts the countdown.
    launch: (id, pad) => {
      menuAudio.go();
      missionUi.select(id);
      menu.close();
      setLaunchPad(pad);
      resetFlight();
    },
    freeRoam: (pad) => {
      menuAudio.go();
      missionUi.select('free');
      menu.close();
      setLaunchPad(pad);
      resetFlight();
    },
    resume: () => {
      if (menuPaused) send({ type: 'pause', value: false });
      menuPaused = false;
      menu.close();
    },
    restart: () => {
      menuPaused = false;
      send({ type: 'pause', value: false });
      resetFlight();
      menu.close();
    },
    mainMenu: () => openMainMenu(),
    nextScene: () => changeScene(),
  },
  document.querySelector<HTMLElement>('#help')!,
);

function openMainMenu(): void {
  if (menuPaused) send({ type: 'pause', value: false });
  menuPaused = false;
  resetFlight();
  menu.open('main', { mission: missionUi.selected });
  showScene(randomScene());
}

// Main menu backdrops: the sim sets each one up (Simulation.scene); the camera frames it and turns
// slowly round it. They change every so often (or on the menu's › button) through a fade to black.
/**
 * shift: how far right of centre (fraction of the width) the scene is framed, clear of the menu;
 * azimuth: the range the camera starts in (rad; it turns ~1 rad while the scene is up), else anywhere.
 */
const MENU_SCENES: {
  kind: MenuScene;
  caption: string;
  track: string;
  elevation: number;
  distance: number;
  shift?: number;
  azimuth?: [number, number];
  /** How long it stays up, s (default SCENE_SECONDS). */
  seconds?: number;
  /** Its own weather over Starbase (else the Settings'). */
  weather?: StarbaseWeather;
}[] = [
  { kind: 'pad', caption: 'Stacked on Pad 1 · rain over Starbase', track: 'stack', elevation: 0.12, distance: 420, weather: 'rain' },
  { kind: 'liftoff', caption: 'Liftoff · Pad 1', track: 'stack', elevation: 0.08, distance: 520, weather: 'overcast', seconds: 34 },
  { kind: 'orbit', caption: 'Starship in orbit · 250 km over Starbase', track: 'ship', elevation: 0.8, distance: 190, shift: 0.26, azimuth: [-0.2, 1.2], weather: 'partly' },  // looking over the coast, not out to sea
  // The ship against the black sky with the Earth's curved horizon below it: the camera nearly
  // level with it (from 250 km the horizon is 16 deg down), on its sunlit side.
  { kind: 'orbit', caption: 'Starship in orbit · Earth and space', track: 'ship', elevation: 0.13, distance: 170, shift: 0.26, azimuth: [0.6, 1.3], weather: 'partly' },
  // (Back and up: above the dust its engines raise, the whole approach in view.)
  { kind: 'reentry', caption: 'Starship reentry · 72 km, Mach 23', track: 'ship', elevation: 0.25, distance: 150, shift: 0.26, seconds: 24 },
  { kind: 'boosterCatch', caption: 'Super Heavy returning to the tower', track: 'booster', elevation: 0.16, distance: 620, shift: 0.3, seconds: 42, weather: 'partly' },
  // The ship home from orbit: flip, landing burn, and the catch by Pad 1's chopsticks, live.
  { kind: 'shipCatch', caption: 'Starship returning to the tower', track: 'ship', elevation: 0.14, distance: 420, shift: 0.3, seconds: 70 },
];
/** Seconds each backdrop stays up. */
const SCENE_SECONDS = 28;
let sceneIndex = -1;
let sceneTime = 0;
let sceneChanging = false;
/** Menu scenes asked for, and the worker's count of those it has set up. */
let scenesSent = 0;
let workerSceneId = 0;
let sceneHold = 0;
const sceneFade = document.createElement('div');
sceneFade.id = 'scene-fade';
document.body.appendChild(sceneFade);

function randomScene(): number {
  const others = MENU_SCENES.map((_, i) => i).filter((i) => i !== sceneIndex);
  return others[Math.floor(Math.random() * others.length)];
}

function showScene(i: number): void {
  const sc = MENU_SCENES[i];
  sceneIndex = i;
  sceneTime = 0;
  send({ type: 'scene', kind: sc.kind });
  scenesSent++;
  sceneWeather = sc.weather ?? null;
  applyWeatherSetting();
  startDay(null);
  blasts.clear();
  send({ type: 'warp', value: 1 });
  send({ type: 'node', node: null });
  trackedId = sc.track;
  setPilot({ manual: false, target: sc.track, throttle: 1, engines: 0, sas: 'stability' });
  if (rig.map) rig.toggleMap(lastTarget);
  rig.mode = 'orbit';
  const [a0, a1] = sc.azimuth ?? [0, Math.PI * 2];
  rig.azimuth = a0 + Math.random() * (a1 - a0);
  rig.elevation = sc.elevation;
  rig.distance = sc.distance;
  // (Hold the framing for a moment: until the new scene's snapshots arrive, the camera may be
  // aiming at the old one and get pushed up out of the ground.)
  sceneHold = performance.now() + 1500;
  plot.reset();
  hud.clearLog();
  tracker.reset();
  missionUi.hideResults();
  // (With the weather off, a caption's weather part (after a '·' naming it) is dropped.)
  menu.setCaption((WEATHER_AVAILABLE ? sc.caption : sc.caption.replace(/ · (rain|morning fog).*$/, '')).toUpperCase());
}

/** Fade to black, swap the backdrop, fade back in. */
function changeScene(): void {
  if (sceneChanging || menu.kind !== 'main') return;
  sceneChanging = true;
  sceneFade.classList.add('on');
  window.setTimeout(() => {
    if (menu.kind === 'main') showScene(randomScene());
    // Fade back in once the worker has the new scene up (some take a moment to compute), plus a
    // moment for its first frames to arrive.
    const started = performance.now();
    const wait = () => {
      if (workerSceneId < scenesSent && performance.now() - started < 8000) return void window.setTimeout(wait, 100);
      window.setTimeout(() => {
        sceneFade.classList.remove('on');
        sceneChanging = false;
      }, 350);
    };
    wait();
  }, 900);
}

function openPauseMenu(): void {
  menuPaused = !paused;
  if (menuPaused) send({ type: 'pause', value: true });
  const tm = curr?.snap.missionTime ?? null;
  menu.open('pause', { status: `${tracker.mission.title.toUpperCase()}${tm !== null ? ` · ${formatClock(tm)}` : ''}` });
}

/** The pad the flight starts from (0 = Pad 1); the arrow keys drive its arms. */
let launchPad = 0;
function setLaunchPad(pad: number): void {
  launchPad = pad;
  armsPad = pad;
  document.querySelector('#site')!.textContent = `STARSHIP V3 · STARBASE PAD ${pad + 1}`;
}

function resetFlight(): void {
  // (A new weather map for the flight: the Settings' weather, not a menu scene's.)
  sceneWeather = null;
  applyWeatherSetting();
  const setup = tracker.mission.setup;
  const start = setup.start ?? 'pad';
  startDay(missionDaylight());
  send({ type: 'reset', pad: launchPad, start, boosterOcean: setup.boosterOcean ? BOOSTER_OCEAN_ENU : null });
  scenesSent++;
  send({ type: 'warp', value: 1 });
  send({ type: 'node', node: null });
  // Hand-flown missions (and free roam) start with the player at the controls, autopilot off
  // for what they fly: set up for where it starts.
  trackedId = setup.fly ?? 'stack';
  const fly = setup.fly;
  manualVehicles.clear();
  if (fly) manualVehicles.add(fly);
  if (!fly) setPilot({ manual: false, target: 'stack', throttle: 1, engines: 0, sas: 'stability' });
  else if (start === 'separation') setPilot({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'stability' });
  else if (start === 'boosterLanding') setPilot({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'retrograde' });
  else if (start === 'entry') setPilot({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'entry' });
  else setPilot({ manual: true, target: fly, throttle: 1, engines: 0, sas: 'stability' });
  showPreparing(start !== 'pad');
  plot.reset();
  hud.clearLog();
  tracker.reset();
  missionUi.hideResults();
  blasts.clear();
}

// A screen covers the start of a flight until it's ready to look at: a mission starting part-way
// through a flight (the worker runs one ahead to there, a second or two), and the ground around
// the camera streamed in at full detail (the first time, a few seconds).
const preparing = document.createElement('div');
preparing.id = 'preparing';
preparing.innerHTML = '<div class="pp-title"></div><div class="pp-name"></div><div class="pp-bar"><i></i></div><div class="pp-sub"></div>';
document.body.appendChild(preparing);
/** Frames drawn so far (the loading screen waits for the camera to have moved to the new flight). */
let framesDrawn = 0;
/** Longest the screen waits for the ground (a slow connection flies with it still arriving), ms. */
const PREPARING_MAX_MS = 20000;
let preparingRun = 0;

function showPreparing(midFlight: boolean): void {
  const run = ++preparingRun;
  preparing.querySelector('.pp-title')!.textContent = midFlight ? 'Preparing mission' : 'Loading';
  preparing.querySelector('.pp-name')!.textContent = tracker.mission.title;
  const sub = preparing.querySelector<HTMLElement>('.pp-sub')!;
  sub.textContent = '';
  const started = performance.now();
  let settled = 0;
  let shown = false;
  /** Frames drawn once the worker had the new flight (the camera takes a few to get there). */
  let readyAt: number | null = null;
  const wait = () => {
    if (run !== preparingRun) return;
    const waited = performance.now() - started;
    if (readyAt === null && workerReady()) readyAt = framesDrawn;
    const ground = terrain.ready ? terrain.pendingInView : Infinity;
    const ready = readyAt !== null && framesDrawn >= readyAt + 5 && models !== null && ground === 0;
    // (Ready at once, as when the ground is already loaded: no screen at all.)
    settled = ready ? settled + 1 : 0;
    if (settled >= 3 || waited > PREPARING_MAX_MS) {
      if (shown) window.setTimeout(() => preparing.classList.remove('on'), 300);
      return;
    }
    if (!shown && (midFlight || waited > 150)) {
      shown = true;
      preparing.classList.add('on');
    }
    sub.textContent = !workerReady() ? '' : models === null ? 'Loading models' : Number.isFinite(ground) && ground > 0 ? `Loading terrain · ${ground} tile${ground === 1 ? '' : 's'}` : 'Loading terrain';
    window.setTimeout(wait, 100);
  };
  wait();
}

/**
 * While the main menu is up: load the launch pad's ground ahead (as the launch camera will see it),
 * so a launch starts with it there.
 */
const warmCam = new THREE.PerspectiveCamera(50, 1, 1, 5e6);
function warmPad(): void {
  const [e, n] = MOUNTS[launchPad] ?? [0, 0];
  const target = new THREE.Vector3(e, 70, -n);
  const [az, el, d] = [-2.3, 0.12, 420]; // (the orbit camera's starting view, cameras.ts)
  const pos = target.clone().add(new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(d));
  warmCam.aspect = world.camera.aspect;
  warmCam.updateProjectionMatrix();
  warmCam.position.set(0, 0, 0);
  warmCam.lookAt(target.clone().sub(pos));
  terrain.warm(warmCam, [pos.x, pos.y, pos.z]);
}

/** The worker has caught up with the last scene / mission set-up asked for. */
const workerReady = () => workerSceneId >= scenesSent;

/** Launch with the selected mission's setup. */
function startMission(): void {
  const setup = tracker.mission.setup;
  tracker.reset();
  missionUi.hideResults();
  if (setup.fly === 'stack') setPilot({ manual: true, target: 'stack', sas: 'stability', throttle: 1, engines: 0 });
  send({ type: 'launch' });
}

/** Mission hand-overs driven by the flight's events, and scoring. */
function followMission(snap: Snapshot): void {
  if (menu.kind === 'main') return; // a menu backdrop, not a flight
  const setup = tracker.mission.setup;
  for (const e of snap.events) {
    // Flying the stack by hand: at separation the controls stay with the ship.
    if (/^Stage separation/.test(e.text) && manualVehicles.has('stack')) manualVehicles.add('ship');
    // Missions about the booster: the camera goes with it at separation.
    if (setup.followBooster && /^Stage separation/.test(e.text)) trackedId = 'booster';
    // Ship Catch: at SECO the ship heads home by itself. Time only speeds up when the player
    // warps; it drops back to normal for the flip and catch so they can be watched.
    if (setup.shipReturn && /^SECO/.test(e.text)) {
      trackedId = 'ship';
      const target = setup.shipReturn === 'tower' ? ({ kind: 'tower', pad: -1 } as const) : ({ kind: 'ocean', ...SPLASH_TARGET } as const);
      send({ type: 'return', target });
    }
    if (setup.shipReturn && /^Return: flip and landing burn/.test(e.text)) send({ type: 'warp', value: 1 });
  }
  if (snap.phase === 'prelaunch') return;
  const result = tracker.update(snap);
  if (result) missionUi.showResults(result);
}

function warpLabel(): string {
  if (rails) return `${warp}× time (on rails)`;
  if (effectiveWarp < warp) return `${effectiveWarp}× time <span class="warn">(${warp}× needs coasting above 140 km)</span>`;
  return `${warp}× time`;
}

const maneuverPanel = new ManeuverPanel(
  document.body,
  (node) => send({ type: 'node', node }),
  (go) => send(go ? { type: 'warpTo', target: 'node' } : { type: 'warp', value: 1 }),
);
const returnPanel = new ReturnPanel(
  document.body,
  (target) => {
    if (target) setPilot({ manual: false });
    send({ type: 'return', target });
  },
  (go) => send(go ? { type: 'warpTo', target: 'next' } : { type: 'warp', value: 1 }),
);

// Map view: shift-click the globe to pick the ship's ocean return point.
canvas.addEventListener('click', (e) => {
  if (!rig.map || !e.shiftKey) return;
  const cam = origin.camera;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, world.camera);
  const center = new THREE.Vector3(EARTH_CENTER_WORLD[0] - cam[0], EARTH_CENTER_WORLD[1] - cam[1], EARTH_CENTER_WORLD[2] - cam[2]);
  const hit = ray.ray.intersectSphere(new THREE.Sphere(center, RE), new THREE.Vector3());
  if (!hit) return;
  const g = worldToGeodetic([hit.x + cam[0], hit.y + cam[1], hit.z + cam[2]]);
  returnPanel.setOcean(g.lat, g.lon);
});

// --- Player controls (manual flight) -------------------------------------------------

/** The player's controls; mirrored to the sim's Pilot whenever they change. */
const pilot: PilotCommand = { manual: false, target: 'stack', pitch: 0, yaw: 0, roll: 0, throttle: 1, sas: 'stability', engines: 0 };
let pilotDirty = true;
const setPilot = (patch: Partial<PilotCommand>) => {
  Object.assign(pilot, patch);
  pilotDirty = true;
};
/** Vehicles the player has taken the controls of (the others fly on autopilot). */
const manualVehicles = new Set<string>();
/** Throttle ramp while Shift / Ctrl are held, per second. */
const THROTTLE_RATE = 0.6;

/** The flown vehicle's current mean throttle on its lit engines (0 if none). */
function currentThrottle(): number {
  const v = curr?.snap.vehicles.find((x) => x.id === trackedId);
  if (!v) return 0;
  if (v.status === 'held') return 1;
  const t = v.stageState[activeStageId(v.stages)]?.throttles.filter((x) => x > 0.02) ?? [];
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0;
}

/** The engine set matching what's lit on the tracked vehicle (so taking over doesn't relight everything). */
function currentEngineSet(): number {
  const v = curr?.snap.vehicles.find((x) => x.id === trackedId);
  if (!v || v.status === 'held') return 0;
  const lit = (v.stageState[activeStageId(v.stages)]?.throttles ?? []).filter((x) => x > 0.02).length;
  if (activeStageId(v.stages) === 'booster') return lit === 0 || lit > 13 ? 0 : lit > 3 ? 1 : 2;
  return lit === 0 || lit > 3 ? 0 : 1;
}

/** Take over the tracked vehicle as it is flying right now. */
const takeOver = () => ({ throttle: currentThrottle(), engines: currentEngineSet() });

const flightPanel = new FlightPanel(hud.webcast, document.querySelector('#console')!, (mode) => {
  if (!pilot.manual) setPilot({ manual: true, ...takeOver() });
  setPilot({ sas: mode });
});

bindKeys({
  spaceBar: () => {
    const phase = curr?.snap.phase;
    if (phase === 'prelaunch') startMission();
    else if (pilot.manual) send({ type: 'stage' });
  },
  toggleMissions: () => {
    if (curr?.snap.phase === 'prelaunch') menu.open('main', { mission: missionUi.selected });
  },
  menu: () => (menu.isOpen ? menu.back() : openPauseMenu()),
  blocked: () => menu.isOpen,
  toggleManual: () => {
    // Taking the controls from the return autopilot pauses it; handing them back resumes it
    // from wherever the ship is by then (Cancel in the Return panel ends it).
    setPilot({ manual: !pilot.manual, ...takeOver() });
    if (pilot.manual) manualVehicles.add(trackedId);
    else manualVehicles.delete(trackedId);
  },
  toggleSas: () => setPilot({ sas: pilot.sas === 'off' ? 'stability' : 'off' }),
  cycleEngines: () => setPilot({ engines: (pilot.engines + 1) % 3 }),
  throttleFull: () => setPilot({ throttle: 1 }),
  throttleCut: () => setPilot({ throttle: 0 }),
  reset: () => resetFlight(),
  cycleCamera: () => rig.cycle(),
  toggleMap: () => rig.toggleMap(lastTarget),
  cycleTarget: () => {
    const ids = curr?.snap.vehicles.filter((v) => v.status !== 'destroyed').map((v) => v.id) ?? [];
    if (ids.length) trackedId = ids[(ids.indexOf(trackedId) + 1) % ids.length];
    // Looking at another vehicle doesn't take its autopilot away: the controls are yours only
    // on the ones you've taken over (L).
    setPilot({ manual: manualVehicles.has(trackedId) });
  },
  setWarp: (w) => send({ type: 'warp', value: w }),
  stepWarp: (dir) => {
    // (From the nearest level at or below: a warp-to runs in between the keyboard's levels.)
    const i = WARP_LEVELS.reduce((best, l, k) => (l <= warp ? k : best), 0);
    const next = WARP_LEVELS[Math.min(WARP_LEVELS.length - 1, Math.max(0, i + dir))];
    send({ type: 'warp', value: next });
  },
  toggleNode: () => maneuverPanel.toggle(),
  togglePlot: () => plot.toggle(),
  toggleHelp: () => document.querySelector('#help')!.classList.toggle('hidden'),
  toggleLog: () => hud.toggleLog(),
  toggleMute: () => updateSettings({ muted: !settings.muted }),
  toggleFullscreen,
  arms: (lift, swing, slew = null) => send({ type: 'arms', pad: armsPad, lift, swing, slew }),
  cycleArmsPad: () => {
    send({ type: 'arms', pad: armsPad, lift: 0, swing: 0, slew: 0 });
    armsPad = (armsPad + 1) % 2;
  },
});

function trackedName(): string {
  return curr?.snap.vehicles.find((v) => v.id === trackedId)?.name ?? '—';
}

// --- Vehicles ---------------------------------------------------------------------

const meshes = new Map<string, VehicleMesh>();
/** The mission's landing target beacon (and which target it's showing). */
const targetMarker = new TargetMarker();
world.scene.add(targetMarker.group);
let shownTarget: MissionTarget | null = null;
/** Vehicles that blew up: where, how big, and when (real ms), so the camera can stay on them. */
const blasts = new Map<string, { at: V3; radius: number; since: number }>();
/** How long the camera watches a blast before moving to a stage that's still flying, ms. */
const WATCH_BLAST_MS = 12000;

function syncMeshes(vehicles: VehicleSnapshot[], simTime: number): void {
  if (!models) return;
  const alive = new Set(vehicles.filter((v) => v.status !== 'destroyed').map((v) => v.id));
  for (const [id, m] of meshes) {
    if (!alive.has(id)) {
      // Broke up or crashed (rather than just gone, like the stack at staging): fireball.
      const v = vehicles.find((x) => x.id === id);
      const at = m.root.userData.world as V3 | undefined;
      if (v?.status === 'destroyed' && at) {
        const [e, n, u] = v.telemetry.vAirEnu;
        const length = v.stages.length === 2 ? BOOSTER_LENGTH + SHIP_LENGTH : v.stages[0] === 'ship' ? SHIP_LENGTH : BOOSTER_LENGTH;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.root.quaternion);
        const mid = midpoint(v);
        const where: V3 = [at[0] + up.x * mid, at[1] + up.y * mid, at[2] + up.z * mid];
        // As big as the propellant still aboard and the impact make it.
        const propellant = v.stages.reduce((sum, id) => sum + (v.stageState[id]?.propFrac ?? 0) * (id === 'booster' ? SUPER_HEAVY_V3 : STARSHIP_V3).propMass, 0);
        const air = Math.exp(-Math.max(0, v.telemetry.altitude) / 8500);
        const radius = explosionRadius(propellant, v.telemetry.mass, Math.hypot(e, n, u), length);
        fx.explode(where, new THREE.Vector3(e, u, -n), simTime, radius, air);
        ambience.play('explosion', where, origin.camera, radius / 60);
        blasts.set(id, { at: where, radius: radius * (air > 0.05 ? 1 : 0.4), since: performance.now() });
      }
      world.scene.remove(m.root);
      m.dispose();
      meshes.delete(id);
    }
  }
  for (const v of vehicles) {
    if (alive.has(v.id) && !meshes.has(v.id)) {
      const m = new VehicleMesh(v.stages, models);
      meshes.set(v.id, m);
      world.scene.add(m.root);
    }
  }
}

/** Mid-body of a vehicle along its axis, from the booster-base origin, m. */
function midpoint(v: VehicleSnapshot): number {
  const lo = v.stages.includes('booster') ? 0 : BOOSTER_LENGTH;
  const hi = v.stages.includes('ship') ? BOOSTER_LENGTH + SHIP_LENGTH : BOOSTER_LENGTH;
  return (lo + hi) / 2;
}

const shadowFocus = new THREE.Vector3();
const camUp = new THREE.Vector3();
const earthCenterRel = new THREE.Vector3();
const EARTH_CENTER_WORLD = ecefToWorld([0, 0, 0]);
const EARTH_AXIS_WORLD = new THREE.Vector3(...ecefToWorld([0, 0, 1e6])).sub(new THREE.Vector3(...EARTH_CENTER_WORLD)).normalize();

// --- Time of day: the Earth turns once in 24 h of sim time ---------------------------------------
const DAY_RATE = (2 * Math.PI) / 86400;
/** Where and when a mission wants daylight: at a mission time (s), or some time after its start. */
interface DaylightAt {
  lat: number;
  lon: number;
  /** Instead of lat / lon: where the flown vehicle is at the start. */
  atVehicle?: boolean;
  missionTime?: number;
  afterStart?: number;
  /** Wants it dark there instead (the sun well below the horizon). */
  night?: boolean;
}
/** The flight's day angle at its first snapshot, and that snapshot's times (null: not yet in). */
let dayPhase = 0;
let dayRef: { t: number; missionTime: number } | null = null;
/** What the flight about to start wants in daylight (null: morning at Starbase, day angle 0). */
let dayWants: DaylightAt[] | null = null;
function startDay(wants: DaylightAt[] | null): void {
  dayWants = wants;
  dayRef = null;
}
/** The key moments of a mission, to be in daylight: the pad at liftoff, the target on arrival. */
function missionDaylight(): DaylightAt[] | null {
  const m = tracker.mission;
  if (m.group === 'free') return null;
  const pad = { lat: PAD.latDeg, lon: PAD.lonDeg };
  const start = m.setup.start ?? 'pad';
  if (start === 'entry' && m.target) {
    // Night where the ship starts, then entry (~10-25 minutes, eastward) into the dawn and
    // daylight over the target: the sunrise line lies between.
    const { lat, lon } = m.target;
    return [
      { lat: 0, lon: 0, atVehicle: true, afterStart: 0, night: true },
      { lat, lon, afterStart: 900 },
      { lat, lon, afterStart: 1500 },
    ];
  }
  // Starting near Starbase part-way up (staging, the booster coming home).
  if (start !== 'pad') return [{ ...pad, afterStart: 0 }];
  const wants: DaylightAt[] = [{ ...pad, missionTime: 0 }];
  // The ship's splashdown on the far side of the world, ~65 minutes after liftoff.
  if (m.target?.vehicle === 'ship') wants.push({ lat: m.target.lat, lon: m.target.lon, missionTime: 3900 });
  return wants;
}
/**
 * The day angle at this flight's start that puts its key moments in daylight: the sun at least
 * ~30 degrees up at each if that can be had (or ~12 below, where it wants night), else as near
 * as they can all have it together;
 * of those, the nearest to a Starbase morning (day angle 0).
 */
function daylightPhase(wants: DaylightAt[], missionTime: number, vehicle: { lat: number; lon: number } | null): number {
  const center = new THREE.Vector3(...EARTH_CENTER_WORLD);
  wants = wants.filter((w) => !w.atVehicle || vehicle);
  const ups = wants.map((w) => {
    const at = w.atVehicle ? vehicle! : w;
    return new THREE.Vector3(...toWorld(at.lat, at.lon, 0)).sub(center).normalize();
  });
  const q = new THREE.Quaternion();
  const sun = new THREE.Vector3();
  const score = (phase: number) =>
    Math.min(
      ...wants.map((w, i) => {
        const dt = w.missionTime !== undefined ? w.missionTime - missionTime : (w.afterStart ?? 0);
        q.setFromAxisAngle(EARTH_AXIS_WORLD, -(phase + DAY_RATE * dt));
        sun.copy(SUN_AT_DAY0).applyQuaternion(q);
        const elev = Math.asin(THREE.MathUtils.clamp(sun.dot(ups[i]), -1, 1));
        // (Enough is enough: 30 degrees up for daylight, 12 below for a dark night.)
        return w.night ? Math.min(-elev, 12 * (Math.PI / 180)) : Math.min(elev, 30 * (Math.PI / 180));
      }),
    );
  const step = Math.PI / 180;
  const tries = [0];
  for (let k = 1; k <= 180; k++) tries.push(k * step, -k * step);
  const scores = tries.map(score);
  const best = Math.max(...scores);
  return tries[scores.findIndex((x) => x >= best - 0.5 * step)];
}

// --- Weather: planet-wide clouds, rain under them --------------------------------------------
const weather = new Weather(EARTH_AXIS_WORLD.clone(), new THREE.Vector3(...EARTH_CENTER_WORLD).negate().normalize());
const rain = new Rain();
world.scene.add(rain.lines);
/** A menu scene's own weather over Starbase (else the setting's). */
let sceneWeather: StarbaseWeather | null = null;
/**
 * A new weather map (each flight, each menu scene): with the weather asked for over Starbase,
 * or on 'Random' whatever the day brings (fog now and then).
 */
const applyWeatherSetting = () => {
  if (!WEATHER_AVAILABLE) {
    weather.enabled = false;
    weather.fog = 0;
    return;
  }
  const w = sceneWeather ?? settings.weather;
  weather.set(w === 'natural' ? (Math.random() < 0.2 ? 'fog' : 'any') : w);
};
let weatherSetting = settings.weather;
onSettingsChange((s) => {
  weather.enabled = WEATHER_AVAILABLE && s.clouds;
  if (s.weather !== weatherSetting) {
    weatherSetting = s.weather;
    applyWeatherSetting();
  }
});
applyWeatherSetting();

/** Rain keeps falling in real time (any warp), stopping only when paused. */
let rainClock = 0;
const camFromCentre = new THREE.Vector3();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const up = new THREE.Vector3();

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  world.setSize(w, h);
  world.camera.aspect = w / h;
  world.camera.updateProjectionMatrix();
  mapView.setSize(w, h);
}
window.addEventListener('resize', () => {
  resize();
  frozenFrame = false;
});
resize();

let lastFrame = performance.now();

// --- Render resolution ---------------------------------------------------------------------
// The GPU work is mostly per pixel (MSAA scene, atmosphere, bloom), so resolution is the big
// lever. Auto: start at the display's full density and adjust every ~45 frames to hold 60 fps
// (down quickly when frames are missed, back up slowly, not retrying a level that failed for a while).
const NATIVE_PR = Math.min(window.devicePixelRatio || 1, 2);
const MIN_PR = Math.max(0.6, NATIVE_PR * 0.5);
const TARGET_MS = 1000 / 60;
let pixelRatio = NATIVE_PR;
const frameGaps: number[] = [];
const frameCpu: number[] = [];
let goodWindows = 0;
let failedPr = Infinity;
let failedUntil = 0;

function governResolution(gapMs: number, cpuMs: number, now: number): void {
  const fixed = settings.renderScale;
  if (fixed !== 'auto') {
    pixelRatio = Math.max(0.5, NATIVE_PR * fixed);
    world.setPixelRatio(pixelRatio);
    return;
  }
  if (document.hidden || gapMs > 250) return;
  frameGaps.push(gapMs);
  frameCpu.push(cpuMs);
  if (frameGaps.length < 45) return;
  const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  const gap = median(frameGaps);
  const cpu = median(frameCpu);
  frameGaps.length = 0;
  frameCpu.length = 0;
  if (gap > TARGET_MS * 1.2 && cpu < TARGET_MS * 0.75) {
    // Missing frames and it's not the scripts: fewer pixels.
    failedPr = pixelRatio;
    failedUntil = now + 20000;
    pixelRatio = Math.max(MIN_PR, pixelRatio * 0.85);
    goodWindows = 0;
  } else if (gap < TARGET_MS * 1.08) {
    const next = Math.min(NATIVE_PR, pixelRatio * 1.12);
    if (++goodWindows >= 3 && next > pixelRatio && !(next >= failedPr && now < failedUntil)) {
      pixelRatio = next;
      goodWindows = 0;
    }
  } else goodWindows = 0;
  world.setPixelRatio(pixelRatio);
}
world.setPixelRatio(pixelRatio);

/** Below this height (m) a vehicle's shadow on the ground is drawn. */
const SHADOW_CEILING = 5000;
/** The launch site's shadows: both towers, and the ground their shadows reach (world, m). */
let siteShadow: { x: number; z: number; r: number } | null = null;
const siteShadowArea = (sd: THREE.Vector3) => {
  if (siteShadow) return siteShadow;
  // Tower bases and where their tops' shadows land (the towers are ~145 m tall).
  const pts: [number, number][] = [];
  for (const [e, n] of [...TOWERS, ...MOUNTS]) {
    pts.push([e, -n], [e - (sd.x * 150) / sd.y, -n - (sd.z * 150) / sd.y]);
  }
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const z = (Math.min(...zs) + Math.max(...zs)) / 2;
  const r = Math.max(...pts.map(([px, pz]) => Math.hypot(px - x, pz - z))) + 40;
  siteShadow = { x, z, r };
  return siteShadow;
};

/** What the shadows depend on, coarsely: when it changes, the shadow map is redrawn. */
let shadowKey = '';
/** The last frame's script time, ms (to tell a CPU-bound frame from a GPU-bound one). */
let lastCpuMs = 0;
/** A frame was drawn while paused behind the pause menu (nothing more to draw until it closes). */
let frozenFrame = false;
let shadowAt = 0;
/** 0..1: how far the view is shifted aside for the main menu. */
let menuShift = 0;
/** Tracked vehicle's mid-body (world), where the map view opens. */
let lastTarget: V3 = [0, 60, 0];

/** Held keys -> the player's attitude / throttle inputs; send any change to the sim. */
function updatePilot(dt: number): void {
  const axes = flightAxes();
  if (pilot.manual) {
    if (axes.pitch !== pilot.pitch || axes.yaw !== pilot.yaw || axes.roll !== pilot.roll) {
      setPilot({ pitch: axes.pitch, yaw: axes.yaw, roll: axes.roll });
    }
    if (axes.throttle !== 0) setPilot({ throttle: Math.min(1, Math.max(0, pilot.throttle + axes.throttle * THROTTLE_RATE * dt)) });
  } else if (pilot.pitch || pilot.yaw || pilot.roll) {
    setPilot({ pitch: 0, yaw: 0, roll: 0 });
  }
  if (pilot.target !== trackedId && workerReady()) setPilot({ target: trackedId, ...takeOver() });
  if (pilotDirty) {
    send({ type: 'pilot', cmd: { ...pilot } });
    pilotDirty = false;
  }
}

function frame(): void {
  requestAnimationFrame(frame);
  if (!curr) return;
  const now = performance.now();
  const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
  // Paused behind the pause menu: the picture doesn't change, so draw it once and then leave
  // the GPU alone (keeps the menu itself responsive).
  if (menu.kind === 'pause' && paused && frozenFrame) {
    lastFrame = now;
    return;
  }
  governResolution(now - lastFrame, lastCpuMs, now);
  lastFrame = now;
  updatePilot(frameDt);
  // Behind the main menu: its music, not the world's sounds.
  if ((menu.kind === 'main') !== menuMusic) {
    menuMusic = menu.kind === 'main';
    menuAudio.setMusic(menuMusic);
    audioEngine.setWorldLevel(menuMusic ? 0 : 1, menuMusic ? 0.4 : 1.5);
  }
  // Main menu: the view turns slowly round the pad behind it.
  if (menu.kind === 'main' && !rig.map && rig.mode === 'orbit') rig.azimuth += frameDt * 0.035;
  if (menu.kind === 'main' && (sceneTime += frameDt) > (MENU_SCENES[sceneIndex]?.seconds ?? SCENE_SECONDS)) changeScene();
  if (menu.kind === 'main' && now < sceneHold && sceneIndex >= 0) rig.elevation = MENU_SCENES[sceneIndex].elevation;
  // Render between the last two snapshots so motion is smooth at any frame rate.
  const span = prev ? curr.at - prev.at : 0;
  const alpha = span > 0 ? Math.min(1, (now - curr.at) / span) : 1;
  const snap = curr.snap;
  const simTime = prev ? prev.snap.t + (snap.t - prev.snap.t) * alpha : snap.t;
  syncMeshes(snap.vehicles, simTime);
  // The time of day, from this flight's (or menu scene's) first snapshot on.
  if (!dayRef && workerReady()) {
    dayRef = { t: snap.t, missionTime: snap.missionTime ?? 0 };
    const flown = snap.vehicles.find((v) => v.id === trackedId)?.telemetry;
    dayPhase = dayWants ? daylightPhase(dayWants, dayRef.missionTime, flown ? { lat: flown.lat, lon: flown.lon } : null) : 0;
  }
  const dayAngle = dayPhase + (dayRef ? DAY_RATE * (simTime - dayRef.t) : 0);
  world.setDay(dayAngle, EARTH_AXIS_WORLD);

  // The tracked vehicle blew up: watch the explosion for a while (V switches sooner), then go
  // over to whatever is still flying.
  let watching: { at: V3; radius: number; since: number } | null = null;
  if (workerReady() && !snap.vehicles.some((v) => v.id === trackedId && v.status !== 'destroyed')) {
    const blast = blasts.get(trackedId);
    if (blast && now - blast.since < WATCH_BLAST_MS) watching = blast;
    else {
      const next = snap.vehicles.find((v) => v.id === 'ship' && v.status !== 'destroyed')?.id
        ?? snap.vehicles.find((v) => v.status !== 'destroyed')?.id
        ?? trackedId;
      if (next !== trackedId) {
        trackedId = next;
        setPilot({ manual: manualVehicles.has(next) });
      }
    }
  }

  const placements: FxVehicle[] = [];
  let target: { center: V3; axis: V3; size: number } | null = null;
  for (const v of snap.vehicles) {
    const mesh = meshes.get(v.id);
    if (!mesh) continue;
    const p = prev?.snap.vehicles.find((x) => x.id === v.id);
    const pos: V3 = p
      ? [p.pos[0] + (v.pos[0] - p.pos[0]) * alpha, p.pos[1] + (v.pos[1] - p.pos[1]) * alpha, p.pos[2] + (v.pos[2] - p.pos[2]) * alpha]
      : v.pos;
    vehicleQuaternion(v.rot, qb);
    if (p) qb.copy(vehicleQuaternion(p.rot, qa).slerp(qb, alpha));
    mesh.root.quaternion.copy(qb);
    mesh.update(v, simTime);
    const w = enuToWorld(pos);
    placements.push({ snap: v, mesh, world: w });
    {
      up.set(0, 1, 0).applyQuaternion(qb);
      const mid = midpoint(v);
      const m: V3 = [w[0] + up.x * mid, w[1] + up.y * mid, w[2] + up.z * mid];
      vehicleMid.set(v.id, m);
      // A stage slowing through Mach 1 on its way down: its double sonic boom.
      const was = lastMach.get(v.id) ?? 0;
      const mach = v.telemetry.mach;
      if (v.status === 'flight' && was >= 1.02 && mach < 1 && v.telemetry.vAirEnu[2] < 0 && v.telemetry.altitude < 30e3) ambience.play('boom', m, origin.camera);
      lastMach.set(v.id, mach);
    }
    if (v.id === trackedId) {
      up.set(0, 1, 0).applyQuaternion(qb);
      const mid = midpoint(v);
      target = {
        center: [w[0] + up.x * mid, w[1] + up.y * mid, w[2] + up.z * mid],
        axis: [up.x, up.y, up.z],
        size: v.stages.length === 2 ? BOOSTER_LENGTH + SHIP_LENGTH : v.stages[0] === 'ship' ? SHIP_LENGTH : BOOSTER_LENGTH,
      };
    }
  }

  // Dev-only: __debug.focus = [x, y, z] (world) aims the orbit camera at a fixed point instead.
  const focus0 = import.meta.env.DEV ? (window as unknown as { __focus?: V3 }).__focus : undefined;
  const aim = focus0 ? { center: focus0, axis: [0, 1, 0] as V3, size: 60 } : (target ?? (watching ? { center: watching.at, axis: [0, 1, 0] as V3, size: watching.radius } : null));
  // Back off far enough to take in the whole fireball.
  if (watching && rig.mode === 'orbit' && !rig.map) rig.distance += (Math.max(rig.distance, watching.radius * 3.2) - rig.distance) * Math.min(1, frameDt * 1.5);
  if (target) lastTarget = target.center;
  // Nothing left to track (it broke up): stay where it was, watching the debris.
  const cam = rig.update(world.camera, aim ?? { center: lastTarget, axis: [0, 1, 0], size: 124 });
  origin.camera = cam;
  if (mapView.visible !== rig.map) mapView.setVisible(rig.map);
  const mapVehicles: MapVehicle[] = placements
    .filter((pl) => pl.snap.status !== 'destroyed')
    .map((pl) => ({ id: pl.snap.id, name: pl.snap.name, world: pl.world, altitude: pl.snap.telemetry.altitude }));
  const ret = snap.shipReturn;
  const returnMarks = ret
    ? [
        { ...ret.targetLatLon, cls: 'mark return', html: `<i></i><span>${ret.target.kind === 'tower' ? `Pad ${ret.target.pad + 1} tower` : 'Return target'}</span>` },
        ...(ret.predicted ? [{ lat: ret.predicted.lat, lon: ret.predicted.lon, cls: 'mark impact', html: '<i></i><span>Guidance landing</span>' }] : []),
      ]
    : snap.phase === 'coast' && rig.map
      ? [{ ...returnPanel.ocean, cls: 'mark return', html: '<i></i><span>Ocean return point</span>' }]
      : [];
  // The mission's landing target: a beacon in the world, a mark on the map.
  const missionTarget = menu.kind === 'main' ? null : (tracker.mission.target ?? null);
  if (missionTarget !== shownTarget) {
    shownTarget = missionTarget;
    targetMarker.set(missionTarget);
  }
  targetMarker.update(origin, now / 1000);
  if (missionTarget) returnMarks.push({ lat: missionTarget.lat, lon: missionTarget.lon, cls: 'mark return', html: `<i></i><span>${missionTarget.label}</span>` });
  mapView.update(origin, world.camera, simTime, mapVehicles, trackedId, returnMarks);
  origin.apply(world.statics);
  for (const pl of placements) {
    origin.place(pl.mesh.root, pl.world);
    pl.mesh.afterPlace();
  }
  // Dev-only: __fxMissionTime overrides the countdown clock the effects see (to preview the deluge).
  const fxClock = import.meta.env.DEV ? (window as unknown as { __fxMissionTime?: number }).__fxMissionTime : undefined;
  fx.update(simTime, fxClock ?? snap.missionTime, placements, world.sun, 1);

  // Sound: every vehicle is a source (silent ones too, so a cut-off is heard late as well).
  for (const pl of placements) {
    const n = vehicleNoise(pl);
    sound.record(pl.snap.id, simTime, n.pos, plumePower(n.thrust, n.pressureRatio));
  }
  sound.prune(simTime);
  const heard = sound.hear(simTime, cam);
  globeTiles.update(world.camera, cam);
  terrain.update(world.camera, cam, now / 1000);
  framesDrawn++;
  if (menu.kind === 'main') warmPad();
  padRig?.update(snap.missionTime, snap.towers);
  // Shadows: near the ground they cover the whole launch site (both towers and the shadows they
  // cast) and, as a vehicle climbs, the ground its own shadow falls on, straight down the sun's
  // rays from it. Up high only the vehicle itself (its parts shading each other).
  const focus = target?.center ?? [0, 60, 0];
  const sd = world.sunDir;
  const fh = Math.max(0, focus[1]);
  if (fh < SHADOW_CEILING && sd.y > 0.08) {
    const gx = focus[0] - (sd.x * fh) / sd.y;
    const gz = focus[2] - (sd.z * fh) / sd.y;
    const site = siteShadowArea(sd);
    const d = Math.hypot(gx - site.x, gz - site.z);
    const reach = fh / sd.y;
    if (d < site.r + 400) {
      shadowFocus.set(site.x - cam[0], -cam[1], site.z - cam[2]);
      world.updateShadow(shadowFocus, Math.max(site.r, d + 80), reach);
    } else {
      shadowFocus.set(gx - cam[0], -cam[1], gz - cam[2]);
      world.updateShadow(shadowFocus, 160, reach);
    }
  } else {
    shadowFocus.set(focus[0] - cam[0], focus[1] - cam[1], focus[2] - cam[2]);
    world.updateShadow(shadowFocus, 140);
  }
  const r2 = (x: number) => Math.round(x * 20);
  const key =
    `${r2(focus[0])},${r2(focus[1])},${r2(focus[2])}|${Math.round(dayAngle * 2000)}|${meshes.size}|${padRig ? 1 : 0}|${JSON.stringify(snap.towers)}|` +
    placements.map((pl) => `${r2(pl.world[0])},${r2(pl.world[1])},${r2(pl.world[2])},${r2(pl.mesh.root.quaternion.x * 50)},${r2(pl.mesh.root.quaternion.y * 50)},${r2(pl.mesh.root.quaternion.z * 50)}`).join(';');
  if (key !== shadowKey || now - shadowAt > 2000) {
    shadowKey = key;
    shadowAt = now;
    world.shadowsDirty();
  }

  // Camera altitude above the WGS84 ellipsoid (geocentric radius at the camera's latitude).
  camUp.set(cam[0] - EARTH_CENTER_WORLD[0], cam[1] - EARTH_CENTER_WORLD[1], cam[2] - EARTH_CENTER_WORLD[2]);
  const camR = camUp.length();
  camUp.divideScalar(camR);
  const sinLat = camUp.dot(EARTH_AXIS_WORLD);
  const cos2 = 1 - sinLat * sinLat;
  const camAlt = camR - Math.sqrt(((RE * RE) ** 2 * cos2 + (RP * RP) ** 2 * sinLat * sinLat) / (RE * RE * cos2 + RP * RP * sinLat * sinLat));
  camFromCentre.set(cam[0] - EARTH_CENTER_WORLD[0], cam[1] - EARTH_CENTER_WORLD[1], cam[2] - EARTH_CENTER_WORLD[2]);
  const wx = weather.local(camFromCentre, camAlt);
  audio.update(heard.level, heard.distance, Math.exp(-Math.max(0, camAlt) / 8500), paused);
  // Everything else you hear: wind, surf, air rush, tower machinery, deluge, venting.
  const mt = snap.missionTime;
  const sm = (x: number, a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const [me, mn] = MOUNTS[launchPad];
  const heldStack = placements.find((pl) => pl.snap.status === 'held' && pl.snap.stages.length === 2);
  ambience.update({
    dt: frameDt,
    paused: paused || menu.kind === 'pause',
    cam,
    camAlt,
    listenerAir: Math.exp(-Math.max(0, camAlt) / 8500),
    time: simTime,
    vehicles: placements
      .filter((pl) => pl.snap.status === 'flight')
      .map((pl) => ({ world: vehicleMid.get(pl.snap.id) ?? pl.world, q: pl.snap.telemetry.q, mach: pl.snap.telemetry.mach, heatFlux: pl.snap.telemetry.heatFlux })),
    towers: snap.towers.map((a, i) => ({ world: enuToWorld([TOWERS[i][0], TOWERS[i][1], a.top]), motion: towerMotion[i] })),
    deluge: mt === null ? null : { world: enuToWorld([me, mn, PAD.mountHeight]), level: sm(mt, -6, -4.5) * (1 - sm(mt, 12, 16)) },
    vent: heldStack && (snap.phase === 'prelaunch' || snap.phase === 'countdown') ? (vehicleMid.get(heldStack.snap.id) ?? null) : null,
    rain: rig.map ? 0 : wx.rain,
  });
  fx.shake(world.camera, paused || rig.map ? -Infinity : heard.level, now / 1000);
  earthCenterRel.set(EARTH_CENTER_WORLD[0] - cam[0], EARTH_CENTER_WORLD[1] - cam[1], EARTH_CENTER_WORLD[2] - cam[2]);
  world.updateSky(camAlt, camUp, earthCenterRel, camR - camAlt);
  // Weather: the clouds (drawn by the atmosphere pass), overcast dimming the sun, rain.
  weather.update(simTime);
  weather.apply(world.atmosphere);
  world.sun.intensity *= wx.sun;
  if (!paused) rainClock += frameDt;
  rain.update(rig.map ? 0 : wx.rain, cam, camUp, rainClock);
  // Main menu: frame the pad off to the right, clear of the menu (eased in and out).
  menuShift += ((menu.kind === 'main' ? 1 : 0) - menuShift) * Math.min(1, frameDt * 3);
  if (menuShift > 0.001) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shift = (sceneIndex >= 0 ? MENU_SCENES[sceneIndex].shift : undefined) ?? 0.4;
    world.camera.setViewOffset(w, h, -w * shift * menuShift, 0, w, h);
  } else if (world.camera.view) world.camera.clearViewOffset();
  // (Screen scale for effects sized in metres, e.g. the reentry sparks.)
  VehicleMesh.pixelRatio = world.renderer.getPixelRatio();
  VehicleMesh.screenScale = (world.renderer.getContext().drawingBufferHeight / 2) * world.camera.projectionMatrix.elements[5];
  world.render();
  plot.draw();
  flightPanel.update(snap, snap.vehicles.find((v) => v.id === trackedId), missionTarget);
  maneuverPanel.update(snap, trackedId, trajectories.get(trackedId) ?? null, rig.map, warpTo);
  returnPanel.update(snap, trackedId, rig.map, warpTo);
  missionUi.updateTracker(snap.phase === 'prelaunch' ? null : tracker.mission, tracker.states(), tracker.score().total);
  lastCpuMs = performance.now() - now;
  frozenFrame = menu.kind === 'pause' && paused;
}
requestAnimationFrame(frame);

// Corner buttons: pause menu and full screen (for the mouse; Esc and F do the same).
{
  const corner = document.createElement('div');
  corner.id = 'corner';
  corner.innerHTML =
    '<button data-act="pause" title="Pause menu (Esc)"><svg viewBox="0 0 16 16"><rect x="4" y="3" width="2.6" height="10"/><rect x="9.4" y="3" width="2.6" height="10"/></svg></button>' +
    '<button data-act="fs" title="Full screen (F)"><svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>';
  corner.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'pause' && !menu.isOpen) openPauseMenu();
    else if (act === 'fs') toggleFullscreen();
  });
  document.body.appendChild(corner);
}

// Start at the main menu (once everything above is set up).
menu.open('main', { mission: missionUi.selected });
showScene(randomScene());
