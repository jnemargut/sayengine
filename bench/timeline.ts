// Phase 10 step 2 checkpoint: everything that moves, on one timeline in the live view. The forge yard
// (bench/forge.ts) with sparks on the strike, a clink on the impact and the forge's roar; the view
// renders headless with the timeline dock: the smith's swing with its red failure stretch (a joint pops
// at the downswing), the sparks, the clink waveform, and a note pinned at a moment. Then a word note
// on the clip becomes a step (before/after), an effect slider becomes a labelled step, and the clink is
// "shown three" with the listen-and-pick ask. Frame time is measured on the GPU (Metal) with the clip,
// sparks and sound playing together. Writes screenshots, a short video and report.json.
//   STUDIO_PORT=4711 STUDIO_CHROME_PORT=9610 STUDIO_CHROME_SPAN=10 node bench/timeline.ts [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/daemon/src/server.ts';
import { withPage } from '../packages/game/src/chrome.ts';
import { captureFromView } from '../packages/daemon/src/viewcapture.ts';
import { buildForge } from './forge.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-phase10', 'timeline'));
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, 'apps/view/build.ts')], { stdio: 'ignore' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-timeline-'));
process.env.STUDIO_HOME = path.join(dir, 'home');
const port = Number(process.env.STUDIO_PORT ?? 4711);
const { server, studio, url } = await startDaemon({ dir, port });
const ok = (tool: string, args: object, author = 'claude', why?: string) => {
  const r = studio.call(tool, args, author, why ? { why } : {});
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

buildForge((t, a) => ok(t, a));
ok('add-effect', { id: 'sparks', preset: 'sparks', at: [-0.02, 0.78, -0.5], triggers: [{ on: 'Blacksmith:strike@impact', layer: 'burst' }] });
ok('add-effect', { id: 'forge-fire', preset: 'forge-fire', at: [-1.9, 0.76, -1.65], value: 'fire' });
ok('add-sound', { id: 'clink', kind: 'event', sound: 'clink', seed: 'strike-1', on: 'Blacksmith:strike@impact' });
ok('add-sound', { id: 'roar', kind: 'bed', sound: 'forge-roar', seed: 'yard', seconds: 6, gain: -10 });
// a note pinned by you at a moment: the hand, just after the impact
const impact = (studio.collab.address({ object: 'blacksmith', clock: 'clip:strike', near: 'impact' }) as any);
ok('notes', { action: 'add', text: 'Hand snaps too fast here — ease the downswing', at: { ...impact, thing: 'blacksmith/RightHand', at: impact.at + 1200 } }, 'human');

const shots: Record<string, string> = {};
const report: any = { made: new Date().toISOString() };
const shoot = async (page: any, name: string) => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, await page.screenshot()); shots[name] = path.relative(ROOT, f); };
const viewReady = `new Promise((r) => { const t = setInterval(() => { const tl = window.__timeline; if (document.querySelector('#conn.live') && tl && tl.ready() && tl.timeline() && tl.timeline().tracks.length) { clearInterval(t); r(true); } }, 100); })`;

