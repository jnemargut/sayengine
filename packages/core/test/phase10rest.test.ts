// Phase 10 step 3 (part A): looks with sliders, towns you click to fix, the UI kit live in the view.
// Slider release → one labelled step; building click → stable id → fix-layer entry (also from words);
// UI element selection → an address; the UI checks update as tokens change.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio } from '../src/index.ts';
import { PRESETS, parseLook } from '../src/look/look.ts';
import { LOOK_KNOBS, knobStep, turnKnob, knobsFor, lookTakes, tempToKelvin, kelvinToTemp, kelvinToHex, hexToKelvin, fogDensity } from '../src/look/knobs.ts';
import { activeLook } from '../src/look/tools.ts';
import { setWorldCacheDir, buildTown, fixFromWords, townView, townsForState } from '../src/world/index.ts';
import { uiChecks, FORGE_LAYOUT, FORGE_TOKENS, type UiKit } from '../src/uikit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
before(async () => { await initKernel(); setWorldCacheDir(path.join(HERE, 'fixtures', 'world')); });

const okCall = (s: Studio) => (t: string, a: object, author = 'claude', why?: string) => { const r = s.call(t, a, author, why ? { why } : {}); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
const steps = (s: Studio) => Object.keys(s.history.data.commits);

// ── looks ────────────────────────────────────────────────────────────────────────────────────────

test('look knobs speak Kelvin, stops and percent, and round-trip the record', () => {
  assert.equal(tempToKelvin(0.1), 6200);
  assert.equal(tempToKelvin(0.3), 5600);
  assert.equal(kelvinToTemp(5600), 0.3);
  // sun colours: warm low Kelvin is orange, high is blue-white, and reading one back lands near it
  for (const k of [2700, 4000, 5500, 6500, 9000]) assert.ok(Math.abs(hexToKelvin(kelvinToHex(k)) - k) <= 300, `${k} K`);
  const night = PRESETS['neon-night'];
  assert.ok(knobsFor(night).some((k) => k.id === 'lamps') && knobsFor(night).some((k) => k.id === 'glow'), 'a night look has lamp and glow knobs');
  assert.ok(!knobsFor(PRESETS['studio-neutral']).some((k) => k.id === 'lamps'), 'no lamp knob without lamps');
  // turning a knob and reading it back gives the same value (within its step)
  for (const k of LOOK_KNOBS) {
    if (k.applies && !k.applies(night)) continue;
    const v = k.min + (k.max - k.min) * 0.37;
    const back = k.get(turnKnob(night, k.id, v));
    assert.ok(Math.abs(back - v) <= Math.max(k.step, k.id === 'sun-colour' ? 300 : k.id === 'fog' ? 0.02 : 0), `${k.id}: ${v} → ${back}`);
  }
  const thick = turnKnob(PRESETS['day-toy'], 'fog', 0.8);
  assert.ok(fogDensity(thick) > 0.75 && thick.fog.end < 400, `thick fog ends at ${thick.fog.end} m`);
});

test('slider release → one labelled step ("warmer: white balance 6200 K → 5600 K"); dragging changes nothing', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('look-new', { preset: 'day-toy' });
  ok('look-set', { set: { grade: { temperature: 0.1 } } });
  const before = steps(s).length;
  const look = activeLook(s.doc())!;
  // dragging: previews are computed in the view from the record, nothing reaches history
  for (const k of [6000, 5800, 5650]) turnKnob(look, 'white-balance', k);
  assert.equal(steps(s).length, before, 'a drag makes no steps');
  const st = knobStep(look, 'white-balance', 5600)!;
  assert.equal(st.why, 'warmer: white balance 6200 K → 5600 K');
  ok('look-set', { set: st.set }, 'human', st.why);
  const log = steps(s);
  assert.equal(log.length, before + 1, 'one release = one step');
  const c = s.history.data.commits[s.history.data.mainHead!];
  assert.equal(c.note, 'warmer: white balance 6200 K → 5600 K', 'the step carries its word note');
  assert.equal(activeLook(s.doc())!.grade.temperature, 0.3);
  assert.equal(knobStep(activeLook(s.doc())!, 'white-balance', 5610), null, 'a release that changes nothing visible is no step');
  assert.match(knobStep(look, 'fog', 0.6)!.why, /^thicker fog: fog density \d+% → 60%$/);
  assert.match(knobStep(PRESETS['neon-night'], 'lamps', 3)!.why, /^lamps dimmer: lamp strength 7 → 3$/);
  assert.match(knobStep(look, 'exposure', -0.5)!.why, /^darker: exposure \+0\.1 EV → −0\.5 EV$/);
});

