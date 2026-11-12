import * as THREE from 'three';
import { BOOSTER_LENGTH, SHIP_LENGTH, STARLINK_V3, STARSHIP_V3, SUPER_HEAVY_V3 } from './sim/config/starshipV3';
import type { V3 } from './sim/math';
import type { FlightOptions, Snapshot, VehicleSnapshot } from './sim/simulation';
import type { ReturnTarget } from './sim/shipReturn';
import { CAMERA_LABELS, CameraRig, type CameraTarget } from './render/cameras';
import { FloatingOrigin, enuToWorld, vehicleQuaternion } from './render/floatingOrigin';
import { type ModelLibrary, loadModels } from './render/models';
import { applyShipSerial } from './render/decals';
import { buildingUniforms, loadFacilities, setBuildingNight } from './render/facilities';
import { rocketGarden } from './render/rocketGarden';
import { loadSouthPadre } from './render/southPadre';
import { createLaunchSite } from './render/launchSite';
import { PadLights, lampLightAll } from './render/padLights';
import { Moon } from './render/moon';
import { type StarbaseWeather, WEATHER_AVAILABLE, WEATHER_NAME, onSettingsChange, settings, updateSettings } from './settings';
import { type PadRig, SUN_AT_DAY0, createWorld } from './render/scene';
import { createFramePacing } from './render/framePacing';
import { PAD, RE, RP } from './sim/constants';
import { GlobeTiles } from './render/globeTiles';
import { ecefToWorld, toWorld, worldToGeodetic } from './render/geo';
import { sea } from './render/ocean';
import { AfloatFx } from './render/fx/afloat';
import { OceanSurface } from './render/oceanSurface';
import { FarCull } from './render/farCull';
import { Director } from './render/director';
import { Terrain, seaColourUniforms } from './render/terrain';
import { tileTextureStats } from './render/tileTexture';
import { type MapVehicle, MapView } from './render/mapView';
import type { Trajectory } from './sim/trajectory';
import { VehicleMesh } from './render/vehicleMesh';
import { TargetMarker } from './render/targetMarker';
import { Weather } from './render/weather';
import { starbaseDay } from './weather/model';
import { Rain } from './render/fx/rain';
import { Lightning } from './render/fx/lightning';
import { StarlinkFleet, loadStarlink } from './render/starlink';
import { type FxVehicle, LaunchFx, explosionRadius, vehicleNoise } from './render/fx/launchFx';
import { VentFx } from './render/fx/vent';
import { LaunchAudio } from './audio/launchAudio';
import { AudioEngine } from './audio/engine';
import { Ambience } from './audio/ambience';
import { MenuAudio } from './audio/menuAudio';
import { MOUNTS, TOWERS } from './sim/padCollision';
import { type Heard, SoundField, plumePower } from './audio/soundField';
import { Hud, formatClock } from './ui/hud';
import { type InputActions, WARP_LEVELS, bindKeys } from './ui/input';
import { SnapshotClock } from './render/snapshotClock';
import { keyText, paintKeys } from './ui/keyLabels';
import { GamepadInput } from './ui/gamepad';
import { Replay } from './ui/replay';
import { ManeuverPanel } from './ui/maneuverPanel';
import { DAY_RATE, type DaylightAt, daylightPhase, missionDaylight } from './game/daylight';
import { flightLines } from './ui/statusLines';
import { ShieldPanel } from './ui/shieldPanel';
import { BOOSTER_OCEAN_ENU, type MissionDef, type MissionSetup, type MissionTarget, MissionTracker, SPLASH_TARGET, missionById } from './game/missions';
import { MissionUi } from './ui/missionUi';
import { GameMenu, toggleFullscreen } from './ui/gameMenu';
import { ReturnPanel } from './ui/returnPanel';
import { FlightPanel } from './ui/flightPanel';
import { TelemetryPlot } from './ui/plot';
import type { FromWorker, ToWorker, WorkerMessage } from './worker/protocol';
import { type FlightSave, formatSavedAt } from './game/savedFlight';
import { createSaveSession } from './game/saveSession';
import { createPilotControls } from './game/pilotControls';
import { type Received, createViewModes } from './game/viewModes';
import { createMenuBackdrop } from './game/menuBackdrop';
import { installWindowChrome } from './ui/windowChrome';
import SimWorker from './worker/sim.worker.ts?worker';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const origin = new FloatingOrigin();
const world = createWorld(canvas, origin);
const rig = new CameraRig(canvas);
const hud = new Hud();
const shieldPanel = new ShieldPanel(document.body);
const plot = new TelemetryPlot(document.querySelector<HTMLCanvasElement>('#plot')!);

const globeTiles = new GlobeTiles(world.renderer, origin);
world.scene.add(globeTiles.group);
const terrain = new Terrain(world.renderer, origin);
world.scene.add(terrain.group);
terrain.load().catch((err) => console.error('terrain failed to load', err));
rig.groundHeight = (lat, lon) => terrain.groundHeight(lat, lon);
const mapView = new MapView(document.body);
world.scene.add(mapView.group);
// The Moon, in the sky and on the map.
const moon = new Moon();
world.scene.add(moon.mesh, moon.halo, moon.light, moon.light.target);
// (The background: the clouds are drawn against these, the vehicles and buildings over them.)
world.atmosphere.setBackground(globeTiles.group, terrain.group, moon.mesh, moon.halo);
mapView.bodies = { sunDir: world.sunDir, moon };
const PAD_UP = new THREE.Vector3(0, 1, 0);
/** Latest predicted trajectories, by vehicle id. */
const trajectories = new Map<string, Trajectory>();
const fx = new LaunchFx(origin);
world.scene.add(fx.group, ...fx.lights);
const ventFx = new VentFx(origin);
const afloatFx = new AfloatFx(origin, ecefToWorld([0, 0, 0]));
world.scene.add(ventFx.group);
world.scene.add(afloatFx.group);
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
onSettingsChange((s) => audioEngine.setMuted(s.muted, s.volume));
// The flight displays' size, and the camera's speed.
onSettingsChange((s) => {
  document.documentElement.style.setProperty('--ui-scale', String(s.uiScale));
  rig.sensitivity = s.cameraSpeed;
});
/** How fast each pad's arms are moving (0 = still, 1 ~ a full-speed motion), from the snapshots. */
const towerMotion = [0, 0];
/** Each vehicle's mid-body (world) last frame, and its Mach number (for the sonic boom). */
const vehicleMid = new Map<string, V3>();
const lastMach = new Map<string, number>();
const launchSite = createLaunchSite();
world.scene.add(launchSite);
world.statics.push(launchSite);
origin.place(launchSite, [0, 0, 0]);
// The launch site's parts too small to see from where the camera is: left out (farCull.ts).
const farCull = new FarCull();
farCull.add(launchSite, origin.camera);
// Floodlights and tower beacons, for the night.
const padLights = new PadLights();
lampLightAll(launchSite);
world.scene.add(padLights.group);
world.statics.push(padLights.group);
origin.place(padLights.group, [0, 0, 0]);
// South Padre Island and Port Isabel, across the channel (the skyline behind the pad views).
loadSouthPadre()
  .then((g) => {
    world.scene.add(g);
    world.statics.push(g);
    origin.place(g, [0, 0, 0]);
    farCull.add(g, origin.camera);
  })
  .catch((err) => console.error('South Padre Island failed to load', err));
const facilitiesLoaded = loadFacilities();
facilitiesLoaded
  .then((g) => {
    lampLightAll(g);
    world.scene.add(g);
    world.statics.push(g);
    origin.place(g, [0, 0, 0]);
    farCull.add(g, origin.camera);
  })
  .catch((err) => console.error('facilities failed to load', err));

