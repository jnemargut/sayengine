// Character tools (Decisions 14, 19–22): make a kit character, set its expression, pose and hands,
// give props a grip and put them in a hand, inspect pose checks, record spoken lines. Every call is a
// normal, reviewable step. The face shapes, bones and named hand poses live in rig.ts.
import { z } from 'zod';
import { freeSpot, type ToolDef } from './tools.ts';
import type { CharacterState, GripSocket, HandPose, LineClip, Material, SceneObject } from './types.ts';
import { CHAR_DEFAULTS, EXPRESSIONS, NAMED_HAND_POSES, SHAPE_KEYS, VISEMES, characterSpec, charParams, weightReport, type V3 } from './rig.ts';
import { autoGrip, fitGrip, heldPlacement } from './grip.ts';
import { placeVerts } from './kernel.ts';

const ObjRef = z.string().optional().describe('object id or name (defaults to the only/last object)');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';
const r2 = (x: number) => +x.toFixed(2);

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return d[a.length][b.length];
}
const closest = (x: string, list: readonly string[]) => [...list].sort((a, b) => lev(x, a) - lev(x, b)).slice(0, 3);

function asCharacter(o: SceneObject): SceneObject {
  if (o.semanticType !== 'character') throw new Error(`${o.name} is not a character (make one with studio new-character)`);
  return o;
}

// ── looks: palettes per preset ───────────────────────────────────────────
interface Look { skin: string; hair: string; shirt: string; sleeves: 'shirt' | 'skin'; trousers: string; boots: string; lips: string; iris: string; apron?: string }
const LOOKS: Record<string, Look> = {
  default: { skin: '#d9a77a', hair: '#4a3022', shirt: '#6f8fa8', sleeves: 'shirt', trousers: '#3f4654', boots: '#2f2a26', lips: '#b06a5a', iris: '#5b4632' },
  blacksmith: { skin: '#c58c64', hair: '#3b2a20', shirt: '#9a8466', sleeves: 'skin', trousers: '#3c4350', boots: '#2e2a26', lips: '#9c5a4a', iris: '#4a3b2c', apron: '#5a3a24' },
  apprentice: { skin: '#e3b48f', hair: '#8a5a2e', shirt: '#7b9a72', sleeves: 'shirt', trousers: '#5a5248', boots: '#3b3129', lips: '#c07466', iris: '#4f6b3a' },
};
const PRESETS: Record<string, Partial<Record<string, number>>> = {
  default: {},
  blacksmith: { height: 1.8, build: 0.85, headSize: 1.04, armLength: 1.02, handSize: 1.12 },
  apprentice: { height: 1.62, build: 0.32, headSize: 1.1, armLength: 0.98, legLength: 0.98, handSize: 0.95 },
};
const mat = (name: string, color: string, roughness = 0.75, extra: Partial<Material> = {}): Material => ({ name, color, roughness, metalness: 0, grain: null, ...extra });
function partMaterials(l: Look): Array<{ parts: string; material: Material }> {
  const skin = mat('skin', l.skin, 0.62);
  return [
    { parts: 'torso', material: mat('shirt', l.shirt, 0.9) },
    { parts: '*UpperArm', material: mat('shirt', l.shirt, 0.9) },
    { parts: '*LowerArm', material: l.sleeves === 'shirt' ? mat('shirt', l.shirt, 0.9) : skin },
    { parts: '*UpperLeg', material: mat('trousers', l.trousers, 0.92) },
    { parts: '*LowerLeg', material: mat('trousers', l.trousers, 0.92) },
    { parts: '*Foot', material: mat('boots', l.boots, 0.55) },
    { parts: '*Toes', material: mat('boots', l.boots, 0.55) },
    { parts: 'hair', material: mat('hair', l.hair, 0.85) },
    { parts: 'brow.*', material: mat('hair', l.hair, 0.85) },
    { parts: 'lip*', material: mat('lips', l.lips, 0.5) },
    { parts: 'mouthInner', material: mat('mouth', '#4a1f1c', 0.6) },
    { parts: 'eyeSocket', material: mat('skin', shade(l.skin, 0.8), 0.7) },
    { parts: '*Eye', material: mat('eye white', '#f3efe8', 0.25) },
    { parts: '*Eye.iris', material: mat('iris', l.iris, 0.3) },
    { parts: '*Eye.pupil', material: mat('pupil', '#141210', 0.2) },
    ...(l.apron ? [{ parts: 'apron', material: mat('leather', l.apron, 0.7) }] : []),
  ];
}
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A hand pose from a named pose and/or explicit settings. */
function handPose(a: any, base?: HandPose): HandPose {
  let h: HandPose = { ...(a.pose ? NAMED_HAND_POSES[a.pose] : base ?? NAMED_HAND_POSES.relaxed) };
  if (a.pose && !NAMED_HAND_POSES[a.pose]) throw new Error(`unknown hand pose "${a.pose}" — one of ${Object.keys(NAMED_HAND_POSES).join(', ')}`);
  if (typeof a.curl === 'number') h = { ...h, index: a.curl, middle: a.curl, ring: a.curl, little: a.curl, name: undefined };
  else if (a.curl && typeof a.curl === 'object') {
    for (const [k, v] of Object.entries(a.curl)) {
      if (!['thumb', 'index', 'middle', 'ring', 'little'].includes(k)) throw new Error(`unknown finger "${k}" — thumb, index, middle, ring, little`);
      (h as any)[k] = v; h.name = undefined;
    }
  }
  if (a.thumb !== undefined) { h.thumb = a.thumb; h.name = undefined; }
  if (a.spread !== undefined) { h.spread = a.spread; h.name = undefined; }
  for (const k of ['thumb', 'index', 'middle', 'ring', 'little', 'spread'] as const) h[k] = r2(Math.min(1, Math.max(0, h[k] ?? 0)));
  return h;
}
const describeHand = (h: HandPose) => h.name ?? `curl ${['index', 'middle', 'ring', 'little'].map((f) => (h as any)[f]).join('/')}, thumb ${h.thumb}, spread ${h.spread}`;

