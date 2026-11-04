// `studio export --target godot|web` through the daemon: needs a view to bake (a websocket client
// stands in for the browser here), refuses while game checks fail, validates every GLB, runs
// after-export hooks, and keeps plain exports working.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startDaemon } from '../src/server.ts';
import { onAfterExport } from '../../core/src/index.ts';
import { solidPng } from '../../core/test/png.ts';

// The real engine round-trip is covered by packages/game tests; here a stand-in hook checks the wiring.
process.env.STUDIO_ROUNDTRIP = '0';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-game-'));
const port = 4595;
const { server } = await startDaemon({ dir, port });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;
const call = async (tool: string, args: object = {}) => (await (await fetch(`${base}/api/call`, { method: 'POST', body: JSON.stringify({ tool, args }) })).json());

async function buildStool() {
  for (const [t, a] of [
    ['new-object', { name: 'Stool', type: 'stool', material: 'walnut' }],
    ['add-op', { id: 'seat', op: 'roundedBox', part: 'seat', args: { size: [0.36, 0.03, 0.36], r: 0.008, at: [0, 0.435, 0] } }],
    ['add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: 0.015, h: 0.42 } }],
    ['add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.05 } }],
    ['add-op', { id: 'body', op: 'union', inputs: ['seat', 'legs'], output: true }],
    ['set-profile', { profile: 'godot-desktop' }],
  ] as const) assert.ok((await call(t, a)).ok, t);
}

test('game export: no view → clear error; failing game checks block; --bake false writes a valid untextured GLB', async () => {
  await buildStool();
  const noCol = await call('export', { target: 'godot' });
  assert.equal(noCol.ok, false);
  assert.match(noCol.error, /Has a collision shape/);
  assert.ok((await call('add-op', { id: 'col', op: 'collision', inputs: ['body'] })).ok);
  const noView = await call('export', { target: 'godot' });
  assert.equal(noView.ok, false);
  assert.match(noView.error, /needs the browser view/);
  assert.match(noView.hint, /--bake false/);
  const plain = await call('export', { target: 'godot', bake: false });
  assert.ok(plain.ok, plain.error);
  assert.ok(plain.result.file.endsWith('scene.godot.glb'));
  assert.deepEqual(plain.result.validation, { errors: 0, warnings: 0 });
  assert.equal(plain.result.objectsReport[0].collision[0].node, 'Stool_col-convcolonly');
  const glb = await call('export', { format: 'glb' });
  assert.ok(glb.ok && glb.result.validation.errors === 0, 'plain GLB export is validated too');
  assert.equal((await call('export', { target: 'unity' })).ok, false);
});

test('game export with a view: the daemon relays a bake request and embeds the returned textures; hooks run', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let request: any = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== 'bake') return;
    request = m;
    const png = (rgba: [number, number, number, number]) => 'data:image/png;base64,' + Buffer.from(solidPng(m.size, m.size, rgba)).toString('base64');
    ws.send(JSON.stringify({ type: 'bake-result', id: m.id, baseColor: png([94, 63, 44, 255]), metallicRoughness: png([0, 140, 0, 255]) }));
  });
  await new Promise((r) => ws.once('open', r));
  const seen: string[] = [];
  const off = onAfterExport(async (ctx) => { seen.push(`${ctx.target}:${path.basename(ctx.file)}`); return { name: 'round-trip', ok: true, detail: 'imported' }; });
  try {
    const r = await call('export', { target: 'web', object: 'stool' });
    assert.ok(r.ok, r.error);
    assert.equal(request.size, 1024);
    assert.ok(request.parts.length >= 5 && typeof request.parts[0].positions === 'string' && request.parts[0].material.grain, 'parts arrive as base64 floats with their material');
    const bytes = fs.readFileSync(r.result.file);
    const j = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    assert.equal(j.images.length, 2);
    assert.ok(r.result.objectsReport[0].uv.checks.every((c: any) => c.pass));
    assert.deepEqual(seen, ['web:stool.web.glb']);
    assert.deepEqual(r.result.afterExport, [{ name: 'round-trip', ok: true, detail: 'imported' }]);
  } finally { off(); }
  const offBad = onAfterExport(async () => ({ name: 'round-trip', ok: false, detail: 'Godot import warnings' }));
  try {
    const bad = await call('export', { target: 'web', object: 'stool' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /after-export check failed: round-trip: Godot import warnings/);
  } finally { offBad(); ws.close(); }
});