let models: ModelLibrary | null = null;
let padRig: PadRig | null = null;
/** The deployed Starlink satellites (once their model has loaded). */
let starlink: StarlinkFleet | null = null;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingBar = loading.querySelector<HTMLElement>('.ld-bar i')!;
const loadingText = loading.querySelector<HTMLElement>('.ld-text')!;
loadModels(world.renderer, (f) => (loadingBar.style.transform = `scaleX(${f})`))
  .then((lib) => {
    models = lib;
    // Vehicle meshes clone the model and share its materials, so this updates every ship.
    onSettingsChange((s) => applyShipSerial(lib.ship, s.shipSerial));
    lampLightAll(lib.pad);
    padRig = world.addPad(lib.pad);
    farCull.add(lib.pad, origin.camera);
    // The rocket garden's vehicles, now the models are here.
    facilitiesLoaded
      .then((g) => {
        const garden = rocketGarden(lib, g.userData.garden ?? []);
        world.scene.add(garden);
        world.statics.push(garden);
        origin.place(garden, [0, 0, 0]);
        farCull.add(garden, origin.camera);
      })
      .catch(() => {});
    // The Starlink satellites (Starlink flights deploy them): their own small model.
    loadStarlink()
      .then((model) => {
        starlink = new StarlinkFleet(model);
        world.scene.add(starlink.group);
      })
      .catch((err) => console.error('Starlink model failed to load', err));
    loadingBar.style.transform = 'scaleX(1)';
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 1000);
    if (import.meta.env.DEV) Object.assign(window, { __debug: { sea, oceanSurface, afloatFx, farCull, models, padRig, world, meshes, terrain, settings, updateSettings, rig, fx, sound, pr: () => pacing.state().pixelRatio, pacing: () => pacing.state(), frame, globeTiles, tileTextureStats, mapView, flightPanel, hud, plot, ambience, audioEngine, lightning, starlink: () => starlink, menu, menuAudio, weather, moon, origin, showScene: backdrop.showScene } });
  })
  .catch((err) => {
    loadingText.textContent = import.meta.env.DEV
      ? `Failed to load models: ${err.message}. Run \`npm run models\`.`
      : 'Couldn’t load the simulator. Check your connection and reload the page.';
    console.error(err);
  });

const worker = new SimWorker();
const send = (m: ToWorker) => worker.postMessage(m);

let prev: Received | null = null;
let curr: Received | null = null;
/**
 * What frame() draws the motion from: a steady sim-time clock a couple of snapshots behind the
 * newest, and the snapshots either side of it (render/snapshotClock.ts). Everything else (the
 * HUD, events, mission logic) goes by the newest snapshot, curr.
 */
const motion = new SnapshotClock<Snapshot>();
/** The flight or scene (the worker's count of them) its snapshots are of. */
let motionScene = 0;
let warp = 1;
/** Warping ahead to a maneuver / the autopilot's next event (the worker drives it). */
let warpTo: FromWorker['warpTo'] = null;
let effectiveWarp = 1;
let rails = false;
let paused = false;
let trackedId = 'stack';
/** The auto camera (render/director.ts; the log lines it hasn't seen yet: game/viewModes.ts). */
const director = new Director();
/** Instant replay (ui/replay.ts): the live snapshots it keeps (the live ones while it plays: game/viewModes.ts). */
const replay = new Replay();
/** A Starlink the cameras follow instead (V steps on to them after the vehicles), by its number. */
let satFocus: number | null = null;
/** Which pad's tower arms the arrow keys drive (0 = Pad 1). */
let armsPad = 0;

worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  // (The answers to 'save' / 'load'.)
  if (ev.data.type !== 'snapshot') return void saves.onReply(ev.data);
  const at = performance.now();
  // (A new flight or scene: nothing of the last one to draw between. During a replay too: the
  // clock goes on with the live flight, so it's in step when the replay ends.)
  if (ev.data.sceneId !== motionScene) {
    motionScene = ev.data.sceneId;
    motion.reset();
  }
  motion.push(ev.data.snapshot, ev.data.snapshot.t, at);
  // (Replaying: the live flight waits, its snapshots kept for the return: game/viewModes.ts.)
  if (views.holdLive({ snap: ev.data.snapshot, at })) return;
  if (!ev.data.paused) replay.record(ev.data.snapshot);
  prev = curr;
  curr = { snap: ev.data.snapshot, at };
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
  views.noteEvents(curr.snap.events);
  // One-off sounds from what happened.
  for (const e of curr.snap.events) {
    const at = (id: string) => vehicleMid.get(id) ?? null;
    const where = (e.who && at(e.who)) ?? at(trackedId);
    if (!where) continue;
    if (e.kind === 'boosterCaught' || e.kind === 'shipCaught') ambience.play('catch', where, origin.camera);
    else if (e.kind === 'grab' || e.kind === 'stacked') ambience.play('grab', where, origin.camera);
    else if (e.kind === 'touchdown') ambience.play('touchdown', where, origin.camera);
    else if (e.kind === 'splashdown') ambience.play('splash', where, origin.camera);
  }
  followMission(curr.snap);
  if (ev.data.trajectories) {
    trajectories.clear();
    for (const t of ev.data.trajectories) trajectories.set(t.id, t);
    mapView.setTrajectories(ev.data.trajectories);
  }
  // Hot staging hands the player a fresh stage: full throttle, all engines.
  if (prev && prev.snap.phase === 'hotstaging' && curr.snap.phase === 'shipburn' && pilotCtl.cmd.manual) pilotCtl.set({ throttle: 1, engines: 0 });
  const shipOrbit = trajectories.get('ship')?.orbit ?? null;
  hud.update(curr.snap, { camera: rig.map ? 'Map' : (director.enabled ? 'Auto camera: ' : '') + CAMERA_LABELS[rig.mode], tracked: trackedName(), warp: warpLabel(), paused, armsPad, manual: pilotCtl.cmd.manual, orbit: shipOrbit, weather: weather.enabled ? WEATHER_NAME[weatherToday] : '', payload: flightLines(curr.snap, tracker.mission.id === 'free') });
  {
    // The heat shield map: in the inspection camera view, and through the entry when there are gaps.
    const sh = curr.snap.shield;
    const ship = curr.snap.vehicles.find((v) => v.stages.length === 1 && v.stages[0] === 'ship' && v.status === 'flight');
    const entry = !!ship && sh.lost > 0 && ship.telemetry.altitude < 130e3 && ship.telemetry.verticalSpeed < 0;
    shieldPanel.update(sh, !rig.map && menu.kind !== 'main' && (rig.mode === 'inspect' || entry));
  }
};

// --- Missions -------------------------------------------------------------------------

const tracker = new MissionTracker(missionById('ift'));
const missionUi = new MissionUi(document.body, {
  select: (id) => {
    tracker.reset(missionById(id));
    hud.setMission(tracker.mission.title, tracker.mission.id);
  },
  retry: () => {
    // Back on the pad: Space starts the countdown again.
    resetFlight();
  },
  menu: () => openMainMenu(),
});
hud.setMission(tracker.mission.title, tracker.mission.id);

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
      // (A real flight's own pad, if it has one.)
      setLaunchPad(missionById(id).setup.pad ?? pad);
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
    nextScene: () => backdrop.changeScene(),
    saves: () => saves.list().map((e) => ({ ...e, clock: formatClock(e.missionTime), when: formatSavedAt(e.savedAt) })),
    continueFlight: (id) => saves.continueFlight(id),
    deleteSave: (id) => saves.delete(id),
    canSave: () => (replay.active ? 'Not during a replay.' : !inFlight() ? 'Nothing to save before liftoff.' : !workerReady() ? 'Not yet: the flight is still loading.' : null),
    saveFlight: (name, replace) => {
      if (!saves.askSave({ name, replace })) showToast('Flight not saved');
    },
    backdrop: (pad) => backdrop.backdrop(pad),
  },
  document.querySelector<HTMLElement>('#help')!,
);

// --- Replay, photo mode and the auto camera (game/viewModes.ts) ------------------------------
const views = createViewModes({
  replay,
  director,
  menu,
  rig,
  world,
  send,
  showToast,
  live: () => ({ prev, curr }),
  setLive: (p, c) => {
    prev = p;
    curr = c;
  },
  paused: () => paused,
  manual: () => pilotCtl.cmd.manual,
  tracked: () => trackedId,
  setTracked: (id) => {
    trackedId = id;
  },
  setSatFocus: (n) => {
    satFocus = n;
  },
});

function openMainMenu(page?: 'saves'): void {
  // (The flight as it is now, kept: "Continue" in the menu takes it up again.)
  saves.askSave();
  if (menuPaused) send({ type: 'pause', value: false });
  menuPaused = false;
  resetFlight();
  // (Its Free Roam page puts up the backdrop: the pad picked, menuBackdrop.)
  menu.open('main', { mission: missionUi.selected, page });
}

