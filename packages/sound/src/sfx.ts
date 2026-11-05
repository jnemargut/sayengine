// Game sounds from settings (Decision 33's synth layer): a jsfxr-style generator (the sfxr parameter set,
// rendered the sfxr way with 8× supersampling) plus a few "physical" kinds sfxr can't do well (a metal
// clink from inharmonic modes, steam, a bellows puff, risers and hits for trailers). Every sound is
// `kind + seed`: the same pair gives the same samples on any machine, and in both engines (they get the
// rendered file, not the synth).
import { SR, type Channels, type Rng, rng, seedOf, biquad, whiteNoise, pinkNoise, reverb, mixInto, normalize, fade, secs, midiHz } from './dsp.ts';

/** The sfxr parameter set (0..1 unless noted; signed ones are -1..1). */
export interface SfxrParams {
  wave: 0 | 1 | 2 | 3;              // square, saw, sine, noise
  attack: number; sustain: number; punch: number; decay: number;
  baseFreq: number; freqLimit: number; freqRamp: number; freqDramp: number;
  vibStrength: number; vibSpeed: number;
  arpMod: number; arpSpeed: number;
  duty: number; dutyRamp: number;
  repeatSpeed: number;
  phaOffset: number; phaRamp: number;
  lpfFreq: number; lpfRamp: number; lpfResonance: number;
  hpfFreq: number; hpfRamp: number;
  volume: number;
}
export const DEFAULT_SFXR: SfxrParams = { wave: 0, attack: 0, sustain: 0.3, punch: 0, decay: 0.4, baseFreq: 0.3, freqLimit: 0, freqRamp: 0, freqDramp: 0, vibStrength: 0, vibSpeed: 0, arpMod: 0, arpSpeed: 0, duty: 0, dutyRamp: 0, repeatSpeed: 0, phaOffset: 0, phaRamp: 0, lpfFreq: 1, lpfRamp: 0, lpfResonance: 0, hpfFreq: 0, hpfRamp: 0, volume: 0.5 };