await withPage(`${url}/?theme=light`, { width: 1440, height: 900 }, async (page) => {
  await page.eval(viewReady, 120000);
  const tl = await page.eval(`(() => { const t = window.__timeline.timeline(); return { length: t.length, tracks: t.tracks.map((x) => ({ id: x.id, label: x.label, clock: x.clock, markers: x.markers.length, error: x.error })) }; })()`);
  report.tracks = tl.tracks;
  const red = await page.eval(`window.__timeline.stretches()`);
  report.red = red.map((s: any) => ({ track: s.track, check: s.check, from: +(s.from / 24000).toFixed(3), to: +(s.to / 24000).toFixed(3) }));
  // 1. the swing at its red stretch, the hand selected: a full moment address on the clip clock
  await page.eval(`(() => { window.__timeline.select('motion:blacksmith'); return true; })()`);
  await page.eval(`(() => { const s = window.__timeline.stretches()[0]; window.__timeline.seek((s.from + s.to) / 2 / 24000); return true; })()`);
  await page.eval(`(() => { window.__timeline.frameOn('blacksmith', { show: ['anvil', 'stump'], dir: [0.2, 0.35, 1], fill: 0.55 }); return true; })()`);
  await sleep(600);
  await shoot(page, '01-swing-red-stretch');
  // 2. just after the impact: sparks in the air, the clink's waveform under the playhead, the pinned note
  await page.eval(`(() => { window.__timeline.seek(1.18); return true; })()`);
  await sleep(500);
  report.momentAtImpact = await page.eval(`window.__timeline.moment()`);
  await shoot(page, '02-impact-sparks-clink-note');
  // 3. the sparks track: its knobs as sliders; one release = one labelled step
  await page.eval(`(() => { window.__timeline.select('effect:sparks'); window.__timeline.seek(1.2); return true; })()`);
  await sleep(400);
  const side = await page.eval(`document.querySelector('.tl-side').innerText.slice(0, 300)`);
  if (!side.includes('Knobs')) console.log('side panel:', side, await page.eval(`JSON.stringify(window.__timeline.timeline().tracks.find((x) => x.id === 'effect:sparks').fx ? 'fx ok' : 'no fx')`));
  await page.eval(`(() => { const r = document.querySelector('[data-knob="1"]'); r.value = String(Number(r.value) * 1.3); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(1500);
  await shoot(page, '03-effect-sliders');
  report.sliderStep = studio.history.data.commits[studio.history.data.mainHead!]?.note;
  // 4. a word note on the clip becomes a step: before / after on the timeline
  await page.eval(`(() => { window.__timeline.select('motion:blacksmith'); return true; })()`);
  await sleep(300);
  await page.eval(`(() => { document.querySelector('[data-tl="word"][data-word="slower"]').click(); return true; })()`);
  await page.eval(`new Promise((r) => { const t = setInterval(() => { const b = document.querySelector('[data-focus="p1"]'); if (b) { clearInterval(t); b.click(); r(true); } }, 100); })`, 30000);
  await page.eval(`new Promise((r) => { const t = setInterval(() => { const tl = window.__timeline.timeline(); if (tl && tl.branch === 'p1') { clearInterval(t); r(true); } }, 100); })`, 120000);
  await sleep(800);
  await page.eval(`(() => { window.__timeline.select('motion:blacksmith'); window.__timeline.seek(1.35); return true; })()`);
  await sleep(600);
  await shoot(page, '04-word-note-step-after');
  await page.eval(`(() => { document.querySelector('[data-tl="before"]').click(); return true; })()`);
  await page.eval(`new Promise((r) => { const t = setInterval(() => { const tl = window.__timeline.timeline(); if (tl && tl.branch === 'main') { clearInterval(t); r(true); } }, 100); })`, 120000);
  await sleep(500);
  await page.eval(`(() => { window.__timeline.play(false); window.__timeline.seek(1.08); return true; })()`);
  await sleep(400);
  await shoot(page, '05-word-note-step-before');
  report.wordNote = { proposal: studio.history.proposal('p1').title, steps: studio.history.steps(studio.history.proposal('p1')).map((s: any) => ({ id: s.id, note: s.note, summary: s.summary })) };
  ok('discard-proposal', { proposal: 'p1' });
  await page.eval(`(() => { const b = document.querySelector('[data-focus="main"]'); b && b.click(); return true; })()`);
  await sleep(1200);
  // 5. show me three for the clink: three waveforms to listen to and a pick
  ok('sound-three', { id: 'clink' });
  await sleep(1500);
  await page.eval(`(() => { const b = document.querySelector('[data-focus="main"]'); b && b.click(); window.__timeline.play(false); window.__timeline.select('sound:clink'); window.__timeline.seek(1.1); return true; })()`);
  await page.eval(`new Promise((r) => { const t = setInterval(() => { window.__timeline.select('sound:clink'); if (document.querySelector('.tl-side').innerText.includes('Your call')) { clearInterval(t); r(true); } }, 500); })`, 60000).catch(() => console.log('no listen-and-pick ask in the dock'));
  await sleep(500);
  await shoot(page, '06-sound-show-three');
  report.three = (studio.snapshot() as any).takes.map((g: any) => ({ id: g.id, ask: g.ask }));
  const errs = page.logs.filter((l: any) => l.level === 'error' && !/favicon/.test(l.text));
  await page.eval(`(() => { window.__timeline.play(false); return true; })()`);
  report.viewErrors = errs.map((e: any) => e.text).slice(0, 10);
});

// frame time on the GPU (Metal): the forge playing the swing, sparks, fire and sound together
try {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${Number(process.env.STUDIO_CHROME_PORT ?? 9610) + 9}`] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  await page.waitForFunction(() => { const tl = (window as any).__timeline; return tl && tl.timeline() && tl.timeline().tracks.length; }, null, { timeout: 120000 });
  await page.evaluate(() => { const tl = (window as any).__timeline; tl.seek(0); tl.play(true); });
  await sleep(1500);
  await page.evaluate(() => (window as any).__timeline.resetStats());
  await sleep(6000);
  report.frameTime = await page.evaluate(() => (window as any).__timeline.stats());
  report.frameTime.renderer = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2') as any; const e = c?.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  await browser.close();
} catch (e: any) { report.frameTime = { error: e.message }; }

// a short video: frames of the real view (timeline dock included)
const cap = await captureFromView(url, path.join(out, 'video'), [{ id: 'forge', seconds: 3.8, focus: 'blacksmith', show: ['anvil', 'stump', 'forge'], dir: [0.2, 0.35, 1], fill: 0.6, select: { object: 'blacksmith', part: 'RightHand' } } as any], { width: 1100, height: 700, fps: 12, name: 'forge-timeline' });
if (cap.video) { fs.copyFileSync(cap.video, path.join(out, 'forge-timeline.mp4')); shots.video = path.relative(ROOT, path.join(out, 'forge-timeline.mp4')); }
fs.rmSync(path.join(out, 'video'), { recursive: true, force: true });

report.shots = shots;
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots, red: report.red?.slice(0, 3), frameTime: report.frameTime, sliderStep: report.sliderStep, wordNote: report.wordNote, viewErrors: report.viewErrors }, null, 2));
server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
