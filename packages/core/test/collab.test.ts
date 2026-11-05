// Phase 10 shared core (decisions 61–64): moment addresses, steps for any asset, the notes inbox, the
// taste file and the "your call" card — proven on models, plus a look and a character action.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, emptyDoc } from '../src/index.ts';
import {
  TICKS, parseAddress, formatAddress, formatMoment, describeAddress, resolveAddress, checkAddress, secondsToTicks,
  timelineFor, clipTimeline, addressFor, Notes, parseTaste, formatTaste, addRule, rulesFromPicks, ruleFor, SEED_TASTE,
  makeCard, answerAsk, skipAsk, renderKey, RenderCache, FsIO, MemoryIO, distinctness, changedLeaves, stamp,
  type MomentAddress, type Pick, type TasteRule,
} from '../src/collab/index.ts';

before(async () => { await initKernel(); });

function stool(s: Studio) {
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33' });
  ok('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: 0 } });
  ok('add-op', { id: 'seat', op: 'box', args: { size: ['$seatW', '$seatT', '$seatW'], at: [0, '$seatH - $seatT/2', 0] } });
  ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', args: { r: '$legR', h: '($seatH - $seatT) / cos($legSplay)' }, output: false });
  ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' }, output: false });
  ok('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'], output: true });
  return ok;
}

/** A doc with a creature action (labelled keys, in seconds) and a kit character action (fractions). */
function actionDoc(notes: string[] = []) {
  const d: any = emptyDoc();
  d.objects.octopus = { id: 'octopus', name: 'Octopus', semanticType: 'creature', params: {}, ops: {}, opOrder: [], output: null, material: { name: 'x', color: '#fff' }, position: [0, 0, 0], rules: [],
    creature: { def: {}, motions: { 'pours-tea': { kind: 'action', action: { label: 'the octopus pours tea', notes, keys: [{ t: 0, label: 'start' }, { t: 1.2, label: 'grab the handle' }, { t: 1.5, label: 'grip' }, { t: 2.4, label: 'lift' }, { t: 3.2, label: 'pour' }] } } } } };
  d.objectOrder.push('octopus');
  return d;
}

// ── D61: addresses ───────────────────────────────────────────────────────────────────────────────

test('addresses: whole ticks at 24,000/s, the compact form round-trips, readable times per clock', () => {
  assert.equal(TICKS, 24000);
  assert.equal(secondsToTicks(1.4), 33600);
  const a = parseAddress('octopus@clip:pours-tea 2.4s+0.5s ~pour #abc');
  assert.deepEqual(a, { thing: 'octopus', clock: 'clip:pours-tea', at: 57600, len: 12000, near: 'pour', of: 'abc' });
  assert.deepEqual(parseAddress(formatAddress(a)), a);
  assert.deepEqual(parseAddress('stool/leg#2'), { thing: 'stool/leg#2', clock: 'none' });
  // every common frame rate lands on whole ticks
  for (const fps of [24, 25, 30, 48, 50, 60]) assert.ok(Number.isInteger(TICKS / fps), `${fps} fps`);
  assert.match(checkAddress({ thing: 'x', clock: 'clip:a', at: 1.5 } as any).join(), /whole ticks/);
  assert.match(checkAddress({ thing: 'x', clock: 'none', at: 10 }).join(), /timeless/);
  assert.match(checkAddress({ thing: 'x', clock: 'tape' as any }).join(), /clock/);
  assert.throws(() => parseAddress('run@game 10s'), /seed, build/);
  // readable: "1.4 s", "bar 9", "10:32", "shot 3"
  assert.equal(formatMoment({ thing: 'x', clock: 'clip:wave', at: 33600 }), '1.4 s');
  assert.equal(formatMoment({ thing: 'x', clock: 'beats:theme', at: secondsToTicks(16) }, { bpm: 120, beatsPerBar: 4 } as any), 'bar 9');
  assert.equal(formatMoment({ thing: 'x', clock: 'game', at: secondsToTicks(632), game: { seed: 7, build: 'a1' } }), '10:32');
  const shots = [{ id: 'a', at: 0, len: 48000 }, { id: 'b', at: 48000, len: 24000 }, { id: 'c', at: 72000, len: 48000 }];
  assert.equal(formatMoment({ thing: 'cutscene:intro', clock: 'shot:intro', at: 72000 }, { shots } as any), 'shot 3');
  assert.equal(describeAddress({ thing: 'stool/leg#2', clock: 'none' }, null, () => 'Walnut stool'), 'Walnut stool / leg#2');
});

