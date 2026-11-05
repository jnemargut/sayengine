// The pack, played offline: given sound.json and a trace of what a game did (values over time, events,
// the music's end), mix exactly what the runtimes would play — the same follow curves, smoothing time
// constants, intensity ladder and next-bar stings. Used to make listening samples of real play (a bot's
// session) and to put sound under captured video.
import fs from 'node:fs';
import path from 'node:path';
import { readWav, resample, silence, mixInto, softClip, type Channels } from './dsp.ts';
import type { PackManifest } from './pack.ts';

export interface Trace {
  seconds: number;
  values: Array<{ t: number; name: string; v: number }>;     // value changes, in time order
  events: Array<{ t: number; name: string; pick?: number }>;
  musicStart?: number;                                       // default 0
  musicEnd?: { t: number; sting?: string };
}

const SR = 44100;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function renderTrace(packDir: string, tr: Trace): Channels {
  const m: PackManifest = JSON.parse(fs.readFileSync(path.join(packDir, 'sound.json'), 'utf8'));
  const cache = new Map<string, Channels>();
  const load = (rel: string, loop: boolean) => { if (!cache.has(rel)) { const w = readWav(path.join(packDir, rel)); let c = resample(w.ch, w.sr, SR, loop); if (c.length === 1) c = [c[0], c[0]]; cache.set(rel, c); } return cache.get(rel)!; };
  const n = Math.round(tr.seconds * SR), out = silence(n + SR * 4, 2);
  // a value's smoothed curve at control rate (every 64 samples), like setTargetAtTime(v, t, tc)
  const K = 64, steps = Math.ceil((n + SR * 4) / K);
  const valueCurve = (name: string, tc: number, map: (v: number) => number) => {
    const ch = tr.values.filter((x) => x.name === name);
    const cur = new Float32Array(steps);
    let target = map(m.values[name] ?? 0), y = target, k = 0;
    const a = 1 - Math.exp(-K / (SR * tc));
    for (let s = 0; s < steps; s++) { const t = (s * K) / SR; while (k < ch.length && ch[k].t <= t) target = map(ch[k++].v); y += (target - y) * a; cur[s] = y; }
    return cur;
  };
  // layers: loop, gain and low-pass follow their value (one-pole low-pass per control block is enough here)
  for (const [li, L] of m.layers.entries()) {
    const src = load(L.file, true), len = src[0].length, f = L.follow;
    const g = valueCurve(f?.value ?? '__none', 0.12, (v) => (f?.gain ? lerp(f.gain[0], f.gain[1], clamp01(v)) : 1) * L.gain);
    const lp = f?.lowpass ? valueCurve(f.value, 0.12, (v) => f.lowpass![0] * Math.pow(f.lowpass![1] / f.lowpass![0], clamp01(v))) : null;
    const off = Math.round(((L.id.length * 1.37) % (len / SR)) * SR);
    for (let k = 0; k < 2; k++) {
      let y = 0;
      for (let i = 0; i < n; i++) {
        const s = Math.floor(i / K), x = src[k][(i + off) % len] * g[s];
        if (lp) { const a = 1 - Math.exp(-2 * Math.PI * lp[s] / SR); y += (x - y) * a; out[k][i] += y; } else out[k][i] += x;
      }
    }
    void li;
  }
  // events: the same variation pick and pitch spread as the runtime's generator
  let seed = 1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (const e of tr.events) {
    const E = m.events[e.name]; if (!E) continue;
    const f = E.files[Math.floor(rand() * E.files.length) % E.files.length];
    const rate = E.pitch ? lerp(E.pitch[0], E.pitch[1], rand()) : 1;
    const src = rate === 1 ? load(f, false) : resample(load(f, false), SR, Math.round(SR / rate));
    mixInto(out, src, Math.round(e.t * SR), E.gain);
  }
  // music: stems sample-locked from musicStart; each stem's gain glides to the ladder (tc 0.6 s)
  const mu = m.music;
  if (mu) {
    const t0 = tr.musicStart ?? 0, endAt = tr.musicEnd ? t0 + Math.ceil((tr.musicEnd.t - t0 + 0.05) / mu.barSeconds) * mu.barSeconds : Infinity;
    const L = mu.levels;
    const mixAt = (x: number) => { const s = clamp01(x) * (L.length - 1), i = Math.min(L.length - 2, Math.floor(s)), f = s - i; return (k: string) => lerp(L[i][k] ?? 0, L[i + 1]?.[k] ?? 0, f); };
    for (const [name, rel] of Object.entries(mu.stems)) {
      const src = load(rel, true), len = src[0].length;
      const g = valueCurve(mu.value, 0.6, (v) => mixAt(v)(name));
      const busFade = (i: number) => (i / SR < endAt - 0.05 ? 1 : Math.exp(-(i / SR - (endAt - 0.05)) / 0.12));
      for (let k = 0; k < 2; k++) for (let i = Math.round(t0 * SR); i < Math.min(n, (endAt + 1) * SR); i++) out[k][i] += src[k][(i - Math.round(t0 * SR)) % len] * g[Math.floor(i / K)] * mu.gain * busFade(i);
    }
    if (tr.musicEnd?.sting && mu.stings[tr.musicEnd.sting]) mixInto(out, load(mu.stings[tr.musicEnd.sting], false), Math.round(endAt * SR), mu.gain);
  }
  // keep a tail only when a sting rings past the end
  return softClip(out.map((c) => c.subarray(0, n + (tr.musicEnd?.sting ? SR * 3 : 0)).slice()));
}
