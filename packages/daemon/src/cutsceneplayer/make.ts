// Cutscene preview (Decision 24, review): a self-contained folder — the studio scene's GLB, the cutscene
// timeline, the line audio and the three.js player page — plus a storyboard (one frame per shot, with
// its camera, lines and the checks) and, with --video, an MP4 rendered frame by frame in headless Chrome
// and muxed with the voices by ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../game/src/web.ts';
import { STUDIO_ROOT } from '../../../game/src/project.ts';
import { withPage } from '../../../game/src/chrome.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface CutsceneBuild { dir: string; page: string; storyboard?: string; video?: string; frames?: number; seconds?: number; stills?: string[]; note?: string }

export async function buildCutscenePreview(outDir: string, glb: Uint8Array, timeline: any, audio: Record<string, Uint8Array>): Promise<CutsceneBuild> {
  fs.mkdirSync(path.join(outDir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scene.glb'), glb);
  for (const [name, bytes] of Object.entries(audio)) fs.writeFileSync(path.join(outDir, 'audio', name), bytes);
  fs.writeFileSync(path.join(outDir, 'cutscene.json'), JSON.stringify(timeline, null, 2));
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(outDir, 'index.html'));
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({ entryPoints: [path.join(HERE, 'main.ts')], outfile: path.join(outDir, 'player.js'), bundle: true, minify: true, format: 'esm', target: 'es2022', nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent' });
  } catch (e: any) { throw new Error(`could not bundle the cutscene player: ${(e.errors ?? [{ text: e.message }]).map((x: any) => x.text).join('; ')}`); }
  return { dir: outDir, page: path.join(outDir, 'index.html') };
}

/** Mix the line audio at the cue times (ffmpeg adelay + amix) under a video of `total` seconds. */
export function muxAudio(video: string, frameGlob: string, fps: number, total: number, cues: Array<{ t: number; file: string }>, out: string) {
  const inputs = cues.flatMap((c) => ['-i', c.file]);
  const filt = cues.length
    ? cues.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(c.t * 1000)}:all=1[a${i}]`).join(';') + `;${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)}[aout]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[aout]`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', frameGlob, ...inputs, '-filter_complex', filt, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-t', total.toFixed(3), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  void video;
  return out;
}

/** Storyboard page: one frame per shot (shot id, framing, time, lines), then the checks. */
export function writeStoryboard(outDir: string, timeline: any, frames: Record<string, string>, checks: Array<{ label: string; pass: boolean; detail: string }>, extra: { title?: string; video?: string } = {}) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const cards = timeline.shots.map((s: any, i: number) => {
    const lines = timeline.cues.filter((c: any) => c.shot === s.id).map((c: any) => `<li>${c.kind === 'line' ? `<b>${esc(c.name)}</b>: “${esc(c.text ?? '')}”` : `<b>${esc(c.name)}</b> ${esc(c.clip)}`} <span class="t">${c.t.toFixed(1)}–${c.end.toFixed(1)} s</span></li>`).join('');
    return `<article><img src="${esc(frames[s.id] ?? '')}" alt="Shot ${i + 1}: ${esc(s.framing)}"><div class="meta"><h2>${i + 1}. ${esc(s.id)} <span>${esc(s.framing)}</span></h2><p class="t">${s.start.toFixed(1)}–${s.end.toFixed(1)} s · ${(s.end - s.start).toFixed(1)} s</p><ul>${lines || '<li class="t">no lines</li>'}</ul></div></article>`;
  }).join('\n');
  const chk = checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}"><b>${c.pass ? 'Pass' : 'Fail'}</b> ${esc(c.label)}: ${esc(c.detail)}</li>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(extra.title ?? timeline.title ?? timeline.id)} storyboard</title>
<style>:root{--bg:#f4f1ec;--ink:#1c1917;--muted:#6b645c;--line:#ddd6cc;--card:#fffdf9;--ok:#2f6b3a;--bad:#9b2c1f}@media (prefers-color-scheme:dark){:root{--bg:#1b1916;--ink:#f2ede6;--muted:#a39a8f;--line:#3a352f;--card:#24211d;--ok:#8fcf98;--bad:#f0a092}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}article{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}article img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:var(--line)}
.meta{padding:10px 14px 14px}h2{font-size:16px;margin:0}h2 span{font-weight:400;color:var(--muted);font-size:14px;margin-left:6px}.t{color:var(--muted);font-size:13px;margin:2px 0 6px}ul{margin:0;padding-left:18px}
.checks{margin-top:28px;padding:0;list-style:none}.checks li{padding:8px 0;border-top:1px solid var(--line)}.ok b{color:var(--ok)}.bad b{color:var(--bad)}video{width:100%;border-radius:10px;margin-bottom:20px;border:1px solid var(--line)}</style></head>
<body><main><h1>${esc(extra.title ?? timeline.title ?? timeline.id)}</h1><p class="sub">${timeline.shots.length} shots · ${timeline.duration.toFixed(1)} s · keep or undo each shot in the studio's review panel (every set-shot is one step).</p>
${extra.video ? `<video src="${esc(extra.video)}" controls></video>` : ''}<section class="grid">${cards}</section><h2 style="margin-top:28px">Checks</h2><ul class="checks">${chk}</ul></main></body></html>`;
  const file = path.join(outDir, 'storyboard.html');
  fs.writeFileSync(file, html);
  return file;
}

