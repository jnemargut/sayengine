// Motion preview (Decision 16 review): a self-contained folder with the exported character and a
// three.js page that plays each motion over a checker floor at its own speed; optionally an MP4 of
// all of them, rendered frame by frame in headless Chrome, plus stills at telling moments.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../game/src/web.ts';
import { STUDIO_ROOT } from '../../../game/src/project.ts';
import { withPage } from '../../../game/src/chrome.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface PreviewMotion { id: string; kind: string; label: string; duration: number; loop: boolean; speed: number; show: number }
export interface MotionPreviewResult { dir: string; page: string; video?: string; frames?: number; seconds?: number; stills?: string[]; note?: string }

/** How long each motion plays in the video: two cycles of a loop (at least 2.5 s), a one-off once plus a beat. */
export const showTime = (m: { duration: number; loop: boolean }) => (m.loop ? Math.max(2.5, Math.min(8, m.duration * 2)) : m.duration + 0.5);

export async function buildMotionPreview(outDir: string, name: string, glb: Uint8Array, motions: PreviewMotion[]): Promise<MotionPreviewResult> {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'character.glb'), glb);
  fs.writeFileSync(path.join(outDir, 'motions.json'), JSON.stringify({ name, glb: 'character.glb', motions }, null, 2));
  const html = fs.readFileSync(path.join(HERE, '..', 'lineplayer', 'index.html'), 'utf8')
    .replace('<title>Line preview</title>', '<title>Motion preview</title>')
    .replace('Line preview</h1>', 'Motion preview</h1>')
    .replace(/<p class="sub">[^<]*<\/p>/, '<p class="sub">Click a motion to play it. Walks and runs travel at their own speed over half-metre squares, so a sliding foot would show.</p>')
    .replace('<div id="lines"></div>', '<div id="motions" style="display:grid;gap:8px;margin-top:16px"></div>')
    .replace("fetch('lines.json')", "fetch('motions.json')").replace('`${c.name}: lines`', '`${c.name}: motions`').replace('`${c.name} lines`', '`${c.name} motions`')
    .replace('.capture #lines', '.capture #motions');
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({ entryPoints: [path.join(HERE, 'main.ts')], outfile: path.join(outDir, 'player.js'), bundle: true, minify: true, format: 'esm', target: 'es2022', nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent' });
  } catch (e: any) { throw new Error(`could not bundle the motion player: ${(e.errors ?? [{ text: e.message }]).map((x: any) => x.text).join('; ')}`); }
  return { dir: outDir, page: path.join(outDir, 'index.html') };
}

export async function captureMotionVideo(outDir: string, motions: PreviewMotion[], opts: { width?: number; height?: number; fps?: number; keepFrames?: boolean } = {}): Promise<MotionPreviewResult> {
  const W = opts.width ?? 1280, H = opts.height ?? 720, fps = opts.fps ?? 30;
  const frameDir = path.join(outDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const segs: Array<{ id: string; start: number; end: number }> = [];
  let t = 0;
  for (const m of motions) { segs.push({ id: m.id, start: t, end: t + m.show }); t += m.show; }
  const total = t, n = Math.ceil(total * fps);
  await serve(outDir, (url) => withPage(`${url}index.html?capture=1&w=${W}&h=${H}`, { width: W, height: H }, async (page) => {
    for (let i = 0; i < 300; i++) { if (await page.eval('!!window.__ready', 5000).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!(await page.eval('!!window.__ready'))) throw new Error(`motion player did not start: ${page.logs.map((l) => l.text).join('; ')}`);
    for (let f = 0; f < n; f++) {
      const tt = f / fps;
      const s = segs.find((x) => tt >= x.start && tt < x.end) ?? segs[segs.length - 1];
      const url64: string = await page.eval(`window.__frame(${JSON.stringify(s.id)}, ${(tt - s.start).toFixed(4)})`);
      fs.writeFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), Buffer.from(url64.split(',')[1], 'base64'));
    }
  }));
  // stills: a quarter and three quarters of the way through each motion
  const stillDir = path.join(outDir, 'stills');
  fs.rmSync(stillDir, { recursive: true, force: true });
  fs.mkdirSync(stillDir, { recursive: true });
  const stills: string[] = [];
  for (const s of segs) for (const [k, u] of [['a', 0.25], ['b', 0.6]] as const) {
    const f = Math.min(n - 1, Math.round((s.start + (s.end - s.start) * u) * fps));
    const dst = path.join(stillDir, `${s.id}-${k}.png`);
    fs.copyFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), dst);
    stills.push(dst);
  }
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) return { dir: outDir, page: path.join(outDir, 'index.html'), frames: n, seconds: total, stills, note: 'ffmpeg not found: frames are in frames/' };
  const video = path.join(outDir, 'motions.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  return { dir: outDir, page: path.join(outDir, 'index.html'), video, frames: n, seconds: +total.toFixed(2), stills };
}
