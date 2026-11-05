// Godot back end: drive the engine from the command line.
//   import:   godot --headless --import            (post-import script prints STUDIO_IMPORT {json})
//   commands: godot [--headless] --fixed-fps 60 --path P res://studio/runner.tscn -- --studio-cmd=<json>
// Headless runs use a dummy renderer, so screenshots run windowed, placed off-screen.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTemplate, workDir } from './project.ts';
import { parseGodotOutput } from './util.ts';

const CANDIDATES = [
  process.env.GODOT_BIN,
  '/Applications/Godot.app/Contents/MacOS/Godot',
  '/Applications/Godot_mono.app/Contents/MacOS/Godot',
  'godot', 'godot4',
].filter(Boolean) as string[];

let cached: { bin: string; version: string } | null | undefined;
/** Find a Godot 4 binary (GODOT_BIN wins). null when none is installed. */
export function findGodot(): { bin: string; version: string } | null {
  if (cached !== undefined) return cached;
  for (const bin of CANDIDATES) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
      const v = (r.stdout || '').trim().split('\n').pop() ?? '';
      if (r.status === 0 && /^4\./.test(v)) return (cached = { bin, version: v });
    } catch { /* try next */ }
  }
  return (cached = null);
}

function requireGodot() {
  const g = findGodot();
  if (!g) throw Object.assign(new Error('Godot 4 not found'), { hint: 'install it (brew install --cask godot) or set GODOT_BIN to the Godot binary' });
  return g;
}

function exec(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; text: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: process.env });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, text, timedOut }); });
  });
}

const IMPORT_FILE = `[remap]

importer="scene"
importer_version=1
type="PackedScene"

[params]

import_script/path="res://studio/import_studio.gd"
meshes/ensure_tangents=false
`;

/** Make sure a GLB in the project imports through the studio post-import script. */
function ensureImportSettings(glb: string) {
  const imp = glb + '.import';
  if (!fs.existsSync(imp)) { fs.writeFileSync(imp, IMPORT_FILE); return; }
  let s = fs.readFileSync(imp, 'utf8');
  if (!/import_script\/path="res:\/\/studio\/import_studio\.gd"/.test(s)) {
    s = /import_script\/path=/.test(s)
      ? s.replace(/import_script\/path=.*$/m, 'import_script/path="res://studio/import_studio.gd"')
      : s.replace(/\[params\]\n/, '[params]\n\nimport_script/path="res://studio/import_studio.gd"\n');
  }
  // studio materials never use normal maps: no tangents (an unbaked export has no UVs to make them from)
  s = /meshes\/ensure_tangents=/.test(s) ? s.replace(/meshes\/ensure_tangents=.*$/m, 'meshes/ensure_tangents=false') : s.replace(/\[params\]\n/, '[params]\n\nmeshes/ensure_tangents=false\n');
  fs.writeFileSync(imp, s);
}

export interface ImportReport { ok: boolean; engine: 'godot'; version: string; meshes: number; triangles: number; materials: any[]; objects: any[]; collision: number; warnings: string[]; errors: string[]; seconds: number }

