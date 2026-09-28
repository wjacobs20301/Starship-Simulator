// Missions and scoring. A mission is a set of objectives checked against what happened in the
// flight (collected from snapshots and the event log by MissionTracker) and a score out of 1000.
// Pure logic (no DOM), so the headless tests can fly missions too.

import { PAD } from '../sim/constants';
import { MISSION } from '../sim/config/starshipV3';
import type { MissionStart } from '../sim/simulation';
import type { Snapshot, VehicleSnapshot } from '../sim/simulation';

export type MissionId = 'free' | 'ift' | 'shipcatch' | 'boosterreturn' | 'boostersplash' | 'ascent' | 'orbit' | 'boosterocean' | 'catch' | 'landing';
export type ObjectiveState = 'pending' | 'done' | 'failed';

/** Where the ship aims in the Indian Ocean (the autopilot's nominal splashdown), degrees. */
export const SPLASH_TARGET = MISSION.splashTarget;
export const SPLASH_ZONE_KM = 50;
/** Where Super Heavy comes down in the Gulf when it isn't going back to the tower: 32 km east of Pad 1. */
export const BOOSTER_OCEAN_ENU: [number, number] = [32000, -4000];
export const BOOSTER_OCEAN_TARGET = {
  lat: PAD.latDeg + BOOSTER_OCEAN_ENU[1] / 110_800,
  lon: PAD.lonDeg + BOOSTER_OCEAN_ENU[0] / (111_320 * Math.cos((PAD.latDeg * Math.PI) / 180)),
};
/** Booster splashdown: counts within this of the target, km. */
const BOOSTER_ZONE_KM = 3;
/** Hand-flown ascent: target apoapsis at SECO and the tolerance around it, m. */
const ASCENT_APO = 230e3;
const ASCENT_TOL = 50e3;
const ORBIT_PERIGEE = 150e3;

/** Everything the objectives and scores look at. */
export interface FlightRecord {
  liftoff: boolean;
  separated: boolean;
  seco: { perigee: number; apogee: number } | null;
  stackLost: boolean;
  boosterLost: boolean;
  shipLost: boolean;
  /** Booster on the chopsticks: offset from centre (m) and sink rate (m/s). */
  caught: { off: number; speed: number } | null;
  /** Ship on a tower's chopsticks: which pad, offset from centre (m) and sink rate (m/s). */
  shipCaught: { pad: number; off: number; speed: number } | null;
  /** Booster down anywhere but the tower. */
  boosterLanded: boolean;
  /** Booster on the water: touchdown speed (m/s) and distance to its ocean target (km). */
  boosterSplash: { speed: number; km: number } | null;
  /** Ship on the water: touchdown speed (m/s) and distance to the target (km). */
  splash: { speed: number; km: number } | null;
  /** Highest altitude of the stack / ship, m. */
  maxAlt: number;
  /** Ship's heat damage (0..1) at its worst. */
  shipHeat: number;
  /** Ship's current orbit and delta-v left (m/s). */
  shipOrbit: { perigee: number; apogee: number } | null;
  shipDeltaV: number;
  /** Ship below 20 km on the way down, still in one piece (made it through entry). */
  entrySurvived: boolean;
}

export interface Objective {
  label: string;
  check(r: FlightRecord): ObjectiveState;
}

export interface ScoreLine {
  label: string;
  points: number;
}

export interface MissionSetup {
  /** Where it starts: on the pad (default) or part-way through a flight (run ahead to there). */
  start?: MissionStart;
  /** The player flies this from the start, autopilot off (hand-flown missions, free roam). */
  fly?: 'stack' | 'booster' | 'ship';
  /** The booster comes down on the Gulf at BOOSTER_OCEAN_TARGET instead of at the tower. */
  boosterOcean?: boolean;
  /** Autopilot missions about the booster: the camera goes with it at stage separation. */
  followBooster?: boolean;
  /** At SECO, send the ship home on autopilot (tower catch or the ocean target). */
  shipReturn?: 'tower' | 'ocean';
}

/** A target shown in the world, on the map and in the flight readout. */
export interface MissionTarget {
  lat: number;
  lon: number;
  label: string;
  /** The vehicle it's for. */
  vehicle: 'booster' | 'ship';
}

