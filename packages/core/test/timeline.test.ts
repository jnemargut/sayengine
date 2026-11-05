// Phase 10 step 2: everything that moves, on one timeline. Moments on the timeline become addresses,
// failed motion checks become red stretches, a word note on a clip becomes a step, effect sliders
// become labelled steps, and "show me three" works for a sound with a listen-and-pick ask.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio } from '../src/index.ts';
import { parseAddress, resolveAddress, addressFor, timelineFor, TICKS } from '../src/collab/index.ts';
import { buildSceneTimeline, type RenderedSound } from '../src/collab/scenetimeline.ts';
import { checkStretches, momentAt, localTicks, masterTimes, framesToTicks, effectKnobs, knobChange, momentWords, type SceneTimeline } from '../src/collab/movetimeline.ts';
import { buildForge } from '../../../bench/forge.ts';

before(async () => { await initKernel(); });

/** A stand-in for the sound module: a decaying tone of the recipe's length (the daemon renders the real one). */
const fakeSound = (s: any): RenderedSound => {
  const seconds = s.kind === 'bed' ? s.bed.seconds : s.kind === 'music' ? (s.music.bars ?? 4) * 4 * 60 / (s.music.bpm ?? 96) : 1.2, sr = 8000;
  const mono = Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => Math.sin(i * 0.3) * Math.exp(-i / sr * 3));
  return { sr, mono, wav: new Uint8Array(44), seconds, ...(s.kind === 'music' ? { bpm: s.music.bpm ?? 96, bars: s.music.bars ?? 4 } : {}) };
};

