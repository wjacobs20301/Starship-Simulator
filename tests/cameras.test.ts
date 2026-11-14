import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, type CameraTarget } from '../src/render/cameras';
import { ecefToWorld } from '../src/render/geo';
import type { V3 } from '../src/sim/math';

const el = { addEventListener: () => {}, setPointerCapture: () => {} } as unknown as HTMLElement;
const CENTRE = ecefToWorld([0, 0, 0]);
const OMEGA_E = 7.2921159e-5;

/**
 * A ship on a circular orbit like Flight 15's (27 deg, ~275 km), as the cameras see it: its
 * place in the world (which turns with the Earth) and the way it's going over the ground.
 */
function orbit(t: number): CameraTarget {
  const R = 6.65e6;
  const n = Math.sqrt(3.986e14 / R ** 3);
  const inc = (27 * Math.PI) / 180;
  const at = (time: number): V3 => {
    const u = n * time + 0.4;
    // Inertial, then into the Earth's turning frame.
    const x = R * Math.cos(u);
    const y = R * Math.sin(u) * Math.cos(inc);
    const z = R * Math.sin(u) * Math.sin(inc);
    const a = -OMEGA_E * time;
    return ecefToWorld([x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z]);
  };
  const p = at(t);
  const q = at(t + 1);
  return { center: p, axis: [0, 1, 0], size: 52, id: 'ship', track: [q[0] - p[0], q[1] - p[1], q[2] - p[2]] };
}

/** Where the camera sits relative to the ship: how far along its track, to its left, and above it (unit). */
function seat(cam: V3, tg: CameraTarget): V3 {
  const c = tg.center;
  const up = new THREE.Vector3(c[0] - CENTRE[0], c[1] - CENTRE[1], c[2] - CENTRE[2]).normalize();
  const fwd = new THREE.Vector3(...tg.track!);
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const left = new THREE.Vector3().crossVectors(up, fwd);
  const off = new THREE.Vector3(cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]).normalize();
  return [off.dot(fwd), off.dot(left), off.dot(up)];
}

describe('the free camera round a ship in orbit', () => {
  for (const [name, step] of [
    ['at normal speed', 1 / 60],
    ['under 1000x time warp', 1000 / 60],
    ['under 100 000x time warp', 1e5 / 60],
  ] as const) {
    it(`keeps its place by the ship, orbit after orbit, ${name}`, () => {
      const rig = new CameraRig(el);
      const camera = new THREE.PerspectiveCamera();
      rig.azimuth = 0.7;
      rig.elevation = 0.3;
      rig.distance = 200;
      // (From the pad, up to the orbit: the camera's axes are carried there.)
      rig.update(camera, { center: ecefToWorld([-1.2e6, -5.6e6, 2.8e6]), axis: [0, 1, 0], size: 52, id: 'ship' });
      let t = 0;
      rig.update(camera, orbit(t));
      const first = seat(rig.update(camera, orbit((t += step))), orbit(t));
      let worst = 0;
      // (Three orbits at least; a few thousand frames at the most.)
      const frames = Math.min(6000, Math.ceil((3.2 * 5400) / step));
      const stride = Math.max(1, Math.ceil((3.2 * 5400) / step / frames));
      for (let i = 0; i < frames; i++) {
        for (let k = 0; k < stride; k++) t += step;
        const s = seat(rig.update(camera, orbit(t)), orbit(t));
        worst = Math.max(worst, Math.hypot(s[0] - first[0], s[1] - first[1], s[2] - first[2]));
      }
      // (It used to swing right round the ship every orbit: a difference of up to 2.)
      expect(worst).toBeLessThan(0.02);
    });
  }

  it("near the pad it is the pad's own frame, as it always was", () => {
    const rig = new CameraRig(el);
    const camera = new THREE.PerspectiveCamera();
    rig.azimuth = 0;
    rig.elevation = 0;
    rig.distance = 100;
    const cam = rig.update(camera, { center: [10, 50, -20], axis: [0, 1, 0], size: 124, id: 'stack' });
    expect(cam[0]).toBeCloseTo(10, 0);
    expect(cam[1]).toBeCloseTo(50, 0);
    expect(cam[2]).toBeCloseTo(80, 0);
  });

  it("Starbase's cameras are offered only for what they can see", () => {
    expect(CameraRig.groundSees([500, 3000, -2000])).toBe(true);
    expect(CameraRig.groundSees([80e3, 60e3, -5e3])).toBe(true);
    // (In orbit round the far side of the Earth; and close by but under the horizon.)
    expect(CameraRig.groundSees(orbit(2700).center)).toBe(false);
    expect(CameraRig.groundSees([300e3, -6e3, 0])).toBe(false);
  });
});