/** Menu scenes asked for, and the worker's count of those it has set up. */
let scenesSent = 0;
let workerSceneId = 0;

// --- Main menu backdrops (game/menuBackdrop.ts) ------------------------------------------------
const backdrop = createMenuBackdrop({
  menu,
  rig,
  settle: () => pacing.settle(),
  sendScene: (m) => {
    send(m);
    scenesSent++;
  },
  workerReady: () => workerReady(),
  enter: (w, track) => {
    sceneWeather = w;
    applyWeatherSetting();
    startDay(null);
    blasts.clear();
    send({ type: 'warp', value: 1 });
    send({ type: 'node', node: null });
    trackedId = track;
    pilotCtl.set({ manual: false, target: track, throttle: 1, engines: 0, sas: 'stability' });
    if (rig.map) rig.toggleMap(lastTarget);
    rig.mode = 'orbit';
  },
  cleared: () => {
    plot.reset();
    hud.clearLog();
    tracker.reset();
    missionUi.hideResults();
  },
  weatherToday: () => weatherToday,
  pickFreeWeather: () => freeWeatherPick(),
  setWeather: (w, morph) => {
    sceneWeather = w;
    applyWeatherSetting(morph);
  },
});

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

// --- The flights kept for next time (game/savedFlight.ts, game/saveSession.ts) ---------------
const saves = createSaveSession({
  send,
  canSave: () => !replay.active && workerReady() && inFlight(),
  meta: () => ({
    mission: tracker.mission.id,
    title: tracker.mission.title,
    finished: tracker.result !== null,
    pad: launchPad,
    tracked: trackedId,
    manual: [...pilotCtl.manualVehicles],
    day: dayRef ? { phase: dayPhase, t: dayRef.t, missionTime: dayRef.missionTime } : null,
    tracker: tracker.saveState(),
  }),
  showToast,
  savesChanged: () => menu.savesChanged(),
  logEvents: (events) => hud.logEvents(events),
  missionOver: () => !!tracker.result,
  openMainMenu: (page) => openMainMenu(page),
  takeUp: (s, mission) => takeUpFlight(s, mission),
});

/**
 * A saved flight taken up (saves.continueFlight): the same mission, vehicles, weather and time of
 * day. (The save's own bookkeeping, after this: game/saveSession.ts.)
 */
function takeUpFlight(s: FlightSave, mission: MissionDef): void {
  menuAudio.go();
  missionUi.select(mission.id);
  tracker.loadState(s.tracker);
  menu.close();
  setLaunchPad(s.pad);
  pacing.settle();
  sceneWeather = null;
  backdrop.clearPadView();
  // Its weather, the same world from the same moment (and so the same wind: the worker has it
  // from this before the flight itself). Its time of day.
  if (WEATHER_AVAILABLE && s.flight.weather) {
    weather.restore(s.flight.weather);
    if (s.flight.weather.site !== 'natural') weatherToday = s.flight.weather.site;
  }
  dayWants = null;
  dayPhase = s.day?.phase ?? 0;
  dayRef = s.day ? { t: s.day.t, missionTime: s.day.missionTime } : null;
  send({ type: 'load', data: s.flight });
  scenesSent++;
  trackedId = s.tracked;
  satFocus = null;
  pilotCtl.manualVehicles.clear();
  for (const id of s.manual) pilotCtl.manualVehicles.add(id);
  views.restartDirector(false);
  showPreparing(true);
  plot.reset();
  hud.clearLog();
  missionUi.hideResults();
  blasts.clear();
}

