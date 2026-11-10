// Each flight's timeline: the milestones the webcast arc shows (and the mission page lists), at
// their nominal mission times. The times are as the sim flies each profile (measured from
// headless runs of the missions); in flight each milestone moves to when it actually happened.
// Pure data (no DOM).

import type { MissionId } from './missions';

export interface Milestone {
  /** Short label on the arc. */
  label: string;
  /** Nominal mission time, s. */
  at: number;
  /** The event (sim log line) that marks it. Each event marks the first pending milestone it matches. */
  match: RegExp;
  /** Caption shown when it happens. */
  caption: string;
}

const m = (label: string, at: number, match: RegExp, caption = label): Milestone => ({ label, at, match, caption });

// --- Pieces shared between flights -----------------------------------------------------------

const LIFTOFF = m('LIFTOFF', 0, /^Liftoff/);
const MAX_Q = m('MAX-Q', 62, /^Max-Q/, 'MAX-Q');
const MECO = m('MECO', 137, /^Booster MECO/, 'SUPER HEAVY MECO');
const HOT_STAGING = m('HOT STAGING', 138, /^Ship engine ignition|^Stage separation/, 'STARSHIP IGNITION · HOT STAGING');
const BOOSTBACK = m('BOOSTBACK', 145, /^Boostback burn startup/, 'BOOSTBACK BURN');
const ASCENT = [LIFTOFF, MAX_Q, MECO, HOT_STAGING, BOOSTBACK];
const landingBurn = (at: number) => m('LANDING BURN', at, /^Landing burn startup/, 'SUPER HEAVY LANDING BURN');
const boosterCatch = (at: number) => m('BOOSTER CATCH', at, /^Booster caught/, 'SUPER HEAVY CATCH');
const boosterSplash = (at: number) => m('BOOSTER SPLASHDOWN', at, /^Super Heavy (splashdown|touchdown)/, 'SUPER HEAVY SPLASHDOWN');
const seco = (at: number) => m('SECO', at, /^SECO/, 'STARSHIP ENGINE CUTOFF');
const orbitBurn = (at: number) => m('ORBIT BURN', at, /^In-space Raptor relight/, 'RAPTOR RELIGHT · ORBIT');
const deorbit = (at: number) => m('DEORBIT BURN', at, /^In-space Raptor relight/, 'RAPTOR RELIGHT · DEORBIT BURN');
const entry = (at: number) => m('ENTRY', at, /^Entry interface/, 'ATMOSPHERIC ENTRY');
const peakHeating = (at: number) => m('PEAK HEATING', at, /^Peak heating/);
const flip = (at: number) => m('LANDING FLIP', at, /^Landing flip/, 'LANDING FLIP AND BURN');
const shipSplash = (at: number) => m('SPLASHDOWN', at, /^Splashdown/, 'STARSHIP SPLASHDOWN');
const shipCatch = (at: number) => m('SHIP CATCH', at, /^Ship caught/, 'STARSHIP CATCH');
const inspection = (at: number) => m('HEAT SHIELD', at, /^Heat shield inspection/, 'HEAT SHIELD INSPECTION');
/** A Starlink deployment: door open, the first and last satellite out, door closed. */
const starlink = (door: number, first: number, last: number, closed: number) => [
  m('DOOR OPEN', door, /^Payload door opening/, 'PAYLOAD DOOR OPENING'),
  m('STARLINK DEPLOY', first, /^Starlink 1 of/, 'FIRST STARLINK DEPLOYED'),
  m('DEPLOY COMPLETE', last, /^All \d+ Starlink/, 'ALL STARLINK V3 SATELLITES DEPLOYED'),
  m('DOOR CLOSED', closed, /^Payload door closed/, 'PAYLOAD DOOR CLOSED'),
];
/** The test flights' ship: through space and down in the Indian Ocean. */
const INDIAN_OCEAN = [entry(2834), peakHeating(3109), flip(3958), shipSplash(3992)];

const TIMELINES: Record<MissionId, Milestone[]> = {
  flight15: [
    ...ASCENT,
    landingBurn(378),
    boosterCatch(409),
    seco(456),
    m('ON THE MOUNT', 543, /^Super Heavy back on the/, 'SUPER HEAVY BACK ON THE LAUNCH MOUNT'),
    m('ARMS READY', 592, /^Pad \d chopsticks ready for the ship/, 'CHOPSTICKS SWUNG ROUND FOR THE SHIP'),
    orbitBurn(1587),
    ...starlink(2055, 2070, 3767, 3799),
    inspection(3800),
    deorbit(78966),
    entry(80134),
    peakHeating(80374),
    flip(80989),
    shipCatch(81048),
  ],
  flight14: [
    ...ASCENT,
    m('SHIP ENGINE OUT', 200, /^Engine out: Ship/, 'STARSHIP SEA-LEVEL RAPTOR SHUTDOWN'),
    m('ENTRY BURN', 326, /^Entry burn startup/, 'SUPER HEAVY ENTRY BURN'),
    landingBurn(400),
    boosterSplash(438),
    seco(505),
    orbitBurn(1612),
    ...starlink(2054, 2070, 3766, 3798),
    inspection(3799),
    deorbit(9099),
    entry(10314),
    peakHeating(10554),
    flip(11171),
    shipSplash(11190),
    m('FIREBALL', 11197, /^Starship tipped over/, 'STARSHIP TIPS OVER · FIREBALL'),
  ],
  ift: [...ASCENT, landingBurn(365), boosterCatch(396), seco(456), ...INDIAN_OCEAN],
  boosterreturn: [...ASCENT, landingBurn(365), boosterCatch(396), seco(456), ...INDIAN_OCEAN],
  boostersplash: [...ASCENT, landingBurn(377), boosterSplash(409), seco(456), ...INDIAN_OCEAN],
  shipcatch: [
    ...ASCENT,
    landingBurn(365),
    boosterCatch(396),
    seco(456),
    orbitBurn(1487),
    inspection(2089),
    deorbit(78695),
    entry(79869),
    peakHeating(80142),
    flip(80741),
    shipCatch(80790),
  ],
  // Hand-flown: the profile as the autopilot would fly it (you set the pace).
  ascent: [...ASCENT, landingBurn(365), boosterCatch(396), seco(456)],
  orbit: [...ASCENT, landingBurn(365), boosterCatch(396), seco(456), orbitBurn(1500)],
  boosterocean: [HOT_STAGING, BOOSTBACK, landingBurn(400), boosterSplash(438)],
  catch: [landingBurn(378), boosterCatch(409)],
  landing: INDIAN_OCEAN,
  free: [...ASCENT, landingBurn(365), boosterCatch(396), seco(456)],
};

/** A fresh copy of a flight's timeline (the webcast moves each milestone to when it happened). */
export function missionTimeline(id: MissionId): Milestone[] {
  return (TIMELINES[id] ?? TIMELINES.free).map((x) => ({ ...x }));
}

/** Mission time as T+H:MM:SS (or M:SS under an hour). */
export function formatT(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
