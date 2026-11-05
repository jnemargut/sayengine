// Scene sounds (Phase 10 step 2): the sounds that belong to a scene, as recipes on the shared history,
// so they sit on the live view's timeline as waveform tracks and every change is a reviewable step.
//   event — one sound (`studio sound sfx` settings: kind + seed + options) fired on a moment
//           ("Blacksmith:strike@impact") or at fixed scene seconds
//   bed   — a seamless ambience loop (forge-roar, crackle, room, city-hum, wind)
//   music — seeded music (mood, bpm, bars); its clock is the beats clock (bars and beats)
// The audio itself is rendered by the sound module (packages/sound) from the recipe and cached by the
// recipe's stamp (Decision 62: renders are caches, never history).
import { z } from 'zod';
import type { ToolDef, ToolCtx } from './tools.ts';
import { parseTrigger, type EffectTrigger } from './effects.ts';

export interface SoundDef {
  id: string; name: string;
  kind: 'event' | 'bed' | 'music';
  sfx?: { kind: string; seed: string | number; params?: Record<string, number> };
  bed?: { kind: string; seed: string | number; seconds: number };
  music?: { seed: string | number; mood?: 'warm' | 'night' | 'forge' | 'bright'; bpm?: number; bars?: number };
  on?: EffectTrigger;          // event: fires when that character's clip crosses the moment
  at?: number[];               // event: or at these scene seconds
  gain?: number;               // dB on the timeline mix (default 0)
}

export const BED_KINDS = ['forge-roar', 'crackle', 'room', 'city-hum', 'wind'];

export function describeSound(s: SoundDef): string {
  if (s.kind === 'event') return `${s.name}: ${s.sfx?.kind} (seed ${s.sfx?.seed})${s.on ? ` on ${s.on.on}` : s.at?.length ? ` at ${s.at.join(', ')} s` : ''}`;
  if (s.kind === 'bed') return `${s.name}: ${s.bed?.kind} bed, ${s.bed?.seconds} s loop`;
  return `${s.name}: music (${s.music?.mood ?? 'any mood'}${s.music?.bpm ? `, ${s.music.bpm} bpm` : ''}, ${s.music?.bars ?? 8} bars)`;
}

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const SoundArgs = {
  kind: z.enum(['event', 'bed', 'music']).optional(),
  sound: z.string().optional().describe('event: the sfx kind (clink, thud, hiss, puff, chime, whoosh, impact, pickup, hit…); bed: forge-roar | crackle | room | city-hum | wind'),
  seed: z.union([z.string(), z.number()]).optional(),
  params: z.record(z.string(), z.number()).optional().describe('kind options, e.g. {"pitch": 1050} for a clink'),
  seconds: z.number().min(1).max(30).optional().describe('bed loop length'),
  mood: z.enum(['warm', 'night', 'forge', 'bright']).optional(), bpm: z.number().min(50).max(200).optional(), bars: z.number().int().min(1).max(32).optional(),
  on: z.string().optional().describe('event: "Character:motion@moment" (impact, windup, peak, a key label, or a fraction 0..1)'),
  at: z.array(z.number().min(0)).optional().describe('event: scene seconds instead of a moment'),
  gain: z.number().min(-40).max(12).optional(),
};

const actionOf = (ctx: ToolCtx) => (character: string, clip: string): string | undefined => {
  const o = Object.values(ctx.doc.objects).find((x) => x.name.toLowerCase() === character.toLowerCase() || x.id === character);
  if (!o) throw new Error(`no character "${character}"`);
  const m: any = o.character?.motions?.[clip] ?? o.creature?.motions?.[clip];
  if (!m) throw new Error(`${o.name} has no motion "${clip}"`);
  return m.action && typeof m.action === 'string' ? m.action : clip;
};

