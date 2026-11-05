// npm run play: serve dist/web on http://127.0.0.1:8123 (any static file server works too).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, 'dist', 'web');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.wasm': 'application/wasm' };
const port = Number(process.env.PORT ?? 8123);
http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Fire's Dying: http://127.0.0.1:${port}/`));
