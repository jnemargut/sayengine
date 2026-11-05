// Phase 10 checkpoint: the live view with working-together on — a proposal with word-note steps (a
// model and a look on one history), its "your call" card, notes pinned on parts (one gone stale), and
// the review counter. Renders the real view in headless Chrome and saves screenshots.
//   STUDIO_CHROME_PORT=9600 STUDIO_CHROME_SPAN=10 node bench/collab.ts [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../packages/daemon/src/server.ts';
import { withPage } from '../packages/game/src/chrome.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-phase10', 'core'));
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, 'apps/view/build.ts')], { stdio: 'ignore' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-collab-'));
process.env.STUDIO_HOME = path.join(dir, 'home');          // a private studio-wide taste file for the demo (seeded)
const port = Number(process.env.STUDIO_PORT ?? 4701);
const { server, studio, url } = await startDaemon({ dir, port });
const ok = (tool: string, args: object, author = 'claude', why?: string) => {
  const r = studio.call(tool, args, author, why ? { why } : {});
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r;
};

// a walnut stool with a footrest ring
ok('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33', material: 'walnut' });
ok('set-params', { values: { seatH: 0.62, seatT: 0.035, seatW: 0.36, legR: 0.018, legSplay: 0 } });
ok('add-op', { id: 'seat', op: 'roundedBox', args: { size: ['$seatW', '$seatT', '$seatW'], radius: 0.012, at: [0, '$seatH - $seatT/2', 0] } });
ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', args: { r: '$legR', h: '($seatH - $seatT) / cos($legSplay)' }, output: false });
ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' }, output: false });
ok('add-op', { id: 'rest', op: 'box', part: 'footrest', args: { size: [0.3, 0.02, 0.02], at: [0, 0.22, 0.13] }, output: false });
ok('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs', 'rest'], output: true });

// notes pinned by you in the view: one on the seat, one on the footrest (removed next: it goes stale)
studio.selection = { object: 'walnut-stool', part: 'seat', time: new Date().toISOString() };
ok('notes', { action: 'add', text: 'Seat edge feels sharp — round it more' }, 'human');
ok('notes', { action: 'add', text: 'Footrest too low for a counter', at: 'walnut-stool/footrest' }, 'human');
ok('notes', { action: 'add', text: 'Legs read a bit heavy', at: 'walnut-stool/leg#1' }, 'human');
ok('notes', { action: 'on-it', id: 'n3' });
ok('set-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'] }, 'claude', 'no footrest');
ok('remove-op', { id: 'rest' });

// a proposal: a word note per step, on a model and on a look (one history)
ok('propose', { title: 'Lighter legs, warmer light' });
ok('set-param', { name: 'legR', value: 0.013 }, 'claude', 'thinner legs');
ok('set-param', { name: 'seatH', value: 0.58 }, 'claude', 'a touch lower');
ok('look-new', { preset: 'day-toy' }, 'claude', 'warmer light');
ok('look-set', { set: { grade: { temperature: 0.16 } } }, 'claude', 'warmer');
ok('open-step', { step: 1 });
ok('keep', { step: 1 }, 'human');
const card = ok('card', { asks: [
  { kind: 'pick', question: 'Which legs read better from across the room?', topic: 'stool-legs', options: [{ label: '13 mm', traits: ['thin'] }, { label: '15 mm', traits: ['medium'] }, { label: '18 mm (as was)', traits: ['thick'] }] },
  { kind: 'yesno', question: 'Is the warmer light too orange on walnut?', topic: 'look-warmth' },
  { kind: 'note', question: 'Anything about the seat height?' },
  { kind: 'pick', question: 'Which sound for the stool scraping the floor?', topic: 'sound-source', options: [{ label: 'CC0 library' }, { label: 'generated' }] },
], leans: [] });
console.log('card:', JSON.stringify((card.result as any).byTaste));

const shots: string[] = [];
let cacheCheck: Record<string, boolean> = {};
const reveal = `(() => { const c = document.querySelector('.card'); if (c) c.scrollIntoView({ block: 'end' }); return true; })()`;
await withPage(url, { width: 1440, height: 1100 }, async (page) => {
  await page.eval(`new Promise((r) => { const t = setInterval(() => { if (document.querySelector('#conn.live') && document.querySelector('[data-focus="p1"]')) { clearInterval(t); r(true); } }, 100); })`, 60000);
  await page.eval(`document.querySelector('[data-focus="p1"]').click(); true`);
  await page.eval(`(() => { const el = document.querySelector('[data-obj="walnut-stool"][data-part="seat"]'); el && el.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 2500));
  await page.eval(reveal);
  await new Promise((r) => setTimeout(r, 300));
  const a = path.join(out, 'view-card-and-notes.png');
  fs.writeFileSync(a, await page.screenshot());
  shots.push(a);
  // open step 2's before/after: the viewport shows the before; the step is marked seen
  await page.eval(`document.querySelector('[data-act="open-step"][data-step="${(studio.proposalsInfo()[0].steps[1] as any).id}"]').click(); true`);
  await new Promise((r) => setTimeout(r, 2000));
  const b = path.join(out, 'view-before-after.png');
  fs.writeFileSync(b, await page.screenshot());
  shots.push(b);
  // answer one ask, skip another: the skipped one lands in the notes inbox
  await page.eval(`document.querySelector('[data-act="card-answer"][data-ask="a1"]').click(); true`);
  await new Promise((r) => setTimeout(r, 600));
  await page.eval(`document.querySelector('[data-act="card-skip"][data-ask="a2"]').click(); true`);
  await new Promise((r) => setTimeout(r, 2000));
  await page.eval(reveal);
  await new Promise((r) => setTimeout(r, 300));
  const c = path.join(out, 'view-answered-skipped.png');
  fs.writeFileSync(c, await page.screenshot());
  shots.push(c);
  // renders are caches keyed by the recipe: the second identical render comes from the cache
  const render = async () => (await (await fetch(`${url}/api/call`, { method: 'POST', body: JSON.stringify({ tool: 'render', args: { views: 'iso', proposal: 'p1' } }) })).json()) as any;
  const r1 = await render(), r2 = await render();
  cacheCheck = { first: !!r1.result?.cached, second: !!r2.result?.cached, sameKey: r1.result?.key === r2.result?.key, ok: r1.ok && r2.ok };
  const errs = page.logs.filter((l) => l.level === 'error' && !/favicon/.test(l.text));
  if (errs.length) console.log('view errors:', errs);
});

const stats = studio.collab.stats();
const report = {
  made: new Date().toISOString(), shots: shots.map((s) => path.relative(ROOT, s)), renderCache: cacheCheck,
  notes: studio.collab.notes.list({ status: 'all' }).map((n) => ({ id: n.id, status: n.status, text: n.text, thing: n.address.thing, why: n.log.at(-1)?.why })),
  card: studio.history.proposal('p1').card,
  stats: { steps: stats.steps, notes: stats.notes, taste: stats.taste, asks: stats.asks },
};
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: report.shots, renderCache: cacheCheck, notes: report.notes, stats: report.stats }, null, 2));
server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
