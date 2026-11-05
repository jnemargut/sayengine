// @studio/game — the /game skill's engine back ends (Decisions 13 and 17).
// The studio makes assets; real engines run games: Godot for standalone games, three.js for web.
// Everything returns the studio's JSON shape: { ok, tool, engine, project, result, warnings, errors }.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GAME_TOOLS, gameTool } from './tools.ts';
import { initProject, listGames, resolveProject, writeConfig, copyTemplate, workDir, type Engine } from './project.ts';
import * as godot from './godot.ts';
import * as web from './web.ts';
import { findChrome } from './chrome.ts';
import { parseTarget, parseViews } from './util.ts';

export { GAME_TOOLS, gameTool };
export { findGodot } from './godot.ts';
import { writeCutscenes, muxCutscene, type CutsceneBundle } from './cutscene.ts';
export { writeCutscenes, godotCutsceneScene } from './cutscene.ts';
export { findChrome } from './chrome.ts';
import { writeGameData } from './effects.ts';
import { frameStats, parity, sideBySide } from './fxreview.ts';
import type { GameData } from '../../core/src/gamedata.ts';
export { writeGameData, quarksJSON, quarksGroup, parseQuarks, loadQuarks, QUARKS_VERSION } from './effects.ts';
export { frameStats, parity } from './fxreview.ts';

