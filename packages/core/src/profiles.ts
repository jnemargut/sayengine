// Game export profiles (Decision 17): budgets that show up as checks after every step, so Claude
// sees "too many triangles" on the step that causes it, not at export. Objects without a profile
// are unaffected. While an object is still being built (pending checks), budget failures are
// reported as pending, so a half-built prop doesn't shout.
import type { EvalResult } from './kernel.ts';
import type { CheckResult } from './checks.ts';
import { materialForPart } from './materials.ts';
import type { GameProfile, Material, SceneObject } from './types.ts';

export type ProfileName = GameProfile['name'];

export interface Budget {
  description: string;
  triangles: number;             // visible mesh, per object
  texture: number;               // default baked texture size (px, square)
  textureMax: number;            // largest texture allowed
  materials: number;             // glTF materials per object (≈ draw calls)
  bones: number;
  weights: number;               // skin influences per vertex
  shapes: number;                // face shape keys (morph targets) per character
  fingers: boolean;              // export finger bones (otherwise fingers follow the hand bone)
  collision: boolean;            // a collision shape is required
  lod: 'engine' | 'required';    // engine = Godot generates distance versions on import
  lodAbove: number;              // with lod 'required': objects above this many triangles need a lod op
}

export const PROFILES: Record<ProfileName, Budget> = {
  'godot-desktop': { description: 'Godot 4, desktop (Steam). Godot makes its own distance versions on import.', triangles: 20000, texture: 1024, textureMax: 2048, materials: 4, bones: 64, weights: 4, shapes: 64, fingers: true, collision: true, lod: 'engine', lodAbove: Infinity },
  web: { description: 'three.js in a desktop browser.', triangles: 10000, texture: 1024, textureMax: 1024, materials: 3, bones: 64, weights: 4, shapes: 48, fingers: true, collision: true, lod: 'required', lodAbove: 3000 },
  'web-mobile': { description: 'three.js on phones: small downloads, few draw calls.', triangles: 5000, texture: 512, textureMax: 512, materials: 2, bones: 32, weights: 4, shapes: 33, fingers: false, collision: true, lod: 'required', lodAbove: 1500 },
};

/** The profile's budgets with the object's overrides applied. */
export function budgetFor(p: GameProfile): Budget {
  const b = { ...PROFILES[p.name] };
  if (p.triangles) b.triangles = p.triangles;
  if (p.textureMax) b.textureMax = p.textureMax;
  if (p.texture) b.texture = p.texture;
  if (p.materials) b.materials = p.materials;
  if (p.bones !== undefined) b.bones = p.bones;
  if (p.weights) b.weights = p.weights;
  if (p.shapes !== undefined) b.shapes = p.shapes;
  if (p.fingers !== undefined) b.fingers = p.fingers;
  if (p.collision !== undefined) b.collision = p.collision;
  return b;
}

/** The export target a profile belongs to. */
export const targetOf = (p: ProfileName): 'godot' | 'web' => (p === 'godot-desktop' ? 'godot' : 'web');

export interface MaterialGroup {
  key: string;
  textured: boolean;             // opaque: baked into the asset's texture; glass/translucent keep factors
  material: Material;            // representative (special properties: clearcoat, transmission…)
  parts: string[];
}

/**
 * How an object's parts become glTF materials in a game export: every opaque part shares ONE
 * baked material (colour, grain, roughness, metalness live in the textures) unless it needs a
 * different shading model (clearcoat/glaze, glass, translucency).
 */
