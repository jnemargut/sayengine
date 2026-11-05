// Pocket Raleigh (web): stills and frame sequences of town life for the checkpoint, the same shots as
// games/pocket-raleigh/game/life_capture.gd (bench/life-shots.json). Bundles the game, serves it on port
// 4641, drives it in Chrome (GPU) with the clock stepped by hand: 30 fps of game time per frame.
//   node bench/life-web-capture.ts <shots.json> <out dir>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { bundle } from '../packages/game/src/web.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(ROOT, 'games/pocket-raleigh-web');
const [shotsFile, out] = [process.argv[2] ?? path.join(ROOT, 'bench/life-shots.json'), process.argv[3] ?? path.join(ROOT, '.scratch/life-web')];
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const b = await bundle(GAME);
if (!b.ok) { console.log('bundle failed', b.errors.slice(0, 5)); process.exit(1); }
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(GAME, rel);
  if (!file.startsWith(GAME) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(4641, '127.0.0.1', () => r()));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('page error', e.message));
await page.goto('http://127.0.0.1:4641/');
await page.waitForFunction(() => (window as any).life && (window as any).__game, null, { timeout: 180000 });
await page.evaluate(() => {
  const g = (window as any).__game;
  g.paused = true;
  // the studio player stays out of the way
  const p = g.characters?.player;
  if (p?.body) p.body.setTranslation({ x: 0, y: -400, z: 0 }, true);
});
for (const s of shots) {
  await page.evaluate((s) => { (window as any).life.seek(s.t, s.warm ?? 60); (window as any).life.showWalk(!!s.walk); for (let k = 0; k < (s.ff ?? 0); k++) (window as any).life.rt.step(); (window as any).life.update(0); (window as any).__cam = null; }, s);
  const frames = s.frames ?? 1;
  for (let f = -6; f < frames; f++) {
    const url = await page.evaluate(({ s, f }) => {
      const g = (window as any).__game, life = (window as any).life, THREE_cam = g.camera;
      const dt = 1 / 30;
      g.step(dt); life.update(dt);
      let pos = s.cam, look = s.look;
      const who = s.follow !== undefined ? life.rt.agents[s.follow] : s.followVehicle !== undefined ? life.rt.vehicles[s.followVehicle] : null;
      if (who && who.visible) {
        const yaw = who.yaw + (s.angle ?? 0) * Math.PI / 180;
        pos = [who.x - Math.sin(yaw) * (s.dist ?? 6), who.y + (s.height ?? 2.6), who.z - Math.cos(yaw) * (s.dist ?? 6)];
        look = [who.x, who.y + (s.lookUp ?? 1), who.z];
        const w = window as any;
        if (w.__cam && f > -6) pos = pos.map((v: number, k: number) => w.__cam[k] + (v - w.__cam[k]) * 0.08);
        w.__cam = pos;
      }
      THREE_cam.fov = s.fov ?? 50; THREE_cam.updateProjectionMatrix();
      THREE_cam.position.set(pos[0], pos[1], pos[2]);
      THREE_cam.lookAt(look[0], look[1], look[2]);
      g.renderer.render(g.scene, THREE_cam);
      return f >= 0 ? g.renderer.domElement.toDataURL('image/png') : null;
    }, { s, f });
    if (url) fs.writeFileSync(path.join(out, `${s.name}-${String(f).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log('shot', s.name, frames);
}
await browser.close();
server.close();
console.log('LIFE_WEB_CAPTURE done');
