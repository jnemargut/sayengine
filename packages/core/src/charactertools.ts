// Character tools (Decisions 14, 19–22): make a kit character, set its expression, pose and hands,
// give props a grip and put them in a hand, inspect pose checks, record spoken lines. Every call is a
// normal, reviewable step. The face shapes, bones and named hand poses live in rig.ts.
import { z } from 'zod';
import { freeSpot, type ToolDef } from './tools.ts';
import type { CharacterState, FacePaint, GripSocket, HandPose, LineClip, Material, SceneObject } from './types.ts';
import { BODY_PLANS, BROW_STYLES, CHAR_DEFAULTS, EARS, MOODS, SHAPES, EXPRESSIONS, EYE_STYLES, HAIRS, MOUTHS, NAMED_HAND_POSES, NOSES, PLANS, SHAPE_KEYS, STYLE_FAMILIES, VISEMES, apronDepth, characterSpec, charParams, weightReport, type BodyPlan, type V3 } from './rig.ts';
import { decodePng, readReference } from './charstyle.ts';
import { importCharacter } from './importchar.ts';
import { autoGrip, fitGrip, heldPlacement } from './grip.ts';
import { lineLife } from './life.ts';
import { ACTIONS, MOTION_DEFAULTS, bakeMotion, motionSettings } from './motion.ts';
import type { MotionSpec, PerformanceGesture, PerformanceScript } from './types.ts';
import { EMOTION_FACE, GESTURES, POSTURES, autoPerformance, compilePerformance, findWord, lineWords, performanceReport } from './performance.ts';
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
interface Look { paint?: FacePaint; skin: string; hair: string; shirt: string; sleeves: 'shirt' | 'skin'; trousers: string; boots: string; lips: string; iris: string; apron?: string; metal?: boolean; wing?: string; belt?: string; accent?: string; shank?: string; nosePad?: string }
const LOOKS: Record<string, Look> = {
  // craft pass: each look has a value plan (one light group, one dark group) and a single accent colour
  // (used on the belt buckle, collar or hems) so the eye lands on the face first
  default: { paint: { lashes: '#2a1d16', smile: 0.5, blush: '#d98a7a', blushAmt: 0.25 }, skin: '#d9a77a', hair: '#4a3022', shirt: '#6f8fa8', sleeves: 'shirt', trousers: '#3f4654', boots: '#2f2a26', lips: '#b06a5a', iris: '#5b4632', belt: '#3a2c22', accent: '#d9b25a' },
  // the forge pair: a stocky, bald, bushy-browed smith (dark leather, warm skin, a brass buckle) and a
  // lanky, freckled kid (light teal shirt over dark trousers, an orange tuft)
  blacksmith: { paint: { lashes: '#3a2016', smile: -0.15, blush: '#c4573e', blushAmt: 0.42, stubble: '#5a2e1c', wrinkles: 0.35 }, skin: '#c27f52', hair: '#9c4424', shirt: '#8a7458', sleeves: 'skin', trousers: '#2f343e', boots: '#231d19', lips: '#8f4e3e', iris: '#3d4a5c', apron: '#4e301d', belt: '#2a1f18', accent: '#d8a24a' },
  apprentice: { paint: { lashes: '#5a3020', smile: 0.85, blush: '#ec8f7f', blushAmt: 0.38, freckles: '#b8643a', frecklesAmt: 0.7 }, skin: '#f1c6a2', hair: '#e06a2a', shirt: '#5aa0a0', sleeves: 'shirt', trousers: '#4e4232', boots: '#3a2a1e', lips: '#cf7f6e', iris: '#4f7a3a', belt: '#6a4a2c', accent: '#f0d27a' },
  goblin: { paint: { lashes: '#26301c', smile: 0.6, blush: '#c97a5a', blushAmt: 0.3, freckles: '#5e7d3a', frecklesAmt: 0.55 }, skin: '#86ab58', hair: '#2d2a26', shirt: '#9a3a2c', sleeves: 'skin', trousers: '#3e352c', boots: '#2e231b', lips: '#4f6a3a', iris: '#f0c030', apron: '#d8b47a', belt: '#4a3626', accent: '#e8d070' },
  robot: { paint: { lashes: null, blush: '#41c9e6', blushAmt: 0.45, markings: 'robot', mark2: '#5a6470' }, skin: '#b3bec8', hair: '#3a4250', shirt: '#e07a2a', sleeves: 'skin', trousers: '#46505e', boots: '#262b33', lips: '#e8eef4', iris: '#41c9e6', metal: true, belt: '#2d333c', accent: '#41c9e6' },
  bird: { paint: { lashes: null, markings: 'feathers', mark: '#f3b98f', blush: '#f09a7a', blushAmt: 0.35 }, skin: '#efe4c8', hair: '#c4532d', shirt: '#3f6a3a', sleeves: 'skin', trousers: '#efe4c8', boots: '#e8a02c', lips: '#eba83a', iris: '#141210', belt: '#5a4a32', accent: '#e8a02c', shank: '#e8a02c' },
  // four legs: the coat is skin, shirt and trousers at once; boots are the paws, a dark nose pad
  dog: { paint: { lashes: '#2a1a10', markings: 'dog', mark: '#f1dfbf', mark2: '#5a3a22' }, skin: '#c08a52', hair: '#6a4026', shirt: '#c08a52', sleeves: 'shirt', trousers: '#c08a52', boots: '#a87444', lips: '#2a1e19', iris: '#3a2616', nosePad: '#1e1715', accent: '#c94a3a' },
  birdfolk: { paint: { lashes: null, markings: 'heron', mark: '#ffffff', mark2: '#262d3a' }, skin: '#f1f2f4', hair: '#2f3a4c', shirt: '#9aa8b8', sleeves: 'skin', trousers: '#c3ccd6', boots: '#e0a83a', lips: '#e3a72c', iris: '#141210', wing: '#5f7189', belt: '#4a5568', accent: '#e0a83a', shank: '#e0a83a' },
  kid: { paint: { lashes: '#26263a', smile: 0.9, blush: '#f08a8a', blushAmt: 0.5, freckles: '#c48466', frecklesAmt: 0.3 }, skin: '#f2cba8', hair: '#26263a', shirt: '#f0b62e', sleeves: 'shirt', trousers: '#3567a8', boots: '#d24a36', lips: '#e3a08c', iris: '#2f2620', belt: '#26263a', accent: '#d24a36' },
  elder: { paint: { lashes: '#6a5a50', smile: 0.6, blush: '#d98a7a', blushAmt: 0.3, wrinkles: 0.8 }, skin: '#d9a681', hair: '#ece8df', shirt: '#6a4c7a', sleeves: 'shirt', trousers: '#3c3742', boots: '#2a2522', lips: '#a96858', iris: '#4c6278', belt: '#2a2522', accent: '#c9a45a' },
};
/** Presets: a body plan, proportions and face parts (Decision 47 A). Anything can be overridden. */
const PRESETS: Record<string, Partial<Record<string, number | string>>> = {
  default: {},
  blacksmith: { plan: 'stocky', height: 1.42, build: 0.95, handSize: 1.05, hair: 'none', brows: 'bushy', nose: 'big', shape: 'square', mood: 'grumpy' },
  apprentice: { plan: 'lanky', height: 1.9, build: 0.15, headSize: 1.14, hair: 'tuft', nose: 'long', ears: 'pointy', eyes: 'big', shape: 'triangle', mood: 'cheerful' },
  goblin: { plan: 'stocky', height: 1.05, build: 0.55, headSize: 1.3, armLength: 1.1, handSize: 1.15, hair: 'none', nose: 'long', ears: 'pointy', mouth: 'cartoon', eyes: 'big', brows: 'bar', style: 'toy', shape: 'triangle', mood: 'nervous' },
  robot: { plan: 'human', height: 1.95, build: 0.8, headSize: 1.2, hair: 'none', mouth: 'grille', eyes: 'dot', brows: 'none', nose: 'none', ears: 'none', style: 'toy', shape: 'square', mood: 'warm' },
  bird: { plan: 'beaked', legs: 'bird', mood: 'gentle' },
  dog: { plan: 'quadruped', headSize: 0.88, legLength: 0.86, mood: 'warm' },
  // a heron: the lanky skeleton with a bird's face parts and wings (body plans and face parts mix freely)
  birdfolk: { plan: 'lanky', height: 1.72, build: 0.35, headSize: 1.2, hair: 'tuft', mouth: 'beak', eyes: 'dot', brows: 'none', nose: 'none', ears: 'none', wings: true, tail: true, tailLength: 0.45, legs: 'bird', shape: 'triangle', mood: 'proud' } as any,
  kid: { plan: 'chibi', hair: 'bun', mood: 'cheerful' },
  elder: { plan: 'human', height: 1.66, build: 0.45, headSize: 1.08, hair: 'bun', nose: 'long', brows: 'bushy', style: 'smooth', shape: 'round', mood: 'gentle' },
};
/** Palettes: colour families that can dress any plan. */
const PALETTES: Record<string, Partial<Look>> = {
  earthy: { shirt: '#8a6a48', trousers: '#4a4034', boots: '#2e2620', hair: '#4a3022' },
  storybook: { shirt: '#c8463a', trousers: '#2f5d8a', boots: '#3b2a20', hair: '#2a2a3a' },
  forest: { shirt: '#3f6b3a', trousers: '#5a4a32', boots: '#2e2a20', hair: '#6a4a24' },
  pastel: { shirt: '#9fc7d9', trousers: '#e8c1c9', boots: '#7a6a8a', hair: '#d9b56a' },
  night: { shirt: '#3a3f6b', trousers: '#22253a', boots: '#151520', hair: '#1a1a22' },
};
export const CHARACTER_PRESETS = Object.keys(PRESETS);
const mat = (name: string, color: string, roughness = 0.75, extra: Partial<Material> = {}): Material => ({ name, color, roughness, metalness: 0, grain: null, ...extra });
function partMaterials(l: Look): Array<{ parts: string; material: Material }> {
  const skin = mat('skin', l.skin, l.metal ? 0.38 : 0.62, l.metal ? { metalness: 0.55 } : {});
  // painted detail (face appeal round): the head and lids sample the face paint, irises their own tile,
  // and a marked body (a dog's blaze, feathers, panel seams) its body paint
  const face = { ...skin, paint: 'head' as const };
  const coat = l.paint?.markings === 'dog' || l.paint?.markings === 'robot' ? { paint: 'body' as const } : {};
  const body = l.paint?.markings === 'feathers' || l.paint?.markings === 'heron' ? { paint: 'body' as const } : {};
  return [
    { parts: 'Head', material: face },
    { parts: 'lid*', material: face },
    { parts: 'torso', material: mat('shirt', l.shirt, 0.9, coat) },
    { parts: '*UpperArm', material: mat('shirt', l.shirt, 0.9) },
    { parts: '*LowerArm', material: l.sleeves === 'shirt' ? mat('shirt', l.shirt, 0.9) : skin },
    { parts: '*UpperLeg', material: mat('trousers', l.trousers, 0.92) },
    { parts: '*LowerLeg', material: mat('trousers', l.trousers, 0.92) },
    { parts: '*Foot', material: mat('boots', l.boots, 0.55) },
    { parts: '*Toes', material: mat('boots', l.boots, 0.55) },
    { parts: 'hair', material: mat('hair', l.hair, 0.85) },
    { parts: 'brow.*', material: mat('hair', l.hair, 0.85) },
    { parts: 'lip*', material: mat('lips', l.lips, 0.5, l.metal ? { metalness: 0.6 } : {}) },
    { parts: 'mouthInner', material: mat('mouth', l.metal ? '#1b2027' : '#542220', 0.75) },
    { parts: 'teeth*', material: mat('teeth', '#ece4d4', 0.35) },
    { parts: 'tongue', material: mat('tongue', '#b0605a', 0.55) },
    { parts: 'eyeSocket', material: mat('skin', shade(l.skin, 0.8), 0.7) },
    { parts: '*Eye', material: mat('eye white', '#f3efe8', 0.25) },
    { parts: '*Eye.iris', material: mat('iris', l.iris, 0.3, { paint: 'iris' }) },
    { parts: '*Eye.pupil', material: mat('pupil', '#141210', 0.2) },
    ...(l.apron ? [{ parts: 'apron', material: mat('leather', l.apron, 0.7) }] : []),
    { parts: 'Tail*', material: mat('shirt', l.shirt, 0.9) },
    { parts: 'plumage', material: mat('feathers', l.shirt, 0.9, body) },
    { parts: 'collar', material: mat('collar', shade(l.shirt, 0.78), 0.9) },
    { parts: '*.hem', material: mat('hem', shade(l.shirt, 0.72), 0.9) },
    { parts: '*.cuff', material: mat('hem', shade(l.sleeves === 'shirt' ? l.shirt : l.trousers, 0.72), 0.9) },
    { parts: '*LowerLeg.cuff', material: mat('trousers hem', shade(l.trousers, 0.7), 0.92) },
    { parts: 'belt', material: mat('leather', l.belt ?? shade(l.boots, 1.1), 0.6) },
    { parts: 'belt.buckle', material: mat('buckle', l.accent ?? '#d8a24a', 0.35, { metalness: 0.6 }) },
    { parts: '*.shank', material: mat('scales', l.shank ?? l.boots, 0.5) },
    { parts: 'nose.pad', material: mat('nose pad', l.nosePad ?? '#1e1715', 0.35) },
    { parts: '*Eye.glint', material: mat('catch-light', '#ffffff', 0.12) },
    { parts: '*Wing*', material: mat('feathers', l.wing ?? l.hair, 0.8) },
  ];
}
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A reference picture steers a new character: its outline picks the body plan (unless one was given)
 *  and the head and leg proportions; its colours, sampled by height band, dress it. */
