// Face forms (the "Dad's teeth" round): continuous teeth rows with a gum line, eyelids that stay outside
// the eyeball at every lid angle, eyeballs that no face shape deforms, and soft (smoothed) heads.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, characterSpec, charParams, SHAPE_KEYS, EXPRESSIONS, LID, forward, localRotations, poseVertices } from '../src/index.ts';

before(async () => { await initKernel(); });

const hullX = (pts: number[][]) => [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0]))];

test('teeth: the upper row is continuous along the arch (no gaps), at least six front teeth, a gum line above; a lower row', () => {
  for (const preset of [{}, { plan: 'stocky', height: 1.42, build: 0.95, shape: 'square', nose: 'big', brows: 'bushy', hair: 'none' }, { plan: 'lanky', headSize: 1.14, shape: 'triangle', eyes: 'big' }]) {
    const spec = characterSpec(charParams(preset));
    const H = spec.face.headH;
    for (const part of ['teethUpper', 'teethLower']) {
      const teeth = spec.mouth.filter((pc) => pc.part === part && pc.kind === 'hull').map((pc) => hullX((pc as any).pts)).sort((a, b) => a[0] - b[0]);
      assert.ok(teeth.length >= 8, `${part}: ${teeth.length} teeth`);
      for (let i = 1; i < teeth.length; i++) {
        const gap = teeth[i][0] - teeth[i - 1][1];
        assert.ok(gap < 0.0015 * H, `${part}: a ${(gap * 1000).toFixed(2)} mm gap between teeth ${i - 1} and ${i}`);
        assert.ok(gap > 0, `${part}: teeth ${i - 1} and ${i} overlap`);
      }
      // the front of the mouth (where an open mouth shows them) holds at least six teeth
      const front = teeth.filter(([a, b]) => Math.abs((a + b) / 2) < 0.6 * spec.face.mouthW);
      if (part === 'teethUpper') assert.ok(front.length >= 6, `${front.length} upper front teeth`);
    }
    assert.ok(spec.mouth.some((pc) => pc.part === 'gumUpper'), 'a gum line over the upper teeth');
  }
  // cartoon, beak and grille mouths keep no teeth
  for (const mouth of ['cartoon', 'beak', 'grille'] as const) assert.equal(characterSpec(charParams({ mouth })).mouth.filter((pc) => /teeth|gum/.test(pc.part)).length, 0, mouth);
});

function kit(preset: string) {
  const s = new Studio();
  const r = s.call('new-character', { name: 'F', preset });
  assert.ok(r.ok, r.error);
  return s.evaluate(s.doc().objects.f).rig!;
}

