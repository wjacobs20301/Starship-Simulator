// Downloads a cloud-free Sentinel-2 L2A true-colour mosaic (10 m, Copernicus, free and open)
// at z14 over the whole 200 km region. It fills everything the NAIP survey doesn't cover
// (Mexico, offshore). Resumable.
//   npx tsx scripts/terrain/fetch-s2.ts [--concurrency=16]
import { resolve } from 'node:path';
import { S2_ZOOM, SRC, tileRange } from './config';
import { downloadTiles } from './tile-fetch';

export const S2_SEARCH = {
  collections: ['sentinel-2-l2a'],
  'filter-lang': 'cql2-json',
  filter: {
    op: 'and',
    args: [
      { op: 'anyinteracts', args: [{ property: 'datetime' }, { interval: ['2025-09-01T00:00:00Z', '2026-09-01T00:00:00Z'] }] },
      { op: '<', args: [{ property: 'eo:cloud_cover' }, 5] },
    ],
  },
  sortby: [{ field: 'eo:cloud_cover', direction: 'asc' }],
};

const concurrency = Number(process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 16);
const z = S2_ZOOM;
const r = tileRange(z);
const jobs: [number, number][] = [];
for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([x, y]);
downloadTiles({
  search: S2_SEARCH,
  collection: 'sentinel-2-l2a',
  query: 'assets=visual&asset_bidx=visual%7C1,2,3&nodata=0',
  z,
  jobs,
  dir: resolve(SRC, 's2'),
  concurrency,
});
