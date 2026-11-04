// The face's life while speaking (Decision 23's life layer, first slice): blinks, small eye darts and
// brow lifts on stressed words, so a talking face doesn't stare. Deterministic: the same line and seed
// always give the same blinks. Pure functions; the result rides along with the line (LineClip.life)
// and goes into its exported clip as shape-key curves (blinks, brows) and eye/eyelid bone rotations.
// Week 5 extends this (breathing, head motion, idle between lines) by adding channels here.
import type { LineClip, LineLife } from './types.ts';
import { EMOTION_SCALE } from './lipsync.ts';

/** Small fast seeded generator (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashSeed = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); } return h >>> 0; };

/** Blink timing and shape (seconds). Spontaneous blinks come every 2.4–4.8 s, never closer than `minGap`. */
export const BLINK = { close: 0.07, hold: 0.03, open: 0.13, minGap: 1.1, every: [2.2, 4.2] as [number, number], first: [0.8, 2.6] as [number, number], atPause: 0.85 };
/** Eye darts: a fixation held 0.5–1.6 s, a dart of 1.5–4° (yaw) and up to 1.5° (pitch), most returning to the listener. */
export const GAZE = { hold: [0.5, 1.6] as [number, number], yaw: [1.5, 4] as [number, number], pitch: 1.5, saccade: 0.045, home: 0.6 };

type Line = Pick<LineClip, 'text' | 'duration' | 'fps' | 'cues' | 'emotion' | 'phonemes'>;

/** Pauses inside the line (phrase boundaries): from the phonemes' gaps, or Rhubarb's rests. */
export function phrasePauses(l: Line): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (l.phonemes?.length) {
    for (let i = 0; i + 1 < l.phonemes.length; i++) {
      const a = l.phonemes[i].end, b = l.phonemes[i + 1].start;
      if (b - a >= 0.12) out.push({ start: a, end: b });
    }
  } else {
    for (const c of l.cues) if (c.shape === 'X' && c.start > 0.15 && c.end < l.duration - 0.15 && c.end - c.start >= 0.12) out.push({ start: c.start, end: c.end });
  }
  return out;
}

/** Blinks, eye darts and brow lifts for a line, per frame at the line's fps. */
export function lineLife(l: Line, seed = hashSeed(l.text)): LineLife {
  const fps = l.fps, frames = Math.max(2, Math.ceil(l.duration * fps) + 1);
  const r = rng(seed);
  const between = (a: number, b: number) => a + (b - a) * r();
  // ── blinks: at most pauses (a natural place to blink), plus spontaneous ones ──
  const pauses = phrasePauses(l);
  const wanted: number[] = [];
  if (r() < 0.35) wanted.push(between(0.02, 0.25));                        // often a blink as the line starts
  for (const p of pauses) if (r() < BLINK.atPause) wanted.push(p.start + Math.min(0.08, (p.end - p.start) * 0.3));
  let t = between(...BLINK.first);
  while (t < l.duration - 0.15) { wanted.push(t); t += between(...BLINK.every); }
  const blinks: number[] = [];
  for (const b of wanted.sort((x, y) => x - y)) {
    if (b > l.duration - (BLINK.close + BLINK.hold)) continue;
    if (blinks.length && b - blinks[blinks.length - 1] < BLINK.minGap) {
      // a pause blink wins over a spontaneous one just before it
      if (pauses.some((p) => Math.abs(p.start - b) < 0.12)) blinks[blinks.length - 1] = b;
      continue;
    }
    blinks.push(b);
  }
  const blink = new Array(frames).fill(0);
  const ease = (u: number) => u * u * (3 - 2 * u);
  for (const b of blinks) {
    for (let f = Math.floor(b * fps); f < Math.min(frames, Math.ceil((b + BLINK.close + BLINK.hold + BLINK.open) * fps) + 1); f++) {
      const x = f / fps - b;
      const w = x < 0 ? 0 : x < BLINK.close ? ease(x / BLINK.close) : x < BLINK.close + BLINK.hold ? 1 : Math.max(0, 1 - ease((x - BLINK.close - BLINK.hold) / BLINK.open));
      blink[f] = Math.max(blink[f], w);
    }
  }
  // ── gaze: hold on the listener, dart away briefly, come back (darts often ride a blink) ──
  const yaw = new Array(frames).fill(0), pitch = new Array(frames).fill(0);
  const fix: Array<{ at: number; yaw: number; pitch: number }> = [{ at: 0, yaw: 0, pitch: 0 }];
  t = between(...GAZE.hold);
  let away = false;
  while (t < l.duration) {
    const nearBlink = blinks.find((b) => b > t - 0.25 && b < t + 0.25);
    const at = nearBlink !== undefined ? nearBlink + BLINK.close : t;
    if (!away || r() > GAZE.home) {
      const side = r() < 0.5 ? -1 : 1;
      fix.push({ at, yaw: side * between(...GAZE.yaw), pitch: (r() * 2 - 1) * GAZE.pitch });
      away = true;
    } else { fix.push({ at, yaw: 0, pitch: 0 }); away = false; }
    t = at + between(...GAZE.hold) * (away ? 0.6 : 1);
  }
  for (let f = 0; f < frames; f++) {
    const tt = f / fps;
    let i = 0;
    while (i + 1 < fix.length && fix[i + 1].at <= tt) i++;
    const cur = fix[i], prev = fix[Math.max(0, i - 1)];
    const u = i === 0 ? 1 : ease(Math.min(1, (tt - cur.at) / GAZE.saccade));
    yaw[f] = +(prev.yaw + (cur.yaw - prev.yaw) * u).toFixed(2);
    pitch[f] = +(prev.pitch + (cur.pitch - prev.pitch) * u).toFixed(2);
  }
  // ── brows: a small lift on the main stressed word of each phrase ──
  const brow = new Array(frames).fill(0);
  const lift = 0.32 * Math.min(1.2, EMOTION_SCALE[l.emotion] ?? 1);
  const bounds = [0, ...pauses.map((p) => p.start), l.duration];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [a, b] = [bounds[k], bounds[k + 1]];
    let peak: { start: number; end: number } | undefined;
    if (l.phonemes?.length) {
      const stressed = l.phonemes.filter((p) => p.stress === 1 && p.start >= a && p.end <= b && /[aeiouɑɐʌɒɔɛæɪʊəɚɜ]/.test(p.ph));
      peak = stressed.sort((x, y) => (y.end - y.start) - (x.end - x.start))[0];
    } else {
      peak = l.cues.filter((c) => (c.shape === 'D' || c.shape === 'C') && c.start >= a && c.end <= b).sort((x, y) => (y.end - y.start) - (x.end - x.start))[0];
    }
    if (!peak || r() < 0.25) continue;                                      // not every phrase
    const s0 = peak.start - 0.12, s1 = peak.end + 0.3;
    for (let f = Math.max(0, Math.floor(s0 * fps)); f < Math.min(frames, Math.ceil(s1 * fps)); f++) {
      const x = f / fps;
      const w = x < peak.start ? ease((x - s0) / 0.12) : x <= peak.end ? 1 : 1 - ease((x - peak.end) / 0.3);
      brow[f] = Math.max(brow[f], +(lift * Math.max(0, w)).toFixed(3));
    }
  }
  const round = (a: number[]) => a.map((v) => +v.toFixed(3));
  return { seed, curves: { eyeBlinkLeft: round(blink), eyeBlinkRight: round(blink), browInnerUp: brow }, gaze: { yaw, pitch }, blinks: blinks.map((b) => +b.toFixed(3)) };
}
