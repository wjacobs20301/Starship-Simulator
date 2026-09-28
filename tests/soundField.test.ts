import { describe, expect, it } from 'vitest';
import { SPEED_OF_SOUND, SoundField, plumePower } from '../src/audio/soundField';

describe('SoundField', () => {
  const fullBooster = plumePower(33 * 2.5e6, 1);

  it('delays the sound by distance / speed of sound', () => {
    const f = new SoundField();
    const listener: [number, number, number] = [9000, 0, 0];
    // Silent until ignition at t = 10, then running.
    for (let t = 0; t <= 60; t += 0.1) f.record('stack', t, [0, 0, 0], t < 10 ? 0 : fullBooster);
    const arrival = 10 + 9000 / SPEED_OF_SOUND;
    expect(f.hear(arrival - 0.5, listener).level).toBe(-Infinity);
    expect(f.hear(arrival + 0.5, listener).level).toBeGreaterThan(100);
  });

  it('gives launch-like levels near and far', () => {
    const f = new SoundField();
    f.record('stack', 0, [0, 0, 0], fullBooster);
    f.record('stack', 100, [0, 0, 0], fullBooster);
    const near = f.hear(50, [450, 0, 0]).level;
    const far = f.hear(50, [9000, 0, 0]).level;
    expect(near).toBeGreaterThan(135);
    expect(near).toBeLessThan(150);
    expect(far).toBeGreaterThan(110);
    expect(far).toBeLessThan(125);
  });

  it('silences a source that stops being recorded', () => {
    const f = new SoundField();
    for (let t = 0; t <= 10; t += 0.1) {
      f.record('stack', t, [0, 0, 0], fullBooster);
      f.prune(t);
    }
    f.prune(10.1);
    f.prune(20);
    expect(f.hear(20 + 100 / SPEED_OF_SOUND, [100, 0, 0]).level).toBe(-Infinity);
  });
});
