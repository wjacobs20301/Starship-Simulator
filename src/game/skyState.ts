// The sky's state: the time of day (the Earth turning once in 24 h of sim time), the weather (a
// planet-wide map of it, picked and configured for each flight and menu scene, the season), rain
// and lightning, and the sea round the camera; and the frame steps that only concern them.
// (Moved out of main.ts: its "Time of day" and "Weather" sections, from dayPhase to the settings'
// weather, and the frame steps timeOfDayStep, seaAndWeatherStep and skyStep.)

import * as THREE from 'three';
import type { Ambience } from '../audio/ambience';
import type { Heard } from '../audio/soundField';
import type { CameraRig } from '../render/cameras';
import type { LaunchFx } from '../render/fx/launchFx';
import type { AfloatFx } from '../render/fx/afloat';
import { Lightning } from '../render/fx/lightning';
import { Rain } from '../render/fx/rain';
import { ecefToWorld, toWorld, worldToGeodetic } from '../render/geo';
import type { GlobeTiles } from '../render/globeTiles';
import { sea } from '../render/ocean';
import { OceanSurface } from '../render/oceanSurface';
import { SUN_AT_DAY0, type World } from '../render/scene';
import { type Terrain, seaColourUniforms } from '../render/terrain';
import { Weather } from '../render/weather';
import { type StarbaseWeather, WEATHER_AVAILABLE, onSettingsChange, settings } from '../settings';
import { PAD, RE, RP } from '../sim/constants';
import type { V3 } from '../sim/math';
import type { Snapshot } from '../sim/simulation';
import type { GameMenu } from '../ui/gameMenu';
import { starbaseDay } from '../weather/model';
import type { ToWorker } from '../worker/protocol';
import { DAY_RATE, type DaylightAt, daylightPhase } from './daylight';
import { type FlightView, workerCaughtUp } from './flightView';
import type { MenuBackdrop } from './menuBackdrop';
import type { MissionDef } from './missions';
import type { FlightSave } from './savedFlight';

export const EARTH_CENTER_WORLD = ecefToWorld([0, 0, 0]);
export const EARTH_AXIS_WORLD = new THREE.Vector3(...ecefToWorld([0, 0, 1e6])).sub(new THREE.Vector3(...EARTH_CENTER_WORLD)).normalize();

/** Render world -> Earth-fixed (ECEF) directions (the weather map's axes). */
const WORLD_TO_ECEF = (() => {
  const c = new THREE.Vector3(...EARTH_CENTER_WORLD);
  const [ex, ey, ez] = ([[1e6, 0, 0], [0, 1e6, 0], [0, 0, 1e6]] as const).map((p) => new THREE.Vector3(...ecefToWorld([...p])).sub(c).normalize());
  return new THREE.Matrix3().set(ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z);
})();
/** The weather where the camera is (Weather.local). */
export type LocalWeather = ReturnType<Weather['local']>;
/** The season: the sun's latitude (it stays put through a flight's days), degrees. */
const SEASON = THREE.MathUtils.radToDeg(Math.asin(SUN_AT_DAY0.dot(EARTH_AXIS_WORLD)));

export interface SkyStateDeps {
  world: World;
  rig: CameraRig;
  menu: Pick<GameMenu, 'kind'>;
  fx: LaunchFx;
  terrain: Terrain;
  globeTiles: GlobeTiles;
  afloatFx: AfloatFx;
  ambience: Ambience;
  /** The mission (missions always fly in fair weather). */
  tracker: { readonly mission: MissionDef };
  /** The menu's pad view (it takes a new free roam weather setting while it's up). */
  backdrop: Pick<MenuBackdrop, 'freeWeatherChanged'>;
  send(m: ToWorker): void;
  /** The tracked vehicle, paused, and the worker's count of scenes (the day and weather start from its first snapshot). */
  flight: FlightView;
}

export interface SkyState {
  readonly weather: Weather;
  readonly oceanSurface: OceanSurface;
  readonly lightning: Lightning;
  /** A new day: what the flight about to start wants in daylight (null: morning at Starbase, day angle 0). */
  startDay(wants: DaylightAt[] | null): void;
  /** The time of day as a save keeps it (null: not yet in). */
  daySave(): { phase: number; t: number; missionTime: number } | null;
  /** A saved flight's weather and time of day taken up. */
  takeUp(s: FlightSave): void;
  /** A menu scene's own weather over Starbase (null: the setting's). */
  setSceneWeather(w: StarbaseWeather | null): void;
  /** New weather for the flight or menu scene (morph: blended into from the sky there is). */
  applyWeatherSetting(morph?: boolean): void;
  /** Free roam's weather pick as a day's weather ('Starbase' rolls one). */
  freeWeatherPick(): StarbaseWeather;
  /** The weather over Starbase this flight. */
  weatherToday(): StarbaseWeather;
  /** The time of day, from this flight's (or menu scene's) first snapshot on: the day angle. */
  timeOfDayStep(snap: Snapshot, simTime: number): number;
  /** The camera's height (and distance from the Earth's centre), the weather there, and the sea round it. */
  seaAndWeatherStep(cam: V3, simTime: number, frameDt: number): { camR: number; camAlt: number; wx: LocalWeather };
  /** The camera's shake, the sky, the clouds, overcast, lightning and rain. */
  skyStep(cam: V3, camR: number, camAlt: number, simTime: number, frameDt: number, wx: LocalWeather, heard: Heard, now: number): void;
}