function resetFlight(): void {
  saves.newFlight();
  pacing.settle();
  // (A new weather map for the flight: the Settings' weather, not a menu scene's.)
  sceneWeather = null;
  backdrop.clearPadView();
  applyWeatherSetting();
  const setup = tracker.mission.setup;
  const start = setup.start ?? 'pad';
  if (setup.pad !== undefined && launchPad !== setup.pad) setLaunchPad(setup.pad);
  startDay(missionDaylight(tracker.mission));
  send({ type: 'reset', pad: launchPad, start, boosterOcean: setup.boosterOcean ? BOOSTER_OCEAN_ENU : null, options: flightOptions(setup) });
  scenesSent++;
  send({ type: 'warp', value: 1 });
  send({ type: 'node', node: null });
  // Hand-flown missions (and free roam) start with the player at the controls, autopilot off
  // for what they fly: set up for where it starts.
  trackedId = setup.fly ?? 'stack';
  // Watched flights get the auto camera (K turns it off; touching the camera does too).
  views.restartDirector(tracker.mission.group === 'auto');
  const fly = setup.fly;
  pilotCtl.manualVehicles.clear();
  if (fly) pilotCtl.manualVehicles.add(fly);
  if (!fly) pilotCtl.set({ manual: false, target: 'stack', throttle: 1, engines: 0, sas: 'stability' });
  else if (start === 'separation') pilotCtl.set({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'stability' });
  else if (start === 'boosterLanding') pilotCtl.set({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'retrograde' });
  else if (start === 'entry') pilotCtl.set({ manual: true, target: fly, throttle: 0, engines: 1, sas: 'entry' });
  else pilotCtl.set({ manual: true, target: fly, throttle: 1, engines: 0, sas: 'stability' });
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
/** A flight is under way (not a menu backdrop, not the stack waiting on the pad). */
const inFlight = () => menu.kind !== 'main' && !!curr && curr.snap.phase !== 'prelaunch';

/** Launch with the selected mission's setup. */
function startMission(): void {
  const setup = tracker.mission.setup;
  tracker.reset();
  missionUi.hideResults();
  // (Unless the player handed the stack to the autopilot on the pad, with L.)
  if (setup.fly === 'stack' && pilotCtl.manualVehicles.has('stack')) pilotCtl.set({ manual: true, target: 'stack', sas: 'stability', throttle: 1, engines: 0 });
  send({ type: 'launch' });
}

/** Mission hand-overs driven by the flight's events, and scoring. */
function followMission(snap: Snapshot): void {
  if (menu.kind === 'main') return; // a menu backdrop, not a flight
  const setup = tracker.mission.setup;
  for (const e of snap.events) {
    // Flying the stack by hand: at separation the controls stay with the ship.
    if (e.kind === 'separation' && pilotCtl.manualVehicles.has('stack')) pilotCtl.manualVehicles.add('ship');
    // Missions about the booster: the camera goes with it at separation.
    if (setup.followBooster && e.kind === 'separation') trackedId = 'booster';
    // Ship Catch: at SECO the ship heads home by itself. Time only speeds up when the player
    // warps; it drops back to normal for the flip and catch so they can be watched.
    if (setup.shipReturn && e.kind === 'seco') {
      trackedId = 'ship';
      const aim = tracker.mission.target?.vehicle === 'ship' ? tracker.mission.target : SPLASH_TARGET;
      const target: ReturnTarget =
        setup.shipReturn === 'tower'
          ? setup.shipCatchSlew !== undefined
            ? { kind: 'tower', pad: launchPad, slew: setup.shipCatchSlew }
            : { kind: 'tower', pad: -1 }
          : { kind: 'ocean', lat: aim.lat, lon: aim.lon };
      send({ type: 'return', target });
    }
    if (setup.shipReturn && e.kind === 'landingFlip') send({ type: 'warp', value: 1 });
    // Starlink flights: back to normal speed, the camera on the ship, for the deployment.
    if (setup.payload && e.kind === 'doorOpening') {
      trackedId = 'ship';
      send({ type: 'warp', value: 1 });
    }
  }
  if (snap.phase === 'prelaunch') return;
  const result = tracker.update(snap);
  // (Over: the result once. The flight is still autosaved after, marked as over; the player's
  // own saves are theirs to delete.)
  if (result) missionUi.showResults(result);
}

function warpLabel(): string {
  if (rails) return `${warp}× time (on rails)`;
  if (effectiveWarp < warp) return `${effectiveWarp}× time <span class="warn">(${warp}× needs coasting above 140 km)</span>`;
  return `${warp}× time`;
}

const maneuverPanel = new ManeuverPanel(
  // (In the left column, at its foot: under the objectives, never over them.)
  document.querySelector<HTMLElement>('#hud-left') ?? document.body,
  (node) => send({ type: 'node', node }),
  (go) => send(go ? { type: 'warpTo', target: 'node' } : { type: 'warp', value: 1 }),
);
const returnPanel = new ReturnPanel(
  document.body,
  (target) => {
    if (target) pilotCtl.set({ manual: false });
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

const pilotCtl = createPilotControls({
  snap: () => curr?.snap ?? null,
  tracked: () => trackedId,
  setTracked: (id) => {
    trackedId = id;
  },
  workerReady: () => workerReady(),
  send,
  adoptPending: () => saves.adoptPending(),
  adoptDone: () => saves.adoptDone(),
});

const flightPanel = new FlightPanel(hud.webcast, document.querySelector('#console')!, (mode) => {
  if (!pilotCtl.cmd.manual) pilotCtl.set({ manual: true, ...pilotCtl.takeOver() });
  pilotCtl.set({ sas: mode });
});

const actions: InputActions = {
  spaceBar: () => {
    if (replay.active) return replay.togglePlay();
    const phase = curr?.snap.phase;
    if (phase === 'prelaunch') startMission();
    else if (pilotCtl.cmd.manual) send({ type: 'stage' });
  },
  toggleMissions: () => {
    if (curr?.snap.phase === 'prelaunch') menu.open('main', { mission: missionUi.selected });
  },
  menu: () => {
    if (replay.active) return views.endReplay();
    if (views.inPhoto()) return views.endPhoto();
    menu.isOpen ? menu.back() : openPauseMenu();
  },
  blocked: () => menu.isOpen,
  toggleManual: () => pilotCtl.toggleManual(),
  toggleSas: () => pilotCtl.toggleSas(),
  cycleEngines: () => pilotCtl.cycleEngines(),
  deploy: () => send({ type: 'deploy' }),
  throttleFull: () => pilotCtl.throttleFull(),
  throttleCut: () => pilotCtl.throttleCut(),
  toggleReplay: () => (replay.active ? views.endReplay() : views.startReplay()),
  togglePhoto: () => (views.inPhoto() ? views.endPhoto() : views.startPhoto()),
  savePhoto: () => views.savePhoto(),
  toggleDirector: () => views.toggleDirector(),
  cycleCamera: () =>
    (views.stopDirector(),
    rig.cycle((need) => {
      const ship = curr?.snap.vehicles.find((v) => v.id === trackedId && v.stages.length === 1 && v.stages[0] === 'ship' && v.status !== 'destroyed');
      return !!ship && (need === 'door' ? !!curr?.snap.payload : !!curr?.snap.payload?.sats.length);
    })),
  toggleMap: () => rig.toggleMap(lastTarget),
  cycleTarget: () => {
    views.stopDirector();
    const ids = curr?.snap.vehicles.filter((v) => v.status !== 'destroyed').map((v) => v.id) ?? [];
    // After the vehicles, the satellites out (the cameras follow one; the ship stays the one tracked).
    const sats = curr?.snap.payload?.sats.map((s) => s.n) ?? [];
    if (satFocus !== null) {
      const i = sats.indexOf(satFocus);
      satFocus = i >= 0 && i + 1 < sats.length ? sats[i + 1] : null;
      if (satFocus === null && ids.length) trackedId = ids[0];
      pilotCtl.set({ manual: pilotCtl.manualVehicles.has(trackedId) });
      return;
    }
    if (sats.length && ids.indexOf(trackedId) === ids.length - 1 && ids.includes('ship')) {
      trackedId = 'ship';
      satFocus = sats[0];
      pilotCtl.set({ manual: pilotCtl.manualVehicles.has(trackedId) });
      return;
    }
    if (ids.length) trackedId = ids[(ids.indexOf(trackedId) + 1) % ids.length];
    // Looking at another vehicle doesn't take its autopilot away: the controls are yours only
    // on the ones you've taken over (L).
    pilotCtl.set({ manual: pilotCtl.manualVehicles.has(trackedId) });
  },
  setWarp: (w) => send({ type: 'warp', value: w }),
  stepWarp: (dir) => {
    if (replay.active) return replay.speed(dir);
    // (From the nearest level at or below: a warp-to runs in between the keyboard's levels.)
    const i = WARP_LEVELS.reduce((best, l, k) => (l <= warp ? k : best), 0);
    const next = WARP_LEVELS[Math.min(WARP_LEVELS.length - 1, Math.max(0, i + dir))];
    send({ type: 'warp', value: next });
  },
  toggleNode: () => maneuverPanel.toggle(),
  togglePlot: () => plot.toggle(),
  toggleHelp: () => document.querySelector('#help')!.classList.toggle('hidden'),
  toggleLog: () => hud.toggleLog(),
  // (Unmuted at no volume would still be silent: back to half.)
  toggleMute: () => updateSettings(settings.muted ? { muted: false, volume: settings.volume || 0.5 } : { muted: true }),
  toggleFullscreen,
  arms: (lift, swing, slew = null) => {
    // (Replaying, ← → step back and on; in photo mode [ ] change the field of view.)
    if (replay.active) {
      if (swing) replay.seek(swing * 5);
      return;
    }
    if (views.inPhoto()) {
      if (slew) rig.fovOverride = THREE.MathUtils.clamp((rig.fovOverride ?? 50) * (slew > 0 ? 1.15 : 1 / 1.15), 2, 100);
      return;
    }
    send({ type: 'arms', pad: armsPad, lift, swing, slew });
  },
  cycleArmsPad: () => {
    send({ type: 'arms', pad: armsPad, lift: 0, swing: 0, slew: 0 });
    armsPad = (armsPad + 1) % 2;
  },
};
bindKeys(actions);
// The help panel names the keys as the player has them (the menu's Controls page changes them).
onSettingsChange(() => paintKeys(document.querySelector('#help')!));
// A game controller, alongside the keys (gamepad.ts).
const toast = document.createElement('div');
toast.id = 'toast';
document.body.append(toast);
let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('on'), 3500);
}
// (The player took the camera: the auto camera stands down, game/viewModes.ts.)
world.renderer.domElement.addEventListener('pointerdown', views.stopDirector);
world.renderer.domElement.addEventListener('wheel', views.stopDirector, { passive: true });
const gamepad = new GamepadInput(
  actions,
  {
    orbit: (dAz, dEl, zoom) => {
      views.stopDirector();
      if (rig.map) {
        rig.mapDistance = THREE.MathUtils.clamp(rig.mapDistance * zoom, 6.5e6, 4e8);
        rig.mapLon -= dAz;
        rig.mapLat = THREE.MathUtils.clamp(rig.mapLat - dEl, -1.5, 1.5);
        return;
      }
      if ((dAz || dEl) && rig.mode !== 'orbit') rig.mode = 'orbit';
      rig.azimuth += dAz * rig.sensitivity;
      rig.elevation = THREE.MathUtils.clamp(rig.elevation + dEl * rig.sensitivity, -1.4, 1.5);
      rig.distance = THREE.MathUtils.clamp(rig.distance * zoom, 20, 2e6);
    },
  },
  (name) => showToast(name ? `Controller connected · ${keyText('help')} for its buttons` : 'Controller disconnected'),
);

function trackedName(): string {
  if (satFocus !== null) return `Starlink ${satFocus}`;
  return curr?.snap.vehicles.find((v) => v.id === trackedId)?.name ?? '—';
}

// --- Vehicles ---------------------------------------------------------------------

const meshes = new Map<string, VehicleMesh>();
/** The mission's landing target beacon (and which target it's showing). */
const targetMarker = new TargetMarker();
world.scene.add(targetMarker.group);
let shownTarget: MissionTarget | null = null;
type Blast = { at: V3; radius: number; since: number };
/** Vehicles that blew up: where, how big, and when (real ms), so the camera can stay on them. */
const blasts = new Map<string, Blast>();
/** How long the camera watches a blast before moving to a stage that's still flying, ms. */
const WATCH_BLAST_MS = 12000;

/**
 * Compile every shader and upload every texture ahead, once the first scene's vehicles are up
 * (behind the loading screen): else each is built the first time it's drawn (the plume at
 * ignition, the plasma, frost, rain, lightning, a fireball, the satellites...), and the frame
 * it happens in stalls for a moment. Hidden parts are shown just for the compile (it collects
 * what to build at once; they're hidden again before any frame is drawn).
 */
let prewarmed = false;
function prewarmShaders(): void {
  if (prewarmed || !models || meshes.size === 0) return;
  prewarmed = true;
  const r = world.renderer;
  const shown: THREE.Object3D[] = [];
  world.scene.traverse((o) => {
    if (!o.visible) {
      o.visible = true;
      shown.push(o);
    }
  });
  const extra = fx.warmObjects();
  for (const o of extra) fx.group.add(o);

  const seen = new Set<THREE.Texture>();
  world.scene.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(m)) {
        if (v && (v as THREE.Texture).isTexture && !seen.has(v as THREE.Texture) && (v as THREE.Texture).image) {
          seen.add(v as THREE.Texture);
          r.initTexture(v as THREE.Texture);
        }
      }
    }
  });
  // (Pass by pass, as the frame draws each: see compileAhead.)
  world.atmosphere.compileAhead(r).catch(() => {});
  // (Their material kept, not disposed: that would drop the program just built.)
  for (const o of extra) fx.group.remove(o);
  for (const o of shown) o.visible = false;
}

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

