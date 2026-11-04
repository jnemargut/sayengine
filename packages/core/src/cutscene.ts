// Cutscenes (Decisions 24–25): a studio cutscene file — shots, each with a camera (a framing on the
// characters, not raw coordinates), the lines spoken and the actions played in it — resolved into a
// timeline both engine players read: camera keys per shot, clip cues per character, audio. Every
// set-shot is one reviewable step (keep or undo a shot), and checks catch the classic mistakes: a
// speaker out of frame, a cut in the middle of a word, the camera jumping across the line of action.
import { z } from 'zod';
import type { ToolDef, ToolCtx } from './tools.ts';
import type { SceneDoc, SceneObject, LineClip } from './types.ts';
import type { V3 } from './rig.ts';
import { bakeMotion } from './motion.ts';

export interface ShotCamera {
  framing: 'close' | 'medium' | 'wide' | 'two-shot' | 'over-shoulder' | 'custom';
  subject?: string;              // the character the shot is on (close, medium, over-shoulder)
  over?: string;                 // over-shoulder: whose shoulder we look over
  side?: 'left' | 'right';       // which side of the subject's face (close/medium) or the shoulder (OTS)
  move?: 'none' | 'push-in' | 'pull-out' | 'drift';
  fov?: number;                  // degrees (vertical); framings pick one
  position?: V3; target?: V3;    // custom framing
}
export interface CutsceneShot {
  id: string;
  camera: ShotCamera;
  lines?: Array<{ character: string; line: string; at?: number; to?: string }>;   // at: s into the shot (default: one after another); to: the listener
  actions?: Array<{ character: string; motion: string; at?: number }>;            // a motion clip (e.g. strike)
  duration?: number;             // s (default: until the last line/action ends + 0.5)
  events?: Array<{ at: number; name: string }>;                                   // named markers the game can react to
  engine?: { godot?: string; web?: string };                                     // escape hatch: code the engine runs at the shot's start
}
export interface Cutscene { id: string; title?: string; shots: CutsceneShot[] }

export interface CamKey { position: V3; target: V3; fov: number }
export interface TimelineCue { t: number; end: number; character: string; name: string; clip: string; kind: 'line' | 'motion'; audio?: string; text?: string; shot: string }
export interface Timeline {
  id: string; title?: string; duration: number;
  shots: Array<{ id: string; start: number; end: number; from: CamKey; to: CamKey; framing: string }>;
  cues: TimelineCue[];
  characters: Array<{ id: string; name: string; idle: string | null }>;
  events: Array<{ t: number; name: string; shot: string }>;
  engine: Array<{ t: number; shot: string; godot?: string; web?: string }>;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const r3 = (v: V3): V3 => v.map((x) => +x.toFixed(4)) as V3;

/** Where a character's head, chest and facing are in the world (from its rig and placement). */
export function characterFrame(studio: any, o: SceneObject) {
  const r = studio.evaluate(o);
  if (!r.ok || !r.rig) throw new Error(`${o.name} doesn't build`);
  const rig = r.rig.rig;
  const bone = (n: string) => rig.bones.find((b: any) => b.name === n)!.head as V3;
  const yaw = ((o.rotation ?? 0) * Math.PI) / 180;
  const toWorld = (p: V3): V3 => [o.position[0] + p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw), o.position[1] + p[1], o.position[2] - p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw)];
  const head = toWorld(add(bone('Head'), [0, 0.09 * rig.spec.s, 0.03 * rig.spec.s]));
  const chest = toWorld(bone('UpperChest'));
  const hips = toWorld(bone('Hips'));
  const facing: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  return { head, chest, hips, facing, height: rig.spec.s * 1.75, s: rig.spec.s };
}

