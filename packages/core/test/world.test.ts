// The world module (Decisions 26–28): town plans from real data (an offline fixture cut from downtown
// Raleigh), invented and remixed towns, the rules, the fix layer surviving rebuilds and data refreshes,
// landmarks, and the GLB the game contract carries.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio, GlbBuilder, validateGlb } from '../src/index.ts';
import { setWorldCacheDir, buildTown, worldNodes, addTownsToGlb, landmarkMeshes, applyRules, clampBuilding, styleFor, inventedPlan, type TownSpec } from '../src/world/index.ts';
import { squareUp, inset, area, triangulate, ccw, type P2 } from '../src/world/geo.ts';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'world');
before(async () => { await initKernel(); setWorldCacheDir(FIX); });

const real = (fixes: any[] = []): TownSpec => ({ name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown', fixes });

test('geometry: outlines square up, insets shrink, ear clipping covers the polygon', () => {
  const jitter: P2[] = [[0, 0], [20.3, 0.4], [20, 12.2], [0.2, 11.8], [0.1, 6]];
  const r = squareUp(jitter);
  assert.equal(r.how, 'rect');
  assert.equal(r.poly.length, 4);
  const L: P2[] = [[0, 0], [30, 0.5], [30.2, 10], [12, 10.3], [11.8, 25], [-0.3, 25]];
  const o = squareUp(L);
  assert.equal(o.how, 'ortho');
  assert.equal(o.poly.length, 6);
  assert.ok(Math.abs(area(o.poly) - area(L)) / area(L) < 0.05);
  const sq = ccw([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(Math.round(area(inset(sq, 1))), 64);
  assert.equal(Math.round(area(inset(sq, -1))), 144);
  const tris = triangulate(o.poly);
  let sum = 0;
  for (let i = 0; i < tris.length; i += 3) sum += area([o.poly[tris[i]], o.poly[tris[i + 1]], o.poly[tris[i + 2]]]);
  assert.ok(Math.abs(sum - area(o.poly)) < 1e-6);
});

test('rules clamp silly values and keep pitched roofs on simple outlines', () => {
  const s = styleFor('raleigh-downtown');
  const b: any = { id: 'x', footprint: [[0, 0], [3, 0], [3, 3], [0, 3]], height: 900, floors: 0, use: 'shop' };
  const notes: string[] = [];
  assert.ok(clampBuilding(b, s, notes));
  assert.ok(b.height <= 36 + 1e-9, `a 3 m kiosk can't be a tower (got ${b.height})`);
  assert.ok(b.floors >= 1 && b.floors <= Math.floor(b.height / 2.6));
  const odd: any = { id: 'y', footprint: [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]], height: 8, floors: 2, roof: 'gable', use: 'home' };
  clampBuilding(odd, s);
  assert.equal(odd.roof, 'flat');
});

test('a real town builds from the cached Overture, OSM and USGS data with stable ids, graded roads and ODbL credits', () => {
  const t = buildTown(real());
  const p = t.plan;
  assert.ok(p.buildings.length >= 15, `${p.buildings.length} buildings`);
  assert.ok(p.buildings.every((b) => /^ov:[0-9a-f-]{36}/.test(b.id)), 'every building keyed by its Overture GERS id');
  assert.ok(p.streets.some((s) => s.name === 'Fayetteville Street') && p.streets.some((s) => /Martin Street/.test(s.name ?? '')));
  assert.ok(p.credits.some((c) => c.licence === 'ODbL-1.0' && /OpenStreetMap/.test(c.name)) && p.credits.some((c) => /Overture/.test(c.name)) && p.credits.some((c) => /Geological/.test(c.name)));
  for (const s of p.streets) {
    for (let i = 1; i < s.points.length; i++) {
      const d = Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1]);
      if (d > 0.5) assert.ok(Math.abs(s.heights![i] - s.heights![i - 1]) / d <= 0.0801, `${s.id} too steep`);
    }
  }
  // the same inputs build the same plan
  const again = buildTown({ ...real(), name: 'Mini Raleigh 2' }).plan;
  assert.deepEqual(again.buildings.map((b) => [b.id, b.height, b.footprint]), p.buildings.map((b) => [b.id, b.height, b.footprint]));
});

test('invented towns: the same seed gives the same lots and ids, another seed a different town', () => {
  const a = applyRules(inventedPlan('A', { seed: 7, description: 'mill town on a river, 1920s, 3 blocks' }));
  const b = applyRules(inventedPlan('B', { seed: 7, description: 'mill town on a river, 1920s, 3 blocks' }));
  const c = applyRules(inventedPlan('C', { seed: 8, description: 'mill town on a river, 1920s, 3 blocks' }));
  assert.ok(a.buildings.length > 20);
  assert.deepEqual(a.buildings.map((x) => x.id), b.buildings.map((x) => x.id));
  assert.ok(a.buildings.every((x) => x.id.startsWith('inv:7:')));
  assert.notDeepEqual(a.buildings.map((x) => x.footprint), c.buildings.map((x) => x.footprint));
  assert.ok(a.areas.some((x) => x.kind === 'river') && a.areas.some((x) => x.kind === 'park'));
  assert.ok(a.buildings.some((x) => x.use === 'church') && a.buildings.some((x) => x.use === 'industrial'), 'a church and a mill');
  assert.ok(a.buildings.some((x) => x.roof === 'gable'), 'the river-town style has gables');
});

test('the fix layer: fixes land by id, survive a regenerate, fall back to position on a data refresh, and orphans are flagged', () => {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
  const plan = buildTown(s.doc().world!.towns['Mini Raleigh']).plan;
  const target = plan.buildings.slice().sort((x, y) => area(y.footprint) - area(x.footprint))[0];
  ok('world-fix', { town: 'Mini Raleigh', id: target.id, set: { roof: 'hip', height: 21 }, note: 'hipped roof' });
  const other = plan.buildings.find((b) => b.id !== target.id)!;
  const c = other.footprint.reduce((a, q) => [a[0] + q[0] / other.footprint.length, a[1] + q[1] / other.footprint.length], [0, 0]);
  const hid = ok('world-fix', { town: 'Mini Raleigh', at: c, hide: true }).result as any;
  assert.equal(hid.fix.id, other.id, 'a fix made by position also records the id');
  // regenerate the same town: the fix layer stays and re-applies
  ok('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  let t = buildTown(s.doc().world!.towns['Mini Raleigh']);
  const fixed = t.plan.buildings.find((b) => b.id === target.id)!;
  assert.equal(fixed.roof, 'hip');
  assert.equal(fixed.height, 21);
  assert.equal(t.fixes.orphaned.length, 0);
  // a data refresh changes the building's id: the fix finds it by position instead
  const refreshed = fs.mkdtempSync(path.join(os.tmpdir(), 'world-refresh-'));
  fs.cpSync(path.join(FIX, 'raleigh-mini'), path.join(refreshed, 'raleigh-mini'), { recursive: true });
  const gj = JSON.parse(fs.readFileSync(path.join(refreshed, 'raleigh-mini', 'buildings.geojson'), 'utf8'));
  const gers = target.id.slice(3);
  gj.features.find((f: any) => f.id === gers).id = '00000000-0000-0000-0000-000000000001';
  fs.writeFileSync(path.join(refreshed, 'raleigh-mini', 'buildings.geojson'), JSON.stringify(gj));
  try {
    setWorldCacheDir(refreshed);
    t = buildTown(s.doc().world!.towns['Mini Raleigh']);
    assert.equal(t.fixes.applied[0].by, 'position');
    assert.equal(t.plan.buildings.find((b) => b.id === 'ov:00000000-0000-0000-0000-000000000001')!.roof, 'hip');
    // the building is demolished in the data: the fix is orphaned and the check says so
    gj.features = gj.features.filter((f: any) => f.id !== '00000000-0000-0000-0000-000000000001');
    fs.writeFileSync(path.join(refreshed, 'raleigh-mini', 'buildings.geojson'), JSON.stringify(gj));
    fs.utimesSync(path.join(refreshed, 'raleigh-mini', 'meta.json'), new Date(), new Date(Date.now() + 5000));
    const r = s.call('check', {});
    const row = (r.result as any)['town:Mini Raleigh'].find((c: any) => c.id === 'world-fixes');
    assert.equal(row.pass, false);
    assert.match(row.detail, /fix #0 \(hipped roof\)/);
  } finally { setWorldCacheDir(FIX); fs.rmSync(refreshed, { recursive: true, force: true }); }
  // undo removes the last step like any studio change
  assert.ok(s.call('world-unfix', { town: 'Mini Raleigh', index: 1 }).ok);
  assert.equal(s.doc().world!.towns['Mini Raleigh'].fixes.length, 1);
});

test('a landmark swaps in a studio model and the town GLB carries vertex colours, few materials and the credits', async () => {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
  ok('world-town', { name: 'Twin', source: 'invented', seed: 3, description: 'a river town, 2 blocks', offset: [300, 0, 0] });
  ok('new-object', { name: 'Capitol', type: 'building' });
  ok('add-op', { id: 'body', op: 'box', args: { size: [12, 10, 18], at: [0, 5, 0] } });
  const plan = buildTown(s.doc().world!.towns['Mini Raleigh']).plan;
  ok('world-fix', { town: 'Mini Raleigh', id: plan.buildings[0].id, model: 'Capitol', note: 'landmark' });
  const doc = s.doc();
  const models = landmarkMeshes(s, doc);
  assert.ok(models.capitol, 'the studio object becomes a landmark mesh');
  const towns = worldNodes(doc.world, models);
  assert.ok(towns[0].nodes.some((n) => n.semanticType === 'landmark' && n.extras.model === 'capitol'));
  const B = new GlbBuilder();
  const rep = addTownsToGlb(B, towns);
  assert.equal(rep.length, 2);
  // shading classes: matte, glossy, metal, water + the ones a look can light (lit, lamp, neon, sign)
  assert.ok(rep[0].materials <= 8, `${rep[0].materials} materials`);
  const glb = B.build();
  const v = await validateGlb(glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages.slice(0, 3)));
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  assert.match(json.asset.copyright, /OpenStreetMap/);
  assert.ok(json.meshes.every((m: any) => m.primitives.every((p: any) => p.attributes.COLOR_0 !== undefined)));
  assert.ok(json.nodes.some((n: any) => n.name === 'Twin (town)' && n.translation[0] === 300));
  // brand names stay data: no building node is named after its sign
  assert.ok(!json.nodes.some((n: any) => plan.buildings.some((b) => b.name && n.name.includes(b.name))));
});

test('remix keeps the real streets and invents the buildings; world-info finds ids near a point', () => {
  const s = new Studio();
  const r = s.call('world-town', { name: 'Remix', source: 'remix', area: 'raleigh-mini', seed: 5 });
  assert.ok(r.ok, r.error);
  const p = buildTown(s.doc().world!.towns.Remix).plan;
  assert.ok(p.streets.some((x) => x.id.startsWith('osm:w')));
  assert.ok(p.buildings.length > 0 && p.buildings.every((b) => b.id.startsWith('inv:5:')));
  assert.ok(!p.credits.some((c) => /Overture/.test(c.name)), 'no Overture buildings, so no Overture credit');
  const s2 = new Studio();
  s2.call('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
  const info = s2.call('world-info', { near: [0, 0], radius: 60, credits: true });
  assert.ok(info.ok);
  assert.ok((info.result as any).near.length > 0 && (info.result as any).near[0].id.startsWith('ov:'));
  assert.match((info.result as any).creditsText, /ODbL/);
  assert.equal(s2.call('world-town', { name: 'X', source: 'real' }).ok, false, 'real needs an area');
});
