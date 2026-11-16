// The auto camera: a broadcast director for a flight. It cuts between the cameras there are (the
// pad and tower cameras, the long lens from South Padre Island, chase, wide orbits, the bay, hull
// and Starlink cameras) as a webcast would: a shot every 6-12 s, the shots that suit what's
// happening (on the pad: the pad cameras and the long lens; climbing out: tracking from the
// island, chase; at staging, close on the stack; the booster coming home: the tower camera; the
// ship in space: chase, the bay, the satellites going out; entry: wide on the plasma; the flip and
// catch: the tower again), cutting at once when something happens (liftoff, MECO, staging, the
// landing burn, a catch, the door, entry, the flip, a splashdown). Pure logic: main applies the shot.
//
// A rollout is a film, not a webcast: ten minutes of road told in a minute and a half. Its clips
// are a fixed list (rollClips), each begun at its own place on the way, so the transport is
// taken on up the road between them (most of the road is never shown), and a few run fast, as
// time lapses: an establishing
// shot high over the Starfactory with a title; low ahead of the transport, looking up the ship;
// a drone behind and above with the miles going by; a tripod on the verge it comes past; the
// wheels past a wide lens; straight down on it; off its bow; a long lens far up the road;
// in across the launch site with the pad beyond; onto its stand. There the tower's arms stack it
// on the booster by themselves (sim/autoStack.ts), a shot for each step of that, the long ones
// run fast; a last look at the stack, and the camera is handed back. (Taking the camera at any
// point ends the film: the rollout goes on from where it had got to, at its own pace, and a
// stacking already begun is finished. A hand on the arms' controls ends the stacking too.)

import type { CameraMode } from './cameras';

export interface DirectorVehicle {
  id: string;
  status: string;
  altitude: number;
  speed: number;
  /** Within sight of Starbase's cameras (tens of km). */
  nearPad: boolean;
}

export interface DirectorView {
  missionTime: number | null;
  vehicles: DirectorVehicle[];
  /** Log lines since the last call. */
  events: string[];
  /** A payload door to look out of; satellites out to ride on. */
  door: boolean;
  sats: boolean;
  /** Someone's flying by hand: the director won't move the controls to another vehicle. */
  manual: boolean;
  tracked: string;
  /** A vehicle on its transport, rolling out: the pad it's bound for, how far it has come and has to go (m), and whether it's there. */
  transport?: DirectorTransport | null;
  /** A ship being stacked without hands: the step the arms are at (sim/autoStack.ts StackStage), or null. */
  stacking?: string | null;
}

export interface DirectorTransport {
  id: string;
  pad: number;
  gone: number;
  left: number;
  arrived: boolean;
}

export interface Shot {
  mode: CameraMode;
  /** The vehicle to follow (unchanged if absent). */
  track?: string;
  /** For an orbit shot: where the camera sits round the vehicle. */
  orbit?: { azimuth: number; elevation: number; distance: number; /** The azimuth is round from dead ahead of a vehicle on its transport (to its left), not from south. */ ahead?: boolean };
  /** The free camera's slow move while the shot lasts, a second: round and up (rad), and in or out (the distance's rate; closing: negative). */
  drift?: { azimuth?: number; elevation?: number; zoom?: number };
  /**
   * The roadside camera's place: this far up the road from the vehicle (m), this far to the left
   * of its way, this high over the pad's level (under the ground: head height); its lens (deg;
   * none: zoomed to the vehicle).
   */
  roadside?: { ahead: number; side: number; up: number; fov?: number };
  /** Aimed this far up the vehicle from its middle, m. */
  aim?: number;
  /** How long it's held, s: between these (else 6 to 12). */
  hold?: [number, number];
  /** A rollout's clip: the transport is first taken on to this far along its way, m; and time runs this fast while it's held (else as it is: 1 for a rollout's). */
  skipTo?: number;
  pace?: number;
  /** A title over it: a heading and a line under. */
  title?: [string, string];
  /** Have the tower's arms at this pad stack the ship that has rolled out to it (0 = Pad 1). */
  stack?: number;
  /** The last shot: the auto camera turns itself off on it. */
  last?: boolean;
}

