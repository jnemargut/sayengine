// Animate anything (Decisions 52–54) in the typed registry: creatures assembled from rig parts, their
// motions, and the motion checks with a failure timeline. Characters from the kit are part combos too
// (BODY_PLAN_PARTS); motion-checks runs the universal checks on their clips as well.
import { z } from 'zod';
import { freeSpot, type ToolDef } from './tools.ts';
import type { SceneObject } from './types.ts';
import { bakeCreature, buildCreature, creatureChecks, CHECK_LIMITS, type CreatureDef, type CreatureMotion, type MotionCheck, type PartSpec } from './rigparts.ts';
import { BODY_PLAN_PARTS, CREATURE_PRESETS, creatureFromPreset } from './creatures.ts';
import { applyNotes, describeAction } from './actions.ts';
import { bakeMotion, clipPose, motionReport, qAngle, type MotionClip } from './motion.ts';
import { qIdentity, qRot, type Rig, type V3 } from './rig.ts';

const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

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
  wing    {kind:'wing', id, at:[x,y,z] (left shoulder), length, chord, color, tipColor?, flapHz?, stroke?} — a mirrored pair: fold, flap, glide, hover; beat rate and flight cycle from the proportions
  fin     {kind:'fin', id, parent?, at, dir, length, width, taper?, normal?, mirror?, motion:'flutter'|'still', amp?} — tail fins, dorsals, pectorals
  prop    {kind:'prop', id, at (grip point), shapes, surface?, parent?, fx?:{hide}} — things an action picks up (a teapot), stands on (a table) or shows (a tea stream)
  (chain motion 'swim' with swim:'fish'|'eel' makes a swimming body; 'curl' curls arms upward)
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
  // contacts: whichever of heel and ball is on the floor stays put (the ground moves back at the clip's speed)
  const bad = new Array(F).fill(false);
  let worst = 0;
  if (!rig.spec.quad) {
    const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
    const s = rig.spec.s;
    const prev: Record<string, V3 | null> = {};
    for (let f = 0; f < F; f++) {
      const P = clipPose(rig, clip, f);
      for (const side of ['Left', 'Right'] as const) {
        const fi = idx.get(`${side}Foot`)!, ti = idx.get(`${side}Toes`)!;
        const ft = rig.bones[fi], toe = rig.bones[ti];
        const heelRest: V3 = [ft.head[0], 0, ft.head[2] - 0.035 * s], ballRest: V3 = [toe.head[0], 0, toe.head[2]];
        const heel = vadd(P.worldP[fi], qRot(P.worldQ[fi], vsub(heelRest, ft.head)));
        const ball = vadd(P.worldP[ti], qRot(P.worldQ[ti], vsub(ballRest, toe.head)));
        const down = (side === 'Left' ? clip.contacts.left : clip.contacts.right)[Math.min(f, clip.frames)];
        for (const [key, pt] of [[`${side}heel`, heel], [`${side}ball`, ball]] as const) {
          const onFloor = down && pt[1] < 0.006 * s;
          const g: V3 = [pt[0], 0, pt[2] + (clip.speed * f) / clip.fps];
          if (onFloor && prev[key]) {
            const d = Math.hypot(g[0] - prev[key]![0], g[2] - prev[key]![2]) * clip.fps;
            if (d > height * CHECK_LIMITS.slide) bad[f] = true;
            worst = Math.max(worst, d);
          }
          prev[key] = onFloor ? g : null;
        }
      }
    }
  } else {
    const r = motionReport(rig, clip);
    if (!r.pass) bad.fill(true);
    worst = r.slip;
  }
  out.push({ name: 'leg reach', part: 'legs', pass: clip.reachMiss <= 0.01 * rig.spec.s, worst: +clip.reachMiss.toFixed(4), limit: +(0.01 * rig.spec.s).toFixed(4), unit: 'm', frames: clip.reachMiss <= 0.01 * rig.spec.s ? [] : [[0, F - 1]], detail: 'planted feet are within the legs\' reach' });
  out.push({ name: 'feet planted (no sliding)', part: 'legs', pass: !bad.some(Boolean), worst: +worst.toFixed(4), limit: +(height * CHECK_LIMITS.slide).toFixed(4), unit: 'm/s', frames: ranges(bad), detail: 'planted feet stay where they landed' });
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

