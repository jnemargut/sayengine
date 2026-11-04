// Lip sync (Decision 21 A): aligner cues (Rhubarb's mouth shapes A–H, X) → curves for the 15
// speech shapes, smoothed so neighbouring sounds overlap (coarticulation: each shape rises before
// its sound and decays after it), lips always fully close on M/B/P, and the line's emotion scales
// how wide the mouth opens. Pure functions: DOM-free and Node-free (the daemon runs the aligner).
import type { CheckResult } from './checks.ts';
import type { LineClip } from './types.ts';
import { VISEMES } from './rig.ts';

/** Rhubarb mouth shapes (Preston Blair) → mixes of the 15 speech shapes. */
export const RHUBARB_TO_VISEMES: Record<string, Partial<Record<(typeof VISEMES)[number], number>>> = {
  A: { PP: 1 },                       // closed: M, B, P
  B: { SS: 0.55, ih: 0.45 },          // slightly open, clenched teeth: K, S, T, EE
  C: { E: 0.8, DD: 0.2 },             // open: EH, AE
  D: { aa: 1 },                       // wide open: AA
  E: { oh: 0.85, RR: 0.15 },          // slightly rounded: AO, ER
  F: { ou: 0.9, CH: 0.1 },            // puckered: UW, OW, W
  G: { FF: 1 },                       // F, V: teeth on the lower lip
  H: { DD: 0.5, nn: 0.5 },            // L: tongue up, mouth a little open
  X: { sil: 1 },                      // rest
};

/** How strongly each emotion opens the mouth. */
export const EMOTION_SCALE: Record<string, number> = { neutral: 1, calm: 0.9, gentle: 0.85, firm: 1.05, happy: 1.1, excited: 1.2, angry: 1.15, sad: 0.8, scared: 0.95, whisper: 0.6 };
const OPEN = new Set(['TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou']);

export interface Cue { start: number; end: number; shape: string }

/**
 * Aligners sometimes stretch an open mouth across a pause (e.g. a comma). Where the audio is silent
 * for at least `minGap` seconds inside an open shape, the mouth rests there instead. `energy` is the
 * loudness envelope (0..1) at `energyFps`.
 */
export function restInSilence(cues: Cue[], energy: number[], energyFps: number, minGap = 0.14, quiet = 0.06): Cue[] {
  const silent = (t: number) => (energy[Math.round(t * energyFps)] ?? 0) < quiet;
  const out: Cue[] = [];
  const step = 1 / energyFps, lead = 0.04;
  for (const c of cues) {
    if (c.shape === 'X' || c.shape === 'A') { out.push(c); continue; }
    let cur = c.start;
    let t = c.start;
    while (t < c.end) {
      if (!silent(t)) { t += step; continue; }
      let e = t;
      while (e < c.end && silent(e)) e += step;
      const r0 = Math.max(cur, t + lead), r1 = Math.min(c.end, e - lead);
      if (e - t >= minGap && r1 - r0 > 0.05) {
        if (r0 - cur > 1e-3) out.push({ start: +cur.toFixed(3), end: +r0.toFixed(3), shape: c.shape });
        out.push({ start: +r0.toFixed(3), end: +r1.toFixed(3), shape: 'X' });
        cur = r1;
      }
      t = e + step;
    }
    if (c.end - cur > 1e-3) out.push({ start: +cur.toFixed(3), end: c.end, shape: c.shape });
  }
  return out;
}

/** Smoothed speech-shape curves (0..1 per frame) from aligner cues. */
export function curvesFromCues(cues: Cue[], duration: number, fps = 30, emotion = 'neutral'): Record<string, number[]> {
  const frames = Math.max(2, Math.ceil(duration * fps) + 1);
  const curves: Record<string, number[]> = Object.fromEntries(VISEMES.map((v) => [v, new Array(frames).fill(0)]));
  const attack = 0.07, decay = 0.08;
  const env = (t: number, s: number, e: number) => {
    const rise = Math.min(0.05, (e - s) * 0.4);
    if (t < s - attack || t > e + decay) return 0;
    if (t < s + rise) { const u = (t - (s - attack)) / (attack + rise); return u * u * (3 - 2 * u); }
    if (t <= e) return 1;
    const u = 1 - (t - e) / decay; return u * u * (3 - 2 * u);
  };
  const scale = EMOTION_SCALE[emotion] ?? 1;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const acc: Record<string, number> = {};
    let total = 0;
    for (const c of cues) {
      const a = env(t, c.start, c.end);
      if (!a) continue;
      total += a;
      for (const [k, w] of Object.entries(RHUBARB_TO_VISEMES[c.shape] ?? { sil: 1 })) acc[k] = (acc[k] ?? 0) + a * (w ?? 0);
    }
    const norm = Math.max(1, total);
    for (const [k, v] of Object.entries(acc)) curves[k][f] = Math.min(1, (v / norm) * (OPEN.has(k) ? scale : 1));
  }
  // M / B / P: lips fully closed for the whole sound (at least 60 ms), the open shapes suppressed
  for (const c of cues) {
    if (c.shape !== 'A') continue;
    const mid = (c.start + c.end) / 2, half = Math.max(0.03, (c.end - c.start) / 2);
    for (let f = Math.max(0, Math.floor((mid - half) * fps)); f <= Math.min(frames - 1, Math.ceil((mid + half) * fps)); f++) {
      curves.PP[f] = 1;
      for (const k of OPEN) curves[k][f] *= 0.12;
      curves.sil[f] = 0;
    }
  }
  for (const k of VISEMES) curves[k] = curves[k].map((v) => +v.toFixed(3));
  return curves;
}

