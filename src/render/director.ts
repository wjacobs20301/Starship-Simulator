// The auto camera: a broadcast director for a flight. It cuts between the cameras there are (the
// pad and tower cameras, the long lens from South Padre Island, chase, wide orbits, the bay, hull
// and Starlink cameras) as a webcast would: a shot every 6-12 s, the shots that suit what's
// happening (on the pad: the pad cameras and the long lens; climbing out: tracking from the
// island, chase; at staging, close on the stack; the booster coming home: the tower camera; the
// ship in space: chase, the bay, the satellites going out; entry: wide on the plasma; the flip and
// catch: the tower again), cutting at once when something happens (liftoff, MECO, staging, the
// landing burn, a catch, the door, entry, the flip, a splashdown). Pure logic: main applies the shot.

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
}

export interface Shot {
  mode: CameraMode;
  /** The vehicle to follow (unchanged if absent). */
  track?: string;
  /** For an orbit shot: where the camera sits round the vehicle. */
  orbit?: { azimuth: number; elevation: number; distance: number };
}

type Situation = 'pad' | 'liftoff' | 'ascent' | 'staging' | 'boostback' | 'boosterLanding' | 'boosterDown' | 'coast' | 'deploy' | 'entry' | 'shipLanding' | 'shipDown';

/** Events that start a new situation at once (and how long it lasts, s, unless the state moves on). */
const CUES: [RegExp, Situation, number][] = [
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

export class Director {
  enabled = false;
  private cue: { s: Situation; until: number } | null = null;
  private situation: Situation | null = null;
  private shotAt = -Infinity;
  private shotLen = 8;
  private index = 0;

  /** Start afresh (a new flight). */
  reset(): void {
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
    this.shotLen = rand(6, 12);
    if (v.manual) delete shot.track;
    return shot;
  }

  private situationNow(now: number, v: DirectorView): Situation {
    if (this.cue && now < this.cue.until) return this.cue.s;
    this.cue = null;
    const get = (id: string) => v.vehicles.find((x) => x.id === id && x.status !== 'destroyed');
    const stack = get('stack'), booster = get('booster'), ship = get('ship');
    const mt = v.missionTime;
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
    switch (s) {
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
