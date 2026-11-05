// Trailers on the timeline (Phase 10 step 3b, Decision 32 + 62): a reel file (packages/reel: takes with
// camera keys, an edit cut to the music's beats) lives in the scene doc while you work on it, so each
// change is a step on the shared history. The view shows its shots as segments on a "shots" track with
// beat marks and plays them through each shot's camera on the scene. Per shot: keep, redo (a new take of
// that shot only: one step) and "show me three" (three distinct camera takes, compared side by side;
// the pick is logged to taste). The final export still goes through the reel module's ffmpeg recipe:
// `studio reel-export` writes the reel file back for `studio reel capture --takes …` and `studio reel cut`.
import { z } from 'zod';
import type { ToolDef } from './tools.ts';
import type { SceneDoc } from './types.ts';
import { parseReel, cutToBeats, cameraAt, type Reel, type Cut } from '../../reel/src/reel.ts';
import { stamp, secondsToTicks, type Timeline } from './collab/address.ts';
import { addTimelineProvider, partWords } from './collab/timelines.ts';

const nodeFs = () => (process as any).getBuiltinModule('node:fs') as typeof import('node:fs');
const nodePath = () => (process as any).getBuiltinModule('node:path') as typeof import('node:path');

type V3 = [number, number, number];
type Take = Reel['takes'][number];
export interface SceneReel { reel: Reel; file?: string; kept?: number[]; made?: Record<string, { from: string; style: string }> }

export const REDO_STYLES: Record<string, string> = {
  orbit: 'a slow orbit round it', push: 'a push in', crane: 'a crane up', drift: 'a sideways drift', low: 'low, looking up', pull: 'a pull back',
};
export const SHOT_MIN_DISTINCT = 0.15;

export function reelsOf(doc: SceneDoc): Record<string, SceneReel> { return ((doc as any).reels ?? {}) as Record<string, SceneReel>; }
export function reelOf(doc: SceneDoc, id?: string): { id: string; r: SceneReel } {
  const all = reelsOf(doc), ids = Object.keys(all);
  const k = id ?? (ids.length === 1 ? ids[0] : undefined);
  if (!k || !all[k]) throw new Error(id ? `no reel "${id}" in the scene (have: ${ids.join(', ') || 'none'})` : ids.length ? `which reel? --reel ${ids.join('|')}` : 'no reel in the scene yet: studio reel-import --file games/<game>/reel/trailer.json');
  return { id: k, r: all[k] };
}

/** The beats the view and the tools cut on: a steady grid at the reel's bpm (the export uses librosa's detected beats). */
export function reelBeats(reel: Reel): number[] {
  const bpm = reel.music.bpm ?? 128, n = reel.edit.reduce((s, e) => s + e.beats, 0) + (reel.endCard?.beats ?? 0) + 8;
  return Array.from({ length: n }, (_, k) => +(k * 60 / bpm).toFixed(4));
}
export function reelCut(reel: Reel): Cut { return cutToBeats(reel, reelBeats(reel)); }

// ── a new take of one shot ──────────────────────────────────────────────────────────────────────

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const r3 = (a: V3): V3 => [+a[0].toFixed(2), +a[1].toFixed(2), +a[2].toFixed(2)];

/** A new camera move on the same subject as a take: an orbit, a push in, a crane up, a drift, low or a pull back. */
export function redoTake(base: Take, style: string, id: string): Take {
  const T = mul(base.keys.reduce<V3>((s, k) => add(s, k.target as V3), [0, 0, 0]), 1 / base.keys.length);
  const P0 = base.keys[0].position as V3;
  const v = sub(P0, T);
  const dist = Math.max(8, len(v));
  const hz = Math.max(4, Math.hypot(v[0], v[2]));
  const yaw = Math.atan2(v[0], v[2]), h = v[1];
  const around = (dy: number, d = hz, up = h): V3 => add(T, [Math.sin(yaw + dy) * d, up, Math.cos(yaw + dy) * d]);
  const side: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  let keys: Array<{ position: V3; target: V3 }>;
  switch (style) {
    case 'orbit': keys = [-0.45, 0, 0.45].map((a) => ({ position: around(a), target: T })); break;
    case 'push': keys = [1, 0.78, 0.55].map((k) => ({ position: add(T, mul(v, k)), target: T })); break;
    case 'pull': keys = [0.6, 0.9, 1.25].map((k) => ({ position: add(T, mul(v, k)), target: T })); break;
    case 'crane': keys = [0, 0.5, 1].map((u) => ({ position: around(0, hz, Math.max(1.6, h * 0.2) * (1 - u) + (h + dist * 0.55) * u), target: add(T, [0, dist * 0.08 * u, 0]) })); break;
    case 'drift': keys = [-1, 0, 1].map((u) => ({ position: add(add(T, v), mul(side, u * dist * 0.3)), target: add(T, mul(side, u * dist * 0.12)) })); break;
    case 'low': keys = [0, 1].map((u) => ({ position: around(0, hz * (0.85 - 0.15 * u), 1.2), target: add(T, [0, dist * 0.25, 0]) })); break;
    default: throw new Error(`no camera style "${style}" (${Object.keys(REDO_STYLES).join(', ')})`);
  }
  return { ...base, id, keys: keys.map((k) => ({ position: r3(k.position), target: r3(k.target) })), note: `a new take of ${base.id}: ${REDO_STYLES[style]}` };
}