test('pointing at a region pins a note on the thing under it, with the spot and the look', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('new-object', { name: 'Crate', type: 'box', color: '#8a6a4a' });
  ok('add-op', { id: 'body', op: 'box', args: { size: [0.4, 0.4, 0.4], at: [0, 0.2, 0] } });
  ok('look-new', { preset: 'neon-night' });
  const r = ok('notes', { action: 'add', text: 'too dark here', at: { thing: 'crate/body', clock: 'none' }, region: { look: 'neon-night', point: [0.1, 0.3, 0.2], screen: [0.42, 0.58] } }, 'human');
  const n = (r.result as any).note;
  assert.equal(n.address.thing, 'crate/body');
  assert.deepEqual(n.region, { look: 'neon-night', point: [0.1, 0.3, 0.2], screen: [0.42, 0.58] });
  const v = s.collab.notesForView().find((x: any) => x.id === n.id)!;
  assert.equal((v as any).region.look, 'neon-night');
  assert.equal(v.where, 'Crate / body');
});

test('"show me three" on a look: three distinct grades, picked whole', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('look-new', { preset: 'day-toy' });
  const takes = lookTakes(activeLook(s.doc())!);
  assert.equal(new Set(takes.map((t) => t.label)).size, 3);
  const r = ok('show-three', { title: 'Day toy grade', topic: 'look-grade', takes });
  const g = (r.result as any);
  assert.equal(g.takes.length, 3);
  assert.ok(Math.min(...g.distinct.map((p: any) => p.distance)) >= 0.15, 'takes are at least 15% apart');
  // each take's look rides on its proposal in the view's state
  const snap: any = s.snapshot();
  const looks = snap.proposals.map((p: any) => p.look?.grade.temperature);
  assert.equal(new Set(looks).size, 3, 'three different looks to compare side by side');
  ok('pick-take', { group: g.group, take: 'cool and crisp' }, 'human');
  assert.ok(activeLook(s.doc())!.grade.temperature < PRESETS['day-toy'].grade.temperature, 'the cool take is on main');
});

// ── towns ────────────────────────────────────────────────────────────────────────────────────────

test('word notes on a building read into a fix ("flat roof", "two storeys taller", "brick")', () => {
  const b = { floors: 4, height: 15, roof: 'gable' as const, use: 'office' as const };
  assert.deepEqual(fixFromWords('flat roof', b).set, { roof: 'flat' });
  assert.deepEqual(fixFromWords('two storeys taller', b).set, { floors: 6 });
  assert.deepEqual(fixFromWords('one floor shorter', b).set, { floors: 3 });
  assert.equal(fixFromWords('brick', b).set.wall, '#9c4f3e');
  assert.equal(fixFromWords('red brick walls, flat roof', b).set.wall, '#a8503c');
  assert.deepEqual(fixFromWords('five storeys', b).set, { floors: 5 });
  assert.equal(fixFromWords('it should be a hotel', b).set.use, 'hotel');
  assert.equal(fixFromWords('hide it', b).hide, true);
  assert.equal(fixFromWords('taller', b).set.floors, 5);
  assert.throws(() => fixFromWords('make it nicer', b), /didn't catch/);
});

test('a building click → its stable id → a fix-layer entry and one step; no ids typed', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
  // the view loads one chunk, one mesh per building, each mesh carrying its building's stable id
  const tv = townView(s.doc().world!.towns['Mini Raleigh'], s.doc().world, {}, { radius: 80, maxBuildings: 12 });
  assert.ok(tv.chunk.buildings <= 12 && tv.chunk.buildings > 0, `${tv.chunk.buildings} buildings in the chunk`);
  const meshes = tv.nodes.filter((n) => n.worldId);
  assert.equal(meshes.length, tv.chunk.buildings, 'one pickable mesh per building');
  const clicked = meshes[0].worldId!;
  const info = tv.buildings.find((b) => b.id === clicked)!;
  assert.ok(info.height > 0 && info.floors > 0 && info.roof && info.use && /Overture/.test(info.source), JSON.stringify(info));
  // the click becomes the selection, and the selection an address on the building
  s.selection = { object: 'town:Mini Raleigh', part: clicked, time: new Date().toISOString() };
  const addr = s.collab.address('selection');
  assert.equal(addr.thing, `town:Mini Raleigh/${clicked}`);
  assert.equal(s.collab.describe(addr), `Mini Raleigh / ${clicked}`);
  // a word note from the inspector becomes a fix entry keyed by the id, and one step with the note
  const before = steps(s).length;
  const r = ok('world-fix', { town: 'Mini Raleigh', id: clicked, words: 'flat roof, two storeys taller' }, 'human');
  assert.equal(steps(s).length, before + 1);
  const fix = s.doc().world!.towns['Mini Raleigh'].fixes.at(-1)!;
  assert.equal(fix.id, clicked, 'keyed by the stable id');
  assert.ok(fix.at, 'with the position fallback');
  assert.deepEqual(fix.set, { roof: 'flat', floors: info.floors + 2 });
  assert.equal(s.history.data.commits[s.history.data.mainHead!].note, 'flat roof, two storeys taller');
  assert.deepEqual((r.result as any).heard, ['flat roof', `2 floor(s) taller → ${info.floors + 2} floors`]);
  const rebuilt = buildTown(s.doc().world!.towns['Mini Raleigh']).plan.buildings.find((b) => b.id === clicked)!;
  assert.equal(rebuilt.floors, info.floors + 2);
  assert.equal(rebuilt.roof, 'flat');
  // the light state summary changes stamp, so the view refetches the chunk
  const st = townsForState(s.doc().world)[0];
  assert.equal(st.fixes, 1);
  // a note pinned on the building stays put while the building exists
  ok('notes', { action: 'add', text: 'cornice looks thin', at: addr }, 'human');
  assert.deepEqual(s.collab.refreshNotes().stale, []);
});