export function createSkyState(deps: SkyStateDeps): SkyState {
  const { world, rig, menu, fx, terrain, globeTiles, afloatFx, ambience, tracker, backdrop, send, flight } = deps;
  const camUp = new THREE.Vector3();
  const earthCenterRel = new THREE.Vector3();
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
  const weather = new Weather(EARTH_AXIS_WORLD.clone(), WORLD_TO_ECEF, PAD.latDeg, PAD.lonDeg);
  // The sea near the camera: a mesh rising and falling with the waves, at sea level.
  const oceanSurface = new OceanSurface({ ...seaColourUniforms, uWorldToEcef: { value: WORLD_TO_ECEF } });
  world.scene.add(oceanSurface.mesh);
  world.atmosphere.setBackground(oceanSurface.mesh);
  const seaGround = { up: new THREE.Vector3(), east: new THREE.Vector3(), north: new THREE.Vector3(), v: new THREE.Vector3() };
  // (The physics flies through the same weather: its wind.)
  weather.onConfig = (cfg, land) => send({ type: 'weather', cfg, land });
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
    weatherToday = sceneWeather ?? (tracker.mission.id !== 'free' ? 'partly' : freeWeatherPick());
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

  /** Rain keeps falling in real time (any warp), stopping only when paused. */
  let rainClock = 0;
  const camFromCentre = new THREE.Vector3();
  const lightningScreen = new THREE.Vector2();

  function takeUp(s: FlightSave): void {
    // Its weather, the same world from the same moment (and so the same wind: the worker has it
    // from this before the flight itself). Its time of day.
    if (WEATHER_AVAILABLE && s.flight.weather) {
      weather.restore(s.flight.weather);
      if (s.flight.weather.site !== 'natural') weatherToday = s.flight.weather.site;
    }
    dayWants = null;
    dayPhase = s.day?.phase ?? 0;
    dayRef = s.day ? { t: s.day.t, missionTime: s.day.missionTime } : null;
  }

  function timeOfDayStep(snap: Snapshot, simTime: number): number {
    // The time of day, from this flight's (or menu scene's) first snapshot on.
    if (!dayRef && workerCaughtUp(flight)) {
      dayRef = { t: snap.t, missionTime: snap.missionTime ?? 0 };
      const flown = snap.vehicles.find((v) => v.id === flight.trackedId)?.telemetry;
      dayPhase = dayWants ? daylightPhase(dayWants, dayRef.missionTime, flown ? { lat: flown.lat, lon: flown.lon } : null) : 0;
    }
    // (Dev-only: __dayOffset, rad, shifts the time of day, e.g. Math.PI for night.)
    const dayOffset = import.meta.env.DEV ? ((window as unknown as { __dayOffset?: number }).__dayOffset ?? 0) : 0;
    const dayAngle = dayPhase + (dayRef ? DAY_RATE * (simTime - dayRef.t) : 0) + dayOffset;
    world.setDay(dayAngle, EARTH_AXIS_WORLD);
    return dayAngle;
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
    weather.update(simTime, world.sunDir, flight.workerSceneId >= flight.scenesSent);
    const wx = weather.local(camFromCentre, camAlt);
    // The sea: waves for the wind round the camera.
    seaEast.crossVectors(EARTH_AXIS_WORLD, camUp).normalize();
    seaNorth.crossVectors(camUp, seaEast);
    sea.update(flight.paused ? 0 : frameDt, cam, EARTH_CENTER_WORLD, weather.surfaceWind(camFromCentre), seaEast, seaNorth);
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

  function skyStep(cam: V3, camR: number, camAlt: number, simTime: number, frameDt: number, wx: LocalWeather, heard: Heard, now: number): void {
    fx.shake(world.camera, flight.paused || rig.map ? -Infinity : heard.level, now / 1000);
    earthCenterRel.set(EARTH_CENTER_WORLD[0] - cam[0], EARTH_CENTER_WORLD[1] - cam[1], EARTH_CENTER_WORLD[2] - cam[2]);
    world.updateSky(camAlt, camUp, earthCenterRel, camR - camAlt);
    // Weather: the clouds (drawn by the atmosphere pass), overcast dimming the sun, rain.
    weather.apply(world.atmosphere);
    world.sun.intensity *= wx.sun;
    world.setOvercast(Math.min(1, Math.max(0, (1 - wx.sun) / 0.65)));
    // Lightning in the thunderstorms round the camera: bolts, the clouds flashing, thunder.
    lightning.update(frameDt, flight.paused || menu.kind === 'pause', weather.enabled ? weather.model : null, simTime, cam, camFromCentre, camAlt, WORLD_TO_ECEF,
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
    if (!flight.paused) rainClock += frameDt;
    rain.update(rig.map ? 0 : wx.rain, cam, camUp, rainClock, wx.sun * Math.min(1, Math.max(0.05, (world.sunDir.dot(camUp) + 0.1) / 0.35)));
  }

  return {
    weather,
    oceanSurface,
    lightning,
    startDay,
    daySave: () => (dayRef ? { phase: dayPhase, t: dayRef.t, missionTime: dayRef.missionTime } : null),
    takeUp,
    setSceneWeather: (w) => {
      sceneWeather = w;
    },
    applyWeatherSetting,
    freeWeatherPick,
    weatherToday: () => weatherToday,
    timeOfDayStep,
    seaAndWeatherStep,
    skyStep,
  };
}