/** The camera for a shot's framing, at the start and end of the shot (a move changes the end). */
export function frameShot(studio: any, doc: SceneDoc, cam: ShotCamera, cast: string[], lead: string[] = []): { from: CamKey; to: CamKey } {
  const C = (id: string) => characterFrame(studio, findChar(doc, id));
  const side = cam.side === 'left' ? 1 : -1;
  let from: CamKey;
  if (cam.framing === 'custom') {
    if (!cam.position || !cam.target) throw new Error('a custom framing needs --position and --target');
    from = { position: cam.position, target: cam.target, fov: cam.fov ?? 35 };
  } else if (cam.framing === 'wide' || cam.framing === 'two-shot') {
    const who = cast.length ? cast : Object.values(doc.objects).filter((o) => o.semanticType === 'character').map((o) => o.id);
    if (!who.length) throw new Error('no characters to frame');
    const fr = who.map(C);
    const mid = mul(fr.reduce((a, f) => add(a, cam.framing === 'wide' ? f.chest : f.head), [0, 0, 0] as V3), 1 / fr.length);
    let across: V3 = [1, 0, 0];
    if (fr.length >= 2) across = norm(sub(fr[1].head, fr[0].head));
    // look at them from the side they face (perpendicular to the line between them)
    let view: V3 = norm([-across[2], 0, across[0]]);
    // the side the characters face; when someone in the shot acts (a strike, a line), favour their
    // face: swing the view toward the front of the lead, so a wide never shows the actor's back
    const leads = lead.map(C);
    const facingSum = (leads.length ? leads : fr).reduce((a, f) => add(a, f.facing), [0, 0, 0] as V3);
    if (view[0] * facingSum[0] + view[2] * facingSum[2] < 0) view = mul(view, -1);
    if (leads.length && cam.framing === 'wide') view = norm(add(view, mul(norm(facingSum), 0.9)));
    if (cam.side === 'left') view = norm(add(view, mul(across, 0.45))); else if (cam.side === 'right') view = norm(sub(view, mul(across, 0.45)));
    const spread = fr.length >= 2 ? len(sub(fr[1].head, fr[0].head)) : 0.6;
    const fov = cam.fov ?? (cam.framing === 'wide' ? 40 : 34);
    const dist = cam.framing === 'wide' ? Math.max(4.2, spread * 2.4) : Math.max(2.1, spread * 1.6 + 0.9);
    const target: V3 = cam.framing === 'wide' ? add(mid, [0, -0.15, 0]) : add(mid, [0, -0.22, 0]);
    from = { position: add(add(target, mul(view, dist)), [0, cam.framing === 'wide' ? 0.55 : 0.12, 0]), target, fov };
  } else {
    if (!cam.subject) throw new Error(`a ${cam.framing} shot needs --subject (the character it's on)`);
    const S = C(cam.subject);
    if (cam.framing === 'over-shoulder') {
      if (!cam.over) throw new Error('an over-shoulder shot needs --over (whose shoulder)');
      const O = C(cam.over);
      const toS = norm(sub(S.head, O.head));
      const lat: V3 = norm([-toS[2], 0, toS[0]]);
      // behind and beside the listener's head, a little above the shoulder: their head and shoulder
      // fill a third of the frame, soft on the edge, the speaker framed past them
      const sh = add(add(O.head, mul(lat, side * -0.46 * O.s)), [0, -0.02 * O.s, 0]);
      from = { position: add(sh, mul(toS, -1.05 * O.s)), target: add(S.head, [0, -0.1 * S.s, 0]), fov: cam.fov ?? 30 };
    } else {
      // three-quarter on the face: toward the camera side, a little above the eyes
      const yawOff = (side * 28 * Math.PI) / 180;
      const f = S.facing;
      const dir: V3 = norm([f[0] * Math.cos(yawOff) + f[2] * Math.sin(yawOff), 0.06, -f[0] * Math.sin(yawOff) + f[2] * Math.cos(yawOff)]);
      const close = cam.framing === 'close';
      const target = close ? S.head : add(S.head, [0, -0.32 * S.s, 0]);
      from = { position: add(target, mul(dir, close ? 1.05 * S.s : 2.0 * S.s)), target, fov: cam.fov ?? (close ? 28 : 33) };
    }
  }
  const to: CamKey = { ...from, position: [...from.position] as V3, target: [...from.target] as V3 };
  const toward = sub(from.target, from.position);
  if (cam.move === 'push-in') to.position = add(from.position, mul(toward, 0.16));
  else if (cam.move === 'pull-out') to.position = add(from.position, mul(toward, -0.16));
  else if (cam.move === 'drift') { const lat = norm([-toward[2], 0, toward[0]]); to.position = add(from.position, mul(lat, 0.18)); to.target = add(from.target, mul(lat, 0.06)); }
  return { from: { ...from, position: r3(from.position), target: r3(from.target) }, to: { ...to, position: r3(to.position), target: r3(to.target) } };
}