/** How open the mouth is per frame (jaw-weighted sum of the open shapes). */
export function openness(curves: Record<string, number[]>): number[] {
  const jaw: Record<string, number> = { TH: 0.24, DD: 0.3, kk: 0.4, CH: 0.26, SS: 0.1, nn: 0.2, RR: 0.26, aa: 1, E: 0.55, ih: 0.35, oh: 0.65, ou: 0.3, FF: 0.12 };
  const n = curves.sil?.length ?? 0;
  return Array.from({ length: n }, (_, f) => Object.entries(jaw).reduce((s, [k, w]) => s + (curves[k]?.[f] ?? 0) * w, 0));
}

/** Delay (ms) that best lines the mouth's speaking spans up with the voiced spans of the audio (positive = mouth late). */
export function syncOffset(curves: Record<string, number[]>, fps: number, energy: number[], energyFps: number, maxMs = 300): number {
  // speaking vs resting (any shape but rest) against voiced vs quiet audio: robust for lines heavy
  // in consonants, where how open the mouth is and how loud the voice is do not track each other
  const open = (curves.sil ?? []).map((v) => 1 - v);
  const voiced = energy.map((v) => (v > 0.06 ? 1 : 0));
  energy = voiced;
  const at = (arr: number[], rate: number, t: number) => { const i = t * rate; const a = Math.floor(i); return a < 0 || a + 1 >= arr.length ? 0 : arr[a] + (arr[a + 1] - arr[a]) * (i - a); };
  const dur = open.length / fps;
  // Pearson correlation of mouth openness (shifted) against loudness: the shift that fits best
  const T = Array.from({ length: Math.floor(dur * 100) }, (_, i) => i / 100);
  const E = T.map((t) => at(energy, energyFps, t));
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let s = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return s / Math.sqrt(va * vb || 1);
  };
  let best = 0, bestScore = -Infinity;
  for (let ms = -maxMs; ms <= maxMs; ms += 10) {
    const sc = corr(T.map((t) => at(open, fps, t + ms / 1000)), E);
    if (sc > bestScore + 1e-9 || (Math.abs(sc - bestScore) <= 1e-9 && Math.abs(ms) < Math.abs(best))) { bestScore = sc; best = ms; }
  }
  return best;
}

/** Checks for a recorded line: lips close on M/B/P, nothing held unnaturally long, mouth in sync with the audio. */
export function lineChecks(id: string, l: LineClip): CheckResult[] {
  const out: CheckResult[] = [];
  const fps = l.fps;
  const closures = l.cues.filter((c) => c.shape === 'A');
  const missed = closures.filter((c) => {
    const a = Math.floor(c.start * fps), b = Math.max(a, Math.ceil(c.end * fps));
    return Math.max(...(l.curves.PP ?? []).slice(a, b + 1), 0) < 0.85;
  });
  out.push({
    id: `line-${id}-closures`, label: `"${id}": lips close on M/B/P`, pass: !missed.length,
    detail: closures.length ? (missed.length ? `${missed.length} of ${closures.length} closures don't fully close (at ${missed.map((c) => c.start.toFixed(2) + ' s').join(', ')})` : `${closures.length} closure${closures.length === 1 ? '' : 's'}, all fully closed`) : 'no M/B/P sounds in this line',
  });
  // the mouth shouldn't hold one open shape for long (reads as a frozen face)
  let worst = 0, worstAt = 0;
  const open = [...(Object.keys(l.curves).filter((k) => k !== 'sil' && k !== 'PP'))];
  const n = l.curves.sil?.length ?? 0;
  for (const k of open) {
    let run = 0;
    for (let f = 0; f < n; f++) {
      run = (l.curves[k][f] ?? 0) > 0.6 ? run + 1 : 0;
      if (run > worst) { worst = run; worstAt = f; }
    }
  }
  const held = worst / fps;
  out.push({ id: `line-${id}-held`, label: `"${id}": no shape held too long`, pass: held <= 0.7, detail: held <= 0.7 ? `longest held shape ${held.toFixed(2)} s` : `one shape is held for ${held.toFixed(2)} s around ${(worstAt / fps).toFixed(2)} s — the aligner missed a change; re-run with the script, or check the audio` });
  if (l.sync !== undefined) out.push({ id: `line-${id}-sync`, label: `"${id}": mouth in sync with the voice`, pass: Math.abs(l.sync) <= 90, detail: `${l.sync >= 0 ? 'mouth trails' : 'mouth leads'} the voice by ${Math.abs(l.sync)} ms (≤ 90 ms reads as in sync)` });
  return out;
}
