import { describe, expect, it } from 'vitest';
import { eventKind, eventWho } from '../src/sim/events';

// The wording the sim logs today for the events the game acts on (src/sim/events.ts). If one of
// these messages is reworded in the sim, change it here and in events.ts together.
describe('event kinds', () => {
  it('tells the events the game reacts to from their wording', () => {
    const cases: [string, ReturnType<typeof eventKind>][] = [
      ['Liftoff', 'liftoff'],
      ['Stage separation', 'separation'],
      ['SECO (manual): 26,000 km/h, alt 150 km, orbit -20 x 250 km', 'seco'],
      ['Booster caught! (0.42 m off center, 1.3 m/s)', 'boosterCaught'],
      ['Ship caught by the Pad 2 tower! (0.31 m off center, 0.9 m/s)', 'shipCaught'],
      ['Pad 1 chopsticks lifting Starship off Super Heavy', 'grab'],
      ['Pad 1 chopsticks lifting Super Heavy', 'grab'],
      ['Starship stacked on Super Heavy', 'stacked'],
      ['Return: flip and landing burn (1.20 km up, 0.35 km out)', 'landingFlip'],
      ['Final approach: hovering 40 m above the arms', 'finalApproach'],
      ['Payload door opening: 26 Starlink V3 satellites to deploy', 'doorOpening'],
      ['Payload door closed', 'doorClosed'],
      ['Super Heavy splashdown at 3.2 m/s (31 km downrange)', 'splashdown'],
      ['Starship touchdown at 2.1 m/s (0 km downrange)', 'touchdown'],
      ['Return: splashdown 21 m from the target at 1.4 m/s', 'splashdown'],
      ["Can't launch: Starship isn't stacked on Super Heavy on the launch mount", undefined],
      ['Max Q', undefined],
    ];
    for (const [text, kind] of cases) expect(eventKind(text), text).toBe(kind);
  });

  it('tells whose event it is', () => {
    expect(eventWho('Super Heavy splashdown at 3.2 m/s (31 km downrange)')).toBe('booster');
    expect(eventWho('Booster caught! (0.42 m off center, 1.3 m/s)')).toBe('booster');
    expect(eventWho('Starship touchdown at 2.1 m/s')).toBe('ship');
    expect(eventWho('Ship caught by the Pad 1 tower! (0.3 m off center, 1.0 m/s)')).toBe('ship');
    expect(eventWho('Stage separation')).toBeUndefined();
  });
});
