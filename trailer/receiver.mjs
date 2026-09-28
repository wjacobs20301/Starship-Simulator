// Tiny local receiver: the trailer page POSTs its recording here; it's written to ./out.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(dir, { recursive: true });
http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.method === 'GET') {
      // Serve a script from this folder (the trailer director).
      const f = path.join(path.dirname(dir), path.basename(new URL(req.url, 'http://x').pathname));
      if (!fs.existsSync(f)) return res.writeHead(404).end();
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(fs.readFileSync(f));
    }
    const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') || 'clip.bin');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      fs.writeFileSync(path.join(dir, name), buf);
      console.log(`saved ${name} ${buf.length} bytes`);
      res.end('ok');
    });
  })
  .listen(8765, '127.0.0.1', () => console.log('listening 8765'));
