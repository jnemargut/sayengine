// The Blender creature builder (organic creatures with real topology and a real rig).
// Node side: find Blender, turn studio options into a build spec, run Blender headless on the
// scripts in ./py, then validate what comes back (Khronos validator, clip motion checks).
//
// Why Blender: building a fat cat from metaballs in game code hit a ceiling (lumpy bodies, a head
// that read as a separate ball, stump legs, skinning that crumpled in sit and loaf, felted shell fur,
// hand-built poses). Blender gives clean all-quad topology, Rigify and automatic weights, locally and
// for free. The builder is optional: without Blender the studio says how to install it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { KitFaceOptions } from './kitface.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PY_DIR = path.join(HERE, 'py');

export const BLENDER_HINT = 'Blender was not found. It is free and local: install it from https://www.blender.org/download/ '
  + '(macOS: `brew install --cask blender`; Linux: `sudo snap install blender --classic`; Windows: `winget install BlenderFoundation.Blender`), '
  + 'or point STUDIO_BLENDER at the blender executable. Blender 4.2 or newer; Rigify ships with it.';

/** The blender executable: STUDIO_BLENDER, then PATH, then the usual install places. Null when absent. */
export function findBlender(env = process.env): string | null {
  const cands = [env.STUDIO_BLENDER, env.BLENDER].filter(Boolean) as string[];
  const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
  for (const d of (env.PATH ?? '').split(path.delimiter)) if (d) cands.push(path.join(d, exe));
  cands.push('/opt/homebrew/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender',
    path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'), '/usr/bin/blender', '/snap/bin/blender',
    'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe');
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

/** "5.2.2" from `blender --version`, or null. */
export function blenderVersion(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
  const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout ?? '');
  return m ? m[1] : null;
}

// ── plans, presets and options ────────────────────────────────────────────────
export const CREATURE_PLANS = {
  cat: {
    presets: ['british-shorthair', 'domestic-shorthair'],
    builds: { lean: 0.15, normal: 0.45, chubby: 0.7, fat: 0.92 } as Record<string, number>,
    patterns: ['solid', 'tabby', 'tuxedo', 'calico'],
    clips: ['idle', 'walk', 'trot', 'sit', 'loaf', 'jump', 'jump_takeoff', 'jump_wiggle', 'jump_air', 'jump_land', 'land', 'swat',
      'carried', 'carried_dangle', 'carried_cradle', 'squash',
      'bat_test_tap', 'bat_tap_loop', 'bat_push_final', 'bat_backhand_swipe', 'bat_double_smack', 'bat_hook', 'bat_flick', 'bat_flurry',
      'bat_belly_push', 'bat_nose_push', 'bat_test_tap_windup', 'bat_push_final_windup', 'bat_backhand_swipe_windup', 'bat_double_smack_windup',
      'bat_hook_windup', 'bat_flick_windup', 'bat_belly_push_windup', 'bat_nose_push_windup', 'react_innocent_sit', 'react_paw_lick', 'react_stare_down',
      'scratch_vertical', 'scratch_horizontal', 'scratch_bed', 'scratch_on_scratcher', 'butt_wiggle', 'tail_flick',
      'idle_breathe', 'idle_weight_shift', 'idle_tail_sway', 'ear_swivel_L', 'ear_swivel_R', 'blink_quick', 'blink_half', 'slow_blink', 'sleepy_eyes',
      'squint_content', 'nictitate_flick', 'head_tilt', 'sniff', 'groom_paw_face', 'lick_chest', 'yawn', 'stretch_front', 'stretch_back', 'lie_to_loaf',
      'flop_side', 'ear_scratch', 'knead', 'chatter', 'startle_hop', 'crouch_alert', 'zoomies', 'pounce', 'caught_freeze'],
  },
  person: {
    presets: ['dad'],
    builds: { lean: 0.0, normal: 0.7, round: 1.0 } as Record<string, number>,
    patterns: [],
    clips: ['idle', 'walk', 'pick_up', 'look_around', 'carry_cat', 'reading', 'phone_call', 'sit_desk', 'idle_breathe', 'idle_weight_shift', 'glance_around',
      'adjust_glasses', 'rub_neck', 'read_page_turn', 'read_chuckle', 'sip_tea', 'sit', 'cross_legs', 'eat_fork', 'chew', 'type_burst', 'think_pause', 'rub_eyes',
      'stretch_arms_up', 'phone_pace_gesture', 'phone_laugh', 'hands_on_hips_sigh', 'head_shake', 'pet_cat_down', 'knee_groan'],
  },
} as const;
export type CreaturePlan = keyof typeof CREATURE_PLANS;

