import * as THREE from 'three';
import type { V3 } from './sim/math';
import type { Snapshot } from './sim/simulation';
import { CAMERA_LABELS, CameraRig, type CameraTarget } from './render/cameras';
import { FloatingOrigin, enuToWorld } from './render/floatingOrigin';
import { type ModelLibrary, loadModels } from './render/models';
import { applyShipSerial } from './render/decals';
import { buildingUniforms, loadFacilities } from './render/facilities';
import { farShadowCasters } from './render/farShadows';
import { rocketGarden } from './render/rocketGarden';
import { loadSouthPadre } from './render/southPadre';
import { createLaunchSite } from './render/launchSite';
import { PadLights, lampLightAll } from './render/padLights';
import { Moon } from './render/moon';
import { WEATHER_NAME, onSettingsChange, settings, updateSettings } from './settings';
import { type PadRig, createWorld } from './render/scene';
import { createFramePacing } from './render/framePacing';
import { RE } from './sim/constants';
import { GlobeTiles } from './render/globeTiles';
import { ecefToWorld, worldToGeodetic } from './render/geo';
import { sea } from './render/ocean';
import { AfloatFx } from './render/fx/afloat';
import { FarCull } from './render/farCull';
import { Director } from './render/director';
import { Terrain } from './render/terrain';
import { tileTextureStats } from './render/tileTexture';
import { MapView } from './render/mapView';
import type { Trajectory } from './sim/trajectory';
import { VehicleMesh } from './render/vehicleMesh';
import { type Blast, createVehicleMeshes } from './render/vehicleMeshes';
import { createShadows } from './render/shadows';
import { type FrameMotion, frameMotion } from './render/frameMotion';
import { createMapMarks } from './render/mapMarks';
import { StarlinkFleet, loadStarlink } from './render/starlink';
import { type FxVehicle, LaunchFx } from './render/fx/launchFx';
import { VentFx } from './render/fx/vent';
import { LaunchAudio } from './audio/launchAudio';
import { AudioEngine } from './audio/engine';
import { Ambience } from './audio/ambience';
import { MenuAudio } from './audio/menuAudio';
import { SoundField } from './audio/soundField';
import { createFlightSound } from './audio/flightSound';
import { Hud, formatClock } from './ui/hud';
import { type InputActions, WARP_LEVELS, bindKeys } from './ui/input';
import { SnapshotClock } from './render/snapshotClock';
import { keyText, paintKeys } from './ui/keyLabels';
import { GamepadInput } from './ui/gamepad';
import { Replay } from './ui/replay';
import { ManeuverPanel } from './ui/maneuverPanel';
import { missionDaylight } from './game/daylight';
import { flightLines } from './ui/statusLines';
import { ShieldPanel } from './ui/shieldPanel';
import { BOOSTER_OCEAN_ENU, type MissionDef, type MissionTarget, MissionTracker, missionById } from './game/missions';
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
import { createFlightView, workerCaughtUp } from './game/flightView';
import { EARTH_CENTER_WORLD, createSkyState } from './game/skyState';
import { createMissionFlow } from './game/missionFlow';
import { createPreparing } from './ui/preparing';
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
onSettingsChange((s) => audioEngine.setMuted(s.muted, s.volume));
// The flight displays' size, and the camera's speed.
onSettingsChange((s) => {
  document.documentElement.style.setProperty('--ui-scale', String(s.uiScale));
  rig.sensitivity = s.cameraSpeed;
});
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
    farShadowCasters.push(g);
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
        farShadowCasters.push(garden);
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
    if (import.meta.env.DEV) Object.assign(window, { __debug: { sea, oceanSurface: sky.oceanSurface, afloatFx, farCull, models, padRig, world, meshes: vehicleMeshes.meshes, terrain, settings, updateSettings, rig, fx, sound, pr: () => pacing.state().pixelRatio, pacing: () => pacing.state(), frame, globeTiles, tileTextureStats, mapView, flightPanel, hud, plot, ambience, audioEngine, lightning: sky.lightning, starlink: () => starlink, menu, menuAudio, weather: sky.weather, moon, origin, showScene: backdrop.showScene } });
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
/** The tracked vehicle, the Starlink followed, paused, the launch pad, the worker's scene count (game/flightView.ts). */
const flight = createFlightView();
/** The auto camera (render/director.ts; the log lines it hasn't seen yet: game/viewModes.ts). */
const director = new Director();
/** Instant replay (ui/replay.ts): the live snapshots it keeps (the live ones while it plays: game/viewModes.ts). */
const replay = new Replay();
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
  flight.paused = ev.data.paused;
  warpTo = ev.data.warpTo;
  flight.workerSceneId = ev.data.sceneId;
  plot.record(curr.snap);
  flightSound.noteTowers(prev, curr);
  views.noteEvents(curr.snap.events);
  flightSound.eventSounds(curr.snap);
  missionFlow.followMission(curr.snap);
  if (ev.data.trajectories) {
    trajectories.clear();
    for (const t of ev.data.trajectories) trajectories.set(t.id, t);
    mapView.setTrajectories(ev.data.trajectories);
  }
  // Hot staging hands the player a fresh stage: full throttle, all engines.
  if (prev && prev.snap.phase === 'hotstaging' && curr.snap.phase === 'shipburn' && pilotCtl.cmd.manual) pilotCtl.set({ throttle: 1, engines: 0 });
  const shipOrbit = trajectories.get('ship')?.orbit ?? null;
  hud.update(curr.snap, { camera: rig.map ? 'Map' : (director.enabled ? 'Auto camera: ' : '') + CAMERA_LABELS[rig.mode], tracked: trackedName(), warp: warpLabel(), paused: flight.paused, armsPad, manual: pilotCtl.cmd.manual, orbit: shipOrbit, weather: sky.weather.enabled ? WEATHER_NAME[sky.weatherToday()] : '', payload: flightLines(curr.snap, tracker.mission.id === 'free') });
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
  paused: () => flight.paused,
  manual: () => pilotCtl.cmd.manual,
  tracked: () => flight.trackedId,
  setTracked: (id) => {
    flight.trackedId = id;
  },
  setSatFocus: (n) => {
    flight.satFocus = n;
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

// --- Main menu backdrops (game/menuBackdrop.ts) ------------------------------------------------
const backdrop = createMenuBackdrop({
  menu,
  rig,
  settle: () => pacing.settle(),
  // (Menu scenes asked for, and the worker's count of those it has set up: flight.scenesSent, flight.workerSceneId.)
  sendScene: (m) => {
    send(m);
    flight.scenesSent++;
  },
  workerReady: () => workerReady(),
  enter: (w, track) => {
    sky.setSceneWeather(w);
    sky.applyWeatherSetting();
    sky.startDay(null);
    vehicleMeshes.blasts.clear();
    send({ type: 'warp', value: 1 });
    send({ type: 'node', node: null });
    flight.trackedId = track;
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
  weatherToday: () => sky.weatherToday(),
  pickFreeWeather: () => sky.freeWeatherPick(),
  setWeather: (w, morph) => {
    sky.setSceneWeather(w);
    sky.applyWeatherSetting(morph);
  },
});

function openPauseMenu(): void {
  menuPaused = !flight.paused;
  if (menuPaused) send({ type: 'pause', value: true });
  const tm = curr?.snap.missionTime ?? null;
  menu.open('pause', { status: `${tracker.mission.title.toUpperCase()}${tm !== null ? ` · ${formatClock(tm)}` : ''}` });
}

/** The pad the flight starts from (0 = Pad 1); the arrow keys drive its arms. (flight.launchPad) */
function setLaunchPad(pad: number): void {
  flight.launchPad = pad;
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
    pad: flight.launchPad,
    tracked: flight.trackedId,
    manual: [...pilotCtl.manualVehicles],
    day: sky.daySave(),
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
  sky.setSceneWeather(null);
  backdrop.clearPadView();
  // (Its weather and time of day: game/skyState.ts.)
  sky.takeUp(s);
  send({ type: 'load', data: s.flight });
  flight.scenesSent++;
  flight.trackedId = s.tracked;
  flight.satFocus = null;
  pilotCtl.manualVehicles.clear();
  for (const id of s.manual) pilotCtl.manualVehicles.add(id);
  views.restartDirector(false);
  preparing.showPreparing(true);
  plot.reset();
  hud.clearLog();
  missionUi.hideResults();
  vehicleMeshes.blasts.clear();
}

function resetFlight(): void {
  saves.newFlight();
  pacing.settle();
  // (A new weather map for the flight: the Settings' weather, not a menu scene's.)
  sky.setSceneWeather(null);
  backdrop.clearPadView();
  sky.applyWeatherSetting();
  const setup = tracker.mission.setup;
  const start = setup.start ?? 'pad';
  if (setup.pad !== undefined && flight.launchPad !== setup.pad) setLaunchPad(setup.pad);
  sky.startDay(missionDaylight(tracker.mission));
  send({ type: 'reset', pad: flight.launchPad, start, boosterOcean: setup.boosterOcean ? BOOSTER_OCEAN_ENU : null, options: missionFlow.flightOptions(setup) });
  flight.scenesSent++;
  send({ type: 'warp', value: 1 });
  send({ type: 'node', node: null });
  // Hand-flown missions (and free roam) start with the player at the controls, autopilot off
  // for what they fly: set up for where it starts.
  flight.trackedId = setup.fly ?? 'stack';
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
  preparing.showPreparing(start !== 'pad');
  plot.reset();
  hud.clearLog();
  tracker.reset();
  missionUi.hideResults();
  vehicleMeshes.blasts.clear();
}

// The screen over the start of a flight, and the pad's ground loaded ahead behind the main menu
// (ui/preparing.ts: it puts its screen in the page here).
const preparing = createPreparing({ tracker, flight, terrain, world, models: () => models });

/** The worker has caught up with the last scene / mission set-up asked for. */
const workerReady = () => workerCaughtUp(flight);
/** A flight is under way (not a menu backdrop, not the stack waiting on the pad). */
const inFlight = () => menu.kind !== 'main' && !!curr && curr.snap.phase !== 'prelaunch';

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
  tracked: () => flight.trackedId,
  setTracked: (id) => {
    flight.trackedId = id;
  },
  workerReady: () => workerReady(),
  send,
  adoptPending: () => saves.adoptPending(),
  adoptDone: () => saves.adoptDone(),
});

