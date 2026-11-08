// Bakes rows of the global weather map off the main thread (a few of these share the work).

import { Land, type WeatherConfig, WeatherModel } from './model';

export type ToBake =
  | { type: 'config'; cfg: WeatherConfig; land: Uint8Array | null }
  | { type: 'bake'; id: number; t: number; sun: number[]; W: number; H: number; j0: number; j1: number };

export type FromBake = { type: 'baked'; id: number; j0: number; j1: number; a: Uint8Array; b: Uint8Array; c: Uint8Array };

let land: Land | null = null;
let model: WeatherModel | null = null;

self.onmessage = (ev: MessageEvent<ToBake>) => {
  const m = ev.data;
  if (m.type === 'config') {
    if (m.land && !land) land = new Land(m.land);
    model = new WeatherModel(m.cfg, land);
    return;
  }
  if (!model) return;
  const rows = m.j1 - m.j0;
  const a = new Uint8Array(m.W * rows * 4);
  const b = new Uint8Array(m.W * rows * 4);
  const c = new Uint8Array(m.W * rows * 4);
  model.bake(m.t, m.sun, m.W, m.H, a, b, m.j0, m.j1, c);
  const out: FromBake = { type: 'baked', id: m.id, j0: m.j0, j1: m.j1, a, b, c };
  (self as unknown as Worker).postMessage(out, [a.buffer, b.buffer, c.buffer]);
};
