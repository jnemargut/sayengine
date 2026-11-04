// The single typed tool registry (Decision 5). The `studio` CLI, the browser view and
// (optionally, later) an MCP adapter are all generated from this list.
import { z } from 'zod';
import { OP_NAMES, DEFAULT_RULES, type SceneDoc, type SceneObject, type OpNode, type Param } from './types.ts';
import { ANCHORS } from './kernel.ts';

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
      color: z.string().optional(), material: z.string().optional(),
    }),
    example: `studio new-object --name "Walnut stool" --type stool --material walnut --color "#6b4a33"`,
    run(ctx, a) {
      let id = a.id ?? slug(a.name);
      while (ctx.doc.objects[id]) id = id + '-2';
      const obj: SceneObject = {
        id, name: a.name, semanticType: a.type.toLowerCase(),
        params: {}, ops: {}, opOrder: [], output: null,
        material: { name: a.material ?? 'default', color: a.color ?? '#a8a29e', roughness: 0.6 },
        position: a.position ?? [0, 0, 0], rules: [],
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
    description: 'Add a construction op (level 3). Primitives: box{size,at} (centered at "at"), cylinder{r|r1,r2,h,at} (Y-up, base at "at"), sphere{r,at}, roundedBox{size,r,at}, extrude{profile,h,axis?:y|z|x,center?,at}, revolve{profile:[[r,y]…],at}. Modifiers take inputs:[id]: round{r}, smooth{levels}, trim{normal?,offset?}. Transforms take inputs:[id]: translate{by}, rotate{deg,about?}, scale{by}, mirror{normal,keep?}. Booleans: union/difference/intersect/hull with inputs. Instancers: placeAt{target,anchor,inset?,splay?,align?} with inputs:[part], array{count,step}. The first op added becomes the output unless --output false; pass --output true to make this op the output.',
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
    description: 'Set material name/color/roughness.',
    input: z.object({ object: ObjRef, name: z.string().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), roughness: z.number().min(0).max(1).optional() }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      const m = { ...o.material, ...(a.name ? { name: a.name } : {}), ...(a.color ? { color: a.color } : {}), ...(a.roughness !== undefined ? { roughness: a.roughness } : {}) };
      ctx.set(['objects', o.id, 'material'], m);
      ctx.summary(`Material → ${m.name} ${m.color}`);
      return { material: m };
    },
  },
  {
    name: 'move-object', mode: 'modify', mutates: true,
    description: 'Place an object in the scene (meters; y=0 is the floor).',
    input: z.object({ object: ObjRef, position: z.tuple([z.number(), z.number(), z.number()]) }),
    run(ctx, a) {
      const o = ctx.obj(a.object);
      ctx.set(['objects', o.id, 'position'], a.position);
      ctx.summary(`Moved ${o.name} to [${a.position.join(', ')}]`);
      return { position: a.position };
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
    extrude: '{ profile:[[a,b],…], h, axis?: "y"|"z"|"x", center?: bool, at?, twist?: deg, scaleTop?: n|[sa,sb] (scales the far end toward profile point [0,0]) } — a polygon pushed along an axis (either winding). axis y (default): profile [[x,z]] seen from above, pushed up (shaped tops, brackets, floor plans). axis z: profile [[x,y]] seen from the front, pushed back along +Z (gable roofs, arches, chair-back outlines). axis x: profile [[z,y]] seen from the side, pushed along +X. center:true centres it on "at" along the axis.',
    revolve: '{ profile:[[radius,y],…], at?, degrees?: 360, segments? } — lathe around the vertical axis. Use for vases, turned legs, lamp bases, bowls.',
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
  ],
};

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
