// Phase 9 weeks 15–16: effects (Decisions 56–57), the UI kit (Decision 58) and the /game fixes from the
// Fire's Dying pain log (#10 grip sockets, #11 hand props, #12 place-on the largest flat top, #14 names).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  initKernel, Studio, EFFECT_PRESETS, effectChecks, peakParticles, overdraw, godotEffectScene, parseTrigger, effectFrame,
  FORGE_TOKENS, FORGE_LAYOUT, uiChecks, makeIcon, lintIcon, ICON_NAMES, scoreIcons, pseudo, contrast, godotTheme, uiCss, budgetFor,
} from '../src/index.ts';
import { exportGame } from '../src/gameexport.ts';
import { gameData } from '../src/gamedata.ts';

before(async () => { await initKernel(); });

function make() {
  const s = new Studio();
  const ok = (t: string, a: object = {}) => { const r: any = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  return { s, ok };
}
const glbJson = (glb: Uint8Array) => { const b = Buffer.from(glb); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')); };

test('place-object on: an anvil sits on its face, not on the tip of its horn (pain #12)', () => {
  const { s, ok } = make();
  ok('new-object', { name: 'Anvil', type: 'tool', material: 'black-metal' });
  ok('add-op', { id: 'face', op: 'box', output: false, args: { size: [0.36, 0.08, 0.13], at: [-0.02, 0.23, 0] } });
  ok('add-op', { id: 'horn', op: 'box', output: false, args: { size: [0.04, 0.12, 0.04], at: [0.2, 0.26, 0] } });   // a peak, taller than the face
  ok('add-op', { id: 'anvil', op: 'union', inputs: ['face', 'horn'], output: true });
  ok('new-object', { name: 'Ingot', type: 'prop', material: 'steel' });
  ok('add-op', { id: 'bar', op: 'box', args: { size: [0.1, 0.02, 0.03], at: [0, 0.01, 0] } });
  ok('place-object', { relation: 'on', target: 'anvil' });
  const doc = s.doc(), ingot = Object.values(doc.objects).find((o) => o.name === 'Ingot')!;
  const b = s.evaluate(ingot).bbox!;
  assert.ok(Math.abs(b.min[1] - 0.27) < 2e-3, `ingot rests on the face at 0.27 m, not the horn top at 0.32 (got ${b.min[1]})`);
  assert.ok(Math.abs((b.min[0] + b.max[0]) / 2 - -0.02) < 0.03, 'centred on the face');
});

test('hand props: no collider by default, a grip socket and per-hand hold transforms in the export (pains #10, #11, #14)', async () => {
  const { s, ok } = make();
  ok('new-character', { name: 'Blacksmith', preset: 'blacksmith' });
  ok('new-object', { name: 'Big hammer', type: 'tool', material: 'oak', position: [1, 0, 0] });
  ok('add-op', { id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  ok('add-op', { id: 'head', op: 'box', part: 'head', args: { size: [0.11, 0.045, 0.045], at: [0, 0.33, 0] } });
  ok('add-op', { id: 'hammer', op: 'union', inputs: ['handle', 'head'], output: true });
  ok('set-profile', { profile: 'godot-desktop', kind: 'hand-prop' });
  const doc = s.doc(), ham = Object.values(doc.objects).find((o) => o.name === 'Big hammer')!;
  assert.equal(ham.profile?.kind, 'hand-prop');
  assert.equal(budgetFor(ham.profile!).collision, false, 'a hand prop needs no collider');
  const items = doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) }));
  const r = await exportGame(items, { target: 'web', baker: null, evaluateOp: (o, op) => s.evaluateOp(o, op) });
  const node = glbJson(r.glb).nodes.find((n: any) => n.extras?.studioName === 'Big hammer');
  assert.ok(node, 'the node carries its studio name (named() finds it after GLTFLoader renames it)');
  assert.equal(node.extras.kind, 'hand-prop');
  assert.ok(node.extras.grip?.kind && node.extras.grip.center.length === 3, 'grip socket exported');
  assert.ok(node.extras.grip.center[1] < 0.3, 'the grip is on the handle, below the head');
  const h = node.extras.hold?.Blacksmith?.right;
  assert.ok(h && h.t.length === 3 && h.r.length === 4, 'hold transform for the right hand');
  assert.ok(Math.abs(Math.hypot(...h.r) - 1) < 1e-4, 'unit quaternion');
});

