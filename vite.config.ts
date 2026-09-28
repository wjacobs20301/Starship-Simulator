import { cpSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** The public site's hostname (served through a Cloudflare tunnel). */
const HOST = 'starship.wjacobs.space';

/**
 * The streamed terrain and globe tiles (~10 GB, ~750k files): left out of the build's copy of
 * public/. In production the web server serves them from their own folder (synced once, not
 * rebuilt), next to the built site.
 */
const STREAMED = ['terrain', join('globe', 'tiles')];

/** Copy public/ into the build, minus the streamed tiles. */
function copyPublicExceptTiles(): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'copy-public-except-tiles',
    apply: 'build',
    configResolved(c) {
      root = c.publicDir;
      outDir = c.build.outDir;
    },
    closeBundle() {
      cpSync(root, outDir, {
        recursive: true,
        filter: (src) => {
          const rel = relative(root, src);
          return !STREAMED.some((s) => rel === s || rel.startsWith(s + sep));
        },
      });
    },
  };
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5180,
    // Served to the internet through a Cloudflare tunnel: Vite only answers requests for hosts it
    // knows, so allow the tunnel's hostname (HMR follows the page's own host / port, so it works
    // over the tunnel's https too).
    allowedHosts: [HOST],
    // The terrain is ~750k static tile files: watching them exhausts the dev server's memory.
    watch: { ignored: ['**/public/terrain/**', '**/public/terrain.*/**', '**/public/globe/tiles/**', '**/art/**', '**/dist/**', '**/trailer/**'] },
  },
  // (The same for `vite preview`, serving the production build.)
  preview: { port: Number(process.env.PORT) || 5180, allowedHosts: [HOST] },
  // (One main chunk, ~290 kB gzipped: fine for a game that then streams its tiles.)
  build: { copyPublicDir: false, chunkSizeWarningLimit: 1500 },
  plugins: [copyPublicExceptTiles()],
  worker: { format: 'es' },
  // (The flight tests are heavy: all at once on every core, the slowest can run out of time.)
  test: { include: ['tests/**/*.test.ts'], maxWorkers: 4 },
});
