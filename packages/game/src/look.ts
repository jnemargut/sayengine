// The look on its way into a game (Decision 29): assets/studio/look/ gets look.json (the record plus
// derived engine numbers), lut.png (the 33³ grade as a strip Godot slices into a Texture3D and the web
// reads into a Data3DTexture), look.cube (for other tools) and, for Godot, an import file that keeps the
// strip lossless. Where the renderer can't grade (Godot's Compatibility renderer, or fallback "bake"),
// the grade is baked into the scene's colours instead.
import fs from 'node:fs';
import path from 'node:path';
import { buildLut, cubeText, lutStrip, parseLook } from '../../core/src/look/look.ts';
import { encodePng } from '../../core/src/look/png.ts';
import { bakeGlb } from '../../core/src/look/bake.ts';

export function godotRenderer(dir: string): string {
  const f = path.join(dir, 'project.godot');
  if (!fs.existsSync(f)) return 'forward_plus';
  const m = fs.readFileSync(f, 'utf8').match(/renderer\/rendering_method\s*=\s*"([^"]+)"/);
  return m ? m[1] : 'forward_plus';
}

const IMPORT = (res: string) => `[remap]

importer="texture"
type="CompressedTexture2D"

[deps]

source_file="${res}"

[params]

compress/mode=0
compress/high_quality=false
compress/lossy_quality=1.0
mipmaps/generate=false
roughness/mode=0
process/fix_alpha_border=false
process/premult_alpha=false
process/size_limit=0
detect_3d/compress_to=0
`;

export function writeLook(dir: string, engine: 'godot' | 'web', rec: any | null): { files: string[]; baked?: { glb: string; vertexColours: number; materials: number; textures: number }[]; mode: 'none' | 'grade' | 'bake' } {
  const out = path.join(dir, 'assets', 'studio', 'look');
  fs.rmSync(out, { recursive: true, force: true });
  if (!rec) return { files: [], mode: 'none' };
  fs.mkdirSync(out, { recursive: true });
  const { version, derived, ...record } = rec;
  const look = parseLook(record);
  const files: string[] = [];
  const put = (n: string, body: string | Uint8Array) => { const f = path.join(out, n); fs.writeFileSync(f, body); files.push(f); };
  const strip = lutStrip(buildLut(look));
  put('lut.png', encodePng(strip.rgba, strip.width, strip.height));
  put('look.cube', cubeText(look));
  const bake = look.fallback === 'bake' || (look.fallback === 'auto' && engine === 'godot' && godotRenderer(dir) === 'gl_compatibility');
  put('look.json', JSON.stringify({ ...rec, baked: bake }, null, 2) + '\n');
  if (engine === 'godot') put('lut.png.import', IMPORT('res://assets/studio/look/lut.png'));
  if (!bake) return { files, mode: 'grade' };
  const baked = [];
  for (const g of ['scene.glb', 'player.glb']) {
    const f = path.join(dir, 'assets', 'studio', g);
    if (!fs.existsSync(f)) continue;
    const r = bakeGlb(new Uint8Array(fs.readFileSync(f)), look);
    fs.writeFileSync(f, r.glb);
    baked.push({ glb: g, vertexColours: r.vertexColours, materials: r.materials, textures: r.textures });
  }
  return { files, baked, mode: 'bake' };
}