function forge() {
  const s = new Studio();
  const ok = (t: string, a: object, why?: string) => { const r = s.call(t, a, 'claude', why ? { why } : {}); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  buildForge((t, a) => ok(t, a));
  ok('add-effect', { id: 'sparks', preset: 'sparks', at: [-0.02, 0.78, -0.5], triggers: [{ on: 'Blacksmith:strike@impact', layer: 'burst' }] });
  ok('add-sound', { id: 'clink', kind: 'event', sound: 'clink', seed: 'strike-1', on: 'Blacksmith:strike@impact' });
  return { s, ok };
}
const built = (s: Studio, opts: any = {}) => buildSceneTimeline(s, s.doc(), { renderSound: fakeSound, ...opts }).timeline;

test('the forge on one timeline: a track per system, the strike looping with its named moments', () => {
  const { s } = forge();
  const tl = built(s);
  const ids = tl.tracks.map((t) => t.id);
  for (const id of ['motion:blacksmith', 'motion:apprentice', 'effect:sparks', 'sound:clink']) assert.ok(ids.includes(id), `${id} in ${ids}`);
  const strike = tl.tracks.find((t) => t.id === 'motion:blacksmith')!;
  assert.equal(strike.clock, 'clip:strike');
  assert.ok(strike.loop && strike.glb && strike.place, 'the strike loops, from its own GLB, placed in the scene');
  assert.deepEqual(strike.covers, ['blacksmith'], 'the GLB stands in for the smith');
  assert.deepEqual(strike.held, [{ object: 'hammer', bone: 'RightHand' }], 'the hammer rides his right hand');
  const impact = strike.markers.find((m) => m.name === 'impact')!;
  assert.equal(impact.at, Math.round(0.6 * 1.8 * TICKS), 'impact at 60% of the 1.8 s strike');
  assert.ok(tl.length >= 6 * TICKS, 'a scene timeline is at least 6 s');
  // sparks and the clink fire on every impact (one per pass of the strike)
  const bursts = tl.tracks.find((t) => t.id === 'effect:sparks')!.markers.filter((m) => m.kind === 'burst').map((m) => m.at);
  assert.deepEqual(bursts, masterTimes(strike, impact.at, tl.length));
  assert.equal(bursts.length, 3);
  const clink = tl.tracks.find((t) => t.id === 'sound:clink')!;
  assert.deepEqual(clink.markers.filter((m) => m.kind === 'burst').map((m) => m.at), bursts);
  assert.ok(clink.wave!.length > 50 && Math.max(...clink.wave!) === 1, 'the clink carries its waveform (peaks, normalised)');
});

test('failed motion checks become red stretches on every pass of the clip', () => {
  assert.deepEqual(framesToTicks([29, 29], 30), [23200, 800]);
  const tl: Pick<SceneTimeline, 'tracks' | 'length'> = {
    length: 6 * TICKS,
    tracks: [{ id: 'motion:x', system: 'motion', label: 'x', thing: 'x', clock: 'clip:a', start: 0, length: 2 * TICKS, loop: true, markers: [], version: 'v',
      checks: [{ name: 'feet planted', pass: false, worst: 0.05, limit: 0.03, unit: 'm', ranges: [[TICKS / 2, TICKS / 4]] }, { name: 'ok', pass: true, worst: 0, limit: 1, unit: '', ranges: [] }] }],
  };
  const red = checkStretches(tl);
  assert.deepEqual(red.map((r) => [r.from / TICKS, r.to / TICKS]), [[0.5, 0.75], [2.5, 2.75], [4.5, 4.75]]);
  assert.ok(red.every((r) => r.check === 'feet planted'));
  // the forge's strike really pops a joint on the downswing: its red stretch sits before the impact
  const { s } = forge();
  const real = checkStretches(built(s)).filter((r) => r.track === 'motion:blacksmith');
  assert.ok(real.length >= 3, 'one red stretch per pass of the strike');
  assert.ok(real[0].from < 1.08 * TICKS && real[0].to <= 1.1 * TICKS, `the pop is on the downswing (${real[0].from / TICKS}–${real[0].to / TICKS} s)`);
});

test('a moment on the timeline becomes a full address on the right clock, anchored to a named moment', () => {
  const { s } = forge();
  const tl = built(s);
  // 2.9 s on the scene timeline = 1.1 s into the second pass of the 1.8 s strike, 0.02 s after "impact"
  const a = momentAt(tl, Math.round(2.9 * TICKS), { object: 'blacksmith', part: 'RightHand' })!;
  assert.equal(a.thing, 'blacksmith/RightHand');
  assert.equal(a.clock, 'clip:strike');
  assert.equal(a.at, Math.round(1.1 * TICKS));
  assert.equal(a.near, 'impact', 'a named moment beats an unnamed key at the same tick');
  // the same address the studio makes for that selection, and it resolves cleanly on the clip's clock
  const parsed = parseAddress({ ...a } as any);
  const fromStudio = addressFor(s.doc(), { object: 'blacksmith', part: 'RightHand', clock: 'clip:strike', seconds: 1.1 });
  assert.equal(fromStudio.near, 'impact');
  assert.equal(fromStudio.of, a.of, 'the track version is the clip clock\'s version stamp');
  assert.equal(resolveAddress(parsed, timelineFor(s.doc(), 'blacksmith/RightHand', 'clip:strike')).status, 'ok');
  assert.match(momentWords(tl.tracks[0], a.at!), /1\.1 s · "impact"/);
  // a sound and the music: their own clocks (sound, beats with bars)
  s.call('add-sound', { id: 'tune', kind: 'music', mood: 'forge', bpm: 120, bars: 4 });
  const tl2 = built(s);
  const music = tl2.tracks.find((t) => t.id === 'sound:tune')!;
  assert.equal(music.clock, 'beats:tune');
  assert.equal(music.markers.filter((m) => m.kind === 'bar').length, 4);
  assert.equal(momentWords(music, localTicks(music, Math.round(2.6 * TICKS))!), 'bar 2 beat 2');
  const m = momentAt(tl2, Math.round(2.6 * TICKS), { track: 'sound:tune' })!;
  assert.equal(m.clock, 'beats:tune');
  assert.equal(m.near, undefined, 'bars are markers, not anchors');
  assert.equal(timelineFor(s.doc(), 'sound:tune', 'beats:tune')!.markers['bar 2'].at, 2 * TICKS);
  const fxAt = momentAt(tl, Math.round(1.2 * TICKS), { track: 'effect:sparks' })!;
  assert.deepEqual([fxAt.thing, fxAt.clock, fxAt.at], ['effect:sparks', 'none', undefined], 'an effect is pointed at as a thing (its bursts follow the strike)');
  parseAddress(fxAt as any);
  // nothing selected, cutscene-less: no track → null; a timeless part stays timeless
  assert.equal(momentAt({ tracks: [] }, 0, {}), null);
  assert.deepEqual(momentAt({ tracks: [] }, 0, { object: 'anvil' }), { thing: 'anvil', clock: 'none' });
});

test('a word note on a clip becomes one step with a before and after', () => {
  const { s } = forge();
  const r = s.call('word-note', { note: 'slower', at: 'blacksmith/RightHand@clip:strike 1.08s ~impact' });
  assert.ok(r.ok, r.error);
  const res: any = r.result;
  assert.equal(res.motion, 'strike');
  const p = s.history.proposal(res.proposal);
  assert.match(p.title, /Blacksmith strike: slower/);
  const steps = s.history.steps(p);
  assert.equal(steps.length, 1, 'one word note = one step');
  assert.equal(steps[0].note, 'slower');
  assert.ok(res.after.seconds > res.before.seconds, `slower is longer (${res.before.seconds} → ${res.after.seconds} s)`);
  assert.ok(res.after.moments.impact > res.before.moments.impact, 'the impact moves with it');
  // the before/after: main and the proposal give two timelines to play
  const before = buildSceneTimeline(s, s.history.mainDoc(), { renderSound: fakeSound }).timeline.tracks[0];
  const after = buildSceneTimeline(s, s.history.proposalDoc(p), { renderSound: fakeSound, branch: p.id }).timeline.tracks[0];
  assert.ok(after.length > before.length && after.version !== before.version);
  const ba = s.collab.openStep(p, 1);
  assert.ok(ba.lines.some((l) => /notes/.test(l)), ba.lines.join('; '));
  assert.ok(ba.assets.some((a) => a.kind === 'character' && a.id === 'blacksmith'));
  // a note pinned on the impact follows it into the slower clip (D61)
  s.history.data.active = 'main';
  const pin = s.collab.addNote('hand snaps here', 'blacksmith/RightHand@clip:strike 1.08s ~impact');
  s.call('commit-proposal', { proposal: p.id });
  s.collab.refreshNotes(); // (the studio may already have re-resolved it on commit)
  assert.notEqual(s.collab.notes.get(pin.id)!.status, 'stale');
  assert.equal(s.collab.notes.get(pin.id)!.address.at, Math.round(1.35 * TICKS));
  // a word note needs a clip
  assert.equal(s.call('word-note', { note: 'slower', at: 'anvil' }).ok, false);
});

test('effect knobs are sliders; moving one is one labelled step', () => {
  const { s } = forge();
  const fx: any = s.doc().effects!.sparks;
  const knobs = effectKnobs(fx);
  assert.deepEqual(knobs.map((k) => k.label), ['burst count', 'speed m/s', 'life s', 'size m', 'spread °', 'gravity']);
  const speed = knobs.find((k) => k.field === 'speed')!;
  assert.equal(speed.value, 3.4);
  const c = knobChange(fx, speed, 4.25);
  assert.equal(c.why, 'sparks burst: speed 3.4 → 4.25');
  assert.deepEqual(c.args.set.speed, [2, 4.25], 'a range scales both ends');
  const r = s.call(c.tool, c.args, 'human', { why: c.why });
  assert.ok(r.ok, r.error);
  const head = s.history.data.commits[s.history.data.mainHead!];
  assert.equal(head.note, c.why, 'the step carries the slider\'s label as its word note');
  assert.deepEqual((s.doc().effects!.sparks as any).layers[0].speed, [2, 4.25]);
  const burst = knobChange(s.doc().effects!.sparks as any, effectKnobs(s.doc().effects!.sparks as any)[0], 90);
  assert.deepEqual(burst.args.set.bursts, [{ at: 0, count: 90 }]);
  // the timeline sees the new recipe: a new version on the effect track
  const v1 = built(s).tracks.find((t) => t.id === 'effect:sparks')!.version;
  s.call(burst.tool, burst.args, 'human', { why: burst.why });
  assert.notEqual(built(s).tracks.find((t) => t.id === 'effect:sparks')!.version, v1);
});

test('show me three for a sound: three distinct takes, a listen-and-pick ask, the pick commits one whole', () => {
  const { s } = forge();
  const r = s.call('sound-three', { id: 'clink' });
  assert.ok(r.ok, r.error);
  const res: any = r.result;
  assert.deepEqual(res.takes.map((t: any) => t.label), ['brighter ring', 'heavier', 'dull thud']);
  assert.equal(res.ask.kind, 'pick');
  assert.ok(res.ask.listen, 'a listen-and-pick ask');
  assert.match(res.ask.question, /Listen to each/);
  assert.ok(res.distinct.every((d: any) => d.distance >= 0.15), 'deliberately distinct');
  // each take has its own sound recipe on its proposal, so the view can play each one's waveform
  const docs = res.takes.map((t: any) => s.history.proposalDoc(s.history.proposal(t.proposal)));
  const kinds = docs.map((d: any) => [d.sounds.clink.sfx.kind, d.sounds.clink.sfx.params?.pitch ?? null]);
  assert.deepEqual(kinds, [['clink', 1500], ['clink', 620], ['thud', null]]);
  const versions = docs.map((d: any) => buildSceneTimeline(s, d, { renderSound: fakeSound }).timeline.tracks.find((t) => t.id === 'sound:clink')!.version);
  assert.equal(new Set(versions).size, 3);
  assert.ok((s.snapshot() as any).takes[0].ask.options.length === 3, 'the view gets the ask with the state');
  const pick = s.call('pick-take', { group: res.group, take: 'heavier', why: 'weightier' });
  assert.ok(pick.ok, pick.error);
  assert.equal((s.doc() as any).sounds.clink.sfx.params.pitch, 620);
  assert.equal(s.collab.picks().at(-1)!.topic, 'sound-clink');
});
