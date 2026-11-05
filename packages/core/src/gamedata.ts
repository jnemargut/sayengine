// What `studio game import` needs besides the GLB (Phase 9): effects with their resolved positions and
// colours, the UI kit, and every recorded line's audio (Fire's Dying pain #9: only cutscene voices were
// exported, so the game had no way to play a line on its own).
import type { Studio } from './studio.ts';
import type { SceneDoc } from './types.ts';
import { largestTop } from './scene.ts';
import { DEFAULT_FIRE_PALETTE, resolveColour, type EffectDef } from './effects.ts';
import type { UiKit } from './uikit.ts';

type V3 = [number, number, number];
export interface EffectBundle { def: EffectDef; at: V3; colours: Record<string, string> }
export interface LineBundle { character: string; line: string; text: string; clip: string; duration: number; sync: number; audio: string | null }   // audio: base64 WAV

/** Where an effect plays: its position, or the largest flat top of its object (the hearth, the chimney). */
export function effectAt(studio: Studio, doc: SceneDoc, fx: EffectDef): V3 {
  if (fx.at) return fx.at;
  const o = fx.object ? doc.objects[fx.object] : undefined;
  if (!o) return [0, 0, 0];
  const r = studio.evaluate(o);
  const top = largestTop(r);
  if (top) return [top.c[0], top.y, top.c[1]];
  return r.bbox ? [(r.bbox.min[0] + r.bbox.max[0]) / 2, r.bbox.max[1], (r.bbox.min[2] + r.bbox.max[2]) / 2] : o.position;
}

export function gameData(studio: Studio, doc: SceneDoc = studio.doc()) {
  const look = (doc as any).look?.palette as Record<string, string> | undefined;
  const effects: EffectBundle[] = [];
  for (const fx of Object.values(doc.effects ?? {})) {
    const pal = { ...DEFAULT_FIRE_PALETTE, ...(look ?? {}), ...(fx.palette ?? {}) };
    const colours: Record<string, string> = {};
    for (const l of fx.layers) for (const c of l.colour) colours[c] = resolveColour(c, pal);
    effects.push({ def: fx, at: effectAt(studio, doc, fx), colours });
  }
  const lines: LineBundle[] = [];
  for (const id of doc.objectOrder) {
    const o = doc.objects[id];
    for (const [line, clip] of Object.entries(o?.character?.lines ?? {})) {
      let audio: string | null = null;
      try { audio = Buffer.from(studio.assets.get(clip.audio)).toString('base64'); } catch { /* not recorded */ }
      lines.push({ character: o.name, line, text: clip.text, clip: `line:${line}`, duration: clip.duration, sync: clip.sync ?? 0, audio });
    }
  }
  return { effects, ui: (doc.ui ?? null) as UiKit | null, lines };
}
export type GameData = ReturnType<typeof gameData>;