export function materialGroups(obj: SceneObject, res: EvalResult): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();
  for (const p of res.parts) {
    const m = materialForPart(obj, p.name.startsWith('~') ? obj.output ?? '' : p.name);
    const textured = !(m.transmission && m.transmission > 0) && (m.opacity ?? 1) >= 1;
    const special = textured
      ? { cc: m.clearcoat ? +m.clearcoat.toFixed(2) : 0, ccr: m.clearcoat ? +(m.clearcoatRoughness ?? 0.1).toFixed(2) : 0 }
      : { t: m.transmission ?? 0, ior: m.ior ?? 1.5, th: m.thickness ?? 0, o: m.opacity ?? 1, c: m.color, r: m.roughness };
    const key = (textured ? 'T' : 'F') + JSON.stringify(special);
    const g = groups.get(key) ?? { key, textured, material: m, parts: [] };
    g.parts.push(p.name);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export interface ProfileCtx {
  evaluateOp(obj: SceneObject, opId: string): EvalResult;
  overlap(a: EvalResult, b: EvalResult): number;
}

/** Budget, collision and distance-version checks for an object with a game profile. */
export function profileChecks(obj: SceneObject, res: EvalResult, ctx: ProfileCtx, midBuild: boolean): CheckResult[] {
  if (!obj.profile || !res.ok) return [];
  const b = budgetFor(obj.profile);
  const name = obj.profile.name;
  const out: CheckResult[] = [];
  // over budget while still building = pending ("so far"), not failing
  const budget = (c: CheckResult): CheckResult => (!c.pass && midBuild ? { ...c, pending: true, detail: `so far: ${c.detail}` } : c);

  out.push(budget({
    id: 'budget-triangles', label: `Triangles within ${name} budget`, pass: res.triangles <= b.triangles,
    detail: `${res.triangles.toLocaleString('en')} / ${b.triangles.toLocaleString('en')}${res.triangles > b.triangles ? ' — lower segments, simplify the shape, or add-op lod and use it as the output' : ''}`,
  }));
  out.push({
    id: 'budget-texture', label: `Texture within ${name} budget`, pass: b.texture <= b.textureMax,
    detail: b.texture <= b.textureMax ? `${b.texture} px baked texture (max ${b.textureMax})` : `${b.texture} px over budget (${b.textureMax}) → set-profile --texture ${b.textureMax}`,
  });
  const groups = materialGroups(obj, res);
  out.push(budget({
    id: 'budget-materials', label: `Materials within ${name} budget`, pass: groups.length <= b.materials,
    detail: `${groups.length} / ${b.materials} (${groups.map((g) => g.textured ? `baked: ${g.parts.length} part${g.parts.length === 1 ? '' : 's'}${g.material.clearcoat ? ' + glaze' : ''}` : `${g.material.name}: ${g.parts.join(', ')}`).join('; ')})`,
  }));
  if (res.rig) {
    const all = res.rig.rig.bones.length;
    const fingers = res.rig.rig.bones.filter((x) => /(Thumb|Index|Middle|Ring|Little)/.test(x.name)).length;
    const bones = b.fingers ? all : all - fingers;
    out.push(budget({
      id: 'budget-bones', label: `Bones within ${name} budget`, pass: bones <= b.bones,
      detail: `${bones} / ${b.bones} bones${b.fingers ? '' : ` (finger bones dropped: fingers follow the hand)`}, ≤ ${b.weights} weights per vertex${bones > b.bones ? ` — set-profile --fingers false drops the ${fingers} finger bones` : ''}`,
    }));
    const shapes = res.rig.rig.shapeNames.length;
    out.push(budget({ id: 'budget-shapes', label: `Face shapes within ${name} budget`, pass: shapes <= b.shapes, detail: `${shapes} / ${b.shapes} shape keys (15 speech + ${shapes - 15} expression)` }));
  } else {
    out.push({ id: 'budget-bones', label: `Bones within ${name} budget`, pass: true, detail: `no skeleton (0 / ${b.bones} bones, ≤ ${b.weights} weights per vertex)` });
  }

  const cols = obj.opOrder.filter((id) => obj.ops[id]?.op === 'collision');
  if (!cols.length) {
    if (b.collision) out.push({ id: 'collision', label: 'Has a collision shape', pass: false, pending: midBuild, detail: `${name} needs one for physics — add-op --id col --op collision --inputs '["${obj.output}"]' --args '{"shape":"hull"}' (box | hull | capsule | sphere)` });
  } else {
    for (const id of cols) {
      const cr = ctx.evaluateOp(obj, id);
      if (!cr.ok) { out.push({ id: `collision-${id}`, label: `Collision "${id}" fits`, pass: false, detail: cr.error ?? 'collision op failed' }); continue; }
      const inside = res.volume > 0 ? ctx.overlap(res, cr) / res.volume : 0;
      const extra = res.volume > 0 ? cr.volume / res.volume : 0;
      const pct = Math.round(inside * 100);
      out.push({
        id: `collision-${id}`, label: `Collision "${id}" covers the mesh`, pass: inside >= 0.95,
        detail: inside >= 0.95
          ? `${cr.collision?.shape ?? 'shape'} encloses ${pct}% of the mesh (${extra.toFixed(1)}× its volume${extra > 4 ? ' — loose: a hull or capsule would hug it closer' : ''})`
          : `only ${pct}% of the mesh is inside the ${cr.collision?.shape ?? 'shape'}: things would pass through it — use shape "hull", or fit it to the output op`,
      });
    }
  }

  const lods = obj.opOrder.filter((id) => obj.ops[id]?.op === 'lod');
  if (b.lod === 'engine') {
    out.push({ id: 'lod', label: 'Distance versions (LOD)', pass: true, detail: lods.length ? `${lods.length} lod op(s) exported for three.js; Godot also generates its own on import` : 'Godot generates distance versions on import' });
  } else if (res.triangles > b.lodAbove && !lods.length) {
    out.push(budget({ id: 'lod', label: 'Distance versions (LOD)', pass: false, detail: `${res.triangles} triangles is above ${b.lodAbove} for ${name}: add-op --id lod1 --op lod --inputs '["${obj.output}"]' --args '{"ratio":0.4}'` }));
  } else if (lods.length) {
    const info = lods.map((id) => { const r = ctx.evaluateOp(obj, id); return r.ok ? `${id} ${r.triangles} tris (${Math.round((r.triangles / res.triangles) * 100)}%)` : `${id}: ${r.error}`; });
    out.push({ id: 'lod', label: 'Distance versions (LOD)', pass: lods.every((id) => ctx.evaluateOp(obj, id).ok), detail: info.join(', ') });
  }
  return out;
}