test('effects: presets, budgets, fallback, palette, triggers and the review camera', () => {
  for (const [k, p] of Object.entries(EFFECT_PRESETS)) {
    const def: any = { id: k, name: k, ...p.make() };
    const checks = effectChecks(def);
    for (const c of checks.filter((c) => c.id !== 'fx-parity')) assert.ok(c.pass, `${k} ${c.id}: ${c.detail}`);
    assert.ok(checks.find((c) => c.id === 'fx-parity')!.pending, 'parity waits for a review');
    const tscn = godotEffectScene(def);
    assert.match(tscn, /^\[gd_scene/);
    for (const l of def.layers.filter((l: any) => l.kind === 'particles')) {
      assert.ok(tscn.includes(`[node name="${l.id}" type="GPUParticles3D"`), `${k}: GPU layer`);
      assert.ok(tscn.includes(`[node name="${l.id}_cpu" type="CPUParticles3D"`), `${k}: CPU twin`);
    }
    const f = effectFrame(def, [0, 0, 0]);
    assert.ok(f.radius >= 0.3 && f.radius < 10, `${k} framing ${f.radius}`);
  }
  const rain: any = { id: 'r', name: 'r', ...EFFECT_PRESETS.rain.make() };
  rain.layers[0].rate = 5000;
  rain.profile = 'web-mobile';
  assert.equal(effectChecks(rain).find((c) => c.id === 'fx-particles')!.pass, false, 'heavy rain is over the phone budget');
  assert.ok(peakParticles(rain) > 250);
  const fire: any = { id: 'f', name: 'f', ...EFFECT_PRESETS['forge-fire'].make(), palette: { ember: '#ffcf6a' } };
  fire.layers[0].colour = ['#00ff00', 'ember'];
  assert.equal(effectChecks(fire).find((c) => c.id === 'fx-palette')!.pass, false, 'green is far from the palette');
  assert.ok(overdraw(fire).screens > 0);
  const t = parseTrigger('Blacksmith:hammer-strike@impact', 'burst');
  assert.deepEqual([t.character, t.clip, t.fraction], ['Blacksmith', 'hammer-strike', 0.6]);
  assert.equal(parseTrigger('fed', 'puff').character, undefined, 'a plain name is a game event');
  assert.throws(() => parseTrigger('Blacksmith:hammer-strike@nope', 'burst'), /no moment/);
});

test('effect tools: add, change, check, motion ids resolve to their action', () => {
  const { s, ok } = make();
  ok('new-character', { name: 'Blacksmith', preset: 'blacksmith' });
  ok('set-motion', { object: 'blacksmith', id: 'strike', kind: 'action', action: 'hammer-strike' });
  const r = ok('add-effect', { id: 'sparks', preset: 'sparks', at: [0, 0.8, 0], triggers: [{ on: 'Blacksmith:strike@impact', layer: 'burst' }] });
  assert.equal(r.result.peak, 60);
  const fx = (s.doc() as any).effects.sparks;
  assert.equal(fx.triggers[0].clip, 'strike');
  assert.equal(fx.triggers[0].fraction, 0.6, 'the strike motion plays hammer-strike: impact at 60%');
  ok('add-effect', { id: 'fire', preset: 'forge-fire', at: [0, 0.75, 0], value: 'heat' });
  ok('set-effect', { id: 'fire', layer: 'flames', set: { noise: 0.4 }, valueDefault: 0.5 });
  ok('effect-review', { id: 'fire', score: 0.1, detail: 'close' });
  const checks = ok('check', {}).result;
  assert.ok(checks['effect:fire'].find((c: any) => c.id === 'fx-parity').pass);
  ok('set-effect', { id: 'fire', layer: 'flames', set: { scroll: 2 } });
  assert.equal((s.doc() as any).effects.fire.review, undefined, 'a change clears the review');
  const bad: any = s.call('add-effect', { id: 'x', preset: 'sparks', triggers: [{ on: 'Blacksmith:dance@impact', layer: 'burst' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no motion "dance"/);
  const data = gameData(s);
  assert.equal(data.effects.length, 2);
  assert.deepEqual(data.effects.find((e) => e.def.id === 'fire')!.at, [0, 0.75, 0]);
  assert.equal(data.effects[0].colours.spark, '#ffe2a0', 'colours resolved for the engines');
});

test('UI kit: contrast, translated overflow, tap size, safe area, icons in SVG Tiny', () => {
  const icons = Object.fromEntries(ICON_NAMES.map((n) => [n, { svg: makeIcon(n) }]));
  const ui = { tokens: structuredClone(FORGE_TOKENS), layout: structuredClone(FORGE_LAYOUT), icons };
  const by = (u: any) => Object.fromEntries(uiChecks(u).map((c) => [c.id, c]));
  const c = by(ui);
  for (const id of ['ui-contrast', 'ui-overflow', 'ui-tap', 'ui-safe', 'ui-text-size', 'ui-icon-contrast', 'ui-icons-tiny', 'ui-font']) assert.ok(c[id].pass, `${id}: ${c[id].detail}`);
  assert.ok(c['ui-icons-score'].pending, 'icons are scored when rendered');
  const low = structuredClone(ui); low.tokens.palette.accentInk = '#c0602a';
  assert.equal(by(low)['ui-contrast'].pass, false);
  const long = structuredClone(ui); long.layout.find((e: any) => e.id === 'pump')!.text = 'Pump the bellows harder';
  assert.equal(by(long)['ui-overflow'].pass, false, 'German-length text overflows the button');
  const small = structuredClone(ui); small.layout.find((e: any) => e.id === 'pump')!.h = 60;
  assert.equal(by(small)['ui-tap'].pass, false, '60 ref px is 33 px on a phone');
  const edge = structuredClone(ui); edge.layout.find((e: any) => e.id === 'heat')!.x = 20;
  assert.equal(by(edge)['ui-safe'].pass, false, 'under the notch');
  assert.match(pseudo('Pump'), /^\[Püm/);
  assert.ok(contrast('#000000', '#ffffff') > 20);
  assert.deepEqual(lintIcon(makeIcon('tongs')), []);
  assert.ok(lintIcon('<svg viewBox="0 0 48 48"><filter/><path style="fill:red" d="M0 0"/></svg>').length >= 2);
  const sq = new Float32Array(576), dot = new Float32Array(576);
  for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) sq[y * 24 + x] = 1;
  dot[12 * 24 + 12] = 1;
  const sc = scoreIcons({ sq, sq2: sq.slice(), dot });
  assert.equal(sc.sq.pass, false, 'two identical icons read the same');
  assert.equal(sc.dot.pass, false, 'a dot is too thin');
  assert.match(godotTheme(FORGE_TOKENS), /^\[gd_resource type="Theme"/);
  assert.match(uiCss(FORGE_TOKENS), /--ui-accent: #e0782a/);
});

test('UI tools and gameData: the kit, icons and every recorded line travel to the game (pain #9)', () => {
  const { s, ok } = make();
  ok('ui-kit', { preset: 'forge', tokens: { border: { radius: 2 } } });
  ok('ui-icon', { names: ['tongs', 'blade'] });
  assert.equal((s.doc() as any).ui.tokens.border.radius, 2);
  assert.equal((s.doc() as any).ui.tokens.border.width, 3, 'merged, not replaced');
  ok('ui-score-icons', { masks: { tongs: Array(576).fill(0), blade: Array(576).fill(0) } });
  const checks = ok('check', {}).result.ui;
  assert.equal(checks.find((c: any) => c.id === 'ui-icons-score').pass, false, 'empty renders fail');
  ok('new-character', { name: 'Blacksmith', preset: 'blacksmith' });
  const doc = s.doc(), b = Object.values(doc.objects).find((o) => o.name === 'Blacksmith')!;
  // a recorded line, as record-line stores it (the voice is an asset)
  const wav = s.assets.put(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), 'wav');
  b.character!.lines = { 'good-lad': { text: 'Good lad.', audio: wav, emotion: 'warm', duration: 0.9, fps: 30, cues: [], curves: {}, aligner: 'test', sync: -130 } as any };
  const d = gameData(s, doc);
  assert.equal(d.ui!.tokens.border.radius, 2);
  assert.equal(d.lines.length, 1);
  assert.deepEqual([d.lines[0].character, d.lines[0].line, d.lines[0].clip, d.lines[0].sync], ['Blacksmith', 'good-lad', 'line:good-lad', -130]);
  assert.equal(Buffer.from(d.lines[0].audio!, 'base64').subarray(0, 4).toString(), 'RIFF');
});
