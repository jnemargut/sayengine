// Animate anything (Decisions 52–54) in the typed registry: creatures assembled from rig parts, their
// motions, and the motion checks with a failure timeline. Characters from the kit are part combos too
// (BODY_PLAN_PARTS); motion-checks runs the universal checks on their clips as well.
import { z } from 'zod';
import { freeSpot, type ToolDef } from './tools.ts';
import type { SceneObject } from './types.ts';
import { bakeCreature, buildCreature, creatureChecks, CHECK_LIMITS, type CreatureDef, type CreatureMotion, type MotionCheck, type PartSpec } from './rigparts.ts';
import { BODY_PLAN_PARTS, CREATURE_PRESETS, creatureFromPreset } from './creatures.ts';
import { bakeMotion, qAngle, type MotionClip } from './motion.ts';
import { qIdentity, type Rig, type V3 } from './rig.ts';

const ObjRef = z.string().optional().describe('object id or name (defaults to the only/last object)');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creature';

const PART_HELP = `Part kinds (each brings its own motion and checks):
  body    {kind:'body', shape:'box'|'ball'|'capsule', size:[w,h,l], height, color}
  legs    {kind:'legs', id, count:2|4|6|8, upper, lower, spread, radius, color, span?, kneeUp?, lift?, duty?} — gait for N legs, IK feet that plant, body rides the feet
  chain   {kind:'chain', id, at:[x,y,z], dir:[x,y,z], length, segments, r0, r1, color, motion:'wave'|'whip'|'coil'|'reach'|'serpent', plane:'yaw'|'pitch', amp, freq, target?, ground?, wavelength?} — tails, tentacles, necks, snakes
  wheels  {kind:'wheels', id, axles:[{z, track, r, w}], ride, travel, hz?, damp?, color} — roll at ground speed, springy suspension
  hinge   {kind:'hinge', id, parent?, at, axis, shapes:[{shape, color}], motion:{kind:'spin',rpm}|{kind:'swing',min,max,period}|{kind:'still'}, limit?:{min,max}}
  slider  {kind:'slider', id, parent?, at, axis, range:[a,b], period, shapes}
  spring  {kind:'spring', id, parent?, at, dir, length, r, color, hz?, damp?} — antennae, ears, aerials: lag and settle
  sway    {kind:'sway', id, area:[x0,z0,x1,z1], count, height, color, wind?, strength?} — grass and flags
Shapes: {kind:'box',c,size} {kind:'seg',a,b,r1,r2} {kind:'ball',c,r} {kind:'wheel',c,r,w} {kind:'blade',a,b,w}. Object space, faces +Z, y up, ground y = 0.`;

function asCreature(o: SceneObject): SceneObject {
  if (!o.creature) throw new Error(`${o.name} is not a creature (make one with studio new-creature)`);
  return o;
}

