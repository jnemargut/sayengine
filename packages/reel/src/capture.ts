// Capturing reel takes from the game itself (Decision 32): Godot's movie mode (`--write-movie` with a
// fixed frame rate: every frame rendered, none dropped, whatever the machine's speed) and the web build
// in headless Chrome at a fixed step (the game paused; the harness draws one frame per camera). Each take
// becomes takes/<id>.mp4 (near-lossless) in the reel's work folder; a re-cut never re-captures.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { takeFrames, type Reel } from './reel.ts';
import { PRESETS, parseLook, runtimeLook, buildLut, lutStrip } from '../../core/src/look/look.ts';
import { encodePng } from '../../core/src/look/png.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSCN = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://studio/reel.gd" id="1"]\n\n[node name="Reel" type="Node"]\nscript = ExtResource("1")\n`;

/** The game-side look files for a preset: the record with engine numbers, and its LUT strip. */
export function lookFiles(name: string, dir: string): { record: any; lut: string } {
  if (!PRESETS[name]) throw new Error(`unknown look "${name}" (have: ${Object.keys(PRESETS).join(', ')})`);
  const look = parseLook(structuredClone(PRESETS[name]));
  fs.mkdirSync(dir, { recursive: true });
  const strip = lutStrip(buildLut(look));
  const lut = path.join(dir, 'lut.png');
  fs.writeFileSync(lut, encodePng(strip.rgba, strip.width, strip.height));
  const record = runtimeLook(look);
  fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify(record, null, 2));
  return { record, lut };
}

