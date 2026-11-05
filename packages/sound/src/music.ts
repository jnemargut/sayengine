// Seeded stems (Decision 33's music layer). A seed picks a key, a progression, grooves and a melody;
// six stems (pad, arp, bass, hats, beat, lead) are rendered as loops exactly N bars long (each stem's
// tail is folded back onto its start, so the loop is cut on the bar and never clicks). Games layer
// the stems by intensity (Godot's AudioStreamSynchronized inside an AudioStreamInteractive, or the web
// runtime); a trailer gets an arranged song with a riser into the drop and a hit on the end card.
import { SR, type Channels, type Rng, rng, seedOf, biquad, whiteNoise, reverb, mixInto, foldLoop, softClip, secs, midiHz, silence, scale } from './dsp.ts';

export const STEMS = ['pad', 'arp', 'bass', 'hats', 'beat', 'lead'] as const;
export type Stem = typeof STEMS[number];
export type Mix = Partial<Record<Stem, number>>;
/** The default intensity ladder: 0 calm … 3 full. Games blend between neighbours. */
export const LEVELS: Mix[] = [
  { pad: 0.9, arp: 0.45 },
  { pad: 0.85, arp: 0.7, bass: 0.9, hats: 0.6 },
  { pad: 0.8, arp: 0.75, bass: 1, hats: 0.8, beat: 0.9 },
  { pad: 0.75, arp: 0.7, bass: 1, hats: 0.85, beat: 1, lead: 0.85 },
];

export interface MusicSpec {
  seed: number | string;
  bpm?: number;
  bars?: number;                    // loop length (default 8)
  mood?: 'warm' | 'night' | 'forge' | 'bright';
  key?: number;                     // tonic as a MIDI note (48–59)
  mode?: 'major' | 'minor';
}
export interface Plan {
  seed: number; bpm: number; bars: number; beatsPerBar: 4; mood: string;
  key: number; keyName: string; mode: 'major' | 'minor';
  progression: string[]; chords: number[][];     // chord tones per bar (MIDI)
  loopSamples: number; barSeconds: number; loopSeconds: number;
  groove: { kick: number[]; snare: number[]; hats: number[]; bass: number[]; arp: string };
  melody: Array<{ bar: number; step: number; len: number; note: number }>;   // steps are 16ths
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const PROGS = {
  major: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 5, 4], [0, 3, 0, 4]],
  minor: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 5, 3, 4], [0, 2, 6, 5]],
};
// grooves in 16ths over one bar (1 = hit, values are velocities)
const KICKS = [[1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0.7, 1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], [1, 0, 0, 0.6, 0, 0, 0, 0, 1, 0, 0.6, 0, 0, 0, 0, 0]];
const SNARES = [[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.3]];
const HATS = [[0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0], [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0.4], [0.7, 0.3, 0.5, 0.3, 0.7, 0.3, 0.5, 0.3, 0.7, 0.3, 0.5, 0.3, 0.7, 0.3, 0.5, 0.4]];
const BASSES = [[1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0.7, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0, 0], [1, 0, 0.6, 0, 1, 0, 0.6, 0, 1, 0, 0.6, 0, 1, 0, 0.6, 0], [1, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 1, 0, 0, 0, 0, 0]];
const RHYTHMS = [   // melody rhythms over two bars: note lengths in 16ths (0 = rest of that length, negative)
  [4, 2, 2, 4, 4, 6, 2, 8], [2, 2, 4, 2, 2, 4, 4, 4, 8], [6, 2, 4, 4, 3, 3, 2, 8], [4, 4, 2, 2, 4, -4, 4, 2, 2, 8],
];

