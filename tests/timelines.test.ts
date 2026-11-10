import { describe, expect, it } from 'vitest';
import { MISSIONS } from '../src/game/missions';
import { formatT, missionTimeline } from '../src/game/timelines';

describe('mission timelines', () => {
  it('every mission has one, its milestones in time order', () => {
    for (const m of MISSIONS) {
      const tl = missionTimeline(m.id);
      expect(tl.length, m.id).toBeGreaterThan(0);
      for (let i = 1; i < tl.length; i++) expect(tl[i].at, `${m.id} ${tl[i].label}`).toBeGreaterThanOrEqual(tl[i - 1].at);
    }
  });

  it('Flight 15 runs from liftoff through the Starlink deployment to the ship catch nearly a day later', () => {
    const labels = missionTimeline('flight15').map((x) => x.label);
    expect(labels.slice(0, 3)).toEqual(['LIFTOFF', 'MAX-Q', 'MECO']);
    for (const l of ['BOOSTER CATCH', 'SECO', 'STARLINK DEPLOY', 'DEPLOY COMPLETE', 'DEORBIT BURN', 'SHIP CATCH']) expect(labels).toContain(l);
    expect(missionTimeline('flight15').at(-1)!.at / 3600).toBeGreaterThan(20);
  });

  it('a fresh copy each time (the webcast moves milestones to when they happen)', () => {
    const a = missionTimeline('ift');
    a[0].at = 999;
    expect(missionTimeline('ift')[0].at).toBe(0);
  });

  it('formats mission times', () => {
    expect(formatT(75)).toBe('1:15');
    expect(formatT(81048)).toBe('22:30:48');
  });
});