function encode(frameGlobOrFile: { pattern?: string; file?: string; fps: number; skip?: number }, out: string) {
  const input = frameGlobOrFile.file ? ['-i', frameGlobOrFile.file] : ['-framerate', String(frameGlobOrFile.fps), '-i', frameGlobOrFile.pattern!];
  const skip = frameGlobOrFile.skip ? ['-vf', `select=gte(n\\,${frameGlobOrFile.skip}),setpts=PTS-STARTPTS`] : [];
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, ...skip, '-an', '-r', String(frameGlobOrFile.fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.trim().split('\n').slice(-1)[0]}`);
}

/** Godot movie mode: one Godot run per take (its look applied), written as MJPEG AVI, then encoded. */
export async function captureGodot(reel: Reel, gameDir: string, work: string, only?: string[], log: (s: string) => void = () => {}) {
  fs.copyFileSync(path.join(HERE, '..', 'runtime', 'reel.gd'), path.join(gameDir, 'studio', 'reel.gd'));
  fs.writeFileSync(path.join(gameDir, 'studio', 'reel.tscn'), TSCN);
  // a fresh checkout has no imported assets: the town would load as an empty sky
  if (!fs.existsSync(path.join(gameDir, '.godot', 'imported'))) spawnSync('godot', ['--headless', '--path', gameDir, '--import'], { encoding: 'utf8', timeout: 300000 });
  const out: Record<string, any> = {};
  const WARM = 12;
  for (const take of reel.takes.filter((t) => !only || only.includes(t.id))) {
    const t0 = Date.now();
    const dir = path.join(work, 'capture', take.id);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const look = take.look ? lookFiles(take.look, path.join(work, 'looks', take.look)) : null;
    const spec = { frames: takeFrames(take, reel.fps), warmup: WARM, look };
    const specFile = path.join(dir, 'take.json');
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const avi = path.join(dir, 'take.avi');
    const args = ['--path', gameDir, '--write-movie', avi, '--fixed-fps', String(reel.fps), '--resolution', `${reel.size}x${reel.size}`, '--disable-vsync', 'res://studio/reel.tscn', '--', `--reel=${specFile}`];
    // movie mode writes the viewport's size: a temporary override.cfg sets it (and the window) square
    const lookJson = path.join(gameDir, 'assets', 'studio', 'look', 'look.json');
    const hadLook = fs.existsSync(lookJson) ? fs.readFileSync(lookJson, 'utf8') : null;
    if (look) fs.writeFileSync(lookJson, JSON.stringify(look.record, null, 2) + '\n');
    const override = path.join(gameDir, 'override.cfg');
    const hadOverride = fs.existsSync(override) ? fs.readFileSync(override, 'utf8') : null;
    fs.writeFileSync(override, `${hadOverride ?? ''}\n[display]\nwindow/size/viewport_width=${reel.size}\nwindow/size/viewport_height=${reel.size}\nwindow/size/window_width_override=${Math.round(reel.size / 2)}\nwindow/size/window_height_override=${Math.round(reel.size / 2)}\nwindow/stretch/mode="viewport"\n`);
    const code = await new Promise<number>((res) => { const p = spawn('godot', args, { stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (c) => { if (c !== 0) log(err.slice(-800)); res(c ?? 1); }); });
    if (hadOverride === null) fs.rmSync(override, { force: true }); else fs.writeFileSync(override, hadOverride);
    if (hadLook !== null) fs.writeFileSync(lookJson, hadLook);
    if (code !== 0 || !fs.existsSync(avi)) throw new Error(`godot movie mode failed for take ${take.id} (exit ${code})`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', avi], { encoding: 'utf8' });
    const st = JSON.parse(probe.stdout).streams?.[0] ?? {};
    const mp4 = path.join(work, 'takes', `${take.id}.mp4`);
    fs.mkdirSync(path.dirname(mp4), { recursive: true });
    encode({ file: avi, fps: reel.fps, skip: WARM + 1 }, mp4);
    fs.rmSync(avi, { force: true });
    out[take.id] = { engine: 'godot', mp4, size: [st.width, st.height], aviFrames: Number(st.nb_frames), frames: spec.frames.length, seconds: +((Date.now() - t0) / 1000).toFixed(1), look: take.look };
    if (st.width !== reel.size || st.height !== reel.size) out[take.id].warning = `captured ${st.width}×${st.height}, asked ${reel.size}² (the window was clamped by the screen?)`;
    log(`godot take ${take.id}: ${out[take.id].frames} frames in ${out[take.id].seconds}s`);
  }
  return out;
}

/** The web build at a fixed step: a reel page (the game + the look module) draws one frame per camera
 *  with the game paused, returned as JPEG in batches. Slow on software GL — use small sizes for checks. */
export async function captureWeb(reel: Reel, gameDir: string, work: string, only?: string[], log: (s: string) => void = () => {}, size?: number) {
  const { bundle, serve } = await import('../../game/src/web.ts');
  const { withPage } = await import('../../game/src/chrome.ts');
  const S = size ?? reel.size;
  const stage = path.join(gameDir, '.studio', 'reel');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'entry.ts'), `import '../../src/main.ts';\nimport { applyLook } from '../../studio/look.ts';\n(window as any).__reelApplyLook = applyLook;\n`);
  const b = await bundle(gameDir, '.studio/reel/entry.ts', 'dist/reel.js');
  if (!b.ok) throw new Error(`web build failed: ${b.errors.join('; ')}`);
  const html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8').replace('dist/game.js', 'dist/reel.js');
  const page = path.join(gameDir, 'reel-capture.html');
  fs.writeFileSync(page, html);
  const out: Record<string, any> = {};
  try {
    await serve(gameDir, (url) => withPage(url + 'reel-capture.html', { width: 640, height: 400 }, async (p) => {
      const ready = await p.eval(`Promise.race([window.__studio.ready.then(() => true), new Promise((_, j) => setTimeout(() => j('not ready'), 90000))])`, 120000);
      if (ready !== true) throw new Error(String(ready));
      for (const take of reel.takes.filter((t) => !only || only.includes(t.id))) {
        const t0 = Date.now();
        const dir = path.join(work, 'capture-web', take.id);
        fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
        let lookDir: string | null = null;
        if (take.look) { lookDir = `.studio/reel/look-${take.look}/`; lookFiles(take.look, path.join(gameDir, lookDir)); }
        await p.eval(`(async () => { const g = window.__game; g.paused = true; if (${JSON.stringify(lookDir)}) { g.look?.dispose(); await window.__reelApplyLook(g, undefined, ${JSON.stringify(lookDir)}); } g.renderer.setPixelRatio(1); g.renderer.setSize(${S}, ${S}, false); window.__reelCam = new (g.camera.constructor)(70, 1, 0.1, 3000); return true; })()`, 60000);
        const frames = takeFrames(take, reel.fps);
        for (let i = 0; i < frames.length; i += 12) {
          const batch = frames.slice(i, i + 12);
          const urls: string[] = await p.eval(`(() => { const g = window.__game, c = window.__reelCam, out = []; for (const f of ${JSON.stringify(batch)}) { c.fov = f[6]; c.position.set(f[0], f[1], f[2]); c.lookAt(f[3], f[4], f[5]); c.updateProjectionMatrix(); g.step(1 / ${reel.fps}); g.renderer.render(g.scene, c); out.push(g.renderer.domElement.toDataURL('image/jpeg', 0.92)); } return out; })()`, 300000);
          urls.forEach((u, k) => fs.writeFileSync(path.join(dir, `${String(i + k).padStart(5, '0')}.jpg`), Buffer.from(u.split(',')[1], 'base64')));
        }
        const mp4 = path.join(work, 'takes-web', `${take.id}.mp4`);
        fs.mkdirSync(path.dirname(mp4), { recursive: true });
        encode({ pattern: path.join(dir, '%05d.jpg'), fps: reel.fps }, mp4);
        fs.rmSync(dir, { recursive: true, force: true });
        out[take.id] = { engine: 'web', mp4, size: [S, S], frames: frames.length, seconds: +((Date.now() - t0) / 1000).toFixed(1), look: take.look };
        log(`web take ${take.id}: ${frames.length} frames in ${out[take.id].seconds}s`);
      }
    }));
  } finally { fs.rmSync(page, { force: true }); }
  return out;
}
