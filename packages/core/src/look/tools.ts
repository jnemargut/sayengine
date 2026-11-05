// The look module's tool group (Decision 29): looks live in the scene doc (doc.look), so every change is
// one reviewable step with history, undo and proposals. doc.look = { active, looks: {name: Look}, palette }
// (palette mirrors the active look's named colours: effects already read doc.look.palette).
import { z } from 'zod';
import type { ToolDef } from '../tools.ts';
import { LookZ, PRESETS, buildLut, bakeHex, engineLight, gradeSceneLinear, parseLook, type Look } from './look.ts';
import { hexToLinear, rgbToHex, type RGB } from './color.ts';

export interface LookState { active: string | null; looks: Record<string, Look>; palette?: Record<string, string> }
export function lookState(doc: any): LookState { return { active: doc.look?.active ?? null, looks: doc.look?.looks ?? {}, palette: doc.look?.palette }; }
/** The look the outputs use: the active one, or null (engines keep their own defaults). */
export function activeLook(doc: any): Look | null { const s = lookState(doc); return s.active && s.looks[s.active] ? parseLook(s.looks[s.active]) : null; }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge (objects merge, arrays and values replace; null deletes a key). */
export function mergeLook(a: any, b: any): any {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) { if (v === null) delete out[k]; else out[k] = isObj(v) && isObj(a[k]) ? mergeLook(a[k], v) : v; }
  return out;
}

function zodMessage(e: any): string {
  return (e.issues ?? []).map((i: any) => `${i.path.join('.') || 'look'}: ${i.message}`).join('; ') || e.message;
}

/** A short, checkable description of what a look does to a few known colours (no scores out of 10). */
export function lookSummary(look: Look) {
  const probe = (hex: string, light = 1): string => rgbToHex(gradeSceneLinear(look, hexToLinear(hex).map((v) => v * light) as RGB));
  const lut = buildLut(look);
  let lo = 1, hi = 0; for (const v of lut.data) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return {
    name: look.name, label: look.label, curve: look.tonemap.curve, exposure: look.tonemap.exposure,
    greys: { '18% grey': probe('#757575'), 'white wall in sun': probe('#ffffff', 1.4), 'shadow': probe('#757575', 0.15) },
    lut: { size: lut.size, outputRange: [+lo.toFixed(3), +hi.toFixed(3)] },
    bakeFallback: { brick: bakeHex(look, '#9c4f3e'), limestone: bakeHex(look, '#d6cbb5'), glass: bakeHex(look, '#2f3b45') },
    sun: engineLight(look).toSun.map((v) => +v.toFixed(3)), outline: look.outline.enabled ? `${look.outline.width}px ${look.outline.color}` : 'off',
    toon: look.toon.enabled ? `${look.toon.bands} bands` : 'off', tweaks: Object.keys(look.materials),
    board: look.board ?? null,
  };
}

