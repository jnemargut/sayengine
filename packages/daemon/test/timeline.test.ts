// Phase 10 step 2 in the daemon: the scene timeline and its cached GLBs and WAVs over HTTP, the timeline
// tool, and the retired players' commands redirecting to the live view.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/server.ts';
import { PREVIEW_TOOLS } from '../src/previews.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-timeline-'));
const port = 4712;
const { server, studio } = await startDaemon({ dir, port });
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${port}`;
const call = async (tool: string, args: object = {}) => (await (await fetch(`${base}/api/call`, { method: 'POST', body: JSON.stringify({ tool, args }) })).json());
const ok = (tool: string, args: object) => { const r = studio.call(tool, args); assert.ok(r.ok, `${tool}: ${r.error}`); return r; };

ok('new-creature', { preset: 'crab' });
ok('add-sound', { id: 'clack', kind: 'event', sound: 'blip', seed: 3, at: [0.5, 2] });
ok('add-sound', { id: 'room', kind: 'bed', sound: 'room', seconds: 4 });

test('the scene timeline over HTTP: tracks per system, assets as caches, unchanged → same', async () => {
  const tl = await (await fetch(`${base}/api/timeline`)).json();
  const crab = tl.tracks.find((t: any) => t.system === 'motion');
  assert.ok(crab && crab.glb && crab.checks.length, 'the crab plays with its motion checks');
  const clack = tl.tracks.find((t: any) => t.id === 'sound:clack');
  assert.deepEqual(clack.markers.map((m: any) => m.at / 24000), [0.5, 2]);
  assert.ok(clack.wave.length > 10 && clack.audio, 'rendered by the sound module, with its waveform');
  const glb = await fetch(`${base}/api/timeline/asset/${crab.glb}`);
  assert.equal(glb.status, 200);
  assert.equal(new TextDecoder().decode(new Uint8Array(await glb.arrayBuffer()).slice(0, 4)), 'glTF');
  const wav = new Uint8Array(await (await fetch(`${base}/api/timeline/asset/${clack.audio}`)).arrayBuffer());
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.ok(fs.readdirSync(path.join(dir, '.studio/cache/timeline')).length >= 2, 'GLB and WAV land in the render cache');
  assert.equal((await fetch(`${base}/api/timeline/asset/..%2Frepo`)).status, 404);
  const again = await (await fetch(`${base}/api/timeline?have=${tl.stamp}`)).json();
  assert.equal(again.same, true);
  const t = await call('timeline', {});
  assert.ok(t.ok, t.error);
  assert.ok(t.result.tracks.some((x: any) => x.clock === 'sound:room'));
});

test('the five players are retired: their commands play in the live view instead', async () => {
  assert.deepEqual(PREVIEW_TOOLS, ['line-preview', 'motion-preview', 'creature-preview', 'cutscene-preview']);
  for (const d of ['motionplayer', 'creatureplayer', 'castplayer', 'cutsceneplayer', 'lineplayer']) assert.ok(!fs.existsSync(new URL(`../src/${d}`, import.meta.url)), `${d} is gone`);
  const r = await call('creature-preview', { object: 'crab' });
  assert.ok(r.ok, r.error);
  assert.match(r.result.view, new RegExp(`^http://localhost:${port}/\\?focus=crab&play=crab%3A`));
  assert.match(r.result.playsIn, /live view/);
  assert.ok(Object.keys(r.result.checks).length, 'the checks come back as before');
  assert.ok(!fs.existsSync(path.join(dir, '.studio/exports/crab-creature/index.html')), 'no separate player page is written');
  const m = await call('motion-preview', { object: 'crab', motions: 'nope' });
  assert.equal(m.ok, false);
  const l = await call('line-preview', { object: 'crab' });
  assert.equal(l.ok, false);
  assert.match(l.error, /no lines/);
  const c = await call('cutscene-preview', {});
  assert.equal(c.ok, false);
  assert.match(c.hint, /new-cutscene/);
});
