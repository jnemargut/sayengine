// Effect review (Decision 57): what an effect looks like in each engine, measured the same way, and a
// side-by-side card. Frames are compared to a background frame (the effect hidden) at 160×100: the
// effect is every pixel that changed. Particles are random, so engines are compared by statistics —
// how much of the screen the effect covers, its mean colour, and where it sits — not pixel by pixel.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const W = 320, H = 200;   // fine enough that a rain streak survives the downscale
export interface FxStats { frames: number; coverage: number; peakCoverage: number; peakFrame: string; colour: [number, number, number]; centroid: [number, number]; top: number }

function raw(input: string[], glob = false): Buffer | null {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', ...(glob ? ['-pattern_type', 'glob'] : []), '-i', ...input, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:'], { maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : null;
}

/** Statistics of the effect over a folder of frames, against the background frame. */
export function frameStats(frameDir: string, background: string): FxStats | null {
  const files = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /\.(png|jpg)$/.test(f)).sort() : [];
  if (!files.length || !fs.existsSync(background)) return null;
  const bg = raw([background]);
  const all = raw([path.join(frameDir, `*${path.extname(files[0])}`)], true);
  if (!bg || !all) return null;
  const n = Math.floor(all.length / (W * H * 3));
  let cov = 0, peak = 0, peakAt = 0, cr = 0, cg = 0, cb = 0, cx = 0, cy = 0, tot = 0, top = 1, used = 0;
  for (let f = Math.floor(n * 0.15); f < n; f += 2) {   // skip the first moments while emitters fill
    const o = f * W * H * 3;
    let c = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const d = Math.max(Math.abs(all[o + i] - bg[i]), Math.abs(all[o + i + 1] - bg[i + 1]), Math.abs(all[o + i + 2] - bg[i + 2]));
      if (d < 16) continue;
      c++; cr += all[o + i]; cg += all[o + i + 1]; cb += all[o + i + 2]; cx += x; cy += y; tot++;
      top = Math.min(top, y / H);
    }
    cov += c / (W * H); if (c / (W * H) > peak) { peak = c / (W * H); peakAt = f; } used++;
  }
  if (!used) return null;
  const t = Math.max(1, tot);
  return { frames: n, coverage: +(cov / used).toFixed(4), peakCoverage: +peak.toFixed(4), peakFrame: path.join(frameDir, files[Math.min(files.length - 1, peakAt)]), colour: [cr / t / 255, cg / t / 255, cb / t / 255].map((v) => +v.toFixed(3)) as [number, number, number], centroid: [+(cx / t / W).toFixed(3), +(cy / t / H).toFixed(3)], top: +top.toFixed(3) };
}

/** How far apart two engines' renders of one effect are (0 = the same; ≤ 0.25 passes). */
export function parity(a: FxStats, b: FxStats): { score: number; detail: string } {
  const cov = Math.abs(a.coverage - b.coverage) / Math.max(a.coverage, b.coverage, 1e-4);
  const col = Math.hypot(a.colour[0] - b.colour[0], a.colour[1] - b.colour[1], a.colour[2] - b.colour[2]) / Math.sqrt(3);
  const pos = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1]) * 2;
  const score = +Math.max(cov * 0.5, col * 2, pos).toFixed(3);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return { score, detail: `coverage ${pct(a.coverage)} vs ${pct(b.coverage)} of the screen (${(cov * 100).toFixed(0)}% apart), colour ${(col * 100).toFixed(0)}% apart, centre ${(pos * 50).toFixed(1)}% of the screen apart → ${score <= 0.25 ? 'match' : 'differ'} (${score})` };
}

/** The review card: two videos side by side (left/right labels in the file name; ffmpeg's drawtext is
 *  used when this ffmpeg has it), plus a still pair as PNG. */
export function sideBySide(left: { video: string; still: string; label: string }, right: { video: string; still: string; label: string }, out: string): { video: string | null; card: string | null; note?: string } {
  const lab = (l: string, x: string) => `drawtext=text='${l}':x=${x}:y=16:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`;
  const tryRun = (args: string[]) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  const vf = (withText: boolean) => `[0:v]scale=800:-2[a];[1:v]scale=800:-2[b];[a][b]hstack=inputs=2${withText ? `,${lab(left.label, '20')},${lab(right.label, 'w/2+20')}` : ''}`;
  const video = `${out}.mp4`, card = `${out}.png`;
  let r = tryRun(['-i', left.video, '-i', right.video, '-filter_complex', vf(true), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video]);
  let note: string | undefined;
  if (r.status !== 0) { r = tryRun(['-i', left.video, '-i', right.video, '-filter_complex', vf(false), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video]); note = `no drawtext in this ffmpeg: ${left.label} is on the left, ${right.label} on the right`; }
  const ok = r.status === 0;
  let c = tryRun(['-i', left.still, '-i', right.still, '-filter_complex', vf(true), '-frames:v', '1', card]);
  if (c.status !== 0) c = tryRun(['-i', left.still, '-i', right.still, '-filter_complex', vf(false), '-frames:v', '1', card]);
  return { video: ok ? video : null, card: c.status === 0 ? card : null, ...(note ? { note } : {}) };
}