test('addresses follow their named moment after re-timing ("slower"); unanchored ones go stale, never move silently', () => {
  const was = clipTimeline(actionDoc(), 'octopus', 'pours-tea')!;
  assert.equal(was.markers.pour.at, secondsToTicks(3.2));
  const notes = new Notes();
  const pinned = (a: MomentAddress) => notes.add('x', a, { basis: was });
  const anchored = pinned({ thing: 'octopus', clock: 'clip:pours-tea', at: secondsToTicks(3.4), near: 'pour', of: was.version });   // 0.2 s after the pour
  const bare = pinned({ thing: 'octopus', clock: 'clip:pours-tea', at: secondsToTicks(1.0), of: was.version });
  const atLift = pinned({ thing: 'octopus', clock: 'clip:pours-tea', at: secondsToTicks(2.4), near: 'lift', of: was.version });
  // "slower": tempo × 1.25, every key moves
  const slower = actionDoc(['slower']);
  const now = clipTimeline(slower, 'octopus', 'pours-tea')!;
  assert.equal(now.markers.pour.at, secondsToTicks(4.0));
  const r = notes.refresh((a) => timelineFor(slower, a.thing, a.clock));
  assert.deepEqual(r.moved.sort(), [anchored.id, atLift.id].sort());
  assert.deepEqual(r.stale, [bare.id]);
  assert.equal(notes.get(anchored.id).address.at, secondsToTicks(4.2), 'still 0.2 s after the pour');
  assert.equal(notes.get(atLift.id).address.at, secondsToTicks(3.0));
  assert.equal(notes.get(bare.id).status, 'stale');
  assert.match(notes.get(bare.id).log.at(-1)!.why!, /re-timed/);
  assert.match(notes.get(anchored.id).log.at(-1)!.why!, /followed "pour"/);
  // resolving again on the same clock changes nothing
  const again = notes.refresh((a) => timelineFor(slower, a.thing, a.clock));
  assert.deepEqual(again, { moved: [], stale: [] });
  // the named moment is gone (the key was relabelled) → stale, with the moments it has now
  const relabel = actionDoc(['slower']);
  relabel.objects.octopus.creature.motions['pours-tea'].action.keys[3].label = 'raise';
  notes.refresh((a) => timelineFor(relabel, a.thing, a.clock));
  assert.equal(notes.get(atLift.id).status, 'stale');
  assert.match(notes.get(atLift.id).log.at(-1)!.why!, /"lift" is gone/);
  // the whole clip is gone → stale
  const r2 = resolveAddress(notes.get(anchored.id).address, timelineFor(emptyDoc(), 'octopus', 'clip:pours-tea'));
  assert.equal(r2.status, 'stale');
  // the D61 tripwire counts it
  assert.ok(notes.staleRate().rate > 0.1);
});

test('kit character actions: "slower" stretches the clip; a moment picked by time snaps to the nearest key', () => {
  const d: any = emptyDoc();
  d.objects.kid = { id: 'kid', name: 'Kid', semanticType: 'character', params: {}, ops: {}, opOrder: [], output: null, material: { name: 'x', color: '#fff' }, position: [0, 0, 0], rules: [], character: { motions: { hi: { kind: 'action', action: 'wave' } } } };
  d.objectOrder.push('kid');
  const t1 = clipTimeline(d, 'kid', 'hi')!;
  const a = addressFor(d, { object: 'kid', clock: 'clip:hi', seconds: t1.markers['key 3'].at / TICKS + 0.1 });
  assert.equal(a.near, 'key 3');
  d.objects.kid.character.motions.hi.notes = ['slower'];
  const t2 = clipTimeline(d, 'kid', 'hi')!;
  assert.equal(t2.length, Math.round(t1.length * 1.25));
  const r = resolveAddress(a, t2, t1);
  assert.equal(r.status, 'moved');
  assert.equal(r.address.at, t2.markers['key 3'].at + (a.at! - t1.markers['key 3'].at));
});

