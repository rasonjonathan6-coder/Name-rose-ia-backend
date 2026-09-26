/**
 * Static server for the local demo page.
 *
 * Serves ./dist so the demo runs at http://localhost:4173/demo/demo.html, which
 * matches the `http://localhost/*` content-script match pattern in the manifest.
 * Load the unpacked extension first, then open this URL — the demo exercises the
 * real detection, memory, generation and insertion paths, not a mock.
 *
 * The extension origin must be reachable from the page for `chrome.*` APIs; the
 * demo works with or without them, so it is useful even outside the extension.
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

if (!fs.existsSync(dist)) {
  process.stderr.write('[demo] dist/ not found — run `npm run build` first.\n');
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const rel = url.pathname === '/' ? '/demo/demo.html' : url.pathname;
  const filePath = path.join(dist, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(dist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  process.stdout.write(`[demo] http://localhost:${PORT}/demo/demo.html\n`);
});