/** A person's face: the studio's kit face (kitface.ts), built with these options and joined to the
 *  Blender body. Dad: about 40, receding greying hair, warm brown eyes, a few laugh lines. */
export const PERSON_FACES: Record<string, KitFaceOptions> = {
  dad: { height: 1.78, hair: 'receding', mood: 'warm', skin: '#e2b394', hairColor: '#6b5a4c', browColor: '#5a4a3e', iris: '#5b3a22', lips: '#b5705f',
    paint: { lashes: '#2a1d16', smile: 0.45, blush: '#d98a7a', blushAmt: 0.22, wrinkles: 0.15 } },
};

export const COAT_COLORS: Record<string, string> = {
  blue: '#787d86', grey: '#7e7f82', gray: '#7e7f82', black: '#2a2a2e', white: '#e9e6df', cream: '#d9c4a3', red: '#c9792f', ginger: '#c9792f',
  brown: '#7a5a3e', lilac: '#a49aa0', silver: '#b8bcc2',
};
export const EYE_COLORS: Record<string, string> = { copper: '#c9771f', amber: '#d18a22', gold: '#d6a62a', green: '#7e9e3a', blue: '#5d8fc9', hazel: '#9a7b32' };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const CreatureOptions = z.object({
  plan: z.enum(Object.keys(CREATURE_PLANS) as [CreaturePlan]).default('cat'),
  preset: z.string().optional(),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/).default('creature'),
  style: z.enum(['real', 'toy']).default('real').describe('real: believable proportions; toy: a chunky cartoon (a big head, huge eyes, bold simple features that act, clips that overshoot and settle)'),
  build: z.union([z.number().min(0).max(1), z.string()]).default('normal').describe('0 lean .. 1 very fat, or lean|normal|chubby|fat'),
  legLength: z.number().min(0.7).max(1.4).default(1),
  bodyLength: z.number().min(0.75).max(1.3).default(1),
  headSize: z.number().min(0.8).max(1.25).default(1),
  coat: z.string().optional().describe('colour name or #rrggbb'),
  pattern: z.string().optional().describe('solid | tabby | tuxedo | calico'),
  eyeColor: z.string().optional().describe('copper | amber | gold | green | blue | hazel | #rrggbb'),
  furLength: z.number().min(0.002).max(0.03).default(0.006).describe('metres; deepens the pile in the normal map'),
  faces: z.number().int().min(2000).max(30000).default(9000).describe('body quads (the triangle budget is about twice this plus ~2.5k for the parts)'),
  texture: z.number().int().min(256).max(4096).default(1024),
  rigify: z.boolean().default(true),
  renders: z.union([z.boolean(), z.array(z.string())]).default(false),
  clips: z.array(z.string()).optional(),
  tempo: z.number().min(0.5).max(2).default(1).describe('speeds every clip up (> 1) or down; contact times and speeds follow'),
  clipTempo: z.record(z.string(), z.number().min(0.25).max(4)).optional().describe('per-clip tempo on top of --tempo, e.g. {"walk": 1.2}'),
  out: z.string(),
});
export type CreatureOptionsIn = z.input<typeof CreatureOptions>;

