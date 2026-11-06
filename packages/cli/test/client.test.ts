// The CLI's daemon client: a daemon that is busy (slow to answer the health check) is waited for,
// never replaced by a second one; long tool calls are not cut off by a client timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 4790 + Math.floor(Math.random() * 40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-client-'));
process.env.STUDIO_PORT = String(PORT);
process.env.STUDIO_DIR = dir;
process.env.STUDIO_BUSY_WAIT_MS = '20000';

test('a busy daemon is waited for, not replaced; a long call is not timed out', async () => {
  // a stand-in daemon: the first health checks answer late (it is busy), /api/call takes a while
  let healthCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      healthCalls++;
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, dir })); }, healthCalls <= 2 ? 1500 : 10);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, echo: JSON.parse(body).tool })); }, 1200));
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  try {
    const { ensureDaemon, callTool, portOpen } = await import('../client.ts');
    assert.equal(await portOpen(), true);
    const note = await ensureDaemon();
    assert.equal(note, null, 'no "started engine daemon" note: the busy one was used');
    assert.ok(!fs.existsSync(path.join(dir, '.studio', 'daemon.log')), 'no second daemon was spawned');
    assert.ok(healthCalls >= 2);
    const r = await callTool('render', {});
    assert.deepEqual(r, { ok: true, echo: 'render' });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
