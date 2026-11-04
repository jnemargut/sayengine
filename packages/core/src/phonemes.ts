// Phonemes → the 15 speech shapes (Decision 21 A, beyond Rhubarb's 9 mouth shapes). The line's text is
// turned into phonemes locally (eSpeak NG via the `phonemizer` package, run by the daemon; IPA in,
// pure functions here), then aligned to the audio: a segmental dynamic-programming fit of the phoneme
// sequence onto Rhubarb's timed mouth shapes and its silences (which say *when* the mouth does what),
// with each phoneme's typical length as a prior. Rhubarb alone stays the fallback when there's no text.
import type { VISEMES } from './rig.ts';

type Viseme = (typeof VISEMES)[number];
export type VisemeMix = Partial<Record<Viseme, number>>;

export interface PhonemeToken {
  ph: string;            // IPA, e.g. "tʃ", "aɪ" (a diphthong becomes two tokens: "a" then "ɪ")
  mix: VisemeMix;        // the speech shape(s) it makes
  dur: number;           // typical relative length (1 ≈ a short vowel)
  vowel: boolean;
  stress: 0 | 1 | 2;     // primary / secondary stress (vowels of stressed syllables)
  word: number;
  pause?: boolean;       // an optional pause between phrases (may take no time at all)
}

export interface TimedPhoneme { start: number; end: number; ph: string; viseme: Viseme; mix: VisemeMix; stress: 0 | 1 | 2; word: number }

// consonants: [shape mix, typical length]
const CONS: Record<string, [VisemeMix, number]> = {
  p: [{ PP: 1 }, 0.8], b: [{ PP: 1 }, 0.7], m: [{ PP: 1 }, 0.9],
  f: [{ FF: 1 }, 0.95], v: [{ FF: 1 }, 0.75],
  θ: [{ TH: 1 }, 0.9], ð: [{ TH: 1 }, 0.6],
  t: [{ DD: 1 }, 0.7], d: [{ DD: 1 }, 0.65], ɾ: [{ DD: 1 }, 0.4], ʔ: [{ DD: 0.5, sil: 0.5 }, 0.4],
  k: [{ kk: 1 }, 0.75], ɡ: [{ kk: 1 }, 0.7], g: [{ kk: 1 }, 0.7], ŋ: [{ kk: 0.6, nn: 0.4 }, 0.8], x: [{ kk: 1 }, 0.8],
  tʃ: [{ CH: 1 }, 1.0], dʒ: [{ CH: 1 }, 0.95], ʃ: [{ CH: 1 }, 1.0], ʒ: [{ CH: 1 }, 0.9],
  s: [{ SS: 1 }, 1.0], z: [{ SS: 1 }, 0.85],
  n: [{ nn: 1 }, 0.8], l: [{ nn: 1 }, 0.8], ɫ: [{ nn: 1 }, 0.8],
  ɹ: [{ RR: 1 }, 0.7], r: [{ RR: 1 }, 0.7],
  w: [{ ou: 1 }, 0.7], j: [{ ih: 1 }, 0.55], h: [{}, 0.6],   // h takes the next vowel's shape
};
// vowels (single symbols; diphthongs split into two)
const VOW: Record<string, [VisemeMix, number]> = {
  i: [{ ih: 1 }, 0.9], ɪ: [{ ih: 1 }, 0.75], ᵻ: [{ ih: 1 }, 0.6], y: [{ ou: 0.6, ih: 0.4 }, 0.9],
  e: [{ E: 1 }, 0.9], ɛ: [{ E: 1 }, 0.95], æ: [{ aa: 0.6, E: 0.4 }, 1.15],
  a: [{ aa: 1 }, 1.0], ɑ: [{ aa: 1 }, 1.1], ɐ: [{ aa: 0.7, E: 0.3 }, 0.6], ʌ: [{ aa: 0.85, E: 0.15 }, 0.9],
  ɒ: [{ oh: 0.8, aa: 0.2 }, 1.0], ɔ: [{ oh: 1 }, 1.05], o: [{ oh: 1 }, 1.0],
  ʊ: [{ ou: 1 }, 0.8], u: [{ ou: 1 }, 1.0],
  ə: [{ E: 0.4, aa: 0.3, ih: 0.3 }, 0.5], ɚ: [{ RR: 0.7, E: 0.3 }, 0.9], ɝ: [{ RR: 0.7, E: 0.3 }, 1.0], ɜ: [{ RR: 0.5, E: 0.5 }, 1.0],
};
const SKIP = new Set(['ˑ', '̃', '̩', '̯', 'ʰ', '-', "'", '‿']);

