// @studio/game — the /game skill's engine back ends (Decisions 13 and 17).
// The studio makes assets; real engines run games: Godot for standalone games, three.js for web.
// Everything returns the studio's JSON shape: { ok, tool, engine, project, result, warnings, errors }.
import fs from 'node:fs';
import path from 'node:path';
import { GAME_TOOLS, gameTool } from './tools.ts';
import { initProject, listGames, resolveProject, writeConfig, copyTemplate, workDir, type Engine } from './project.ts';
import * as godot from './godot.ts';
import * as web from './web.ts';
import { findChrome } from './chrome.ts';
import { parseTarget, parseViews } from './util.ts';

export { GAME_TOOLS, gameTool };
export { findGodot } from './godot.ts';
export { findChrome } from './chrome.ts';

export interface GameContext {
  studioDir: string;
  /** Export the studio scene (or one object) as GLB to an absolute path — the CLI wires this to the daemon. */
  exportGlb(out: string, object: string | undefined, engine: Engine): Promise<{ ok: boolean; error?: string; result?: any }>;
}

/**
 * Round-trip a GLB through an engine and report what it built plus every warning/error.
 * The studio's export (Week 1, `export --target godot|web`) calls this; any warning or error is a failed export.
 */
export async function roundTrip(glbPath: string, engine: Engine) {
  return engine === 'godot' ? godot.roundTrip(glbPath) : web.roundTrip(glbPath);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export async function runGame(name: string, args: Record<string, any>, ctx: GameContext): Promise<any> {
  const tool = gameTool(name);
  if (!tool) return { ok: false, error: `unknown game command "${name}"`, hint: `commands: ${GAME_TOOLS.map((t) => t.name.slice(5)).join(', ')}` };
  const out = (o: object) => ({ tool: tool.name, ...o });
  try {
    switch (tool.name) {
      case 'game-init': {
        const r = initProject(ctx.studioDir, args as any);
        const rel = path.relative(ctx.studioDir, r.dir) || '.';
        return out({ ok: true, engine: r.config.engine, project: rel, result: { dir: r.dir, files: r.files, next: `studio game import --project ${rel}` } });
      }
      case 'game-status': {
        const games = (args.project ? [resolveProject(ctx.studioDir, args.project)] : listGames(ctx.studioDir)).map(({ dir, config }) => {
          const glb = path.join(dir, 'assets', 'studio', 'scene.glb');
          return { project: path.relative(ctx.studioDir, dir), name: config.name, engine: config.engine, lastImport: config.lastImport ?? null, sceneGlb: fs.existsSync(glb) ? { bytes: fs.statSync(glb).size, modified: fs.statSync(glb).mtime.toISOString() } : null };
        });
        const g = godot.findGodot();
        return out({ ok: true, result: { games, engines: { godot: g ? { available: true, ...g } : { available: false, hint: 'brew install --cask godot, or set GODOT_BIN' }, web: findChrome() ? { available: true, chrome: findChrome() } : { available: false, hint: 'install Google Chrome or set CHROME_BIN' } } } });
      }
    }
    const { dir, config } = resolveProject(ctx.studioDir, args.project);
    const project = path.relative(ctx.studioDir, dir) || '.';
    const base = { engine: config.engine, project };
    // managed files follow the studio version on every command (user files are never touched)
    copyTemplate(config.engine, dir, { NAME: config.name }, true);

    switch (tool.name) {
      case 'game-import': {
        const dest = path.join(dir, 'assets', 'studio', 'scene.glb');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        let source: string;
        if (args.file) {
          const f = path.resolve(ctx.studioDir, String(args.file));
          if (!fs.existsSync(f)) return out({ ok: false, ...base, error: `no file ${args.file}` });
          fs.copyFileSync(f, dest);
          source = path.relative(ctx.studioDir, f);
        } else {
          const e = await ctx.exportGlb(dest, args.object, config.engine);
          if (!e.ok) return out({ ok: false, ...base, error: `studio export failed: ${e.error}` });
          source = args.object ? `studio object ${args.object}` : 'studio scene';
          if (e.result?.skipped?.length) return out({ ok: false, ...base, error: `these objects don't evaluate, fix them in the studio first: ${e.result.skipped.join(', ')}` });
        }
        const rep: any = config.engine === 'godot' ? await godot.importProject(dir) : await web.webCommand(dir, { cmd: 'info' });
        const report = config.engine === 'godot' ? rep : { ...rep.result, warnings: rep.warnings ?? [], errors: [...(rep.errors ?? []), ...(rep.error ? [rep.error] : [])] };
        const strict = args.strict !== false;
        const failures = [...report.errors, ...(strict ? report.warnings : [])];
        config.lastImport = { at: new Date().toISOString(), file: path.relative(dir, dest), source, ok: !failures.length, triangles: report.triangles, meshes: report.meshes ?? report.objects?.length, warnings: report.warnings.length };
        writeConfig(dir, config);
        return out({
          ok: !failures.length, ...base,
          result: { file: dest, source, roundTrip: report },
          ...(failures.length ? { error: `round trip into ${config.engine} reported ${report.errors.length} error(s) and ${report.warnings.length} warning(s)`, failures, hint: 'fix the asset in the studio and import again — never edit the engine copy' + (strict && !report.errors.length ? ' (or --strict false to accept warnings)' : '') } : {}),
        });
      }
      case 'game-run': {
        const seconds = Number(args.seconds ?? 3);
        const r = config.engine === 'godot' ? await godot.runnerCommand(dir, { cmd: 'run', seconds }) : await web.webCommand(dir, { cmd: 'run', seconds });
        return out({ ...base, ...r });
      }
      case 'game-screenshot': {
        const views = parseViews(args.views);
        const size = Number(args.size ?? 960);
        const cmd: any = { cmd: 'screenshot', views, size, prefix: `${stamp()}-shot`, ...(args.object ? { object: args.object } : {}), ...(args.player ? { player: args.player } : {}) };
        const r = config.engine === 'godot'
          ? await godot.runnerCommand(dir, { ...cmd, outDir: workDir(dir, 'shots') }, { windowed: true, size })
          : await web.webCommand(dir, cmd, { size });
        return out({ ...base, ...r, ...(r.ok ? { note: 'Read the PNG files to look at the game as the engine renders it.' } : {}) });
      }
      case 'game-walk-to': {
        const target = parseTarget(args.target);
        const cmd: any = { cmd: 'walk', target, speed: args.speed ?? 1.4, reach: args.reach ?? 0.45, timeout: args.timeout ?? 20, ...(args.from ? { from: args.from } : {}) };
        const shot = args.screenshot === true || args.screenshot === 'true';
        if (shot) Object.assign(cmd, { shot: true, views: ['iso'], prefix: `${stamp()}-walk` });
        const r = config.engine === 'godot'
          ? await godot.runnerCommand(dir, { ...cmd, outDir: workDir(dir, 'shots') }, { windowed: shot })
          : await web.webCommand(dir, cmd);
        const summary = r.ok && r.result ? (r.result.reached ? `reached ${typeof target === 'string' ? target : JSON.stringify(target)} in ${r.result.seconds} s` : `did not reach it: ${r.result.timedOut ? 'timed out' : 'blocked'} ${r.result.distanceToTarget} m short at ${JSON.stringify(r.result.final)}`) : undefined;
        return out({ ...base, ...r, ...(summary ? { summary } : {}) });
      }
      case 'game-test': {
        const assertions = typeof args.assertions === 'string' ? JSON.parse(args.assertions) : args.assertions ?? [];
        if (!Array.isArray(assertions)) return out({ ok: false, ...base, error: '--assertions must be a JSON array of {kind, …}' });
        const cmd = { cmd: 'test', assertions, scripts: args.scripts !== false };
        const r = config.engine === 'godot' ? await godot.runnerCommand(dir, cmd) : await web.webCommand(dir, cmd);
        const summary = r.ok && r.result ? `${r.result.passed} passed, ${r.result.failed} failed` : undefined;
        return out({ ...base, ...r, ok: r.ok && (r.result?.failed ?? 0) === 0, ...(summary ? { summary } : {}) });
      }
    }
    return out({ ok: false, error: `not implemented: ${tool.name}` });
  } catch (e: any) {
    return out({ ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}) });
  }
}