export function findChar(doc: SceneDoc, ref: string): SceneObject {
  const o = doc.objects[ref] ?? Object.values(doc.objects).find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!o) throw new Error(`no object "${ref}" (characters: ${Object.values(doc.objects).filter((x) => x.semanticType === 'character').map((x) => x.id).join(', ') || 'none'})`);
  if (o.semanticType !== 'character') throw new Error(`${o.name} is not a character`);
  return o;
}

/** A motion clip's length, from its baked settings. */
function motionLength(studio: any, o: SceneObject, id: string): number {
  const spec = o.character?.motions?.[id];
  if (!spec) throw new Error(`${o.name} has no motion "${id}" (have: ${Object.keys(o.character?.motions ?? {}).join(', ') || 'none'})`);
  const r = studio.evaluate(o);
  return bakeMotion(id, spec, r.rig.rig, o.character).duration;
}

/** Resolve a cutscene into the timeline the players read. */
export function cutsceneTimeline(studio: any, doc: SceneDoc, cs: Cutscene): Timeline {
  let t = 0;
  const shots: Timeline['shots'] = [], cues: TimelineCue[] = [], events: Timeline['events'] = [], engine: Timeline['engine'] = [];
  const cast = new Set<string>();
  // the line of action between the two characters of the cutscene (when there are two)
  const two = [...new Set(cs.shots.flatMap((sh) => [...(sh.lines ?? []).map((l) => l.character), ...(sh.actions ?? []).map((a) => a.character), ...(sh.camera.subject ? [sh.camera.subject] : []), ...(sh.camera.over ? [sh.camera.over] : [])]).map((r) => { try { return findChar(doc, r).id; } catch { return r; } }))];
  let axis: { sideOf: (p: V3) => number; ref: number } | null = null;
  if (two.length === 2 && doc.objects[two[0]] && doc.objects[two[1]]) {
    const A = characterFrame(studio, doc.objects[two[0]]).head, B = characterFrame(studio, doc.objects[two[1]]).head;
    const ax = sub(B, A);
    axis = { sideOf: (p: V3) => Math.sign(ax[0] * (p[2] - A[2]) - ax[2] * (p[0] - A[0])), ref: 0 };
  }
  for (const sh of cs.shots) {
    let cursor = 0.25, end = 0;
    for (const l of sh.lines ?? []) {
      const o = findChar(doc, l.character);
      const line = o.character?.lines?.[l.line];
      if (!line) throw new Error(`${o.name} has no line "${l.line}" (have: ${Object.keys(o.character?.lines ?? {}).join(', ') || 'none'})`);
      const at = l.at ?? cursor;
      cues.push({ t: +(t + at).toFixed(3), end: +(t + at + line.duration).toFixed(3), character: o.id, name: o.name, clip: `line:${l.line}`, kind: 'line', audio: line.audio, text: line.text, shot: sh.id });
      cursor = at + line.duration + 0.35; end = Math.max(end, at + line.duration);
      cast.add(o.id);
    }
    for (const a of sh.actions ?? []) {
      const o = findChar(doc, a.character);
      const d = motionLength(studio, o, a.motion);
      const at = a.at ?? 0.2;
      cues.push({ t: +(t + at).toFixed(3), end: +(t + at + d).toFixed(3), character: o.id, name: o.name, clip: a.motion, kind: 'motion', shot: sh.id });
      end = Math.max(end, at + d);
      cast.add(o.id);
    }
    const dur = sh.duration ?? Math.max(1.5, end + 0.5);
    const castIds = [...new Set([...(sh.lines ?? []).map((l) => findChar(doc, l.character).id), ...(sh.actions ?? []).map((a) => findChar(doc, a.character).id), ...(sh.camera.subject ? [findChar(doc, sh.camera.subject).id] : []), ...(sh.camera.over ? [findChar(doc, sh.camera.over).id] : [])])];
    const castFor = castIds.length >= 2 ? castIds : Object.values(doc.objects).filter((o) => o.semanticType === 'character').map((o) => o.id);
    const leadIds = [...new Set([...(sh.actions ?? []).map((a) => findChar(doc, a.character).id), ...(sh.lines ?? []).map((l) => findChar(doc, l.character).id)])];
    let cam = frameShot(studio, doc, sh.camera, castFor, leadIds);
    // no side given: take the one that keeps the camera on the side of the line already established
    if (!sh.camera.side && sh.camera.framing !== 'custom' && axis) {
      const s0 = axis.sideOf(cam.from.position);
      if (axis.ref === 0) axis.ref = s0;
      else if (s0 !== 0 && s0 !== axis.ref) {
        const other = frameShot(studio, doc, { ...sh.camera, side: 'left' }, castFor, leadIds), other2 = frameShot(studio, doc, { ...sh.camera, side: 'right' }, castFor, leadIds);
        cam = axis.sideOf(other.from.position) === axis.ref ? other : axis.sideOf(other2.from.position) === axis.ref ? other2 : cam;
      }
    } else if (axis && axis.ref === 0) axis.ref = axis.sideOf(cam.from.position);
    shots.push({ id: sh.id, start: +t.toFixed(3), end: +(t + dur).toFixed(3), ...cam, framing: sh.camera.framing });
    for (const e of sh.events ?? []) events.push({ t: +(t + e.at).toFixed(3), name: e.name, shot: sh.id });
    if (sh.engine) engine.push({ t: +t.toFixed(3), shot: sh.id, ...sh.engine });
    t += dur;
  }
  const characters = Object.values(doc.objects).filter((o) => o.semanticType === 'character').map((o) => ({ id: o.id, name: o.name, idle: o.character?.motions?.idle ? 'idle' : null }));
  return { id: cs.id, ...(cs.title ? { title: cs.title } : {}), duration: +t.toFixed(3), shots, cues, characters, events, engine };
}

