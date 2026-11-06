// Material presets (physically based). A SceneObject's material stores the preset name plus any
// overrides; resolveMaterial() fills in the rest. The view, the AI renders and GLB export all read
// the resolved values, so "walnut" means the same thing everywhere.
import type { Material, SceneObject } from './types.ts';

type Preset = Omit<Material, 'name'> & { description: string };

export const MATERIAL_PRESETS: Record<string, Preset> = {
  walnut: { description: 'dark brown hardwood, oiled', color: '#5e3f2c', roughness: 0.55, grain: { color2: '#3a2417', scale: 1, contrast: 0.65 } },
  oak: { description: 'warm mid-tone hardwood with open grain', color: '#a8875f', roughness: 0.6, grain: { color2: '#7f6040', scale: 0.8, contrast: 0.55 } },
  maple: { description: 'pale, tight-grained hardwood', color: '#dcc29a', roughness: 0.5, grain: { color2: '#c4a476', scale: 1.4, contrast: 0.35 } },
  ash: { description: 'light hardwood with strong straight grain', color: '#d2bb94', roughness: 0.55, grain: { color2: '#a88a5d', scale: 0.9, contrast: 0.5 } },
  'painted-wood': { description: 'satin paint over wood; set --color', color: '#e9e5dc', roughness: 0.45, clearcoat: 0.15, clearcoatRoughness: 0.4 },
  'glazed-ceramic': { description: 'glossy glaze over ceramic; set --color', color: '#e8e2d6', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 },
  'matte-ceramic': { description: 'unglazed stoneware, chalky', color: '#d6cdc0', roughness: 0.92 },
  terracotta: { description: 'unglazed red clay', color: '#b4613d', roughness: 0.88 },
  'brushed-metal': { description: 'brushed steel / aluminium', color: '#b8bbbe', metalness: 1, roughness: 0.32 },
  'black-metal': { description: 'black powder-coated steel', color: '#262626', metalness: 0.75, roughness: 0.48 },
  brass: { description: 'satin brass', color: '#c6a050', metalness: 1, roughness: 0.28 },
  plastic: { description: 'smooth moulded plastic; set --color', color: '#eeeeec', roughness: 0.38 },
  glass: { description: 'clear glass', color: '#ffffff', roughness: 0.04, transmission: 1, ior: 1.5, thickness: 0.006 },
  concrete: { description: 'cast concrete', color: '#a5a29c', roughness: 0.95 },
  fabric: { description: 'woven upholstery; set --color', color: '#8b8f86', roughness: 1 },
  default: { description: 'neutral matte', color: '#a8a29e', roughness: 0.6 },
};

/** Aliases people (and models) actually type. */
const ALIASES: Record<string, string> = {
  ceramic: 'glazed-ceramic', 'glazed ceramic': 'glazed-ceramic', 'matte ceramic': 'matte-ceramic', stoneware: 'matte-ceramic',
  steel: 'brushed-metal', aluminium: 'brushed-metal', aluminum: 'brushed-metal', metal: 'brushed-metal', 'black metal': 'black-metal',
  paint: 'painted-wood', painted: 'painted-wood', wood: 'oak', clay: 'terracotta',
};

export function presetName(name: string | undefined): string | null {
  if (!name) return null;
  const k = name.toLowerCase().trim();
  if (MATERIAL_PRESETS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  const dashed = k.replace(/\s+/g, '-');
  return MATERIAL_PRESETS[dashed] ? dashed : null;
}

const FIELDS = ['color', 'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'opacity', 'grain', 'paint'] as const;

/** Preset values with the material's own fields layered on top. */
export function resolveMaterial(m: Partial<Material> | undefined): Material {
  const name = m?.name ?? 'default';
  const p = MATERIAL_PRESETS[presetName(name) ?? 'default'];
  const out: Material = { name, color: p.color, roughness: p.roughness ?? 0.6, metalness: p.metalness ?? 0 };
  for (const k of FIELDS) if ((p as any)[k] !== undefined) (out as any)[k] = (p as any)[k];
  for (const k of FIELDS) if (m && (m as any)[k] !== undefined) (out as any)[k] = (m as any)[k];
  if (out.grain === null) delete out.grain;
  return out;
}

function globRe(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\#]/g, '\\$&')).join('.*') + '$');
}

/** The material a part ends up with: the object's, unless a part rule matches (last match wins). */
export function materialForPart(obj: Pick<SceneObject, 'material' | 'partMaterials'>, part: string): Material {
  let m: Partial<Material> = obj.material;
  for (const r of obj.partMaterials ?? []) if (globRe(r.parts).test(part) || globRe(r.parts).test(part.replace(/#\d+$/, '')) || globRe(r.parts).test(part.replace(/~\d+$/, ''))) m = r.material;
  return resolveMaterial(m);
}

export function describeMaterial(m: Material): string {
  const r = resolveMaterial(m);
  const bits = [r.name];
  if (presetName(m.name) && m.color && m.color.toLowerCase() !== MATERIAL_PRESETS[presetName(m.name)!].color) bits.push(m.color);
  if (!presetName(m.name)) bits.push(r.color);
  return bits.join(' ');
}