// The launch, the hand-overs the flight's events drive, scoring, a new flight's options (game/missionFlow.ts).
const missionFlow = createMissionFlow({ tracker, missionUi, menu, pilotCtl, send, flight });

const flightPanel = new FlightPanel(hud.webcast, document.querySelector('#console')!, (mode) => {
  if (!pilotCtl.cmd.manual) pilotCtl.set({ manual: true, ...pilotCtl.takeOver() });
  pilotCtl.set({ sas: mode });
});

const actions: InputActions = {
  spaceBar: () => {
    if (replay.active) return replay.togglePlay();
    const phase = curr?.snap.phase;
    if (phase === 'prelaunch') missionFlow.startMission();
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
      const ship = curr?.snap.vehicles.find((v) => v.id === flight.trackedId && v.stages.length === 1 && v.stages[0] === 'ship' && v.status !== 'destroyed');
      return !!ship && (need === 'door' ? !!curr?.snap.payload : !!curr?.snap.payload?.sats.length);
    })),
  toggleMap: () => rig.toggleMap(lastTarget),
  cycleTarget: () => {
    views.stopDirector();
    const ids = curr?.snap.vehicles.filter((v) => v.status !== 'destroyed').map((v) => v.id) ?? [];
    // After the vehicles, the satellites out (the cameras follow one; the ship stays the one tracked).
    const sats = curr?.snap.payload?.sats.map((s) => s.n) ?? [];
    if (flight.satFocus !== null) {
      const i = sats.indexOf(flight.satFocus);
      flight.satFocus = i >= 0 && i + 1 < sats.length ? sats[i + 1] : null;
      if (flight.satFocus === null && ids.length) flight.trackedId = ids[0];
      pilotCtl.set({ manual: pilotCtl.manualVehicles.has(flight.trackedId) });
      return;
    }
    if (sats.length && ids.indexOf(flight.trackedId) === ids.length - 1 && ids.includes('ship')) {
      flight.trackedId = 'ship';
      flight.satFocus = sats[0];
      pilotCtl.set({ manual: pilotCtl.manualVehicles.has(flight.trackedId) });
      return;
    }
    if (ids.length) flight.trackedId = ids[(ids.indexOf(flight.trackedId) + 1) % ids.length];
    // Looking at another vehicle doesn't take its autopilot away: the controls are yours only
    // on the ones you've taken over (L).
    pilotCtl.set({ manual: pilotCtl.manualVehicles.has(flight.trackedId) });
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
  if (flight.satFocus !== null) return `Starlink ${flight.satFocus}`;
  return curr?.snap.vehicles.find((v) => v.id === flight.trackedId)?.name ?? '—';
}

