// `studio install-skills` — link the game planning skills (decision 36) into the user's skills
// folder so /x-decide-gaming works in any game folder. Links by default (skills follow the repo's
// version); --copy copies instead. Never overwrites something that isn't ours unless --force.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SKILLS_SRC = path.join(REPO, '.claude', 'skills');
export const GAME_SKILLS = ['x-decide-gaming', 'x-game-concept', 'x-game-design', 'x-game-build', 'x-playtest'];
/** Project skills that assume `./studio` in the current folder; only installed with --all. */
export const STUDIO_SKILLS = ['studio', 'game'];

export interface InstallOpts { dest?: string; copy?: boolean; all?: boolean; force?: boolean; bin?: string; home?: string }
export interface InstallResult {
  ok: boolean; dest: string;
  linked: string[]; copied: string[]; unchanged: string[]; replaced: string[]; skipped: { name: string; reason: string }[];
  bin?: string; notes: string[];
}

export function installSkills(opts: InstallOpts = {}): InstallResult {
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const dest = path.resolve(opts.dest ?? path.join(home, '.claude', 'skills'));
  fs.mkdirSync(dest, { recursive: true });
  const names = [...GAME_SKILLS, ...(opts.all ? STUDIO_SKILLS : [])];
  const r: InstallResult = { ok: true, dest, linked: [], copied: [], unchanged: [], replaced: [], skipped: [], notes: [] };
  for (const name of names) {
    const src = path.join(SKILLS_SRC, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) { r.skipped.push({ name, reason: 'not found in this repo' }); continue; }
    const target = path.join(dest, name);
    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(target); } catch { existing = null; }
    if (existing) {
      const ours = existing.isSymbolicLink() && path.resolve(dest, fs.readlinkSync(target)) === src;
      if (ours && !opts.copy) { r.unchanged.push(name); continue; }
      if (!ours && !opts.force) { r.skipped.push({ name, reason: `${target} already exists and isn't linked to this repo (use --force to replace it)` }); continue; }
      fs.rmSync(target, { recursive: true, force: true });
      r.replaced.push(name);
    }
    if (opts.copy) { fs.cpSync(src, target, { recursive: true }); r.copied.push(name); }
    else { fs.symlinkSync(src, target, 'dir'); r.linked.push(name); }
  }
  if (opts.copy) r.notes.push('Copied skills find the studio through $STUDIO_HOME or `studio` on PATH; set STUDIO_HOME to this repo.');
  if (opts.all) r.notes.push('/studio and /game run `./studio` from the current folder; outside this repo, use the launcher from --bin or STUDIO_HOME.');
  if (opts.bin) {
    const binDir = path.resolve(opts.bin);
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'studio');
    const launcher = path.join(REPO, 'studio');
    let cur: string | null = null;
    try { cur = fs.readlinkSync(link); } catch { cur = null; }
    if (cur && path.resolve(binDir, cur) === launcher) r.bin = link;
    else if (fs.existsSync(link) && !opts.force) r.skipped.push({ name: 'studio (bin)', reason: `${link} already exists (use --force)` });
    else { fs.rmSync(link, { force: true }); fs.symlinkSync(launcher, link); r.bin = link; }
  }
  r.ok = r.skipped.filter((s) => s.reason !== 'not found in this repo').length === 0;
  return r;
}