/** Everything about a piece that the seed decides, before any sound is made. */
export function plan(spec: MusicSpec): Plan {
  const seed = seedOf(spec.seed), r = rng(seed);
  const mood = spec.mood ?? r.pick(['warm', 'night', 'bright'] as const);
  const mode = spec.mode ?? (mood === 'bright' ? 'major' : mood === 'warm' ? (r.chance(0.6) ? 'major' : 'minor') : 'minor');
  const bpm = spec.bpm ?? Math.round(mood === 'night' ? r.range(104, 124) : mood === 'forge' ? r.range(88, 100) : r.range(92, 112));
  const bars = spec.bars ?? 8;
  const key = spec.key ?? r.int(50, 57);
  const sc = SCALE[mode];
  const deg = r.pick(PROGS[mode]);
  const per = Math.max(1, Math.round(bars / deg.length));
  // in minor the V chord borrows the raised seventh (harmonic minor), so it pulls home
  const chordOf = (d: number) => [0, 2, 4].map((k) => { const s = d + k; return key + sc[s % 7] + 12 * Math.floor(s / 7) + (mode === 'minor' && d === 4 && k === 2 ? 1 : 0); });
  const chords = Array.from({ length: bars }, (_, b) => chordOf(deg[Math.floor(b / per) % deg.length]));
  const groove = {
    kick: r.pick(mood === 'night' ? KICKS.slice(2) : KICKS.slice(0, 3)), snare: r.pick(SNARES), hats: r.pick(HATS), bass: r.pick(BASSES),
    arp: r.pick(['up', 'down', 'updown', 'broken']),
  };
  const barSeconds = 4 * 60 / bpm, loopSamples = Math.round(bars * barSeconds * SR);
  return {
    seed, bpm, bars, beatsPerBar: 4, mood, key, keyName: `${NAMES[key % 12]} ${mode}`, mode,
    progression: deg.map((d) => { const minorTriad = mode === 'minor' ? [0, 3].includes(d) : [1, 2, 5].includes(d); return minorTriad ? ROMAN[d].toLowerCase() : d === 6 && mode === 'major' ? 'vii°' : d === 1 && mode === 'minor' ? 'ii°' : ROMAN[d]; }),
    chords, loopSamples, barSeconds: +barSeconds.toFixed(5), loopSeconds: +(loopSamples / SR).toFixed(5), groove,
    melody: melody(r, chords, key, sc, bars),
  };
}

/** A two-bar motif, answered and varied: chord tones on strong beats, steps between, the last phrase home. */
function melody(r: Rng, chords: number[][], key: number, sc: number[], bars: number) {
  const notes: Plan['melody'] = [];
  const scaleNotes: number[] = [];
  for (let o = 0; o < 3; o++) for (const s of sc) scaleNotes.push(key + 12 + 12 * o + s);
  const inRange = scaleNotes.filter((n) => n >= key + 14 && n <= key + 31);
  const nearest = (n: number, pool: number[]) => pool.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  const motif = r.pick(RHYTHMS), steps = motif.map(() => r.pick([-2, -1, -1, 1, 1, 2, 0, 3, -3]));
  let prev = nearest(key + 19, inRange);
  for (let phrase = 0; phrase < Math.ceil(bars / 2); phrase++) {
    const variant = phrase % 4 === 2;     // the B phrase: new steps, same rhythm
    let pos = 0;
    motif.forEach((len, i) => {
      const L = Math.abs(len), bar = phrase * 2 + Math.floor(pos / 16), step = pos % 16;
      if (bar >= bars) return;
      if (len > 0) {
        const tones = chords[bar].flatMap((c) => [c + 12, c + 24]).filter((n) => inRange.includes(n) || (n >= key + 14 && n <= key + 31));
        const strong = step % 8 === 0 || L >= 6;
        let want = prev + (variant ? r.pick([-2, -1, 1, 2]) : steps[i]) * 1.7;
        const lastOfAll = phrase === Math.ceil(bars / 2) - 1 && i === motif.length - 1;
        let n = lastOfAll ? nearest(prev, chords[bar].flatMap((c) => [c + 12, c + 24]).filter((x) => (x - key) % 12 === 0) .concat([key + 24])) : strong && tones.length ? nearest(want, tones) : nearest(want, inRange);
        if (Math.abs(n - prev) > 9) n = nearest(prev + Math.sign(n - prev) * 4, inRange);
        notes.push({ bar, step, len: L, note: n });
        prev = n;
      }
      pos += L;
    });
  }
  return notes;
}

// ── instruments (PolyBLEP oscillators, simple envelopes) ────────────────────────────────────────

