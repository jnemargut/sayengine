// The reel module (Decision 32): a trailer is a cutscene-style file — takes (camera moves captured from
// the game itself, each with a look and a crop box per shape) plus an edit track (which take, how many
// beats, captions, titles) cut to the music's beats. Takes are captured once with handles; re-cutting
// (swap shots, change lengths, another shape) only re-runs the ffmpeg recipe.
import { z } from 'zod';

export const ASPECTS = ['16:9', '1:1', '9:16'] as const;
export type Aspect = typeof ASPECTS[number];
export const OUTPUT: Record<Aspect, [number, number]> = { '16:9': [1920, 1080], '1:1': [1080, 1080], '9:16': [1080, 1920] };
type V3 = [number, number, number];
const V3Z = z.tuple([z.number(), z.number(), z.number()]);
const Crop = z.object({ x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5), zoom: z.number().min(1).max(3).default(1) });

export const ReelZ = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  fps: z.number().int().min(12).max(60).default(30),
  size: z.number().int().min(256).max(2160).default(1440).describe('the square capture side in px; every shape is cropped from it'),
  takes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    look: z.string().nullable().default(null).describe('look preset for this take (day-toy, neon-night) or null for the game\'s own'),
    seconds: z.number().min(1).max(30).default(6).describe('take length: longer than any cut that uses it (handles)'),
    fov: z.number().min(10).max(110).default(70).describe('vertical fov of the square frame (a 16:9 crop sees ≈ 43° when this is 70)'),
    keys: z.array(z.object({ position: V3Z, target: V3Z, fov: z.number().optional() })).min(1).describe('camera keys spread evenly over the take (Catmull-Rom, eased)'),
    crop: z.partialRecord(z.enum(ASPECTS), Crop).default({}).describe('per shape: the crop box centre (0..1 of the square frame) and zoom'),
    note: z.string().optional(),
  })).min(1),
  edit: z.array(z.object({
    take: z.string(),
    beats: z.number().int().min(1).describe('shot length in beats (cuts land on beats)'),
    in: z.number().min(0).default(0.5).describe('seconds into the take where the shot starts'),
    caption: z.string().optional(),
    title: z.object({ text: z.string(), sub: z.string().optional() }).optional().describe('a big title card over the shot'),
  })).min(1),
  endCard: z.object({ beats: z.number().int().min(1), title: z.string(), sub: z.string().optional(), credit: z.string().optional() }).optional(),
  music: z.object({
    file: z.string().optional().describe('a WAV to cut to (else the generated track)'),
    seed: z.union([z.string(), z.number()]).default(1), mood: z.enum(['warm', 'night', 'forge', 'bright']).default('night'), bpm: z.number().default(128),
    sections: z.array(z.object({ bars: z.number().int().min(1), mix: z.record(z.string(), z.number()), riser: z.boolean().optional(), hit: z.boolean().optional(), label: z.string().optional() })).optional(),
  }).default({ seed: 1, mood: 'night', bpm: 128 }),
});
export type Reel = z.infer<typeof ReelZ>;
export const parseReel = (x: unknown): Reel => {
  const r = ReelZ.parse(x);
  for (const e of r.edit) if (!r.takes.some((t) => t.id === e.take)) throw new Error(`edit uses take "${e.take}", which isn't in takes (${r.takes.map((t) => t.id).join(', ')})`);
  return r;
};

// ── camera (the formula lives in camera.ts, so the live view can use it without zod) ──────────
export { cameraAt } from './camera.ts';
import { cameraAt } from './camera.ts';
/** One camera per frame for a take: [px, py, pz, tx, ty, tz, fov]. */
export function takeFrames(take: Reel['takes'][number], fps: number): number[][] {
  const n = Math.round(take.seconds * fps);
  return Array.from({ length: n }, (_, k) => { const c = cameraAt(take, n > 1 ? k / (n - 1) : 0); return [...c.position, ...c.target, c.fov].map((v) => +v.toFixed(4)); });
}