/** Project a world point into a camera's view: NDC x/y (−1..1 is in frame) and whether it's in front. */
export function project(cam: CamKey, p: V3, aspect = 16 / 9) {
  const f = norm(sub(cam.target, cam.position));
  const r = norm([-f[2], 0, f[0]]);                          // right = forward × up
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d = sub(p, cam.position);
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  const th = Math.tan(((cam.fov * Math.PI) / 180) / 2);
  const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * th * aspect), y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * th);
  return { x, y, front: z > 0.05 };
}

/** The silences inside a line (s), where a cut can fall without cutting a word. */
function pauses(line: LineClip): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (line.phonemes?.length) { for (let i = 0; i + 1 < line.phonemes.length; i++) if (line.phonemes[i + 1].start - line.phonemes[i].end >= 0.1) out.push([line.phonemes[i].end, line.phonemes[i + 1].start]); }
  else for (const c of line.cues) if (c.shape === 'X') out.push([c.start, c.end]);
  return out;
}

export interface CutsceneCheck { id: string; label: string; pass: boolean; detail: string }
/** The checks: the speaker is in frame, no cut lands mid-word, the camera keeps to one side of the two characters, nobody talks over themself. */
export function cutsceneChecks(studio: any, doc: SceneDoc, cs: Cutscene): CutsceneCheck[] {
  let tl: Timeline;
  try { tl = cutsceneTimeline(studio, doc, cs); } catch (e: any) { return [{ id: `cutscene-${cs.id}`, label: `Cutscene "${cs.id}"`, pass: false, detail: e.message }]; }
  const out: CutsceneCheck[] = [];
  // the speaker's face in frame while they speak (sampled through each shot their line overlaps)
  const missing: string[] = [];
  for (const c of tl.cues.filter((x) => x.kind === 'line')) {
    const o = doc.objects[c.character];
    const head = characterFrame(studio, o).head;
    for (const sh of tl.shots) {
      const a = Math.max(c.t, sh.start), b = Math.min(c.end, sh.end);
      if (b <= a) continue;
      const shot = cs.shots.find((x) => x.id === sh.id)!;
      if (shot.camera.framing === 'over-shoulder' && shot.camera.over && findChar(doc, shot.camera.over).id === o.id) continue;   // the listener's reverse: fine to hear them off-screen
      for (const u of [0, 0.5, 1]) {
        const k = (a + (b - a) * u - sh.start) / Math.max(1e-6, sh.end - sh.start);
        const cam: CamKey = { position: sh.from.position.map((x, i) => x + (sh.to.position[i] - x) * k) as V3, target: sh.from.target.map((x, i) => x + (sh.to.target[i] - x) * k) as V3, fov: sh.from.fov };
        const p = project(cam, head);
        if (!p.front || Math.abs(p.x) > 0.92 || Math.abs(p.y) > 0.92) { missing.push(`${c.name}'s face is out of frame in shot ${sh.id} while saying "${c.text}"`); break; }
      }
    }
  }
  out.push({ id: `cutscene-${cs.id}-framing`, label: `Cutscene "${cs.id}": speakers in frame`, pass: !missing.length, detail: missing.length ? [...new Set(missing)].join('; ') : `${tl.cues.filter((x) => x.kind === 'line').length} line(s), each speaker in frame` });
  // cuts: not in the middle of a word
  const midWord: string[] = [];
  for (const sh of tl.shots.slice(1)) {
    for (const c of tl.cues.filter((x) => x.kind === 'line' && x.t < sh.start - 0.02 && x.end > sh.start + 0.02)) {
      const line = doc.objects[c.character].character!.lines![c.clip.slice(5)];
      const u = sh.start - c.t;
      if (!pauses(line).some(([a, b]) => u >= a - 0.02 && u <= b + 0.02)) midWord.push(`the cut to ${sh.id} at ${sh.start.toFixed(2)} s falls inside a word of "${c.text}"`);
    }
  }
  out.push({ id: `cutscene-${cs.id}-cuts`, label: `Cutscene "${cs.id}": cuts between words`, pass: !midWord.length, detail: midWord.length ? midWord.join('; ') : `${Math.max(0, tl.shots.length - 1)} cut(s), none inside a word` });
  // the 180° rule: with two characters, every camera stays on the same side of the line between them
  const chars = tl.characters.filter((c) => tl.cues.some((q) => q.character === c.id) || cs.shots.some((s) => s.camera.subject === c.id || s.camera.over === c.id));
  if (chars.length === 2) {
    const A = characterFrame(studio, doc.objects[chars[0].id]).head, B = characterFrame(studio, doc.objects[chars[1].id]).head;
    const ax = sub(B, A);
    const sideOf = (p: V3) => Math.sign(ax[0] * (p[2] - A[2]) - ax[2] * (p[0] - A[0]));
    const sides = tl.shots.map((s) => ({ id: s.id, side: sideOf(s.from.position) }));
    const ref = sides.find((s) => s.side !== 0)?.side ?? 0;
    const crossed = sides.filter((s) => s.side !== 0 && s.side !== ref);
    out.push({ id: `cutscene-${cs.id}-axis`, label: `Cutscene "${cs.id}": the camera keeps one side (180° rule)`, pass: !crossed.length, detail: crossed.length ? `shot(s) ${crossed.map((s) => s.id).join(', ')} jump across the line between ${chars[0].name} and ${chars[1].name} (they'd seem to swap places)` : `every shot on one side of ${chars[0].name} ↔ ${chars[1].name}` });
  }
  // nobody talks over themself
  const over: string[] = [];
  for (const c of tl.cues.filter((x) => x.kind === 'line')) for (const d of tl.cues.filter((x) => x.kind === 'line' && x !== c && x.character === c.character)) if (d.t > c.t && d.t < c.end) over.push(`${c.name} starts "${d.text}" before finishing "${c.text}"`);
  out.push({ id: `cutscene-${cs.id}-lines`, label: `Cutscene "${cs.id}": lines and actions`, pass: !over.length, detail: over.length ? over.join('; ') : `${tl.shots.length} shot(s), ${tl.duration.toFixed(1)} s, ${tl.cues.length} cue(s)` });
  return out;
}

