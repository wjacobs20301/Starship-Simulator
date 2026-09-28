// Writes art/generated/geometry.json from the simulation config, so the Blender model
// scripts and the physics share one source of truth for dimensions and engine layout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MISSION, STARSHIP_V3, SUPER_HEAVY_V3 } from '../src/sim/config/starshipV3';
import { PAD, PAD2 } from '../src/sim/constants';
import type { StageDef } from '../src/sim/vehicle';

const stage = (d: StageDef) => ({
  id: d.id,
  xBase: d.xBase,
  length: d.length,
  radius: d.radius,
  engines: d.engines.map((e, i) => ({
    index: i,
    name: e.type.name,
    vacuum: e.type.name.includes('Vacuum'),
    ring: e.ring,
    // Body frame: x along the axis (from the booster base), y/z lateral.
    pos: e.pos,
    exitDiameter: 2 * Math.sqrt(e.type.exitArea / Math.PI),
    length: e.type.length,
    gimbals: e.type.gimbalMax > 0,
  })),
});

const out = resolve(import.meta.dirname, '../art/generated/geometry.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      booster: stage(SUPER_HEAVY_V3),
      ship: stage(STARSHIP_V3),
      pad: PAD,
      // Pads in local east/north metres from the Pad 1 mount (the render origin).
      pads: [PAD, PAD2].map((p, i) => ({
        prefix: `Pad${i + 1}_`,
        mount: [(p.lonDeg - PAD.lonDeg) * 111_320 * Math.cos((PAD.latDeg * Math.PI) / 180), (p.latDeg - PAD.latDeg) * 110_800],
        tower: [p.tower.e, p.tower.n],
        trench: p.trench,
      })),
      azimuthDeg: MISSION.azimuthDeg,
    },
    null,
    2,
  ),
);
console.log(`wrote ${out}`);