/** Render sfxr parameters (the original algorithm, ported). Mono, 44.1 kHz. */
export function renderSfxr(p: SfxrParams, seed = 1): Float32Array {
  const r = rng(seed);
  const noise = new Float32Array(32), phaser = new Float32Array(1024);
  const out: number[] = [];
  let period = 0, maxPeriod = 0, slide = 0, dslide = 0, squareDuty = 0, squareSlide = 0, arpMod = 1, arpTime = 0, arpLimit = 0;
  const reset = (all: boolean) => {
    period = 100 / (p.baseFreq * p.baseFreq + 0.001); maxPeriod = 100 / (p.freqLimit * p.freqLimit + 0.001);
    slide = 1 - Math.pow(p.freqRamp, 3) * 0.01; dslide = -Math.pow(p.freqDramp, 3) * 0.000001;
    squareDuty = 0.5 - p.duty * 0.5; squareSlide = -p.dutyRamp * 0.00005;
    arpMod = p.arpMod >= 0 ? 1 - Math.pow(p.arpMod, 2) * 0.9 : 1 + Math.pow(p.arpMod, 2) * 10;
    arpTime = 0; arpLimit = p.arpSpeed === 1 ? 0 : Math.floor(Math.pow(1 - p.arpSpeed, 2) * 20000 + 32);
    if (all) for (let i = 0; i < 32; i++) noise[i] = r.next() * 2 - 1;
  };
  reset(true);
  let fltp = 0, fltdp = 0, fltw = Math.pow(p.lpfFreq, 3) * 0.1, fltwd = 1 + p.lpfRamp * 0.0001;
  let fltdmp = 5 / (1 + Math.pow(p.lpfResonance, 2) * 20) * (0.01 + fltw); if (fltdmp > 0.8) fltdmp = 0.8;
  let fltphp = 0, flthp = Math.pow(p.hpfFreq, 2) * 0.1; const flthpd = 1 + p.hpfRamp * 0.0003;
  let vibPhase = 0; const vibSpeed = Math.pow(p.vibSpeed, 2) * 0.01, vibAmp = p.vibStrength * 0.5;
  const envLen = [Math.floor(p.attack * p.attack * 100000), Math.floor(p.sustain * p.sustain * 100000), Math.floor(p.decay * p.decay * 100000)];
  let envStage = 0, envTime = 0, envVol = 0;
  let phase = 0, iphase = 0, phaserPos = 0;
  let phaOffset = Math.pow(p.phaOffset, 2) * 1020; if (p.phaOffset < 0) phaOffset = -phaOffset;
  let phaRamp = Math.pow(p.phaRamp, 2); if (p.phaRamp < 0) phaRamp = -phaRamp;
  let repTime = 0; const repLimit = p.repeatSpeed === 0 ? 0 : Math.floor(Math.pow(1 - p.repeatSpeed, 2) * 20000 + 32);
  const max = SR * 6;
  for (let t = 0; t < max; t++) {
    if (repLimit && ++repTime >= repLimit) { repTime = 0; reset(false); }
    if (arpLimit && ++arpTime >= arpLimit) { arpLimit = 0; period *= arpMod; }
    slide += dslide; period *= slide;
    if (period > maxPeriod) { period = maxPeriod; if (p.freqLimit > 0) break; }
    let rp = period;
    if (vibAmp > 0) { vibPhase += vibSpeed; rp = period * (1 + Math.sin(vibPhase) * vibAmp); }
    const iperiod = Math.max(8, Math.floor(rp));
    squareDuty = Math.min(0.5, Math.max(0, squareDuty + squareSlide));
    if (++envTime > envLen[envStage]) { envTime = 0; envStage++; if (envStage === 3) break; }
    const et = envTime / Math.max(1, envLen[envStage]);
    envVol = envStage === 0 ? et : envStage === 1 ? 1 + (1 - et) * 2 * p.punch : 1 - et;
    phaOffset += phaRamp; iphase = Math.min(1023, Math.abs(Math.floor(phaOffset)));
    if (flthpd !== 1) { flthp = Math.min(0.1, Math.max(0.00001, flthp * flthpd)); }
    let ssample = 0;
    for (let si = 0; si < 8; si++) {
      let sample = 0;
      phase++;
      if (phase >= iperiod) { phase %= iperiod; if (p.wave === 3) for (let i = 0; i < 32; i++) noise[i] = r.next() * 2 - 1; }
      const fp = phase / iperiod;
      if (p.wave === 0) sample = fp < squareDuty ? 0.5 : -0.5;
      else if (p.wave === 1) sample = 1 - fp * 2;
      else if (p.wave === 2) sample = Math.sin(fp * 2 * Math.PI);
      else sample = noise[Math.floor(phase * 32 / iperiod) % 32];
      const pp = fltp; fltw = Math.min(0.1, Math.max(0, fltw * fltwd));
      if (p.lpfFreq !== 1) { fltdp += (sample - fltp) * fltw; fltdp -= fltdp * fltdmp; } else { fltp = sample; fltdp = 0; }
      fltp += fltdp; fltphp += fltp - pp; fltphp -= fltphp * flthp; sample = fltphp;
      phaser[phaserPos & 1023] = sample; sample += phaser[(phaserPos - iphase + 1024) & 1023]; phaserPos = (phaserPos + 1) & 1023;
      ssample += sample * envVol;
    }
    out.push(Math.max(-1, Math.min(1, (ssample / 8) * 2 * p.volume)));
  }
  return Float32Array.from(out);
}

// ── the jsfxr presets, seeded ───────────────────────────────────────────────────────────────────
const P = (o: Partial<SfxrParams>): SfxrParams => ({ ...DEFAULT_SFXR, ...o });
export const SFXR_PRESETS: Record<string, (r: Rng) => SfxrParams> = {
  pickup: (r) => P({ baseFreq: r.range(0.4, 0.9), sustain: r.range(0, 0.1), decay: r.range(0.1, 0.5), punch: r.range(0.3, 0.6), ...(r.chance(0.5) ? { arpSpeed: r.range(0.5, 0.7), arpMod: r.range(0.2, 0.6) } : {}) }),
  laser: (r) => P({ wave: r.pick([0, 1, 2] as const), baseFreq: r.range(0.5, 1), freqLimit: r.range(0, 0.2), freqRamp: r.range(-0.35, -0.15), duty: r.range(0, 0.5), sustain: r.range(0.1, 0.3), decay: r.range(0, 0.4) }),
  explosion: (r) => P({ wave: 3, baseFreq: r.range(0.1, 0.4), freqRamp: r.range(-0.1, 0.3), sustain: r.range(0.1, 0.4), decay: r.range(0.3, 0.8), punch: r.range(0.2, 0.8) }),
  powerup: (r) => P({ wave: r.chance(0.5) ? 1 : 0, baseFreq: r.range(0.2, 0.5), freqRamp: r.range(0.05, 0.25), sustain: r.range(0, 0.4), decay: r.range(0.1, 0.5), ...(r.chance(0.5) ? { vibStrength: r.range(0, 0.5), vibSpeed: r.range(0, 0.6) } : { repeatSpeed: r.range(0.4, 0.8) }) }),
  hit: (r) => P({ wave: r.pick([0, 1, 3] as const), baseFreq: r.range(0.2, 0.8), freqRamp: r.range(-0.7, -0.3), sustain: r.range(0, 0.1), decay: r.range(0.1, 0.3), hpfFreq: r.chance(0.5) ? r.range(0, 0.3) : 0 }),
  jump: (r) => P({ wave: 0, duty: r.range(0, 0.6), baseFreq: r.range(0.3, 0.6), freqRamp: r.range(0.1, 0.3), sustain: r.range(0.1, 0.4), decay: r.range(0.1, 0.3), hpfFreq: r.chance(0.5) ? r.range(0, 0.3) : 0 }),
  blip: (r) => P({ wave: r.pick([0, 1] as const), duty: r.range(0, 0.6), baseFreq: r.range(0.2, 0.6), sustain: r.range(0.1, 0.2), decay: r.range(0, 0.2), hpfFreq: 0.1 }),
};

