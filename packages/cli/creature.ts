// `studio new-creature --builder blender …` — organic creatures built in Blender (real topology,
// a Rigify rig, baked coat, scripted clips). Runs in the CLI process (Blender takes a minute; the
// daemon stays free), then brings the GLB in through the rigged-import side door (import-character).
import path from 'node:path';
import { DIR, ensureDaemon, callTool } from './client.ts';

export const CREATURE_FLAGS: Record<string, string> = {
  '--builder': 'blender (the Blender builder; without it new-creature makes a rig-part creature)',
  '--plan': 'cat (bipeds and other plans follow)',
  '--preset': 'british-shorthair | domestic-shorthair',
  '--name': 'creature name (default: the preset)',
  '--build': '0..1 or lean | normal | chubby | fat',
  '--legLength': 'scale on the legs, 0.7..1.4 (default 1)',
  '--bodyLength': 'scale on the barrel, 0.75..1.3 (default 1)',
  '--headSize': 'scale on the head, 0.8..1.25 (default 1)',
  '--coat': 'blue | grey | black | white | cream | red | brown | lilac | silver | #rrggbb',
  '--pattern': 'solid | tabby | tuxedo | calico',
  '--eyeColor': 'copper | amber | gold | green | blue | hazel | #rrggbb',
  '--furLength': 'metres (default 0.006): deepens the pile',
  '--faces': 'body quads (default 9000; triangles are about twice this plus ~2.5k for eyes, ears, whiskers)',
  '--texture': 'coat texture size (default 1024)',
  '--renders': 'true for the look renders (Eevee), or a JSON list of shot names',
  '--clips': 'JSON list: a subset of idle, walk, trot, sit, loaf, jump, land, swat, carried, squash',
  '--out': 'output folder (default .studio/creatures/<name>)',
  '--import': 'false to skip bringing it into the studio scene (default true)',
  '--rigify': 'false to skip generating the Rigify control rig',
};

export async function blenderCreatureCli(rest: string[], parseFlags: (a: string[]) => Record<string, unknown>) {
  const f = parseFlags(rest);
  if (f.help) {
    return { command: 'new-creature --builder blender', description: 'Build an organic creature in Blender, headless: a body from a skeleton and a shape field (one clean all-quad surface, no metaballs), a Rigify control rig plus a game deform skeleton bound with automatic weights (smoothed, the belly kept off the legs), a baked coat (colour with fur variation, a pile normal map, sheen), separate eyes that only turn, lids, ears, nose and whiskers, and clips keyed by script (idle, walk, trot, sit, loaf, jump, land, swat, carried, squash). The GLB is checked by the Khronos validator and the clip motion checks, then imported with import-character.', flags: CREATURE_FLAGS, example: 'studio new-creature --builder blender --plan cat --preset british-shorthair --build fat --coat blue --eyeColor copper' };
  }
  const { buildCreature, BlenderMissing, findBlender, blenderVersion } = await import('../core/src/blender/creature.ts');
  const name = String(f.name ?? f.preset ?? 'creature');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creature';
  const out = path.resolve(DIR, String(f.out ?? path.join('.studio', 'creatures', slug)));
  const bin = findBlender();
  if (!bin) { const e = new BlenderMissing(); return { ok: false, tool: 'new-creature', error: e.message, hint: e.hint }; }
  const known = new Set(Object.keys(CREATURE_FLAGS).map((k) => k.slice(2)));
  const unknown = Object.keys(f).filter((k) => !known.has(k));
  if (unknown.length) return { ok: false, tool: 'new-creature', error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`, flags: Object.keys(CREATURE_FLAGS) };
  let build;
  try {
    build = await buildCreature({
      plan: (f.plan as any) ?? 'cat', preset: String(f.preset ?? 'british-shorthair'), name: slug,
      ...(f.build !== undefined ? { build: f.build as any } : {}),
      ...(f.legLength !== undefined ? { legLength: Number(f.legLength) } : {}),
      ...(f.bodyLength !== undefined ? { bodyLength: Number(f.bodyLength) } : {}),
      ...(f.headSize !== undefined ? { headSize: Number(f.headSize) } : {}),
      ...(f.coat !== undefined ? { coat: String(f.coat) } : {}),
      ...(f.pattern !== undefined ? { pattern: String(f.pattern) } : {}),
      ...(f.eyeColor !== undefined ? { eyeColor: String(f.eyeColor) } : {}),
      ...(f.furLength !== undefined ? { furLength: Number(f.furLength) } : {}),
      ...(f.faces !== undefined ? { faces: Number(f.faces) } : {}),
      ...(f.texture !== undefined ? { texture: Number(f.texture) } : {}),
      ...(f.renders !== undefined ? { renders: f.renders as any } : {}),
      ...(f.clips !== undefined ? { clips: f.clips as any } : {}),
      ...(f.rigify !== undefined ? { rigify: f.rigify !== false && f.rigify !== 'false' } : {}),
      out,
    }, { blender: bin, onLog: (l) => process.stderr.write(`blender: ${l}\n`) });
  } catch (e: any) {
    return { ok: false, tool: 'new-creature', error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  }
  const failing = Object.entries(build.motion ?? {}).flatMap(([clip, ks]) => ks.filter((k) => !k.pass).map((k) => `${clip}: ${k.name} (${k.detail})`));
  const result: Record<string, unknown> = {
    glb: build.glb, blend: build.blend, triangles: build.triangles, clips: Object.keys(build.clips), bones: build.bones.length,
    rigify: build.rigify, blender: blenderVersion(bin) ?? build.blender, seconds: build.seconds,
    validation: build.validation, motionChecks: failing.length ? { failing } : 'all pass', ...(build.renders ? { renders: build.renders } : {}),
  };
  if (f.import === false || f.import === 'false') return { ok: !!build.validation?.ok, tool: 'new-creature', result };
  const note = await ensureDaemon();
  if (note) process.stderr.write(`studio: ${note}\n`);
  const imp: any = await callTool('import-character', { file: build.glb, name });
  return { ok: !!build.validation?.ok && imp.ok, tool: 'new-creature', result: { ...result, imported: imp.ok ? imp.result : undefined }, ...(imp.ok ? {} : { error: `built, but the import failed: ${imp.error}` }) };
}