/** IPA phrases (eSpeak's output, one string per phrase) → phoneme tokens with optional pauses between phrases. */
export function ipaTokens(phrases: string[]): PhonemeToken[] {
  const out: PhonemeToken[] = [];
  let word = 0;
  const pause = () => out.push({ ph: '_', mix: { sil: 1 }, dur: 0, vowel: false, stress: 0, word, pause: true });
  pause();
  phrases.forEach((phrase) => {
    let stress: 0 | 1 | 2 = 0;
    const chars = [...phrase.normalize('NFC')];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i], n = chars[i + 1];
      if (c === ' ') { word++; stress = 0; continue; }
      if (c === 'ˈ') { stress = 1; continue; }
      if (c === 'ˌ') { stress = 2; continue; }
      if (SKIP.has(c) || /[.,!?;:"]/.test(c)) continue;
      const long = (k: number) => (chars[k] === 'ː' ? 1.35 : 1);
      if ((c === 't' && n === 'ʃ') || (c === 'd' && n === 'ʒ')) { const [mix, dur] = CONS[c + n]; out.push({ ph: c + n, mix, dur, vowel: false, stress: 0, word }); i++; continue; }
      if (VOW[c]) {
        const l = long(i + 1);
        if (l > 1) i++;
        // a diphthong: this vowel then the glide vowel (the second part shorter)
        const glide = chars[i + 1] && VOW[chars[i + 1]] && l === 1 ? chars[i + 1] : null;
        out.push({ ph: c, mix: VOW[c][0], dur: VOW[c][1] * l * (glide ? 0.85 : 1), vowel: true, stress, word });
        if (glide) { out.push({ ph: glide, mix: VOW[glide][0], dur: VOW[glide][1] * 0.6, vowel: true, stress: 0, word }); i++; }
        stress = 0;
        continue;
      }
      if (CONS[c]) { const [mix, dur] = CONS[c]; out.push({ ph: c, mix, dur: dur * long(i + 1), vowel: false, stress: 0, word }); if (n === 'ː') i++; continue; }
      // unknown symbol: a brief neutral mouth rather than a gap
      out.push({ ph: c, mix: { E: 0.3, ih: 0.3 }, dur: 0.5, vowel: false, stress: 0, word });
    }
    word++;
    pause();
  });
  // h: the shape of the vowel after it, softer
  for (let i = 0; i < out.length; i++) if (out[i].ph === 'h') {
    const v = out.slice(i + 1).find((t) => t.vowel);
    out[i].mix = Object.fromEntries(Object.entries(v?.mix ?? { E: 1 }).map(([k, w]) => [k, (w ?? 0) * 0.5])) as VisemeMix;
  }
  return out;
}

/** Which of Rhubarb's mouth shapes agree with a speech shape (used to place phonemes in time). */
const AGREES: Record<string, string> = { PP: 'A', FF: 'G', TH: 'BCH', DD: 'BCH', kk: 'BC', CH: 'BF', SS: 'B', nn: 'BCH', RR: 'BEF', ih: 'BC', E: 'CB', aa: 'DC', oh: 'EFD', ou: 'FE', sil: 'X' };
const OPEN_SHAPES = 'CDEF';
const STOPS = new Set(['p', 'b', 't', 'd', 'k', 'ɡ', 'g', 'tʃ', 'dʒ', 'ʔ']);

const dominant = (mix: VisemeMix): Viseme => (Object.entries(mix).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? 'sil') as Viseme;

