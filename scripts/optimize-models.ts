// Optimizes Blender's GLB exports for the web: dedup + weld + meshopt geometry
// compression + WebP textures. Named pivot nodes (engines, fins, flaps, chopsticks)
// are preserved: no flatten/join/instancing passes that would merge or rename nodes.
import { readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const inDir = resolve(import.meta.dirname, '../art/generated/glb');
const outDir = resolve(import.meta.dirname, '../public/models');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

for (const file of readdirSync(inDir).filter((f) => f.endsWith('.glb'))) {
  const src = resolve(inDir, file);
  const dst = resolve(outDir, file);
  const doc = await io.read(src);
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88, resize: [1024, 1024] }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(dst, doc);
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`${basename(file)}: ${kb(statSync(src).size)} -> ${kb(statSync(dst).size)}`);
}