/** Universal checks on a character kit clip (the body plans are part combos: legs ×2 or ×4, spine…). */
export function characterMotionChecks(rig: Rig, clip: MotionClip): MotionCheck[] {
  const F = clip.frames + 1;
  const out: MotionCheck[] = [];
  const ranges = (bad: boolean[]) => { const r: Array<[number, number]> = []; let s = -1; bad.forEach((b, i) => { if (b && s < 0) s = i; if (!b && s >= 0) { r.push([s, i - 1]); s = -1; } }); if (s >= 0) r.push([s, bad.length - 1]); return r; };
  const height = Math.max(...rig.bones.map((b) => Math.max(b.head[1], b.tail[1])));
  // contacts: planned feet (in place) + travel must stay put while planted
  const bad = new Array(F).fill(false);
  let worst = 0;
  const dirZ = (clip.settings as any)?.backward ? -1 : 1;
  for (const side of ['left', 'right'] as const) {
    const feet = clip.feet?.[side], down = clip.contacts?.[side];
    if (!feet || !down) continue;
    for (let f = 1; f < F && f < feet.length; f++) {
      if (!down[f] || !down[f - 1]) continue;
      const dz = feet[f][2] - feet[f - 1][2] + (dirZ * clip.speed) / clip.fps, dx = feet[f][0] - feet[f - 1][0];
      const d = Math.hypot(dx, dz);
      if (d > height * CHECK_LIMITS.slide / 4) bad[f] = true;
      worst = Math.max(worst, d);
    }
  }
  out.push({ name: 'feet planted (no sliding)', part: 'legs', pass: !bad.some(Boolean), worst: +worst.toFixed(4), limit: +(height * CHECK_LIMITS.slide / 4).toFixed(4), unit: 'm/frame', frames: ranges(bad), detail: 'planted feet stay where they landed' });
  // pops
  const pb = new Array(F).fill(false);
  let pw = 0, who = '';
  const face = /Lid|Eye|Brow|Jaw|Lip|Mouth|Tongue|Cheek|Ear/;   // blinks and visemes are fast on purpose
  for (let b = 0; b < rig.bones.length; b++) for (let f = 1; f < F && f < clip.local.length; f++) {
    if (face.test(rig.bones[b].name)) continue;
    const w = qAngle(clip.local[f - 1][b], clip.local[f][b]) * clip.fps;
    if (w > CHECK_LIMITS.popDegPerS * 1.4) { pb[f] = true; if (w > pw) { pw = w; who = rig.bones[b].name; } }
  }
  out.push({ name: 'no pops (joint speed)', pass: !pb.some(Boolean), worst: Math.round(pw), limit: CHECK_LIMITS.popDegPerS * 1.4, unit: '°/s', frames: ranges(pb), detail: who ? `fastest: ${who}` : 'no joint turns faster than it can' });
  if (clip.loop) {
    let wd = 0;
    for (let b = 0; b < rig.bones.length; b++) wd = Math.max(wd, qAngle(clip.local[0][b], clip.local[clip.frames][b]));
    out.push({ name: 'loop closes', pass: wd <= CHECK_LIMITS.loopDeg, worst: +wd.toFixed(2), limit: CHECK_LIMITS.loopDeg, unit: '°', frames: wd <= CHECK_LIMITS.loopDeg ? [] : [[clip.frames, clip.frames]], detail: 'last frame vs first' });
  }
  void qIdentity;
  return out;
}