/** A flight's options: the mission's setup, and the player's realism settings where it leaves them open. */
function flightOptions(setup: MissionSetup): FlightOptions {
  return {
    // (Free roam: Starlinks if the player loaded them, deployed when they press B.)
    payload: setup.payload ?? (tracker.mission.id === 'free' && settings.freeStarlink ? 'starlink' : null),
    deploy: setup.payload ? 'auto' : 'manual',
    parkingAlt: setup.parkingAlt ?? null,
    faults: setup.faults ?? (settings.engineFailures ? 'random' : 'off'),
    faultSeed: Math.floor(Math.random() * 2 ** 31),
    tiles: settings.tileLoss ? 'random' : 'off',
    splashFireball: setup.splashFireball ?? false,
    // (Dev-only: __flightOptions overrides these for the next flight, e.g. set tiles missing.)
    ...(import.meta.env.DEV ? (window as unknown as { __flightOptions?: FlightOptions }).__flightOptions : undefined),
  };
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
const seaEast = new THREE.Vector3();
/** How much of what's under the camera is sea, 0..1 (eased: the reflections' ground). */
let seaUnder = 0;
const seaNorth = new THREE.Vector3();

// --- Time of day: the Earth turns once in 24 h of sim time ---------------------------------------
/** The flight's day angle at its first snapshot, and that snapshot's times (null: not yet in). */
let dayPhase = 0;
let dayRef: { t: number; missionTime: number } | null = null;
/** What the flight about to start wants in daylight (null: morning at Starbase, day angle 0). */
let dayWants: DaylightAt[] | null = null;
function startDay(wants: DaylightAt[] | null): void {
  dayWants = wants;
  dayRef = null;
}
// --- Weather: planet-wide clouds, rain under them --------------------------------------------
/** Render world -> Earth-fixed (ECEF) directions (the weather map's axes). */
const WORLD_TO_ECEF = (() => {
  const c = new THREE.Vector3(...EARTH_CENTER_WORLD);
  const [ex, ey, ez] = ([[1e6, 0, 0], [0, 1e6, 0], [0, 0, 1e6]] as const).map((p) => new THREE.Vector3(...ecefToWorld([...p])).sub(c).normalize());
  return new THREE.Matrix3().set(ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z);
})();
/** The weather where the camera is (Weather.local). */
type LocalWeather = ReturnType<Weather['local']>;
const weather = new Weather(EARTH_AXIS_WORLD.clone(), WORLD_TO_ECEF, PAD.latDeg, PAD.lonDeg);
// The sea near the camera: a mesh rising and falling with the waves, at sea level.
const oceanSurface = new OceanSurface({ ...seaColourUniforms, uWorldToEcef: { value: WORLD_TO_ECEF } });
world.scene.add(oceanSurface.mesh);
world.atmosphere.setBackground(oceanSurface.mesh);
const seaGround = { up: new THREE.Vector3(), east: new THREE.Vector3(), north: new THREE.Vector3(), v: new THREE.Vector3() };
// (The physics flies through the same weather: its wind.)
weather.onConfig = (cfg, land) => send({ type: 'weather', cfg, land });
/** The season: the sun's latitude (it stays put through a flight's days), degrees. */
const SEASON = THREE.MathUtils.radToDeg(Math.asin(SUN_AT_DAY0.dot(EARTH_AXIS_WORLD)));
const rain = new Rain();
world.scene.add(rain.lines);
const lightning = new Lightning();
world.scene.add(lightning.mesh);
lightning.onStrike = (st) => ambience.thunder(st.distance, st.ground);
/** A menu scene's own weather over Starbase (else the setting's). */
let sceneWeather: StarbaseWeather | null = null;
/**
 * New weather (each flight, each menu scene): a new world of weather systems, with the weather
 * asked for over Starbase, or on 'Random' whatever the day brings. Missions get fair weather.
 */
/** The weather over Starbase this flight (free roam's 'starbase' rolls one: shown in the HUD). */
let weatherToday: StarbaseWeather = 'partly';
const applyWeatherSetting = (morph = false) => {
  if (!WEATHER_AVAILABLE) {
    weather.enabled = false;
    return;
  }
  // Missions always fly in fair weather with light wind (the setting is free roam's).
  // (Free roam on 'Starbase': a day as the place's climate deals them out, a new one each time.)
  const free = settings.freeWeather === 'starbase' ? starbaseDay(SEASON, Math.random()) : settings.freeWeather;
  weatherToday = sceneWeather ?? (tracker.mission.id !== 'free' ? 'partly' : free);
  weather.configure(weatherToday, SEASON, !sceneWeather && tracker.mission.id !== 'free', undefined, morph);
};
/** Free roam's weather pick as a day's weather ('Starbase' rolls one). */
function freeWeatherPick(): StarbaseWeather {
  return settings.freeWeather === 'starbase' ? starbaseDay(SEASON, Math.random()) : settings.freeWeather;
}
let weatherSetting = settings.freeWeather;
onSettingsChange((s) => {
  weather.enabled = WEATHER_AVAILABLE && s.clouds;
  if (s.freeWeather !== weatherSetting) {
    weatherSetting = s.freeWeather;
    // The menu's pad view, if it's up, takes it: its sky turns into the weather picked
    // (game/menuBackdrop.ts). (Else free roam's: a mission keeps its fair weather.)
    if (!backdrop.freeWeatherChanged() && tracker.mission.id === 'free') applyWeatherSetting();
  }
});
applyWeatherSetting();

/** Rain keeps falling in real time (any warp), stopping only when paused. */
let rainClock = 0;
const camFromCentre = new THREE.Vector3();
const lightningScreen = new THREE.Vector2();
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

// --- Render resolution and frame pacing (render/framePacing.ts) ------------------------------
const pacing = createFramePacing(world, () => terrain.pendingInView);

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
let shadowKey = 0;
/** The last frame's script time, ms (to tell a CPU-bound frame from a GPU-bound one). */
let lastCpuMs = 0;
/** Of it, the drawing (world.render: it waits on the GPU when that's behind), ms. */
let lastRenderMs = 0;
/** A frame was drawn while paused behind the pause menu (nothing more to draw until it closes). */
let frozenFrame = false;
let shadowAt = 0;
/** 0..1: how far the view is shifted aside for the main menu. */
let menuShift = 0;
/** Tracked vehicle's mid-body (world), where the map view opens. */
let lastTarget: V3 = [0, 60, 0];

/** The animation loop: one frame() per refresh (or fewer: see the frame pacing above). */
function loop(ts: number): void {
  requestAnimationFrame(loop);
  pacing.watchRefresh(ts);
  // (A display faster than the frames can be drawn: every second refresh, evenly spaced.)
  if (curr && pacing.skip(performance.now() - lastFrame)) return;
  frame(ts);
}

/**
 * ts: the refresh this frame is for (the animation frame's own time: steadier than when its callback got to run).
 * (A sequence of steps, each below with what it needs: the order is the order they must run in.)
 */
function frame(ts: number): void {
  if (!curr) return;
  const now = performance.now();
  const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
  // Paused behind the pause menu: the picture doesn't change, so draw it once and then leave
  // the GPU alone (keeps the menu itself responsive).
  if (menu.kind === 'pause' && paused && frozenFrame) {
    lastFrame = now;
    return;
  }
  pacing.govern(now - lastFrame, lastCpuMs, lastCpuMs - lastRenderMs, now);
  lastFrame = now;
  // Replaying: the recorded snapshots either side of the playback time, as if just received.
  views.replayFrame(now);
  gamepad.poll(frameDt);
  pilotCtl.update(frameDt);
  saves.autosave(now);
  menuMusicStep();
  // Main menu: the view turns slowly round the pad behind it; the backdrops change.
  backdrop.tick(frameDt, now);
  const m = frameMotion(curr, prev, ts, now);
  const { snap, simTime } = m;
  syncMeshes(snap.vehicles, simTime);
  prewarmShaders();
  views.runDirector(now, snap);
  const dayAngle = timeOfDayStep(snap, simTime);
  const watching = watchBlastStep(snap, now);
  const { placements, target } = placeVehiclesStep(m);
  const cam = aimCameraStep(m, target, watching, frameDt, now);
  const missionTarget = mapStep(snap, placements, simTime, now);
  placeWorldStep(snap, simTime, placements, cam, m);
  const heard = soundStep(placements, simTime, cam);
  groundStep(snap, cam, now);
  shadowStep(snap, placements, target, cam, dayAngle, now);
  const { camR, camAlt, wx } = seaAndWeatherStep(cam, simTime, frameDt);
  audioStep(snap, placements, heard, cam, camAlt, simTime, frameDt, wx);
  skyStep(cam, camR, camAlt, simTime, frameDt, wx, heard, now);
  menuShiftStep(frameDt);
  drawStep(snap, missionTarget, now);
}

/** Behind the main menu: its music, not the world's sounds. */
function menuMusicStep(): void {
  if ((menu.kind === 'main') !== menuMusic) {
    menuMusic = menu.kind === 'main';
    menuAudio.setMusic(menuMusic);
    audioEngine.setWorldLevel(menuMusic ? 0 : 1, menuMusic ? 0.4 : 1.5);
  }
}

/** What a frame draws the motion from (frameMotion): the snapshots either side of simTime, and how far between. */
interface FrameMotion {
  /** The newest snapshot: everything but places, attitudes and simTime comes from it. */
  snap: Snapshot;
  from: Snapshot | null;
  to: Snapshot;
  alpha: number;
  simTime: number;
  placeAt(p: V3 | undefined, q: V3, vel: V3, ahead: number): V3;
  satPlace(s: { n: number; pos: V3 }): V3;
  /** A satellite's world position, between snapshots. */
  satWorld(n: number): V3 | null;
}

function frameMotion(curr: Received, prev: Received | null, ts: number, now: number): FrameMotion {
  // Render between snapshots so motion is smooth at any frame rate. Live: where the snapshot
  // clock is, a steady sim time a couple of snapshots behind the newest, between the two either
  // side of it (`from`, `to`), so their uneven arrival doesn't show. A replay: between the pair
  // it gave (made prev and curr above). Only places, attitudes and simTime come from these;
  // everything else is the newest snapshot's, `snap`.
  const snap = curr.snap;
  const live = replay.active ? null : motion.sample(Math.min(ts, now));
  const span = prev ? curr.at - prev.at : 0;
  const from = live ? live.a : (prev?.snap ?? null);
  const to = live ? live.b : snap;
  const alpha = live ? live.alpha : span > 0 ? Math.min(1, (now - curr.at) / span) : 1;
  const simTime = from ? from.t + (to.t - from.t) * alpha : to.t;
  /**
   * Where something is at simTime: between its places in the two snapshots (p, q); or, when it
   * isn't in the earlier one yet (a stage just separated, a satellite just out), back along its
   * velocity from the first place it's known (q, `ahead` seconds on), so it doesn't run ahead
   * of the rest for a frame or two.
   */
  const placeAt = (p: V3 | undefined, q: V3, vel: V3, ahead: number): V3 =>
    p
      ? [p[0] + (q[0] - p[0]) * alpha, p[1] + (q[1] - p[1]) * alpha, p[2] + (q[2] - p[2]) * alpha]
      : [q[0] - vel[0] * ahead, q[1] - vel[1] * ahead, q[2] - vel[2] * ahead];
  /** A satellite out of the bay, in pad ENU at simTime (one just deployed is moving as the ship is). */
  const shipVel: V3 = snap.vehicles.find((v) => v.id === 'ship')?.telemetry.vAirEnu ?? [0, 0, 0];
  const satPlace = (s: { n: number; pos: V3 }): V3 => {
    const q = to === snap ? s : to.payload?.sats.find((x) => x.n === s.n);
    const p = q && from?.payload?.sats.find((x) => x.n === s.n);
    return placeAt(p ? p.pos : undefined, (q ?? s).pos, shipVel, (q ? to.t : snap.t) - simTime);
  };
  /** A satellite's world position, between snapshots. */
  const satWorld = (n: number): V3 | null => {
    const s = snap.payload?.sats.find((x) => x.n === n);
    return s ? enuToWorld(satPlace(s)) : null;
  };
  return { snap, from, to, alpha, simTime, placeAt, satPlace, satWorld };
}

/** The time of day, from this flight's (or menu scene's) first snapshot on: the day angle. */
function timeOfDayStep(snap: Snapshot, simTime: number): number {
  // The time of day, from this flight's (or menu scene's) first snapshot on.
  if (!dayRef && workerReady()) {
    dayRef = { t: snap.t, missionTime: snap.missionTime ?? 0 };
    const flown = snap.vehicles.find((v) => v.id === trackedId)?.telemetry;
    dayPhase = dayWants ? daylightPhase(dayWants, dayRef.missionTime, flown ? { lat: flown.lat, lon: flown.lon } : null) : 0;
  }
  // (Dev-only: __dayOffset, rad, shifts the time of day, e.g. Math.PI for night.)
  const dayOffset = import.meta.env.DEV ? ((window as unknown as { __dayOffset?: number }).__dayOffset ?? 0) : 0;
  const dayAngle = dayPhase + (dayRef ? DAY_RATE * (simTime - dayRef.t) : 0) + dayOffset;
  world.setDay(dayAngle, EARTH_AXIS_WORLD);
  return dayAngle;
}

/** The blast the camera is watching, if the tracked vehicle blew up (else on to what's still flying). */
function watchBlastStep(snap: Snapshot, now: number): Blast | null {
  // The tracked vehicle blew up: watch the explosion for a while (V switches sooner), then go
  // over to whatever is still flying.
  let watching: Blast | null = null;
  if (workerReady() && !snap.vehicles.some((v) => v.id === trackedId && v.status !== 'destroyed')) {
    const blast = blasts.get(trackedId);
    if (blast && now - blast.since < WATCH_BLAST_MS) watching = blast;
    else {
      const next = snap.vehicles.find((v) => v.id === 'ship' && v.status !== 'destroyed')?.id
        ?? snap.vehicles.find((v) => v.status !== 'destroyed')?.id
        ?? trackedId;
      if (next !== trackedId) {
        trackedId = next;
        pilotCtl.set({ manual: pilotCtl.manualVehicles.has(next) });
      }
    }
  }
  return watching;
}

/** The vehicles placed and turned for this frame (their sonic booms too), and the camera's target on the tracked one. */
function placeVehiclesStep(m: FrameMotion): { placements: FxVehicle[]; target: CameraTarget | null } {
  const { snap, from, to, alpha, simTime, placeAt, satWorld } = m;
  const placements: FxVehicle[] = [];
  let target: CameraTarget | null = null;
  if (satFocus !== null && !snap.payload?.sats.some((x) => x.n === satFocus)) satFocus = null;
  const sats = snap.payload?.sats ?? [];
  const camSat = satFocus ?? (sats.length ? sats[sats.length - 1].n : null);
  for (const v of snap.vehicles) {
    const mesh = meshes.get(v.id);
    if (!mesh) continue;
    // (Its place and attitude: as the two snapshots the clock is between have them.)
    const q = to === snap ? v : to.vehicles.find((x) => x.id === v.id);
    const p = q && from?.vehicles.find((x) => x.id === v.id);
    const pos = placeAt(p ? p.pos : undefined, (q ?? v).pos, v.telemetry.vAirEnu, (q ? to.t : snap.t) - simTime);
    vehicleQuaternion((q ?? v).rot, qb);
    if (p) qb.copy(vehicleQuaternion(p.rot, qa).slerp(qb, alpha));
    mesh.root.quaternion.copy(qb);
    mesh.update(v, simTime);
    if (v.stages.includes('ship')) {
      mesh.setPayloadDoor(snap.payload?.door ?? 0, (rig.mode === 'bay' || rig.mode === 'baytop') && !rig.map && v.id === trackedId);
      mesh.setShield(snap.shield);
    }
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
      // (Dev-only: __focusAlong, m, moves the aim along the tracked vehicle's axis from its base.)
      const along = import.meta.env.DEV ? (window as unknown as { __focusAlong?: number }).__focusAlong : undefined;
      const mid = along ?? midpoint(v);
      target = {
        center: [w[0] + up.x * mid, w[1] + up.y * mid, w[2] + up.z * mid],
        axis: [up.x, up.y, up.z],
        size: v.stages.length === 2 ? BOOSTER_LENGTH + SHIP_LENGTH : v.stages[0] === 'ship' ? SHIP_LENGTH : BOOSTER_LENGTH,
        belly: ((b) => [b.x, b.y, b.z] as V3)(new THREE.Vector3(1, 0, 0).applyQuaternion(qb)),
      };
      if (v.stages.length === 1 && v.stages[0] === 'ship') {
        // The payload door (Starlink flights): on the leeward side (mesh -x), doorX above the ship's base.
        if (snap.payload) {
          const out = new THREE.Vector3(-1, 0, 0).applyQuaternion(qb);
          const h = BOOSTER_LENGTH + STARLINK_V3.doorX;
          const side = new THREE.Vector3(0, 0, -1).applyQuaternion(qb);
          target.door = { at: [w[0] + up.x * h + out.x * 4.5, w[1] + up.y * h + out.y * 4.5, w[2] + up.z * h + out.z * 4.5], out: [out.x, out.y, out.z], side: [side.x, side.y, side.z] };
        }
        if (camSat !== null) target.sat = satWorld(camSat) ?? undefined;
      }
    }
  }
  return { placements, target };
}