/** How different two takes' camera moves are, 0..1: the mean gap between them (5 points along the move) over the subject distance. */
export function cameraDistance(a: Take, b: Take): number {
  const T = mul(a.keys.reduce<V3>((s, k) => add(s, k.target as V3), [0, 0, 0]), 1 / a.keys.length);
  const d = Math.max(8, len(sub(a.keys[0].position as V3, T)));
  let s = 0;
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    const ca = cameraAt(a, u), cb = cameraAt(b, u);
    s += Math.min(1, (len(sub(ca.position as V3, cb.position as V3)) + 0.5 * len(sub(ca.target as V3, cb.target as V3))) / d);
  }
  return +(s / 5).toFixed(3);
}

const shotOf = (reel: Reel, n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > reel.edit.length) throw new Error(`no shot ${n}: the edit has shots 1–${reel.edit.length}`);
  return reel.edit[n - 1];
};
const uniqueId = (reel: Reel, base: string) => { let id = base, k = 2; while (reel.takes.some((t) => t.id === id)) id = `${base}-${k++}`; return id; };
const rootOf = (id: string) => id.replace(new RegExp(`-(${Object.keys(REDO_STYLES).join('|')})(-\\d+)?$`), '');

/** The shots of a reel for the view and Claude: times on the steady beat grid, take, camera keys, kept or not. */
export function reelShots(sr: SceneReel) {
  const cut = reelCut(sr.reel);
  return {
    duration: cut.duration, bpm: cut.bpm, beats: reelBeats(sr.reel).filter((b) => b <= cut.duration + 1e-6),
    shots: cut.shots.map((s) => ({ ...s, kept: (sr.kept ?? []).includes(s.index), made: sr.made?.[s.take]?.style ?? null })),
    endCard: cut.endCard, warnings: cut.warnings,
  };
}

// ── the shot clock (Decision 61): shot:<reel> on thing reel:<id> ───────────────────────────────

addTimelineProvider((doc, thing, clock) => {
  if (!thing.startsWith('reel:') || !clock.startsWith('shot:')) return undefined;
  const id = thing.slice(5).split('/')[0];
  const sr = reelsOf(doc)[id];
  if (!sr) return { clock, thing, length: 0, version: 'gone', markers: {}, exists: false } as Timeline;
  const cut = reelCut(sr.reel);
  const markers: Timeline['markers'] = {};
  for (const s of cut.shots) markers[`shot ${s.index}`] = { at: secondsToTicks(s.start), len: secondsToTicks(s.end - s.start) };
  if (cut.endCard) markers['end card'] = { at: secondsToTicks(cut.endCard.start), len: secondsToTicks(cut.endCard.end - cut.endCard.start) };
  return { clock, thing, length: secondsToTicks(cut.duration), version: stamp(sr.reel), markers, shots: cut.shots.map((s) => ({ id: String(s.index), at: secondsToTicks(s.start), len: secondsToTicks(s.end - s.start) })), bpm: cut.bpm, beatsPerBar: 4 };
});
partWords.reel = (doc, id) => reelsOf(doc)[id]?.reel.title ?? null;

// ── tools ───────────────────────────────────────────────────────────────────────────────────────

