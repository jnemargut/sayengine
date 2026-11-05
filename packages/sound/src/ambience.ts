// Ambience beds (Decision 33): procedural textures (a forge's roar, sparse crackle, a room tone, a city
// hum, wind) rendered as seamless loops, and loops cut from library recordings (a stretch crossfaded
// into itself). Beds are long and quiet; games raise and filter them by a value (the fire).
import { SR, type Channels, rng, seedOf, biquad, whiteNoise, pinkNoise, brownNoise, crossfadeLoop, secs, normalize, readWav, toStereo } from './dsp.ts';

export const BED_KINDS = ['forge-roar', 'crackle', 'room', 'city-hum', 'wind'] as const;
export type BedKind = typeof BED_KINDS[number];

/** A slow random wobble in [0, 1] (smoothed noise), for gusts and flicker. */
function wobble(n: number, rate: number, r: ReturnType<typeof rng>) {
  const out = new Float32Array(n), step = Math.max(1, Math.round(SR / rate));
  let a = r.next(), b = r.next();
  for (let i = 0; i < n; i++) { if (i % step === 0) { a = b; b = r.next(); } const t = (i % step) / step, s = t * t * (3 - 2 * t); out[i] = a + (b - a) * s; }
  return out;
}

export function bed(kind: BedKind, seed: number | string = 1, seconds = 8): Channels {
  const r = rng(seedOf(seed) ^ seedOf(kind)), n = secs(seconds + 1);
  let L: Float32Array, R: Float32Array;
  const pair = (f: () => Float32Array) => { L = f(); R = f(); };
  switch (kind) {
    case 'forge-roar': pair(() => {
      // a deep, breathing roar: brown noise through a low band, flickering; a hollow body resonance
      const x = biquad(brownNoise(n, r), 'lowpass', 380, 0.7);
      const flick = wobble(n, 7, r), gust = wobble(n, 0.6, r);
      const body = biquad(pinkNoise(n, r), 'bandpass', 160, 3);
      for (let i = 0; i < n; i++) x[i] = x[i] * (0.55 + 0.45 * gust[i]) * (0.8 + 0.2 * flick[i]) + body[i] * 0.6 * (0.6 + 0.4 * gust[i]);
      return x;
    }); break;
    case 'crackle': pair(() => {
      // sparse pops: exponential gaps, each a tiny filtered burst
      const x = new Float32Array(n);
      for (let t = 0; t < n;) {
        t += Math.round(-Math.log(1 - r.next()) * SR * 0.07);
        const len = r.int(30, 260), a = r.range(0.15, 1) ** 2, f = r.range(1500, 6000);
        const burst = biquad(whiteNoise(len, r), 'bandpass', f, 1.2);
        for (let i = 0; i < len && t + i < n; i++) x[t + i] += burst[i] * a * Math.exp(-i / (len * 0.25)) * 3;
      }
      return x;
    }); break;
    case 'room': pair(() => { const x = biquad(pinkNoise(n, r), 'lowpass', 900); biquad(x, 'highpass', 60); for (let i = 0; i < n; i++) x[i] *= 0.4; return x; }); break;
    case 'city-hum': pair(() => {
      // a distant city: low rumble, a soft mid wash that swells (traffic passing), a mains-ish hum
      const x = biquad(brownNoise(n, r), 'lowpass', 250), wash = biquad(pinkNoise(n, r), 'bandpass', 700, 0.5), sw = wobble(n, 0.25, r);
      for (let i = 0; i < n; i++) x[i] = x[i] * 0.8 + wash[i] * 0.5 * (0.3 + 0.7 * sw[i]) + 0.02 * Math.sin(2 * Math.PI * 60 * i / SR);
      return x;
    }); break;
    case 'wind': pair(() => {
      const g = wobble(n, 0.35, r), x = biquad(pinkNoise(n, r), 'bandpass', (i) => 350 + 700 * g[i], 0.9);
      for (let i = 0; i < n; i++) x[i] *= 0.3 + 0.9 * g[i];
      return x;
    }); break;
  }
  return normalize(crossfadeLoop([L!, R!], 1), 0.6);
}

/** A seamless loop cut from a recording: `seconds` from `start` (default: skip the first 10%),
 *  the end crossfaded into the beginning. */
export function loopFromRecording(file: string, seconds = 8, start?: number, fadeS = 1): Channels {
  const { sr, ch } = readWav(file);
  if (sr !== SR) throw new Error(`${file}: expected ${SR} Hz (the library converts on fetch)`);
  const total = ch[0].length / sr, from = start ?? Math.min(total * 0.1, Math.max(0, total - seconds - fadeS));
  const len = Math.min(secs(seconds + fadeS), ch[0].length - secs(from));
  if (len < secs(fadeS * 3)) throw new Error(`${file} is too short for a ${seconds}s loop`);
  const cut = ch.map((c) => c.slice(secs(from), secs(from) + len));
  return crossfadeLoop(toStereo(cut), fadeS);
}
