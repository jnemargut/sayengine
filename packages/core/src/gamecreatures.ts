// Creatures into a game (`studio game import`, Decision 52): every creature in the scene as its own GLB.
// Skinned with extras.ik (core creatureskin.ts) when the live runtime has something to drive, so Godot's
// studio/creature_ik.gd steps and plants it live; otherwise, or when the skinned file doesn't validate,
// the node-per-bone baked clips (creatureGLB). Each entry says which path it took and why.
import fs from 'node:fs';
import path from 'node:path';
import { buildCreature, bakeCreature } from './rigparts.ts';
import { creatureGLB } from './creatures.ts';
import { creatureSkinnedGLB, creatureGamePath, creatureIkInfo, type CreatureGamePath } from './creatureskin.ts';
import { validateGlb } from './gameexport.ts';
import type { SceneDoc } from './types.ts';

export interface GameCreature {
  id: string; name: string; file: string; path: CreatureGamePath; reason: string;
  position: [number, number, number]; rotation: number;
  motions: Record<string, { kind: string; loop: boolean; speed: number; dir: number[]; duration: number }>;
  legs: number; chains: string[]; size: number; bytes: number;
}

export async function exportGameCreatures(doc: SceneDoc, outDir: string, opts: { baked?: boolean } = {}): Promise<Array<GameCreature | { id: string; name: string; error: string }>> {
  fs.mkdirSync(outDir, { recursive: true });
  const list: Array<GameCreature | { id: string; name: string; error: string }> = [];
  for (const id of doc.objectOrder) {
    const obj: any = doc.objects[id];
    if (!obj?.creature || obj.role === 'reference') continue;
    try {
      const c = buildCreature(obj.creature.def);
      const clips = Object.entries(obj.creature.motions as Record<string, any>).map(([mid, m]) => bakeCreature(c, mid, m));
      let pick: { path: CreatureGamePath; reason: string } = opts.baked ? { path: 'baked', reason: 'forced (--baked true)' } : creatureGamePath(c);
      let glb: Uint8Array | null = null;
      if (pick.path === 'skinned-live') {
        glb = creatureSkinnedGLB(c, clips);
        const v = await validateGlb(glb);
        if (!v.ok) { pick = { path: 'baked', reason: `the skinned GLB failed the glTF validator (${v.errors} error(s))` }; glb = null; }
      }
      if (!glb) glb = creatureGLB(c, clips);
      const file = path.join(outDir, `${id}.glb`);
      fs.writeFileSync(file, glb);
      const ik = creatureIkInfo(c);
      const motions = Object.fromEntries(clips.map((cl) => [cl.id, { kind: String(obj.creature.motions[cl.id]?.kind ?? cl.kind), loop: cl.loop, speed: +cl.speed.toFixed(4), dir: [...cl.dir], duration: +cl.duration.toFixed(3) }]));
      list.push({ id, name: obj.name, file: path.basename(file), path: pick.path, reason: pick.reason, position: obj.position ?? [0, 0, 0], rotation: obj.rotation ?? 0, motions, legs: ik.legs.length, chains: ik.chains.map((ch) => ch.id), size: +c.size.toFixed(4), bytes: glb.length });
    } catch (e: any) { list.push({ id, name: obj.name, error: e.message }); }
  }
  return list;
}