export const CHARACTER_TOOLS: ToolDef[] = [
  {
    name: 'new-character', mode: 'create', mutates: true,
    description: 'Make a character from the humanoid kit (Decision 14): a low-poly body with a stylized face and full hands, born rigged — 56 Godot humanoid bones, skin weights, 15 speech shapes + 18 expression shapes. Proportions are params (height, build 0..1, headSize, armLength, legLength, handSize), so "make him taller" is one set-param. --preset blacksmith | apprentice | default sets proportions, colours and (blacksmith) a leather apron. Clothes, hair and tools are ordinary ops unioned with the body op; they follow the nearest bones. Starts relaxed (arms down, hands relaxed).',
    input: z.object({
      name: z.string(), id: z.string().optional(), preset: z.enum(['default', 'blacksmith', 'apprentice']).optional(),
      height: z.number().min(0.5).max(3).optional(), build: z.number().min(0).max(1).optional(), headSize: z.number().min(0.7).max(1.6).optional(),
      armLength: z.number().min(0.7).max(1.4).optional(), legLength: z.number().min(0.7).max(1.4).optional(), handSize: z.number().min(0.6).max(1.6).optional(),
      hair: z.enum(['short', 'none']).optional(),
      skin: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), hairColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), shirt: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
    example: `studio new-character --name "Blacksmith" --preset blacksmith`,
    run(ctx, a) {
      const preset = a.preset ?? 'default';
      let id = a.id ?? slug(a.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const P = { ...CHAR_DEFAULTS, ...PRESETS[preset] } as any;
      for (const k of ['height', 'build', 'headSize', 'armLength', 'legLength', 'handSize'] as const) if (a[k] !== undefined) P[k] = a[k];
      charParams(P); // validate the combination
      const spec = characterSpec(charParams({ ...P, hair: a.hair }));
      const look = { ...LOOKS[preset], ...(a.skin ? { skin: a.skin } : {}), ...(a.hairColor ? { hair: a.hairColor } : {}), ...(a.shirt ? { shirt: a.shirt } : {}) };
      const params: SceneObject['params'] = {
        height: { value: P.height, unit: 'm', min: 0.5, max: 3, description: 'standing height (feet to crown)' },
        build: { value: P.build, unit: '', min: 0, max: 1, description: 'slim 0 … broad 1' },
        headSize: { value: P.headSize, unit: '', min: 0.7, max: 1.6, description: 'head size (× stylized default)' },
        armLength: { value: P.armLength, unit: '', min: 0.7, max: 1.4, description: 'arm length (×)' },
        legLength: { value: P.legLength, unit: '', min: 0.7, max: 1.4, description: 'leg length (×)' },
        handSize: { value: P.handSize, unit: '', min: 0.6, max: 1.6, description: 'hand size (×)' },
      };
      const ops: SceneObject['ops'] = {
        body: { id: 'body', op: 'character', args: { height: '$height', build: '$build', headSize: '$headSize', armLength: '$armLength', legLength: '$legLength', handSize: '$handSize', hair: a.hair ?? 'short' }, part: 'body' },
      };
      const opOrder = ['body'];
      let output = 'body';
      if (look.apron) {
        // a leather apron hung from the chest, in front of the legs (follows the hips and thighs)
        const hip = spec.bones.find((b) => b.name === 'Hips')!.head[1], chest = spec.bones.find((b) => b.name === 'UpperChest')!.head[1];
        const s = spec.s;
        // a bib apron: wide over the thighs, narrower over the chest (an outline pushed 3 cm deep)
        const k = '* $height / 1.75';
        const yb = r2(hip / s - 0.36), yw = r2(hip / s + 0.05), yt = r2(chest / s + 0.02);
        ops.apron = { id: 'apron', op: 'extrude', part: 'apron', args: {
          axis: 'z', h: `0.03 ${k}`,
          profile: [[`-0.2 ${k}`, `${yb} ${k}`], [`0.2 ${k}`, `${yb} ${k}`], [`0.18 ${k}`, `${yw} ${k}`], [`0.12 ${k}`, `${yt} ${k}`], [`-0.12 ${k}`, `${yt} ${k}`], [`-0.18 ${k}`, `${yw} ${k}`]],
          at: [0, 0, `0.123 ${k} * (0.9 + 0.3 * $build)`],
        } };
        ops.figure = { id: 'figure', op: 'union', args: {}, inputs: ['body', 'apron'] };
        opOrder.push('apron', 'figure');
        output = 'figure';
      }
      const character: CharacterState = {
        pose: { LeftUpperArm: [0, 0, -72], RightUpperArm: [0, 0, 72], LeftLowerArm: [0, -8, 0], RightLowerArm: [0, 8, 0] },
        hands: { left: { ...NAMED_HAND_POSES.relaxed }, right: { ...NAMED_HAND_POSES.relaxed } },
        expression: {},
      };
      const obj: SceneObject = {
        id, name: a.name, semanticType: 'character', params, ops, opOrder, output,
        material: mat('skin', look.skin, 0.62), partMaterials: partMaterials(look),
        position: a.position ?? freeSpot(ctx as any), character, rules: [],
      };
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      ctx.summary(`Created character "${a.name}" (${preset}, ${P.height} m) — rigged: 56 bones, ${SHAPE_KEYS.length} face shapes`);
      return { id, preset, params: Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.value])), shapes: { speech: VISEMES, expression: EXPRESSIONS }, handPoses: Object.keys(NAMED_HAND_POSES), next: `studio set-expression --object ${id} --values '{"mouthSmileLeft":0.5,"mouthSmileRight":0.5}'` };
    },
  },
  {
    name: 'set-expression', mode: 'modify', mutates: true,
    description: `Set a character's face: shape-key weights 0..1. Speech shapes: ${VISEMES.join(', ')}. Expressions (ARKit names): ${EXPRESSIONS.join(', ')}. --values merges into the current face (0 removes a key); --reset true starts from neutral.`,
    input: z.object({ object: ObjRef, values: z.record(z.string(), z.number().min(0).max(1)).optional(), reset: z.boolean().optional() }),
    example: `studio set-expression --object blacksmith --values '{"mouthSmileLeft":0.6,"mouthSmileRight":0.6,"browInnerUp":0.3}'`,
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const bad = Object.keys(a.values ?? {}).filter((k) => !SHAPE_KEYS.includes(k));
      if (bad.length) throw new Error(`unknown shape key${bad.length > 1 ? 's' : ''} ${bad.map((k) => `"${k}" (did you mean ${closest(k, SHAPE_KEYS).join(' / ')}?)`).join(', ')}`);
      const cur = a.reset ? {} : { ...(o.character?.expression ?? {}) };
      for (const [k, v] of Object.entries(a.values ?? {}) as Array<[string, number]>) { if (v === 0) delete cur[k]; else cur[k] = r2(v); }
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), expression: cur });
      const list = Object.entries(cur).map(([k, v]) => `${k} ${v}`).join(', ');
      ctx.summary(`${o.name}'s face: ${list || 'neutral'}`);
      return { expression: cur };
    },
  },
  {
    name: 'set-pose', mode: 'modify', mutates: true,
    description: 'Pose a character\'s body: --bones \'{"BoneName":[x,y,z]}\' local rotations in degrees (X, then Y, then Z) on Godot humanoid bones (Hips, Spine, Chest, UpperChest, Neck, Head, LeftUpperArm, LeftLowerArm, LeftHand, LeftUpperLeg… and Right*). The rest pose is a T-pose facing +Z (left arm along +X): arms down is LeftUpperArm [0,0,-75] / RightUpperArm [0,0,75]; nod is Head [15,0,0]; turn the head is Head [0,30,0]. Merges into the current pose ([0,0,0] removes); --reset true starts from the T-pose. Hands: use set-hand.',
    input: z.object({ object: ObjRef, bones: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])).optional(), reset: z.boolean().optional() }),
    example: `studio set-pose --object blacksmith --bones '{"Head":[10,25,0],"RightUpperArm":[0,-40,40]}'`,
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const r = ctx.studio.evaluate(o);
      const names: string[] = r.rig ? r.rig.rig.bones.map((b: any) => b.name) : [];
      const bad = Object.keys(a.bones ?? {}).filter((k) => !names.includes(k) || /(Thumb|Index|Middle|Ring|Little)/.test(k));
      if (bad.length) throw new Error(`not a body bone: ${bad.map((k) => `"${k}" (did you mean ${closest(k, names.filter((n) => !/(Thumb|Index|Middle|Ring|Little)/.test(n))).join(' / ')}?)`).join(', ')} — fingers are posed with set-hand`);
      const cur: Record<string, [number, number, number]> = a.reset ? {} : { ...(o.character?.pose ?? {}) };
      for (const [k, v] of Object.entries(a.bones ?? {}) as Array<[string, [number, number, number]]>) { if (v.every((x) => x === 0)) delete cur[k]; else cur[k] = v.map(r2) as any; }
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), pose: cur });
      ctx.summary(`${o.name}'s pose: ${Object.entries(a.bones ?? {}).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ') || (a.reset ? 'T-pose' : 'unchanged')}`);
      return { pose: cur };
    },
  },
  {
    name: 'set-hand', mode: 'modify', mutates: true,
    description: `Pose a hand (Decision 22): --pose ${Object.keys(NAMED_HAND_POSES).join(' | ')} and/or settings: --curl n (all four fingers) or --curl '{"index":0,"middle":1,…}' (0 straight … 1 fist), --thumb 0..1, --spread 0..1. "Loosen his grip" = lower curl. --hand left | right | both.`,
    input: z.object({
      object: ObjRef, hand: z.enum(['left', 'right', 'both']), pose: z.string().optional(),
      curl: z.union([z.number().min(0).max(1), z.record(z.string(), z.number().min(0).max(1))]).optional(),
      thumb: z.number().min(0).max(1).optional(), spread: z.number().min(0).max(1).optional(),
    }),
    example: `studio set-hand --object blacksmith --hand right --pose point`,
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const hands = { ...(o.character?.hands ?? {}) };
      const sides = a.hand === 'both' ? (['left', 'right'] as const) : ([a.hand] as const);
      for (const s of sides) hands[s] = handPose(a, hands[s]);
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), hands });
      ctx.summary(`${o.name}'s ${a.hand === 'both' ? 'hands' : `${a.hand} hand`}: ${describeHand(hands[sides[0]]!)}`);
      return { hands };
    },
  },
  {
    name: 'set-grip', mode: 'modify', mutates: true,
    description: 'Set where a hand holds a prop (its grip socket, in the prop\'s own coordinates): --auto true generates it from the shape (a long thin section is a handle → power grip a third of the way from the free end; a small object → pinch). Or give --kind power|pinch, --center [x,y,z], --axis [x,y,z] (toward the working end, e.g. the hammer head), --radius m.',
    input: z.object({
      object: ObjRef, auto: z.boolean().optional(), kind: z.enum(['power', 'pinch']).optional(),
      center: z.tuple([z.number(), z.number(), z.number()]).optional(), axis: z.tuple([z.number(), z.number(), z.number()]).optional(), radius: z.number().positive().optional(),
    }),
    example: `studio set-grip --object hammer --auto true`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (o.semanticType === 'character') throw new Error('characters hold props; give the prop a grip instead');
      let g: GripSocket = o.grip && !a.auto ? { ...o.grip } : autoGripFor(ctx, o);
      if (a.kind) g.kind = a.kind;
      if (a.center) g.center = a.center;
      if (a.radius) g.radius = a.radius;
      if (a.axis) {
        const l = Math.hypot(...a.axis) || 1;
        g.axis = a.axis.map((v: number) => v / l) as V3;
        const helper: V3 = Math.abs(g.axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const c: V3 = [g.axis[1] * helper[2] - g.axis[2] * helper[1], g.axis[2] * helper[0] - g.axis[0] * helper[2], g.axis[0] * helper[1] - g.axis[1] * helper[0]];
        const cl = Math.hypot(...c) || 1;
        g.side = [c[0] / cl, c[1] / cl, c[2] / cl];
      }
      if (a.center || a.axis || a.kind || a.radius) g.auto = false;
      ctx.set(['objects', o.id, 'grip'], g);
      ctx.summary(`${o.name}: ${g.kind} grip at ${g.center.map(r3).join(', ')}${g.auto ? ' (from its shape)' : ''}`);
      return { grip: g };
    },
  },
  {
    name: 'hold', mode: 'modify', mutates: true,
    description: 'Put a prop in a character\'s hand: the prop\'s grip socket snaps to the posed hand (made from the prop\'s shape if it has none — see set-grip), and the fingers close around it as far as they can without passing through it. The prop then follows the hand when the character is posed. One step.',
    input: z.object({ character: z.string(), hand: z.enum(['left', 'right']), prop: z.string() }),
    example: `studio hold --character blacksmith --hand right --prop hammer`,
    run(ctx, a) {
      const c = asCharacter(ctx.obj(a.character));
      const p = ctx.obj(a.prop);
      if (p.semanticType === 'character') throw new Error('characters can\'t be held');
      if (p.id === c.id) throw new Error('a character can\'t hold itself');
      const grip = p.grip ?? autoGripFor(ctx, p);
      const cr = ctx.studio.evaluate(c).rig;
      if (!cr) throw new Error(`${c.name} has no rig (its geometry doesn't evaluate)`);
      // the prop in the character's object space at the held placement
      const h = heldPlacement(cr, a.hand, grip);
      const local = ctx.studio.evaluate({ ...p, position: [0, 0, 0], rotation: 0, orientation: undefined, place: undefined });
      const P = new Float32Array(local.positions);
      placeVerts(P, { position: h.p, orientation: h.q });
      const base = c.character?.hands?.[a.hand] ?? NAMED_HAND_POSES.relaxed;
      const fitted = fitGrip(cr, a.hand, { P, I: local.indices }, base, grip);
      const holds = { ...(c.character?.holds ?? {}) };
      const prev = holds[a.hand];
      holds[a.hand] = p.id;
      ctx.set(['objects', c.id, 'character'], { ...(c.character ?? {}), holds, hands: { ...(c.character?.hands ?? {}), [a.hand]: fitted } });
      if (!p.grip) ctx.set(['objects', p.id, 'grip'], grip);
      ctx.set(['objects', p.id, 'place'], { kind: 'held', target: c.id, hand: a.hand });
      if (prev && prev !== p.id && ctx.doc.objects[prev]) { ctx.set(['objects', prev, 'place'], undefined); ctx.set(['objects', prev, 'orientation'], undefined); }
      ctx.summary(`${c.name} holds ${p.name} in the ${a.hand} hand (${grip.kind} grip; fingers ${['index', 'middle', 'ring', 'little'].map((f) => (fitted as any)[f]).join('/')}, thumb ${fitted.thumb})`);
      return { grip, hand: fitted };
    },
  },
  {
    name: 'release', mode: 'modify', mutates: true,
    description: 'Take a prop out of a character\'s hand: it is set down on the floor beside the character and the hand relaxes.',
    input: z.object({ character: z.string(), hand: z.enum(['left', 'right']) }),
    run(ctx, a) {
      const c = asCharacter(ctx.obj(a.character));
      const held = c.character?.holds?.[a.hand];
      if (!held) throw new Error(`${c.name}'s ${a.hand} hand is empty`);
      const holds = { ...(c.character?.holds ?? {}) };
      delete holds[a.hand];
      ctx.set(['objects', c.id, 'character'], { ...(c.character ?? {}), holds, hands: { ...(c.character?.hands ?? {}), [a.hand]: { ...NAMED_HAND_POSES.relaxed } } });
      const p = ctx.doc.objects[held];
      if (p) {
        ctx.set(['objects', held, 'place'], undefined);
        ctx.set(['objects', held, 'orientation'], undefined);
        ctx.set(['objects', held, 'position'], [c.position[0] + (a.hand === 'left' ? 0.45 : -0.45), 0, c.position[2] + 0.2]);
      }
      ctx.summary(`${c.name} puts down ${p?.name ?? held}`);
      return { released: held };
    },
  },
  {
    name: 'pose-check', mode: 'inspect', mutates: false,
    description: 'Deform a character through 10 canonical poses (T, A, arms down, elbows bent, arms forward, sitting, step, bend forward, twist + look, fists + wrists) and report per pose: the joint that keeps the least volume (candy-wrapping), the largest edge stretch, and body regions passing through each other. Also checks skin weights (sum 1, ≤ 4 per vertex). `studio render --poses true` draws the pose sheet.',
    input: z.object({ object: ObjRef }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const r = ctx.studio.evaluate(o);
      if (!r.rig) throw new Error(`${o.name} has no rig`);
      const poses = ctx.studio.poseChecks(o);
      const w = weightReport(r.rig.rig);
      ctx.summary(`${poses.filter((p: any) => p.pass).length}/${poses.length} poses bend cleanly; weights ${w.unbound || w.badSum ? 'have problems' : 'OK'}`);
      return { poses, weights: w, vertices: r.positions.length / 3, triangles: r.triangles };
    },
  },
  {
    name: 'character', mode: 'inspect', mutates: false,
    description: 'What a character carries: bones, face shape keys (speech + expression), named hand poses, its current pose/expression/hands, held props and spoken lines.',
    input: z.object({ object: ObjRef }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const r = ctx.studio.evaluate(o);
      const c = o.character ?? {};
      return {
        name: o.name, params: Object.fromEntries(Object.entries(o.params).map(([k, p]) => [k, p.value])),
        bones: r.rig?.rig.bones.map((b: any) => b.name) ?? [], shapes: { speech: VISEMES, expression: EXPRESSIONS },
        handPoses: NAMED_HAND_POSES, pose: c.pose ?? {}, expression: c.expression ?? {}, hands: c.hands ?? {}, holds: c.holds ?? {},
        lines: Object.fromEntries(Object.entries(c.lines ?? {}).map(([k, l]) => [k, { text: l.text, duration: l.duration, emotion: l.emotion, voice: l.voice, audio: l.audio, aligner: l.aligner }])),
      };
    },
  },
  {
    name: 'set-line', mode: 'modify', mutates: true,
    description: 'Record a spoken line on a character (audio + script aligned into speech-shape curves). Normally made by `studio say`, which runs the local voice and aligner first.',
    input: z.object({ object: ObjRef, id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), line: z.any() }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const l = a.line as LineClip;
      if (!l || typeof l.text !== 'string' || !l.curves || !l.duration) throw new Error('line needs text, duration and curves (use studio say)');
      const lines = { ...(o.character?.lines ?? {}), [a.id]: l };
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), lines });
      ctx.summary(`${o.name} says "${l.text}" (${l.duration.toFixed(1)} s, ${l.emotion}${l.voice ? `, voice ${l.voice}` : ''})`);
      return { id: a.id, duration: l.duration, cues: l.cues.length };
    },
  },
  {
    name: 'remove-line', mode: 'modify', mutates: true,
    description: 'Remove a spoken line from a character.',
    input: z.object({ object: ObjRef, id: z.string() }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const lines = { ...(o.character?.lines ?? {}) };
      if (!lines[a.id]) throw new Error(`${o.name} has no line "${a.id}" (have: ${Object.keys(lines).join(', ') || 'none'})`);
      delete lines[a.id];
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), lines });
      ctx.summary(`${o.name}: removed line ${a.id}`);
      return { removed: a.id };
    },
  },
];

const r3 = (x: number) => +x.toFixed(3);

function autoGripFor(ctx: { studio: any }, o: SceneObject): GripSocket {
  const local = ctx.studio.evaluate({ ...o, position: [0, 0, 0], rotation: 0, orientation: undefined, place: undefined });
  if (!local.ok) throw new Error(`${o.name} has no geometry to grip yet`);
  const g = autoGrip(local.positions, local.indices);
  return { ...g, center: g.center.map(r3) as V3, axis: g.axis.map((v) => +v.toFixed(4)) as V3, side: g.side.map((v) => +v.toFixed(4)) as V3, radius: r3(g.radius) };
}
