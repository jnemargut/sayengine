// The single typed tool registry (Decision 5). The `studio` CLI, the browser view and
// (optionally, later) an MCP adapter are all generated from this list.
import { z } from 'zod';
import { OP_NAMES, DEFAULT_RULES, type SceneDoc, type SceneObject, type OpNode, type Param } from './types.ts';
import { ANCHORS } from './kernel.ts';
import { MATERIAL_PRESETS, presetName, resolveMaterial, describeMaterial } from './materials.ts';
import { describePlacement } from './scene.ts';
import { formatOf, imageSize, parseMesh, FORMAT_DEFAULTS, type MeshFormat } from './importers.ts';
import { PROFILES, budgetFor, type ProfileName } from './profiles.ts';
import type { Material, Placement } from './types.ts';
import { CHARACTER_TOOLS } from './charactertools.ts';

export interface ToolCtx {
  doc: SceneDoc;                       // draft of the active branch
  author: string;
  set(path: string[], value: unknown): void;
  obj(ref?: string): SceneObject;
  summary(s: string): void;
  studio: any;                         // Studio (typed loosely to avoid a cycle)
}

export interface ToolDef {
  name: string;
  mode: 'create' | 'modify' | 'inspect' | 'propose' | 'review' | 'output';
  mutates: boolean;
  description: string;
  input: z.ZodObject<any>;
  example?: string;
  run(ctx: ToolCtx, a: any): unknown;
}

const Num = z.union([z.number(), z.string()]).describe('number or expression over params, e.g. "$seatH - $seatT"');
const Vec = z.tuple([Num, Num, Num]);
const ObjRef = z.string().optional().describe('object id or name (defaults to the only/last object)');

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'object';
const fmtV = (v: unknown) => (typeof v === 'number' ? String(+v.toFixed(4)) : JSON.stringify(v));

function opDesc(n: OpNode): string {
  const a = n.args ?? {};
  if (n.op === 'placeAt') return `${n.id} = placeAt(${(n.inputs ?? []).join(', ')} → ${a.target}.${a.anchor ?? 'corners:bottom'}${a.splay !== undefined ? `, splay ${fmtV(a.splay)}` : ''})`;
  if (['union', 'difference', 'intersect', 'hull'].includes(n.op)) return `${n.id} = ${n.op}(${(n.inputs ?? []).join(', ')})`;
  if (n.inputs?.length) return `${n.id} = ${n.op}(${[n.inputs.join(', '), ...Object.entries(a).map(([k, v]) => `${k} ${fmtV(v)}`)].join(', ')})`;
  return `${n.id} = ${n.op}(${Object.entries(a).map(([k, v]) => `${k} ${fmtV(v)}`).join(', ')})`;
}