const blep = (t: number, dt: number) => (t < dt ? (t /= dt, t + t - t * t - 1) : t > 1 - dt ? (t = (t - 1) / dt, t * t + t + t + 1) : 0);
function saw(buf: Float32Array, at: number, n: number, hz: number | ((i: number) => number), amp: (i: number) => number, ph0 = 0) {
  let ph = ph0;
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const f = typeof hz === 'number' ? hz : hz(i), dt = f / SR;
    buf[at + i] += amp(i) * ((2 * ph - 1) - blep(ph, dt));
    ph += dt; if (ph >= 1) ph -= 1;
  }
}
function sine(buf: Float32Array, at: number, n: number, hz: number | ((i: number) => number), amp: (i: number) => number) {
  let ph = 0;
  for (let i = 0; i < n && at + i < buf.length; i++) { const f = typeof hz === 'number' ? hz : hz(i); buf[at + i] += amp(i) * Math.sin(ph); ph += 2 * Math.PI * f / SR; }
}
function tri(buf: Float32Array, at: number, n: number, hz: number, amp: (i: number) => number, vib = 0) {
  let ph = 0;
  for (let i = 0; i < n && at + i < buf.length; i++) { const f = hz * (1 + vib * Math.sin(2 * Math.PI * 5.2 * i / SR) * Math.min(1, i / (SR * 0.3))); buf[at + i] += amp(i) * (1 - 4 * Math.abs(ph - 0.5)); ph += f / SR; if (ph >= 1) ph -= 1; }
}
const env = (a: number, hold: number, rel: number) => (i: number) => { const t = i / SR; return t < a ? t / a : t < a + hold ? 1 : Math.max(0, 1 - (t - a - hold) / rel) ** 2; };
const pluckEnv = (decay: number) => (i: number) => { const t = i / SR; return Math.min(1, t * 400) * Math.exp(-t / decay); };

function stereoWet(dry: Channels, amount: number, room = 0.8, tail = 2.5): Channels {
  const wet = reverb(dry, { room, tail, damp: 0.4 });
  const out = silence(wet[0].length, 2);
  mixInto(out, dry, 0, 1); mixInto(out, wet, 0, amount);
  return out;
}
function delay(ch: Channels, seconds: number, fb: number, mixAmt: number): Channels {
  const d = secs(seconds), n = ch[0].length + d * 6, out = silence(n, 2);
  mixInto(out, ch, 0, 1);
  for (let k = 1; k <= 6; k++) mixInto(out, k % 2 ? [ch[ch.length - 1]] : [ch[0]], d * k, mixAmt * Math.pow(fb, k - 1) * (k % 2 ? 1 : 0.8));
  return out;
}

