// Phase 10 step 3 (part B): town life in the view with a day clock (a person is a thing with a moment on
// the day clock; a redirect is one step and the headless day checks re-run), and trailers on the timeline
// (per-shot redo touches only that shot; per-shot "show me three" is distinct and its pick is logged).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio } from '../src/index.ts';
import { setWorldCacheDir } from '../src/world/index.ts';
import { sceneLife, personPlan, hoursFromWords, redirectFromWords, lifeForView } from '../src/life/view.ts';
import { parseAddress, formatAddress, formatMoment, resolveAddress } from '../src/collab/address.ts';
import { timelineFor } from '../src/collab/timelines.ts';
import { stepAssets } from '../src/collab/steps.ts';
import { redoTake, cameraDistance, reelCut, SHOT_MIN_DISTINCT } from '../src/reels.ts';
import { buildSceneTimeline } from '../src/collab/scenetimeline.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TRAILER = path.join(ROOT, 'games/pocket-raleigh/reel/trailer.json');
before(async () => { await initKernel(); setWorldCacheDir(path.join(HERE, 'fixtures', 'world')); });

const okCall = (s: Studio) => (t: string, a: object, author = 'claude', why?: string) => { const r = s.call(t, a, author, why ? { why } : {}); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
const commits = (s: Studio) => Object.keys(s.history.data.commits).length;
const head = (s: Studio) => s.history.data.commits[s.history.data.mainHead!];

let town: Studio | null = null;
function lifeStudio(): Studio {
  if (town) return town;
  const s = new Studio();
  const ok = okCall(s);
  ok('world-town', { name: 'Pocket Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  ok('new-character', { id: 'folk-ada', name: 'Ada', position: [0, 0, -330] });
  ok('set-motion', { object: 'folk-ada', id: 'walk', kind: 'walk', speed: 1.3 });
  ok('set-motion', { object: 'folk-ada', id: 'sit', kind: 'action', action: 'sit' });
  ok('life-on', { folk: 12, cars: 0 });
  town = s;
  return s;
}

// ── town life ────────────────────────────────────────────────────────────────────────────────────

test('life in the view: capped cast, one town, plans in words, the cast leaves the scene timeline', () => {
  const s = lifeStudio();
  const L = sceneLife(s.doc())!;
  assert.ok(L.bake.stats.folk <= 12 + 6, `folk ${L.bake.stats.folk} (12 + friends)`);
  const v = lifeForView(s.doc())!;
  assert.equal(v.people.length, L.bake.data.agents.length);
  const p = v.people.find((x) => x.kind === 'person' && x.stops.some((st) => st.kind === 'stop'))!;
  assert.ok(p.stops[0].kind === 'out' && p.stops.at(-1)!.kind === 'home', JSON.stringify(p.stops.map((x) => x.kind)));
  assert.ok(p.info.name && p.info.role && p.info.looksLike === 'Ada', JSON.stringify(p.info));
  // the life cast plays in the town on the day clock, not as a clip on the scene timeline
  const tl = buildSceneTimeline(s, s.doc()).timeline;
  assert.ok(!tl.tracks.some((t) => t.object === 'folk-ada'), 'Ada is the cast, not a motion track');
  assert.equal(s.snapshot().life?.redirects, 0);
});

test('a person is a thing with a moment on the day clock, anchored to the stop it falls in', () => {
  const s = lifeStudio();
  const L = sceneLife(s.doc())!;
  const i = L.bake.data.agents.findIndex((a, k) => a.kind === 'person' && a.owner === undefined && personPlan(L, k).some((x) => x.kind === 'stop'));
  const id = L.bake.data.agents[i].id;
  const stop = personPlan(L, i).find((x) => x.kind === 'stop')!;
  const mid = Math.round((stop.from + stop.to) / 2);
  // what the view sends when a person is clicked at a time of day
  s.selection = { object: `person:${id}`, part: null, clock: 'day', seconds: mid } as any;
  const a = s.collab.address('selection');
  assert.equal(a.thing, `person:${id}`);
  assert.equal(a.clock, 'day');
  assert.equal(a.at, mid * 24000, 'whole ticks at 24,000 a second');
  assert.equal(a.near, stop.name, 'anchored to the stop they are at');
  assert.ok(a.of && a.of !== 'gone');
  const words = s.collab.describe(a);
  assert.match(words, new RegExp(`${L.names[i]} \\(${id}\\) · day · "${stop.name.replace(/[()]/g, '\\$&')}" · \\d\\d:\\d\\d`));
  assert.match(formatMoment(a), /^\d\d:\d\d$/);
  // the compact form round-trips, and a time of day can be typed as 09:30
  assert.deepEqual(parseAddress(formatAddress(a)), a);
  assert.equal(parseAddress(`person:${id}@day 09:30`).at, 9.5 * 3600 * 24000);
  // the day clock: the person's stops are its named moments
  const t = timelineFor(s.doc(), `person:${id}`, 'day')!;
  assert.equal(t.length, 86400 * 24000);
  assert.ok(t.markers[stop.name], Object.keys(t.markers).join(', '));
  // a note on them follows the stop when the plan around it moves; a gone person goes stale
  const gone = resolveAddress({ ...a, thing: 'person:nobody-1' }, timelineFor(s.doc(), 'person:nobody-1', 'day'));
  assert.equal(gone.status, 'stale');
  // words → a time and a place
  assert.equal(hoursFromWords('go to the café at 9 instead'), 9);
  assert.equal(hoursFromWords('at 3pm'), 15);
  assert.equal(hoursFromWords('at 14:30'), 14.5);
  const r = redirectFromWords(L, i, 'go to the café at 9 instead');
  assert.equal(L.places.get(r.place)!.kind, 'door');
  assert.equal(L.places.get(r.place)!.use, 'shop', 'a café is a shop door');
  assert.throws(() => redirectFromWords(L, i, 'go somewhere nice'), /time/);
});

test('redirect → one step with its word note; nobody else\'s day moves; the day checks re-run', () => {
  const s = lifeStudio();
  const L0 = sceneLife(s.doc())!;
  const i = L0.bake.data.agents.findIndex((a, k) => a.kind === 'person' && a.owner === undefined && personPlan(L0, k).some((x) => x.kind === 'stop'));
  const id = L0.bake.data.agents[i].id;
  const plans0 = L0.bake.data.agents.map((a) => JSON.stringify(a.plan));
  const n0 = commits(s);
  const r = okCall(s)('life-redirect', { who: `person:${id}`, words: 'go to the café at 9 instead' }, 'human');
  assert.equal(commits(s), n0 + 1, 'one redirect = one step');
  const c = head(s);
  assert.equal(c.note, 'go to the café at 9 instead', 'the step carries the words as its note');
  assert.equal(c.tool, 'life-redirect');
  assert.deepEqual(stepAssets(c, s.doc()).map((x) => x.thing), [`person:${id}`], 'the step points at the person');
  const res: any = r.result;
  assert.ok(res.after.some((l: string) => /^09:0\d–09:\d\d goes into Shop /.test(l)), res.after.join(' | '));
  assert.ok(!res.before.some((l: string) => /^09:0\d–09:\d\d goes into Shop /.test(l)));
  // the headless day ran again on the new plan (all 13 checks), and its report is what the view shows
  assert.equal(res.checks.length, 13);
  assert.ok(res.checks.every((k: any) => typeof k.pass === 'boolean'));
  assert.deepEqual(res.failing, res.checks.filter((k: any) => !k.pass).map((k: any) => k.name));
  const L1 = sceneLife(s.doc())!;
  assert.notEqual(L1.key, L0.key, 'a new bake');
  assert.ok(L1.day, 'the day checks are kept with the new bake (the view reads them)');
  // only the redirected person's plan changed (their friend or dog follows them; nobody else moves)
  L1.bake.data.agents.forEach((a, k) => { if (k !== i) assert.equal(JSON.stringify(a.plan), plans0[k], `${a.id}'s day is untouched`); });
  assert.notEqual(JSON.stringify(L1.bake.data.agents[i].plan), plans0[i]);
  // and back again: one more step, the old day returns
  okCall(s)('life-redirect', { who: id, undo: true }, 'human', 'back to their own day');
  assert.equal(JSON.stringify(sceneLife(s.doc())!.bake.data.agents[i].plan), plans0[i]);
});

// ── trailers ─────────────────────────────────────────────────────────────────────────────────────

function reelStudio() {
  const s = new Studio();
  const ok = okCall(s);
  ok('reel-import', { file: TRAILER, takes: ['day-street', 'day-plaza', 'day-aerial'] });
  return s;
}

test('trailer shots on a shots track with beat marks; the shot clock is addressable', () => {
  const s = reelStudio();
  const tl = buildSceneTimeline(s, s.doc()).timeline;
  const tr = tl.tracks.find((t) => t.system === 'shots')!;
  assert.ok(tr, 'a shots track');
  const shots = tr.markers.filter((m) => m.kind === 'shot');
  assert.deepEqual(shots.map((m) => m.name), ['1 day-street', '2 day-plaza', '3 day-aerial', 'end card']);
  assert.ok(tr.markers.filter((m) => m.kind === 'beat' || m.kind === 'bar').length >= 28, 'beat marks');
  // every cut lands on a beat of the grid
  const beats = new Set(tr.markers.filter((m) => m.kind === 'beat' || m.kind === 'bar').map((m) => m.at));
  for (const m of shots.slice(1)) assert.ok(beats.has(m.at), `${m.name} on a beat`);
  assert.equal(tl.length, tr.length, 'the master timeline is the cut');
  assert.ok(tr.reel!.mid[2].position.length === 3);
  const t = timelineFor(s.doc(), 'reel:trailer', 'shot:trailer')!;
  assert.deepEqual(Object.keys(t.markers), ['shot 1', 'shot 2', 'shot 3', 'end card']);
  assert.equal(formatMoment({ thing: 'reel:trailer', clock: 'shot:trailer', at: t.markers['shot 2'].at + 12000 }, t), 'shot 2 +0.5 s');
});

test('per-shot redo makes a new take of that shot only (one step); keep marks it', () => {
  const s = reelStudio();
  const ok = okCall(s);
  const before = structuredClone((s.doc() as any).reels.trailer.reel);
  const n0 = commits(s);
  ok('reel-keep', { shot: 1 }, 'human', 'keep shot 1');
  ok('reel-redo', { shot: 2, style: 'orbit' }, 'human', 'redo shot 2');
  assert.equal(commits(s), n0 + 2, 'keep and redo: a step each');
  const c = head(s);
  assert.equal(c.note, 'redo shot 2');
  // the step's changes are all about shot 2: its new take, its edit entry, where the take came from
  assert.deepEqual(c.changes.map((x) => x.path.join('.')).sort(), ['reels.trailer.made.day-plaza-orbit', 'reels.trailer.reel.edit.1.take', 'reels.trailer.reel.takes.3']);
  const after = (s.doc() as any).reels.trailer;
  after.reel.edit.forEach((e: any, i: number) => { if (i !== 1) assert.deepEqual(e, before.edit[i], `shot ${i + 1} untouched`); });
  before.takes.forEach((t: any, i: number) => assert.deepEqual(after.reel.takes[i], t, `take ${t.id} untouched`));
  assert.equal(after.reel.edit[1].take, 'day-plaza-orbit');
  assert.deepEqual(after.kept, [1], 'shot 1 stays kept');
  assert.equal(stepAssets(c, s.doc())[0].thing, 'reel:trailer');
  // the cut is the same length (the redo keeps the shot's beats)
  assert.equal(reelCut(after.reel).duration, reelCut(before).duration);
  // the new take is a different camera move on the same subject
  const old = before.takes.find((t: any) => t.id === 'day-plaza'), fresh = after.reel.takes.find((t: any) => t.id === 'day-plaza-orbit');
  assert.ok(cameraDistance(old, fresh) >= SHOT_MIN_DISTINCT, `${cameraDistance(old, fresh)}`);
  // a redo of a kept shot un-keeps it
  ok('reel-redo', { shot: 1 }, 'human');
  assert.deepEqual((s.doc() as any).reels.trailer.kept, []);
});

test('per-shot "show me three": three distinct camera takes, compared, the pick committed whole and logged', () => {
  const s = reelStudio();
  const ok = okCall(s);
  const before = structuredClone((s.doc() as any).reels.trailer.reel);
  const r: any = ok('reel-three', { shot: 3 }).result;
  assert.equal(r.takes.length, 3);
  for (const p of r.cameraDistinct) assert.ok(p.distance >= SHOT_MIN_DISTINCT, `${p.a}/${p.b} ${p.distance}`);
  for (const p of r.distinct) assert.ok(p.distance >= SHOT_MIN_DISTINCT);
  const g = (s.history.data as any).takes[r.group];
  assert.deepEqual(g.reel, { id: 'trailer', shot: 3 });
  assert.equal((s.doc() as any).reels.trailer.reel.edit[2].take, 'day-aerial', 'main is untouched until a pick');
  // too alike is refused (the same move twice)
  const s2 = reelStudio();
  const bad = s2.call('reel-three', { shot: 3, styles: ['orbit', 'orbit', 'push'] }, 'claude');
  assert.ok(!bad.ok && /too alike/.test(bad.error!), bad.error);
  // pick the push in: committed whole, the other two discarded, the pick logged
  const picks0 = s.collab.picks().length;
  ok('pick-take', { group: r.group, take: 'a push in' }, 'human');
  const after = (s.doc() as any).reels.trailer;
  assert.match(after.reel.edit[2].take, /^day-aerial-push/);
  after.reel.edit.forEach((e: any, i: number) => { if (i !== 2) assert.deepEqual(e, before.edit[i]); });
  assert.equal(g.status, 'picked');
  for (const t of g.takes) if (t.label !== 'a push in') assert.equal(s.history.data.proposals[t.proposal].status, 'discarded');
  const log = s.collab.picks();
  assert.equal(log.length, picks0 + 1);
  assert.equal(log.at(-1)!.topic, 'reel-shot');
  assert.deepEqual(log.at(-1)!.chosen.traits, ['push']);
  assert.deepEqual(log.at(-1)!.rejected.map((x: any) => x.traits[0]).sort(), ['crane', 'orbit']);
  // a redo style of a take made from a redo starts again from the original take
  const t2 = redoTake(after.reel.takes.find((t: any) => t.id === 'day-aerial'), 'crane', 'x');
  assert.equal(t2.keys.length, 3);
});