export const TOOLS: ToolDef[] = [
  // ── create ────────────────────────────────────────────────────────────
  {
    name: 'new-object', mode: 'create', mutates: true,
    description: 'Create a new object (semantic level). Default checks come from its type (stool/chair/table get "legs grounded").',
    input: z.object({
      name: z.string(), type: z.string().describe('semantic type: stool, chair, table, bench, shelf, lamp, wall…'),
      id: z.string().optional(), description: z.string().optional(),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
      color: z.string().optional(), material: z.string().optional().describe(`material preset (${Object.keys(MATERIAL_PRESETS).join(', ')}) or a custom name`),
    }),
    example: `studio new-object --name "Walnut stool" --type stool --material walnut --color "#6b4a33"`,
    run(ctx, a) {
      let id = a.id ?? slug(a.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const obj: SceneObject = {
        id, name: a.name, semanticType: a.type.toLowerCase(),
        params: {}, ops: {}, opOrder: [], output: null,
        material: newMaterial(a.material, a.color),
        position: a.position ?? freeSpot(ctx), rules: [],
      };
      if (a.description) obj.description = a.description;
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      ctx.summary(`Created ${obj.semanticType} "${a.name}"`);
      return { id, defaultChecks: DEFAULT_RULES[obj.semanticType] ?? DEFAULT_RULES.default };
    },
  },
  {
    name: 'set-param', mode: 'modify', mutates: true,
    description: 'Create or change a named parameter (level 2). Ops reference it as "$name".',
    input: z.object({
      object: ObjRef, name: z.string(), value: z.number(),
      unit: z.enum(['m', 'deg', '']).optional(), min: z.number().optional(), max: z.number().optional(), description: z.string().optional(),
    }),
    example: `studio set-param --name legSplay --value 6 --unit deg`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const prev = o.params[a.name];
      if (prev?.min !== undefined && a.value < prev.min && a.min === undefined) throw new Error(`${a.name} must be ≥ ${prev.min}`);
      if (prev?.max !== undefined && a.value > prev.max && a.max === undefined) throw new Error(`${a.name} must be ≤ ${prev.max}`);
      const p: Param = { ...(prev ?? {}), value: a.value };
      for (const k of ['unit', 'min', 'max', 'description'] as const) if (a[k] !== undefined) (p as any)[k] = a[k];
      ctx.set(['objects', o.id, 'params', a.name], p);
      const u = p.unit === 'deg' ? '°' : p.unit === 'm' ? ' m' : '';
      ctx.summary(!prev ? `New param ${a.name} = ${+a.value.toFixed(4)}${u}`
        : prev.value === a.value ? `${a.name}: ${['unit', 'min', 'max', 'description'].filter((k) => a[k] !== undefined).join(', ') || 'no'} change`
        : `${a.name} ${+prev.value.toFixed(4)}${u} → ${+a.value.toFixed(4)}${u}`);
      return { param: a.name, value: a.value };
    },
  },
  {
    name: 'set-params', mode: 'modify', mutates: true,
    description: 'Set several parameters in one step. Values are numbers, or {value, unit?, min?, max?, description?} to also set units/limits, e.g. {"seatH":0.45,"legSplay":{"value":8,"unit":"deg"}}. Existing units are kept.',
    input: z.object({
      object: ObjRef,
      values: z.record(z.string(), z.union([z.number(), z.object({ value: z.number(), unit: z.enum(['m', 'deg', '']).optional(), min: z.number().optional(), max: z.number().optional(), description: z.string().optional() })])),
      label: z.string().optional(),
    }),
    example: `studio set-params --values '{"seatH":0.45,"seatW":0.36,"legSplay":{"value":8,"unit":"deg"}}' --label "Bar-height to dining-height"`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const parts: string[] = [];
      for (const [k, raw] of Object.entries(a.values as Record<string, number | Param>)) {
        const prev = o.params[k];
        const next: Param = typeof raw === 'number' ? { ...(prev ?? {}), value: raw } : { ...(prev ?? {}), ...raw };
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) === false) throw new Error(`param name "${k}" must be an identifier (letters, digits, _)`);
        ctx.set(['objects', o.id, 'params', k], next);
        const u = next.unit === 'deg' ? '°' : '';
        parts.push(prev ? (prev.value === next.value ? `${k} unit ${next.unit ?? '—'}` : `${k} ${+prev.value.toFixed(4)}→${+next.value.toFixed(4)}${u}`) : `${k}=${+next.value.toFixed(4)}${u}`);
      }
      ctx.summary(a.label ? `${a.label} (${parts.join(', ')})` : parts.join(', '));
      return { set: Object.keys(a.values) };
    },
  },
  {
    name: 'add-op', mode: 'create', mutates: true,
    description: 'Add a construction op (level 3). Primitives: box{size,at} (centered at "at"), cylinder{r|r1,r2,h,at} (Y-up, base at "at"), sphere{r,at}, roundedBox{size,r,at}, extrude{profile,h,axis?:y|z|x,center?,curve?,at}, revolve{profile:[[r,y]…],curve?,at}, mesh{asset} (an import). Modifiers take inputs:[id]: round{r}, smooth{levels}, trim{normal?,offset?}. Transforms take inputs:[id]: translate{by}, rotate{deg,about?}, scale{by}, mirror{normal,keep?}. Booleans: union/difference/intersect/hull with inputs. Instancers: placeAt{target,anchor,inset?,splay?,align?} with inputs:[part], array{count,step}. Game side products (never the output): collision{shape:box|hull|capsule|sphere} and lod{ratio} with inputs:[output]. The first op added becomes the output unless --output false; pass --output true to make this op the output.',
    input: z.object({
      object: ObjRef, id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), op: z.enum(OP_NAMES),
      args: z.record(z.string(), z.any()).default({}), inputs: z.array(z.string()).optional(),
      part: z.string().optional().describe('semantic part name, e.g. "leg" (instances become leg#1..n)'),
      output: z.boolean().optional(),
    }),
    example: `studio add-op --id legs --op placeAt --inputs '["leg"]' --args '{"target":"seat","anchor":"corners:bottom","inset":0.04,"splay":"$legSplay"}'`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (o.ops[a.id]) throw new Error(`op "${a.id}" already exists — use set-op to change it`);
      for (const i of a.inputs ?? []) if (!o.ops[i]) throw new Error(`input "${i}" does not exist (ops: ${o.opOrder.join(', ') || 'none'})`);
      if (a.op === 'placeAt') {
        if (!a.args.target || !o.ops[a.args.target]) throw new Error(`placeAt needs args.target = an existing op id`);
        if (a.args.anchor && !(ANCHORS as readonly string[]).includes(a.args.anchor)) throw new Error(`anchor must be one of ${ANCHORS.join(', ')}`);
      }
      const node: OpNode = { id: a.id, op: a.op, args: a.args };
      if (a.inputs?.length) node.inputs = a.inputs;
      if (a.part) node.part = a.part;
      ctx.set(['objects', o.id, 'ops', a.id], node);
      ctx.set(['objects', o.id, 'opOrder'], [...o.opOrder, a.id]);
      if (a.output === true || (o.output === null && a.output !== false)) ctx.set(['objects', o.id, 'output'], a.id);
      ctx.summary(`Added ${opDesc(node)}${a.output ? ' (output)' : ''}`);
      return { op: a.id };
    },
  },
  {
    name: 'set-op', mode: 'modify', mutates: true,
    description: 'Change an existing op: args are merged (use null to delete an arg); inputs/part replaced if given.',
    input: z.object({ object: ObjRef, id: z.string(), args: z.record(z.string(), z.any()).optional(), inputs: z.array(z.string()).optional(), part: z.string().optional(), label: z.string().optional() }),
    example: `studio set-op --id leg --args '{"h":"($seatH - $seatT) / cos($legSplay)"}' --label "Lengthen legs to reach the floor"`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const n = o.ops[a.id];
      if (!n) throw new Error(`op "${a.id}" does not exist (ops: ${o.opOrder.join(', ') || 'none'})`);
      const next: OpNode = structuredClone(n);
      const changed: string[] = [];
      for (const [k, v] of Object.entries(a.args ?? {})) {
        if (v === null) delete next.args[k]; else next.args[k] = v;
        changed.push(`${k} ${fmtV(n.args[k])} → ${fmtV(v)}`);
      }
      if (a.inputs) { for (const i of a.inputs) if (!o.ops[i]) throw new Error(`input "${i}" does not exist`); next.inputs = a.inputs; changed.push(`inputs → ${a.inputs.join(', ')}`); }
      if (a.part) { next.part = a.part; changed.push(`part → ${a.part}`); }
      ctx.set(['objects', o.id, 'ops', a.id], next);
      ctx.summary(a.label ?? `${a.id}: ${changed.join(', ')}`);
      return { op: a.id };
    },
  },
  {
    name: 'remove-op', mode: 'modify', mutates: true,
    description: 'Remove an op that nothing else uses.',
    input: z.object({ object: ObjRef, id: z.string() }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!o.ops[a.id]) throw new Error(`op "${a.id}" does not exist`);
      const users = o.opOrder.filter((k) => o.ops[k].inputs?.includes(a.id) || o.ops[k].args?.target === a.id);
      if (users.length) throw new Error(`"${a.id}" is used by ${users.join(', ')} — change those first`);
      ctx.set(['objects', o.id, 'ops', a.id], undefined);
      ctx.set(['objects', o.id, 'opOrder'], o.opOrder.filter((k) => k !== a.id));
      if (o.output === a.id) ctx.set(['objects', o.id, 'output'], null);
      ctx.summary(`Removed op ${a.id}`);
      return { removed: a.id };
    },
  },
  {
    name: 'set-output', mode: 'modify', mutates: true,
    description: 'Choose which op is the object\'s final shape.',
    input: z.object({ object: ObjRef, id: z.string() }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!o.ops[a.id]) throw new Error(`op "${a.id}" does not exist`);
      ctx.set(['objects', o.id, 'output'], a.id);
      ctx.summary(`Output → ${a.id}`);
      return { output: a.id };
    },
  },
  {
    name: 'set-material', mode: 'modify', mutates: true,
    description: 'Give an object (or some of its parts) a physically based material. --preset picks walnut, oak, maple, ash, painted-wood, glazed-ceramic, matte-ceramic, terracotta, brushed-metal, black-metal, brass, plastic, glass, concrete, fabric (see `studio materials`); any other flag overrides the preset (e.g. painted-wood with --color). --part takes a glob ("leg*", "seat") to override just those parts; without it the whole object changes. --grain false removes wood grain.',
    input: z.object({
      object: ObjRef, part: z.string().optional().describe('part glob, e.g. "leg*"; omit for the whole object'),
      preset: z.string().optional(), name: z.string().optional().describe('alias of --preset (or a custom label)'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(),
      clearcoat: z.number().min(0).max(1).optional(), clearcoatRoughness: z.number().min(0).max(1).optional(),
      transmission: z.number().min(0).max(1).optional(), ior: z.number().min(1).max(3).optional(), opacity: z.number().min(0).max(1).optional(),
      grain: z.union([z.boolean(), z.object({ color2: z.string(), scale: z.number(), contrast: z.number() })]).optional(),
    }),
    example: `studio set-material --part "leg*" --preset black-metal`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const label = a.preset ?? a.name;
      if (a.preset && !presetName(a.preset)) throw new Error(`unknown preset "${a.preset}" — one of ${Object.keys(MATERIAL_PRESETS).join(', ')} (or use --name for a custom label with explicit values)`);
      const existing = a.part ? (o.partMaterials ?? []).find((r) => r.parts === a.part)?.material : o.material;
      // a new preset starts fresh; otherwise edit what's there
      const base: Material = label ? { name: presetName(label) ?? label, color: resolveMaterial({ name: label }).color } : { ...(existing ?? o.material) };
      if (label && !presetName(label) && existing) Object.assign(base, { ...existing, name: label });
      for (const k of ['color', 'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'opacity'] as const) if (a[k] !== undefined) (base as any)[k] = a[k];
      if (a.grain === false) base.grain = null;
      else if (a.grain && typeof a.grain === 'object') base.grain = a.grain;
      if (a.part) {
        const rules = (o.partMaterials ?? []).filter((x) => x.parts !== a.part);
        ctx.set(['objects', o.id, 'partMaterials'], [...rules, { parts: a.part, material: base }]);
        ctx.summary(`${o.name}: ${a.part} → ${describeMaterial(base)}`);
      } else {
        ctx.set(['objects', o.id, 'material'], base);
        ctx.summary(`${o.name} → ${describeMaterial(base)}`);
      }
      return { material: resolveMaterial(base), part: a.part ?? null };
    },
  },
  {
    name: 'set-profile', mode: 'modify', mutates: true,
    description: `Make an object a game asset: --profile godot-desktop | web | web-mobile (or none to remove). The profile adds budget checks after every step (triangles, baked texture size, materials, bones), requires a collision shape, and asks for distance versions (lod ops) on web. Over-budget while still building shows as pending. Override a budget with --triangles, --texture (baked px), --materials, --collision false. Export it with \`studio export --target godot|web\`.`,
    input: z.object({
      object: ObjRef, profile: z.enum(['godot-desktop', 'web', 'web-mobile', 'none']),
      triangles: z.number().int().positive().optional(), texture: z.number().int().refine((v) => [128, 256, 512, 1024, 2048, 4096].includes(v), 'texture must be 128, 256, 512, 1024, 2048 or 4096').optional(),
      materials: z.number().int().positive().optional(), collision: z.boolean().optional(),
      fingers: z.boolean().optional().describe('characters: keep finger bones (web-mobile drops them by default)'),
      shapes: z.number().int().positive().optional().describe('characters: face shape-key budget'),
    }),
    example: `studio set-profile --object stool --profile godot-desktop`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (a.profile === 'none') {
        if (!o.profile) throw new Error(`${o.name} has no game profile`);
        ctx.set(['objects', o.id, 'profile'], undefined);
        ctx.summary(`${o.name} is no longer a game asset`);
        return { profile: null };
      }
      const prof: any = { ...(o.profile?.name === a.profile ? o.profile : {}), name: a.profile };
      for (const k of ['triangles', 'texture', 'materials', 'collision', 'fingers', 'shapes'] as const) if (a[k] !== undefined) prof[k] = a[k];
      ctx.set(['objects', o.id, 'profile'], prof);
      const b = budgetFor(prof);
      ctx.summary(`${o.name}: game profile ${a.profile} (≤ ${b.triangles.toLocaleString('en')} triangles, ${b.texture} px texture, ≤ ${b.materials} materials${b.collision ? ', needs collision' : ''})`);
      return { profile: prof, budget: { ...b, lodAbove: Number.isFinite(b.lodAbove) ? b.lodAbove : null }, note: PROFILES[a.profile as ProfileName].description };
    },
  },
  {
    name: 'materials', mode: 'inspect', mutates: false,
    description: 'Material presets with their physical values (colour, roughness, metalness, clearcoat, transmission, wood grain).',
    input: z.object({}),
    run() {
      return Object.fromEntries(Object.entries(MATERIAL_PRESETS).map(([k, p]) => [k, { ...p }]));
    },
  },
  {
    name: 'move-object', mode: 'modify', mutates: true,
    description: 'Put an object at absolute coordinates (meters; y=0 is the floor) and/or turn it about Y (--rotation degrees). Prefer place-object for "on/next to/under" — those relations follow when sizes change. Moving a placed object detaches it from its relation.',
    input: z.object({ object: ObjRef, position: z.tuple([z.number(), z.number(), z.number()]).optional(), rotation: z.number().optional().describe('degrees about Y') }),
    example: `studio move-object --object vase --position '[0.6,0,0]' --rotation 30`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!a.position && a.rotation === undefined) throw new Error('give --position [x,y,z] and/or --rotation <deg>');
      const was = o.place ? describePlacement(o.place, (t) => ctx.doc.objects[t]?.name ?? t) : null;
      if (o.place) ctx.set(['objects', o.id, 'place'], undefined);
      if (a.position) ctx.set(['objects', o.id, 'position'], a.position);
      else if (o.place) ctx.set(['objects', o.id, 'position'], o.position);
      if (a.rotation !== undefined) ctx.set(['objects', o.id, 'rotation'], a.rotation);
      ctx.summary(`Moved ${o.name}${a.position ? ` to [${a.position.map((v: number) => +v.toFixed(3)).join(', ')}]` : ''}${a.rotation !== undefined ? `, turned to ${a.rotation}°` : ''}${was ? ` (no longer ${was})` : ''}`);
      return { position: a.position ?? o.position, rotation: a.rotation ?? o.rotation ?? 0, detached: !!was };
    },
  },
  {
    name: 'place-object', mode: 'modify', mutates: true,
    description: 'Place an object relative to another; the relation is kept, so it follows when either changes size. --relation on (on top, centred) | under (centred under it, on the floor) | next-to (--side left|right|front|back, --gap m) | align (--axis x|z, --edge min|center|max) | free (drop the relation, stay where it is). --offset [dx,dz] shifts it from the solved spot. Checks then confirm it rests on its support and overlaps nothing.',
    input: z.object({
      object: ObjRef, relation: z.enum(['on', 'under', 'next-to', 'align', 'free']), target: z.string().optional(),
      side: z.enum(['left', 'right', 'front', 'back']).optional(), gap: z.number().optional(),
      axis: z.enum(['x', 'z']).optional(), edge: z.enum(['min', 'center', 'max']).optional(),
      offset: z.tuple([z.number(), z.number()]).optional().describe('[dx, dz] in metres from the solved position'),
    }),
    example: `studio place-object --object vase --relation on --target "Walnut stool"`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (a.relation === 'free') {
        if (!o.place) throw new Error(`${o.name} has no relation to drop`);
        const was = describePlacement(o.place, (t) => ctx.doc.objects[t]?.name ?? t);
        ctx.set(['objects', o.id, 'place'], undefined);
        ctx.set(['objects', o.id, 'position'], o.position);
        ctx.set(['objects', o.id, 'rotation'], o.rotation ?? 0);
        ctx.summary(`${o.name} is free-standing (was ${was})`);
        return { place: null };
      }
      if (!a.target) throw new Error('--target <object> is required');
      const t = ctx.obj(a.target);
      if (t.id === o.id) throw new Error('an object cannot be placed relative to itself');
      const offset = a.offset ?? undefined;
      let place: Placement;
      if (a.relation === 'on') place = { kind: 'on', target: t.id, ...(offset ? { offset } : {}) };
      else if (a.relation === 'under') place = { kind: 'under', target: t.id, ...(offset ? { offset } : {}) };
      else if (a.relation === 'next-to') place = { kind: 'nextTo', target: t.id, side: a.side ?? 'right', gap: a.gap ?? 0.05, ...(offset ? { offset } : {}) };
      else place = { kind: 'align', target: t.id, axis: a.axis ?? 'x', edge: a.edge ?? 'center', ...(offset ? { offset } : {}) };
      // cycle guard
      for (let cur: any = t, n = 0; cur?.place && n < 50; cur = ctx.doc.objects[cur.place.target], n++) {
        if (cur.place.target === o.id) throw new Error(`${t.name} is already placed relative to ${o.name} — that would be a loop`);
      }
      ctx.set(['objects', o.id, 'place'], place);
      ctx.summary(`${o.name} ${describePlacement(place, (id) => ctx.doc.objects[id]?.name ?? id)}`);
      return { place };
    },
  },
  {
    name: 'arrange', mode: 'modify', mutates: true,
    description: 'Arrange several objects around or along another in one step (e.g. 4 stools around a table). --around <target> spaces them evenly on a circle (--radius m, default just past the target\'s edge; --start deg; --face target|away|none). --along <target> lines them up on one --side (front|back|left|right) with --spacing m and --gap m. Objects face the target by default (an object\'s front is +Z). Use duplicate-object first to make the copies.',
    input: z.object({
      objects: z.array(z.string()).min(1), around: z.string().optional(), along: z.string().optional(),
      radius: z.number().optional(), start: z.number().optional(), face: z.enum(['target', 'away', 'none']).optional(),
      side: z.enum(['left', 'right', 'front', 'back']).optional(), spacing: z.number().optional(), gap: z.number().optional(),
    }),
    example: `studio arrange --objects '["stool","stool-2","stool-3","stool-4"]' --around table --radius 0.55 --start 45`,
    run(ctx, a) {
      if (!!a.around === !!a.along) throw new Error('give exactly one of --around <object> or --along <object>');
      const t = ctx.obj(a.around ?? a.along);
      const objs = a.objects.map((r: string) => ctx.obj(r));
      if (objs.some((o: any) => o.id === t.id)) throw new Error('the target cannot be one of the arranged objects');
      const n = objs.length;
      objs.forEach((o: any, i: number) => {
        const place: Placement = a.around
          ? { kind: 'around', target: t.id, index: i, count: n, ...(a.radius !== undefined ? { radius: a.radius } : {}), ...(a.start !== undefined ? { start: a.start } : {}), ...(a.face ? { face: a.face } : {}) }
          : { kind: 'along', target: t.id, index: i, count: n, side: a.side ?? 'front', ...(a.spacing !== undefined ? { spacing: a.spacing } : {}), ...(a.gap !== undefined ? { gap: a.gap } : {}), ...(a.face ? { face: a.face } : {}) };
        ctx.set(['objects', o.id, 'place'], place);
      });
      ctx.summary(a.around ? `${n} objects around ${t.name}${a.radius !== undefined ? ` at ${a.radius} m` : ''}` : `${n} objects along the ${a.side ?? 'front'} of ${t.name}`);
      return { arranged: objs.map((o: any) => o.id), target: t.id };
    },
  },
  {
    name: 'duplicate-object', mode: 'create', mutates: true,
    description: 'Make copies of an object. Linked copies (default) share the original\'s params, ops and materials — edit the original and every copy follows; each copy has its own position. --linked false makes independent copies. New copies sit to the right of the original until you place/arrange them.',
    input: z.object({ object: z.string(), count: z.number().int().min(1).max(50).default(1), linked: z.boolean().default(true), names: z.array(z.string()).optional() }),
    example: `studio duplicate-object --object stool --count 3`,
    run(ctx, a) {
      const src = ctx.obj(a.object);
      const root = src.instanceOf ? ctx.doc.objects[src.instanceOf] ?? src : src;
      const r = ctx.studio.evaluate(src);
      const w = r.bbox ? r.bbox.max[0] - r.bbox.min[0] : 0.5;
      const ids: string[] = [];
      let order = [...ctx.doc.objectOrder];
      for (let i = 0; i < a.count; i++) {
        let id = `${root.id}-${i + 2}`;
        for (let k = i + 2; ctx.doc.objects[id] || ids.includes(id); k++) id = `${root.id}-${k + 1}`;
        const name = a.names?.[i] ?? `${root.name} ${id.slice(root.id.length + 1)}`;
        const copy: SceneObject = a.linked
          ? { id, name, semanticType: root.semanticType, params: {}, ops: {}, opOrder: [], output: null, material: root.material, position: [src.position[0] + (w + 0.15) * (i + 1), src.position[1], src.position[2]], rotation: src.rotation ?? 0, rules: [], instanceOf: root.id }
          : { ...structuredClone(root), id, name, position: [src.position[0] + (w + 0.15) * (i + 1), src.position[1], src.position[2]], place: undefined };
        if (!a.linked) delete (copy as any).place;
        ctx.set(['objects', id], copy);
        ids.push(id);
        order = [...order, id];
      }
      ctx.set(['objectOrder'], order);
      ctx.summary(`${a.count} ${a.linked ? 'linked ' : ''}cop${a.count === 1 ? 'y' : 'ies'} of ${root.name}: ${ids.join(', ')}`);
      return { copies: ids, linked: a.linked };
    },
  },
  {
    name: 'unlink', mode: 'modify', mutates: true,
    description: 'Turn a linked copy into an independent object (it keeps its current shape, then edits apply only to it).',
    input: z.object({ object: z.string() }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!o.instanceOf) throw new Error(`${o.name} is not a linked copy`);
      const was = o.instanceOf;
      for (const k of ['params', 'ops', 'opOrder', 'output', 'material', 'partMaterials', 'rules'] as const) ctx.set(['objects', o.id, k], structuredClone((o as any)[k]));
      ctx.set(['objects', o.id, 'instanceOf'], undefined);
      ctx.summary(`${o.name} is no longer linked to ${ctx.doc.objects[was]?.name ?? was}`);
      return { unlinked: o.id };
    },
  },
  {
    name: 'drag-object', mode: 'modify', mutates: true,
    description: 'Nudge an object by [dx, dz] metres on the floor and/or turn it by --rotate degrees (what dragging in the view does). A placed object keeps its relation: the drag becomes its offset, so a vase dragged across a stool stays on the stool.',
    input: z.object({ object: ObjRef, by: z.tuple([z.number(), z.number()]).optional(), rotate: z.number().optional() }),
    example: `studio drag-object --object vase --by '[0.05,0]'`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const [dx, dz] = a.by ?? [0, 0];
      const dr = a.rotate ?? 0;
      if (!dx && !dz && !dr) throw new Error('nothing to do: give --by [dx,dz] and/or --rotate deg');
      const r3 = (v: number) => +v.toFixed(4);
      const bits: string[] = [];
      if (dx || dz) bits.push(`${Math.round(Math.hypot(dx, dz) * 1000) / 10} cm`);
      if (dr) bits.push(`turned ${+dr.toFixed(1)}°`);
      if (o.place) {
        const p = structuredClone(o.place) as any;
        const off = p.offset ?? [0, 0];
        p.offset = [r3(off[0] + dx), r3(off[1] + dz)];
        if (dr) { if (p.kind === 'around' || p.kind === 'along') p.rotate = r3((p.rotate ?? 0) + dr); else ctx.set(['objects', o.id, 'rotation'], r3((o.rotation ?? 0) + dr)); }
        ctx.set(['objects', o.id, 'place'], p);
        ctx.summary(`Dragged ${o.name} ${bits.join(', ')} (still ${describePlacement(p, (id) => ctx.doc.objects[id]?.name ?? id)})`);
      } else {
        if (dx || dz) ctx.set(['objects', o.id, 'position'], [r3(o.position[0] + dx), o.position[1], r3(o.position[2] + dz)]);
        if (dr) ctx.set(['objects', o.id, 'rotation'], r3((o.rotation ?? 0) + dr));
        ctx.summary(`Dragged ${o.name} ${bits.join(', ')}`);
      }
      return { object: o.id };
    },
  },
  {
    name: 'drag-part', mode: 'modify', mutates: true,
    description: 'Move one part by [dx, dy, dz] metres (what dragging a part in the view does). Edits the "at" of the op that made the part: a number is shifted, a "$param" used only there is changed, an expression gets "+ d". Parts that are copies (leg#3) or rotated after they are made move the whole object instead, and the summary says so.',
    input: z.object({ object: ObjRef, part: z.string(), by: z.tuple([z.number(), z.number(), z.number()]) }),
    example: `studio drag-part --part seat --by '[0,0.02,0]'`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const target = ctx.studio.partDragTarget(o, a.part);
      const d = a.by.map((v: number) => +v.toFixed(4));
      if (target.kind === 'object') {
        if (o.place) {
          const p = structuredClone(o.place) as any;
          const off = p.offset ?? [0, 0];
          p.offset = [+(off[0] + d[0]).toFixed(4), +(off[1] + d[2]).toFixed(4)];
          ctx.set(['objects', o.id, 'place'], p);
        } else ctx.set(['objects', o.id, 'position'], [+(o.position[0] + d[0]).toFixed(4), Math.max(0, +(o.position[1] + d[1]).toFixed(4)), +(o.position[2] + d[2]).toFixed(4)]);
        ctx.summary(`Moved the whole ${o.name} (${target.reason})`);
        return { moved: 'object', reason: target.reason };
      }
      const node = o.ops[target.op];
      // world delta → object-local delta (undo the object's rotation about Y)
      const t = (-(o.rotation ?? 0) * Math.PI) / 180;
      const local = [Math.cos(t) * d[0] + Math.sin(t) * d[2], d[1], -Math.sin(t) * d[0] + Math.cos(t) * d[2]];
      const at = Array.isArray(node.args.at) ? [...node.args.at as any[]] : [0, 0, 0];
      const changes: string[] = [];
      const usedElsewhere = (param: string) => o.opOrder.some((id) => id !== target.op && JSON.stringify(o.ops[id].args).includes(`$${param}`)) || JSON.stringify({ ...node.args, at: null }).includes(`$${param}`);
      for (let k = 0; k < 3; k++) {
        const dk = +local[k].toFixed(4);
        if (!dk) continue;
        const v = at[k];
        const m = typeof v === 'string' ? /^\s*\$([A-Za-z_]\w*)\s*$/.exec(v) : null;
        if (typeof v === 'number') at[k] = +(v + dk).toFixed(4);
        else if (m && o.params[m[1]] && !usedElsewhere(m[1])) {
          const pv = +(o.params[m[1]].value + dk).toFixed(4);
          ctx.set(['objects', o.id, 'params', m[1]], { ...o.params[m[1]], value: pv });
          changes.push(`${m[1]} → ${pv}`);
          continue;
        } else at[k] = `${v} ${dk >= 0 ? '+' : '-'} ${Math.abs(dk)}`;
        changes.push(`at.${'xyz'[k]} ${dk >= 0 ? '+' : '−'}${Math.abs(dk * 100).toFixed(1)} cm`);
      }
      if (JSON.stringify(at) !== JSON.stringify(node.args.at ?? [0, 0, 0])) ctx.set(['objects', o.id, 'ops', target.op], { ...node, args: { ...node.args, at } });
      ctx.summary(`Moved ${a.part} of ${o.name}: ${changes.join(', ') || 'no change'}`);
      return { moved: 'part', op: target.op, at };
    },
  },
  {
    name: 'import', mode: 'create', mutates: true,
    description: 'Bring in a reference. Meshes (.stl .obj .glb) become a translucent reference object you can measure (inspect) and model around; watertight ones can also be used in booleans with add-op --op mesh --args {"asset":…}. STL defaults to millimetres, Z-up; OBJ/GLB to metres, Y-up (override with --units m|cm|mm|in, --up y|z, --scale). Images (.png .jpg) become a backdrop plane: --plane front|side|top, --size width in metres, --at centre; renders include it so you can model to match. References are not exported.',
    input: z.object({
      file: z.string(), name: z.string().optional(),
      units: z.enum(['m', 'cm', 'mm', 'in']).optional(), up: z.enum(['y', 'z']).optional(), scale: z.number().positive().optional(),
      plane: z.enum(['front', 'side', 'top']).optional(), size: z.number().positive().optional().describe('image width in metres (default 1)'),
      at: z.tuple([z.number(), z.number(), z.number()]).optional(), opacity: z.number().min(0.05).max(1).optional(),
    }),
    example: `studio import --file sketches/chair-front.png --plane front --size 0.6`,
    run(ctx, a) {
      const fmt = formatOf(a.file);
      if (!fmt) throw new Error('import supports .stl .obj .glb meshes and .png .jpg images');
      const bytes: Uint8Array = ctx.studio.assets.readExternal(a.file);
      const fileName = a.file.split(/[\\/]/).pop()!;
      const asset = ctx.studio.assets.put(bytes, fmt);
      let id = slug(a.name ?? fileName.replace(/\.[^.]+$/, ''));
      while (ctx.doc.objects[id]) id = id + '-2';
      const name = a.name ?? fileName;
      let obj: SceneObject;
      if (fmt === 'png' || fmt === 'jpg') {
        const sz = imageSize(bytes);
        const width = a.size ?? 1;
        const height = +(width * (sz.height / sz.width)).toFixed(4);
        const plane = a.plane ?? 'front';
        const at: [number, number, number] = a.at ?? (plane === 'front' ? [0, height / 2, -0.6] : plane === 'side' ? [-0.6, height / 2, 0] : [0, 0.0005, 0]);
        obj = { id, name, semanticType: 'reference', params: {}, ops: {}, opOrder: [], output: null, material: { name: 'reference', color: '#ffffff' }, position: [0, 0, 0], rules: [], role: 'reference', reference: { kind: 'image', asset, file: fileName, plane, width, height, at, opacity: a.opacity ?? 0.6 } };
        ctx.summary(`Imported ${fileName} as a ${plane} reference image, ${width} × ${height} m`);
      } else {
        const opts = { units: a.units ?? FORMAT_DEFAULTS[fmt as MeshFormat].units, up: a.up ?? FORMAT_DEFAULTS[fmt as MeshFormat].up, ...(a.scale ? { scale: a.scale } : {}) };
        const raw = parseMesh(bytes, fmt as MeshFormat, opts); // validate now so errors surface at import time
        const args = { asset, format: fmt, ...opts };
        obj = { id, name, semanticType: 'reference', params: {}, ops: { mesh: { id: 'mesh', op: 'mesh', args, part: 'reference' } }, opOrder: ['mesh'], output: 'mesh', material: { name: 'reference', color: '#7d93ab' }, position: a.at ?? [0, 0, 0], rules: [], role: 'reference', reference: { kind: 'mesh', asset, file: fileName, format: fmt } };
        ctx.summary(`Imported ${fileName} as a reference mesh (${raw.indices.length / 3} triangles, ${opts.units}, ${opts.up}-up)`);
      }
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      return { id, asset, kind: obj.reference!.kind, note: obj.reference!.kind === 'mesh' ? `measure it with studio inspect --object ${id}; to cut/join with it, add-op --op mesh --args '{"asset":"${asset}","format":"${fmt}","units":"${(obj.ops.mesh.args as any).units}","up":"${(obj.ops.mesh.args as any).up}"}' in your object` : 'renders include the image; model to match its outline' };
    },
  },
  {
    name: 'add-rule', mode: 'modify', mutates: true,
    description: 'Add a check rule: {"kind":"grounded","parts":"leg*"} | {"kind":"connected"} | {"kind":"aboveFloor"} | {"kind":"range","expr":"height","min":0.4,"max":0.5}. Measures available in range: params, width, height, depth. Adding a rule replaces the type defaults with defaults + this rule.',
    input: z.object({ object: ObjRef, rule: z.record(z.string(), z.any()) }),
    example: `studio add-rule --rule '{"kind":"range","expr":"height","min":0.43,"max":0.47,"label":"Seat height 430–470 mm"}'`,
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!['grounded', 'connected', 'aboveFloor', 'range'].includes(a.rule.kind)) throw new Error('rule.kind must be grounded | connected | aboveFloor | range');
      const base = o.rules.length ? o.rules : DEFAULT_RULES[o.semanticType] ?? DEFAULT_RULES.default;
      ctx.set(['objects', o.id, 'rules'], [...base, a.rule]);
      ctx.summary(`Rule added: ${a.rule.label ?? a.rule.kind}`);
      return { rules: base.length + 1 };
    },
  },
  {
    name: 'delete-object', mode: 'modify', mutates: true,
    description: 'Delete an object.',
    input: z.object({ object: z.string() }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const deps = ctx.doc.objectOrder.filter((id) => ctx.doc.objects[id]?.place?.target === o.id || ctx.doc.objects[id]?.instanceOf === o.id);
      if (deps.length) throw new Error(`${deps.join(', ')} ${deps.length === 1 ? 'is' : 'are'} placed on or linked to ${o.name} — place-object --relation free / unlink them first`);
      ctx.set(['objects', o.id], undefined);
      ctx.set(['objectOrder'], ctx.doc.objectOrder.filter((k) => k !== o.id));
      ctx.summary(`Deleted ${o.name}`);
      return { deleted: o.id };
    },
  },
  // ── proposals & review (Decisions 2 + 9) ─────────────────────────────
  {
    name: 'propose', mode: 'propose', mutates: false,
    description: 'Start a proposal branch off main. Every edit until commit/discard lands on it as a reviewable step.',
    input: z.object({ title: z.string() }),
    example: `studio propose --title "Mid-century splayed legs"`,
    run(ctx, a) {
      const h = ctx.studio.history;
      if (h.data.active !== 'main') throw new Error(`already on proposal ${h.data.active} — commit-proposal or discard-proposal first, or "studio switch --branch main"`);
      const p = h.createProposal(a.title, ctx.author);
      ctx.summary(`${p.id} "${a.title}"`);
      return { proposal: p.id, title: p.title, note: 'Edits now go to this proposal. The human reviews each step in the view (Keep/Undo).' };
    },
  },
  {
    name: 'switch', mode: 'propose', mutates: false,
    description: 'Make "main" or an open proposal (e.g. "p2") the active branch.',
    input: z.object({ branch: z.string() }),
    run(ctx, a) {
      const h = ctx.studio.history;
      if (a.branch !== 'main') {
        const p = h.proposal(a.branch);
        if (p.status !== 'open') throw new Error(`${p.id} is ${p.status}`);
      }
      h.data.active = a.branch;
      ctx.summary(`active → ${a.branch}`);
      return { active: a.branch };
    },
  },
  {
    name: 'undo-step', mode: 'review', mutates: false,
    description: 'Reviewer: exclude one step of a proposal (by commit id or 1-based step number). Steps that depend on it are undone too.',
    input: z.object({ proposal: z.string().optional(), step: z.union([z.string(), z.number()]) }),
    run(ctx, a) {
      const h = ctx.studio.history;
      const p = h.proposal(a.proposal);
      const steps = h.steps(p);
      const s = typeof a.step === 'number' || /^\d+$/.test(String(a.step)) ? steps[Number(a.step) - 1] : steps.find((x: any) => x.id === a.step);
      if (!s) throw new Error(`no step ${a.step} in ${p.id} (has ${steps.length})`);
      const deps = h.dependents(p, s.id);
      p.undone = [...new Set([...p.undone, s.id, ...deps])];
      ctx.summary(`${p.id}: undid "${s.summary}"${deps.length ? ` (+${deps.length} dependent)` : ''}`);
      return { proposal: p.id, undone: s.id, alsoUndone: deps };
    },
  },
  {
    name: 'keep', mode: 'review', mutates: false,
    description: 'Reviewer: re-include a previously undone step.',
    input: z.object({ proposal: z.string().optional(), step: z.union([z.string(), z.number()]) }),
    run(ctx, a) {
      const h = ctx.studio.history;
      const p = h.proposal(a.proposal);
      const steps = h.steps(p);
      const s = typeof a.step === 'number' || /^\d+$/.test(String(a.step)) ? steps[Number(a.step) - 1] : steps.find((x: any) => x.id === a.step);
      if (!s) throw new Error(`no step ${a.step} in ${p.id}`);
      p.undone = p.undone.filter((x: string) => x !== s.id);
      ctx.summary(`${p.id}: kept "${s.summary}"`);
      return { proposal: p.id, kept: s.id };
    },
  },
  {
    name: 'commit-proposal', mode: 'review', mutates: false,
    description: 'Merge the kept steps of a proposal onto main (one main commit per kept step). Undone steps stay archived.',
    input: z.object({ proposal: z.string().optional() }),
    run(ctx, a) {
      const h = ctx.studio.history;
      const p = h.proposal(a.proposal);
      const r = h.commitProposal(p);
      ctx.summary(`${p.id}: committed ${r.merged.length} change(s)${r.skipped.length ? `, ${r.skipped.length} undone` : ''}`);
      return { proposal: p.id, merged: r.merged.map((c: any) => `${c.id}: ${c.summary}`), skipped: r.skipped, note: r.mainMoved ? 'main changed since the proposal started; kept steps were applied on top' : undefined };
    },
  },
  {
    name: 'discard-proposal', mode: 'review', mutates: false,
    description: 'Discard a proposal (kept in history, never deleted).',
    input: z.object({ proposal: z.string().optional() }),
    run(ctx, a) {
      const h = ctx.studio.history;
      const p = h.proposal(a.proposal);
      h.discardProposal(p);
      ctx.summary(`${p.id} discarded`);
      return { proposal: p.id, status: p.status };
    },
  },
  {
    name: 'undo', mode: 'modify', mutates: true,
    description: 'Revert the last commit on the active branch (recorded as a new commit — nothing is lost).',
    input: z.object({}),
    run(ctx) {
      const h = ctx.studio.history;
      const head = h.data.active === 'main' ? h.data.mainHead : h.proposal().head;
      if (!head) throw new Error('nothing to undo');
      const c = h.commit(head);
      for (const ch of [...c.changes].reverse()) ctx.set(ch.path, ch.before);
      ctx.summary(`Undo "${c.summary}"`);
      return { reverted: c.id };
    },
  },
  // ── inspect ───────────────────────────────────────────────────────────
  {
    name: 'scene', mode: 'inspect', mutates: false,
    description: 'Summary of every object on the active branch: params, ops, size, check results.',
    input: z.object({}),
    run(ctx) { return ctx.studio.sceneSummary(); },
  },
  {
    name: 'inspect', mode: 'inspect', mutates: false,
    description: 'Full detail for one object: params, op graph as code, parts with bounding boxes, checks.',
    input: z.object({ object: ObjRef }),
    run(ctx, a) { return ctx.studio.inspect(ctx.obj(a.object).id); },
  },
  {
    name: 'check', mode: 'inspect', mutates: false,
    description: 'Run deterministic checks (grounded, connected, ranges…). These are the authority on anything measurable.',
    input: z.object({ object: ObjRef }),
    run(ctx, a) {
      // Always { objectId: CheckResult[] } so callers parse one shape.
      const ids = a.object ? [ctx.obj(a.object).id] : ctx.doc.objectOrder;
      const out = Object.fromEntries(ids.map((id) => [id, ctx.studio.checks(id)]));
      const all = Object.values(out).flat() as any[];
      const fail = all.filter((c) => !c.pass && !c.pending).length, pend = all.filter((c) => !c.pass && c.pending).length;
      ctx.summary(fail || pend ? `${fail} failing, ${pend} pending of ${all.length}` : `all ${all.length} checks pass`);
      return out;
    },
  },
  {
    name: 'log', mode: 'inspect', mutates: false,
    description: 'Recent commits on main (or a proposal\'s steps with --branch p1).',
    input: z.object({ branch: z.string().optional(), limit: z.number().optional() }),
    run(ctx, a) { return ctx.studio.log(a.branch, a.limit ?? 20); },
  },
  {
    name: 'proposals', mode: 'inspect', mutates: false,
    description: 'Open and past proposals with their steps, undo marks and affected parts.',
    input: z.object({ all: z.boolean().optional() }),
    run(ctx, a) { return ctx.studio.proposalsInfo(!!a.all); },
  },
  {
    name: 'ops', mode: 'inspect', mutates: false,
    description: 'The op vocabulary with argument reference and anchors.',
    input: z.object({}),
    run() { return OP_REFERENCE; },
  },
];