test('model parts: selection makes a timeless address; removing the part makes the note stale', () => {
  const s = new Studio();
  stool(s);
  s.selection = { object: 'walnut-stool', part: 'seat', time: '' };
  const r = s.call('notes', { action: 'add', text: 'round the seat edge' });
  assert.ok(r.ok, r.error);
  const n = (r.result as any).note;
  assert.deepEqual(n.address.thing, 'walnut-stool/seat');
  assert.equal(n.address.clock, 'none');
  assert.equal((r.result as any).where, 'Walnut stool / seat');
  const legNote = s.call('notes', { action: 'add', text: 'legs too thin', at: 'walnut-stool/leg#1' });
  // a step on main that changes the seat: the notes follow the object (still there)
  s.call('set-param', { name: 'seatH', value: 0.44 });
  assert.equal(s.collab.notes.get(n.id).status, 'open');
  // the address tool resolves the selection too
  assert.equal((s.call('address').result as any).words, 'Walnut stool / seat');
  // rebuild the legs as one op: the part "leg#1" is gone → the note goes stale on the next change
  s.call('remove-op', { id: 'legs' });
  s.call('set-op', { id: 'stool', op: 'union', inputs: ['seat'] });
  const ln = s.collab.notes.get((legNote.result as any).note.id);
  assert.equal(ln.status, 'stale', JSON.stringify(ln.log));
  assert.equal(s.collab.notes.get(n.id).status, 'open');
});

// ── D62: steps for any asset ──────────────────────────────────────────────────────────────────────

test('steps carry their word note and a plain before/after; render cache keys follow the recipe, not history', async () => {
  const s = new Studio();
  stool(s);
  s.call('propose', { title: 'lower and warmer' });
  const r1 = s.call('set-param', { name: 'seatH', value: 0.42 }, 'claude', { why: 'lower' });
  assert.equal(s.history.commit(r1.commit!).note, 'lower');
  // a non-model asset on the same history: a look
  const r2 = s.call('look-new', { preset: 'day-toy' }, 'claude', { why: 'a look' });
  const r3 = s.call('look-set', { set: { grade: { temperature: 0.2 } } }, 'claude', { why: 'warmer' });
  assert.ok(r2.ok && r3.ok, r3.error);
  const info = s.proposalsInfo()[0];
  assert.deepEqual(info.steps.map((x: any) => x.note), ['lower', 'a look', 'warmer']);
  assert.deepEqual(info.steps[0].assets, ['walnut-stool']);
  assert.deepEqual(info.steps[2].assets, ['look:day-toy']);
  const ba: any = s.call('open-step', { step: 3 }).result;
  assert.equal(ba.assets[0].kind, 'look');
  assert.ok(ba.lines.some((l: string) => /grade\.temperature: 0\.06 → 0\.2/.test(l)), ba.lines.join('\n'));
  assert.notEqual(ba.before['look:day-toy'], ba.after['look:day-toy']);
  // render keys: same recipe → same key, whatever the history; a change → a new key; undo → the old key again
  const p = s.history.proposal();
  const lookNow = () => (s.history.proposalDoc(p) as any).look.looks['day-toy'];
  const k1 = renderKey(stamp(lookNow()), { view: 'hero' });
  assert.equal(renderKey(stamp(structuredClone(lookNow())), { view: 'hero' }), k1);
  s.call('look-set', { set: { grade: { temperature: 0.3 } } });
  const k2 = renderKey(stamp(lookNow()), { view: 'hero' });
  assert.notEqual(k2, k1);
  s.call('undo');
  assert.equal(renderKey(stamp(lookNow()), { view: 'hero' }), k1);
  assert.notEqual(renderKey(stamp(lookNow()), { view: 'front' }), k1, 'how it is rendered is part of the key');
  // the cache makes a render once per recipe; history never holds render bytes
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cache-'));
  const cache = new RenderCache(dir);
  let made = 0;
  const make = async () => { made++; return { 'hero.png': new Uint8Array([1, 2, 3]) }; };
  const a = await cache.through(k1, ['hero.png'], make), b = await cache.through(k1, ['hero.png'], make);
  assert.equal(made, 1);
  assert.equal(a.cached, false); assert.equal(b.cached, true);
  assert.ok(!JSON.stringify(s.history.data).includes('png'), 'no renders in history');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a character action as a step: "slower" is one step with its note, and its clip re-times', () => {
  const s = new Studio();
  const d = actionDoc();
  // put the creature action in via a step (any recipe change is a step)
  const r0 = s.call('undo');
  assert.equal(r0.ok, false);
  s.history.record('claude', 'seed', 'octopus', [{ path: ['objects', 'octopus'], before: undefined, after: d.objects.octopus }, { path: ['objectOrder'], before: [], after: ['octopus'] }]);
  s.call('propose', { title: 'slower pour' });
  const c = s.history.record('claude', 'action-note', 'Octopus "pours-tea": tempo ×1.25 (slower)', [{ path: ['objects', 'octopus', 'creature', 'motions', 'pours-tea', 'action', 'notes'], before: [], after: ['slower'] }]);
  c.note = 'slower';
  const ba = s.collab.openStep(s.history.proposal(), c.id);
  assert.equal(ba.assets[0].kind, 'creature');
  assert.equal(ba.assets[0].section, 'creature/motions/pours-tea');
  assert.ok(ba.lines.some((l) => /notes/.test(l)));
});

