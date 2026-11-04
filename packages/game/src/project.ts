// Game projects: where they live, their config, and copying the engine templates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './util.ts';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STUDIO_ROOT = path.resolve(PKG, '../..');
export type Engine = 'godot' | 'web';

export interface GameConfig {
  name: string;
  engine: Engine;
  created: string;
  studio: { configVersion: 1 };
  lastImport?: { at: string; file: string; source: string; ok: boolean; triangles?: number; meshes?: number; warnings: number };
  /** the studio character the game's player is (exported on its own as assets/studio/player.glb) */
  player?: string;
}

export const CONFIG = 'studio-game.json';
export const configPath = (dir: string) => path.join(dir, CONFIG);
export const readConfig = (dir: string): GameConfig => JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
export const writeConfig = (dir: string, c: GameConfig) => fs.writeFileSync(configPath(dir), JSON.stringify(c, null, 2) + '\n');
/** Scratch output (screenshots, command files) — gitignored inside each game. */
export const workDir = (dir: string, ...sub: string[]) => { const d = path.join(dir, '.studio-game', ...sub); fs.mkdirSync(d, { recursive: true }); return d; };

/** All game projects under <studioDir>/games. */
export function listGames(studioDir: string): Array<{ dir: string; config: GameConfig }> {
  const root = path.join(studioDir, 'games');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((n) => path.join(root, n)).filter((d) => fs.existsSync(configPath(d))).map((dir) => ({ dir, config: readConfig(dir) }));
}

/** Resolve --project (a path or a name under games/); with none given, the only game there is. */
export function resolveProject(studioDir: string, project?: unknown): { dir: string; config: GameConfig } {
  if (project !== undefined && project !== null && project !== '') {
    const p = String(project);
    for (const dir of [path.resolve(studioDir, p), path.join(studioDir, 'games', p), path.join(studioDir, 'games', slug(p))]) {
      if (fs.existsSync(configPath(dir))) return { dir, config: readConfig(dir) };
    }
    const names = listGames(studioDir).map((g) => path.basename(g.dir));
    throw Object.assign(new Error(`no game project "${p}"`), { hint: names.length ? `games here: ${names.join(', ')}` : 'create one with `studio game init --name <name> --engine godot|web`' });
  }
  const all = listGames(studioDir);
  if (all.length === 1) return all[0];
  if (!all.length) throw Object.assign(new Error('no game project yet'), { hint: 'studio game init --name <name> --engine godot|web' });
  throw Object.assign(new Error(`${all.length} game projects — pass --project`), { hint: `games: ${all.map((g) => path.basename(g.dir)).join(', ')}` });
}

/** Copy a template folder. `managedOnly` refreshes only studio/ files (safe on every import). */
export function copyTemplate(engine: Engine, dest: string, vars: Record<string, string>, managedOnly = false): string[] {
  const src = path.join(PKG, 'templates', engine);
  const written: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      const managed = r.split(path.sep)[0] === 'studio';
      if (managedOnly && !managed) continue;
      const to = path.join(dest, r.replace(/\.tmpl$/, ''));
      if (!managed && fs.existsSync(to)) continue; // never clobber the user's game files
      fs.mkdirSync(path.dirname(to), { recursive: true });
      let text = fs.readFileSync(path.join(src, r), 'utf8');
      for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
      fs.writeFileSync(to, text);
      written.push(path.relative(dest, to));
    }
  };
  walk('');
  return written;
}

export function initProject(studioDir: string, args: { name: string; engine?: string; dir?: string; force?: boolean }): { dir: string; config: GameConfig; files: string[] } {
  const engine = (args.engine ?? 'godot') as Engine;
  if (engine !== 'godot' && engine !== 'web') throw new Error('--engine must be godot or web');
  if (!args.name) throw new Error('--name is required');
  const dir = path.resolve(studioDir, args.dir ?? path.join('games', slug(args.name)));
  if (fs.existsSync(configPath(dir)) && !args.force) throw Object.assign(new Error(`a game already exists at ${path.relative(studioDir, dir) || dir}`), { hint: 'use it with --project, or pass --force true to refresh its studio/ files' });
  fs.mkdirSync(dir, { recursive: true });
  const files = copyTemplate(engine, dir, { NAME: args.name.replace(/"/g, '') });
  fs.mkdirSync(path.join(dir, 'assets', 'studio'), { recursive: true });
  const config: GameConfig = fs.existsSync(configPath(dir)) ? { ...readConfig(dir), engine } : { name: args.name, engine, created: new Date().toISOString(), studio: { configVersion: 1 } };
  writeConfig(dir, config);
  return { dir, config, files: [...files, CONFIG] };
}