const Cam = z.object({
  framing: z.enum(['close', 'medium', 'wide', 'two-shot', 'over-shoulder', 'custom']),
  subject: z.string().optional(), over: z.string().optional(), side: z.enum(['left', 'right']).optional(),
  move: z.enum(['none', 'push-in', 'pull-out', 'drift']).optional(), fov: z.number().optional(),
  position: z.array(z.number()).length(3).optional(), target: z.array(z.number()).length(3).optional(),
});

function getCs(ctx: ToolCtx, id: string): Cutscene {
  const cs = (ctx.doc as any).cutscenes?.[id];
  if (!cs) throw new Error(`no cutscene "${id}" (have: ${Object.keys((ctx.doc as any).cutscenes ?? {}).join(', ') || 'none'}; studio new-cutscene)`);
  return cs;
}

/** Turn a performed line toward its listener (the yaw/pitch from the speaker's facing to the listener's head). */
function aimLine(ctx: ToolCtx, speaker: SceneObject, lineId: string, listenerRef: string | undefined, notes: string[]) {
  const line = speaker.character?.lines?.[lineId];
  if (!line?.performance || !listenerRef) return;
  const L = findChar(ctx.doc, listenerRef);
  const S = characterFrame(ctx.studio, speaker), T = characterFrame(ctx.studio, L);
  const d = sub(T.head, S.head);
  const yawW = Math.atan2(d[0], d[2]), yawF = Math.atan2(S.facing[0], S.facing[2]);
  let yaw = ((yawW - yawF) * 180) / Math.PI;
  while (yaw > 180) yaw -= 360; while (yaw < -180) yaw += 360;
  const pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  const look: [number, number] = [+Math.max(-60, Math.min(60, yaw)).toFixed(1), +Math.max(-30, Math.min(30, pitch)).toFixed(1)];
  const prev = line.performance.look;
  if (prev && prev[0] === look[0] && prev[1] === look[1]) return;
  ctx.set(['objects', speaker.id, 'character', 'lines', lineId, 'performance', 'look'], look);
  notes.push(`${speaker.name} looks at ${L.name} for "${lineId}" (${look[0]}°, ${look[1]}°)`);
}