function referenceSteer(ctx: any, file: string, P: any): { params: Record<string, unknown>; look: Partial<Look>; note: string } {
  const bytes: Uint8Array = ctx.studio.assets.readExternal(file);
  const ref = readReference(decodePng(bytes));
  const explicitPlan = P.plan && P.plan !== 'human' ? P.plan as BodyPlan : undefined;
  const plan = explicitPlan ?? ref.plan;
  const params: Record<string, unknown> = { plan };
  if (!explicitPlan) { params.height = PLANS[plan].height; params.build = PLANS[plan].build; }
  // proportions relative to the chosen plan
  const scale = (v: number, k: 'head' | 'leg') => +Math.min(k === 'head' ? 1.6 : 1.4, Math.max(0.7, (v * (k === 'head' ? PLANS[ref.plan].head : PLANS[ref.plan].leg)) / PLANS[plan][k])).toFixed(2);
  params.headSize = scale(ref.params.headSize as number, 'head');
  params.legLength = scale(ref.params.legLength as number, 'leg');
  return { params, look: ref.look as Partial<Look>, note: ref.note + (explicitPlan && explicitPlan !== ref.plan ? ` (kept your ${explicitPlan} plan)` : '') };
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
    name: 'import-character', mode: 'create', mutates: true,
    description: 'Bring in an outside character (Decision 50 A: the side door; studio-made characters are the main road). A rigged .glb / .gltf / .vrm (VRoid, Mixamo, Blender, asset stores): its bones are matched to the standard humanoid names, the studio motions (idle, walk, run, start, stop, turn, wave) are retargeted onto it (rest-pose fix + hip-height scale), its face is driven by what it brings (its own 15 visemes → ARKit shapes → VRM vowels with made-up consonants → jaw → eyes only), and its VRM licence is read. Returns a report of what carried over and what did not. The retargeted model is saved as an asset (shown in the scene as a reference you can place). A model with no skeleton stays a prop.',
    input: z.object({ file: z.string(), name: z.string().optional(), motions: z.array(z.string()).optional(), at: z.tuple([z.number(), z.number(), z.number()]).optional() }),
    example: `studio import-character --file models/knight.vrm`,
    run(ctx, a) {
      const bytes: Uint8Array = ctx.studio.assets.readExternal(a.file);
      const fileName = a.file.split(/[\\/]/).pop()!;
      const { glb, report } = importCharacter(bytes, { name: a.name, motions: a.motions });
      const asset = ctx.studio.assets.put(glb, 'glb');
      let id = slug(a.name ?? report.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const obj: SceneObject = {
        id, name: a.name ?? report.name, semanticType: 'reference', params: {}, ops: { mesh: { id: 'mesh', op: 'mesh', args: { asset, format: 'glb', units: 'm', up: 'y' }, part: 'reference' } }, opOrder: ['mesh'], output: 'mesh',
        material: { name: 'reference', color: '#9a8fb0' }, position: a.at ?? freeSpot(ctx as any), rules: [], role: 'reference',
        reference: { kind: 'mesh', asset, file: fileName, format: 'glb' }, imported: { asset, report } as any,
      } as any;
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      ctx.summary(report.rigged ? `Imported ${fileName} as an outside character: ${report.bones.matched}/${report.bones.of} bones matched, ${report.motions.length} motions retargeted, face: ${report.face.mode}${report.warnings.length ? ` — ${report.warnings.length} warning(s)` : ''}` : `Imported ${fileName}: no skeleton, so it stays a prop`);
      return { id, asset, report };
    },
  },
  {
    name: 'new-character', mode: 'create', mutates: true,
    description: `Make a character, skeleton first (Decision 47 A): pick a body plan (${BODY_PLANS.join(', ')}), and the studio builds that skeleton (standard humanoid bone names), a low-poly body around it, a face from parts and hair. Born rigged: skin weights, 15 speech shapes + 18 expression shapes (every mouth answers to the same names), full hands. Face parts: --mouth ${MOUTHS.join('|')}, --eyes ${EYE_STYLES.join('|')}, --brows ${BROW_STYLES.join('|')}, --nose ${NOSES.join('|')}, --ears ${EARS.join('|')}, --hair ${HAIRS.join('|')}; --style ${STYLE_FAMILIES.join('|')} (how the facets are cut); --palette ${Object.keys(PALETTES).join('|')}. Presets: ${Object.keys(PRESETS).join(', ')}. --reference picture.png steers proportions and colours. Proportions stay params (height, build 0..1, headSize, armLength, legLength, handSize), so "make him taller" is one set-param. Studio check compares each new character's outline with the rest of the cast (no look-alikes).`,
    input: z.object({
      name: z.string(), id: z.string().optional(), preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(),
      plan: z.enum(BODY_PLANS).optional(), style: z.enum(STYLE_FAMILIES).optional(), palette: z.enum(Object.keys(PALETTES) as [string, ...string[]]).optional(),
      mouth: z.enum(MOUTHS).optional(), eyes: z.enum(EYE_STYLES).optional(), brows: z.enum(BROW_STYLES).optional(), nose: z.enum(NOSES).optional(), ears: z.enum(EARS).optional(),
      height: z.number().min(0.5).max(3).optional(), build: z.number().min(0).max(1).optional(), headSize: z.number().min(0.7).max(1.6).optional(),
      armLength: z.number().min(0.7).max(1.4).optional(), legLength: z.number().min(0.7).max(1.4).optional(), handSize: z.number().min(0.6).max(1.6).optional(),
      hair: z.enum(HAIRS).optional(), apron: z.boolean().optional(),
      tail: z.boolean().optional(), tailLength: z.number().min(0.3).max(2).optional(), wings: z.boolean().optional(),
      shape: z.enum(SHAPES).optional().describe('shape language: round (soft, friendly), square (solid), triangle (sharp, wiry); defaults to the plan\'s'),
      mood: z.enum(MOODS).optional().describe('the resting face (built into the bind pose; speech and expressions add on top): warm, cheerful, gentle, proud, nervous, grumpy or neutral'),
      skin: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), hairColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), shirt: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      trousers: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      reference: z.string().optional(),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
    example: `studio new-character --name "Mossy" --plan beaked --palette forest`,
    run(ctx, a) {
      const preset = a.preset ?? (a.plan ? undefined : 'default');
      let id = a.id ?? slug(a.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const pre = preset ? PRESETS[preset] : {};
      let plan = (a.plan ?? pre.plan ?? 'human') as BodyPlan;
      const P = { ...CHAR_DEFAULTS, height: PLANS[plan].height, build: PLANS[plan].build, ...pre, plan } as any;
      // a reference picture steers proportions (its outline) and colours (sampled by height band)
      let refLook: Partial<Look> = {}, refNote = '';
      if (a.reference) {
        const ref = referenceSteer(ctx, a.reference, P);
        Object.assign(P, ref.params); refLook = ref.look; refNote = ref.note;
        plan = P.plan;
      }
      for (const k of ['height', 'build', 'headSize', 'armLength', 'legLength', 'handSize', 'hair', 'style', 'mouth', 'eyes', 'brows', 'nose', 'ears', 'tail', 'tailLength', 'wings', 'shape', 'mood'] as const) if (a[k] !== undefined) P[k] = a[k];
      const PD = PLANS[plan];
      if (a.hair === undefined && pre.hair === undefined) P.hair = PD.face.hair;
      charParams(P); // validate the combination
      const spec = characterSpec(charParams(P));
      const baseLook = LOOKS[preset ?? ''] ?? LOOKS[{ chibi: 'kid', beaked: 'bird', stocky: 'blacksmith', lanky: 'apprentice', human: 'default', quadruped: 'dog' }[plan]];
      const look: Look = { ...baseLook, ...(a.palette ? PALETTES[a.palette] : {}), ...refLook, ...(a.skin ? { skin: a.skin } : {}), ...(a.hairColor ? { hair: a.hairColor } : {}), ...(a.shirt ? { shirt: a.shirt } : {}), ...(a.trousers ? { trousers: a.trousers } : {}) };
      if (a.apron === false) delete look.apron;
      if (a.apron === true && !look.apron) look.apron = '#5a3a24';
      const params: SceneObject['params'] = {
        height: { value: P.height, unit: 'm', min: 0.5, max: 3, description: 'standing height (feet to crown)' },
        build: { value: P.build, unit: '', min: 0, max: 1, description: 'slim 0 … broad 1' },
        headSize: { value: P.headSize, unit: '', min: 0.7, max: 1.6, description: 'head size (× stylized default)' },
        armLength: { value: P.armLength, unit: '', min: 0.7, max: 1.4, description: 'arm length (×)' },
        legLength: { value: P.legLength, unit: '', min: 0.7, max: 1.4, description: 'leg length (×)' },
        handSize: { value: P.handSize, unit: '', min: 0.6, max: 1.6, description: 'hand size (×)' },
      };
      const ops: SceneObject['ops'] = {
        body: { id: 'body', op: 'character', args: { height: '$height', build: '$build', headSize: '$headSize', armLength: '$armLength', legLength: '$legLength', handSize: '$handSize', hair: P.hair ?? 'short',
          ...(plan !== 'human' ? { plan } : {}), ...Object.fromEntries((['style', 'mouth', 'eyes', 'brows', 'nose', 'ears', 'tail', 'tailLength', 'wings', 'shape', 'legs', 'mood'] as const).filter((k) => P[k] !== undefined).map((k) => [k, P[k]])), ...(plan !== 'quadruped' ? { sleeves: look.sleeves === 'shirt' ? 'long' : 'short' } : {}) }, part: 'body' },
      };
      const opOrder = ['body'];
      let output = 'body';
      if (look.apron) {
        (ops.body.args as any).apron = true;
        // a leather apron hung from the chest, in front of the legs (follows the hips and thighs)
        const hip = spec.bones.find((b) => b.name === 'Hips')!.head[1], chest = spec.bones.find((b) => b.name === 'UpperChest')!.head[1];
        const s = spec.s;
        // a bib apron: wide over the thighs, narrower over the chest (an outline pushed 3 cm deep)
        const k = '* $height / 1.75';
        const yb = r2(hip / s - 0.36), yw = r2(hip / s + 0.05), yt = r2(chest / s + 0.02);
        // the apron follows the plan's body: wider over a barrel chest, further out over a belly
        const wx = r2(Math.max(1, PD.torso[1] * 0.9)), dz = r2(apronDepth(plan));
        ops.apron = { id: 'apron', op: 'extrude', part: 'apron', args: {
          axis: 'z', h: `0.03 ${k}`,
          profile: [[`-${r2(0.2 * wx)} ${k}`, `${yb} ${k}`], [`${r2(0.2 * wx)} ${k}`, `${yb} ${k}`], [`${r2(0.18 * wx)} ${k}`, `${yw} ${k}`], [`${r2(0.12 * wx)} ${k}`, `${yt} ${k}`], [`-${r2(0.12 * wx)} ${k}`, `${yt} ${k}`], [`-${r2(0.18 * wx)} ${k}`, `${yw} ${k}`]],
          at: [0, 0, dz === 1 ? `0.123 ${k} * (0.9 + 0.3 * $build)` : `0.123 ${k} * (0.9 + 0.3 * $build) * ${dz}`],
        } };
        ops.figure = { id: 'figure', op: 'union', args: {}, inputs: ['body', 'apron'] };
        opOrder.push('apron', 'figure');
        output = 'figure';
      }
      const character: CharacterState = {
        pose: spec.quad ? {} : { LeftUpperArm: [0, 0, -72], RightUpperArm: [0, 0, 72], LeftLowerArm: [0, -8, 0], RightLowerArm: [0, 8, 0] },
        hands: { left: { ...NAMED_HAND_POSES.relaxed }, right: { ...NAMED_HAND_POSES.relaxed } },
        expression: {},
        ...(look.paint ? { paint: look.paint } : {}),
        // every character can stand and walk in a game from the start (set-motion tunes or adds more)
        // the plan's own gait (a beaked body waddles, a chibi bounces) unless set-motion says otherwise
        motions: spec.quad ? { idle: { kind: 'idle' }, walk: { kind: 'walk' }, trot: { kind: 'trot' }, sit: { kind: 'sit' } }
          : { idle: { kind: 'idle' }, walk: { kind: 'walk', ...(spec.walk ? { style: spec.walk } : {}) }, start: { kind: 'start' }, stop: { kind: 'stop' } },
      };
      const obj: SceneObject = {
        id, name: a.name, semanticType: 'character', params, ops, opOrder, output,
        material: mat('skin', look.skin, look.metal ? 0.38 : 0.62, look.metal ? { metalness: 0.55 } : {}), partMaterials: partMaterials(look),
        position: a.position ?? freeSpot(ctx as any), character, rules: [],
      };
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      const face = spec.face.kind ?? 'human';
      ctx.summary(`Created character "${a.name}" (${preset ?? plan} — ${plan} body, ${face} mouth, ${P.height} m) — rigged: ${spec.bones.length} bones, ${SHAPE_KEYS.length} face shapes${refNote ? `; ${refNote}` : ''}`);
      return { id, preset: preset ?? null, plan, face: { mouth: face, eyes: P.eyes ?? PD.face.eyes, brows: P.brows ?? PD.face.brows, nose: P.nose ?? PD.face.nose, ears: P.ears ?? PD.face.ears, hair: P.hair }, style: P.style ?? 'faceted', ...(spec.walk ? { gait: spec.walk } : {}), ...(refNote ? { reference: refNote } : {}), params: Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.value])), shapes: { speech: VISEMES, expression: EXPRESSIONS }, handPoses: Object.keys(NAMED_HAND_POSES), next: `studio check --object ${id}  (the cast check compares its outline with the other characters)` };
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
      if (bad.length) throw new Error(`unknown shape key${bad.length > 1 ? 's' : ''} ${bad.map((k) => `"${k}" (did you mean ${(SHAPE_KEYS.filter((n) => n.toLowerCase().includes(k.toLowerCase())).slice(0, 4).concat(closest(k, SHAPE_KEYS)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4)).join(' / ')}?)`).join(', ')}`);
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
        motions: c.motions ?? {},
      };
    },
  },
  {
    name: 'set-line', mode: 'modify', mutates: true,
    description: 'Record a spoken line on a character (audio + script aligned into speech-shape curves). Normally made by `studio say`, which runs the local voice and aligner first.',
    input: z.object({ object: ObjRef, id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), line: z.any() }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      let l = a.line as LineClip;
      if (!l || typeof l.text !== 'string' || !l.curves || !l.duration) throw new Error('line needs text, duration and curves (use studio say)');
      // blinks, eye darts and brow lifts come with every line (seeded by its text); life: null opts out
      if ((l as any).life === null) { const { life: _drop, ...rest } = l as any; l = rest; }
      else if (!l.life) l = { ...l, life: lineLife(l) };
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
  {
    name: 'perform', mode: 'modify', mutates: true,
    description: 'How a character delivers one of its lines with the whole body (Decision 23): a short performance script — emotion (the face follows it), posture, gaze, and gestures on words — compiled into one clip with the mouth, face, eyes, hands and body sharing the line\'s beats, on top of the idle (breathing, weight shift). Gestures land just before the stressed syllable of their word, ease in with the forearm and hand trailing, and flow into each other when close. --gestures "palm-down@still, point@hammer:left"; --auto true picks gestures from the words and emotion (deictic words point, "still" presses down, numbers count, "no" shakes the head…); --clear true removes the performance (the line goes back to face only). Exports carry it as the line\'s clip ("line:<id>", now full body).',
    input: z.object({
      object: ObjRef,
      line: z.string().describe('line id (studio character shows them)'),
      emotion: z.string().optional().describe(`face and default posture: ${Object.keys(EMOTION_FACE).join(', ')} (default: the line's)`),
      intensity: z.number().optional().describe('0..1.5 (default 1)'),
      posture: z.enum(['neutral', 'upright', 'lean-in', 'slump', 'proud', 'guarded']).optional(),
      gaze: z.enum(['listener', 'down', 'away', 'up']).optional(),
      look: z.array(z.number()).length(2).optional().describe('where the listener is: [yaw, pitch] degrees from the facing (+yaw = left); cutscenes set it'),
      gestures: z.union([z.string(), z.array(z.any())]).optional().describe(`"gesture@word[:hand][*size]" comma-separated, or a JSON array; library: ${Object.keys(GESTURES).join(', ')}`),
      beats: z.array(z.any()).optional().describe('[{ word: "perfect", emotion: "happy" }]: the emotion changes mid-line'),
      auto: z.boolean().optional().describe('pick gestures from the words and emotion'),
      clear: z.boolean().optional(),
    }),
    example: `studio perform --object blacksmith --line hold-still --gestures "palm-down@still" --emotion firm`,
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const line = o.character?.lines?.[a.line];
      if (!line) throw new Error(`${o.name} has no line "${a.line}" (have: ${Object.keys(o.character?.lines ?? {}).join(', ') || 'none'}; studio say first)`);
      const lines = { ...(o.character?.lines ?? {}) };
      if (a.clear) {
        const { performance: _p, ...rest } = line;
        lines[a.line] = rest;
        ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), lines });
        ctx.summary(`${o.name}: "${line.text}" back to face only`);
        return { cleared: a.line };
      }
      if (a.emotion && !EMOTION_FACE[a.emotion]) throw new Error(`unknown emotion "${a.emotion}" — one of ${Object.keys(EMOTION_FACE).join(', ')}`);
      let gestures: PerformanceGesture[] | undefined;
      if (typeof a.gestures === 'string') {
        gestures = a.gestures.split(',').map((x: string) => x.trim()).filter(Boolean).map((x: string) => {
          const m = x.match(/^([a-z-]+)(?:@([^:*]+))?(?::(left|right|both))?(?:\*([0-9.]+))?$/);
          if (!m) throw new Error(`can't read gesture "${x}" — write gesture@word, e.g. point@hammer or palm-down@still:left`);
          const word = m[2] === undefined ? undefined : /^\d+(\.\d+)?s$/.test(m[2]) ? undefined : m[2];
          const at = m[2] && /^\d+(\.\d+)?s$/.test(m[2]) ? Number(m[2].slice(0, -1)) : undefined;
          return { gesture: m[1], ...(word !== undefined ? { word } : {}), ...(at !== undefined ? { at } : {}), ...(m[3] ? { hand: m[3] as 'left' | 'right' | 'both' } : {}), ...(m[4] ? { size: Number(m[4]) } : {}) };
        });
      } else if (Array.isArray(a.gestures)) gestures = a.gestures;
      for (const g of gestures ?? []) if (!GESTURES[g.gesture]) throw new Error(`no gesture "${g.gesture}" — library: ${Object.keys(GESTURES).join(', ')}; did you mean ${closest(g.gesture, Object.keys(GESTURES)).join(' or ')}?`);
      const words = lineWords(line);
      for (const g of gestures ?? []) if (g.word !== undefined && findWord(words, g.word) < 0) throw new Error(`"${g.word}" is not a word of "${line.text}" (words: ${words.map((w) => w.word).join(' ')})`);
      const prev = line.performance ?? {};
      let script: PerformanceScript = a.auto ? autoPerformance(line) : { ...prev };
      for (const k of ['emotion', 'intensity', 'posture', 'gaze', 'look', 'beats'] as const) if (a[k] !== undefined) (script as any)[k] = a[k];
      if (gestures) { script.gestures = gestures; delete script.auto; }
      const r = ctx.studio.evaluate(o);
      if (!r.rig) throw new Error(`${o.name} has no rig (its geometry doesn't evaluate)`);
      const clip = compilePerformance(r.rig.rig, o.character, line, script);
      const rep = performanceReport(r.rig.rig, line, script, clip, o.character);
      lines[a.line] = { ...line, performance: script };
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), lines });
      ctx.summary(`${o.name} performs "${line.text}": ${script.emotion ?? line.emotion}${script.posture ? `, ${script.posture}` : ''}${clip.gestures.length ? `, ${clip.gestures.map((g) => `${g.gesture}${g.word ? `@${g.word}` : ''}`).join(', ')}` : ''}`);
      return { line: a.line, script, gestures: clip.gestures, notes: clip.notes, check: { pass: rep.pass, detail: rep.detail }, library: a.auto ? Object.keys(GESTURES) : undefined };
    },
  },
  {
    name: 'gestures', mode: 'inspect', mutates: false,
    description: 'The gesture library for `perform` (what each one means, its hands and timing), the emotions the face can show, and the postures.',
    input: z.object({}),
    run() {
      return { gestures: Object.fromEntries(Object.entries(GESTURES).map(([k, g]) => [k, `${g.label} (${g.hands === 'none' ? 'head' : g.hands === 'both' ? 'both hands' : 'one hand'}, ${(g.prep + g.hold + g.retract).toFixed(1)} s)`])), emotions: Object.keys(EMOTION_FACE), postures: Object.keys(POSTURES) };
    },
  },
  {
    name: 'set-motion', mode: 'modify', mutates: true,
    description: 'Add or tune a parametric motion on a character (Decision 16): walk, run, idle (breathing, weight shifts, blinks, glances), turn, or a library action. Settings, not keyframes: it is baked onto this character\'s skeleton on export, with the legs solved so planted feet never slide, and re-fits when the body changes. Calling it again with the same --id changes only the settings you pass. Clips are in place; games move the character at the clip\'s speed. Hands keep their pose (and grip) while moving.',
    input: z.object({
      object: ObjRef,
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('clip name, e.g. walk, run, idle, turn-left, wave'),
      kind: z.enum(['walk', 'run', 'idle', 'turn', 'action', 'start', 'stop', 'trot', 'gallop', 'sit', 'lie']).optional().describe('required for a new motion (start/stop: the steps into and out of a walk; the game plays them when movement begins and ends; trot, gallop, sit, lie: four-legged bodies)'),
      speed: z.number().optional().describe('m/s (walk 0.3–2.2, default ~1.3; run 1.8–7, default ~3.4)'),
      stride: z.number().optional().describe('m per cycle (two steps); default from leg length and speed'),
      bounce: z.number().optional().describe('m of hip rise and fall'),
      armSwing: z.number().optional().describe('degrees'),
      lean: z.number().optional().describe('degrees forward'),
      sway: z.number().optional().describe('m side to side (idle: the weight shift)'),
      energy: z.number().optional().describe('0 tired … 1 lively (default 0.5)'),
      duration: z.number().optional().describe('s (idle loop, action, turn)'),
      turn: z.number().optional().describe('degrees, + = to the left (turn)'),
      action: z.string().optional().describe(`library action (action): ${Object.keys(ACTIONS).join(', ')}`),
      seed: z.number().optional().describe('blinks and glances'),
      from: z.string().optional().describe('start/stop: the walk motion they pair with (default walk)'),
      style: z.enum(['waddle', 'swagger', 'shuffle', 'bounce']).optional().describe('walk/run gait character (each body plan has its own default)'),
      flap: z.number().optional().describe('wing beats per second during this motion (characters with wings; 0 = folded)'),
    }),
    example: `studio set-motion --object blacksmith --id walk --speed 1.1 --energy 0.3`,
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const prev = o.character?.motions?.[a.id];
      if (!prev && !a.kind) throw new Error(`${o.name} has no motion "${a.id}" yet: pass --kind (walk, run, idle, turn, action, start, stop; four legs: walk, trot, gallop, idle, sit, lie)`);
      const { object: _o, id: _id, ...settings } = a;
      const spec: MotionSpec = { ...(prev ?? {}), ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) } as MotionSpec;
      if (prev && a.kind && a.kind !== prev.kind) for (const k of Object.keys(spec) as Array<keyof MotionSpec>) if (k !== 'kind' && !(k in settings && (settings as any)[k] !== undefined)) delete spec[k];
      if (spec.action && !ACTIONS[spec.action]) throw new Error(`no action "${spec.action}" — library: ${Object.keys(ACTIONS).join(', ')}; did you mean ${closest(spec.action, Object.keys(ACTIONS)).join(' or ')}?`);
      motionSettings(spec);
      const r = ctx.studio.evaluate(o);
      if (!r.rig) throw new Error(`${o.name} has no rig (its geometry doesn't evaluate)`);
      const clip = bakeMotion(a.id, spec, r.rig.rig, o.character);
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), motions: { ...(o.character?.motions ?? {}), [a.id]: spec } });
      const what = spec.kind === 'action' ? spec.action : spec.kind;
      ctx.summary(`${o.name}: ${prev ? 'tuned' : 'added'} motion "${a.id}" (${what}${clip.speed ? `, ${clip.speed.toFixed(2)} m/s` : ''}, ${clip.duration.toFixed(2)} s${clip.loop ? ' loop' : ''})`);
      return { id: a.id, spec, duration: clip.duration, loop: clip.loop, speed: clip.speed, stride: clip.stride, frames: clip.frames };
    },
  },
  {
    name: 'remove-motion', mode: 'modify', mutates: true,
    description: 'Remove a motion from a character.',
    input: z.object({ object: ObjRef, id: z.string() }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const motions = { ...(o.character?.motions ?? {}) };
      if (!motions[a.id]) throw new Error(`${o.name} has no motion "${a.id}" (have: ${Object.keys(motions).join(', ') || 'none'})`);
      delete motions[a.id];
      ctx.set(['objects', o.id, 'character'], { ...(o.character ?? {}), motions });
      ctx.summary(`${o.name}: removed motion ${a.id}`);
      return { removed: a.id };
    },
  },
  {
    name: 'motions', mode: 'inspect', mutates: false,
    description: 'A character\'s motions as baked clips (duration, speed, stride, loop, checks), plus the kinds, defaults and the library of actions you can add with set-motion.',
    input: z.object({ object: ObjRef }),
    run(ctx, a) {
      const o = asCharacter(ctx.obj(a.object));
      const r = ctx.studio.evaluate(o);
      const motions = Object.fromEntries(Object.entries(o.character?.motions ?? {}).map(([id, spec]) => {
        try {
          const c = bakeMotion(id, spec, r.rig!.rig, o.character);
          const checks = ctx.studio.motionChecks(o, id).map((x: any) => ({ label: x.label, pass: x.pass, detail: x.detail }));
          return [id, { spec, duration: c.duration, loop: c.loop, speed: c.speed, stride: c.stride, frames: c.frames, checks }];
        } catch (e: any) { return [id, { spec, error: e.message }]; }
      }));
      return { motions, kinds: ['walk', 'run', 'idle', 'turn', 'action', 'start', 'stop'], defaults: MOTION_DEFAULTS, actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, `${v.label} (${v.duration} s)`])) };
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