/** Cost of a phoneme on one 10 ms frame showing Rhubarb shape `shape` (0 = agrees). */
function frameCost(t: PhonemeToken, shape: string): number {
  if (t.pause) return shape === 'X' ? 0 : 1.6;
  if (shape === 'X') return STOPS.has(t.ph) ? 0.35 : 1.1;
  const v = t.ph === 'h' ? 'E' : dominant(t.mix);
  if ((AGREES[v] ?? '').includes(shape)) return 0;
  if (shape === 'A') return 1.2;                                    // a closure is a closure
  if (v === 'PP' || v === 'FF') return 1.0;
  if (t.vowel && OPEN_SHAPES.includes(shape)) return 0.45;
  return t.vowel ? 0.8 : 0.55;                                      // consonants are short and blurred by any aligner
}

/**
 * Place phonemes in time: the cheapest monotonic split of the line into one segment per phoneme
 * (pauses may be empty), scored by agreement with Rhubarb's shape on each 10 ms frame plus how far
 * each phoneme's length strays from its typical length at this speaking rate.
 */
export function alignPhonemes(tokens: PhonemeToken[], cues: Array<{ start: number; end: number; shape: string }>, duration: number): TimedPhoneme[] {
  const fps = 100, T = Math.max(1, Math.round(duration * fps));
  const shapeAt: string[] = new Array(T).fill('X');
  for (const c of cues) for (let f = Math.max(0, Math.round(c.start * fps)); f < Math.min(T, Math.round(c.end * fps)); f++) shapeAt[f] = c.shape;
  const speech = shapeAt.filter((s) => s !== 'X').length || T;
  const priors = tokens.reduce((s, t) => s + t.dur, 0) || 1;
  const rate = speech / priors;                                     // frames per unit of typical length
  const n = tokens.length;
  // prefix sums of each token's frame cost
  const pre = tokens.map((t) => { const p = new Float64Array(T + 1); for (let f = 0; f < T; f++) p[f + 1] = p[f] + frameCost(t, shapeAt[f]); return p; });
  const INF = 1e18;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(T + 1).fill(INF));
  const back = Array.from({ length: n + 1 }, () => new Int32Array(T + 1).fill(-1));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const t = tokens[i - 1];
    const d = Math.max(2, t.dur * rate);
    const lmin = t.pause ? 0 : Math.max(2, Math.round(0.35 * d)), lmax = t.pause ? T : Math.max(lmin + 2, Math.round(3.2 * d));
    for (let e = 0; e <= T; e++) {
      let best = INF, arg = -1;
      for (let L = lmin; L <= Math.min(lmax, e); L++) {
        const prev = D[i - 1][e - L];
        if (prev >= INF) continue;
        const dp = t.pause ? 0 : 2.2 * Math.log(L / d) ** 2;
        const c = prev + (pre[i - 1][e] - pre[i - 1][e - L]) + dp;
        if (c < best) { best = c; arg = e - L; }
      }
      D[i][e] = best; back[i][e] = arg;
    }
  }
  if (D[n][T] >= INF) return [];                                    // more phonemes than time: give up (Rhubarb fallback)
  const out: TimedPhoneme[] = [];
  let e = T;
  for (let i = n; i >= 1; i--) {
    const s = back[i][e];
    const t = tokens[i - 1];
    if (!t.pause && e > s) out.push({ start: +(s / fps).toFixed(3), end: +(e / fps).toFixed(3), ph: t.ph, viseme: dominant(t.mix), mix: t.mix, stress: t.stress, word: t.word });
    e = s;
  }
  return out.reverse();
}

/** Timed phonemes as speech-shape cues, with the gaps between them as rests. */
export function phonemeVisemeCues(phonemes: Array<{ start: number; end: number; mix: VisemeMix }>, duration: number): Array<{ start: number; end: number; mix: VisemeMix }> {
  const out: Array<{ start: number; end: number; mix: VisemeMix }> = [];
  let t = 0;
  for (const p of phonemes) {
    if (p.start - t > 0.005) out.push({ start: t, end: p.start, mix: { sil: 1 } });
    out.push({ start: p.start, end: p.end, mix: p.mix });
    t = p.end;
  }
  if (duration - t > 0.005) out.push({ start: t, end: duration, mix: { sil: 1 } });
  return out;
}