export interface GameContext {
  studioDir: string;
  /** Export the studio scene (or one object) as GLB to an absolute path — the CLI wires this to the daemon. */
  exportGlb(out: string, object: string | undefined, engine: Engine, opts?: { exclude?: string[]; atOrigin?: boolean }): Promise<{ ok: boolean; error?: string; result?: any }>;
  /** Where a studio object stands (for the player's start). */
  objectInfo?(object: string): Promise<{ id: string; name: string; position: [number, number, number]; rotation: number; character: boolean } | null>;
  /** The studio's cutscenes as timelines + their voices (Decision 24). */
  cutscenes?(): Promise<CutsceneBundle[]>;
  /** Effects (with positions), the UI kit and every recorded line's audio (Phase 9). */
  gameData?(): Promise<GameData | null>;
  /** Call a studio tool (game effect --against saves the parity review on the effect). */
  studioCall?(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; result?: any }>;
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
    if (tool.name === 'game-ui-sheet') {
      const data = ctx.gameData ? await ctx.gameData() : null;
      if (!data?.ui) return out({ ok: false, error: 'no UI kit in the studio', hint: 'studio ui-kit --preset forge, then studio ui-icon --names ...' });
      const outDir = path.resolve(ctx.studioDir, String(args.out ?? path.join('.studio', 'ui-sheet')));
      const { renderSheet } = await import('./uisheet.ts');
      const r = await renderSheet(data.ui, outDir);
      let scores: any = null;
      if (ctx.studioCall && Object.keys(r.masks ?? {}).length) { const sc = await ctx.studioCall('ui-score-icons', { masks: r.masks }); scores = sc.result?.scores ?? sc.error; }
      return out({ ok: true, result: { png: r.png, sheet: r.sheet, scores }, note: 'Read the PNG to look at the kit.' });
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
        if (args.player !== undefined) { if (args.player === 'none' || args.player === '') delete config.player; else config.player = String(args.player); writeConfig(dir, config); }
        const playerGlb = path.join(dir, 'assets', 'studio', 'player.glb');
        let player: any = null;
        if (config.player && !args.file) {
          const info = ctx.objectInfo ? await ctx.objectInfo(config.player) : null;
          if (!info) return out({ ok: false, ...base, error: `the player "${config.player}" is not in the studio`, hint: '--player <character> or --player none' });
          if (!info.character) return out({ ok: false, ...base, error: `${info.name} is not a character, so it can't be the player` });
          const pe = await ctx.exportGlb(playerGlb, info.id, config.engine, { atOrigin: true });
          if (!pe.ok) return out({ ok: false, ...base, error: `player export failed: ${pe.error}` });
          player = { id: info.id, name: info.name, start: info.position, rotation: info.rotation };
        } else fs.rmSync(playerGlb, { force: true });
        let source: string;
        if (args.file) {
          const f = path.resolve(ctx.studioDir, String(args.file));
          if (!fs.existsSync(f)) return out({ ok: false, ...base, error: `no file ${args.file}` });
          fs.copyFileSync(f, dest);
          source = path.relative(ctx.studioDir, f);
        } else {
          const e = await ctx.exportGlb(dest, args.object, config.engine, player ? { exclude: [player.id] } : undefined);
          if (!e.ok) return out({ ok: false, ...base, error: `studio export failed: ${e.error}` });
          source = args.object ? `studio object ${args.object}` : 'studio scene';
          if (e.result?.skipped?.length) return out({ ok: false, ...base, error: `these objects don't evaluate, fix them in the studio first: ${e.result.skipped.join(', ')}` });
        }
        fs.writeFileSync(path.join(dir, 'assets', 'studio', 'characters.json'), JSON.stringify(charactersManifest(dest, player ? { ...player, glb: playerGlb } : null), null, 2) + '\n');
        // cutscenes: the timelines, voices and (Godot) generated scenes
        const cutscenes = !args.file && ctx.cutscenes ? writeCutscenes(dir, config.engine, await ctx.cutscenes()) : [];
        // effects, the UI kit, every line's audio (Godot imports them in the same pass below)
        const extra = await writeGameData(dir, config.engine, !args.file && ctx.gameData ? await ctx.gameData() : null);
        const rep: any = config.engine === 'godot' ? await godot.importProject(dir) : await web.webCommand(dir, { cmd: 'info' });
        const report = config.engine === 'godot' ? rep : { ...rep.result, warnings: rep.warnings ?? [], errors: [...(rep.errors ?? []), ...(rep.error ? [rep.error] : [])] };
        const strict = args.strict !== false;
        const failures = [...report.errors, ...(strict ? report.warnings : [])];
        config.lastImport = { at: new Date().toISOString(), file: path.relative(dir, dest), source, ok: !failures.length, triangles: report.triangles, meshes: report.meshes ?? report.objects?.length, warnings: report.warnings.length };
        writeConfig(dir, config);
        return out({
          ok: !failures.length, ...base,
          result: { file: dest, source, ...(cutscenes.length ? { cutscenes: cutscenes.map((f) => path.relative(dir, f)) } : {}), ...(ctx.gameData && !args.file ? { assets: summariseAssets(dir, extra) } : {}), ...(!ctx.gameData && !args.file ? { note: 'no studio game data reached the import (the caller passed no gameData()): effects, the UI kit and line audio were written empty' } : {}), ...(player ? { player: { name: player.name, file: playerGlb, start: player.start } } : {}), characters: charactersManifest(dest, null).characters.map((c: any) => `${c.name} (${Object.keys(c.clips).join(', ') || 'no clips'})`), roundTrip: report },
          ...(failures.length ? { error: `round trip into ${config.engine} reported ${report.errors.length} error(s) and ${report.warnings.length} warning(s)`, failures, hint: 'fix the asset in the studio and import again — never edit the engine copy' + (strict && !report.errors.length ? ' (or --strict false to accept warnings)' : '') } : {}),
        });
      }
      case 'game-run': {
        const seconds = Number(args.seconds ?? 3);
        const r = config.engine === 'godot' ? await godot.runnerCommand(dir, { cmd: 'run', seconds }) : await web.webCommand(dir, { cmd: 'run', seconds });
        return out({ ...base, ...r });
      }
      case 'game-screenshot': {
        const size = Number(args.size ?? 960);
        if (args.page === true || args.page === 'true') {
          const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
          const frame = args.object ? objectFrame(dir, String(args.object)) : null;
          const cmd: any = { cmd: 'page', prefix: `${stamp()}-page`, ui: args.ui !== false && args.ui !== 'false', seconds: Number(args.seconds ?? 1), ...(args.values ? { values: parse(args.values) } : {}), ...(args.bubbles ? { bubbles: parse(args.bubbles) } : {}), ...(args.card ? { card: parse(args.card) } : {}), ...(args.bars ? { bars: parse(args.bars) } : {}), ...(args.play ? { play: parse(args.play) } : {}), ...(frame ? { frame } : {}) };
          const r = config.engine === 'godot'
            ? await godot.runnerCommand(dir, { ...cmd, outDir: workDir(dir, 'shots') }, { windowed: true, size })
            : await web.webCommand(dir, cmd, { size });
          return out({ ...base, ...r, ...(r.ok ? { note: 'The whole screen as the player sees it (3D + UI). Read the PNG.' } : {}) });
        }
        const views = parseViews(args.views);
        const cmd: any = { cmd: 'screenshot', views, size, prefix: `${stamp()}-shot`, ...(args.object ? { object: args.object } : {}), ...(args.player ? { player: args.player } : {}) };
        const r = config.engine === 'godot'
          ? await godot.runnerCommand(dir, { ...cmd, outDir: workDir(dir, 'shots') }, { windowed: true, size })
          : await web.webCommand(dir, cmd, { size });
        return out({ ...base, ...r, ...(r.ok ? { note: 'Read the PNG files to look at the game as the engine renders it.' } : {}) });
      }
      case 'game-walk-to': {
        const target = parseTarget(args.target);
        const cmd: any = { cmd: 'walk', target, ...(args.speed ? { speed: args.speed } : {}), reach: args.reach ?? 0.45, timeout: args.timeout ?? 20, ...(args.from ? { from: args.from } : {}) };
        const shot = args.screenshot === true || args.screenshot === 'true';
        const video = args.video === true || args.video === 'true';
        if (shot) Object.assign(cmd, { shot: true, views: ['iso'], prefix: `${stamp()}-walk` });
        const frameDir = video ? path.join(workDir(dir, 'video'), stamp()) : '';
        if (video) { fs.mkdirSync(frameDir, { recursive: true }); Object.assign(cmd, { frames: frameDir, frameEvery: 2 }); }
        const r = config.engine === 'godot'
          ? await godot.runnerCommand(dir, { ...cmd, outDir: workDir(dir, 'shots') }, { windowed: shot || video, size: video ? 1280 : undefined, timeoutMs: video ? 300000 : undefined })
          : await web.webCommand(dir, cmd, video ? { size: 1280 } : undefined);
        if (video && r.ok) Object.assign(r.result ?? {}, framesToVideo(frameDir, 30));
        const summary = r.ok && r.result ? (r.result.reached ? `reached ${typeof target === 'string' ? target : JSON.stringify(target)} in ${r.result.seconds} s` : `did not reach it: ${r.result.timedOut ? 'timed out' : 'blocked'} ${r.result.distanceToTarget} m short at ${JSON.stringify(r.result.final)}`) : undefined;
        return out({ ...base, ...r, ...(summary ? { summary } : {}) });
      }
      case 'game-cutscene': {
        const id = String(args.id ?? '');
        const json = path.join(dir, 'assets', 'studio', 'cutscenes', `${id}.json`);
        if (!fs.existsSync(json)) return out({ ok: false, ...base, error: `no cutscene "${id}" in the game`, hint: `studio game import --project ${project} (it writes the studio's cutscenes)` });
        const tl = JSON.parse(fs.readFileSync(json, 'utf8'));
        const video = args.video === true || args.video === 'true';
        const frameDir = path.join(workDir(dir, 'video'), `${stamp()}-${id}`);
        if (video) fs.mkdirSync(frameDir, { recursive: true });
        let r: any;
        if (config.engine === 'godot') r = await godot.runnerCommand(dir, { cmd: 'cutscene', id, ...(video ? { frames: frameDir, every: 2 } : {}) }, { windowed: true, size: video ? 1280 : 640, timeoutMs: 600000 });
        else {
          r = await web.webCommand(dir, { cmd: 'cutscene', id, fps: 30, frames: video }, { size: video ? 1280 : 640 });
          const frames: string[] = r.result?.frames ?? [];
          frames.forEach((d, i) => fs.writeFileSync(path.join(frameDir, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
          if (r.result) delete r.result.frames;
        }
        if (video && r.ok) Object.assign(r.result ?? (r.result = {}), muxCutscene(frameDir, 30, tl, path.join(dir, 'assets', 'studio', 'cutscenes', 'audio'), path.join(workDir(dir, 'video'), `${stamp()}-${id}.mp4`)));
        return out({ ...base, ...r, ...(r.ok ? { summary: `${tl.title ?? id}: ${tl.shots.length} shots, ${tl.duration.toFixed(1)} s in ${config.engine}${r.result?.video ? ` → ${r.result.video}` : ''}` } : {}) });
      }
      case 'game-effect': {
        const id = String(args.id ?? '');
        const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
        const run = async (pdir: string, engine: Engine): Promise<any> => {
          const man = path.join(pdir, 'assets', 'studio', 'effects', 'effects.json');
          const list: any[] = fs.existsSync(man) ? JSON.parse(fs.readFileSync(man, 'utf8')) : [];
          const m = list.find((x) => x.id === id);
          if (!m) return { ok: false, error: `no effect "${id}" in ${path.relative(ctx.studioDir, pdir)} (have: ${list.map((x) => x.id).join(', ') || 'none'})`, hint: 'studio add-effect, then studio game import' };
          const frameDir = path.join(workDir(pdir, 'video'), `${stamp()}-${id}`), background = `${frameDir}-background.png`;
          fs.mkdirSync(frameDir, { recursive: true });
          const cmd: any = { cmd: 'effect', id, frame: m.frame, seconds: Number(args.seconds ?? 4), frames: frameDir, background, ...(args.value !== undefined ? { value: parse(args.value) } : {}), ...(args.events ? { events: parse(args.events) } : {}), ...(args.play ? { play: parse(args.play) } : {}), ...(args.cpu ? { cpu: args.cpu === true || args.cpu === 'true' } : {}) };
          let r: any;
          if (engine === 'godot') r = await godot.runnerCommand(pdir, cmd, { windowed: true, size: 960, timeoutMs: 300000 });
          else {
            r = await web.webCommand(pdir, cmd, { size: 960 });
            if (r.result?.background) { fs.writeFileSync(background, Buffer.from(String(r.result.background).replace(/^data:image\/\w+;base64,/, ''), 'base64')); delete r.result.background; }
          }
          if (!r.ok) return r;
          const stats = frameStats(frameDir, background);
          // the frame where the effect covers the most (a burst at its height): the review card's still
          let peak: string | null = null;
          if (stats?.peakFrame && fs.existsSync(stats.peakFrame)) { peak = `${frameDir}-peak${path.extname(stats.peakFrame)}`; fs.copyFileSync(stats.peakFrame, peak); stats.peakFrame = peak; }
          return { ...r, result: { ...r.result, background, stats, peak, ...framesToVideo(frameDir, 30) } };
        };
        const a = await run(dir, config.engine);
        if (!a.ok || !args.against) return out({ ...base, ...a, ...(a.ok ? { summary: `${id} in ${config.engine}: ${a.result.video ?? 'no video'}`, note: 'Watch the MP4 or Read the stills.' } : {}) });
        const other = resolveProject(ctx.studioDir, String(args.against));
        copyTemplate(other.config.engine, other.dir, { NAME: other.config.name }, true);
        const b = await run(other.dir, other.config.engine);
        if (!b.ok) return out({ ...base, ok: false, error: `in ${other.config.engine}: ${b.error}`, result: a.result });
        const [gd, wb] = config.engine === 'godot' ? [a, b] : [b, a];
        const par = gd.result.stats && wb.result.stats ? parity(gd.result.stats, wb.result.stats) : null;
        const card = gd.result.video && wb.result.video ? sideBySide({ video: gd.result.video, still: gd.result.peak ?? gd.result.stills[1], label: 'Godot' }, { video: wb.result.video, still: wb.result.peak ?? wb.result.stills[1], label: 'web' }, path.join(workDir(dir, 'video'), `${stamp()}-${id}-side-by-side`)) : null;
        let saved = false;
        if (par && ctx.studioCall) { const sv = await ctx.studioCall('effect-review', { id, score: par.score, detail: par.detail }); saved = !!sv.ok; }
        return out({ ...base, ok: true, result: { godot: gd.result, web: wb.result, parity: par, card, savedToStudio: saved }, summary: `${id}: ${par ? par.detail : 'no parity (a render is missing)'}` });
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

/** A camera framing one object for a page capture, from the scene GLB's node bounds. */
function objectFrame(dir: string, object: string) {
  const glb = path.join(dir, 'assets', 'studio', 'scene.glb');
  if (!fs.existsSync(glb)) return null;
  const b = fs.readFileSync(glb);
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, ' ').trim();
  const n = (j.nodes ?? []).find((x: any) => norm(x.extras?.studioName ?? x.name ?? '') === norm(object));
  if (!n || n.mesh === undefined) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of j.meshes[n.mesh].primitives) { const acc = j.accessors[p.attributes.POSITION]; if (acc?.min) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], acc.min[k]); hi[k] = Math.max(hi[k], acc.max[k]); } }
  const t = n.translation ?? [0, 0, 0];
  const c = [0, 1, 2].map((k) => t[k] + (lo[k] + hi[k]) / 2);
  const r = Math.max(hi[1] - lo[1], (hi[0] - lo[0]) / 1.6, (hi[2] - lo[2]) / 1.6) * 0.75;
  return { center: c, radius: +Math.max(0.5, r).toFixed(3), dir: [0.6, 0.45, 1] };
}