/** Render frames in the preview page; returns per-shot storyboard frames and (with video) the MP4. */
export async function captureCutscene(outDir: string, timeline: any, opts: { video?: boolean; width?: number; height?: number; fps?: number; keepFrames?: boolean } = {}): Promise<{ video?: string; frames: number; seconds: number; boards: Record<string, string>; stills: string[] }> {
  const W = opts.width ?? 1280, H = opts.height ?? 720, fps = opts.fps ?? 30;
  const frameDir = path.join(outDir, 'frames'), boardDir = path.join(outDir, 'storyboard');
  fs.rmSync(frameDir, { recursive: true, force: true }); fs.rmSync(boardDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true }); fs.mkdirSync(boardDir, { recursive: true });
  const total = timeline.duration, n = opts.video ? Math.ceil(total * fps) : 0;
  const boards: Record<string, string> = {};
  await serve(outDir, (url) => withPage(`${url}index.html?capture=1&w=${W}&h=${H}`, { width: W, height: H }, async (page) => {
    for (let i = 0; i < 300; i++) { if (await page.eval('!!window.__ready', 5000).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!(await page.eval('!!window.__ready'))) throw new Error(`cutscene player did not start: ${page.logs.map((l) => l.text).join('; ')}`);
    const shot = async (t: number, file: string) => { const d: string = await page.eval(`window.__frame(${t.toFixed(4)})`); fs.writeFileSync(file, Buffer.from(d.split(',')[1], 'base64')); };
    for (const s of timeline.shots) {
      // the storyboard frame: a moment into the shot where its first line is under way
      const q = timeline.cues.find((c: any) => c.shot === s.id);
      const t = q ? Math.min(s.end - 0.05, q.t + Math.min(1.0, (q.end - q.t) * 0.45)) : s.start + (s.end - s.start) * 0.4;
      const f = path.join(boardDir, `${s.id}.png`);
      await shot(t, f); boards[s.id] = `storyboard/${s.id}.png`;
    }
    for (let f = 0; f < n; f++) await shot(f / fps, path.join(frameDir, `${String(f).padStart(5, '0')}.png`));
  }));
  const stills = Object.values(boards).map((b) => path.join(outDir, b));
  if (!opts.video) { fs.rmSync(frameDir, { recursive: true, force: true }); return { frames: 0, seconds: total, boards, stills }; }
  const cues = timeline.cues.filter((c: any) => c.audio && fs.existsSync(path.join(outDir, 'audio', c.audio))).map((c: any) => ({ t: c.t, file: path.join(outDir, 'audio', c.audio) }));
  const video = muxAudio('', path.join(frameDir, '%05d.png'), fps, total, cues, path.join(outDir, `${timeline.id}.mp4`));
  if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  return { video, frames: n, seconds: total, boards, stills };
}
