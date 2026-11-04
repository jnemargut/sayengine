// Bambu Studio on this Mac (Decision 43): resolve presets, slice/arrange with its command line,
// open the result in the app. The studio never talks to the printer: you press Print in Bambu
// Studio, which uses your own login (cloud or LAN).
//
// The command line crashes on Apple Silicon when presets "inherit" from others (bambulab/
// BambuStudio#9636), so every preset is flattened here into one complete JSON before the call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Where Bambu Studio is (BAMBU_STUDIO_APP overrides, read on every call). */
export const bambuApp = () => process.env.BAMBU_STUDIO_APP ?? '/Applications/BambuStudio.app';
export const bambuBinary = () => path.join(bambuApp(), 'Contents/MacOS/BambuStudio');
const SYSTEM_DIR = () => path.join(bambuApp(), 'Contents/Resources/profiles/BBL');
const USER_ROOT = () => process.env.BAMBU_STUDIO_DATA ?? path.join(os.homedir(), 'Library/Application Support/BambuStudio');

export type PresetKind = 'machine' | 'process' | 'filament';

export function findBambu(): { app: string; version: string | null } | null {
  if (!fs.existsSync(bambuBinary())) return null;
  let version: string | null = null;
  try {
    const plist = fs.readFileSync(path.join(bambuApp(), 'Contents/Info.plist'), 'utf8');
    version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch { /* ignore */ }
  return { app: bambuApp(), version };
}

/** Folders a preset of this kind may live in: the app's system presets, then your own (user/<id>/kind). */
function presetDirs(kind: PresetKind): string[] {
  const dirs = [path.join(SYSTEM_DIR(), kind), path.join(USER_ROOT(), 'system', 'BBL', kind)];
  const user = path.join(USER_ROOT(), 'user');
  if (fs.existsSync(user)) for (const id of fs.readdirSync(user)) dirs.push(path.join(user, id, kind));
  return dirs.filter((d) => fs.existsSync(d));
}

/** Every preset name of a kind (for "did you mean"). */
export function presetNames(kind: PresetKind): string[] {
  const names = new Set<string>();
  for (const d of presetDirs(kind)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) names.add(f.slice(0, -5));
  return [...names].sort();
}

function readPreset(kind: PresetKind, name: string): Record<string, any> {
  // user presets win over system ones of the same name (later dirs first)
  for (const d of [...presetDirs(kind)].reverse()) {
    const f = path.join(d, `${name}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const near = presetNames(kind).filter((n) => n.toLowerCase().includes(name.toLowerCase().split(' @')[0].slice(0, 10))).slice(0, 6);
  throw new Error(`no ${kind} preset "${name}" in Bambu Studio${near.length ? ` — similar: ${near.join('; ')}` : ''}`);
}

/** A preset with its whole "inherits" chain folded in: one complete settings object. */
export function flattenPreset(kind: PresetKind, name: string, seen = new Set<string>()): Record<string, any> {
  if (seen.has(name)) throw new Error(`preset "${name}" inherits from itself`);
  seen.add(name);
  const own = readPreset(kind, name);
  const parent = own.inherits ? flattenPreset(kind, own.inherits, seen) : {};
  const merged: Record<string, any> = { ...parent, ...own };
  delete merged.inherits;
  merged.name = own.name ?? name;
  return merged;
}

export interface PresetChoice { machine: string; process: string; filament: string }

/** Write the three flattened presets as complete JSON files the command line accepts. */
export function writeFlatPresets(dir: string, p: PresetChoice): { machine: string; process: string; filament: string; filamentName: string } {
  fs.mkdirSync(dir, { recursive: true });
  const out = (kind: PresetKind, name: string) => {
    const flat = flattenPreset(kind, name);
    // the command line wants these markers on full configs
    if (kind === 'machine') flat.type = 'machine';
    if (kind === 'process') flat.type = 'process';
    if (kind === 'filament') flat.type = 'filament';
    flat.from = 'system';
    const f = path.join(dir, `${kind}.json`);
    fs.writeFileSync(f, JSON.stringify(flat, null, 1));
    return { file: f, flat };
  };
  const m = out('machine', p.machine), pr = out('process', p.process), fi = out('filament', p.filament);
  return { machine: m.file, process: pr.file, filament: fi.file, filamentName: String(fi.flat.name) };
}

export interface CliResult { ok: boolean; code: number | null; out: string; log: string; file?: string }

/** Run Bambu Studio's command line (headless). Returns its exit code and the tail of its output. */
export function runBambuCli(args: string[], timeoutMs = 180000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(bambuBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (b: Buffer) => { out += b.toString(); if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const t = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code, out: out.slice(-4000), log: out }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, code: null, out: String(e.message), log: String(e.message) }); });
  });
}

/**
 * Build a Bambu Studio project (.3mf) for these STL files: printer, process and filament presets,
 * models laid on the bed and arranged. No slicing (that happens in the app, where you see it).
 */
export async function buildProject(stls: string[], out: string, presets: PresetChoice, work: string, opts: { orient?: boolean } = {}): Promise<CliResult> {
  const flat = writeFlatPresets(work, presets);
  const args = [
    '--load-settings', `${flat.machine};${flat.process}`,
    '--load-filaments', flat.filament,
    '--arrange', '1', '--ensure-on-bed',
    ...(opts.orient ? ['--orient', '1'] : []),
    '--export-3mf', path.basename(out), '--outputdir', path.dirname(out),
    ...stls,
  ];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) fs.rmSync(out);
  const r = await runBambuCli(args);
  r.file = out;
  if (!fs.existsSync(out)) r.ok = false;
  return r;
}

/** Open a file in the Bambu Studio app. STUDIO_NO_OPEN=1 (tests) skips it. */
export function openInBambu(file: string): { opened: boolean; note?: string } {
  if (process.env.STUDIO_NO_OPEN === '1') return { opened: false, note: 'STUDIO_NO_OPEN=1: not opening the app' };
  const r = spawnSync('open', ['-a', bambuApp(), file]);
  return r.status === 0 ? { opened: true } : { opened: false, note: String(r.stderr ?? '').trim() || `open exited ${r.status}` };
}

/** Read one file out of a .3mf (zip) — for checking what the project says. */
export function read3mfEntry(file: string, entry: string): string | null {
  const r = spawnSync('unzip', ['-p', file, entry], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.toString('utf8') : null;
}
