// @studio/game: pure helpers, project scaffolding, CLI/MCP surface, and (when Godot / Chrome are
// installed) a real round trip of a studio GLB through each engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frame, parseGodotOutput, parseTarget, parseViews, spawnCandidates, xzDistToBox, slug } from '../src/util.ts';
import { initProject, resolveProject, readConfig, copyTemplate } from '../src/project.ts';
import { GAME_TOOLS, findGodot, findChrome, roundTrip } from '../src/index.ts';
import { initKernel, Studio, toGLB } from '../../core/src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'packages/cli/studio.ts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-game-test-'));

test('views: parse, validate, and frame a box', () => {
  assert.deepEqual(parseViews(undefined), ['iso', 'front']);
  assert.deepEqual(parseViews('iso, top,iso'), ['iso', 'top']);
  assert.deepEqual(parseViews(['side']), ['side']);
  assert.throws(() => parseViews('iso,diagonal'), /unknown view diagonal/);
  const f = frame({ min: [-1, 0, -1], max: [1, 2, 1] }, 'front');
  assert.deepEqual(f.target, [0, 1, 0]);
  assert.ok(f.position[2] > 3 && Math.abs(f.position[0]) < 1e-9, 'front camera sits on +z');
  assert.ok(f.near > 0 && f.far > f.near);
});

test('walk helpers: footprint distance, spawn candidates, targets', () => {
  const b = { min: [-0.2, 0, -0.2], max: [0.2, 0.45, 0.2] } as any;
  assert.equal(xzDistToBox([0, 0, 0], b), 0);
  assert.ok(Math.abs(xzDistToBox([0, 0, 1.2], b) - 1.0) < 1e-9);
  const s = spawnCandidates(b, 3);
  assert.equal(s.length, 5);
  assert.deepEqual(s[0].map((v) => +v.toFixed(3)), [0, 0, 3.2]);
  assert.equal(parseTarget('Walnut stool'), 'Walnut stool');
  assert.deepEqual(parseTarget([1, 2]), [1, 0, 2]);
  assert.deepEqual(parseTarget('[1, 0.5, 2]'), [1, 0.5, 2]);
  assert.throws(() => parseTarget(''), /--target is required/);
});

test('Godot output: result line, import reports, warnings and errors (with locations), ANSI stripped', () => {
  const text = [
    'Godot Engine v4.5.1.stable.official - https://godotengine.org',
    '\x1b[1m[  50% ] reimport | stool.glb\x1b[0m',
    'STUDIO_IMPORT {"meshes":2,"triangles":10}',
    '\x1b[1;33mWARNING:\x1b[0m Mesh has degenerate faces',
    '   at: _import (res://foo.gd:12)',
    'ERROR: Cannot open file',
    'hello from game',
    'STUDIO_RESULT {"ok":true,"reached":true}',
  ].join('\n');
  const p = parseGodotOutput(text);
  assert.deepEqual(p.result, { ok: true, reached: true });
  assert.equal(p.imports[0].meshes, 2);
  assert.deepEqual(p.warnings, ['Mesh has degenerate faces (_import (res://foo.gd:12))']);
  assert.deepEqual(p.errors, ['Cannot open file']);
  assert.deepEqual(p.prints, ['hello from game']);
});

test('projects: init writes the template, never clobbers game files, refreshes managed ones', () => {
  const dir = tmp();
  const r = initProject(dir, { name: 'Forge Yard', engine: 'godot' });
  assert.equal(path.relative(dir, r.dir), path.join('games', 'forge-yard'));
  for (const f of ['project.godot', 'game/main.gd', 'studio/runner.gd', 'studio/import_studio.gd', '.gitignore', 'studio-game.json']) assert.ok(fs.existsSync(path.join(r.dir, f)), f);
  assert.match(fs.readFileSync(path.join(r.dir, 'project.godot'), 'utf8'), /config\/name="Forge Yard"/);
  assert.throws(() => initProject(dir, { name: 'Forge Yard' }), /already exists/);
  fs.writeFileSync(path.join(r.dir, 'game/main.gd'), '# my game');
  fs.writeFileSync(path.join(r.dir, 'studio/runner.gd'), '# stale');
  copyTemplate('godot', r.dir, { NAME: 'Forge Yard' }, true);
  assert.equal(fs.readFileSync(path.join(r.dir, 'game/main.gd'), 'utf8'), '# my game', 'user code untouched');
  assert.match(fs.readFileSync(path.join(r.dir, 'studio/runner.gd'), 'utf8'), /STUDIO_RESULT/, 'managed file refreshed');
  const w = initProject(dir, { name: 'web toy', engine: 'web' });
  for (const f of ['index.html', 'src/main.ts', 'studio/harness.ts']) assert.ok(fs.existsSync(path.join(w.dir, f)), f);
  assert.equal(readConfig(w.dir).engine, 'web');
  assert.throws(() => resolveProject(dir), /2 game projects — pass --project/);
  assert.equal(resolveProject(dir, 'forge-yard').config.name, 'Forge Yard');
  assert.equal(resolveProject(dir, 'Web Toy').config.engine, 'web');
  assert.throws(() => resolveProject(dir, 'nope'), /no game project "nope"/);
  assert.equal(slug('  Forge — Yard 2! '), 'forge-yard-2');
});

test('CLI + MCP: game commands are typed, discoverable and correct bad input without starting anything', () => {
  const run = (args: string[], input?: string) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', cwd: tmp(), env: { ...process.env, STUDIO_PORT: '4595' }, timeout: 30000 });
  const near = JSON.parse(run(['game', 'wlak-to']).stdout);
  assert.deepEqual(near.didYouMean, ['walk-to']);
  const flag = JSON.parse(run(['game', 'walk-to', '--taget', 'x']).stdout);
  assert.match(flag.error, /unknown flag --taget/);
  assert.deepEqual(flag.didYouMean['--taget'], ['--target']);
  const help = JSON.parse(run(['game-screenshot', '--help']).stdout);
  assert.ok(help.flags['--views']);
  const none = JSON.parse(run(['game', 'run']).stdout);
  assert.match(none.error, /no game project yet/);
  const lines = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const out = run(['mcp'], lines).stdout.trim().split('\n').map((l) => JSON.parse(l));
  const names = out[1].result.tools.map((t: any) => t.name);
  for (const t of GAME_TOOLS) assert.ok(names.includes(t.name), t.name);
});

async function studioGlb(): Promise<string> {
  await initKernel();
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); };
  ok('new-object', { name: 'Block', type: 'prop', material: 'glazed-ceramic' });
  ok('add-op', { id: 'b', op: 'box', args: { size: [0.4, 0.3, 0.2], at: [0, 0.15, 0] } });
  const doc = s.doc();
  const f = path.join(tmp(), 'block.glb');
  fs.writeFileSync(f, toGLB(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) }))));
  return f;
}

test('round trip through Godot: clean import, studio glaze re-applied', { skip: !findGodot() && 'Godot 4 not installed', timeout: 180000 }, async () => {
  const r: any = await roundTrip(await studioGlb(), 'godot');
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.meshes, 1);
  assert.equal(r.triangles, 12);
  assert.ok(r.materials[0].clearcoat > 0, 'clearcoat carried over by the post-import script');
});

test('round trip through three.js in headless Chrome', { skip: !findChrome() && 'Chrome not installed', timeout: 180000 }, async () => {
  const r: any = await roundTrip(await studioGlb(), 'web');
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.meshes, 1);
  assert.equal(r.triangles, 12);
  assert.deepEqual(r.size, [0.4, 0.3, 0.2]);
});