const ACTION_HELP = `Key moments (Decision 53): a list of {t, label, ease?, body?, reach?, hold?, props?, wings?, legs?, spin?, creak?, fx?}. Everything carries forward until a later key changes it.
  t        seconds; label names the moment ("grab the handle", "pour") so notes can refer to it; ease: smooth|in|out|back|linear (the move into this key)
  body     {at:[x,y,z] offset from rest (m), turn, pitch (+ nose down), roll} degrees
  reach    {chainId: [x,y,z] | null}: where a chain's tip goes (object space, the creature faces +Z); null hands it back to its own motion. FABRIK solves the chain
  hold     {propId: chainId | null}: from this key the prop rides that chain's tip (keep the tip on the prop's grip point first); null lets go
  props    {propId: {tilt: deg, axis: [x,y,z]}}: tilt a prop about its grip point (pour)
  wings    fold | flap | glide | hover | spread;  legs: plant (feet under the body; a foot that can't reach lifts) | tuck (flight)
  spin     {hingeId: rpm} keyed speeds, integrated (ease 'out' into rpm 0 winds it down); creak 0..1: stick-slip judder
  fx       {effectPropId: true|false}: show/hide an effect prop (the tea stream)
Then: style {tempo, weight 0..1, size}; notes in words ("slower", "more weight", "hold the pour longer") with action-note.`;

/** Bake one motion and its checks (for tool output). */
function bakeAndCheck(def: CreatureDef, id: string, m: CreatureMotion) {
  const c = buildCreature(def);
  const clip = bakeCreature(c, id, m);
  const checks = creatureChecks(c, clip);
  return { c, clip, checks, failing: checks.filter((k) => !k.pass) };
}

