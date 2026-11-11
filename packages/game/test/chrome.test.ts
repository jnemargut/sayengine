// The game runner never leaks a browser: a runner stopped by a signal kills its Chromes and removes their
// temp profiles, and one killed outright (SIGKILL, no handlers run) is swept by the next launch.
// A fake "browser" (a shell loop that keeps its --user-data-dir argument) stands in for Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sweepOrphans } from '../src/chrome.ts';

const CHROME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/chrome.ts');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = async (ok: () => boolean, ms = 5000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return ok(); };

function runner(dir: string) {
  const fake = path.join(dir, 'fake-browser.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const script = path.join(dir, 'runner.ts');
  fs.writeFileSync(script, `import { spawnBrowser, newProfile } from ${JSON.stringify(CHROME)};
const profile = newProfile();
const b = spawnBrowser(${JSON.stringify(fake)}, ['--user-data-dir=' + profile], profile);
console.log(JSON.stringify({ pid: b.child.pid, profile }));
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const first = new Promise<{ pid: number; profile: string }>((resolve) => { let buf = ''; child.stdout!.on('data', (d) => { buf += d; const l = buf.split('\n')[0]; if (buf.includes('\n')) resolve(JSON.parse(l)); }); });
  return { child, first };
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`a ${sig}'d runner takes its browser and profile with it`, { timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-chrome-test-'));
    const { child, first } = runner(dir);
    const { pid, profile } = await first;
    assert.ok(alive(pid), 'the browser started');
    assert.ok(fs.existsSync(profile), 'the profile exists');
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
    child.kill(sig);
    const e = await exited;
    assert.equal(e.signal, sig, 'the runner still dies of the signal');
    assert.ok(await wait(() => !alive(pid)), 'no orphan browser survives');
    assert.ok(!fs.existsSync(profile), 'the temp profile is gone');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('a SIGKILLed runner\'s orphan is swept by the next launch', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-chrome-test-'));
  const { child, first } = runner(dir);
  const { pid, profile } = await first;
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGKILL');
  await exited;
  assert.ok(alive(pid), 'SIGKILL runs no handlers: the browser is orphaned');
  const r = sweepOrphans();
  assert.ok(r.killed >= 1 && r.removed >= 1, JSON.stringify(r));
  assert.ok(await wait(() => !alive(pid)), 'the orphan is killed');
  assert.ok(!fs.existsSync(profile), 'its profile is removed');
  fs.rmSync(dir, { recursive: true, force: true });
});