export const LOOK_TOOLS: ToolDef[] = [
  {
    name: 'look-new', mode: 'create', mutates: true,
    description: `Add a whole-scene look (Decision 29: looks are data) from a preset (${Object.keys(PRESETS).join(', ')}) or a full --record, and make it the active look unless --activate false. One record drives the studio view, Godot, three.js, bakes and thumbnails.`,
    input: z.object({ preset: z.string().optional(), name: z.string().optional(), record: z.any().optional().describe('a full look record (JSON)'), activate: z.boolean().optional() }),
    example: 'studio look-new --preset neon-night',
    run(ctx, a) {
      if (!a.preset && !a.record) throw new Error(`--preset (${Object.keys(PRESETS).join(', ')}) or --record {...}`);
      if (a.preset && !PRESETS[a.preset]) throw new Error(`unknown preset "${a.preset}" (have: ${Object.keys(PRESETS).join(', ')})`);
      let look: Look;
      try { look = parseLook(mergeLook(a.preset ? structuredClone(PRESETS[a.preset]) : {}, { ...(a.record ?? {}), ...(a.name ? { name: a.name } : {}) })); } catch (e: any) { throw new Error(zodMessage(e)); }
      const s = lookState(ctx.doc);
      const existed = !!s.looks[look.name], act = a.activate !== false || !s.active;
      ctx.set(['look', 'looks', look.name], look);
      if (act) { ctx.set(['look', 'active'], look.name); ctx.set(['look', 'palette'], look.palette); }
      ctx.summary(`${existed ? 'Replaced' : 'Added'} look "${look.name}"${act ? ' (active)' : ''}`);
      return lookSummary(look);
    },
  },
  {
    name: 'look-set', mode: 'modify', mutates: true,
    description: 'Change a look: --set is a partial record deep-merged into it (null removes a key), e.g. {"grade":{"saturation":0.9}} for "not too saturated", {"tonemap":{"curve":"aces"}}, {"fog":{"end":900}}, {"materials":{"lit":{"emissionEnergy":3}}}, {"board":{"references":["refs/neon1.jpg"],"colourfulness":[38,52]}}.',
    input: z.object({ look: z.string().optional().describe('look name (default: the active look)'), set: z.any() }),
    example: 'studio look-set --look day-toy --set \'{"grade":{"saturation":0.95}}\'',
    run(ctx, a) {
      const s = lookState(ctx.doc);
      const name = a.look ?? s.active;
      if (!name || !s.looks[name]) throw new Error(`no look "${name ?? ''}" (have: ${Object.keys(s.looks).join(', ') || 'none — studio look-new --preset day-toy'})`);
      if (!isObj(a.set)) throw new Error('--set must be a JSON object (a partial look record)');
      if (a.set.name && a.set.name !== name) throw new Error('rename with look-new --record, not look-set');
      let look: Look;
      try { look = parseLook(mergeLook(s.looks[name], a.set)); } catch (e: any) { throw new Error(zodMessage(e)); }
      ctx.set(['look', 'looks', name], look);
      if (s.active === name) ctx.set(['look', 'palette'], look.palette);
      ctx.summary(`Look "${name}": ${Object.keys(a.set).join(', ')} changed`);
      return lookSummary(look);
    },
  },
  {
    name: 'look-use', mode: 'modify', mutates: true,
    description: 'Make a look the active one (what `studio game import`, the view and renders use). --look none switches looks off.',
    input: z.object({ look: z.string() }),
    example: 'studio look-use --look neon-night',
    run(ctx, a) {
      const s = lookState(ctx.doc);
      if (a.look === 'none') { ctx.set(['look', 'active'], null); ctx.summary('Looks off'); return { active: null }; }
      if (!s.looks[a.look]) throw new Error(`no look "${a.look}" (have: ${Object.keys(s.looks).join(', ') || 'none'})`);
      ctx.set(['look', 'active'], a.look);
      ctx.set(['look', 'palette'], s.looks[a.look].palette);
      ctx.summary(`Active look: ${a.look}`);
      return { active: a.look };
    },
  },
  {
    name: 'look-remove', mode: 'modify', mutates: true,
    description: 'Remove a look from the scene.',
    input: z.object({ look: z.string() }),
    run(ctx, a) {
      const s = lookState(ctx.doc);
      if (!s.looks[a.look]) throw new Error(`no look "${a.look}"`);
      ctx.set(['look', 'looks', a.look], undefined);
      if (s.active === a.look) ctx.set(['look', 'active'], null);
      ctx.summary(`Removed look ${a.look}`);
      return { removed: a.look };
    },
  },
  {
    name: 'look-info', mode: 'inspect', mutates: false,
    description: 'The scene\'s looks: which is active, and per look its curve, what it does to greys, the LUT\'s range, the bake fallback\'s colours, light, outline, toon, material tweaks and its board (references and targets). --record true includes the full record.',
    input: z.object({ look: z.string().optional(), record: z.boolean().optional() }),
    example: 'studio look-info --look neon-night',
    run(ctx, a) {
      const s = lookState(ctx.doc);
      const names = a.look ? [a.look] : Object.keys(s.looks);
      for (const n of names) if (!s.looks[n]) throw new Error(`no look "${n}"`);
      ctx.summary(`${names.length} look(s); active ${s.active ?? 'none'}`);
      return { active: s.active, presets: Object.keys(PRESETS), looks: names.map((n) => ({ ...lookSummary(parseLook(s.looks[n])), ...(a.record ? { record: s.looks[n] } : {}) })) };
    },
  },
];

export { LookZ };
