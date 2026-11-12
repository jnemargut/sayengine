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

test('a phone page: its pixel ratio and viewport, and real touch events (a tap and a two-finger pinch)', { timeout: 60000 }, async () => {
  const { withPage } = await import('../src/chrome.ts');
  const html = 'data:text/html,' + encodeURIComponent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><script>window.got = []; for (const t of ["touchstart", "touchmove", "touchend", "pointerdown"]) addEventListener(t, (e) => window.got.push([t, e.touches ? e.touches.length : e.pointerType]));</script>');
  const r = await withPage(html, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true }, async (page) => {
    await page.touch('touchStart', [{ x: 100, y: 200 }]); await page.touch('touchEnd', []);
    await page.touch('touchStart', [{ x: 150, y: 400, id: 0 }, { x: 240, y: 400, id: 1 }]);
    await page.touch('touchMove', [{ x: 100, y: 400, id: 0 }, { x: 290, y: 400, id: 1 }]);
    await page.touch('touchEnd', []);
    return page.eval('JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight, coarse: matchMedia("(pointer: coarse)").matches, got: window.got })') as Promise<string>;
  });
  const d = JSON.parse(r);
  assert.equal(d.dpr, 3); assert.equal(d.w, 390); assert.equal(d.h, 844);
  assert.ok(d.got.some((g: [string, unknown]) => g[0] === 'touchstart' && g[1] === 1), 'a one-finger touch arrived');
  assert.ok(d.got.some((g: [string, unknown]) => g[0] === 'touchmove' && g[1] === 2), 'a two-finger move arrived');
  assert.ok(d.got.some((g: [string, unknown]) => g[0] === 'pointerdown' && g[1] === 'touch'), 'pointer events carry pointerType touch');
});