export const OP_REFERENCE = {
  conventions: 'Meters and degrees. Y is up; floor is y=0. Args accept numbers or expressions over params ("$seatH - $seatT", "sin($a)"). Op ids are identifiers.',
  primitives: {
    box: '{ size:[x,y,z], at?:[x,y,z] } — centered at "at"',
    cylinder: '{ r | r1,r2, h, at?, segments? } — vertical, base center at "at", extends +Y',
    sphere: '{ r, at?, segments? }',
    roundedBox: '{ size:[x,y,z], r, at? } — box with every edge rounded by r (exact, cheap). Use for seats, tops, cushions.',
    extrude: '{ profile:[[a,b],…], h, axis?: "y"|"z"|"x", center?: bool, at?, twist?: deg, scaleTop?: n|[sa,sb] (scales the far end toward profile point [0,0]) } — a polygon pushed along an axis (either winding). axis y (default): profile [[x,z]] seen from above, pushed up (shaped tops, brackets, floor plans). axis z: profile [[x,y]] seen from the front, pushed back along +Z (gable roofs, arches, chair-back outlines). axis x: profile [[z,y]] seen from the side, pushed along +X. center:true centres it on "at" along the axis. curve:true smooths the outline through its points (sharp turns stay sharp).',
    revolve: '{ profile:[[radius,y],…], curve?: true, at?, degrees?: 360, segments? } — lathe around the vertical axis. Use for vases, turned legs, lamp bases, bowls. curve:true runs a smooth spline through the profile points (keeps sharp turns like a lip or foot sharp) — use it for any flowing silhouette instead of many points.',
    mesh: '{ asset, format, units?, up?, scale?, at? } — an imported, watertight mesh (from `studio import`) as a solid you can union/cut with.',
    character: '{ height?, build?: 0..1, headSize?, armLength?, legLength?, handSize?, hair?: "short"|"none" } — the humanoid kit (made by `studio new-character`): low-poly body, stylized face, full hands, born rigged (56 Godot humanoid bones, skin weights, 33 face shapes). Faces +Z, feet on y = 0. Add clothes/hair/tools as ordinary ops unioned with it; they follow the nearest bones.',
  },
  modifiers: {
    round: 'inputs:[a] { r, segments? } — Minkowski with a sphere: rounds all edges by r but also GROWS the shape by r on every side (shrink the input by r first). Keep inputs < 20k triangles.',
    smooth: 'inputs:[a] { levels?: 1..4, sharpAngle?: deg (edges sharper than this stay creased, default 60), smoothness? } — subdivision-style smoothing for organic shapes.',
    trim: 'inputs:[a] { normal?: [0,1,0], offset?: 0 } — keep the side of the plane the normal points to. Default cuts flat at the floor: the fix for splayed legs that dip below y=0.',
  },
  transforms: {
    translate: 'inputs:[a] { by:[x,y,z] }',
    rotate: 'inputs:[a] { deg:[x,y,z], about?:[x,y,z] }',
    scale: 'inputs:[a] { by: n | [x,y,z] }',
    mirror: 'inputs:[a] { normal:[x,y,z], keep?: true } — keep=true unions original + mirror',
  },
  game: {
    collision: 'inputs:[output] { shape?: "hull" (default) | "box" | "capsule" | "sphere", padding?: m, axis?: x|y|z (capsule) } — a physics shape fitted to its input. A side product: shown in checks, exported as a collision node, never part of the visible mesh.',
    lod: 'inputs:[output] { ratio: 0.05–0.95 } — a simplified copy with about ratio × the triangles, for distance. Exported as a distance version (MSFT_lod); engines without LOD support just show the full mesh.',
  },
  booleans: { union: 'inputs:[a,b,…]', difference: 'inputs:[a, cutters…]', intersect: 'inputs:[a,b,…]', hull: 'inputs:[a,b,…]' },
  instancers: {
    placeAt: `inputs:[part] { target: opId, anchor: ${ANCHORS.join(' | ')}, inset?: m, splay?: deg (tilts instances outward about the anchor), align?: top|bottom|center } — instances named part#1..n`,
    array: 'inputs:[part] { count, step:[x,y,z] }',
  },
  tips: [
    'Model a part at the origin, then placeAt it on a named anchor — never hard-code face numbers.',
    'Splaying legs shortens their vertical reach: use h: "($seatH - $seatT) / cos($legSplay)" so they still touch the floor.',
    'Run `studio check` after every change; numbers beat eyeballing.',
    'Splayed legs dip below the floor at the outer edge: wrap the final union in trim{} (default = floor plane).',
    'Organic shape? Start from a revolve or a coarse box/hull, then smooth{levels:2}.',
    'Materials: new-object --material walnut (a preset) gives real wood grain; set-material --part "leg*" --preset black-metal changes just the legs.',
    'Several objects? place-object (on / next-to / under) and arrange keep relations as sizes change; never hand-compute positions from bounding boxes.',
    'Game asset? set-profile --profile godot-desktop|web, add a collision op, keep the budget checks green, then export --target godot|web (bakes materials into textures).',
  ],
};

