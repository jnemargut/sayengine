// Web back end (three.js + Rapier): bundle src/main.ts with esbuild, serve the game folder on a
// local port, load it in headless Chrome and call window.__studio.run(cmd) (studio/harness.ts).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PKG, STUDIO_ROOT, workDir } from './project.ts';
import { withPage } from './chrome.ts';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

/** Bundle the game. Third-party imports (three, Rapier) resolve from the studio's node_modules. */
export async function bundle(dir: string, entry = 'src/main.ts', outfile = 'dist/game.js'): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const esbuild = await import('esbuild');
  try {
    const r = await esbuild.build({
      entryPoints: [path.join(dir, entry)], outfile: path.join(dir, outfile), bundle: true, format: 'esm', target: 'es2022',
      nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent', sourcemap: 'inline', absWorkingDir: dir,
    });
    return { ok: true, errors: [], warnings: r.warnings.map((w) => `${w.location?.file ?? ''}:${w.location?.line ?? ''} ${w.text}`) };
  } catch (e: any) {
    return { ok: false, errors: (e.errors ?? [{ text: e.message }]).map((x: any) => `${x.location?.file ?? ''}:${x.location?.line ?? ''} ${x.text}`), warnings: [] };
  }
}

/** Serve a folder on 127.0.0.1 (random port) for the duration of fn. */
export async function serve<T>(dir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    if (rel === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try { return await fn(`http://127.0.0.1:${port}/`); } finally { server.close(); }
}

/** Bundle, serve, open in headless Chrome, run one harness command; screenshots are written as PNGs. */
export async function webCommand(dir: string, cmd: Record<string, any>, opts: { size?: number } = {}) {
  const b = await bundle(dir);
  if (!b.ok) return { ok: false, error: 'the game did not compile', errors: b.errors, warnings: b.warnings };
  const w = Math.round(opts.size ?? 960), h = Math.round(w * 0.625);
  return serve(dir, (url) => withPage(url + 'index.html', { width: w, height: h }, async (page) => {
    const ready = await page.eval(`Promise.race([window.__studio?.ready ?? Promise.reject(new Error('no harness: src/main.ts must call installHarness(start())')), new Promise((_, j) => setTimeout(() => j(new Error('game did not become ready in 60 s')), 60000))]).then(() => true, (e) => String(e && e.message || e))`, 90000);
    if (ready !== true) return { ok: false, error: String(ready), errors: page.logs.filter((l) => l.level === 'error').map((l) => l.text), warnings: page.logs.filter((l) => l.level === 'warning').map((l) => l.text) };
    const raw = await page.eval(`window.__studio.run(${JSON.stringify(cmd)})`, 180000);
    const { ok, error, ...result } = raw ?? { ok: false, error: 'no result' };
    if (Array.isArray(result.images)) result.images = writeImages(dir, cmd.prefix ?? `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${cmd.cmd}`, result.images);
    if (Array.isArray(result.frames) && typeof cmd.frames === 'string') {
      fs.mkdirSync(cmd.frames, { recursive: true });
      result.frames.forEach((d: string, i: number) => fs.writeFileSync(path.join(cmd.frames, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(d.replace(/^data:image\/\w+;base64,/, ''), 'base64')));
      result.framesRecorded = result.frames.length;
      delete result.frames;
    }
    const errors = page.logs.filter((l) => l.level === 'error').map((l) => l.text);
    const warnings = [...b.warnings, ...page.logs.filter((l) => l.level === 'warning').map((l) => l.text)];
    return { ok: ok !== false && !error, error, result, warnings, errors };
  }));
}

function writeImages(dir: string, prefix: string, images: Array<{ view: string; dataUrl: string }>) {
  const out = workDir(dir, 'shots');
  return images.map((im) => {
    const file = path.join(out, `${prefix}-${im.view}.png`);
    fs.writeFileSync(file, Buffer.from(im.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    return { view: im.view, file, ok: true };
  });
}

/** Round-trip a GLB through three.js's GLTFLoader in headless Chrome — for the studio's export checks. */
export async function roundTrip(glbPath: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-web-roundtrip-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.copyFileSync(path.join(PKG, 'src', 'web-roundtrip-page.ts'), path.join(dir, 'src', 'main.ts'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><body><script type="module" src="dist/game.js"></script>');
    fs.copyFileSync(glbPath, path.join(dir, 'scene.glb'));
    const b = await bundle(dir);
    if (!b.ok) return { ok: false, engine: 'web', errors: b.errors, warnings: b.warnings };
    return await serve(dir, (url) => withPage(url + 'index.html', { width: 640, height: 400 }, async (page) => {
      const rep = await page.eval('window.__roundTrip', 60000);
      const errors = [...(rep?.error ? [rep.error] : []), ...page.logs.filter((l) => l.level === 'error').map((l) => l.text)];
      const warnings = page.logs.filter((l) => l.level === 'warning').map((l) => l.text);
      return { ok: !errors.length, engine: 'web' as const, ...(rep ?? {}), error: undefined, warnings, errors };
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
