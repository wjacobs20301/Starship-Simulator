// Lists the animatable pivot nodes and textures in public/models/*.glb.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of ['booster', 'ship', 'pad']) {
  const doc = await io.read(`${import.meta.dirname}/../public/models/${f}.glb`);
  const nodes = doc.getRoot().listNodes().map((n) => n.getName());
  const tex = doc.getRoot().listTextures().map((t) => `${t.getName()}:${t.getMimeType()}:${t.getSize()}`);
  const want = nodes.filter((n) => /^(Engine_\d\d|GridFin_[A-Za-z_]+|Flap_(Aft|Fwd)_[LR]|(Pad\d_)?(Chopstick_[LRNS]|Carriage|ShipQD))$/.test(n));
  console.log(f, 'nodes', nodes.length, 'pivots', want.length, want.filter((n) => !n.startsWith('Engine')).join(','), '\n  tex', tex.join(' '));
}