/** Render one stem's loop (exactly plan.loopSamples long, tails folded in). */
export function renderStem(p: Plan, stem: Stem): Channels {
  const r = rng(p.seed ^ seedOf(stem));
  const L = p.loopSamples, beat = 60 / p.bpm, s16 = beat / 4, at = (bar: number, step: number) => Math.round((bar * 16 + step) * s16 * SR);
  const len = L + secs(4);
  const mono = new Float32Array(len);
  const warm = p.mood === 'warm' || p.mood === 'forge';
  switch (stem) {
    case 'pad': {
      const L2 = new Float32Array(len), R2 = new Float32Array(len);
      let prevV: number[] | null = null;
      for (let b = 0; b < p.bars; b++) {
        if (b > 0 && p.chords[b].join() === p.chords[b - 1].join()) continue;
        let span = 1; while (b + span < p.bars && p.chords[b + span].join() === p.chords[b].join()) span++;
        // voice-lead: pick the inversion closest to the last chord
        const base = p.chords[b].map((n) => n + 12);
        const options = [base, [base[1], base[2], base[0] + 12], [base[2] - 12, base[0], base[1]]];
        const v = prevV ? options.reduce((a, o) => (o.reduce((s, n, i) => s + Math.abs(n - prevV![i]), 0) < a.reduce((s, n, i) => s + Math.abs(n - prevV![i]), 0) ? o : a)) : options[0];
        prevV = v;
        const n = Math.round(span * p.barSeconds * SR), e = env(0.35, span * p.barSeconds - 0.35, 1.2);
        for (const note of [...v, v[0] - 12]) for (const [det, side] of [[-0.11, L2], [0.09, R2], [0, L2], [0.02, R2]] as const) saw(side, at(b, 0), n + secs(1.2), midiHz(note + det), (i) => e(i) * 0.06, r.next());
      }
      const cutoff = warm ? 1100 : p.mood === 'night' ? 1600 : 1900;
      biquad(L2, 'lowpass', cutoff, 0.8); biquad(R2, 'lowpass', cutoff, 0.8);
      return foldLoop(stereoWet([L2, R2], 0.55, 0.86, 3), L);
    }
    case 'arp': {
      const order = (c: number[]) => { const t = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24]; return p.groove.arp === 'down' ? [...t].reverse() : p.groove.arp === 'updown' ? [t[0], t[1], t[2], t[3], t[2], t[1]] : p.groove.arp === 'broken' ? [t[0], t[2], t[1], t[3]] : t; };
      for (let b = 0; b < p.bars; b++) {
        const seq = order(p.chords[b]);
        for (let s = 0; s < 16; s += 2) {
          const note = seq[(b * 8 + s / 2) % seq.length], acc = s % 4 === 0 ? 1 : 0.7;
          saw(mono, at(b, s), secs(0.5), midiHz(note), (i) => pluckEnv(0.13)(i) * 0.22 * acc);
          sine(mono, at(b, s), secs(0.5), midiHz(note + 12), (i) => pluckEnv(0.08)(i) * 0.08 * acc);
        }
      }
      biquad(mono, 'lowpass', (i) => 1800 + 900 * Math.sin(2 * Math.PI * i / L), 1.2);
      return foldLoop(stereoWet(delay([mono], beat * 0.75, 0.42, 0.35), 0.3), L);
    }
    case 'bass': {
      for (let b = 0; b < p.bars; b++) {
        const root = p.chords[b][0] - 12 >= 33 ? p.chords[b][0] - 12 : p.chords[b][0];
        p.groove.bass.forEach((v, s) => {
          if (!v) return;
          const note = s >= 8 && v < 1 && r.chance(0.3) ? root + 7 : root;
          const n = secs(s16 * (p.groove.bass.slice(s + 1).findIndex((x) => x > 0) + 1 || 16 - s) * 0.95);
          const e = (i: number) => Math.min(1, i / (SR * 0.004)) * (i < n ? 1 : Math.max(0, 1 - (i - n) / (SR * 0.06))) * Math.exp(-i / (SR * 0.9));
          sine(mono, at(b, s), n + secs(0.08), midiHz(note), (i) => e(i) * 0.55 * v);
          saw(mono, at(b, s), n + secs(0.08), midiHz(note), (i) => e(i) * 0.16 * v);
        });
      }
      biquad(mono, 'lowpass', 520, 0.9);
      return foldLoop([mono], L);
    }
    case 'hats': {
      for (let b = 0; b < p.bars; b++) p.groove.hats.forEach((v, s) => {
        if (!v) return;
        const open = s === 14 && b % 2 === 1, n = secs(open ? 0.22 : 0.05);
        const x = biquad(whiteNoise(n, r), 'highpass', 7200, 0.8);
        for (let i = 0; i < n; i++) x[i] *= Math.exp(-i / (SR * (open ? 0.07 : 0.014))) * 0.32 * v * r.range(0.85, 1.05);
        mixInto([mono], [x], at(b, s) + Math.round((s % 2 ? 0.012 : 0) * SR));    // a touch of swing
      });
      // a shaker under the hats in 16ths
      for (let b = 0; b < p.bars; b++) for (let s = 0; s < 16; s++) { const n = secs(0.04), x = biquad(whiteNoise(n, r), 'bandpass', 5200, 1.4); for (let i = 0; i < n; i++) x[i] *= Math.sin(Math.PI * i / n) * 0.05 * (s % 4 === 2 ? 1.6 : 1); mixInto([mono], [x], at(b, s)); }
      return foldLoop(stereoWet([mono], 0.15, 0.6, 1), L);
    }
    case 'beat': {
      for (let b = 0; b < p.bars; b++) {
        p.groove.kick.forEach((v, s) => { if (!v) return; sine(mono, at(b, s), secs(0.45), (i) => 48 + 110 * Math.exp(-i / (SR * 0.03)), (i) => Math.min(1, i / 30) * Math.exp(-i / (SR * 0.16)) * 0.95 * v); });
        const fill = b % 4 === 3;
        (fill ? p.groove.snare.map((v, s) => (s >= 12 && s % 2 === 0 ? 0.5 + (s - 12) * 0.12 : v)) : p.groove.snare).forEach((v, s) => {
          if (!v) return;
          const n = secs(0.25), x = biquad(whiteNoise(n, r), 'bandpass', 2000, 0.7);
          for (let i = 0; i < n; i++) x[i] = x[i] * Math.exp(-i / (SR * 0.06)) * 0.8 + 0.35 * Math.sin(2 * Math.PI * 185 * i / SR) * Math.exp(-i / (SR * 0.04));
          mixInto([mono], [x], at(b, s), v);
        });
      }
      return foldLoop(stereoWet([mono], 0.18, 0.7, 1.2), L);
    }
    case 'lead': {
      for (const m of p.melody) {
        const n = secs(m.len * s16 * 0.92);
        tri(mono, at(m.bar, m.step), n + secs(0.3), midiHz(m.note), (i) => env(0.02, n / SR, 0.25)(i) * 0.3, 0.006);
        sine(mono, at(m.bar, m.step), n + secs(0.3), midiHz(m.note), (i) => env(0.04, n / SR, 0.25)(i) * 0.12);
      }
      biquad(mono, 'lowpass', 3200, 0.7);
      return foldLoop(stereoWet(delay([mono], beat * 0.5, 0.3, 0.25), 0.4, 0.84, 2.5), L);
    }
  }
}