test('keep counts as reviewed only after the before/after was opened; the studio counts the rest', () => {
  const s = new Studio();
  stool(s);
  s.call('propose', { title: 'two changes' });
  s.call('set-param', { name: 'seatH', value: 0.42 });
  s.call('set-param', { name: 'legR', value: 0.02 });
  s.call('set-param', { name: 'seatW', value: 0.38 });
  s.call('open-step', { step: 1 });
  const k1: any = s.call('keep', { step: 1 }).result, k2: any = s.call('keep', { step: 2 }).result;
  assert.equal(k1.reviewed, true);
  assert.equal(k2.reviewed, false);
  assert.match(k2.hint, /open-step/);
  s.call('undo-step', { step: 3 });
  s.call('commit-proposal');
  const st: any = s.call('review-stats').result;
  assert.equal(st.steps.kept, 2);
  assert.equal(st.steps.keptWithoutOpening, 1);
  assert.equal(st.steps.tripwire, null, 'the tripwire waits for at least 10 kept steps');
  // the tripwire: 10+ kept, more than 9 in 10 unopened
  for (let i = 0; i < 2; i++) {
    s.call('propose', { title: `batch ${i}` });
    for (let j = 0; j < 6; j++) s.call('set-param', { name: 'seatH', value: 0.40 + i * 0.01 + j * 0.001 });
    s.call('commit-proposal');
  }
  const st2: any = s.call('review-stats').result;
  assert.equal(st2.steps.kept, 14);
  assert.equal(st2.steps.keptWithoutOpening, 13);
  assert.match(st2.steps.tripwire, /group them/);
});

test('show me three: takes too alike are refused; a pick commits one take whole and discards the others', () => {
  const s = new Studio();
  stool(s);
  const take = (label: string, name: string, value: number) => ({ label, calls: [{ tool: 'set-param', args: { name, value } }] });
  const bad = s.call('show-three', { title: 'Stool height', takes: [take('a', 'seatH', 0.46), take('b', 'seatH', 0.461), take('c', 'seatH', 0.6)] });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /too alike: a and b are only 0% apart/);
  assert.equal(Object.values(s.history.data.proposals).filter((p) => p.status === 'open').length, 0, 'refused takes are discarded');
  assert.equal(s.history.data.active, 'main');
  const r = s.call('show-three', { title: 'Stool legs', topic: 'stool-legs', takes: [
    { label: 'splayed', traits: ['splayed', 'light'], calls: [{ tool: 'set-param', args: { name: 'legSplay', value: 10 } }] },
    { label: 'thick', traits: ['thick', 'heavy'], calls: [{ tool: 'set-param', args: { name: 'legR', value: 0.03 } }] },
    { label: 'tall', traits: ['tall'], calls: [{ tool: 'set-param', args: { name: 'seatH', value: 0.65 } }] },
  ] });
  assert.ok(r.ok, r.error);
  const g: any = r.result;
  assert.equal(g.takes.length, 3);
  assert.ok(g.distinct.every((p: any) => p.distance >= 0.15));
  assert.ok(g.sections.length >= 3, 'compared per section');
  assert.ok(g.sections.some((x: any) => /param legSplay/.test(x.section)));
  const pick = s.call('pick-take', { group: g.group, take: 'splayed', why: 'reads lighter' });
  assert.ok(pick.ok, pick.error);
  const doc = s.mainDoc();
  assert.equal(doc.objects['walnut-stool'].params.legSplay.value, 10);
  assert.equal(doc.objects['walnut-stool'].params.legR.value, 0.016, 'the losing takes are never merged');
  assert.equal(doc.objects['walnut-stool'].params.seatH.value, 0.45);
  const statuses = g.takes.map((t: any) => s.history.data.proposals[t.proposal].status);
  assert.deepEqual(statuses, ['committed', 'discarded', 'discarded']);
  const picks = s.collab.picks();
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].chosen, { label: 'splayed', traits: ['splayed', 'light'] });
});

