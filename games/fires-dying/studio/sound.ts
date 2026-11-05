// Managed by the studio — overwritten by `studio sound pack`. Don't edit; your code goes in src/.
// The studio sound pack on the web (Decision 33): assets/studio/sound/sound.json drives looping layers
// that follow game values (gain, low-pass, rate), one-shot events (a random pick of variations, a little
// pitch spread), and seeded music stems played in sync whose mix walks an intensity ladder; stings land
// on the next bar. Same file, same behaviour as studio/sound.gd in Godot. Browsers start audio only after
// a user gesture: the first pointer or key press unlocks it (values set before that still apply).

const DIR = 'assets/studio/sound/';
type Follow = { value: string; gain?: [number, number]; lowpass?: [number, number]; rate?: [number, number] };
interface Manifest {
  title: string; values: Record<string, number>;
  layers: Array<{ id: string; file: string; gain: number; follow?: Follow }>;
  events: Record<string, { files: string[]; gain: number; pitch?: [number, number] }>;
  music?: { bpm: number; bars: number; barSeconds: number; loopSeconds: number; value: string; gain: number; levels: Array<Record<string, number>>; stems: Record<string, string>; stings: Record<string, string> };
}

export interface StudioSound {
  ctx: AudioContext;
  manifest: Manifest;
  /** a game value (0..1): layers that follow it and the music's intensity move with it */
  setValue(name: string, v: number): void;
  /** play an event's sound (a random one of its variations) */
  event(name: string, opts?: { gain?: number }): void;
  /** end the music on the next bar with a sting ("won", "lost"), or stop it */
  endMusic(sting?: string): void;
  /** restart the music from the top (after endMusic) */
  restartMusic(): void;
  mute(on: boolean): void;
  unlock(): Promise<void>;
  /** what is playing and at what level (for tests and captures) */
  state(): any;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export async function startSound(g?: any, opts: { dir?: string; volume?: number } = {}): Promise<StudioSound | null> {
  if (g?.sound) return g.sound;
  const dir = opts.dir ?? DIR;
  const res = await fetch(dir + 'sound.json').catch(() => null);
  if (!res?.ok) return null;
  const m: Manifest = await res.json();
  const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC({ latencyHint: 'interactive' });
  const master = ctx.createGain(); master.gain.value = opts.volume ?? 1; master.connect(ctx.destination);
  const buffers = new Map<string, AudioBuffer>();
  const files = new Set<string>([...m.layers.map((l) => l.file), ...Object.values(m.events).flatMap((e) => e.files), ...Object.values(m.music?.stems ?? {}), ...Object.values(m.music?.stings ?? {})]);
  await Promise.all([...files].map(async (f) => { const r = await fetch(dir + f); buffers.set(f, await ctx.decodeAudioData(await r.arrayBuffer())); }));

  const values: Record<string, number> = { ...m.values };
  const fired: Record<string, number> = {};
  let seed = 1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // ── layers ──
  const layers = m.layers.map((L) => {
    const src = ctx.createBufferSource(); src.buffer = buffers.get(L.file)!; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(lp).connect(gain).connect(master);
    // start each layer at a different point so two beds never phase together
    src.start(0, (L.id.length * 1.37) % buffers.get(L.file)!.duration);
    return { L, src, lp, gain };
  });
  const applyLayer = (x: typeof layers[number], now: boolean) => {
    const f = x.L.follow, v = clamp01(f ? values[f.value] ?? 0 : 1), t = ctx.currentTime, tc = now ? 0.001 : 0.12;
    const gv = (f?.gain ? lerp(f.gain[0], f.gain[1], v) : 1) * x.L.gain;
    x.gain.gain.setTargetAtTime(gv, t, tc);
    if (f?.lowpass) x.lp.frequency.setTargetAtTime(f.lowpass[0] * Math.pow(f.lowpass[1] / f.lowpass[0], v), t, tc);
    if (f?.rate) x.src.playbackRate.setTargetAtTime(lerp(f.rate[0], f.rate[1], v), t, tc);
  };
  layers.forEach((x) => applyLayer(x, true));

  // ── music: every stem starts on the same sample; the mix follows the intensity value ──
  const mu = m.music;
  const musicBus = ctx.createGain(); musicBus.gain.value = mu?.gain ?? 0.7; musicBus.connect(master);
  let stems: Array<{ name: string; src: AudioBufferSourceNode; gain: GainNode }> = [];
  let t0 = 0, ended = false;
  const levelMix = (x: number) => {
    const L = mu!.levels, s = clamp01(x) * (L.length - 1), i = Math.min(L.length - 2, Math.floor(s)), f = s - i;
    const out: Record<string, number> = {};
    for (const k of Object.keys(mu!.stems)) out[k] = lerp(L[i][k] ?? 0, L[i + 1]?.[k] ?? 0, L.length > 1 ? f : 0);
    return out;
  };
  const applyMusic = (now: boolean) => {
    if (!mu || ended) return;
    const mix = levelMix(values[mu.value] ?? 0), t = ctx.currentTime;
    for (const s of stems) s.gain.gain.setTargetAtTime(mix[s.name] ?? 0, t, now ? 0.001 : 0.6);   // ~2 s to settle: moves with the action, never jumps
  };
  const startMusic = () => {
    if (!mu) return;
    ended = false;
    musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setValueAtTime(mu.gain, ctx.currentTime);
    t0 = ctx.currentTime + 0.05;
    stems = Object.entries(mu.stems).map(([name, f]) => {
      const src = ctx.createBufferSource(); src.buffer = buffers.get(f)!; src.loop = true;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(gain).connect(musicBus); src.start(t0);
      return { name, src, gain };
    });
    applyMusic(true);
  };
  startMusic();

  const api: StudioSound = {
    ctx, manifest: m,
    setValue(name, v) {
      if (values[name] === v) return;
      values[name] = v;
      for (const x of layers) if (x.L.follow?.value === name) applyLayer(x, false);
      if (mu && name === mu.value) applyMusic(false);
    },
    event(name, o = {}) {
      const e = m.events[name]; if (!e) return;
      const f = e.files[Math.floor(rand() * e.files.length) % e.files.length];
      const src = ctx.createBufferSource(); src.buffer = buffers.get(f)!;
      if (e.pitch) src.playbackRate.value = lerp(e.pitch[0], e.pitch[1], rand());
      const gain = ctx.createGain(); gain.gain.value = e.gain * (o.gain ?? 1);
      src.connect(gain).connect(master); src.start();
      fired[name] = (fired[name] ?? 0) + 1;
    },
    endMusic(stingName) {
      if (!mu || ended) return;
      ended = true;
      const now = ctx.currentTime, bar = mu.barSeconds, next = t0 + Math.ceil((now - t0 + 0.05) / bar) * bar;
      musicBus.gain.setTargetAtTime(0, next - 0.05, 0.12);
      for (const s of stems) s.src.stop(next + 1);
      const sf = stingName ? mu.stings[stingName] : undefined;
      if (sf) { const src = ctx.createBufferSource(); src.buffer = buffers.get(sf)!; const g2 = ctx.createGain(); g2.gain.value = mu.gain; src.connect(g2).connect(master); src.start(next); fired[`sting:${stingName}`] = (fired[`sting:${stingName}`] ?? 0) + 1; }
    },
    restartMusic() { for (const s of stems) { try { s.src.stop(); } catch { /* already stopped */ } } startMusic(); },
    mute(on) { master.gain.setTargetAtTime(on ? 0 : (opts.volume ?? 1), ctx.currentTime, 0.05); },
    async unlock() { if (ctx.state !== 'running') await ctx.resume().catch(() => {}); },
    state() {
      return {
        running: ctx.state, values: { ...values }, fired: { ...fired },
        layers: Object.fromEntries(layers.map((x) => [x.L.id, { gain: +x.gain.gain.value.toFixed(3), lowpass: Math.round(x.lp.frequency.value) }])),
        music: mu ? { ended, level: +(values[mu.value] ?? 0).toFixed(3), target: levelMix(values[mu.value] ?? 0), stems: Object.fromEntries(stems.map((s) => [s.name, +s.gain.gain.value.toFixed(3)])), bar: Math.max(0, Math.floor((ctx.currentTime - t0) / mu.barSeconds)) } : null,
      };
    },
  };
  const unlock = () => { void api.unlock(); };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });
  if (g) g.sound = api;
  return api;
}