export const CUTSCENE_TOOLS: ToolDef[] = [
  {
    name: 'new-cutscene', mode: 'create', mutates: true,
    description: 'Start a cutscene (Decision 24): a list of shots made with set-shot. Each shot frames characters (close, medium, two-shot, over-shoulder, wide), plays their lines (with their performances) and actions; both engine players read the same file.',
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), title: z.string().optional() }),
    run(ctx, a) {
      if ((ctx.doc as any).cutscenes?.[a.id]) throw new Error(`cutscene "${a.id}" exists`);
      ctx.set(['cutscenes'], { ...((ctx.doc as any).cutscenes ?? {}), [a.id]: { id: a.id, ...(a.title ? { title: a.title } : {}), shots: [] } });
      ctx.summary(`New cutscene "${a.title ?? a.id}"`);
      return { id: a.id };
    },
  },
  {
    name: 'set-shot', mode: 'modify', mutates: true,
    description: 'Add or change one shot of a cutscene (one reviewable step: keep or undo it in the review panel). --camera {framing, subject, over, side, move}; --lines [{character, line, at?, to?}] (to: the listener — a performed line turns its head and eyes to them); --actions [{character, motion, at?}]; --duration s (default: until the last line ends + 0.5 s); --after <shot id> to insert. Checks: speakers in frame, cuts between words, the 180° rule.',
    input: z.object({
      cutscene: z.string(), id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      camera: Cam.optional(),
      lines: z.array(z.object({ character: z.string(), line: z.string(), at: z.number().optional(), to: z.string().optional() })).optional(),
      actions: z.array(z.object({ character: z.string(), motion: z.string(), at: z.number().optional() })).optional(),
      duration: z.number().positive().optional(),
      events: z.array(z.object({ at: z.number(), name: z.string() })).optional(),
      engine: z.object({ godot: z.string().optional(), web: z.string().optional() }).optional(),
      after: z.string().optional(),
    }),
    example: `studio set-shot --cutscene forge-lesson --id s1 --camera '{"framing":"close","subject":"blacksmith","side":"right"}' --lines '[{"character":"blacksmith","line":"hold-still","to":"apprentice"}]'`,
    run(ctx, a) {
      const cs = getCs(ctx, a.cutscene);
      const shots = cs.shots.slice();
      const i = shots.findIndex((s) => s.id === a.id);
      const prev = i >= 0 ? shots[i] : null;
      if (!prev && !a.camera) throw new Error(`shot "${a.id}" is new: pass --camera (framing: close, medium, two-shot, over-shoulder, wide)`);
      const shot: CutsceneShot = { ...(prev ?? { id: a.id, camera: a.camera! }), ...(a.camera ? { camera: a.camera as ShotCamera } : {}), ...(a.lines ? { lines: a.lines } : {}), ...(a.actions ? { actions: a.actions } : {}), ...(a.duration ? { duration: a.duration } : {}), ...(a.events ? { events: a.events } : {}), ...(a.engine ? { engine: a.engine } : {}) };
      // validate references now (readable errors), and frame it
      for (const l of shot.lines ?? []) { const o = findChar(ctx.doc, l.character); if (!o.character?.lines?.[l.line]) throw new Error(`${o.name} has no line "${l.line}" (have: ${Object.keys(o.character?.lines ?? {}).join(', ') || 'none'})`); if (l.to) findChar(ctx.doc, l.to); }
      for (const x of shot.actions ?? []) { const o = findChar(ctx.doc, x.character); if (!o.character?.motions?.[x.motion]) throw new Error(`${o.name} has no motion "${x.motion}" (have: ${Object.keys(o.character?.motions ?? {}).join(', ')}; studio set-motion)`); }
      if (shot.camera.subject) findChar(ctx.doc, shot.camera.subject);
      if (shot.camera.over) findChar(ctx.doc, shot.camera.over);
      if (prev) shots[i] = shot;
      else if (a.after) { const j = shots.findIndex((s) => s.id === a.after); if (j < 0) throw new Error(`no shot "${a.after}"`); shots.splice(j + 1, 0, shot); }
      else shots.push(shot);
      const next = { ...cs, shots };
      const notes: string[] = [];
      for (const l of shot.lines ?? []) aimLine(ctx, findChar(ctx.doc, l.character), l.line, l.to, notes);
      ctx.set(['cutscenes', cs.id], next);
      const tl = cutsceneTimeline(ctx.studio, ctx.doc, next);
      const me = tl.shots.find((s) => s.id === a.id)!;
      const checks = cutsceneChecks(ctx.studio, ctx.doc, next);
      ctx.summary(`${cs.title ?? cs.id}: ${prev ? 'changed' : 'added'} shot ${a.id} (${shot.camera.framing}${shot.camera.subject ? ` on ${shot.camera.subject}` : ''}, ${(me.end - me.start).toFixed(1)} s${shot.lines?.length ? `, ${shot.lines.map((l) => l.line).join(' + ')}` : ''})`);
      return { shot: a.id, start: me.start, end: me.end, camera: { from: me.from, to: me.to }, cutscene: { shots: tl.shots.length, duration: tl.duration }, notes, checks };
    },
  },
  {
    name: 'remove-shot', mode: 'modify', mutates: true,
    description: 'Remove a shot from a cutscene.',
    input: z.object({ cutscene: z.string(), id: z.string() }),
    run(ctx, a) {
      const cs = getCs(ctx, a.cutscene);
      if (!cs.shots.some((s) => s.id === a.id)) throw new Error(`no shot "${a.id}" (shots: ${cs.shots.map((s) => s.id).join(', ')})`);
      ctx.set(['cutscenes', cs.id], { ...cs, shots: cs.shots.filter((s) => s.id !== a.id) });
      ctx.summary(`${cs.title ?? cs.id}: removed shot ${a.id}`);
      return { removed: a.id };
    },
  },
  {
    name: 'cutscene', mode: 'inspect', mutates: false,
    description: 'A cutscene as a timeline: shots with start/end and camera, the cues per character (lines, actions) and the checks. Without --id: the list of cutscenes.',
    input: z.object({ id: z.string().optional() }),
    run(ctx, a) {
      const all = (ctx.doc as any).cutscenes ?? {};
      if (!a.id) return { cutscenes: Object.values(all).map((c: any) => ({ id: c.id, title: c.title, shots: c.shots.length })) };
      const cs = getCs(ctx, a.id);
      return { timeline: cutsceneTimeline(ctx.studio, ctx.doc, cs), checks: cutsceneChecks(ctx.studio, ctx.doc, cs) };
    },
  },
];