export function renderStems(p: Plan, which: readonly Stem[] = STEMS): Record<Stem, Channels> {
  const out = {} as Record<Stem, Channels>;
  for (const s of which) out[s] = renderStem(p, s);
  return out;
}

/** The house balance: stems are rendered at different levels, these faders sit them in one mix
 *  (tuned by measuring the band split and per-stem loudness of the mixed loops, see listen.ts). */
export const FADER: Record<Stem, number> = { pad: 1.6, arp: 2, bass: 0.5, hats: 2.6, beat: 0.85, lead: 0.62 };
/** Sum stems with a mix (gains per stem), stereo. */
export function mixStems(stems: Partial<Record<Stem, Channels>>, mix: Mix, n?: number): Channels {
  const len = n ?? Object.values(stems)[0]![0].length;
  const out = silence(len, 2);
  const pan: Record<Stem, number> = { pad: 0, arp: 0.25, bass: 0, hats: -0.2, beat: 0, lead: -0.05 };
  for (const [k, g0] of Object.entries(mix) as Array<[Stem, number]>) {
    const s = stems[k], g = (g0 ?? 0) * FADER[k]; if (!s || !g) continue;
    if (s.length === 1) { const a = (pan[k] + 1) * Math.PI / 4; mixInto(out, [s[0]], 0, g * Math.cos(a) * Math.SQRT2 * 0.5); mixInto([out[1]], [s[0]], 0, g * Math.sin(a) * Math.SQRT2 * 0.5); }
    else mixInto(out, s, 0, g * 0.5);
  }
  return out;
}

export interface Section { bars: number; mix: Mix; riser?: boolean; hit?: boolean; label?: string }
/** A song from the loop's stems: sections play the loop bar by bar (so harmony keeps moving), a
 *  riser leads into any section marked `riser`, a hit lands on `hit`, and the last chord rings out. */
