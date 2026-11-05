// The final edit as an ffmpeg recipe (Decision 32): one filter graph per shape — trim each shot from its
// take, crop that shape's box, scale, concatenate, lay the title cards and captions over their shots,
// fade in and out, and put the music under it. The recipe is written as files (a filter script and a
// shell script) and then run, so a re-cut is "edit the reel file, re-run the recipe": no re-capture.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cropBox, OUTPUT, type Aspect, type Cut, type Reel } from './reel.ts';

export interface RecipeInputs { takes: Record<string, string>; music: string; cards: Record<string, string> }

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const f3 = (n: number) => n.toFixed(3);

/** Build the ffmpeg arguments and filter graph for one shape. */
export function buildRecipe(reel: Reel, cut: Cut, aspect: Aspect, inputs: RecipeInputs, out: string): { args: string[]; filter: string; overlays: Array<{ card: string; from: number; to: number }> } {
  const [W, H] = OUTPUT[aspect];
  const fps = reel.fps;
  const takeIds = [...new Set([...cut.shots.map((s) => s.take), ...(cut.endCard ? [cut.shots[cut.shots.length - 1].take] : [])])];
  const args: string[] = ['-y', '-loglevel', 'error'];
  const idx: Record<string, number> = {};
  for (const t of takeIds) { idx[t] = Object.keys(idx).length; args.push('-i', inputs.takes[t]); }
  const musicIdx = takeIds.length; args.push('-i', inputs.music);
  // cards: which overlay shows when (titles over their shot, captions a beat in, the end card at the end)
  const overlays: Array<{ card: string; from: number; to: number }> = [];
  for (const s of cut.shots) {
    if (s.title) overlays.push({ card: `title-${s.index}`, from: s.start + (s.index === 1 ? 0.35 : 0.08), to: s.end - 0.05 });
    if (s.caption) overlays.push({ card: `caption-${s.index}`, from: s.start + 0.25, to: s.end - 0.1 });
  }
  if (cut.endCard) overlays.push({ card: 'end', from: cut.endCard.start + 0.15, to: cut.duration });
  const cardIdx: Record<string, number> = {};
  for (const o of overlays) { cardIdx[o.card] = musicIdx + 1 + Object.keys(cardIdx).length; args.push('-loop', '1', '-framerate', String(fps), '-t', f3(cut.duration), '-i', inputs.cards[o.card]); }
  const parts: string[] = [];
  const segs: string[] = [];
  const shotChain = (take: string, from: number, to: number, label: string, extra = '') => {
    const b = cropBox(reel, take, aspect);
    // tpad holds the take's last frame if a re-cut asks for more than was captured (the cut reports it)
    parts.push(`[${idx[take]}:v]tpad=stop_mode=clone:stop_duration=4,trim=start=${f3(from)}:end=${f3(to)},setpts=PTS-STARTPTS,crop=${b.w}:${b.h}:${b.x}:${b.y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=${fps}${extra}[${label}]`);
    segs.push(`[${label}]`);
  };
  for (const s of cut.shots) shotChain(s.take, s.in, s.out, `v${s.index}`);
  if (cut.endCard) { const last = cut.shots[cut.shots.length - 1]; shotChain(last.take, last.out, last.out + (cut.endCard.end - cut.endCard.start), 'vend', ',eq=brightness=-0.12:saturation=0.75,gblur=sigma=3'); }
  parts.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=0[base]`);
  let cur = 'base';
  overlays.forEach((o, k) => {
    const i = cardIdx[o.card], fadeIn = 0.25, fadeOut = Math.min(0.3, (o.to - o.from) / 3);
    parts.push(`[${i}:v]format=rgba,fade=t=in:st=${f3(o.from)}:d=${fadeIn}:alpha=1,fade=t=out:st=${f3(o.to - fadeOut)}:d=${f3(fadeOut)}:alpha=1[c${k}]`);
    parts.push(`[${cur}][c${k}]overlay=0:0:enable='between(t,${f3(o.from)},${f3(o.to)})'[o${k}]`);
    cur = `o${k}`;
  });
  parts.push(`[${cur}]fade=t=in:st=0:d=0.4,fade=t=out:st=${f3(cut.duration - 0.6)}:d=0.6,format=yuv420p[vout]`);
  parts.push(`[${musicIdx}:a]atrim=0:${f3(cut.duration)},asetpts=PTS-STARTPTS,afade=t=out:st=${f3(cut.duration - 1.2)}:d=1.2[aout]`);
  const filter = parts.join(';\n');
  args.push('-/filter_complex', '__FILTER__', '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f3(cut.duration), out);
  return { args, filter, overlays };
}

/** Write the recipe (filter script + a runnable shell script) for a shape, then run it. */
export function runRecipe(reel: Reel, cut: Cut, aspect: Aspect, inputs: RecipeInputs, dir: string, out: string) {
  const tag = aspect.replace(':', 'x');
  const r = buildRecipe(reel, cut, aspect, inputs, out);
  const filterFile = path.join(dir, `filter-${tag}.txt`), sh = path.join(dir, `recipe-${tag}.sh`);
  fs.writeFileSync(filterFile, r.filter + '\n');
  const args = r.args.map((a) => (a === '__FILTER__' ? filterFile : a));
  fs.writeFileSync(sh, `#!/bin/sh\n# ${reel.title} — ${aspect}. Written by \`studio reel cut\`; re-running it needs no capture.\nset -e\nffmpeg ${args.map(q).join(' \\\n  ')}\n`);
  fs.chmodSync(sh, 0o755);
  const t0 = Date.now();
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 900000 });
  if (res.status !== 0) throw new Error(`ffmpeg (${aspect}): ${(res.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
  return { aspect, video: out, recipe: sh, filter: filterFile, seconds: +((Date.now() - t0) / 1000).toFixed(1), overlays: r.overlays.length };
}
