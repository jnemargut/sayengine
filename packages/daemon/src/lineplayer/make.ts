// Line preview (Decision 21, review): a self-contained folder with the exported character, its
// line audio and a three.js player page; optionally an MP4 of every line in close-up, rendered
// frame by frame in headless Chrome from the same page and muxed with the audio by ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../game/src/web.ts';
import { STUDIO_ROOT } from '../../../game/src/project.ts';
import { withPage } from '../../../game/src/chrome.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface PreviewLine { id: string; text: string; emotion: string; duration: number; wav: Uint8Array; cues?: Array<{ start: number; end: number; shape: string }> }
export interface PreviewResult { dir: string; page: string; video?: string; frames?: number; seconds?: number; stills?: string[]; note?: string }

/** Gap of rest face before, between and after lines in the video (seconds). */
const GAP = 0.6;

export async function buildLinePreview(outDir: string, name: string, glb: Uint8Array, lines: PreviewLine[]): Promise<PreviewResult> {
  fs.mkdirSync(path.join(outDir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'character.glb'), glb);
  for (const l of lines) fs.writeFileSync(path.join(outDir, 'audio', `${l.id}.wav`), l.wav);
  const cfg = { name, glb: 'character.glb', lines: lines.map((l) => ({ id: l.id, text: l.text, audio: `audio/${l.id}.wav`, duration: l.duration, emotion: l.emotion })) };
  fs.writeFileSync(path.join(outDir, 'lines.json'), JSON.stringify(cfg, null, 2));
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(outDir, 'index.html'));
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({ entryPoints: [path.join(HERE, 'main.ts')], outfile: path.join(outDir, 'player.js'), bundle: true, minify: true, format: 'esm', target: 'es2022', nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent' });
  } catch (e: any) { throw new Error(`could not bundle the line player: ${(e.errors ?? [{ text: e.message }]).map((x: any) => x.text).join('; ')}`); }
  return { dir: outDir, page: path.join(outDir, 'index.html') };
}

/** Timeline of the video: rest face, line, rest face, line … */
export function videoTimeline(lines: Array<{ id: string; duration: number }>, gap = GAP) {
  const segs: Array<{ id: string; start: number; end: number }> = [];
  let t = gap;
  for (const l of lines) { segs.push({ id: l.id, start: t, end: t + l.duration }); t += l.duration + gap; }
  return { segs, total: t };
}

/** Render every frame of every line in the player page (headless Chrome) and mux with the audio. */
export async function captureVideo(outDir: string, lines: PreviewLine[], opts: { width?: number; height?: number; fps?: number; keepFrames?: boolean } = {}): Promise<PreviewResult> {
  const W = opts.width ?? 1280, H = opts.height ?? 720, fps = opts.fps ?? 30;
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  const frameDir = path.join(outDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const { segs, total } = videoTimeline(lines);
  const n = Math.ceil(total * fps);
  await serve(outDir, (url) => withPage(`${url}index.html?capture=1&w=${W}&h=${H}`, { width: W, height: H }, async (page) => {
    for (let i = 0; i < 300; i++) { if (await page.eval('!!window.__ready', 5000).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!(await page.eval('!!window.__ready'))) throw new Error(`line player did not start: ${page.logs.map((l) => l.text).join('; ')}`);
    for (let f = 0; f < n; f++) {
      const t = f / fps;
      const s = segs.find((x) => t >= x.start && t < x.end);
      const url64: string = await page.eval(`window.__frame(${JSON.stringify(s?.id ?? null)}, ${s ? (t - s.start).toFixed(4) : 0})`);
      fs.writeFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), Buffer.from(url64.split(',')[1], 'base64'));
    }
  }));
  if (ff.status !== 0) return { dir: outDir, page: path.join(outDir, 'index.html'), frames: n, seconds: total, note: 'ffmpeg not found: frames are in frames/, open index.html to play the lines with audio' };
  // audio: each line's WAV delayed to its start, mixed into one track
  const inputs = segs.flatMap((s) => ['-i', path.join(outDir, 'audio', `${s.id}.wav`)]);
  const filt = segs.map((s, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(s.start * 1000)}:all=1[a${i}]`).join(';') + `;${segs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${segs.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)}[aout]`;
  const video = path.join(outDir, 'lines.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), ...inputs, '-filter_complex', filt, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-t', total.toFixed(3), video], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  // stills to look at: per line, the rest face, a lip closure (M/B/P) and the widest vowel
  const stillDir = path.join(outDir, 'stills');
  fs.rmSync(stillDir, { recursive: true, force: true });
  fs.mkdirSync(stillDir, { recursive: true });
  const stills: string[] = [];
  const keep = (t: number, label: string) => {
    const f = Math.min(n - 1, Math.max(0, Math.round(t * fps)));
    const dst = path.join(stillDir, `${label}.png`);
    fs.copyFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), dst);
    stills.push(dst);
  };
  keep(segs[0].start * 0.5, '00-rest');
  segs.forEach((s, i) => {
    const cues = lines[i].cues ?? [];
    const closure = cues.find((c) => c.shape === 'A');
    const open = cues.filter((c) => c.shape === 'D' || c.shape === 'C').sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (closure) keep(s.start + (closure.start + closure.end) / 2, `${i + 1}-${s.id}-closed`);
    if (open) keep(s.start + (open.start + open.end) / 2, `${i + 1}-${s.id}-open`);
  });
  if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  return { dir: outDir, page: path.join(outDir, 'index.html'), video, frames: n, seconds: +total.toFixed(2), stills };
}