export const PART_TOOLS: ToolDef[] = [
  {
    name: 'new-creature', mode: 'create', mutates: true,
    description: `Make anything that moves from rig parts (Decision 52 A): legs ×N, chains (tails, tentacles, snakes), wheels with suspension, hinges and sliders with limits, springs, swaying grass. Each part brings its own procedural motion and checks. --preset ${Object.keys(CREATURE_PRESETS).join('|')} starts from a ready combo, or --parts '[…]' builds your own. --motions '{"walk":{"kind":"walk","speed":0.4}}' (kinds: walk, idle, drive, slither, still; dir [x,y,z] to walk sideways). Then studio creature-preview --video true to watch it, and motion-checks for the timeline.\n${PART_HELP}`,
    input: z.object({
      name: z.string().optional(), id: z.string().optional(), preset: z.enum(Object.keys(CREATURE_PRESETS) as [string, ...string[]]).optional(),
      parts: z.array(z.record(z.string(), z.any())).optional().describe('part specs (see the description)'),
      motions: z.record(z.string(), z.object({ kind: z.enum(['walk', 'idle', 'drive', 'slither', 'still']), speed: z.number().optional(), dir: z.tuple([z.number(), z.number(), z.number()]).optional(), duration: z.number().optional(), energy: z.number().optional() })).optional(),
      terrain: z.object({ period: z.number(), bumps: z.array(z.object({ amp: z.number(), k: z.number(), phase: z.number().optional(), kx: z.number().optional() })) }).optional(),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
    example: `studio new-creature --preset crab   ·   studio new-creature --name "Jelly" --parts '[{"kind":"body","shape":"ball","size":[0.4,0.3,0.4],"height":1,"color":"#c9a3e0"},{"kind":"chain","id":"t1","at":[0.1,0.85,0],"dir":[0,-1,0],"length":0.6,"segments":6,"r0":0.03,"r1":0.008,"color":"#b58ad0","motion":"wave","plane":"pitch"}]'`,
    run(ctx, a) {
      let def: CreatureDef, motions: Record<string, CreatureMotion>;
      if (a.preset) { const p = creatureFromPreset(a.preset); def = p.def; motions = p.motions; }
      else if (a.parts) { def = { name: a.name ?? 'Creature', parts: a.parts as unknown as PartSpec[] }; motions = { idle: { kind: 'idle', duration: 3 } }; }
      else throw new Error('--preset or --parts');
      if (a.name) def = { ...def, name: a.name };
      if (a.terrain) def = { ...def, terrain: a.terrain };
      if (a.motions) motions = { ...(a.preset ? {} : motions), ...(a.motions as Record<string, CreatureMotion>) };
      const c = buildCreature(def);                 // validates the parts
      const checks: Record<string, { pass: boolean; failing: string[] }> = {};
      for (const [mid, m] of Object.entries(motions)) {
        const k = creatureChecks(c, bakeCreature(c, mid, m));
        checks[mid] = { pass: k.every((x) => x.pass), failing: k.filter((x) => !x.pass).map((x) => x.name) };
      }
      let id = a.id ?? slug(def.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const obj: SceneObject = {
        id, name: def.name, semanticType: 'creature', params: {},
        ops: { body: { id: 'body', op: 'creature', args: {}, part: 'body' } }, opOrder: ['body'], output: 'body',
        material: { name: 'creature', color: '#9a8f78', roughness: 0.8, metalness: 0 } as any,
        partMaterials: [...new Map(c.pieces.map((p) => [p.part, p.color])).entries()].map(([part, color]) => ({ parts: part, material: { name: part, color, roughness: 0.75, metalness: 0 } as any })),
        position: a.position ?? freeSpot(ctx as any), creature: { def, motions, ...(a.preset ? { preset: a.preset } : {}) }, rules: [],
      };
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      const kinds = c.parts.map((p) => (p.spec.kind === 'legs' ? `legs ×${(p.spec as any).count}` : p.spec.kind));
      ctx.summary(`Created ${def.name}: ${kinds.join(' + ')} — ${c.bones.length} bones; motions ${Object.keys(motions).join(', ')}${Object.values(checks).every((x) => x.pass) ? ' (all motion checks pass)' : ' (some motion checks fail: studio motion-checks)'}`);
      return { id, parts: kinds, bones: c.bones.length, motions: Object.keys(motions), checks, next: `studio creature-preview --object ${id} --video true` };
    },
  },
  {
    name: 'add-part', mode: 'modify', mutates: true,
    description: `Add a rig part to a creature (Decision 52): "give it a whip tail" is one chain part. --part '{…}'. ${PART_HELP}`,
    input: z.object({ object: ObjRef, part: z.record(z.string(), z.any()) }),
    example: `studio add-part --object robot-crab --part '{"kind":"spring","id":"flag","at":[0,0.35,-0.1],"dir":[0,1,0],"length":0.3,"r":0.006,"color":"#d9603b"}'`,
    run(ctx, a) {
      const o = asCreature(ctx.obj(a.object));
      const def: CreatureDef = { ...o.creature!.def, parts: [...o.creature!.def.parts, a.part as unknown as PartSpec] };
      const c = buildCreature(def);
      ctx.set(['objects', o.id, 'creature'], { ...o.creature!, def });
      ctx.summary(`${o.name}: added a ${(a.part as any).kind} part${(a.part as any).id ? ` "${(a.part as any).id}"` : ''} (${c.bones.length} bones)`);
      return { parts: c.parts.map((p) => p.spec.kind), bones: c.bones.length };
    },
  },
  {
    name: 'set-creature-motion', mode: 'modify', mutates: true,
    description: 'Add or change a creature motion: --id walk --kind walk|idle|drive|slither|still [--speed m/s] [--dir x,y,z] [--duration s] [--energy 0..1]. Gaits, rolling, slithering and swaying come from the parts; the checks run on the result.',
    input: z.object({ object: ObjRef, id: z.string(), kind: z.enum(['walk', 'idle', 'drive', 'slither', 'still']), speed: z.number().optional(), dir: z.tuple([z.number(), z.number(), z.number()]).optional(), duration: z.number().optional(), energy: z.number().min(0).max(1).optional() }),
    example: `studio set-creature-motion --object robot-crab --id scuttle --kind walk --speed 0.5 --dir '[1,0,0]'`,
    run(ctx, a) {
      const o = asCreature(ctx.obj(a.object));
      const m: CreatureMotion = { kind: a.kind, ...(a.speed !== undefined ? { speed: a.speed } : {}), ...(a.dir ? { dir: a.dir as V3 } : {}), ...(a.duration ? { duration: a.duration } : {}), ...(a.energy !== undefined ? { energy: a.energy } : {}) };
      const c = buildCreature(o.creature!.def);
      const k = creatureChecks(c, bakeCreature(c, a.id, m));
      ctx.set(['objects', o.id, 'creature'], { ...o.creature!, motions: { ...o.creature!.motions, [a.id]: m } });
      const failing = k.filter((x) => !x.pass);
      ctx.summary(`${o.name}: motion "${a.id}" (${a.kind}) — ${failing.length ? `${failing.length} check(s) fail: ${failing.map((x) => x.name).join(', ')}` : 'all checks pass'}`);
      return { checks: k };
    },
  },
  {
    name: 'motion-checks', mode: 'inspect', mutates: false,
    description: 'The motion checks (Decision 54): each part\'s own (feet planted, wheels roll at ground speed, suspension travel, belly slides along the body…) plus the universal ones (nothing passes through the ground or itself, balance over the feet, joint limits, no pops or jolts, loops close, one-offs end in idle). Each failure lists its frame ranges: a timeline of where it breaks. Works on creatures and on kit characters (their walk/run clips). [--object id] [--motion id]',
    input: z.object({ object: ObjRef, motion: z.string().optional() }),
    example: `studio motion-checks --object robot-crab`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const result: Record<string, MotionCheck[]> = {};
      if (o.creature) {
        const c = buildCreature(o.creature.def);
        for (const [mid, m] of Object.entries(o.creature.motions)) if (!a.motion || a.motion === mid) result[mid] = creatureChecks(c, bakeCreature(c, mid, m));
      } else if (o.character?.motions) {
        const r = ctx.studio.evaluate(o);
        if (!r.rig) throw new Error(`${o.name} does not build`);
        for (const [mid, spec] of Object.entries(o.character.motions)) if (!a.motion || a.motion === mid) result[mid] = characterMotionChecks(r.rig.rig, bakeMotion(mid, spec, r.rig.rig, o.character));
      } else throw new Error(`${o.name} has no motions`);
      const failing = Object.entries(result).flatMap(([mid, ks]) => ks.filter((k) => !k.pass).map((k) => `${mid}: ${k.name} (frames ${k.frames.map(([s, e]) => (s === e ? `${s}` : `${s}–${e}`)).join(', ')})`));
      ctx.summary(failing.length ? `${failing.length} failing: ${failing.slice(0, 4).join('; ')}` : `${Object.keys(result).length} motion(s), every check passes`);
      return { checks: result, ...(o.character ? { parts: BODY_PLAN_PARTS[(o.ops.body?.args as any)?.plan ?? 'human'] } : {}) };
    },
  },
];