/** Where the camera aims (the tracked vehicle, a satellite, the menu's pad, a blast) and the camera moved there: its place. */
function aimCameraStep(m: FrameMotion, target: CameraTarget | null, watching: Blast | null, frameDt: number, now: number): V3 {
  const { snap, satWorld } = m;
  // Dev-only: __debug.focus = [x, y, z] (world) aims the orbit camera at a fixed point instead;
  // __focusSat = n at the nth Starlink deployed.
  const focusSat = import.meta.env.DEV ? (window as unknown as { __focusSat?: number }).__focusSat : undefined;
  const satAt = focusSat !== undefined ? snap.payload?.sats.find((x) => x.n === focusSat) : undefined;
  const focus0 = satAt ? enuToWorld(satAt.pos) : import.meta.env.DEV ? (window as unknown as { __focus?: V3 }).__focus : undefined;
  // (A satellite picked with V: the cameras that follow something follow it.)
  const picked = satFocus !== null && !['bay', 'baytop', 'hull', 'satellite', 'inspect'].includes(rig.mode) ? satWorld(satFocus) : null;
  // (The menu's pad view: on the tower picked, gliding between them.)
  const padAt = backdrop.aim(now);
  const aim = padAt ? { center: [padAt.x, padAt.y, padAt.z] as V3, axis: [0, 1, 0] as V3, size: 140 } : picked ? { center: picked, axis: [0, 1, 0] as V3, size: 24 } : focus0 ? { center: focus0, axis: [0, 1, 0] as V3, size: 60 } : (target ?? (watching ? { center: watching.at, axis: [0, 1, 0] as V3, size: watching.radius } : null));
  // Back off far enough to take in the whole fireball.
  if (watching && rig.mode === 'orbit' && !rig.map) rig.distance += (Math.max(rig.distance, watching.radius * 3.2) - rig.distance) * Math.min(1, frameDt * 1.5);
  if (target) lastTarget = target.center;
  // Nothing left to track (it broke up): stay where it was, watching the debris.
  const cam = rig.update(world.camera, aim ?? { center: lastTarget, axis: [0, 1, 0], size: 124 });
  origin.camera = cam;
  return cam;
}

