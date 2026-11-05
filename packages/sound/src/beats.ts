// The beat tool's Node side: runs beats.py (librosa) in ~/.studio-tools/venv and returns the grid.
// Also a beat-cut loop: N bars from a recording with a beat, starting on a downbeat, the tail folded in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav, foldLoop, secs, type Channels } from './dsp.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export interface BeatGrid { bpm: number; beats: number[]; downbeats: number[]; downbeatPhase: number; onsets: number[]; duration: number; tool: string }

export function venvPython(): string | null {
  const p = process.env.STUDIO_VENV_PYTHON ?? path.join(os.homedir(), '.studio-tools', 'venv', 'bin', 'python');
  return fs.existsSync(p) ? p : null;
}

export function detectBeats(file: string, bpmHint?: number): BeatGrid {
  const py = venvPython();
  if (!py) throw Object.assign(new Error('no ~/.studio-tools/venv'), { hint: 'python3 -m venv ~/.studio-tools/venv && ~/.studio-tools/venv/bin/pip install librosa soundfile' });
  const r = spawnSync(py, ['-I', path.join(HERE, 'beats.py'), file, ...(bpmHint ? ['--bpm-hint', String(bpmHint)] : [])], { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) {
    const missing = /No module named '?librosa/.test(r.stderr ?? '');
    throw Object.assign(new Error(missing ? 'librosa is not installed in ~/.studio-tools/venv' : `beat detection failed: ${(r.stderr ?? '').trim().split('\n').slice(-1)[0]}`), { hint: '~/.studio-tools/venv/bin/pip install librosa soundfile' });
  }
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

/** How well a detected grid matches a known one: tempo error and the median beat offset (s). */
export function gridError(found: BeatGrid, bpm: number, firstBeat = 0) {
  const period = 60 / bpm;
  const offs = found.beats.map((t) => { const k = (t - firstBeat) / period; return Math.abs(k - Math.round(k)) * period; }).sort((a, b) => a - b);
  // librosa may lock onto half or double time; both still put cuts on beats
  const ratio = found.bpm / bpm, octave = [0.5, 1, 2].reduce((a, b) => (Math.abs(ratio - b) < Math.abs(ratio - a) ? b : a));
  return { bpmError: +Math.abs(found.bpm - bpm * octave).toFixed(2), octave, medianOffsetS: +(offs[Math.floor(offs.length / 2)] ?? 1).toFixed(4) };
}

/** A loop of `bars` bars cut on the beat grid from a recording (tail folded into the start). */
export function beatCutLoop(file: string, bars: number, grid?: BeatGrid): { audio: Channels; startS: number; seconds: number; bpm: number } {
  const g = grid ?? detectBeats(file);
  const { sr, ch } = readWav(file);
  const start = g.downbeats.find((t) => t > 0.05) ?? g.beats[0] ?? 0;
  const len = Math.round(bars * 4 * (60 / g.bpm) * sr), s0 = Math.round(start * sr);
  if (s0 + len > ch[0].length) throw new Error(`${path.basename(file)} is shorter than ${bars} bars from its first downbeat`);
  const tail = Math.min(secs(1, sr), ch[0].length - s0 - len);
  return { audio: foldLoop(ch.map((c) => c.slice(s0, s0 + len + tail)), len), startS: start, seconds: +(len / sr).toFixed(4), bpm: g.bpm };
}
