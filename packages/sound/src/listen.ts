// "Listening" for an agent that can't hear: loudness numbers (ffmpeg's EBU R128 meter: integrated LUFS,
// loudness range, true peak), a waveform and a spectrogram picture to Read, and a few checks that catch
// what a listener would — clipping, silence gaps, a click at a loop seam, a mix that is all bass.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readWav, seamJump, peak, rms, biquad, type Channels } from './dsp.ts';

export interface Loudness { integratedLufs: number | null; rangeLu: number | null; truePeakDbfs: number | null }
export function ffLoudness(file: string): Loudness {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = (r.stderr ?? '').split('Summary:').pop() ?? '';
  const num = (re: RegExp) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), rangeLu: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/** Waveform + spectrogram stacked in one PNG (log frequency, 20 Hz–20 kHz). */
export function pictures(file: string, out: string, opts: { width?: number; title?: string } = {}): string | null {
  const w = opts.width ?? 1200;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-filter_complex',
    `[0:a]aformat=channel_layouts=mono,showwavespic=s=${w}x160:colors=#3a7bd5:scale=lin[w];` +
    `[0:a]showspectrumpic=s=${w}x420:legend=0:fscale=log:color=magma:scale=log:drange=70:start=30:stop=16000[s];[w][s]vstack=inputs=2`,
    '-frames:v', '1', out], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

/** Share of energy below 200 Hz, 200 Hz–2 kHz and above 2 kHz (a crude "is it all mud" check). */
export function bands(ch: Channels): { low: number; mid: number; high: number } {
  const m = Float32Array.from(ch[0], (v, i) => (ch.length > 1 ? (v + ch[1][i]) / 2 : v));
  const lo = biquad(Float32Array.from(m), 'lowpass', 200), hi = biquad(Float32Array.from(m), 'highpass', 2000);
  const e = (x: Float32Array) => rms(x) ** 2, t = e(m) || 1e-12;
  const L = e(lo) / t, H = e(hi) / t;
  return { low: +L.toFixed(3), mid: +Math.max(0, 1 - L - H).toFixed(3), high: +H.toFixed(3) };
}

/** Longest stretch quieter than -50 dBFS (in seconds), ignoring the first/last 0.25 s. */
export function longestSilence(ch: Channels, sr: number): number {
  const w = Math.round(sr * 0.05), x = ch[0];
  let run = 0, best = 0;
  for (let s = Math.round(sr * 0.25); s + w < x.length - sr * 0.25; s += w) {
    let m = 0; for (let k = 0; k < ch.length; k++) for (let i = s; i < s + w; i++) m = Math.max(m, Math.abs(ch[k][i]));
    if (m < 0.00316) { run += w; best = Math.max(best, run); } else run = 0;
  }
  return +(best / sr).toFixed(2);
}

export function listen(file: string, opts: { loop?: boolean; picture?: string } = {}) {
  const { sr, ch } = readWav(file);
  const p = peak(ch);
  const report: any = {
    file, seconds: +(ch[0].length / sr).toFixed(3), sampleRate: sr, channels: ch.length,
    ...ffLoudness(file), samplePeak: +p.toFixed(3), clipped: p >= 0.999,
    bands: bands(ch), longestSilenceS: longestSilence(ch, sr),
  };
  if (opts.loop) report.seamJump = +seamJump(ch).toFixed(2);       // ≈ ≤ 3: no audible click at the loop point
  const pic = opts.picture ?? file.replace(/\.wav$/, '.png');
  report.picture = pictures(file, pic);
  return report;
}

export function listenMany(files: string[], outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  return files.map((f) => listen(f, { picture: path.join(outDir, path.basename(f).replace(/\.\w+$/, '.png')) }));
}