/** Re-import the project's assets headlessly and report what Godot made of the studio GLB. */
export async function importProject(dir: string): Promise<ImportReport> {
  const g = requireGodot();
  const glb = path.join(dir, 'assets', 'studio', 'scene.glb');
  const playerGlb = path.join(dir, 'assets', 'studio', 'player.glb');
  const creaturesDir = path.join(dir, 'assets', 'studio', 'creatures');
  const creatureFiles = fs.existsSync(creaturesDir) ? fs.readdirSync(creaturesDir).filter((f) => f.endsWith('.glb')) : [];
  for (const f of [glb, playerGlb, ...creatureFiles.map((c) => path.join(creaturesDir, c))]) if (fs.existsSync(f)) ensureImportSettings(f);
  // Godot skips unchanged sources; the report comes from the post-import script, so always re-run it
  const cache = path.join(dir, '.godot', 'imported');
  if (fs.existsSync(cache)) for (const f of fs.readdirSync(cache)) if (f.startsWith('scene.glb-') || f.startsWith('player.glb-') || creatureFiles.some((c) => f.startsWith(`${c}-`))) fs.rmSync(path.join(cache, f), { force: true });
  const t0 = Date.now();
  const r = await exec(g.bin, ['--headless', '--path', dir, '--import'], dir, 180000);
  const p = parseGodotOutput(r.text);
  const rep = p.imports.filter((x: any) => (x.file ?? 'scene.glb') === 'scene.glb').at(-1) ?? { meshes: 0, triangles: 0, materials: [], objects: [], collision: 0 };
  const playerRep = p.imports.find((x: any) => x.file === 'player.glb');
  if (fs.existsSync(playerGlb)) { if (!playerRep) p.errors.push('the player model (assets/studio/player.glb) did not import'); else (rep as any).player = { meshes: playerRep.meshes, triangles: playerRep.triangles, animations: playerRep.animations }; }
  // creatures: each imported on its own; a skinned one must come out with a Skeleton3D for the live IK
  if (creatureFiles.length) {
    (rep as any).creatures = {};
    for (const f of creatureFiles) {
      const cr = p.imports.find((x: any) => x.file === f);
      if (!cr) { p.errors.push(`the creature ${f} did not import`); continue; }
      (rep as any).creatures[f] = { meshes: cr.meshes, triangles: cr.triangles, animations: cr.animations, skeleton: (cr.skeletons ?? 0) > 0, ik: !!cr.ik };
    }
  }
  if (r.timedOut) p.errors.push('Godot import timed out after 180 s');
  if (fs.existsSync(glb) && !p.imports.length) p.errors.push('the studio post-import script did not run (check assets/studio/scene.glb.import)');
  return { ok: !p.errors.length, engine: 'godot', version: g.version, ...rep, warnings: p.warnings, errors: p.errors, seconds: (Date.now() - t0) / 1000 };
}

/** Round-trip a GLB through Godot in a throwaway project — for the studio's export checks. */
export async function roundTrip(glbPath: string): Promise<ImportReport> {
  // a fresh folder per call: two round trips at once (an export in the daemon, a test) must not delete
  // each other's project mid-import (Godot then fails with "getcwd … is null")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-godot-roundtrip-'));
  fs.mkdirSync(path.join(dir, 'assets', 'studio'), { recursive: true });
  copyTemplate('godot', dir, { NAME: 'roundtrip' });
  fs.copyFileSync(glbPath, path.join(dir, 'assets', 'studio', 'scene.glb'));
  try { return await importProject(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Run one runner command. `windowed` is needed for anything that renders. */
export async function runnerCommand(dir: string, cmd: Record<string, unknown>, opts: { windowed?: boolean; size?: number; timeoutMs?: number } = {}) {
  const g = requireGodot();
  if (!fs.existsSync(path.join(dir, '.godot'))) {
    const imp = await importProject(dir);
    if (!imp.ok) return { ok: false, error: 'import failed before running', errors: imp.errors, warnings: imp.warnings };
  }
  const cmdFile = path.join(workDir(dir, 'cmd'), `${cmd.cmd}-${Date.now()}.json`);
  fs.writeFileSync(cmdFile, JSON.stringify(cmd));
  const w = Math.round(opts.size ?? 960), h = Math.round(w * 0.625);
  const args = [
    ...(opts.windowed ? ['--resolution', `${w}x${h}`, '--position', '30000,30000'] : ['--headless']),
    '--fixed-fps', '60', '--path', dir, 'res://studio/runner.tscn', '--', `--studio-cmd=${cmdFile}`,
  ];
  const r = await exec(g.bin, args, dir, opts.timeoutMs ?? 120000);
  fs.rmSync(cmdFile, { force: true });
  const p = parseGodotOutput(r.text);
  if (r.timedOut) p.errors.push(`Godot did not finish within ${(opts.timeoutMs ?? 120000) / 1000} s`);
  if (!p.result) return { ok: false, error: 'the runner printed no result', errors: p.errors, warnings: p.warnings, log: p.prints.slice(-20) };
  const { ok, error, ...result } = p.result;
  return { ok: ok !== false && !error, error, result, warnings: p.warnings, errors: p.errors, log: p.prints.slice(-20) };
}