export interface MissionDef {
  id: MissionId;
  title: string;
  /** Hand-flown (autopilot off for what you fly) or watched on autopilot (L takes over). */
  group: 'manual' | 'auto' | 'free';
  brief: string;
  setup: MissionSetup;
  target?: MissionTarget;
  objectives: Objective[];
  score(r: FlightRecord): ScoreLine[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const km = (m: number) => `${Math.round(m / 1000)} km`;

// Shared objectives.
const liftoff: Objective = { label: 'Liftoff', check: (r) => (r.liftoff ? 'done' : r.stackLost ? 'failed' : 'pending') };
const separation: Objective = { label: 'Stage separation', check: (r) => (r.separated ? 'done' : r.stackLost ? 'failed' : 'pending') };
const space: Objective = {
  label: 'Reach space (100 km)',
  check: (r) => (r.maxAlt >= 100e3 ? 'done' : r.stackLost || r.shipLost ? 'failed' : 'pending'),
};
const catchBooster: Objective = {
  label: 'Booster caught by the chopsticks',
  check: (r) => (r.caught ? 'done' : r.stackLost || r.boosterLost || r.boosterLanded ? 'failed' : 'pending'),
};
const catchShip: Objective = {
  label: 'Ship caught by a tower',
  check: (r) => (r.shipCaught ? 'done' : r.stackLost || r.shipLost || r.splash ? 'failed' : 'pending'),
};
const boosterSplashInZone: Objective = {
  label: `Booster splashdown within ${BOOSTER_ZONE_KM} km of the target`,
  check: (r) =>
    r.boosterSplash ? (r.boosterSplash.km <= BOOSTER_ZONE_KM ? 'done' : 'failed') : r.stackLost || r.boosterLost || r.caught ? 'failed' : 'pending',
};
const boosterSoft: Objective = {
  label: 'Booster touchdown under 6 m/s',
  check: (r) => (r.boosterSplash ? (r.boosterSplash.speed < 6 ? 'done' : 'failed') : r.stackLost || r.boosterLost ? 'failed' : 'pending'),
};
const shipTarget: MissionTarget = { ...SPLASH_TARGET, label: 'Ship splashdown target', vehicle: 'ship' };
const boosterTarget: MissionTarget = { ...BOOSTER_OCEAN_TARGET, label: 'Booster splashdown target', vehicle: 'booster' };
const splashInZone: Objective = {
  label: `Ship splashdown within ${SPLASH_ZONE_KM} km of the target`,
  check: (r) => (r.splash ? (r.splash.km <= SPLASH_ZONE_KM ? 'done' : 'failed') : r.stackLost || r.shipLost ? 'failed' : 'pending'),
};

/** Points for landing close: full at 0, none at `max`. */
const precision = (label: string, max: number, value: number, limit: number): ScoreLine => ({
  label,
  points: Math.round(max * clamp01(1 - value / limit)),
});
const done = (o: Objective, r: FlightRecord, points: number): ScoreLine => ({ label: o.label, points: o.check(r) === 'done' ? points : 0 });

export const MISSIONS: MissionDef[] = [
  // --- Hand-flown: autopilot off for what you fly, from the pad or from part-way through ---
  {
    id: 'ascent',
    title: 'Hand-Flown Ascent',
    group: 'manual',
    brief: `You fly Starship off the pad: pitch over through max-Q without breaking it up, stage (Space) and cut the ship's engines (X) with the apoapsis at ${km(ASCENT_APO)} (±${km(ASCENT_TOL)}). The booster flies itself home.`,
    setup: { fly: 'stack' },
    objectives: [
      separation,
      {
        label: 'Through max-Q in one piece',
        check: (r) => (r.separated ? 'done' : r.stackLost ? 'failed' : 'pending'),
      },
      {
        label: `SECO with apoapsis ${km(ASCENT_APO - ASCENT_TOL)}–${km(ASCENT_APO + ASCENT_TOL)}`,
        check: (r) =>
          r.seco ? (Math.abs(r.seco.apogee - ASCENT_APO) <= ASCENT_TOL ? 'done' : 'failed') : r.stackLost || r.shipLost ? 'failed' : 'pending',
      },
    ],
    score(r) {
      const lines = missionById('ascent').objectives.map((o) => done(o, r, 250));
      if (r.seco) lines.push(precision(`Apoapsis accuracy (${km(r.seco.apogee)})`, 250, Math.abs(r.seco.apogee - ASCENT_APO), ASCENT_TOL));
      return lines;
    },
  },
  {
    id: 'orbit',
    title: 'Reach Orbit',
    group: 'manual',
    brief: `Fly it yourself all the way to a stable orbit: perigee above ${km(ORBIT_PERIGEE)}. Plan the circularisation burn at apoapsis with a maneuver node (Tab, N). Save as much delta-v as you can.`,
    setup: { fly: 'stack' },
    objectives: [
      separation,
      space,
      {
        label: `Stable orbit (perigee above ${km(ORBIT_PERIGEE)})`,
        check: (r) => (r.shipOrbit && r.shipOrbit.perigee > ORBIT_PERIGEE && !r.shipLost ? 'done' : r.stackLost || r.shipLost ? 'failed' : 'pending'),
      },
    ],
    score(r) {
      const lines = missionById('orbit').objectives.map((o) => done(o, r, 300));
      if (missionById('orbit').objectives[2].check(r) === 'done') lines.push({ label: `Delta-v left (${Math.round(r.shipDeltaV)} m/s)`, points: Math.round(Math.min(100, r.shipDeltaV / 10)) });
      return lines;
    },
  },
  {
    id: 'boosterocean',
    title: 'Booster Ocean Splashdown',
    group: 'manual',
    brief: 'Starts the moment the stages separate, 70 km up, with Super Heavy yours. Turn it round (flip), burn back toward the marker in the Gulf 32 km off the coast (boostback), fall engines-first, light the landing burn (13 engines, then 3) and set it down on the water on the marker, gently. The marker shows in the sky and on the map (Tab); the readout gives the range and heading to it.',
    setup: { start: 'separation', fly: 'booster', boosterOcean: true },
    target: boosterTarget,
    objectives: [boosterSplashInZone, boosterSoft],
    score(r) {
      const lines = [done(boosterSplashInZone, r, 350), done(boosterSoft, r, 250)];
      if (r.boosterSplash) {
        lines.push(precision(`On target (${r.boosterSplash.km.toFixed(2)} km)`, 250, r.boosterSplash.km, BOOSTER_ZONE_KM));
        lines.push(precision(`Touchdown (${r.boosterSplash.speed.toFixed(1)} m/s)`, 150, r.boosterSplash.speed, 6));
      }
      return lines;
    },
  },
  {
    id: 'catch',
    title: 'Catch the Booster',
    group: 'manual',
    brief: 'Starts with Super Heavy falling engines-first 20 km above Starbase, yours all the way down. Light the landing burn in time (13 engines; SAS RET keeps them pointed into the fall), drop to 3 engines, then hover beside the tower: TGT SAS leans it toward the chopsticks, you hold the height with the throttle (Shift / Ctrl) and sink onto the arms at under 2.5 m/s.',
    setup: { start: 'boosterLanding', fly: 'booster' },
    objectives: [catchBooster],
    score(r) {
      const lines = [done(catchBooster, r, 600)];
      if (r.caught) {
        lines.push(precision(`Precision (${r.caught.off.toFixed(2)} m off)`, 200, r.caught.off, 2.5));
        lines.push(precision(`Softness (${r.caught.speed.toFixed(1)} m/s)`, 200, r.caught.speed, 2.5));
      }
      return lines;
    },
  },
  {
    id: 'landing',
    title: 'Ship Reentry & Splashdown',
    group: 'manual',
    brief: 'Starts with the ship at the edge of the atmosphere over the Indian Ocean at 7.4 km/s, yours from there. Hold the belly into the plasma (ENT; turn the bare steel into it and it burns through), ride the belly-flop down, then flip and light the sea-level engines for a soft splashdown on the marker.',
    setup: { start: 'entry', fly: 'ship' },
    target: shipTarget,
    objectives: [
      {
        label: 'Survive entry',
        check: (r) => (r.entrySurvived ? 'done' : r.shipLost ? 'failed' : 'pending'),
      },
      {
        label: 'Splashdown under 8 m/s',
        check: (r) => (r.splash ? (r.splash.speed < 8 ? 'done' : 'failed') : r.shipLost ? 'failed' : 'pending'),
      },
      splashInZone,
    ],
    score(r) {
      const [entry, soft, zone] = missionById('landing').objectives;
      const lines = [done(entry, r, 300), done(soft, r, 250), done(zone, r, 150)];
      lines.push({ label: `Heat shield condition (${Math.round((1 - r.shipHeat) * 100)}%)`, points: r.entrySurvived ? Math.round(100 * (1 - r.shipHeat)) : 0 });
      if (r.splash) {
        lines.push(precision(`Touchdown (${r.splash.speed.toFixed(1)} m/s)`, 100, r.splash.speed, 8));
        lines.push(precision(`On target (${r.splash.km.toFixed(0)} km)`, 100, r.splash.km, SPLASH_ZONE_KM));
      }
      return lines;
    },
  },

  // --- Autopilot: flown for you (L takes over, L again hands back) ---
  {
    id: 'ift',
    title: 'Flight Test',
    group: 'auto',
    brief: 'The full test flight profile: launch, hot staging, the booster back to the tower\'s chopsticks, and the ship through space and down in the Indian Ocean on the marker.',
    setup: {},
    target: shipTarget,
    objectives: [liftoff, separation, space, catchBooster, splashInZone],
    score(r) {
      const lines = [liftoff, separation, space, catchBooster, splashInZone].map((o) => done(o, r, 150));
      if (r.caught) lines.push(precision(`Catch precision (${r.caught.off.toFixed(2)} m off)`, 125, r.caught.off, 2.5));
      if (r.splash) lines.push(precision(`Splashdown precision (${r.splash.km.toFixed(0)} km)`, 125, r.splash.km, SPLASH_ZONE_KM));
      return lines;
    },
  },
  {
    id: 'boosterreturn',
    title: 'Booster Return to the Tower',
    group: 'auto',
    brief: 'Launch, and at stage separation follow Super Heavy home: flip, boostback, the grid fins steering it through the air, the landing burn and the catch by the chopsticks.',
    setup: { followBooster: true },
    objectives: [liftoff, separation, catchBooster],
    score(r) {
      const lines = [done(liftoff, r, 150), done(separation, r, 150), done(catchBooster, r, 450)];
      if (r.caught) lines.push(precision(`Catch precision (${r.caught.off.toFixed(2)} m off)`, 250, r.caught.off, 2.5));
      return lines;
    },
  },
  {
    id: 'boostersplash',
    title: 'Booster Splashdown',
    group: 'auto',
    brief: 'Like the early flight tests: at stage separation Super Heavy flies a short boostback and comes down on the Gulf 32 km off the coast, on the marker, with a landing burn and a soft touchdown on the water.',
    setup: { followBooster: true, boosterOcean: true },
    target: boosterTarget,
    objectives: [liftoff, separation, boosterSplashInZone],
    score(r) {
      const lines = [done(liftoff, r, 150), done(separation, r, 150), done(boosterSplashInZone, r, 450)];
      if (r.boosterSplash) lines.push(precision(`On target (${r.boosterSplash.km.toFixed(2)} km)`, 250, r.boosterSplash.km, BOOSTER_ZONE_KM));
      return lines;
    },
  },
  {
    id: 'shipcatch',
    title: 'Ship Catch',
    group: 'auto',
    brief:
      'The full catch-both profile: launch, the booster back to Pad 1\'s chopsticks, the ship on to space. At engine cutoff the ship heads home by itself: a burn to orbit, a coast of many hours for the pass over Starbase (warp with 1–8 or , . to speed it up: nothing speeds up on its own), deorbit, a steered entry, belly-flop, flip, and a catch by Pad 2\'s tower. It drops back to normal speed for the flip and catch.',
    setup: { shipReturn: 'tower' },
    objectives: [liftoff, separation, catchBooster, space, catchShip],
    score(r) {
      const lines = [liftoff, separation, catchBooster, space, catchShip].map((o) => done(o, r, 150));
      if (r.caught) lines.push(precision(`Booster catch precision (${r.caught.off.toFixed(2)} m off)`, 125, r.caught.off, 2.5));
      if (r.shipCaught) lines.push(precision(`Ship catch precision (${r.shipCaught.off.toFixed(2)} m off)`, 125, r.shipCaught.off, 2.5));
      return lines;
    },
  },
  {
    id: 'free',
    title: 'Free Flight',
    group: 'free',
    brief: 'No objectives: you fly (manual from the start); the booster comes home to the tower on its own unless you take it over.',
    setup: { fly: 'stack' },
    objectives: [],
    score: () => [],
  },
];

export const missionById = (id: MissionId): MissionDef => MISSIONS.find((m) => m.id === id) ?? MISSIONS[MISSIONS.length - 1];

export function grade(score: number): string {
  return score >= 900 ? 'S' : score >= 750 ? 'A' : score >= 550 ? 'B' : score >= 350 ? 'C' : 'D';
}

/** Great-circle distance, km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function emptyRecord(): FlightRecord {
  return {
    liftoff: false,
    separated: false,
    seco: null,
    stackLost: false,
    boosterLost: false,
    shipLost: false,
    caught: null,
    shipCaught: null,
    boosterLanded: false,
    boosterSplash: null,
    splash: null,
    maxAlt: 0,
    shipHeat: 0,
    shipOrbit: null,
    shipDeltaV: 0,
    entrySurvived: false,
  };
}

export interface MissionResult {
  mission: MissionDef;
  states: ObjectiveState[];
  lines: ScoreLine[];
  total: number;
  grade: string;
}

/** Follows a flight and scores it against a mission. */
export class MissionTracker {
  record = emptyRecord();
  result: MissionResult | null = null;
  private splashSpeed: number | null = null;
  private boosterSplashSpeed: number | null = null;

  constructor(public mission: MissionDef) {}

  reset(mission = this.mission): void {
    this.mission = mission;
    this.record = emptyRecord();
    this.result = null;
    this.splashSpeed = null;
    this.boosterSplashSpeed = null;
  }

  states(): ObjectiveState[] {
    return this.mission.objectives.map((o) => o.check(this.record));
  }

  score(): { lines: ScoreLine[]; total: number } {
    const lines = this.mission.score(this.record);
    return { lines, total: Math.min(1000, lines.reduce((a, l) => a + l.points, 0)) };
  }

  /** Feed a snapshot; returns the result the moment the mission finishes (once). */
  update(s: Snapshot): MissionResult | null {
    const r = this.record;
    for (const e of s.events) {
      if (/^Liftoff/.test(e.text)) r.liftoff = true;
      if (/^Stage separation/.test(e.text)) r.separated = true;
      const caught = /^Booster caught! \(([\d.]+) m off center, ([\d.]+) m\/s\)/.exec(e.text);
      if (caught) r.caught = { off: Number(caught[1]), speed: Number(caught[2]) };
      const shipCaught = /^Ship caught by the Pad (\d) tower! \(([\d.]+) m off center, ([\d.]+) m\/s\)/.exec(e.text);
      if (shipCaught) r.shipCaught = { pad: Number(shipCaught[1]), off: Number(shipCaught[2]), speed: Number(shipCaught[3]) };
      const orbit = /^SECO.*orbit (-?\d+) x (-?\d+) km/.exec(e.text);
      if (orbit && !r.seco) r.seco = { perigee: Number(orbit[1]) * 1000, apogee: Number(orbit[2]) * 1000 };
      if (/^Booster struck/.test(e.text)) r.boosterLost = true;
      const splash = /^Starship splashdown.*?([\d.]+) m\/s/.exec(e.text);
      if (splash) this.splashSpeed = Number(splash[1]);
      const boosterSplash = /^Super Heavy (?:splashdown|touchdown).*?([\d.]+) m\/s/.exec(e.text);
      if (boosterSplash) this.boosterSplashSpeed = Number(boosterSplash[1]);
    }
    const find = (id: string) => s.vehicles.find((v) => v.id === id);
    const stack = find('stack');
    const booster = find('booster');
    const ship = find('ship');
    if (stack?.status === 'destroyed') r.stackLost = true;
    if (booster?.status === 'destroyed') r.boosterLost = true;
    if (booster?.status === 'landed') {
      r.boosterLanded = true;
      if (!r.boosterSplash) {
        r.boosterSplash = {
          speed: this.boosterSplashSpeed ?? Math.abs(booster.telemetry.verticalSpeed),
          km: distanceKm(booster.telemetry, BOOSTER_OCEAN_TARGET),
        };
      }
    }
    if (ship?.status === 'destroyed') r.shipLost = true;
    for (const v of [stack, ship]) if (v && v.status === 'flight') r.maxAlt = Math.max(r.maxAlt, v.telemetry.altitude);
    if (ship) this.followShip(ship);
    if (this.result) return null;
    const states = this.states();
    if (!states.length || states.some((x) => x === 'pending')) return null;
    const { lines, total } = this.score();
    this.result = { mission: this.mission, states, lines, total, grade: grade(total) };
    return this.result;
  }

  private followShip(ship: VehicleSnapshot): void {
    const r = this.record;
    const t = ship.telemetry;
    r.shipHeat = Math.max(r.shipHeat, ship.health.heat);
    r.shipDeltaV = t.deltaV.ship ?? 0;
    if (ship.status === 'flight') r.shipOrbit = { perigee: t.perigee, apogee: t.apogee };
    if (ship.status === 'flight' && t.altitude < 20e3 && t.verticalSpeed < 0 && r.maxAlt > 100e3) r.entrySurvived = true;
    if (ship.status === 'landed' && !r.splash) {
      // Touchdown speed from the log (the sim writes it), else the last telemetry.
      r.splash = { speed: this.splashSpeed ?? Math.abs(t.verticalSpeed), km: distanceKm(t, SPLASH_TARGET) };
      r.entrySurvived = true;
    }
  }
}
