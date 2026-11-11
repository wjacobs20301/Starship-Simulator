import { describe, expect, it } from 'vitest';
import { Director, type DirectorVehicle, type DirectorView } from '../src/render/director';

const veh = (id: string, o: Partial<DirectorVehicle> = {}): DirectorVehicle => ({ id, status: 'flight', altitude: 0, speed: 0, nearPad: true, ...o });
const view = (o: Partial<DirectorView>): DirectorView => ({ missionTime: -30, vehicles: [veh('stack', { status: 'held' })], events: [], door: false, sats: false, manual: false, tracked: 'stack', ...o });

describe('the auto camera', () => {
  it('on the pad, Starbase cameras on the stack', () => {
    const d = new Director();
    const s = d.update(0, view({}))!;
    expect(['pad', 'spectator', 'orbit', 'tower']).toContain(s.mode);
    expect(s.track).toBe('stack');
  });

  it('holds a shot, then cuts; cuts at once at liftoff', () => {
    const d = new Director();
    d.update(0, view({}));
    expect(d.update(3, view({}))).toBeNull();
    expect(d.update(13, view({}))).not.toBeNull();
    const lift = d.update(14, view({ missionTime: 0.5, events: ['Liftoff: all 33 engines'], vehicles: [veh('stack', { altitude: 10 })] }))!;
    expect(lift).not.toBeNull();
    expect(lift.mode).toBe('pad');
  });

  it('the booster coming home gets the tower camera', () => {
    const d = new Director();
    const v = (events: string[] = []) => view({ missionTime: 360, events, vehicles: [veh('booster', { altitude: 4000, speed: 700 }), veh('ship', { altitude: 180e3, speed: 7000, nearPad: false })], tracked: 'ship' });
    const shots = [d.update(0, v(['Landing burn startup (4.1 km)']))!];
    for (let t = 13; t < 13 * 6; t += 13) {
      const s = d.update(t, v());
      if (s) shots.push(s);
    }
    expect(shots.every((s) => s.track === 'booster')).toBe(true);
    expect(shots.some((s) => s.mode === 'tower')).toBe(true);
  });

  it("no Starbase cameras on a ship half a world away; doesn't take the controls from a pilot", () => {
    const d = new Director();
    const v = view({ missionTime: 3900, vehicles: [veh('ship', { altitude: 8000, speed: 200, nearPad: false })], tracked: 'ship', manual: true });
    for (let t = 0; t < 200; t += 13) {
      const s = d.update(t, v);
      if (!s) continue;
      expect(['pad', 'tower', 'spectator']).not.toContain(s.mode);
      expect(s.track).toBeUndefined();
    }
  });
});