export function arrange(p: Plan, stems: Record<Stem, Channels>, sections: Section[], fx: { riser?: Channels; impact?: Channels } = {}): { audio: Channels; bars: Array<{ bar: number; t: number; label?: string }>; seconds: number } {
  const barN = p.loopSamples / p.bars, total = sections.reduce((s, x) => s + x.bars, 0);
  const n = Math.round(total * barN), tail = secs(3), out = silence(n + tail, 2);
  const bars: Array<{ bar: number; t: number; label?: string }> = [];
  let bar = 0;
  for (const sec of sections) {
    const start = Math.round(bar * barN);
    if (sec.riser && fx.riser) mixInto(out, fx.riser, start - fx.riser[0].length, 0.5);
    if (sec.hit && fx.impact) mixInto(out, fx.impact, start, 0.7);
    for (let b = 0; b < sec.bars; b++, bar++) {
      bars.push({ bar, t: +(bar * barN / SR).toFixed(4), ...(b === 0 && sec.label ? { label: sec.label } : {}) });
      const from = Math.round((bar % p.bars) * barN), to = Math.round(from + barN), at = Math.round(bar * barN);
      for (const [k, g] of Object.entries(sec.mix) as Array<[Stem, number]>) {
        const s = stems[k]; if (!s || !g) continue;
        const slice = s.map((c) => c.subarray(from, to));
        const m = mixStems({ [k]: slice } as any, { [k]: g }, to - from);
        mixInto(out, m, at);
      }
    }
  }
  // the ending: the pad's first bar rings out under the hit
  const lastMix = sections[sections.length - 1].mix;
  const ring = mixStems({ pad: stems.pad.map((c) => c.subarray(0, Math.round(barN))) } as any, { pad: (lastMix.pad ?? 0.8) * 0.9 });
  for (let i = 0; i < ring[0].length; i++) { const g = Math.exp(-i / (SR * 0.9)); ring[0][i] *= g; ring[1][i] *= g; }
  mixInto(out, ring, n);
  return { audio: softClip(out), bars, seconds: +(n / SR).toFixed(4) };
}

/** An ending sting in the piece's key: "won" climbs the tonic chord and rings, "lost" falls to a low
 *  minor chord over a soft hit. Stereo, about 3 s. */
export function sting(p: Plan, kind: 'won' | 'lost' | 'hit'): Channels {
  const n = secs(3.5), L = new Float32Array(n), R = new Float32Array(n), k = p.key;
  // the win always ends on a major chord (in a minor piece that's a Picardy third)
  const notes = kind === 'won' ? [k + 12, k + 16, k + 19, k + 24] : kind === 'lost' ? [k + 19, k + 15, k + 12, k + 3] : [k, k + 7, k + 12];
  notes.forEach((m, i) => {
    const at = kind === 'hit' ? 0 : secs(i * (kind === 'won' ? 0.11 : 0.2)), e = (j: number) => Math.min(1, j / 200) * Math.exp(-j / (SR * (kind === 'lost' ? 1.1 : 0.9)));
    saw(i % 2 ? R : L, at, n - at, midiHz(m), (j) => e(j) * 0.18);
    sine(i % 2 ? L : R, at, n - at, midiHz(m), (j) => e(j) * 0.2);
  });
  if (kind !== 'won') sine(L, 0, n, (i) => 40 + 50 * Math.exp(-i / (SR * 0.05)), (i) => Math.exp(-i / (SR * 0.5)) * 0.6);
  biquad(L, 'lowpass', 2600); biquad(R, 'lowpass', 2600);
  const out = stereoWet([L, R], 0.5, 0.86, 2);
  return softClip(scale(out, 0.9 / Math.max(1e-6, ...out.map((c) => c.reduce((a, v) => Math.max(a, Math.abs(v)), 0)))));
}

/** K-weighted integrated loudness (ITU-R BS.1770, gated), in LUFS. */
export function lufs(ch: Channels, sr = SR): number {
  const k = ch.map((c) => { const x = Float32Array.from(c); biquad(x, 'highshelf', 1681, 0.707, 4, sr); biquad(x, 'highpass', 38, 0.5, 0, sr); return x; });
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), z: number[] = [];
  for (let s = 0; s + block <= k[0].length; s += hop) { let e = 0; for (const x of k) { let m = 0; for (let i = s; i < s + block; i++) m += x[i] * x[i]; e += m / block; } z.push(e); }
  const L = (e: number) => -0.691 + 10 * Math.log10(e + 1e-12);
  const abs = z.filter((e) => L(e) > -70); if (!abs.length) return -70;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((e) => L(e) > rel);
  return +L(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2);
}
export function toLoudness(ch: Channels, target = -14): Channels { const now = lufs(ch); return scale(ch, Math.pow(10, (target - now) / 20)); }