test('distinctness: numbers relative to their size, a take that changes nothing fails', () => {
  const base = { a: 1, b: 'x' };
  const takes = [{ label: 'p', leaves: changedLeaves(base, { a: 2, b: 'x' }) }, { label: 'q', leaves: changedLeaves(base, { a: 1, b: 'y' }) }, { label: 'r', leaves: changedLeaves(base, base) }];
  const d = distinctness(takes, (k) => (base as any)[k]);
  assert.equal(d.ok, false);
  assert.ok(d.tooAlike.some((x) => /r changes nothing/.test(x)));
  assert.equal(d.pairs.find((p) => p.a === 'p' && p.b === 'q')!.distance, 0.75);
});

// ── D63: notes and taste ────────────────────────────────────────────────────────────────────────

test('notes: open → on it → done; done can only reopen; stale notes re-pin and open again', () => {
  const n = new Notes();
  const a = n.add('too shiny', { thing: 'lamp', clock: 'none' });
  assert.equal(a.status, 'open');
  n.set(a.id, 'on-it');
  n.set(a.id, 'done');
  assert.throws(() => n.set(a.id, 'on-it'), /done: it can go to open/);
  n.set(a.id, 'open', 'came back');
  assert.deepEqual(a.log.map((l) => l.status), ['open', 'on-it', 'done', 'open']);
  n.set(a.id, 'stale', 'lamp deleted');
  n.repin(a.id, { thing: 'lamp-2', clock: 'none' });
  assert.equal(a.status, 'open');
  assert.match(a.log.at(-1)!.why!, /re-pinned \(was lamp\)/);
  assert.throws(() => n.add('  ', { thing: 'x', clock: 'none' }), /words/);
  assert.equal(n.list().length, 1);
  assert.equal(n.list({ status: 'done' }).length, 0);
});

test('notes persist per project in .studio/notes.json; taste is studio-wide (seeded) plus per project', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'));
  const s = new Studio();
  s.collab.setIO(new FsIO(proj, home));
  stool(s);
  s.call('notes', { action: 'add', text: 'check the splay', at: 'walnut-stool' });
  const saved = JSON.parse(fs.readFileSync(path.join(proj, '.studio', 'notes.json'), 'utf8'));
  assert.equal(saved.notes[0].text, 'check the splay');
  const rules: any = s.call('taste').result;
  assert.equal(rules.rules.length, 3, 'seeded with the known verdicts');
  assert.ok(rules.rules.some((r: any) => /CC0/.test(r.text) && r.source === 'you said, 5 Nov 2026'));
  assert.ok(fs.readFileSync(path.join(home, 'taste.md'), 'utf8').includes("The kid's smile"));
  const add = s.call('taste', { action: 'add', text: 'Lamps get heavy bases', said: true, topics: 'lamp-base=heavy' });
  assert.ok(add.ok, add.error);
  assert.match(fs.readFileSync(path.join(proj, '.studio', 'taste.md'), 'utf8'), /Lamps get heavy bases — you said, .* `lamp-base=heavy`/);
  assert.equal(s.call('taste', { action: 'add', text: 'guessing', topics: 'x' }).ok, false, 'a rule needs the user to have said it');
  // the project files are private: .studio is gitignored, and so is any taste.md / notes.json in the repo
  const gi = fs.readFileSync(path.resolve(import.meta.dirname, '../../../.gitignore'), 'utf8');
  assert.match(gi, /^\.studio\/$/m);
  assert.match(gi, /^taste\.md$/m);
  assert.match(gi, /^notes\.json$/m);
  fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
});

