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
  it('a rollout is a film: clips up the road with a title, some run fast, the transport taken on between them', () => {
    const d = new Director();
    const ship = [veh('booster', { status: 'held' }), veh('ship', { status: 'landed' })];
    const L = 3800;
    const roll = (gone: number, arrived = false, events: string[] = []) => view({ missionTime: null, vehicles: ship, tracked: 'ship', events, transport: { id: 'ship', pad: 0, gone, left: L - gone, arrived } });
    // Out of the gate: wide, with the title, at the rollout's own pace and from where it is.
    const first = d.update(0, roll(0))!;
    expect(first.mode).toBe('orbit');
    expect(first.track).toBe('ship');
    expect(first.title?.[0]).toBe('Rollout');
    expect(first.title?.[1]).toContain('Pad 1');
    expect(first.pace).toBe(1);
    expect(first.skipTo).toBeUndefined();
    expect(d.update(4, roll(3))).toBeNull();
    expect(d.upcoming(roll(3).transport)?.at).toBeGreaterThan(100);
    // The film: the transport as the clips leave it (taken on to each one's start, then driven at its pace).
    const clips = [first];
    let gone = 20;
    let t = 0;
    for (let k = 0; k < 4000 && gone < L - 0.5; k++) {
      t += 0.1;
      const s = d.update(t, roll(gone));
      if (s) {
        clips.push(s);
        if (s.skipTo !== undefined) {
          expect(s.skipTo).toBeGreaterThan(gone);
          gone = s.skipTo;
        }
      }
      gone = Math.min(L - 0.5, gone + (L - gone > 30 ? 6 : 1.2) * (clips[clips.length - 1].pace ?? 1) * 0.1);
    }
    // (To the stand in a minute and a half, not ten.)
    expect(t).toBeGreaterThan(60);
    expect(t).toBeLessThan(110);
    expect(clips.length).toBeGreaterThanOrEqual(9);
    expect(clips.every((s) => s.track === 'ship' && s.pace !== undefined && s.last === undefined)).toBe(true);
    expect(clips.filter((s) => s.pace! > 1).length).toBeGreaterThanOrEqual(3);
    expect(clips.filter((s) => s.skipTo !== undefined).length).toBeGreaterThanOrEqual(6);
    expect(clips.some((s) => s.mode === 'roadside' && s.roadside !== undefined)).toBe(true);
    expect(clips.filter((s) => s.mode === 'orbit').every((s) => s.orbit?.ahead === true)).toBe(true);
    // There: round it with a title, twice, at time's own pace; and the last shot hands the camera back.
    const there = d.update(t + 1, roll(L, true, ['Starship at Pad 1, on its stand beside the mount: the chopsticks can take it']))!;
    expect(there.title?.[0]).toBe('Pad 1');
    expect(there.pace).toBe(1);
    expect(there.last).toBeUndefined();
    const after = [];
    for (let u = t + 2; u < t + 60; u += 1) {
      const s = d.update(u, roll(L, true));
      if (s) after.push(s);
      // (The game turns the auto camera off on that shot: game/viewModes.ts.)
      if (s?.last) break;
    }
    expect(after.length).toBe(2);
    expect(after[0].last).toBeUndefined();
    expect(after[1].last).toBe(true);
    expect(after[1].mode).toBe('orbit');
    expect(after[1].pace).toBe(1);
    // (Turned on again later, the ship still on its stand: the pad's usual shots, nothing of the rollout.)
    d.reset();
    const later = d.update(t + 200, roll(L, true))!;
    expect(later.last).toBeUndefined();
    expect(later.title).toBeUndefined();
  });

  it('turned on part of the way out, the film takes up from there: no clip from behind the transport, none back down the road', () => {
    const d = new Director();
    const at = (gone: number) => view({ missionTime: null, vehicles: [veh('ship', { status: 'landed' })], tracked: 'ship', transport: { id: 'ship', pad: 1, gone, left: 4000 - gone, arrived: false } });
    const s = d.update(0, at(2500))!;
    expect(s.title).toBeUndefined();
    if (s.skipTo !== undefined) expect(s.skipTo).toBeGreaterThan(2500);
    const next = d.upcoming(at(2500).transport)!;
    expect(next.at).toBeGreaterThan(2500);
  });
});
