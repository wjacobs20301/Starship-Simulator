// Stacking done for the player: a ship that has rolled out to a pad's stand lifted off it by the
// tower's arms and set on the booster on the mount, as someone at the arms' controls would do it
// (tests/rollout.test.ts does the same by hand). It only gives the arms their orders, a step at
// a time, and waits for each to be carried out: everything the arms do, and what they may not
// (simulation.ts constrainArms), is as ever.
//
//   close   the arms nearly shut (wide open, the one nearer the mount would be over the booster
//           still when the pair is as far round as it goes)
//   reach   round to the stand and down to the ship's catch fittings
//   grip    shut on the ship
//   lift    up with it, clear of the booster's top
//   swing   back round over the mount
//   lower   down until the ship stands on the booster (the carriage stops: the arms can't go on
//           down past what they hold)
//   clear   the arms opened off it (let go, the two are one stack again) and back up the tower,
//           where they stand for a launch
//
// Not part of a flight's saved state: a flight loaded part of the way through one is left with
// the arms where they were going, for the player to carry on with.

import { STARSHIP_V3 } from './config/starshipV3';
import { PAD } from './constants';
import { STAND_HEIGHT } from './padCollision';
import { SHIP_CATCH_PIN } from './shipReturn';
import type { Simulation } from './simulation';
import { ARMS } from './tower';

export type StackStage = 'close' | 'reach' | 'grip' | 'lift' | 'swing' | 'lower' | 'clear';
const ORDER: StackStage[] = ['close', 'reach', 'grip', 'lift', 'swing', 'lower', 'clear'];
/** A step not done in this long (sim s) won't be: something is in the way. The stacking is given up. */
const STAGE_MAX = 150;
/** The arms as they're swung round to the stand, deg open. */
const NARROW = 18;

export class AutoStack {
  stage: StackStage | null = 'close';
  private since: number;
  /** Lowering: where the carriage was last step, and for how many steps it has been there. */
  private was = NaN;
  private still = 0;

  constructor(
    private sim: Simulation,
    readonly pad: number,
  ) {
    this.since = sim.t;
    if (!AutoStack.ready(sim, pad)) this.stage = null;
  }

  /** Whether there's a ship on the pad's stand to stack, a booster on the mount to stack it on, and arms to do it with. */
  static ready(sim: Simulation, pad: number): boolean {
    const tr = sim.transport;
    const ship = tr ? sim.find(tr.id) : undefined;
    const booster = sim.find('booster');
    return !!tr && tr.arrived && tr.pad === pad && ship?.status === 'landed' && booster?.status === 'held' && !sim.towers[pad].disabled;
  }

  /** Each tick of the simulation's clock (any number of its steps apart): the order for the step it's at, and on to the next when it's done. */
  step(): void {
    if (!this.stage) return;
    const { sim, pad } = this;
    const arms = sim.towers[pad];
    const ship = sim.find('ship');
    const stacked = !!sim.find('stack');
    // Nothing to stack any more (the ship dropped, the arms wrecked), or stuck: given up.
    if (arms.disabled || (!stacked && (!ship || ship.status === 'destroyed')) || sim.t - this.since > STAGE_MAX) {
      sim.log('Stacking stopped: the arms are yours');
      this.stage = null;
      return;
    }
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;
    const reach = STAND_HEIGHT + SHIP_CATCH_PIN - ARMS.homeTop;
    const over = PAD.mountHeight + STARSHIP_V3.xBase + SHIP_CATCH_PIN + 4 - ARMS.homeTop;
    let done = false;
    switch (this.stage) {
      case 'close':
        arms.command({ angle: NARROW });
        done = near(arms.angle, NARROW, 0.3);
        break;
      case 'reach':
        arms.command({ slew: ARMS.maxSlewDeg, offset: reach });
        done = near(arms.slew, ARMS.maxSlewDeg, 0.05) && near(arms.offset, reach, 0.02);
        break;
      case 'grip':
        arms.command({ angle: 0 });
        done = arms.contact;
        break;
      case 'lift':
        arms.command({ offset: over });
        done = near(arms.offset, over, 0.02) && ship?.status === 'caught';
        break;
      case 'swing':
        arms.command({ slew: 0 });
        done = near(arms.slew, 0, 0.02);
        break;
      case 'lower':
        arms.command({ offset: ARMS.minOffset });
        // (Stopped to a hair: the floor it rests on is worked out afresh each step.)
        this.still = Math.abs(arms.offset - this.was) < 2e-4 ? this.still + 1 : 0;
        this.was = arms.offset;
        done = arms.offset < over - 3 && this.still > 50;
        break;
      case 'clear':
        // (Open first: up the tower shut, they'd take the stack's nose with them.)
        arms.command({ angle: ARMS.openDeg });
        if (stacked && arms.angle > ARMS.openDeg - 6) arms.command({ offset: ARMS.launchOffset });
        done = stacked && near(arms.angle, ARMS.openDeg, 0.3) && near(arms.offset, ARMS.launchOffset, 0.05);
        break;
    }
    if (done) {
      this.stage = ORDER[ORDER.indexOf(this.stage) + 1] ?? null;
      this.since = sim.t;
    }
  }
}
