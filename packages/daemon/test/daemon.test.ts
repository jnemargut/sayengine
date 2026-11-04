// Daemon-side tests: the QuickJS sandbox, the CLI's guard rails, and the MCP adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxed } from '../src/sandbox.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'packages/cli/studio.ts');

test('sandbox: tools are callable, console works, errors propagate', async () => {
  const calls: string[] = [];
  const r = await runSandboxed(`for (let i = 0; i < 3; i++) console.log(studio.setParam({ name: 'p' + i }).ok)`, ['set-param'], (t) => { calls.push(t); return { ok: true }; });
  assert.deepEqual(r, { ok: true, logs: ['true', 'true', 'true'] });
  assert.equal(calls.length, 3);
  const bad = await runSandboxed(`studio.call('x', {})`, ['x'], () => { throw new Error('nope'); });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /x: nope/);
});

test('sandbox: no host access, time and memory limits', async () => {
  const r = await runSandboxed(`console.log([typeof require, typeof process, typeof fetch, typeof __call, typeof setTimeout].join())`, [], () => null);
  assert.deepEqual(r.logs, ['undefined,undefined,undefined,undefined,undefined']);
  const slow = await runSandboxed(`while (true) {}`, [], () => null, { timeoutMs: 200 });
  assert.match(slow.error!, /timed out/);
  const big = await runSandboxed(`const a = []; while (true) a.push('x'.repeat(1e6))`, [], () => null, { memoryBytes: 16e6 });
  assert.match(big.error!, /memory/);
});

const cli = (args: string[], input?: string) => spawnSync(process.execPath, [CLI, ...args], {
  input, encoding: 'utf8', cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-')),
  env: { ...process.env, STUDIO_PORT: '4591' }, timeout: 30000,
});

test('CLI: unknown commands and flags get suggestions, without starting a daemon', () => {
  const a = JSON.parse(cli(['ad-op']).stdout);
  assert.equal(a.ok, false);
  assert.ok(a.didYouMean.includes('add-op'));
  const b = JSON.parse(cli(['add-op', '--id', 'x', '--op', 'box', '--size', '[1,1,1]']).stdout);
  assert.match(b.error, /unknown flag --size/);
  assert.match(b.hint, /--args/);
  const h = JSON.parse(cli(['add-op', '--help']).stdout);
  assert.ok(h.flags['--id'].required);
  assert.ok(h.ops.primitives.revolve);
});

test('MCP adapter: initialize and tools/list are generated from the registry', () => {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = cli(['mcp'], lines);
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out[0].result.serverInfo.name, 'ai-3d-studio');
  const names = out[1].result.tools.map((t: any) => t.name);
  for (const n of ['new-object', 'add-op', 'propose', 'check', 'render', 'selection', 'export', 'run']) assert.ok(names.includes(n), n);
  const addOp = out[1].result.tools.find((t: any) => t.name === 'add-op');
  assert.equal(addOp.inputSchema.type, 'object');
  assert.ok(addOp.inputSchema.properties.op.enum.includes('extrude'));
});
