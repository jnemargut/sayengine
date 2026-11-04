// The daemon's HTTP/websocket surface for the new features: drag-and-drop upload → import,
// serving reference assets, live slider previews (no commit) and human edits as steps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startDaemon } from '../src/server.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-daemon-'));
const port = 4593;
const { server, studio } = await startDaemon({ dir, port });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;
const call = async (tool: string, args: object = {}) => (await (await fetch(`${base}/api/call`, { method: 'POST', body: JSON.stringify({ tool, args }) })).json());

test('upload imports a dropped mesh as the human and stores it under .studio/assets', async () => {
  // a closed tetrahedron as ASCII STL, in mm
  const v = [[0, 0, 0], [100, 0, 0], [0, 100, 0], [0, 0, 100]];
  const tri = (a: number, b: number, c: number) => `facet normal 0 0 0\nouter loop\n${[a, b, c].map((i) => `vertex ${v[i].join(' ')}`).join('\n')}\nendloop\nendfacet\n`;
  const stl = `solid t\n${tri(0, 2, 1)}${tri(0, 1, 3)}${tri(0, 3, 2)}${tri(1, 2, 3)}endsolid t\n`;
  const r = await (await fetch(`${base}/api/upload?name=tetra.stl`, { method: 'POST', body: stl })).json();
  assert.ok(r.ok, r.error);
  assert.match(r.summary, /reference mesh/);
  assert.equal(studio.log('main', 1)[0].author, 'human');
  const asset = (r.result as any).asset;
  assert.ok(fs.existsSync(path.join(dir, '.studio/assets', asset)));
  const res = await fetch(`${base}/assets/${asset}`);
  assert.equal(res.status, 200);
  const info = await call('inspect', { object: 'tetra' });
  assert.ok(Math.abs(info.result.bbox.max[1] - 0.1) < 1e-6, 'mm, Z-up → 10 cm tall');
  const bad = await (await fetch(`${base}/api/upload?name=notes.txt`, { method: 'POST', body: 'x' })).json();
  assert.equal(bad.ok, false);
  assert.equal((await fetch(`${base}/assets/..%2Frepo.json`)).status, 404);
});

test('slider preview evaluates without committing; export leaves references out', async () => {
  await call('new-object', { name: 'Block', type: 'prop' });
  await call('set-params', { values: { h: 0.2 } });
  await call('add-op', { id: 'b', op: 'box', args: { size: [0.2, '$h', 0.2], at: [0, '$h/2', 0] } });
  const commits = Object.keys(studio.history.data.commits).length;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msg = await new Promise<any>((resolve) => {
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'preview') resolve(m); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'preview', id: 1, branch: 'main', object: 'block', params: { h: 0.5 } })));
  });
  ws.close();
  const block = msg.objects.find((o: any) => o.id === 'block');
  assert.ok(Math.abs(block.bbox.max[1] - 0.5) < 1e-6, 'preview shows the scrubbed height');
  assert.equal(Object.keys(studio.history.data.commits).length, commits, 'nothing committed');
  assert.equal(studio.doc().objects.block.params.h.value, 0.2);
  const ex = await call('export', { format: 'glb' });
  assert.ok(ex.ok);
  assert.deepEqual(ex.result.referencesLeftOut, ['tetra.stl']);
});