/** The map view, its marks, and the mission's landing target beacon: that target (null in the main menu). */
function mapStep(snap: Snapshot, placements: FxVehicle[], simTime: number, now: number): MissionTarget | null {
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
  return missionTarget;
}

/** Everything placed about the camera (floating origin), the Moon, the satellites, and the effects. */
function placeWorldStep(snap: Snapshot, simTime: number, placements: FxVehicle[], cam: V3, m: FrameMotion): void {
  origin.apply(world.statics);
  moon.update(simTime, world.skyRotation, world.sunDir, origin, PAD_UP, buildingUniforms.uNight.value);
  for (const pl of placements) origin.place(pl.mesh.root, pl.world);
  farCull.update(cam, world.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(world.camera.fov) / 2)));
  // Stages down in the sea: afloat on the waves, the spray off them.
  afloatFx.update(simTime, placements, fx.particles);
  for (const pl of placements) pl.mesh.afterPlace();
  // The satellites out of the bay, between snapshots as the vehicles are (they move as fast).
  if (starlink) {
    const cur = snap.payload;
    const sats = cur?.sats.map((s) => ({ ...s, pos: m.satPlace(s) }));
    starlink.update(cur && sats ? { ...cur, sats } : null, origin.camera, enuToWorld, meshes.get('ship')?.root ?? null);
  }
  // Dev-only: __fxMissionTime overrides the countdown clock the effects see (to preview the deluge).
  const fxClock = import.meta.env.DEV ? (window as unknown as { __fxMissionTime?: number }).__fxMissionTime : undefined;
  fx.update(simTime, fxClock ?? snap.missionTime, placements, world.sun, 1);
  ventFx.update(simTime, placements, fx.particles);
}

/** The engines' sound as heard at the camera (late, with the distance). */
function soundStep(placements: FxVehicle[], simTime: number, cam: V3): Heard {
  // Sound: every vehicle is a source (silent ones too, so a cut-off is heard late as well).
  for (const pl of placements) {
    const n = vehicleNoise(pl);
    sound.record(pl.snap.id, simTime, n.pos, plumePower(n.thrust, n.pressureRatio));
  }
  sound.prune(simTime);
  return sound.hear(simTime, cam);
}

/** The globe, the ground round the camera (and the pad's ahead, behind the main menu), the towers. */
function groundStep(snap: Snapshot, cam: V3, now: number): void {
  globeTiles.update(world.camera, cam);
  terrain.update(world.camera, cam, now / 1000, rig.mode === 'orbit' && !rig.map ? rig.distance : 0);
  framesDrawn++;
  if (menu.kind === 'main') warmPad();
  padRig?.update(snap.missionTime, snap.towers);
}

/** Night lighting, and the shadow map: where it covers, and whether it needs drawing again. */
function shadowStep(snap: Snapshot, placements: FxVehicle[], target: CameraTarget | null, cam: V3, dayAngle: number, now: number): void {
  // Shadows: near the ground they cover the whole launch site (both towers and the shadows they
  // cast) and, as a vehicle climbs, the ground its own shadow falls on, straight down the sun's
  // rays from it. Up high only the vehicle itself (its parts shading each other).
  const focus = target?.center ?? [0, 60, 0];
  const sd = world.sunDir;
  setBuildingNight(sd.y);
  padLights.update(now / 1000, world.renderer, world.camera);
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
  // (A hash of it all, to 5 cm and a fraction of a degree: no strings built every frame.)
  let key = 2166136261;
  const mixIn = (x: number) => {
    key = Math.imul(key ^ Math.round(x), 16777619);
  };
  for (const x of focus) mixIn(x * 20);
  mixIn(dayAngle * 2000);
  mixIn(meshes.size * 2 + (padRig ? 1 : 0));
  for (const tw of snap.towers) {
    mixIn(tw.top * 20);
    mixIn(tw.angle * 20);
    mixIn(tw.slew * 20);
    mixIn(tw.qd * 20);
    mixIn((tw.down ? 1 : 0) + (tw.broken.L ? 2 : 0) + (tw.broken.R ? 4 : 0) + (tw.qdBroken ? 8 : 0));
  }
  for (const pl of placements) {
    for (const x of pl.world) mixIn(x * 20);
    const q = pl.mesh.root.quaternion;
    mixIn(q.x * 1000);
    mixIn(q.y * 1000);
    mixIn(q.z * 1000);
  }
  if (key !== shadowKey || now - shadowAt > 2000) {
    shadowKey = key;
    shadowAt = now;
    world.shadowsDirty();
  }
}