export const PART_TOOLS: ToolDef[] = [
  {
    name: 'new-creature', mode: 'create', mutates: true,
    description: `Make anything that moves from rig parts (Decision 52 A): legs ×N, chains (tails, tentacles, snakes), wheels with suspension, hinges and sliders with limits, springs, swaying grass. Each part brings its own procedural motion and checks. --preset ${Object.keys(CREATURE_PRESETS).join('|')} starts from a ready combo, or --parts '[…]' builds your own. --motions '{"walk":{"kind":"walk","speed":0.4}}' (kinds: walk, idle, drive, slither, still, fly, glide, hover, swim; dir [x,y,z] to walk sideways). Then studio creature-preview --video true to watch it, and motion-checks for the timeline.\n${PART_HELP}`,
    input: z.object({
      name: z.string().optional(), id: z.string().optional(), preset: z.enum(Object.keys(CREATURE_PRESETS) as [string, ...string[]]).optional(),
      parts: z.array(z.record(z.string(), z.any())).optional().describe('part specs (see the description)'),
      motions: z.record(z.string(), z.object({ kind: z.enum(['walk', 'idle', 'drive', 'slither', 'still', 'fly', 'glide', 'hover', 'swim']), speed: z.number().optional(), dir: z.tuple([z.number(), z.number(), z.number()]).optional(), duration: z.number().optional(), energy: z.number().optional(), altitude: z.number().optional() })).optional(),
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
    description: 'Add or change a creature motion: --id walk --kind walk|idle|drive|slither|still|fly|glide|hover|swim [--speed m/s] [--dir x,y,z] [--duration s] [--energy 0..1] [--altitude m]. Gaits, rolling, slithering, flight (beat rate, stroke and flap/glide bursts from the wing proportions), swimming (a body wave from the length and speed) and swaying come from the parts; the checks run on the result. One-off actions: perform-action.',
    input: z.object({ object: ObjRef, id: z.string(), kind: z.enum(['walk', 'idle', 'drive', 'slither', 'still', 'fly', 'glide', 'hover', 'swim']), speed: z.number().optional(), dir: z.tuple([z.number(), z.number(), z.number()]).optional(), duration: z.number().optional(), energy: z.number().min(0).max(1).optional(), altitude: z.number().optional() }),
    example: `studio set-creature-motion --object robot-crab --id scuttle --kind walk --speed 0.5 --dir '[1,0,0]'`,
    run(ctx, a) {
      const o = asCreature(ctx.obj(a.object));
      const m: CreatureMotion = { kind: a.kind, ...(a.speed !== undefined ? { speed: a.speed } : {}), ...(a.dir ? { dir: a.dir as V3 } : {}), ...(a.duration ? { duration: a.duration } : {}), ...(a.energy !== undefined ? { energy: a.energy } : {}), ...(a.altitude !== undefined ? { altitude: a.altitude } : {}) };
      const c = buildCreature(o.creature!.def);
      const k = creatureChecks(c, bakeCreature(c, a.id, m));
      ctx.set(['objects', o.id, 'creature'], { ...o.creature!, motions: { ...o.creature!.motions, [a.id]: m } });
      const failing = k.filter((x) => !x.pass);
      ctx.summary(`${o.name}: motion "${a.id}" (${a.kind}) — ${failing.length ? `${failing.length} check(s) fail: ${failing.map((x) => x.name).join(', ')}` : 'all checks pass'}`);
      return { checks: k };
    },
  },
  {
    name: 'perform-action', mode: 'modify', mutates: true,
    description: `A one-off action (Decision 53): "the octopus pours tea". You write the key moments as part goals; the studio solves every frame on top of the creature's idle (FABRIK for reaching chains, IK legs, wing poses blended between modes, spin integrated from keyed speeds), adds weight with a follow-through spring, and runs the universal motion checks plus the props' (held props stay in the grip; let go, they rest on something). The result is a motion like any other: creature-preview --motions <id> --video true gives the clip and a still at every key moment. Then action-note steers it in words. On a kit character the keys are the character action format ({at: 0..1, bones, drop, shift, yaw, pitch, feet, hands}) with --duration; see the studio skill.\n${ACTION_HELP}`,
    input: z.object({ object: ObjRef, action: z.string().describe('what happens, in words: "the octopus pours tea"'), id: z.string().optional(), keys: z.array(z.record(z.string(), z.any())), style: z.object({ tempo: z.number().optional(), weight: z.number().optional(), size: z.number().optional() }).optional(), notes: z.array(z.string()).optional(), duration: z.number().optional() }),
    example: `studio perform-action --object octopus --action "the octopus pours tea" --keys '[{"t":0,"label":"start"},{"t":1.2,"label":"grab the handle","reach":{"arm1":[0.14,0.255,0.645]}},{"t":1.5,"label":"grip","hold":{"teapot":"arm1"}},{"t":2.4,"label":"lift","reach":{"arm1":[0.06,0.42,0.63]}},{"t":3.2,"label":"pour","props":{"teapot":{"tilt":45,"axis":[0,0,1]}},"fx":{"tea":true}}]'`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const id = a.id ?? slug(a.action).split('-').filter((w: string) => !['the', 'a', 'an'].includes(w)).slice(0, 4).join('-');
      if (o.character) {
        const spec: any = { kind: 'action', label: a.action, keys: a.keys, ...(a.duration ? { duration: a.duration } : {}), ...(a.notes ? { notes: a.notes } : {}) };
        ctx.set(['objects', o.id, 'character', 'motions'], { ...(o.character.motions ?? {}), [id]: spec });
        const r = ctx.studio.evaluate(ctx.doc.objects[o.id]);
        if (!r.rig) throw new Error(`${o.name} does not build`);
        const clip = bakeMotion(id, spec, r.rig.rig, ctx.doc.objects[o.id].character);
        const checks = characterMotionChecks(r.rig.rig, clip);
        const failing = checks.filter((k) => !k.pass);
        ctx.summary(`${o.name}: action "${a.action}" as motion "${id}" (${clip.duration.toFixed(2)} s) — ${failing.length ? `failing: ${failing.map((k) => k.name).join(', ')}` : 'every motion check passes'}`);
        return { id, duration: clip.duration, checks, next: `studio motion-preview --object ${o.id} --motions ${id} --video true` };
      }
      const cr = asCreature(o).creature!;
      const m: CreatureMotion = { kind: 'action', action: { label: a.action, keys: a.keys as any, ...(a.style ? { style: a.style } : {}), ...(a.notes ? { notes: a.notes } : {}) } };
      const { clip, checks, failing } = bakeAndCheck(cr.def, id, m);
      ctx.set(['objects', o.id, 'creature'], { ...cr, motions: { ...cr.motions, [id]: m } });
      ctx.summary(`${o.name}: "${a.action}" as motion "${id}" — ${describeAction(clip)} — ${failing.length ? `${failing.length} check(s) fail: ${failing.map((k) => `${k.name} (frames ${k.frames.map(([x, y]) => (x === y ? x : `${x}–${y}`)).join(',')})`).join('; ')}` : 'every motion check passes'}`);
      return { id, duration: clip.duration, keys: clip.keys, notes: clip.notes, checks, next: `studio creature-preview --object ${o.id} --motions ${id} --video true` };
    },
  },
  {
    name: 'action-note', mode: 'modify', mutates: true,
    description: 'Steer an action in words (Decision 53): "slower", "much faster", "more weight" (more lag, overshoot and settle), "lighter", "bigger", "subtler", "snappier", "hold the pour longer", "pause before the lift". Notes stack in order and re-solve the action; the checks run again. --clear true drops every note. Kit characters: slower/faster change the duration, hold/pause stretch the keys.',
    input: z.object({ object: ObjRef, motion: z.string(), note: z.string().optional(), clear: z.boolean().optional() }),
    example: `studio action-note --object octopus --motion octopus-pours-tea --note "slower, more weight"`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (o.character) {
        const spec: any = o.character.motions?.[a.motion];
        if (!spec || spec.kind !== 'action') throw new Error(`${o.name} has no action "${a.motion}"`);
        const notes = a.clear ? [] : [...(spec.notes ?? []), ...(a.note ? [a.note] : [])];
        ctx.set(['objects', o.id, 'character', 'motions', a.motion], { ...spec, notes });
        const r = ctx.studio.evaluate(ctx.doc.objects[o.id]);
        const clip = bakeMotion(a.motion, { ...spec, notes }, r.rig!.rig, ctx.doc.objects[o.id].character);
        const checks = characterMotionChecks(r.rig!.rig, clip);
        ctx.summary(`${o.name} "${a.motion}": ${notes.length ? notes.join('; ') : 'no notes'} → ${clip.duration.toFixed(2)} s`);
        return { notes, duration: clip.duration, checks };
      }
      const cr = asCreature(o).creature!;
      const m = cr.motions[a.motion];
      if (!m || m.kind !== 'action' || !m.action) throw new Error(`${o.name} has no action "${a.motion}" (actions: ${Object.entries(cr.motions).filter(([, x]) => x.kind === 'action').map(([k]) => k).join(', ') || 'none'})`);
      const notes = a.clear ? [] : [...(m.action.notes ?? []), ...(a.note ? [a.note] : [])];
      const next: CreatureMotion = { ...m, action: { ...m.action, notes } };
      const { changes } = applyNotes(next.action!);
      const { clip, checks, failing } = bakeAndCheck(cr.def, a.motion, next);
      ctx.set(['objects', o.id, 'creature'], { ...cr, motions: { ...cr.motions, [a.motion]: next } });
      ctx.summary(`${o.name} "${a.motion}": ${changes.join(', ') || 'no notes'} → ${clip.duration.toFixed(2)} s; ${failing.length ? `failing: ${failing.map((k) => k.name).join(', ')}` : 'every check passes'}`);
      return { notes, changes, duration: clip.duration, keys: clip.keys, checks };
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