// --- Vehicles ---------------------------------------------------------------------
// (render/vehicleMeshes.ts)

const vehicleMeshes = createVehicleMeshes({ world, origin, rig, fx, ambience, models: () => models, flight, pilotCtl });
// The map view's marks, and the mission's landing target beacon (render/mapMarks.ts: in the scene here).
const mapMarks = createMapMarks({ world, origin, rig, mapView, menu, tracker, returnPanel, flight });
// What's heard of the flight: the menu's music, one-off sounds, the engines, the ambience (audio/flightSound.ts).
const flightSound = createFlightSound({ sound, audio, ambience, menuAudio, audioEngine, menu, rig, origin, flight, vehicleMid: vehicleMeshes.vehicleMid });

// --- Time of day and weather (game/skyState.ts): the Earth turns once in 24 h of sim time; ------
// planet-wide clouds, rain under them, lightning; the sea near the camera.
const sky = createSkyState({ world, rig, menu, fx, terrain, globeTiles, afloatFx, ambience, tracker, backdrop, send, flight });
sky.applyWeatherSetting();

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

// Night lighting and the shadow map (render/shadows.ts).
const shadows = createShadows({ world, padLights, meshCount: () => vehicleMeshes.meshes.size, padRigIn: () => !!padRig });

/** The last frame's script time, ms (to tell a CPU-bound frame from a GPU-bound one). */
let lastCpuMs = 0;
/** Of it, the drawing (world.render: it waits on the GPU when that's behind), ms. */
let lastRenderMs = 0;
/** A frame was drawn while paused behind the pause menu (nothing more to draw until it closes). */
let frozenFrame = false;
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
  if (menu.kind === 'pause' && flight.paused && frozenFrame) {
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
  flightSound.menuMusicStep();
  // Main menu: the view turns slowly round the pad behind it; the backdrops change.
  backdrop.tick(frameDt, now);
  const m = frameMotion(curr, prev, ts, now, replay, motion);
  const { snap, simTime } = m;
  vehicleMeshes.syncMeshes(snap.vehicles, simTime);
  vehicleMeshes.prewarmShaders();
  views.runDirector(now, snap);
  const dayAngle = sky.timeOfDayStep(snap, simTime);
  const watching = vehicleMeshes.watchBlastStep(snap, now);
  const { placements, target } = vehicleMeshes.placeVehiclesStep(m);
  const cam = aimCameraStep(m, target, watching, frameDt, now);
  const missionTarget = mapMarks.mapStep(snap, placements, simTime, now);
  placeWorldStep(snap, simTime, placements, cam, m);
  const heard = flightSound.soundStep(placements, simTime, cam);
  groundStep(snap, cam, now);
  shadows.shadowStep(snap, placements, target, cam, dayAngle, now);
  const { camR, camAlt, wx } = sky.seaAndWeatherStep(cam, simTime, frameDt);
  flightSound.audioStep(snap, placements, heard, cam, camAlt, simTime, frameDt, wx);
  sky.skyStep(cam, camR, camAlt, simTime, frameDt, wx, heard, now);
  menuShiftStep(frameDt);
  drawStep(snap, missionTarget, now);
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
  const picked = flight.satFocus !== null && !['bay', 'baytop', 'hull', 'satellite', 'inspect'].includes(rig.mode) ? satWorld(flight.satFocus) : null;
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
    starlink.update(cur && sats ? { ...cur, sats } : null, origin.camera, enuToWorld, vehicleMeshes.meshes.get('ship')?.root ?? null);
  }
  // Dev-only: __fxMissionTime overrides the countdown clock the effects see (to preview the deluge).
  const fxClock = import.meta.env.DEV ? (window as unknown as { __fxMissionTime?: number }).__fxMissionTime : undefined;
  fx.update(simTime, fxClock ?? snap.missionTime, placements, world.sun, 1);
  ventFx.update(simTime, placements, fx.particles);
}

/** The globe, the ground round the camera (and the pad's ahead, behind the main menu), the towers. */
function groundStep(snap: Snapshot, cam: V3, now: number): void {
  globeTiles.update(world.camera, cam);
  terrain.update(world.camera, cam, now / 1000, rig.mode === 'orbit' && !rig.map ? rig.distance : 0);
  preparing.frameDrawn();
  if (menu.kind === 'main') preparing.warmPad();
  padRig?.update(snap.missionTime, snap.towers);
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
  flightPanel.update(snap, snap.vehicles.find((v) => v.id === flight.trackedId), missionTarget);
  maneuverPanel.update(snap, flight.trackedId, trajectories.get(flight.trackedId) ?? null, rig.map, warpTo);
  returnPanel.update(snap, flight.trackedId, rig.map, warpTo);
  missionUi.updateTracker(snap.phase === 'prelaunch' ? null : tracker.mission, tracker.states(), tracker.score().total);
  lastCpuMs = performance.now() - now;
  frozenFrame = menu.kind === 'pause' && flight.paused;
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
  paused: () => flight.paused,
  replayActive: () => replay.active,
  inPhoto: () => views.inPhoto(),
});

// Start at the main menu (once everything above is set up).
menu.open('main', { mission: missionUi.selected });