/**
 * The camera's height (and distance from the Earth's centre), the weather there, and the sea round
 * it (sets camUp and camFromCentre).
 */
function seaAndWeatherStep(cam: V3, simTime: number, frameDt: number): { camR: number; camAlt: number; wx: LocalWeather } {
  // Camera altitude above the WGS84 ellipsoid (geocentric radius at the camera's latitude).
  camUp.set(cam[0] - EARTH_CENTER_WORLD[0], cam[1] - EARTH_CENTER_WORLD[1], cam[2] - EARTH_CENTER_WORLD[2]);
  const camR = camUp.length();
  camUp.divideScalar(camR);
  const sinLat = camUp.dot(EARTH_AXIS_WORLD);
  const cos2 = 1 - sinLat * sinLat;
  const camAlt = camR - Math.sqrt(((RE * RE) ** 2 * cos2 + (RP * RP) ** 2 * sinLat * sinLat) / (RE * RE * cos2 + RP * RP * sinLat * sinLat));
  camFromCentre.set(cam[0] - EARTH_CENTER_WORLD[0], cam[1] - EARTH_CENTER_WORLD[1], cam[2] - EARTH_CENTER_WORLD[2]);
  // (Fresh: the snapshot is from the latest flight / scene, so its clock can start new weather.)
  weather.update(simTime, world.sunDir, workerSceneId >= scenesSent);
  const wx = weather.local(camFromCentre, camAlt);
  // The sea: waves for the wind round the camera.
  seaEast.crossVectors(EARTH_AXIS_WORLD, camUp).normalize();
  seaNorth.crossVectors(camUp, seaEast);
  sea.update(paused ? 0 : frameDt, cam, EARTH_CENTER_WORLD, weather.surfaceWind(camFromCentre), seaEast, seaNorth);
  {
    // (Under the camera, at sea level: the local vertical and east / north there.)
    const g = worldToGeodetic(cam);
    const wl = terrain.waterLevelWorld + PAD.groundAlt;
    const ground = toWorld(g.lat, g.lon, wl);
    const above = toWorld(g.lat, g.lon, wl + 1000);
    const eastP = toWorld(g.lat, g.lon + 0.01, wl);
    const sg = seaGround;
    sg.up.set(above[0] - ground[0], above[1] - ground[1], above[2] - ground[2]).normalize();
    sg.east.set(eastP[0] - ground[0], eastP[1] - ground[1], eastP[2] - ground[2]);
    sg.east.addScaledVector(sg.up, -sg.east.dot(sg.up)).normalize();
    sg.north.crossVectors(sg.up, sg.east);
    oceanSurface.update(world.renderer, cam, g.h - wl, sg.up, sg.east, sg.north, ground, !rig.map && terrain.ready, terrain, globeTiles, afloatFx.hulls);
    // What the vehicles reflect from below: sea or land under the camera (eased), the Earth from high up.
    const gh = terrain.groundHeight(g.lat, g.lon);
    const overSea = gh === null || gh - PAD.groundAlt < terrain.waterLevelWorld + 0.3 ? 1 : 0;
    seaUnder += (overSea - seaUnder) * Math.min(1, frameDt * 0.7);
    world.setSurroundings(seaUnder, camAlt);
  }
  return { camR, camAlt, wx };
}

/** The engines' roar, and everything else heard (ambience.ts). */
function audioStep(snap: Snapshot, placements: FxVehicle[], heard: Heard, cam: V3, camAlt: number, simTime: number, frameDt: number, wx: LocalWeather): void {
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
}

/** The camera's shake, the sky, the clouds, overcast, lightning and rain. */
function skyStep(cam: V3, camR: number, camAlt: number, simTime: number, frameDt: number, wx: LocalWeather, heard: Heard, now: number): void {
  fx.shake(world.camera, paused || rig.map ? -Infinity : heard.level, now / 1000);
  earthCenterRel.set(EARTH_CENTER_WORLD[0] - cam[0], EARTH_CENTER_WORLD[1] - cam[1], EARTH_CENTER_WORLD[2] - cam[2]);
  world.updateSky(camAlt, camUp, earthCenterRel, camR - camAlt);
  // Weather: the clouds (drawn by the atmosphere pass), overcast dimming the sun, rain.
  weather.apply(world.atmosphere);
  world.sun.intensity *= wx.sun;
  world.setOvercast(Math.min(1, Math.max(0, (1 - wx.sun) / 0.65)));
  // Lightning in the thunderstorms round the camera: bolts, the clouds flashing, thunder.
  lightning.update(frameDt, paused || menu.kind === 'pause', weather.enabled ? weather.model : null, simTime, cam, camFromCentre, camAlt, WORLD_TO_ECEF,
    lightningScreen.set(world.renderer.getContext().drawingBufferWidth, world.renderer.getContext().drawingBufferHeight));
  {
    const f = lightning.flash;
    const u = world.atmosphere.uniforms.uFlash.value as THREE.Vector4;
    // (In the clouds' march space: the ellipsoid stretched to a sphere along the axis.)
    const ax = f.pos.dot(EARTH_AXIS_WORLD) * (RE / RP - 1);
    u.set(f.pos.x + EARTH_AXIS_WORLD.x * ax, f.pos.y + EARTH_AXIS_WORLD.y * ax, f.pos.z + EARTH_AXIS_WORLD.z * ax, rig.map ? 0 : f.level);
    // (And on the ground and everything near, as far as the flash's light reaches: a few km.)
    const fd = f.level > 0 ? f.pos.distanceTo(camFromCentre) : Infinity;
    world.setFlash(rig.map ? 0 : f.level / (1 + (fd / 4000) ** 2));
  }
  if (!paused) rainClock += frameDt;
  rain.update(rig.map ? 0 : wx.rain, cam, camUp, rainClock, wx.sun * Math.min(1, Math.max(0.05, (world.sunDir.dot(camUp) + 0.1) / 0.35)));
}

/** Main menu: frame the pad off to the right, clear of the menu (eased in and out). */
function menuShiftStep(frameDt: number): void {
  menuShift += ((menu.kind === 'main' ? 1 : 0) - menuShift) * Math.min(1, frameDt * 3);
  if (menuShift > 0.001) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shift = backdrop.shift();
    world.camera.setViewOffset(w, h, -w * shift * menuShift, 0, w, h);
  } else if (world.camera.view) world.camera.clearViewOffset();
}

/** The frame drawn, then the panels over it; the frame's times kept for the pacing. */
function drawStep(snap: Snapshot, missionTarget: MissionTarget | null, now: number): void {
  // (Screen scale for effects sized in metres, e.g. the reentry sparks.)
  VehicleMesh.pixelRatio = world.renderer.getPixelRatio();
  VehicleMesh.screenScale = (world.renderer.getContext().drawingBufferHeight / 2) * world.camera.projectionMatrix.elements[5];
  const renderAt = performance.now();
  world.render();
  lastRenderMs = performance.now() - renderAt;
  plot.draw();
  flightPanel.update(snap, snap.vehicles.find((v) => v.id === trackedId), missionTarget);
  maneuverPanel.update(snap, trackedId, trajectories.get(trackedId) ?? null, rig.map, warpTo);
  returnPanel.update(snap, trackedId, rig.map, warpTo);
  missionUi.updateTracker(snap.phase === 'prelaunch' ? null : tracker.mission, tracker.states(), tracker.score().total);
  lastCpuMs = performance.now() - now;
  frozenFrame = menu.kind === 'pause' && paused;
}
requestAnimationFrame(loop);

// Corner buttons; not losing a flight by accident; the keyboard in full screen; the graphics
// context taken away (ui/windowChrome.ts).
installWindowChrome({
  canvas,
  menu,
  openPauseMenu,
  inFlight,
  askSave: () => void saves.askSave(),
  send,
  paused: () => paused,
  replayActive: () => replay.active,
  inPhoto: () => views.inPhoto(),
});

// Start at the main menu (once everything above is set up).
menu.open('main', { mission: missionUi.selected });