test('eyes: lids stay outside the eyeball at every lid angle (blinks, squints, wide), and no face shape deforms an eyeball', () => {
  for (const preset of ['default', 'blacksmith', 'dog']) {
    const { rig, rest, vertPart } = kit(preset);
    const eyes = rig.spec.face.eyes;
    const bone = (n: string) => rig.bones.findIndex((b) => b.name === n);
    const of = (re: RegExp) => vertPart.map((p, v) => (re.test(p) ? v : -1)).filter((v) => v >= 0);
    // no shape key touches an eyeball (white, iris, pupil, catch-lights)
    const eyeVerts = new Set(of(/^(Left|Right)Eye/));
    assert.ok(eyeVerts.size > 100);
    for (const k of SHAPE_KEYS) assert.ok(![...rig.shapes[k].idx].some((v) => eyeVerts.has(v)), `${preset}: ${k} moves an eyeball`);
    // everything on the eyeball stays inside LID.eyeMax
    for (const e of eyes) for (const v of of(new RegExp(`^${e.side}Eye`))) {
      const d = Math.hypot(rest[v * 3] - e.c[0], rest[v * 3 + 1] - e.c[1], rest[v * 3 + 2] - e.c[2]);
      assert.ok(d <= LID.eyeMax * e.r, `${preset}: ${vertPart[v]} stands ${(d / e.r).toFixed(3)} r out`);
    }
    // the lids at every angle: open, half, shut, squinting, wide, and squinting while blinking
    const looks: Array<Record<string, number>> = [];
    for (const blink of [0, 0.25, 0.5, 0.75, 1]) for (const [sq, bd, up] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 0.5, 0], [1, 1, 0], [0, 0, 1]]) {
      looks.push({ eyeBlinkLeft: blink, eyeBlinkRight: blink, cheekSquintLeft: sq, cheekSquintRight: sq, browDownLeft: bd, browDownRight: bd, browOuterUpLeft: up, browOuterUpRight: up, browInnerUp: up });
    }
    for (const ex of looks) {
      const posed = forward(rig.bones, rig.parents, localRotations(rig, { expression: ex }));
      const P = poseVertices(rig, rest, posed, ex);
      for (const e of eyes) {
        const c = posed.worldP[bone(`${e.side}Eye`)];
        const dist = (v: number) => Math.hypot(P[v * 3] - c[0], P[v * 3 + 1] - c[1], P[v * 3 + 2] - c[2]) / e.r;
        const up = of(new RegExp(`^lid\\.${e.side[0]}$`)), lo = of(new RegExp(`^lidLow\\.${e.side[0]}$`));
        assert.ok(up.length && lo.length, `${preset}: upper and lower lids`);
        // (where the two lids overlap, below the lower lid's highest point, the upper one stays inside it)
        const elev = (v: number) => Math.atan2(P[v * 3 + 1] - c[1], P[v * 3 + 2] - c[2]);
        const loTop = Math.max(...lo.map(elev)) + 0.05;
        const upMin = Math.min(...up.map(dist)), loMin = Math.min(...lo.map(dist));
        const upLow = up.filter((v) => elev(v) < loTop && elev(v) > -Math.PI * 0.75).map(dist);
        const upMax = upLow.length ? Math.max(...upLow) : 0;
        assert.ok(upMin > LID.eyeMax, `${preset} ${JSON.stringify(ex)}: the upper lid comes to ${upMin.toFixed(3)} r (eyeball ≤ ${LID.eyeMax})`);
        assert.ok(loMin > upMax, `${preset} ${JSON.stringify(ex)}: the lids cross (${loMin.toFixed(3)} vs ${upMax.toFixed(3)})`);
        // and the skin around the eye never comes inside the socket
        for (const v of of(/^(Head|eyeSocket)$/)) {
          const d0 = Math.hypot(rest[v * 3] - e.c[0], rest[v * 3 + 1] - e.c[1], rest[v * 3 + 2] - e.c[2]) / e.r;
          if (d0 < 1.6) assert.ok(dist(v) > LID.lowOut, `${preset}: skin at ${dist(v).toFixed(3)} r cuts into the lids`);
        }
      }
    }
  }
});

test('face shapes keep the lids rigid (they only turn) and squints narrow the eye', () => {
  const { rig, rest, vertPart } = kit('default');
  const e = rig.spec.face.eyes[0];
  for (const k of EXPRESSIONS) {
    const sd = rig.shapes[k];
    for (let i = 0; i < sd.idx.length; i++) {
      const v = sd.idx[i];
      if (!/^lid/.test(vertPart[v]) || !vertPart[v].endsWith('.L')) continue;
      const r0 = Math.hypot(rest[v * 3] - e.c[0], rest[v * 3 + 1] - e.c[1], rest[v * 3 + 2] - e.c[2]);
      const r1 = Math.hypot(rest[v * 3] + sd.d[i * 3] - e.c[0], rest[v * 3 + 1] + sd.d[i * 3 + 1] - e.c[1], rest[v * 3 + 2] + sd.d[i * 3 + 2] - e.c[2]);
      assert.ok(Math.abs(r1 - r0) < 0.002 * e.r, `${k}: a lid vertex changes its distance from the eye centre`);
    }
  }
  const lift = (k: string, part: string) => { const sd = rig.shapes[k]; let m = 0; sd.idx.forEach((v, i) => { if (vertPart[v] === part) m = Math.max(m, Math.abs(sd.d[i * 3 + 1])); }); return m; };
  assert.ok(lift('cheekSquintLeft', 'lidLow.L') > 0.05 * e.r, 'a squint lifts the lower lid');
  assert.ok(lift('browDownLeft', 'lid.L') > 0.05 * e.r, 'a lowered brow lowers the upper lid');
});