type Situation = 'roll' | 'rollArrived' | 'stacking' | 'rollEnd' | 'pad' | 'liftoff' | 'ascent' | 'staging' | 'boostback' | 'boosterLanding' | 'boosterDown' | 'coast' | 'deploy' | 'entry' | 'shipLanding' | 'shipDown';

/** Events that start a new situation at once (and how long it lasts, s, unless the state moves on). */
const CUES: [RegExp, Situation, number][] = [
  [/^Starship at Pad \d, on its stand/, 'rollArrived', 6],
  [/^Liftoff/, 'liftoff', 14],
  [/^Booster MECO|^Ship engine ignition|^Stage separation/, 'staging', 9],
  [/^Boostback burn startup/, 'boostback', 30],
  [/^Landing burn startup/, 'boosterLanding', 60],
  [/^Booster caught|^Super Heavy (splashdown|touchdown)|tipped over/, 'boosterDown', 14],
  [/^Payload door opening|^Starlink 1 of/, 'deploy', 40],
  [/^Entry interface/, 'entry', 60],
  [/^Landing flip|^Return: flip/, 'shipLanding', 40],
  [/^Ship caught|^Starship (splashdown|touchdown)/, 'shipDown', 16],
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * The shot for a step of the stacking. Placed, like the rollout's, from the way the transport
 * came onto the stand (the same at either pad, seen from the mount: the tower some 50 degrees
 * to the right of it, the stand 120), so that the tower stands behind the ship. From the stand
 * itself the tower is dead ahead and the mount 65 degrees to the left: the close shots there
 * are from behind and to the left, over the open slab, with neither in the way.
 */
function stackShot(stage: string, tr: DirectorTransport): Shot {
  const round = (azimuth: number, elevation: number, distance: number) => ({ azimuth, elevation, distance, ahead: true });
  switch (stage) {
    // The arms down the tower and round to the stand: from high and wide, fast.
    case 'close':
    case 'reach':
      return { mode: 'orbit', track: tr.id, orbit: round(1.9, 0.35, 330), drift: { azimuth: -0.03, zoom: -0.012 }, pace: 6 };
    // Shut on the ship: close in at the fittings.
    case 'grip':
      return { mode: 'orbit', track: tr.id, orbit: round(2.5, 0.05, 79), aim: 12, drift: { azimuth: 0.03 }, pace: 1 };
    // Up off the stand: from the ground, looking up it as it goes.
    case 'lift':
      return { mode: 'orbit', track: tr.id, orbit: round(2.55, -0.3, 150), aim: 4, drift: { azimuth: 0.02 }, pace: 4 };
    // Round over the mount.
    case 'swing':
      return { mode: 'orbit', track: tr.id, orbit: round(2.4, 0.25, 260), drift: { azimuth: -0.03 }, pace: 3 };
    // Down onto the booster: close on where they meet.
    case 'lower':
      return { mode: 'orbit', track: tr.id, orbit: round(1.3, 0, 72), aim: -24, drift: { azimuth: 0.02 }, pace: 1 };
    // The arms off it and away up the tower: the whole stack, slowly round.
    default:
      return { mode: 'orbit', track: 'stack', orbit: round(1.9, 0.1, 330), drift: { azimuth: 0.04, zoom: 0.01 }, pace: 1, title: ['Stacked', `Starship on Super Heavy · Pad ${tr.pad + 1}`] };
  }
}

/** A clip of a rollout's film: where on the way it begins (m from the gate), how long it's held (s), and its shot. */
export interface Clip {
  at: number;
  hold: number;
  shot: Shot;
}

/**
 * A rollout's film (about 80 s to the stand). The cameras are placed from the transport's own
 * way (ahead: true), and a shot from under the vehicle's middle is one from the ground: the
 * camera is kept out of it, a head's height up.
 */
function rollClips(tr: DirectorTransport): Clip[] {
  const L = tr.gone + tr.left;
  const id = tr.id;
  const round = (azimuth: number, elevation: number, distance: number) => ({ azimuth, elevation, distance, ahead: true });
  return [
    // High over the Starfactory as it sets off, coming slowly round and in: the title.
    { at: 0, hold: 10, shot: { mode: 'orbit', track: id, orbit: round(-0.95, 0.4, 520), drift: { azimuth: 0.022, zoom: -0.022 }, title: ['Rollout', `Starship to Pad ${tr.pad + 1} · Highway 4, Starbase`] } },
    // Low on the road ahead of it, looking up the ship as it comes on.
    { at: 0.07 * L, hold: 7, shot: { mode: 'orbit', track: id, orbit: round(-0.42, -0.3, 125), aim: -6, drift: { azimuth: 0.016, zoom: -0.012 } } },
    // A drone behind and above, the road running on to the towers: the miles going by.
    { at: 0.14 * L, hold: 7, shot: { mode: 'orbit', track: id, orbit: round(Math.PI - 0.45, 0.42, 300), drift: { azimuth: 0.02 }, pace: 10 } },
    // A tripod on the verge: it comes up the road, fills the picture and is by.
    { at: 0.34 * L, hold: 8, shot: { mode: 'roadside', track: id, roadside: { ahead: 78, side: -17, up: -20 }, pace: 2 } },
    // Down at the transport: the wheels going past a wide lens.
    // (Cut as it comes abreast: past that, the lens is full of hull.)
    { at: 0.45 * L, hold: 5.5, shot: { mode: 'roadside', track: id, roadside: { ahead: 34, side: -7.5, up: -20, fov: 66 }, aim: -21 } },
    // Straight down on it, turning, the road reeling under.
    { at: 0.52 * L, hold: 7, shot: { mode: 'orbit', track: id, orbit: round(0, 1.36, 240), drift: { azimuth: 0.035 }, pace: 3 } },
    // Off its other bow, keeping pace.
    { at: 0.7 * L, hold: 6, shot: { mode: 'orbit', track: id, orbit: round(1.1, -0.12, 90), drift: { azimuth: 0.014 } } },
    // A long lens far up the road, the ship coming on through it. (Not the tower's own camera:
    // from out here it looks back through the framework of the tower's top.)
    { at: 0.78 * L, hold: 6, shot: { mode: 'roadside', track: id, roadside: { ahead: 330, side: -9, up: -20 }, pace: 3 } },
    // In through the gate: behind it, the pad and the tower it's making for beyond.
    { at: L - 330, hold: 8, shot: { mode: 'orbit', track: id, orbit: round(Math.PI - 0.3, 0.09, 230), drift: { azimuth: 0.012, zoom: -0.008 }, pace: 2 } },
    // Across the site, from high up.
    { at: L - 110, hold: 6, shot: { mode: 'orbit', track: id, orbit: round(-1.1, 0.55, 380), drift: { azimuth: -0.02 }, pace: 2 } },
    // Onto its stand, from low on the open slab behind it, the tower beyond: held until it's there.
    // (Not from ahead of it: that way are the tank farm's rack and the mount.)
    // (And from where it has turned onto its last straight: the cameras are set by the way it's
    // heading, and halfway round that corner this one was among the containers to the south.)
    { at: L - 22, hold: 40, shot: { mode: 'orbit', track: id, orbit: round(2.3, -0.3, 100), aim: -9, drift: { azimuth: 0.012 }, pace: 3 } },
  ];
}

export class Director {
  enabled = false;
  private cue: { s: Situation; until: number } | null = null;
  private situation: Situation | null = null;
  private shotAt = -Infinity;
  private shotLen = 8;
  private index = 0;
  /** A rollout has been filmed to its end: the last shot of it is still to come. */
  private rolled = false;
  /** Which of a rollout's clips is playing (-1: none yet). */
  private clip = -1;
  /** The step of a stacking the shot on screen is of. */
  private stage: string | null = null;

  /** Start afresh (a new flight). */
  reset(): void {
    this.rolled = false;
    this.clip = -1;
    this.stage = null;
    this.cue = null;
    this.situation = null;
    this.shotAt = -Infinity;
    this.index = 0;
  }

  /** Each frame while on. now: real time, s. Returns a shot to cut to, or null to hold this one. */
  update(now: number, v: DirectorView): Shot | null {
    for (const e of v.events) {
      const c = CUES.find(([re]) => re.test(e));
      if (c) this.cue = { s: c[1], until: now + c[2] };
    }
    if (v.transport && !v.transport.arrived) return this.film(now, v.transport);
    // A ship being stacked: a shot for each step of it, once the arrival's own has had its time
    // (and none shorter than three seconds: the arms are shut on the ship in two).
    if (v.stacking && v.transport && !(this.cue && now < this.cue.until)) {
      this.situation = 'stacking';
      if (v.stacking === this.stage || now - this.shotAt < 3) return null;
      this.stage = v.stacking;
      this.shotAt = now;
      return stackShot(v.stacking, v.transport);
    }
    const s = this.situationNow(now, v);
    const changed = s !== this.situation;
    // A new situation: cut now (or as soon as the last cut is most of a second old); else at the
    // shot's end.
    if (changed) {
      if (now - this.shotAt < 0.8) return null;
      this.situation = s;
      this.index = 0;
    } else if (now - this.shotAt < this.shotLen) return null;
    // (Starbase's own cameras only for what's in sight of them.)
    const near = (id: string) => v.vehicles.some((x) => x.id === id && x.nearPad);
    const shots = this.shots(s, v).filter((sh) => !['pad', 'tower', 'spectator'].includes(sh.mode) || near(sh.track ?? v.tracked));
    if (!shots.length) return null;
    const shot = shots[this.index % shots.length];
    this.index++;
    this.shotAt = now;
    this.shotLen = shot.hold ? rand(...shot.hold) : rand(6, 12);
    if (s === 'rollArrived') this.rolled = true;
    if (shot.last) this.rolled = false;
    if (v.manual) delete shot.track;
    return shot;
  }

  /**
   * A rollout's film: the clip to cut to now, if it's time for the next. Clips the transport is
   * already past are left out (the auto camera turned on part of the way there, a flight loaded),
   * and the last is held until it's on its stand.
   */
  private film(now: number, tr: DirectorTransport): Shot | null {
    this.situation = 'roll';
    if (this.clip >= 0 && now - this.shotAt < this.shotLen) return null;
    const clips = rollClips(tr);
    let i = this.clip + 1;
    while (i < clips.length - 1 && clips[i + 1].at <= tr.gone + 1) i++;
    if (i >= clips.length) return null;
    this.clip = i;
    this.shotAt = now;
    this.shotLen = clips[i].hold;
    const shot: Shot = { pace: 1, ...clips[i].shot };
    // (Up the road to where the clip begins, if that's any way off.)
    if (clips[i].at > tr.gone + 4) shot.skipTo = clips[i].at;
    return shot;
  }

  /** A rollout's film: the clip after the one playing, and where on the way it begins (its ground can be loaded ahead). */
  upcoming(tr: DirectorTransport | null | undefined): Clip | null {
    if (!tr || tr.arrived || this.clip < 0) return null;
    return rollClips(tr)[this.clip + 1] ?? null;
  }

  private situationNow(now: number, v: DirectorView): Situation {
    if (this.cue && now < this.cue.until) return this.cue.s;
    this.cue = null;
    const get = (id: string) => v.vehicles.find((x) => x.id === id && x.status !== 'destroyed');
    const stack = get('stack'), booster = get('booster'), ship = get('ship');
    const mt = v.missionTime;
    // (A rollout filmed to its stand: one more shot, the one the camera is handed back on.)
    if (v.transport && this.rolled) return 'rollEnd';
    if (stack && (mt === null || mt < 0 || stack.status !== 'flight')) return 'pad';
    if (stack) return mt !== null && mt < 14 ? 'liftoff' : 'ascent';
    // The booster coming home has the stage while it's low; then the ship.
    if (booster?.status === 'flight' && booster.altitude < 20e3) return 'boosterLanding';
    if (booster?.status === 'flight' && ship?.status === 'flight' && ship.altitude < 200e3 && booster.altitude > 20e3) return 'boostback';
    if (ship?.status === 'flight') {
      if (ship.altitude > 120e3) return v.door || v.sats ? 'deploy' : 'coast';
      if (ship.speed > 1500) return 'entry';
      return 'shipLanding';
    }
    if (ship) return 'shipDown';
    if (booster) return 'boosterDown';
    return 'pad';
  }

  private shots(s: Situation, v: DirectorView): Shot[] {
    const orbit = (distance: number, elevation: number) => ({ azimuth: rand(0, 2 * Math.PI), elevation, distance });
    const stackOr = (id: string) => (v.vehicles.some((x) => x.id === 'stack' && x.status !== 'destroyed') ? 'stack' : id);
    const tr = v.transport;
    const id = tr?.id ?? 'ship';
    switch (s) {
      case 'roll':
      case 'stacking':
        return [];
      case 'rollArrived':
        return [
          // (Round it where it stands, from over the trench's ramp; and the arms set to stacking it.)
          { mode: 'orbit', track: id, orbit: { azimuth: 2.45, elevation: 0.06, distance: 125, ahead: true }, aim: -4, drift: { azimuth: 0.03 }, hold: [8, 8], pace: 1, stack: tr?.pad ?? 0, title: [`Pad ${(tr?.pad ?? 0) + 1}`, 'Starship on its stand · the chopsticks take it from here'] },
        ];
      case 'rollEnd':
        // (The view the stacking is done from.)
        return [{ mode: 'orbit', track: id, orbit: { azimuth: -2.3, elevation: 0.14, distance: 380 }, pace: 1, last: true }];
      case 'pad':
        return [
          { mode: 'pad', track: 'stack' },
          { mode: 'spectator', track: 'stack' },
          { mode: 'orbit', track: 'stack', orbit: orbit(650, 0.08) },
          { mode: 'tower', track: 'stack' },
        ];
      case 'liftoff':
        return [
          { mode: 'pad', track: 'stack' },
          { mode: 'orbit', track: 'stack', orbit: orbit(420, -0.12) },
          { mode: 'spectator', track: 'stack' },
        ];
      case 'ascent':
        return [
          { mode: 'spectator', track: 'stack' },
          { mode: 'chase', track: 'stack' },
          { mode: 'orbit', track: 'stack', orbit: orbit(380, -0.35) },
        ];
      case 'staging':
        return [
          { mode: 'orbit', track: stackOr('ship'), orbit: orbit(300, 0.15) },
          { mode: 'chase', track: 'ship' },
        ];
      case 'boostback':
        return [
          { mode: 'orbit', track: 'booster', orbit: orbit(500, 0.2) },
          { mode: 'chase', track: 'ship' },
          { mode: 'chase', track: 'booster' },
          { mode: 'orbit', track: 'ship', orbit: orbit(260, 0.1) },
        ];
      case 'boosterLanding':
        return [
          { mode: 'orbit', track: 'booster', orbit: orbit(520, 0.05) },
          { mode: 'tower', track: 'booster' },
          { mode: 'spectator', track: 'booster' },
          { mode: 'pad', track: 'booster' },
        ];
      case 'boosterDown':
        return [
          { mode: 'tower', track: 'booster' },
          { mode: 'orbit', track: 'booster', orbit: orbit(300, 0.12) },
        ];
      case 'coast':
        return [
          { mode: 'chase', track: 'ship' },
          { mode: 'orbit', track: 'ship', orbit: orbit(220, 0.25) },
          { mode: 'orbit', track: 'ship', orbit: orbit(140, -0.1) },
        ];
      case 'deploy':
        return [
          ...(v.door ? ([{ mode: 'bay', track: 'ship' }, { mode: 'hull', track: 'ship' }] as Shot[]) : []),
          ...(v.sats ? ([{ mode: 'satellite', track: 'ship' }] as Shot[]) : []),
          ...(v.door ? ([{ mode: 'baytop', track: 'ship' }] as Shot[]) : []),
          { mode: 'orbit', track: 'ship', orbit: orbit(180, 0.2) },
        ];
      case 'entry':
        return [
          { mode: 'orbit', track: 'ship', orbit: orbit(260, 0.25) },
          { mode: 'chase', track: 'ship' },
          { mode: 'orbit', track: 'ship', orbit: orbit(160, -0.2) },
        ];
      case 'shipLanding':
        return [
          { mode: 'orbit', track: 'ship', orbit: orbit(420, 0.06) },
          { mode: 'tower', track: 'ship' },
          { mode: 'pad', track: 'ship' },
        ];
      case 'shipDown':
        return [
          { mode: 'orbit', track: 'ship', orbit: orbit(320, 0.1) },
          { mode: 'tower', track: 'ship' },
        ];
    }
  }
}