test('taste rules: only when said outright or from 3+ picks; the file round-trips in plain words', () => {
  const md = formatTaste(SEED_TASTE, 'studio');
  assert.deepEqual(parseTaste(md, 'studio'), SEED_TASTE);
  assert.throws(() => addRule([], { text: 'lean warm', source: { kind: 'picks', n: 2 }, topics: [], scope: 'project' }), /3\+ times \(have 2\)/);
  assert.throws(() => addRule([], { text: 'lean warm', source: { kind: 'other', text: 'I think' }, topics: [], scope: 'project' }), /needs a source/);
  assert.equal(addRule([], { text: 'lean warm', source: { kind: 'picks', n: 3 }, topics: [], scope: 'project' }).rules.length, 1);
  const pick = (chosen: string[], rejected: string[][]): Pick => ({ time: '', topic: 't', chosen: { label: chosen[0], traits: chosen }, rejected: rejected.map((r) => ({ label: r[0], traits: r })), from: 'three' });
  const two = [pick(['warm', 'soft'], [['cool'], ['neutral']]), pick(['warm'], [['cool'], ['grey']])];
  assert.deepEqual(rulesFromPicks(two), [], 'two picks are just picks');
  const three = [...two, pick(['warm', 'bright'], [['cool'], ['dark']])];
  const learned = rulesFromPicks(three);
  assert.equal(learned.length, 1);
  assert.match(learned[0].text, /Lean warm/);
  assert.deepEqual(learned[0].source, { kind: 'picks', n: 3 });
  // a trait you also passed over isn't a pattern
  assert.deepEqual(rulesFromPicks([...three, pick(['cool'], [['warm']])]).filter((r) => /warm/.test(r.text)), []);
  // logging picks through the studio adds the rule at the third, and says where it came from
  const s = new Studio();
  for (let i = 0; i < 2; i++) assert.deepEqual(s.collab.logPick(three[i]).learned, []);
  const third = s.collab.logPick(three[2]);
  assert.equal(third.learned.length, 1);
  assert.ok(s.collab.tasteRules().some((r) => r.source.kind === 'picks' && r.source.n === 3));
  // the 30-rule tripwire
  let rules: TasteRule[] = [];
  let warning: string | undefined;
  for (let i = 0; i < 31; i++) ({ rules, warning } = addRule(rules, { text: `rule ${i}`, source: { kind: 'said', date: 'today' }, topics: [], scope: 'project' }));
  assert.match(warning!, /Prune or merge/);
});

// ── D64: the card ───────────────────────────────────────────────────────────────────────────────