/** The JSON spec the Blender script reads, from validated options. Throws with the allowed values. */
export function creatureSpec(input: CreatureOptionsIn): Record<string, unknown> {
  const o = CreatureOptions.parse(input) as z.output<typeof CreatureOptions> & { preset: string };
  const plan = CREATURE_PLANS[o.plan];
  o.preset ??= plan.presets[0];
  if (!(plan.presets as readonly string[]).includes(o.preset)) throw new Error(`unknown ${o.plan} preset "${o.preset}"; presets: ${plan.presets.join(', ')}`);
  let build: number;
  if (typeof o.build === 'number') build = o.build;
  else if (o.build in plan.builds) build = plan.builds[o.build];
  else if (/^\d*\.?\d+$/.test(o.build)) build = Math.min(1, Math.max(0, Number(o.build)));
  else throw new Error(`--build must be 0..1 or ${Object.keys(plan.builds).join('|')}`);
  const colour = (v: string | undefined, table: Record<string, string>, what: string) => {
    if (v === undefined) return undefined;
    if (hex.safeParse(v).success) return v;
    const c = table[v.toLowerCase()];
    if (!c) throw new Error(`unknown ${what} "${v}"; use #rrggbb or ${Object.keys(table).join(', ')}`);
    return c;
  };
  if (o.pattern && !(plan.patterns as readonly string[]).includes(o.pattern)) throw new Error(`--pattern must be ${plan.patterns.join('|')}`);
  if (o.clips) for (const c of o.clips) if (!(plan.clips as readonly string[]).includes(c)) throw new Error(`unknown clip "${c}"; clips: ${plan.clips.join(', ')}`);
  if (o.clipTempo) for (const c of Object.keys(o.clipTempo)) if (!(plan.clips as readonly string[]).includes(c)) throw new Error(`--clipTempo: unknown clip "${c}"`);
  const coat: Record<string, string> = {};
  const cc = colour(o.coat, COAT_COLORS, 'coat colour');
  if (cc) coat.color = cc;
  if (o.pattern) coat.pattern = o.pattern;
  const toy = o.style === 'toy' ? { toy: 1 } : {};
  if (o.plan === 'person') {
    const out = path.resolve(o.out);
    // a toy person has its own cartoon head (py/toyhead.py): no kit face is cut for it
    if (o.style === 'toy') return { plan: 'person', preset: o.preset, name: o.name.replace(/\s+/g, '-').toLowerCase(), belly: build, texture: o.texture, renders: o.renders, ...(o.clips ? { clips: o.clips } : {}), out, ...toy, height: 1.6 };
    return { plan: 'person', preset: o.preset, name: o.name.replace(/\s+/g, '-').toLowerCase(), belly: build, texture: o.texture, renders: o.renders, ...(o.clips ? { clips: o.clips } : {}), out,
      kitFace: path.join(out, 'kitface.json'), kitFacePng: path.join(out, 'kitface.png') };
  }
  return {
    plan: o.plan, preset: o.preset, name: o.name.replace(/\s+/g, '-').toLowerCase(), build, legLength: o.legLength, bodyLength: o.bodyLength,
    headSize: o.headSize, coat, ...(o.eyeColor ? { eyeColor: colour(o.eyeColor, EYE_COLORS, 'eye colour') } : {}), furLength: o.furLength,
    faces: o.faces, texture: o.texture, rigify: o.rigify, renders: o.renders, ...(o.clips ? { clips: o.clips } : {}), out: path.resolve(o.out),
    ...(o.tempo !== 1 ? { tempo: o.tempo } : {}), ...(o.clipTempo ? { clipTempo: o.clipTempo } : {}), ...toy,
  };
}

