// A launch tower's catch arms ("chopsticks"): the carriage slides up and down the tower and the
// two arms swing open and closed about their hinge. Both move at a limited rate toward targets
// set by the flight sequence (arms high up the tower for launch and the booster catch, closed
// on the booster) or by the player.

export const ARMS = {
  /** Top of the arms' landing rails with the carriage at its home (catch) position, m. */
  homeTop: 99.5,
  /** Carriage travel relative to home, m (arm tops from ~50 m up to just under the tower top). */
  minOffset: -50,
  maxOffset: 36,
  /** Where the arms sit for launch and stay for the booster catch: high up the tower. */
  launchOffset: 34,
  /** Arm opening, degrees each side (0 = closed on a vehicle, parallel). */
  maxOpenDeg: 80,
  openDeg: 50,
  /** Travel rates: carriage m/s, arms deg/s (approx). */
  liftRate: 2.5,
  swingRate: 8,
  /**
   * Both arms turned together about the carriage's pivot (deg, + = counter-clockwise seen from
   * above): carries what they hold around to the side of the tower, e.g. onto a transport stand.
   */
  maxSlewDeg: 100,
  slewRate: 2.5,
  /** Ship quick-disconnect arm: swung back against the tower (deg from its reach-out position), and its rate, deg/s. */
  qdStowedDeg: 80,
  qdRate: 16,
};

export class TowerArms {
  /** Carriage height relative to home, m. */
  offset = 0;
  /** Opening angle, degrees. */
  angle = ARMS.openDeg;
  /** Swing of both arms together about the carriage (deg, + counter-clockwise from above). */
  slew = 0;
  targetOffset = 0;
  targetAngle = ARMS.openDeg;
  targetSlew = 0;
  /** Lowest the carriage may go right now (e.g. with a booster hanging on the arms). */
  floor = ARMS.minOffset;
  /** Both arms are pressed against a vehicle and can close no further (padCollision.ts). */
  contact = false;
  /** Closing is blocked this step (both arms on a vehicle, or one on a vehicle that can't be pushed). */
  blocked = false;
  /** One arm is already touching a vehicle: close the rest of the way slowly (squeeze, don't shove). */
  touching = false;
  /** Arms wrecked by a collision (they hang dead), and the tower itself felled. */
  broken = { L: false, R: false };
  down = false;
  /** Which way a felled tower goes over (pad ENU, horizontal unit). */
  fallDir: [number, number, number] = [0, -1, 0];
  /** Ship quick-disconnect arm: swing (deg; 0 = reaching out to a ship on the mount), where it's going, and wrecked. */
  qd = 0;
  qdTarget = 0;
  qdBroken = false;

  /** Swing the ship QD arm back against the tower (true) or out to the mount (false). */
  stowQd(stow: boolean): void {
    if (!this.qdBroken && !this.down) this.qdTarget = stow ? ARMS.qdStowedDeg : 0;
  }

  get qdStowed(): boolean {
    return this.qdBroken || this.down || this.qd >= ARMS.qdStowedDeg - 1;
  }

  /** Wrecked: nothing moves any more. */
  get disabled(): boolean {
    return this.down || this.broken.L || this.broken.R;
  }

  /** Top of the arms' rails above the pad ground, m. */
  get top(): number {
    return ARMS.homeTop + this.offset;
  }

  get moving(): boolean {
    const swinging = Math.abs(this.targetAngle - this.angle) > 0.01 && !(this.blocked && this.targetAngle < this.angle);
    return Math.abs(this.targetOffset - this.offset) > 0.01 || swinging || Math.abs(this.targetSlew - this.slew) > 0.01;
  }

  /** Command targets (clamped to the travel limits). */
  command(target: { offset?: number; angle?: number; slew?: number }): void {
    if (this.disabled) return;
    if (target.offset !== undefined) this.targetOffset = Math.min(ARMS.maxOffset, Math.max(ARMS.minOffset, target.offset));
    if (target.angle !== undefined) this.targetAngle = Math.min(ARMS.maxOpenDeg, Math.max(0, target.angle));
    if (target.slew !== undefined) this.targetSlew = Math.min(ARMS.maxSlewDeg, Math.max(-ARMS.maxSlewDeg, target.slew));
  }

  /** Stop wherever they are. */
  hold(which: 'lift' | 'swing' | 'slew'): void {
    if (which === 'lift') this.targetOffset = this.offset;
    else if (which === 'slew') this.targetSlew = this.slew;
    else this.targetAngle = this.angle;
  }

  update(dt: number): void {
    if (!this.qdBroken && !this.down) this.qd += Math.max(-ARMS.qdRate * dt, Math.min(ARMS.qdRate * dt, this.qdTarget - this.qd));
    if (this.disabled) return;
    const to = Math.max(this.floor, this.targetOffset);
    this.offset += Math.max(-ARMS.liftRate * dt, Math.min(ARMS.liftRate * dt, to - this.offset));
    this.slew += Math.max(-ARMS.slewRate * dt, Math.min(ARMS.slewRate * dt, this.targetSlew - this.slew));
    // Commanded closed onto something, they keep squeezing: stopped only while it pushes back.
    if (this.blocked && this.targetAngle < this.angle) return;
    const rate = this.touching && this.targetAngle < this.angle ? ARMS.swingRate * 0.2 : ARMS.swingRate;
    this.angle += Math.max(-rate * dt, Math.min(rate * dt, this.targetAngle - this.angle));
  }
}