test('cards: "I checked" from the checks; asks the taste file answers are skipped and the card says it leaned on them', () => {
  const rules = [...SEED_TASTE];
  const checks = { stool: [{ id: 'w', label: 'Watertight solid', pass: true, detail: '' }, { id: 'g', label: 'All 4 legs grounded', pass: false, detail: 'leg#2 floats 4 mm' }] };
  const { card, toInbox } = makeCard({ proposal: 'p1', checks, rules, asks: [
    { kind: 'yesno', question: 'Is the smile right now?', topic: 'kid-smile' },
    { kind: 'pick', question: 'Which sound for the clink?', topic: 'sound-source', options: [{ label: 'CC0 clink' }, { label: 'generated clink' }] },
    { kind: 'pick', question: 'Which legs?', topic: 'stool-legs', options: [{ label: 'splayed' }, { label: 'straight' }] },
    { kind: 'play60', question: 'Play the forge for 60 s: does the rhythm hold?', playable: 'abc' },
    { kind: 'note', question: 'Anything feel off?' },
    { kind: 'yesno', question: 'Ship it?' },
  ] });
  assert.equal(card.checked.passed, 1);
  assert.equal(card.checked.failed, 1);
  assert.match(card.checked.lines[0], /✗ stool: All 4 legs grounded — leg#2 floats 4 mm/);
  assert.deepEqual(card.byTaste.map((b) => b.topic), ['kid-smile', 'sound-source']);
  assert.equal(card.byTaste[1].value, 'cc0-first');
  assert.equal(card.leansOn.length, 2);
  assert.match(card.leansOn[0], /per your taste file/);
  assert.equal(card.asks.length, 3, 'at most 3 asks');
  assert.deepEqual(card.asks.map((a) => a.kind), ['pick', 'play60', 'note']);
  assert.equal(toInbox.length, 1, 'the 4th ask waits in the inbox');
  assert.match(card.dropped[0].why, /cap/);
  // answers are validated per kind
  assert.equal(answerAsk(card, 'a1', '2').answer, 'straight');
  assert.throws(() => answerAsk(card, 'a1', 'curvy'), /isn't one of/);
  assert.equal(skipAsk(card, 'a3').status, 'skipped');
  assert.throws(() => skipAsk(card, 'a1'), /already answered/);
  assert.equal(ruleFor(rules, 'pac')!.value, 'keep');
});

test('cards on proposals: skipped asks go to the inbox, answers can become taste, play60 once per change, overnight never waits', () => {
  const s = new Studio();
  stool(s);
  s.call('propose', { title: 'legs' });
  s.call('set-param', { name: 'legSplay', value: 8 });
  const c = s.call('card', { asks: [
    { kind: 'pick', question: 'Which legs?', topic: 'stool-legs', options: [{ label: 'splayed', traits: ['splayed'] }, { label: 'straight', traits: ['straight'] }] },
    { kind: 'yesno', question: 'Seat height OK?', topic: 'seat-height' },
    { kind: 'play60', question: 'Sit-test in the game for 60 s', playable: 'r1' },
  ] });
  assert.ok(c.ok, c.error);
  const sk: any = s.call('skip-ask', { ask: 'a2' }).result;
  const note = s.collab.notes.get(sk.note.id);
  assert.match(note.text, /Your call \(skipped\): Seat height OK\?/);
  assert.equal(note.address.thing, 'walnut-stool');
  assert.equal(note.proposal, 'p1');
  const ans: any = s.call('answer', { ask: 'a1', answer: 'splayed', remember: true }).result;
  assert.ok(ans.rule, 'remembered as a taste rule');
  assert.equal(ans.rule.source.kind, 'said');
  assert.equal(s.collab.picks().length, 1, 'a pick answer is logged');
  // a new card on the same proposal: the taste file now answers the legs question; the play60 for the same change isn't asked again
  const c2: any = s.call('card', { asks: [
    { kind: 'pick', question: 'Which legs?', topic: 'stool-legs', options: [{ label: 'splayed' }, { label: 'straight' }] },
    { kind: 'play60', question: 'Sit-test in the game for 60 s', playable: 'r1' },
  ] }).result;
  assert.equal(c2.asks.length, 0);
  assert.equal(c2.byTaste[0].value, 'splayed');
  assert.match(c2.dropped[0].why, /already asked to play/);
  // overnight: nothing waits; guesses are marked and left in the inbox to check
  s.call('commit-proposal');
  s.call('propose', { title: 'overnight' });
  s.call('set-param', { name: 'seatW', value: 0.4 });
  const c3: any = s.call('card', { unattended: true, asks: [{ kind: 'yesno', question: 'Wider seat OK?', topic: 'seat-width', guess: 'yes' }] }).result;
  assert.equal(c3.unattended, true);
  assert.equal(c3.asks[0].status, 'guessed');
  assert.equal(c3.asks[0].answer, 'yes');
  assert.match(s.collab.notes.get(c3.asks[0].note).text, /My guess, check it: Wider seat OK\? → yes/);
  // the card rides on the proposal for the view
  assert.equal((s.snapshot() as any).proposals[0].card.asks[0].status, 'guessed');
});

test('review stats work on memory IO and report the four tripwires', () => {
  const s = new Studio();
  s.collab.setIO(new MemoryIO());
  const st: any = s.call('review-stats').result;
  assert.deepEqual(Object.keys(st).slice(0, 4), ['steps', 'notes', 'taste', 'asks']);
});