function summariseAssets(dir: string, files: string[]) {
  const rel = files.map((f) => path.relative(path.join(dir, 'assets', 'studio'), f));
  return { effects: rel.filter((f) => f.startsWith('effects/') && /\.(tscn|json)$/.test(f) && !f.endsWith('effects.json')).length, ui: rel.includes('ui/ui.json'), icons: rel.filter((f) => f.startsWith('ui/icons/')).length, lines: rel.filter((f) => f.startsWith('lines/') && f.endsWith('.wav')).length };
}

/** Clip names, loops and speeds per character in an exported GLB (from its animation and node extras). */
export function charactersManifest(sceneGlb: string, player: { id: string; name: string; start: number[]; rotation: number; glb: string } | null) {
  const read = (f: string) => {
    if (!fs.existsSync(f)) return null;
    const b = fs.readFileSync(f);
    return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  };
  const describe = (j: any) => {
    const chars: any[] = [];
    for (const n of j?.nodes ?? []) {
      const c = n.extras?.character;
      if (!c || n.mesh === undefined) continue;
      const prefix: string = c.clipPrefix ?? '';
      const clips: Record<string, any> = {};
      for (const a of j.animations ?? []) {
        if (prefix && !a.name.startsWith(prefix)) continue;
        const nm = a.name.slice(prefix.length);
        if (!prefix && j.nodes.some((m: any) => m.extras?.character?.clipPrefix && a.name.startsWith(m.extras.character.clipPrefix))) continue;
        clips[nm] = a.extras?.motion ? { motion: a.extras.motion, loop: !!a.extras.loop, speed: a.extras.speed ?? 0, duration: a.extras.duration, ...(a.extras.travel ? { travel: a.extras.travel, then: a.extras.then, ...(a.extras.phase !== undefined ? { phase: a.extras.phase } : {}) } : {}) } : { line: nm.startsWith('line:'), loop: false };
      }
      let lo = Infinity, hi = -Infinity;
      for (const p of j.meshes[n.mesh].primitives) { const acc = j.accessors[p.attributes.POSITION]; if (acc?.min) { lo = Math.min(lo, acc.min[1]); hi = Math.max(hi, acc.max[1]); } }
      chars.push({ name: n.name, prefix, height: Number.isFinite(hi - lo) ? +(hi - lo).toFixed(3) : 1.7, clips, play: clips.idle ? 'idle' : null });
    }
    return chars;
  };
  const characters = describe(read(sceneGlb));
  let p: any = null;
  if (player) {
    const c = describe(read(player.glb))[0];
    if (c) p = { ...c, id: player.id, file: 'player.glb', start: player.start, rotation: player.rotation, walkSpeed: c.clips.walk?.speed ?? 1.4, runSpeed: c.clips.run?.speed ?? null };
  }
  return { player: p, characters };
}

/** PNG frames → MP4 (ffmpeg), plus three stills; frames are kept only when ffmpeg is missing. */
export function framesToVideo(frameDir: string, fps: number) {
  const files = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /\.(png|jpg)$/.test(f)).sort() : [];
  if (!files.length) return { video: null, note: 'no frames were recorded' };
  const ext = path.extname(files[0]);
  const stills = [0.15, 0.5, 0.97].map((u, i) => { const f = files[Math.min(files.length - 1, Math.floor(u * files.length))]; const dst = path.join(frameDir, '..', `${path.basename(frameDir)}-still${i + 1}${ext}`); fs.copyFileSync(path.join(frameDir, f), dst); return dst; });
  const video = `${frameDir}.mp4`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-pattern_type', 'glob', '-i', path.join(frameDir, `*${ext}`), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video], { encoding: 'utf8' });
  if (r.status !== 0) return { video: null, frames: frameDir, stills, note: `ffmpeg: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0]}` };
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { video, frames: files.length, stills };
}
