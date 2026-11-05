// Phase 10 step 3 (part A) checkpoint: the live view with (1) a look's sliders, a pointed-at spot and
// "show me three", (2) a chunk of Pocket Raleigh you click to fix (words → fix layer → steps, a
// landmark swap), (3) the UI kit over the scene on a phone and a desktop screen with live checks.
// Drives the real view in headless Chrome with real pointer and input events; saves screenshots.
//   STUDIO_PORT=4720 STUDIO_CHROME_PORT=9620 STUDIO_CHROME_SPAN=10 node bench/rest-a.ts [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/daemon/src/server.ts';
import { setWorldCacheDir } from '../packages/core/src/world/index.ts';
import { withPage, type Page } from '../packages/game/src/chrome.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-phase10', 'rest-a'));
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, 'apps/view/build.ts')], { stdio: 'ignore' });
const PORT0 = Number(process.env.STUDIO_PORT ?? 4720);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: any = { made: new Date().toISOString(), shots: [], scenes: {} };

async function scene(name: string, port: number, setup: (ok: (t: string, a: object, why?: string) => any, studio: any) => void, drive: (page: Page, studio: any, shot: (f: string) => Promise<void>) => Promise<any>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `studio-resta-${name}-`));
  process.env.STUDIO_HOME = path.join(dir, 'home');
  const { server, studio, url } = await startDaemon({ dir, port });
  // the offline cut of Pocket Raleigh's plaza blocks (27 buildings, from raleigh-city-plaza): a chunk, not the town
  setWorldCacheDir(path.join(ROOT, 'packages/core/test/fixtures/world'));
  const ok = (t: string, a: object, why?: string) => { const r = studio.call(t, a, 'claude', why ? { why } : {}); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
  setup(ok, studio);
  try {
    const r = await withPage(url, { width: 1440, height: 1000 }, async (page) => {
      await page.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#conn.live')) { clearInterval(t); r(true); } }, 100); })`, 60000);
      await wait(2500);
      const shot = async (f: string) => { const p = path.join(out, f); fs.writeFileSync(p, await page.screenshot()); report.shots.push(path.relative(ROOT, p)); };
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

/** Drag a slider: a few input events, then the release (change). */
const drag = (sel: string, values: number[]) => `(async () => { const el = document.querySelector('${sel}'); for (const v of ${JSON.stringify(values)}) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); } el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`;
/** A click on the viewport canvas at client px (pointerdown + pointerup, the view's own picking). */
const clickAt = (x: number, y: number) => `(() => { const c = document.querySelector('#viewport canvas'); const o = { clientX: ${x}, clientY: ${y}, bubbles: true, pointerId: 1, button: 0 }; c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()`;
const commits = (studio: any) => Object.keys(studio.history.data.commits).length;
const lastNote = (studio: any) => studio.history.data.commits[studio.history.data.mainHead].note;

// ── 1. looks with sliders ─────────────────────────────────────────────────────────────────────────
await scene('look', PORT0, (ok) => {
  ok('world-town', { name: 'Pocket Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  ok('look-new', { preset: 'day-toy' });
  ok('look-set', { set: { grade: { temperature: 0.1 } } });
}, async (page, studio, shot) => {
  await page.eval(`new Promise((r) => { const t = setInterval(() => { if (window.__studioView.townIds().length) { clearInterval(t); r(true); } }, 200); })`, 60000);
  await wait(1500);
  const n0 = commits(studio);
  await page.eval(drag('[data-knob="white-balance"]', [6000, 5800, 5600]));
  await wait(1500);
  const wb = { steps: commits(studio) - n0, note: lastNote(studio) };
  await page.eval(drag('[data-knob="fog"]', [0.2, 0.25, 0.3]));
  await wait(1500);
  await page.eval(drag('[data-knob="sun-elevation"]', [50, 38, 30]));
  await wait(2000);
  await shot('look-sliders.png');
  // point at a spot: "too dark here" pins on the building under it
  await page.eval(`document.querySelector('[data-act="look-point"]').click(); true`);
  await wait(300);
  const ids: string[] = await page.eval('window.__studioView.townIds()');
  const xy: [number, number] = await page.eval(`window.__studioView.townScreen(${JSON.stringify(ids[3])})`);
  await page.eval(clickAt(xy[0], xy[1] + 40));
  await wait(500);
  await shot('look-point-bubble.png');
  await page.eval(`document.querySelector('[data-act="look-note"][data-words="too dark here"]').click(); true`);
  await wait(1500);
  const note = studio.collab.notes.list({ status: 'all' }).at(-1);
  await shot('look-point-pinned.png');
  // show me three: three distinct grades side by side with a pick card
  await page.eval(`document.querySelector('[data-act="look-three"]').click(); true`);
  await page.eval(`new Promise((r) => { const t = setInterval(() => { const im = document.querySelectorAll('.lk-take img'); if (im.length === 3 && [...im].every((i) => i.src.startsWith('data:'))) { clearInterval(t); r(true); } }, 200); })`, 60000);
  await wait(800);
  await page.eval(`document.querySelector('.lk-three').scrollIntoView({ block: 'end' }); true`);
  await wait(300);
  await shot('look-three.png');
  const group = Object.values(studio.history.data.takes ?? {})[0] as any;
  return { whiteBalanceRelease: wb, fogNote: studio.history.data.commits[studio.history.data.commits[studio.history.data.mainHead].parent]?.note, sunNote: lastNote(studio), regionNote: { text: note?.text, thing: note?.address.thing, region: note?.region }, three: { takes: group?.takes.map((t: any) => t.label), distinct: group?.distinct?.pairs } };
});

// ── 2. towns: click to fix ───────────────────────────────────────────────────────────────────────
await scene('town', PORT0 + 1, (ok) => {
  ok('world-town', { name: 'Pocket Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  ok('look-new', { preset: 'day-toy' });
  // a landmark to swap in: a stepped tower with a lantern crown
  ok('new-object', { name: 'Lantern tower', type: 'tower', color: '#d8cdb8' });
  ok('add-op', { id: 'base', op: 'box', args: { size: [22, 30, 22], at: [0, 15, 0] } });
  ok('add-op', { id: 'mid', op: 'box', args: { size: [16, 22, 16], at: [0, 41, 0] } });
  ok('add-op', { id: 'crown', op: 'cylinder', args: { r: 5, h: 10, at: [0, 57, 0] } });
  ok('add-op', { id: 'tower', op: 'union', inputs: ['base', 'mid', 'crown'], output: true });
}, async (page, studio, shot) => {
  await page.eval(`new Promise((r) => { const t = setInterval(() => { if (window.__studioView.townIds().length) { clearInterval(t); r(true); } }, 200); })`, 60000);
  await wait(1500);
  const ids: string[] = await page.eval('window.__studioView.townIds()');
  // click buildings until one is selected (a roof point can sit behind a taller neighbour)
  let picked: string | null = null, tried = 0;
  for (const id of ids.slice(2, 14)) {
    tried++;
    const xy = await page.eval(`window.__studioView.townScreen(${JSON.stringify(id)})`);
    if (!xy) continue;
    await page.eval(clickAt(xy[0], xy[1]));
    await wait(700);
    picked = (await page.eval('window.__studioView.panelSelection()')).building;
    if (picked) break;
  }
  await wait(800);
  await shot('town-selected.png');
  const sel = studio.selection;
  const n0 = commits(studio);
  await page.eval(`(() => { const i = document.getElementById('townWords'); i.value = 'flat roof, two storeys taller'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="town-words"]:not([data-words])').click(); return true; })()`);
  await wait(2500);
  const wordsStep = { steps: commits(studio) - n0, note: lastNote(studio), fix: studio.doc().world.towns['Pocket Raleigh'].fixes.at(-1) };
  await page.eval(`document.querySelector('[data-act="town-words"][data-words="brick"]').click(); true`);
  await wait(2500);
  await shot('town-fixed.png');
  // swap in the landmark from the inspector
  await page.eval(`document.querySelector('[data-act="town-swap"]').click(); true`);
  await wait(3000);
  await shot('town-landmark.png');
  const fixes = studio.doc().world.towns['Pocket Raleigh'].fixes;
  return { clickedFirstTry: tried === 1, tried, picked, selection: sel && { object: sel.object, part: sel.part }, wordsStep, brickNote: studio.history.data.commits[studio.history.data.commits[studio.history.data.mainHead].parent]?.note, swapNote: lastNote(studio), fixLayer: fixes.map((f: any) => ({ id: f.id, set: f.set, model: f.model, note: f.note })) };
});

// ── 3. the UI kit over the scene ────────────────────────────────────────────────────────────────
await scene('ui', PORT0 + 2, (ok) => {
  ok('new-object', { name: 'Anvil', type: 'anvil', color: '#4a4d52', material: 'steel' });
  ok('add-op', { id: 'block', op: 'box', args: { size: [0.5, 0.25, 0.22], at: [0, 0.45, 0] } });
  ok('add-op', { id: 'foot', op: 'box', args: { size: [0.3, 0.33, 0.18], at: [0, 0.165, 0] } });
  ok('add-op', { id: 'anvil', op: 'union', inputs: ['block', 'foot'], output: true });
  ok('ui-kit', { preset: 'forge', profile: 'mobile' });
  ok('ui-icon', { names: ['tongs', 'charcoal', 'big-hammer', 'file', 'water-bucket'] });
}, async (page, studio, shot) => {
  await wait(1500);
  await page.eval(`document.querySelector('[data-ui-el="pump"]').click(); true`);
  await wait(800);
  const addr = studio.collab.address('selection');
  await shot('ui-mobile-selected.png');
  const n0 = commits(studio);
  await page.eval(drag('[data-uk="size"]', [30, 38, 44]));
  await wait(1500);
  const sizeStep = { steps: commits(studio) - n0, note: lastNote(studio) };
  const overflow = (studio.snapshot() as any).ui.checks.mobile.find((c: any) => c.id === 'ui-overflow');
  await shot('ui-mobile-overflow.png');
  // tap size: a small pump button fails on the phone, passes on the desktop screen
  await page.eval(drag('[data-uk="size"]', [26, 24]));
  await wait(1200);
  await page.eval(drag('[data-uk="w"]', [140, 100, 70]));
  await wait(1200);
  await page.eval(drag('[data-uk="h"]', [70]));
  await wait(1200);
  await page.eval(`document.querySelector('[data-act="ui-colour"][data-which="fill"][data-key="good"]').click(); true`);
  await wait(1500);
  await shot('ui-mobile-tap.png');
  await page.eval(`document.querySelector('[data-act="ui-profile"][data-p="desktop"]').click(); true`);
  await wait(800);
  await shot('ui-desktop.png');
  const ck = (studio.snapshot() as any).ui.checks;
  return { address: addr, sizeStep, overflowAtSize44: overflow, tap: { mobile: ck.mobile.find((c: any) => c.id === 'ui-tap'), desktop: ck.desktop.find((c: any) => c.id === 'ui-tap') }, notes: Object.values(studio.history.data.commits).map((c: any) => c.note).filter(Boolean) };
});

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
