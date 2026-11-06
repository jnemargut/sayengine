// Regression: clicking any part of a rig-part creature in the live view selects that part. The view
// used to map a click on the creature's moving GLB to the hit mesh's PARENT node, so a hair strand,
// the lips, anything riding its own bone came back as the body. And Delete / Backspace deletes the
// selected object as one human step (in history, undoable).
// Drives the real view in headless Chrome with pointer and key events (the view's own handlers).
//   STUDIO_CHROME_PORT=9650 STUDIO_CHROME_SPAN=5 node --test apps/view/test/picking.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../../packages/daemon/src/server.ts';
import { findChrome, withPage, type Page } from '../../../packages/game/src/chrome.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const noChrome = !findChrome() && 'no Chrome';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A click at the middle of a part as it is drawn right now (found and clicked in the same frame). */
const clickPart = (obj: string, part: string) => `(() => {
  const v = window.__studioView, p = v.partScreen(${JSON.stringify(obj)}, ${JSON.stringify(part)});
  if (!p) return null;
  const c = document.querySelector('#viewport canvas'), o = { clientX: p[0], clientY: p[1], bubbles: true, pointerId: 1, button: 0 };
  c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerup', o));
  return { at: p, sel: v.selection(), tree: document.querySelector('#tree .part.sel span')?.textContent ?? null };
})()`;
const until = async (page: Page, cond: string, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.eval(cond)) return true; await wait(250); }
  return false;
};

test('clicking a creature part selects that part (springs, lips), and Delete deletes the object as one human step', { skip: noChrome, timeout: 300000 }, async () => {
  execFileSync(process.execPath, [path.join(here, '..', 'build.ts')], { stdio: 'ignore' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-view-pick-'));
  process.env.STUDIO_HOME = path.join(dir, 'home');
  const port = Number(process.env.STUDIO_PORT ?? 4750);
  const { server, studio, url } = await startDaemon({ dir, port });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ok = (t: string, a: object) => { const r = studio.call(t, a, 'claude'); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
  const parts = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'mop-lips.parts.json'), 'utf8'));
  ok('new-creature', { name: 'Mop Lips', parts, position: [0, 0, 0] });
  ok('new-object', { name: 'Block', type: 'prop', position: [0.9, 0, 0] });
  ok('add-op', { object: 'block', id: 'body', op: 'box', args: { size: [0.25, 0.25, 0.25], at: [0, 0.125, 0] }, part: 'body', output: true });
  const springs: string[] = parts.filter((p: any) => p.kind === 'spring').map((p: any) => p.id);
  const shot = process.env.PICK_SHOT;

  const res = await withPage(url, { width: 1280, height: 900 }, async (page) => {
    await page.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#conn.live')) { clearInterval(t); r(true); } }, 100); })`, 60000);
    // the creature plays on the timeline (its GLB covers the still mesh): wait until that is drawn
    assert.ok(await until(page, `window.__studioView.tlLoaded() && !!window.__studioView.partScreen('mop-lips', 'lips')`), 'the creature shows');
    await wait(500);
    const lips = await page.eval(clickPart('mop-lips', 'lips'));
    const out: any = { lips, studioLips: studio.selection };
    // a strand of the mop: the first one that shows from here
    let strand: any = null;
    for (const s of springs) { strand = await page.eval(clickPart('mop-lips', s)); if (strand) { strand.part = s; break; } }
    out.strand = strand; out.studioStrand = studio.selection;
    if (shot && strand) { await wait(600); fs.writeFileSync(shot, await page.screenshot()); }
    // a still object next to it picks its own parts
    out.block = await page.eval(clickPart('block', 'body'));
    // while the timeline plays, a moving strand is picked and the address carries the moment
    await page.eval(`document.querySelector('[data-tl="play"]').click(), true`);
    await wait(1200);
    let playing: any = null;
    for (const s of springs.filter((x) => x !== strand?.part)) { playing = await page.eval(clickPart('mop-lips', s)); if (playing) { playing.part = s; break; } }
    await wait(300);
    out.playing = playing; out.studioPlaying = studio.selection;
    await page.eval(`document.querySelector('[data-tl="play"]').click(), true`);
    // Delete with a part selected: the whole object goes, as you, in one step
    out.before = Object.keys(studio.history.data.commits).length;
    await page.eval(clickPart('mop-lips', 'lips'));
    await page.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })), true`);
    await until(page, `!document.querySelector('[data-obj="mop-lips"]')`, 20000);
    await wait(300);
    out.toast = await page.eval(`document.querySelector('.toast')?.textContent ?? null`);
    out.after = Object.keys(studio.history.data.commits).length;
    out.head = studio.log('main', 1)[0];
    out.gone = !studio.mainDoc().objects['mop-lips'];
    out.errors = page.logs.filter((l) => l.level === 'error' && !/favicon|fonts\.g/.test(l.text)).map((l) => l.text).slice(0, 5);
    return out;
  });

  assert.ok(res.lips, 'the lips show on screen');
  assert.equal(res.lips.sel.object, 'mop-lips');
  assert.equal(res.lips.sel.part, 'lips', 'clicking the lips selects the lips');
  assert.equal(res.lips.tree, 'lips', 'the scene tree highlights the lips');
  assert.equal(res.studioLips?.part, 'lips', 'studio selection gets the part');
  assert.ok(res.strand, 'a mop strand shows on screen');
  assert.equal(res.strand.sel.part, res.strand.part, `clicking ${res.strand.part} selects it`);
  assert.equal(res.strand.tree, res.strand.part);
  assert.equal(res.studioStrand?.part, res.strand.part);
  assert.equal(res.block?.sel.object, 'block', 'a still object still picks');
  assert.equal(res.block?.sel.part, 'body');
  assert.ok(res.playing, 'a strand shows while it plays');
  assert.equal(res.playing.sel.part, res.playing.part, 'a moving strand is picked too');
  assert.equal(res.studioPlaying?.part, res.playing.part);
  assert.ok(res.studioPlaying?.clock, `the playing selection is a moment address: ${JSON.stringify(res.studioPlaying)}`);
  assert.equal(res.after, res.before + 1, 'Delete is one step');
  assert.ok(res.gone, 'the object is gone');
  assert.equal(res.head.author, 'human');
  assert.equal(res.head.tool, 'delete-object');
  assert.equal(res.toast, 'Deleted Mop Lips (whole object)');
  assert.deepEqual(res.errors, []);
  // undoable: one undo brings it back
  assert.ok(studio.call('undo', {}, 'human').ok);
  assert.ok(studio.mainDoc().objects['mop-lips'], 'undo brings it back');
});