/** Where a new object starts: the origin in an empty scene, otherwise clear to the right of everything. */
export function freeSpot(ctx: ToolCtx): [number, number, number] {
  let maxX = -Infinity;
  for (const id of ctx.doc.objectOrder) {
    const o = ctx.doc.objects[id];
    if (!o || o.role === 'reference') continue;
    const b = ctx.studio.evaluate(o).bbox;
    if (b) maxX = Math.max(maxX, b.max[0]);
  }
  return maxX === -Infinity ? [0, 0, 0] : [+(maxX + 0.75).toFixed(3), 0, 0];
}

function newMaterial(name: string | undefined, color: string | undefined): Material {
  const preset = presetName(name);
  const m: Material = { name: preset ?? name ?? 'default', color: color ?? resolveMaterial({ name: preset ?? 'default' }).color };
  if (!preset && !color) m.color = '#a8a29e';
  return m;
}

TOOLS.push(...CHARACTER_TOOLS);

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolsHelp(): string {
  const groups = new Map<string, ToolDef[]>();
  for (const t of TOOLS) groups.set(t.mode, [...(groups.get(t.mode) ?? []), t]);
  const lines: string[] = [];
  for (const [mode, list] of groups) {
    lines.push(`\n[${mode}]`);
    for (const t of list) {
      const shape = t.input.shape as Record<string, z.ZodType>;
      const flags = Object.entries(shape).map(([k, s]) => (s.isOptional() ? `[--${k}]` : `--${k}`)).join(' ');
      lines.push(`  ${t.name.padEnd(17)} ${flags}`);
      lines.push(`  ${''.padEnd(17)} ${t.description}`);
      if (t.example) lines.push(`  ${''.padEnd(17)} e.g. ${t.example}`);
    }
  }
  return lines.join('\n');
}