// ── the cut ────────────────────────────────────────────────────────────────────────────────────
export interface Shot { index: number; take: string; start: number; end: number; in: number; out: number; beatStart: number; beats: number; caption?: string; title?: { text: string; sub?: string }; snapErrorMs: number }
export interface Cut { shots: Shot[]; endCard: { start: number; end: number; title: string; sub?: string; credit?: string } | null; duration: number; beatsUsed: number; bpm: number; warnings: string[] }

/** Lay the edit on the detected beats: shot k starts on the beat where the shots before it end. Cut
 *  times are the detected beat times themselves (not a guessed grid), so every cut lands on a beat. */
export function cutToBeats(reel: Reel, beats: number[], opts: { startBeat?: number } = {}): Cut {
  const warnings: string[] = [];
  if (beats.length < 4) throw new Error('need at least 4 beats');
  const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const beatAt = (k: number) => (k < beats.length ? beats[k] : beats[beats.length - 1] + (k - beats.length + 1) * period);
  let b = opts.startBeat ?? 0;
  const shots: Shot[] = [];
  // the first shot starts at 0 (picture from the first frame), later cuts on beats
  for (const [i, e] of reel.edit.entries()) {
    const take = reel.takes.find((t) => t.id === e.take)!;
    const start = i === 0 ? 0 : beatAt(b), end = beatAt(b + e.beats), len = end - start;
    if (e.in + len > take.seconds + 1e-6) warnings.push(`shot ${i + 1} (${e.take}) needs ${(e.in + len).toFixed(2)} s of a ${take.seconds} s take: it will hold the last frame — capture the take longer or cut it shorter`);
    if (len < 0.9) warnings.push(`shot ${i + 1} is only ${len.toFixed(2)} s`);
    shots.push({ index: i + 1, take: e.take, start: +start.toFixed(4), end: +end.toFixed(4), in: e.in, out: +(e.in + len).toFixed(4), beatStart: b, beats: e.beats, ...(e.caption ? { caption: e.caption } : {}), ...(e.title ? { title: e.title } : {}), snapErrorMs: 0 });
    b += e.beats;
  }
  let endCard: Cut['endCard'] = null;
  if (reel.endCard) { endCard = { start: +beatAt(b).toFixed(4), end: +beatAt(b + reel.endCard.beats).toFixed(4), title: reel.endCard.title, sub: reel.endCard.sub, credit: reel.endCard.credit }; b += reel.endCard.beats; }
  const duration = endCard ? endCard.end : shots[shots.length - 1].end;
  return { shots, endCard, duration: +duration.toFixed(4), beatsUsed: b, bpm: +(60 / period).toFixed(2), warnings };
}

/** How far each cut is from the nearest beat (ms) — the check that the cut is on the music. */
export function cutErrors(cut: Cut, beats: number[]): number[] {
  const near = (t: number) => Math.min(...beats.map((b) => Math.abs(b - t)));
  return [...cut.shots.slice(1).map((s) => s.start), ...(cut.endCard ? [cut.endCard.start] : [])].map((t) => +(near(t) * 1000).toFixed(1));
}

/** The crop box in pixels of the square capture for a shape (clamped inside the frame, even sizes). */
export function cropBox(reel: Reel, takeId: string, aspect: Aspect): { w: number; h: number; x: number; y: number } {
  const take = reel.takes.find((t) => t.id === takeId)!;
  const c = Crop.parse(take.crop[aspect] ?? {});
  const S = reel.size, [ow, oh] = OUTPUT[aspect], r = ow / oh;
  let w = r >= 1 ? S : S * r, h = r >= 1 ? S / r : S;
  w /= c.zoom; h /= c.zoom;
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  w = even(w); h = even(h);
  const x = Math.round(Math.max(0, Math.min(S - w, c.x * S - w / 2))), y = Math.round(Math.max(0, Math.min(S - h, c.y * S - h / 2)));
  return { w, h, x, y };
}