const Shot = z.number().int().min(1).describe('shot number in the edit (1 = the first)');
export const REEL_TOOLS: ToolDef[] = [
  {
    name: 'reel-import', mode: 'create', mutates: true,
    description: 'Bring a trailer into the scene to work on it in the live view (Phase 10): its shots become segments on a "shots" track in the timeline dock with beat marks, and playing it runs each shot\'s camera over the scene. Per shot: keep, redo, show me three. --file games/<game>/reel/trailer.json; --takes a,b keeps only the shots that use those takes (e.g. the ones the scene has a town for). Export again with reel-export, then `studio reel capture --takes …` and `studio reel cut` (the ffmpeg recipe).',
    input: z.object({ file: z.string(), id: z.string().optional(), takes: z.array(z.string()).optional() }),
    example: 'studio reel-import --file games/pocket-raleigh/reel/trailer.json --takes day-street,day-plaza,day-aerial',
    run(ctx, a) {
      const fs = nodeFs();
      const raw = JSON.parse(fs.readFileSync(a.file, 'utf8'));
      if (a.takes?.length) {
        raw.edit = raw.edit.filter((e: any) => a.takes.includes(e.take));
        raw.takes = raw.takes.filter((t: any) => a.takes.includes(t.id));
        if (!raw.edit.length) throw new Error(`no shot uses ${a.takes.join(', ')}`);
      }
      const reel = parseReel(raw);
      const id = a.id ?? reel.id;
      ctx.set(['reels', id], { reel, file: a.file, kept: [], made: {} } satisfies SceneReel);
      const cut = reelCut(reel);
      ctx.summary(`Trailer "${reel.title}": ${cut.shots.length} shots over ${cut.duration.toFixed(1)} s at ${cut.bpm} bpm`);
      return { reel: id, shots: cut.shots.length, seconds: cut.duration, warnings: cut.warnings };
    },
  },
  {
    name: 'reel-shots', mode: 'inspect', mutates: false,
    description: 'A trailer\'s shots: start and end on the beat grid, beats, take, its camera move, kept or not.',
    input: z.object({ reel: z.string().optional() }),
    run(ctx, a) {
      const { id, r } = reelOf(ctx.doc, a.reel);
      const s = reelShots(r);
      return { reel: id, seconds: s.duration, bpm: s.bpm, shots: s.shots.map((x) => ({ shot: x.index, take: x.take, from: x.start, to: x.end, beats: x.beats, kept: x.kept, ...(x.made ? { style: REDO_STYLES[x.made] } : {}), ...(x.caption ? { caption: x.caption } : {}) })), warnings: s.warnings };
    },
  },
  {
    name: 'reel-keep', mode: 'review', mutates: true,
    description: 'Keep one shot of a trailer as it is (the view\'s Keep on a shot). --keep false un-keeps it.',
    input: z.object({ reel: z.string().optional(), shot: Shot, keep: z.boolean().optional() }),
    example: 'studio reel-keep --reel trailer --shot 2',
    run(ctx, a) {
      const { id, r } = reelOf(ctx.doc, a.reel);
      shotOf(r.reel, a.shot);
      const kept = new Set(r.kept ?? []);
      if (a.keep === false) kept.delete(a.shot); else kept.add(a.shot);
      ctx.set(['reels', id, 'kept'], [...kept].sort((x, y) => x - y));
      ctx.summary(`${a.keep === false ? 'un-kept' : 'kept'} shot ${a.shot} (${r.reel.edit[a.shot - 1].take})`);
      return { reel: id, kept: [...kept].sort((x, y) => x - y) };
    },
  },
  {
    name: 'reel-redo', mode: 'modify', mutates: true,
    description: `A new take of one shot only (one step): a different camera move on the same subject (${Object.entries(REDO_STYLES).map(([k, v]) => `${k}: ${v}`).join('; ')}). The other shots and their takes stay as they are. --style picks the move (default: the next one not tried on this shot). Capture it for the export with \`studio reel capture --takes <new take>\`.`,
    input: z.object({ reel: z.string().optional(), shot: Shot, style: z.enum(Object.keys(REDO_STYLES) as [string, ...string[]]).optional() }),
    example: 'studio reel-redo --reel trailer --shot 3 --style orbit --why "less static"',
    run(ctx, a) {
      const { id, r } = reelOf(ctx.doc, a.reel);
      const e = shotOf(r.reel, a.shot);
      const cur = r.reel.takes.find((t) => t.id === e.take)!;
      const root = r.reel.takes.find((t) => t.id === (r.made?.[cur.id]?.from ?? rootOf(cur.id))) ?? cur;
      const tried = new Set(Object.entries(r.made ?? {}).filter(([, m]) => m.from === root.id).map(([, m]) => m.style));
      const style = a.style ?? Object.keys(REDO_STYLES).find((s) => !tried.has(s)) ?? 'orbit';
      const take = redoTake(root, style, uniqueId(r.reel, `${root.id}-${style}`));
      ctx.set(['reels', id, 'reel', 'takes', String(r.reel.takes.length)], take);
      ctx.set(['reels', id, 'reel', 'edit', String(a.shot - 1), 'take'], take.id);
      ctx.set(['reels', id, 'made', take.id], { from: root.id, style });
      if ((r.kept ?? []).includes(a.shot)) ctx.set(['reels', id, 'kept'], (r.kept ?? []).filter((k) => k !== a.shot));
      ctx.summary(`shot ${a.shot}: a new take, ${REDO_STYLES[style]} (${take.id})`);
      return { reel: id, shot: a.shot, take: take.id, style, words: REDO_STYLES[style], from: cur.id, capture: `studio reel capture --takes ${take.id}` };
    },
  },
  {
    name: 'reel-three', mode: 'propose', mutates: false,
    description: `"Show me three" for one shot of a trailer: three distinct camera takes (default orbit, push in, crane up; camera moves at least ${Math.round(SHOT_MIN_DISTINCT * 100)}% apart, else refused), each a proposal with one reel-redo step, compared side by side in the timeline dock (a thumbnail of each from the scene). Pick one with pick-take; the pick is logged to taste and the other two are discarded.`,
    input: z.object({ reel: z.string().optional(), shot: Shot, styles: z.array(z.enum(Object.keys(REDO_STYLES) as [string, ...string[]])).length(3).optional() }),
    example: 'studio reel-three --reel trailer --shot 3',
    run(ctx, a) {
      const { id, r } = reelOf(ctx.doc, a.reel);
      const e = shotOf(r.reel, a.shot);
      const cur = r.reel.takes.find((t) => t.id === e.take)!;
      const root = r.reel.takes.find((t) => t.id === (r.made?.[cur.id]?.from ?? rootOf(cur.id))) ?? cur;
      const styles: string[] = a.styles ?? ['orbit', 'push', 'crane'].map((s) => (s === r.made?.[cur.id]?.style ? 'drift' : s));
      // the camera moves themselves must be apart (not just their names)
      const draft = styles.map((s) => redoTake(root, s, s));
      const pairs: Array<{ a: string; b: string; distance: number }> = [];
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) pairs.push({ a: styles[i], b: styles[j], distance: cameraDistance(draft[i], draft[j]) });
      const close = pairs.filter((p) => p.distance < SHOT_MIN_DISTINCT);
      if (close.length) throw new Error(`the camera moves are too alike: ${close.map((p) => `${p.a} and ${p.b} ${Math.round(p.distance * 100)}% apart`).join('; ')} (need ≥ ${Math.round(SHOT_MIN_DISTINCT * 100)}%)`);
      const res = ctx.studio.call('show-three', {
        title: `${r.reel.title} shot ${a.shot}`, topic: 'reel-shot',
        takes: styles.map((s) => ({ label: REDO_STYLES[s], traits: [s], calls: [{ tool: 'reel-redo', args: { reel: id, shot: a.shot, style: s } }] })),
      }, ctx.author);
      if (!res.ok) throw new Error(res.error ?? 'show-three failed');
      const g = ctx.studio.history.data.takes[(res.result as any).group];
      g.reel = { id, shot: a.shot };
      g.cameraDistinct = pairs;
      ctx.summary(`${g.id}: shot ${a.shot} three ways (${styles.join(', ')}), camera moves ${Math.round(Math.min(...pairs.map((p) => p.distance)) * 100)}%+ apart`);
      return { ...(res.result as any), shot: a.shot, cameraDistinct: pairs };
    },
  },
  {
    name: 'reel-export', mode: 'output', mutates: false,
    description: 'Write the trailer back to its reel file (or --out) for the reel module: then `studio reel capture --project <game> --takes <new takes>` and `studio reel cut` (the same ffmpeg recipe as ever). Lists the takes that need capturing.',
    input: z.object({ reel: z.string().optional(), out: z.string().optional() }),
    example: 'studio reel-export --reel trailer',
    run(ctx, a) {
      const { id, r } = reelOf(ctx.doc, a.reel);
      const file = a.out ?? r.file;
      if (!file) throw new Error('where to? --out games/<game>/reel/<id>.json');
      const fs = nodeFs(), path = nodePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(r.reel, null, 2) + '\n');
      const fresh = Object.keys(r.made ?? {}).filter((t) => r.reel.edit.some((e) => e.take === t));
      ctx.summary(`Wrote ${file}: ${r.reel.edit.length} shots${fresh.length ? `; capture ${fresh.join(', ')}` : ''}`);
      return { reel: id, file, capture: fresh.length ? `studio reel capture --takes ${fresh.join(',')}` : null, cut: 'studio reel cut' };
    },
  },
];
