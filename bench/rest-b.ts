// Phase 10 step 3 (part B) checkpoint: (1) town life in the live view with a day clock on the dock —
// click a person, read their plan, redirect them in words ("go to the café at 9 instead": one step), the
// day checks re-run in the panel; (2) a trailer's shots on the timeline — the shot camera over the town,
// keep, redo one shot, "show me three" for a shot with thumbnails side by side and a pick.
// Drives the real view in headless Chrome with real pointer and input events; saves screenshots.
//   STUDIO_PORT=4730 STUDIO_CHROME_PORT=9630 STUDIO_CHROME_SPAN=10 node bench/rest-b.ts [outDir]
//   SCENES=reel node bench/rest-b.ts   (re-runs one scene; the report is merged)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/daemon/src/server.ts';
import { setWorldCacheDir } from '../packages/core/src/world/index.ts';
import { withPage, type Page } from '../packages/game/src/chrome.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-phase10', 'rest-b'));
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, 'apps/view/build.ts')], { stdio: 'ignore' });
const PORT0 = Number(process.env.STUDIO_PORT ?? 4730);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const only = process.env.SCENES?.split(',');
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')); } catch { return null; } })();
const report: any = only && prev ? { ...prev, made: new Date().toISOString() } : { made: new Date().toISOString(), shots: [], scenes: {} };