function apply(ctx: ToolCtx, s: SoundDef, a: any): string[] {
  const changed: string[] = [];
  if (a.kind && a.kind !== s.kind) { s.kind = a.kind; changed.push(`kind ${a.kind}`); }
  if (s.kind === 'event') {
    const prev = s.sfx ?? { kind: 'clink', seed: 1 };
    s.sfx = { ...prev, ...(a.sound ? { kind: a.sound } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.params ? { params: { ...(prev.params ?? {}), ...a.params } } : {}) };
    if (a.sound) changed.push(`sound ${a.sound}`);
    if (a.seed !== undefined) changed.push(`seed ${a.seed}`);
    if (a.params) changed.push(Object.entries(a.params).map(([k, v]) => `${k} ${v}`).join(', '));
    if (a.on) { s.on = parseTrigger(a.on, 'sound', actionOf(ctx)); delete s.at; changed.push(`on ${a.on}`); }
    if (a.at) { s.at = a.at; delete s.on; changed.push(`at ${a.at.join(', ')} s`); }
  } else if (s.kind === 'bed') {
    const prev = s.bed ?? { kind: 'forge-roar', seed: 1, seconds: 8 };
    if (a.sound && !BED_KINDS.includes(a.sound)) throw new Error(`a bed is one of ${BED_KINDS.join(', ')}`);
    s.bed = { ...prev, ...(a.sound ? { kind: a.sound } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.seconds ? { seconds: a.seconds } : {}) };
    if (a.sound) changed.push(`bed ${a.sound}`);
    if (a.seed !== undefined) changed.push(`seed ${a.seed}`);
    if (a.seconds) changed.push(`${a.seconds} s loop`);
  } else {
    const prev = s.music ?? { seed: 1 };
    s.music = { ...prev, ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.mood ? { mood: a.mood } : {}), ...(a.bpm ? { bpm: a.bpm } : {}), ...(a.bars ? { bars: a.bars } : {}) };
    for (const k of ['seed', 'mood', 'bpm', 'bars']) if (a[k] !== undefined) changed.push(`${k} ${a[k]}`);
  }
  if (a.gain !== undefined) { s.gain = a.gain; changed.push(`gain ${a.gain} dB`); }
  return changed;
}

const getSound = (ctx: ToolCtx, id: string): SoundDef => {
  const s = (ctx.doc as any).sounds?.[id];
  if (!s) throw new Error(`no sound "${id}" (sounds: ${Object.keys((ctx.doc as any).sounds ?? {}).join(', ') || 'none'}; studio add-sound)`);
  return s;
};

export const SOUND_TOOLS: ToolDef[] = [
  {
    name: 'add-sound', mode: 'create', mutates: true,
    description: 'Add a sound to the scene (it shows as a waveform track on the live view\'s timeline): --kind event (--sound clink --seed strike-1 [--params {"pitch":1050}] --on "Blacksmith:strike@impact" or --at [0.5]), bed (--sound forge-roar --seconds 8: a seamless loop) or music (--mood forge --bpm 96 --bars 8: the beats clock shows bars and beats). The audio is rendered locally by the sound module from these settings and cached; the recipe is the step.',
    input: z.object({ id: Id, name: z.string().optional(), ...SoundArgs }),
    example: 'studio add-sound --id clink --kind event --sound clink --seed strike-1 --on "Blacksmith:strike@impact"',
    run(ctx, a) {
      if ((ctx.doc as any).sounds?.[a.id]) throw new Error(`sound "${a.id}" exists (studio set-sound changes it)`);
      const s: SoundDef = { id: a.id, name: a.name ?? a.id.replace(/-/g, ' ').replace(/^./, (c: string) => c.toUpperCase()), kind: a.kind ?? (a.mood || a.bpm ? 'music' : a.sound && BED_KINDS.includes(a.sound) ? 'bed' : 'event') };
      apply(ctx, s, { ...a, kind: undefined });
      ctx.set(['sounds'], { ...((ctx.doc as any).sounds ?? {}), [a.id]: s });
      ctx.summary(`New sound — ${describeSound(s)}`);
      return { id: s.id, sound: s };
    },
  },
  {
    name: 'set-sound', mode: 'modify', mutates: true,
    description: 'Change a scene sound: the same flags as add-sound (--seed, --sound, --params, --on, --at, --seconds, --mood, --bpm, --bars, --gain). One change = one step; pass --why with the word note ("brighter", "heavier"). For three distinct takes to listen to and pick from, use show-three with set-sound calls (or `studio sound-three --id clink`).',
    input: z.object({ id: z.string(), name: z.string().optional(), ...SoundArgs }),
    example: 'studio set-sound --id clink --params \'{"pitch":1400}\' --why "brighter"',
    run(ctx, a) {
      const s: SoundDef = structuredClone(getSound(ctx, a.id));
      const changed = apply(ctx, s, a);
      if (a.name) { s.name = a.name; changed.push(`name ${a.name}`); }
      ctx.set(['sounds', s.id], s);
      ctx.summary(`${s.name}: ${changed.join('; ') || 'no change'}`);
      return { id: s.id, sound: s };
    },
  },
  {
    name: 'remove-sound', mode: 'modify', mutates: true,
    description: 'Remove a scene sound.',
    input: z.object({ id: z.string() }),
    run(ctx, a) {
      const s = getSound(ctx, a.id);
      const rest = { ...((ctx.doc as any).sounds ?? {}) }; delete rest[a.id];
      ctx.set(['sounds'], rest);
      ctx.summary(`Removed sound ${s.name}`);
      return { removed: a.id };
    },
  },
];