export interface CreatureBuild {
  ok: boolean; glb: string; blend: string; name: string; triangles: number; bones: string[]; deformBones: string[];
  clips: Record<string, Record<string, unknown>>; rigify: boolean; quadriflow: boolean; blender: string; renders?: string[]; log: string[];
  validation?: { ok: boolean; errors: number; warnings: number; messages: unknown[] };
  motion?: Record<string, Array<{ name: string; pass: boolean; detail: string; frames: Array<[number, number]> }>>;
  /** shape keys (pupils, blinks, squints, the third eyelid; a toy cat's mouthOpen; a toy person's 35 face shapes) */
  shapes?: string[];
  /** the eyelid shape keys never cut the eyeball, and a blink shuts */
  eyeChecks?: Array<{ name: string; pass: boolean; detail: string }>;
  /** per clip: lower legs, paws and tail kept out of the barrel and the head (measured on the skinned mesh in Blender) */
  selfIntersection?: Record<string, { pass: boolean; worst: number; limit: number; detail: string; frames: Array<[number, number]> }>;
  seconds: number;
}

export class BlenderMissing extends Error {
  hint = BLENDER_HINT;
  constructor() { super('Blender is not installed (the creature builder drives it headless)'); }
}

/** Build a creature in Blender. Resolves with the build report (GLB validated, clips checked). */
export async function buildCreature(input: CreatureOptionsIn, opts: { blender?: string | null; timeoutMs?: number; onLog?: (line: string) => void } = {}): Promise<CreatureBuild> {
  const spec = creatureSpec(input);
  const bin = opts.blender === undefined ? findBlender() : opts.blender;
  if (!bin) throw new BlenderMissing();
  const out = String(spec.out);
  fs.mkdirSync(out, { recursive: true });
  if (spec.plan === 'person' && !spec.toy) {
    const { kitFace } = await import('./kitface.ts');
    const { face, png } = await kitFace(PERSON_FACES[String(spec.preset)] ?? {});
    fs.writeFileSync(String(spec.kitFace), JSON.stringify(face));
    fs.writeFileSync(String(spec.kitFacePng), png);
  }
  const specFile = path.join(out, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const t0 = Date.now();
  const lines: string[] = [];
  let error: string | null = null;
  const code: number = await new Promise((resolve, reject) => {
    const script = spec.plan === 'person' ? 'build_person.py' : 'build_creature.py';
    const p = spawn(bin, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(PY_DIR, script), '--', specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`Blender build timed out after ${Math.round((opts.timeoutMs ?? 900000) / 1000)} s`)); }, opts.timeoutMs ?? 900000);
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith('[creature]')) {
          const msg = line.slice(11).trim();
          if (msg.startsWith('ERROR')) error = msg.slice(6);
          else if (!msg.startsWith('REPORT')) { lines.push(msg); opts.onLog?.(msg); }
        } else if (/Traceback|Error:/.test(line)) lines.push(line.trim());
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); });
  });
  const reportFile = path.join(out, 'report.json');
  if (code !== 0 || error || !fs.existsSync(reportFile)) {
    throw new Error(`Blender build failed${error ? `: ${error}` : ` (exit ${code})`}${lines.length ? `\n${lines.slice(-8).join('\n')}` : ''}`);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as CreatureBuild;
  const bytes = new Uint8Array(fs.readFileSync(report.glb));
  const { validateGlb } = await import('../gameexport.ts');
  const v = await validateGlb(bytes);
  report.validation = { ok: v.ok, errors: v.errors, warnings: v.warnings, messages: v.messages };
  const { readGlb } = await import('../importchar.ts');
  const { glbMotionChecks } = await import('./glbmotion.ts');
  const mc = glbMotionChecks(readGlb(bytes));
  report.motion = Object.fromEntries(Object.entries(mc).map(([k, ks]) => [k, ks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail, frames: c.frames }))]));
  // the Blender-side self-intersection check joins each clip's checks
  for (const [k, si] of Object.entries(report.selfIntersection ?? {})) {
    (report.motion[k] ??= []).push({ name: 'no self-intersection', pass: si.pass, detail: si.detail, frames: si.frames });
  }
  report.seconds = Math.round((Date.now() - t0) / 100) / 10;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return report;
}