test('swapping a landmark from the view: the clicked building takes the studio model', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
  ok('new-object', { name: 'Bank tower', type: 'box', color: '#9a9a9a' });
  ok('add-op', { id: 'body', op: 'box', args: { size: [10, 40, 10], at: [0, 20, 0] } });
  const tv = townView(s.doc().world!.towns['Mini Raleigh'], s.doc().world);
  const id = tv.nodes.find((n) => n.worldId)!.worldId!;
  ok('world-fix', { town: 'Mini Raleigh', id, model: 'Bank tower' }, 'human', 'swap in the bank tower');
  const after = townView(s.doc().world!.towns['Mini Raleigh'], s.doc().world, { 'bank-tower': { soups: [], size: [10, 40, 10] } });
  assert.equal(after.buildings.find((b) => b.id === id)!.model, 'bank-tower');
  assert.deepEqual(townsForState(s.doc().world)[0].landmarks, ['bank-tower']);
});

// ── the UI kit ───────────────────────────────────────────────────────────────────────────────────

test('a UI element click → an address on the kit; it goes stale when the element is gone', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('ui-kit', { preset: 'forge' });
  s.selection = { object: 'ui', part: 'pump', time: new Date().toISOString() };
  const a = s.collab.address('selection');
  assert.equal(a.thing, 'ui/pump');
  assert.equal(a.clock, 'none');
  assert.equal(s.collab.describe(a), 'UI kit / pump');
  ok('notes', { action: 'add', text: 'pump button reads small on a phone' }, 'human');
  assert.deepEqual(s.collab.refreshNotes().stale, []);
  ok('ui-kit', { layout: FORGE_LAYOUT.filter((e) => e.id !== 'pump') });
  s.collab.refreshNotes();
  const n = s.collab.notes.list({ status: 'all' }).at(-1)!;
  assert.equal(n.status, 'stale', 'the pump button is gone: its note is stale, not moved');
  assert.equal(n.address.thing, 'ui/pump');
});

test('UI tokens per element: each change is a step and the contrast, overflow and tap checks update', () => {
  const s = new Studio();
  const ok = okCall(s);
  ok('ui-kit', { preset: 'forge', profile: 'mobile' });
  const checks = () => Object.fromEntries((s.snapshot() as any).ui.checks.mobile.map((c: any) => [c.id, c]));
  const desk = () => Object.fromEntries((s.snapshot() as any).ui.checks.desktop.map((c: any) => [c.id, c]));
  assert.ok(checks()['ui-contrast'].pass && checks()['ui-overflow'].pass && checks()['ui-tap'].pass);
  const n0 = steps(s).length;
  ok('ui-style', { element: 'pump', set: { size: 44 } }, 'human', 'bigger: pump text 24 → 44 px');
  assert.equal(steps(s).length, n0 + 1);
  assert.equal(s.history.data.commits[s.history.data.mainHead!].note, 'bigger: pump text 24 → 44 px');
  assert.ok(!checks()['ui-overflow'].pass && /pump/.test(checks()['ui-overflow'].detail), 'big text overflows when translated');
  ok('ui-style', { element: 'pump', set: { size: null, fill: 'bg', ink: 'edge' } }, 'human');
  assert.ok(checks()['ui-overflow'].pass, 'back to the default size fits');
  assert.ok(!checks()['ui-contrast'].pass && /pump text/.test(checks()['ui-contrast'].detail), 'edge on bg is low contrast');
  ok('ui-style', { element: 'pump', set: { fill: null, ink: null, w: 70, h: 70 } }, 'human');
  assert.ok(checks()['ui-contrast'].pass);
  assert.ok(!checks()['ui-tap'].pass && /pump is 38 px/.test(checks()['ui-tap'].detail), checks()['ui-tap'].detail);
  assert.ok(desk()['ui-tap'].pass, 'the same button is big enough on the desktop screen');
  assert.throws(() => { const r = s.call('ui-style', { element: 'pump', set: { fill: '#ff0000' } }); if (!r.ok) throw new Error(r.error); }, /palette colour/);
  // pure check on a kit with an element style
  const kit: UiKit = { tokens: FORGE_TOKENS, layout: [{ ...FORGE_LAYOUT[0], style: { pad: 120 } }], icons: {}, profile: 'desktop' };
  assert.ok(!uiChecks(kit).find((c) => c.id === 'ui-overflow')!.pass, 'huge padding leaves no room');
});