// ── physical kinds ──────────────────────────────────────────────────────────────────────────────

/** Struck metal: inharmonic modes (an anvil/thick bar), a click of noise, a little room. */
function clink(r: Rng, o: { pitch?: number } = {}): Channels {
  const f0 = (o.pitch ?? r.range(880, 1250));
  const ratios = [1, 1.47 + r.range(-0.03, 0.03), 2.09 + r.range(-0.05, 0.05), 2.56, 3.9 + r.range(-0.1, 0.1), 5.4];
  const n = secs(1.6), x = new Float32Array(n);
  ratios.forEach((k, j) => {
    const f = f0 * k, a = [1, 0.6, 0.45, 0.3, 0.22, 0.12][j] * r.range(0.8, 1.1), d = [1.1, 0.7, 0.45, 0.32, 0.18, 0.1][j] * r.range(0.8, 1.2);
    const ph = r.next() * 6.28;
    for (let i = 0; i < n; i++) x[i] += a * Math.exp(-i / (SR * d)) * Math.sin(2 * Math.PI * f * i / SR + ph);
  });
  const click = biquad(whiteNoise(secs(0.012), r), 'highpass', 2500);
  for (let i = 0; i < click.length; i++) x[i] += click[i] * (1 - i / click.length) * 0.9;
  // the hammer's body: a dull low thump under the ring
  for (let i = 0; i < secs(0.08); i++) x[i] += 0.5 * Math.exp(-i / (SR * 0.02)) * Math.sin(2 * Math.PI * 140 * i / SR);
  const dry: Channels = [x];
  const wet = reverb(dry, { room: 0.7, damp: 0.5, tail: 0.8 });
  const out: Channels = [new Float32Array(wet[0].length), new Float32Array(wet[0].length)];
  mixInto(out, dry, 0, 1); mixInto(out, wet, 0, 0.35);
  return out;
}
/** Steam off hot iron: bright noise swelling and dying, a gurgle under it. */
function hiss(r: Rng): Channels {
  const n = secs(1.8), x = biquad(whiteNoise(n, r), 'highpass', 3000);
  biquad(x, 'peak', 6500, 1.2, 6);
  for (let i = 0; i < n; i++) { const t = i / n; x[i] *= Math.min(1, t * 25) * Math.pow(1 - t, 1.6) * (0.8 + 0.2 * Math.sin(i / 900)); }
  return [x];
}
/** A bellows puff: a breathy low swell. */
function puff(r: Rng): Channels {
  const n = secs(0.9), x = biquad(pinkNoise(n, r), 'bandpass', (i) => 300 + 500 * Math.sin(Math.PI * i / n), 0.8);
  for (let i = 0; i < n; i++) x[i] *= Math.sin(Math.PI * Math.pow(i / n, 0.6)) * 2.2;
  return [x];
}
/** A short friendly two-note chime (a job done). */
function chime(r: Rng, o: { root?: number } = {}): Channels {
  const root = o.root ?? r.pick([72, 74, 76, 77]), n = secs(1.2), x = new Float32Array(n);
  for (const [k, at] of [[0, 0], [r.pick([4, 7]), 0.09]] as const) {
    const f = midiHz(root + k), s = secs(at);
    for (let i = s; i < n; i++) { const t = (i - s) / SR; x[i] += 0.5 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 9)); }
  }
  const wet = reverb([x], { room: 0.75, tail: 1 });
  return mixInto(mixInto([new Float32Array(wet[0].length), new Float32Array(wet[0].length)], [x], 0, 1), wet, 0, 0.3);
}
/** A soft "no" (wrong item): two low detuned square blips. */
function buzz(r: Rng): Channels {
  const n = secs(0.36), x = new Float32Array(n), f = r.range(150, 190);
  for (let i = 0; i < n; i++) { const t = i / SR, on = (t < 0.14 || t > 0.19) ? 1 : 0, env = on * Math.min(1, (0.36 - t) * 30);
    x[i] = env * 0.35 * (Math.sign(Math.sin(2 * Math.PI * f * t)) + Math.sign(Math.sin(2 * Math.PI * f * 1.01 * t))) * 0.5; }
  return [biquad(x, 'lowpass', 1800)];
}
/** A dry thud (a sack set down, charcoal tipped). */
function thud(r: Rng): Channels {
  const n = secs(0.5), x = biquad(pinkNoise(n, r), 'lowpass', 400);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (x[i] * 2 + Math.sin(2 * Math.PI * (90 - 40 * t) * t)) * Math.exp(-t * 12); }
  const crunch = biquad(whiteNoise(secs(0.25), r), 'bandpass', 2400, 1.5);
  for (let i = 0; i < crunch.length; i++) x[i] += crunch[i] * Math.exp(-i / (SR * 0.05)) * (r.next() < 0.3 ? 1.4 : 0.5);
  return [x];
}
/** A noise riser (into a trailer's drop): `seconds` long, the filter opening. */
function riser(r: Rng, o: { seconds?: number } = {}): Channels {
  const len = o.seconds ?? 3.75, n = secs(len), x = biquad(whiteNoise(n, r), 'bandpass', (i) => 300 * Math.pow(30, i / n), 1.6);
  for (let i = 0; i < n; i++) x[i] *= Math.pow(i / n, 2.2) * 1.4;
  return fade(toPair(x), 0.01, 0.02);
}
/** A low cinematic hit with a splash (a cut, an end card). */
function impact(r: Rng): Channels {
  const n = secs(2.4), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = 0.9 * Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-t * 18)) * t) * Math.exp(-t * 2.2); }
  const splash = biquad(whiteNoise(n, r), 'highpass', 4000);
  for (let i = 0; i < n; i++) x[i] += splash[i] * 0.3 * Math.exp(-i / (SR * 0.35));
  const wet = reverb([x], { room: 0.88, tail: 1.5 });
  return mixInto(mixInto([new Float32Array(wet[0].length), new Float32Array(wet[0].length)], [x], 0, 1), wet, 0, 0.4);
}
function whoosh(r: Rng): Channels {
  const n = secs(0.7), x = biquad(whiteNoise(n, r), 'bandpass', (i) => 400 + 2600 * Math.sin(Math.PI * i / n), 1.2);
  for (let i = 0; i < n; i++) x[i] *= Math.pow(Math.sin(Math.PI * i / n), 2) * 1.6;
  return [x];
}
const toPair = (x: Float32Array): Channels => [x, Float32Array.from(x)];

const PHYSICAL: Record<string, (r: Rng, o: any) => Channels> = { clink, hiss, puff, chime, buzz, thud, riser, impact, whoosh };
export const SFX_KINDS = [...Object.keys(SFXR_PRESETS), ...Object.keys(PHYSICAL)];

/** One game sound: kind + seed (+ kind options, or full sfxr params). Normalised to -1 dBFS peak. */
export function sfx(kind: string, seed: number | string = 1, opts: Record<string, any> = {}): Channels {
  const s = seedOf(seed), r = rng(s);
  let out: Channels;
  if (kind === 'sfxr') out = [renderSfxr({ ...DEFAULT_SFXR, ...opts }, s)];
  else if (SFXR_PRESETS[kind]) out = [renderSfxr({ ...SFXR_PRESETS[kind](r), ...opts }, s)];
  else if (PHYSICAL[kind]) out = PHYSICAL[kind](r, opts);
  else throw new Error(`unknown sound kind "${kind}" (have: ${SFX_KINDS.join(', ')})`);
  return normalize(fade(out, 0.001, 0.01), 0.89);
}