async function scene(name: string, port: number, setup: (ok: (t: string, a: object, why?: string) => any, studio: any) => void, drive: (page: Page, studio: any, shot: (f: string) => Promise<void>) => Promise<any>) {
  if (only && !only.includes(name)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `studio-restb-${name}-`));
  process.env.STUDIO_HOME = path.join(dir, 'home');
  const { server, studio, url } = await startDaemon({ dir, port });
  setWorldCacheDir(path.join(ROOT, 'packages/core/test/fixtures/world'));
  const ok = (t: string, a: object, why?: string) => { const r = studio.call(t, a, 'claude', why ? { why } : {}); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
  const t0 = Date.now();
  setup(ok, studio);
  console.log(`${name}: set up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  try {
    const r = await withPage(url, { width: 1440, height: 1000 }, async (page) => {
      await page.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#conn.live')) { clearInterval(t); r(true); } }, 100); })`, 60000);
      await wait(2500);
      const shot = async (f: string) => { const p = path.join(out, f); fs.writeFileSync(p, await page.screenshot()); const rel = path.relative(ROOT, p); if (!report.shots.includes(rel)) report.shots.push(rel); console.log(`  ${f}`); };
      const res = await drive(page, studio, shot);
      const errs = page.logs.filter((l) => l.level === 'error' && !/favicon|fonts\.g/.test(l.text));
      return { ...res, viewErrors: errs.map((e) => e.text).slice(0, 5) };
    });
    report.scenes[name] = r;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A click on the viewport canvas at client px (pointerdown + pointerup, the view's own picking). */
const clickAt = (x: number, y: number) => `(() => { const c = document.querySelector('#viewport canvas'); const o = { clientX: ${x}, clientY: ${y}, bubbles: true, pointerId: 1, button: 0 }; c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()`;
/** A press-drag-release on any element at client px (the dock's lanes and the day strip scrub this way). */
const dragOn = (sel: string, xs: number[], y: number) => `(async () => { const c = document.querySelector('${sel}'); const ev = (k, x) => c.dispatchEvent(new PointerEvent(k, { clientX: x, clientY: ${y}, bubbles: true, pointerId: 2, button: 0 })); ev('pointerdown', ${xs[0]}); for (const x of ${JSON.stringify(xs.slice(1))}) { await new Promise((r) => setTimeout(r, 60)); ev('pointermove', x); } ev('pointerup', ${xs.at(-1)}); return true; })()`;
const typeInto = (sel: string, text: string) => `(() => { const i = document.querySelector('${sel}'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const click = (sel: string) => `(() => { const b = document.querySelector('${sel}'); if (!b) return false; b.click(); return true; })()`;
const until = (cond: string, ms = 60000) => `new Promise((r, j) => { const t0 = Date.now(); const t = setInterval(() => { let v = false; try { v = ${cond}; } catch {} if (v) { clearInterval(t); r(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(t); r(false); } }, 200); })`;
const commits = (studio: any) => Object.keys(studio.history.data.commits).length;
const head = (studio: any) => studio.history.data.commits[studio.history.data.mainHead];

// the folk the town's day is drawn from (the life cast), parked out of the chunk, and two cars
function cast(ok: (t: string, a: object) => any) {
  const folk: Array<[string, string, Record<string, unknown>]> = [
    ['folk-ada', 'Ada', { preset: 'default', shirt: '#c8463a', trousers: '#2f3a4a' }],
    ['folk-dev', 'Dev', { preset: 'blacksmith', shirt: '#3f6b3a', trousers: '#4a4034' }],
    ['folk-esme', 'Esme', { shirt: '#9fc7d9', trousers: '#7a6a8a', hairColor: '#d9b56a' }],
    ['folk-faro', 'Faro', { shirt: '#e07a2a', trousers: '#2f3a4a', skin: '#6b4630' }],
  ];
  let x = -60;
  for (const [id, name, look] of folk) {
    ok('new-character', { id, name, position: [x, 0, -330], ...look });
    ok('set-motion', { object: id, id: 'walk', kind: 'walk', speed: 1.3 });
    ok('set-motion', { object: id, id: 'sit', kind: 'action', action: 'sit' });
    x += 6;
  }
  for (const [id, name, col] of [['car-red', 'Red Car', '#b8382c'], ['car-blue', 'Blue Car', '#2f6f9f']]) {
    ok('new-creature', { id, name, position: [x, 0, -345], parts: [
      { kind: 'body', shape: 'box', size: [1.78, 0.62, 4.25], height: 0.62, color: col },
      { kind: 'wheels', id: 'wheels', axles: [{ z: 1.32, track: 1.56, r: 0.33, w: 0.24 }, { z: -1.32, track: 1.56, r: 0.33, w: 0.24 }], ride: 0.3, travel: 0.08, hz: 1.5, damp: 0.55, color: '#23252a', hub: '#c9c2b4' },
    ], motions: { drive: { kind: 'drive', speed: 8 }, idle: { kind: 'still' } } });
    x += 6;
  }
}

// ── 1. town life with a day clock ────────────────────────────────────────────────────────────────
await scene('life', PORT0, (ok) => {
  ok('world-town', { name: 'Pocket Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  ok('look-new', { preset: 'day-toy' });
  cast(ok);
  ok('life-on', { folk: 24, cars: 3, day: 'saturday', start: 8.5 });
}, async (page, studio, shot) => {
  const loaded = await page.eval(until(`window.__studioView.life().on && window.__studioView.townIds().length && document.querySelector('.tl-day canvas')`, 90000), 95000);
  await wait(2500);
  const L0 = await page.eval('window.__studioView.life()');
  await shot('life-day-overview.png');
  // play the day at ×600 for a few seconds (the play button and speed chips on the dock's day strip)
  await page.eval(click('[data-day="speed"][data-speed="600"]'));
  await page.eval(click('[data-day="play"]'));
  await wait(5000);
  await page.eval(click('[data-day="play"]'));
  const L1 = await page.eval('window.__studioView.life()');
  // scrub the day strip back to 08:40 by dragging it
  const [sx, sy, sw, sh] = await page.eval('window.__studioView.lifeStrip()');
  const X = (hours: number) => sx + (hours / 24) * sw;
  await page.eval(dragOn('.tl-day canvas', [X(10), X(9.4), X(8.9), X(8 + 40 / 60)], sy + sh / 2));
  await wait(800);
  const L2 = await page.eval('window.__studioView.life()');
  // someone out now (not a friend tagging along): look at them, then click them
  const vis: number[] = await page.eval('window.__studioView.lifeVisible()');
  let picked: number | null = null, tries = 0;
  for (const i of vis.slice(0, 8)) {
    tries++;
    await page.eval(`window.__studioView.lifeFrame(${i}, 30)`);
    await wait(700);
    const xy = await page.eval(`window.__studioView.lifeScreen(${i})`);
    if (!xy) continue;
    await page.eval(clickAt(xy[0], xy[1]));
    await wait(900);
    picked = (await page.eval('window.__studioView.life()')).selected;
    if (picked !== null) break;
  }
  await wait(1200);
  await page.eval(`document.querySelector('.lf .tw-title')?.scrollIntoView({ block: 'start' }); true`);
  await wait(300);
  await shot('life-person.png');
  const sel = studio.selection;
  const addr = (() => { try { return studio.collab.address('selection'); } catch (e: any) { return { error: e.message }; } })();
  const who = picked !== null ? studio.call('life-person', { who: sel?.object }, 'claude').result : null;
  // redirect in words: type into the inspector and press Redirect (one step), the day checks re-run
  const n0 = commits(studio);
  await page.eval(typeInto('#lifeWords', 'go to the café at 9 instead'));
  await page.eval(click('[data-act="life-words"]:not([data-words])'));
  const done = await page.eval(until(`window.__studioView.life().checks && !window.__studioView.life().checking && window.__studioView.life().key !== ${JSON.stringify(L2.key)}`, 120000), 125000);
  await wait(1500);
  const step = { steps: commits(studio) - n0, note: head(studio).note, tool: head(studio).tool, changes: head(studio).changes.map((c: any) => c.path.join('.')) };
  const after = studio.call('life-person', { who: sel?.object }, 'claude').result;
  await page.eval(`document.querySelector('.lf .tw-row b#lifeNow')?.scrollIntoView({ block: 'start' }); true`);
  await wait(300);
  await shot('life-redirected.png');
  // the day strip at the café visit: they walk there and go in
  await page.eval(dragOn('.tl-day canvas', [X(8.7), X(8.9), X(9 + 1.5 / 60)], sy + sh / 2));
  await wait(1200);
  await page.eval(`window.__studioView.lifeFrame(${picked ?? 0}, 40)`);
  await wait(1200);
  await shot('life-walking-to-cafe.png');
  const L3 = await page.eval('window.__studioView.life()');
  const checks = L3.checks;
  return { loaded, people: L0.people, startedAt: L0.t, played: { from: L0.t, to: L1.t, seconds: 5, speed: 600 }, scrubbedTo: L2.t, clickedFirstTry: tries === 1, tries, picked, selection: sel && { object: sel.object, clock: sel.clock, seconds: sel.seconds, near: sel.near }, address: addr, person: who && { name: who.name, role: who.role, looksLike: who.looksLike, home: who.home, plan: who.plan }, redirect: { ...step, done, planAfter: after?.plan }, checks };
});

// ── 2. a trailer's shots on the timeline ──────────────────────────────────────────────────────────
await scene('reel', PORT0 + 1, (ok) => {
  ok('world-town', { name: 'Pocket Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  ok('look-new', { preset: 'day-toy' });
  // the trailer's day shots of the plaza blocks (the chunk the scene has); the night and river-twin shots need other towns
  ok('reel-import', { file: path.join(ROOT, 'games/pocket-raleigh/reel/trailer.json'), takes: ['day-street', 'day-plaza', 'day-aerial'] });
}, async (page, studio, shot) => {
  await page.eval(until(`window.__studioView.townIds().length && window.__timeline.ready() && window.__timeline.shots()`, 90000), 95000);
  await wait(1500);
  // select the shots track by clicking its label (the shot camera comes on), then drag the playhead into shot 1
  await page.eval(click('[data-track-row^="shots:"]'));
  await wait(500);
  const lanes = await page.eval(`(() => { const r = document.querySelector('.tl-lanes canvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const L = (await page.eval('window.__timeline.timeline().length')) / 24000;
  const at = (sec: number) => lanes[0] + (sec / L) * lanes[2];
  const y = lanes[1] + 18 + 11;
  await page.eval(dragOn('.tl-lanes', [at(0.5), at(1.2), at(1.9)], y));
  await wait(1500);
  await shot('reel-shot1.png');
  const n0 = commits(studio);
  await page.eval(click('[data-tl="shot-keep"]'));
  await wait(1500);
  const keep = { steps: commits(studio) - n0, note: head(studio).note, kept: studio.doc().reels.trailer.kept };
  // shot 2: redo (a new take of that shot only)
  await page.eval(dragOn('.tl-lanes', [at(4.5), at(5.4)], y));
  await wait(800);
  const before = JSON.parse(JSON.stringify(studio.doc().reels.trailer.reel));
  const n1 = commits(studio);
  await page.eval(click('[data-tl="shot-redo"]'));
  await page.eval(until(`window.__timeline.shots() && window.__timeline.shots().shots[1].take !== 'day-plaza'`, 30000), 32000);
  await wait(1500);
  const afterR = studio.doc().reels.trailer.reel;
  const redo = { steps: commits(studio) - n1, note: head(studio).note, summary: head(studio).summary, changes: head(studio).changes.map((c: any) => c.path.join('.')), otherShotsSame: afterR.edit.every((e: any, i: number) => i === 1 || JSON.stringify(e) === JSON.stringify(before.edit[i])), oldTakesSame: before.takes.every((t: any, i: number) => JSON.stringify(t) === JSON.stringify(afterR.takes[i])), newTake: afterR.edit[1].take };
  await shot('reel-redo.png');
  // shot 3: show me three (thumbnails side by side over the scene), then pick one
  await page.eval(dragOn('.tl-lanes', [at(8.6), at(9.4)], y));
  await wait(800);
  await page.eval(click('[data-tl="shot-three"]'));
  let thumbs = false;
  for (let k = 0; k < 40 && !thumbs; k++) {
    await wait(3000);
    try { thumbs = await page.eval(`document.querySelectorAll('.tl-three .img img').length === 3`, 20000); } catch (e: any) { console.log('  (the view is busy)', e.message); }
    if (process.env.DEBUG) console.log('  three?', k, await page.eval(`JSON.stringify({ three: !!document.querySelector('.tl-three'), imgs: document.querySelectorAll('.tl-three .img img').length, groups: Object.keys(window.__timeline.timeline() ?? {}).length })`, 20000).catch(() => 'busy'), Object.values(studio.history.data.takes ?? {}).map((x: any) => x.status));
  }
  await wait(1200);
  await shot('reel-three.png');
  const g: any = Object.values(studio.history.data.takes ?? {}).find((x: any) => x.reel);
  await page.eval(click('.tl-three .tk:nth-child(2) [data-tl3="pick"]'));
  await page.eval(until(`!document.querySelector('.tl-three')`, 30000), 32000);
  await wait(1500);
  const picks = studio.collab.picks();
  // play the cut through the shot cameras
  await page.eval(dragOn('.tl-lanes', [at(0.2)], y));
  await page.eval(click('[data-tl="play"]'));
  await wait(2500);
  await shot('reel-playing.png');
  await page.eval(click('[data-tl="play"]'));
  const exp = path.join(os.tmpdir(), `restb-trailer-${process.pid}.json`);
  const ex = studio.call('reel-export', { out: exp }, 'claude');
  const shotsNow = studio.call('reel-shots', {}, 'claude').result;
  fs.rmSync(exp, { force: true });
  return { keep, redo, three: { thumbnails: thumbs, takes: g?.takes.map((t: any) => t.label), distinct: g?.distinct?.pairs, cameraDistinct: g?.cameraDistinct, picked: g?.picked, status: g?.status, opened: g?.opened }, pickLogged: picks.at(-1), export: ex.ok ? { capture: ex.result.capture, cut: ex.result.cut } : ex.error, shots: shotsNow.shots };
});

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 6000));
process.exit(0);
