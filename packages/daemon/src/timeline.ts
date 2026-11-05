// The scene timeline in the daemon (Phase 10 step 2): builds the one timeline the live view plays (see
// core/collab/scenetimeline.ts), renders scene sounds with the local sound module, and serves the GLBs
// and WAVs the tracks point at. Everything here is a cache keyed by recipe stamps (Decision 62).
import fs from 'node:fs';
import { buildSceneTimeline, timelineInputs, type BuildOpts, type RenderedSound } from '../../core/src/collab/scenetimeline.ts';
import { checkStretches, momentAt, toSeconds, type SceneTimeline } from '../../core/src/collab/movetimeline.ts';
import type { RenderCache } from '../../core/src/collab/index.ts';
import { stamp } from '../../core/src/collab/address.ts';
import type { SoundDef } from '../../core/src/sounds.ts';
import { sfx } from '../../sound/src/sfx.ts';
import { bed, type BedKind } from '../../sound/src/ambience.ts';
import { plan, renderStems, mixStems, LEVELS } from '../../sound/src/music.ts';
import { encodeWav, SR, type Channels } from '../../sound/src/dsp.ts';

const sounds = new Map<string, RenderedSound>();
/** A scene sound from its recipe (memoised by the recipe's stamp). */
export function renderSceneSound(s: SoundDef): RenderedSound {
  const key = stamp({ kind: s.kind, sfx: s.sfx, bed: s.bed, music: s.music, gain: s.gain });
  const hit = sounds.get(key);
  if (hit) return hit;
  let ch: Channels, bpm: number | undefined, bars: number | undefined;
  if (s.kind === 'event') ch = sfx(s.sfx?.kind ?? 'clink', s.sfx?.seed ?? 1, s.sfx?.params ?? {});
  else if (s.kind === 'bed') ch = bed((s.bed?.kind ?? 'forge-roar') as BedKind, s.bed?.seed ?? 1, s.bed?.seconds ?? 8);
  else {
    const p = plan({ seed: s.music?.seed ?? 1, mood: s.music?.mood, bpm: s.music?.bpm, bars: s.music?.bars ?? 4 });
    ch = mixStems(renderStems(p), LEVELS[2], p.loopSamples);
    bpm = p.bpm; bars = p.bars;
  }
  if (s.gain) { const g = Math.pow(10, s.gain / 20); for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g; }
  const mono = ch.length > 1 ? Float32Array.from(ch[0], (v, i) => (v + ch[1][i]) / 2) : ch[0];
  const r: RenderedSound = { sr: SR, mono, wav: new Uint8Array(encodeWav(ch)), seconds: mono.length / SR, ...(bpm ? { bpm, bars } : {}) };
  if (sounds.size > 40) sounds.delete(sounds.keys().next().value!);
  sounds.set(key, r);
  return r;
}

export class TimelineService {
  private memo = new Map<string, { timeline: SceneTimeline; assets: Record<string, { type: string; make: () => Uint8Array }> }>();
  private makers = new Map<string, { type: string; make: () => Uint8Array }>();
  private studio: any; private cache: RenderCache;
  constructor(studio: any, cache: RenderCache) { this.studio = studio; this.cache = cache; }

  docOf(branch: string) {
    const h = this.studio.history;
    if (branch && branch !== 'main' && h.data.proposals[branch]) return h.proposalDoc(h.proposal(branch));
    return h.mainDoc();
  }

  /** The timeline for a branch (main or a proposal), rebuilt only when its moving recipes change. */
  get(branch = 'main', opts: Omit<BuildOpts, 'branch' | 'renderSound'> = {}): SceneTimeline {
    const doc = this.docOf(branch);
    const key = `${branch}:${timelineInputs(doc, opts)}`;
    let hit = this.memo.get(key);
    if (!hit) {
      hit = buildSceneTimeline(this.studio, doc, { ...opts, branch, renderSound: renderSceneSound });
      if (this.memo.size > 12) this.memo.delete(this.memo.keys().next().value!);
      this.memo.set(key, hit);
      for (const [k, v] of Object.entries(hit.assets)) this.makers.set(k, v);
    }
    return hit.timeline;
  }

  /** A track's GLB or WAV: from the render cache, else made now and cached. */
  asset(key: string): { type: string; bytes: Uint8Array } | null {
    if (!/^[a-z]+-[0-9a-f]{6,}$/.test(key)) return null;
    const m = this.makers.get(key);
    const name = key.startsWith('sound-') || key.startsWith('line-') ? 'audio.wav' : 'scene.glb';
    const type = m?.type ?? (name.endsWith('.wav') ? 'audio/wav' : 'model/gltf-binary');
    const hit = this.cache.get(key, [name]);
    if (hit) { return { type, bytes: new Uint8Array(fs.readFileSync(hit[0])) }; }
    if (!m) return null;
    const bytes = m.make();
    this.cache.put(key, name, bytes);
    return { type, bytes };
  }

  /** For Claude: the tracks, the red stretches and the moment the view is on, in words. */
  summary(branch = 'main', opts: Omit<BuildOpts, 'branch' | 'renderSound'> = {}, at?: number, sel?: { object?: string | null; part?: string | null }) {
    const tl = this.get(branch, opts);
    const s = (t: number) => +toSeconds(t).toFixed(3);
    return {
      branch, mode: tl.mode, seconds: s(tl.length), play: tl.play,
      tracks: tl.tracks.map((t) => ({ id: t.id, system: t.system, label: t.label, clock: t.clock, starts: s(t.start), seconds: s(t.length), loop: t.loop, moments: t.markers.filter((m) => m.kind !== 'beat' && m.kind !== 'cue').slice(0, 24).map((m) => `${m.name} @ ${s(m.at)} s`), ...(t.checks ? { failing: t.checks.filter((k) => !k.pass).map((k) => `${k.name}: ${k.worst}${k.unit} > ${k.limit} at ${k.ranges.map(([a, l]) => `${s(a)}–${s(a + l)} s`).join(', ')}`) } : {}), ...(t.error ? { error: t.error } : {}) })),
      red: checkStretches(tl).map((x) => `${x.track} ${x.check}: ${s(x.from)}–${s(x.to)} s on the scene timeline`),
      ...(at !== undefined && sel ? { moment: momentAt(tl, Math.round(at * 24000), sel) } : {}),
    };
  }
}

