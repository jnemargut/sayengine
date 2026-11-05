// Life polish (Phase 4): the cast GLB slimmer (exact under skinning), wheels as nodes, and the evaluator no
// longer handing a second creature the first one's body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import validator from 'gltf-validator';
import { slimGlb, rigWheels } from '../src/life/slim.ts';

/** A tiny skinned GLB: one triangle on one joint, a face shape, a clip with a still and a moving channel. */
function tinyGlb(): Uint8Array {
  const f = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  const parts: Uint8Array[] = [];
  const views: any[] = [];
  let off = 0;
  const add = (b: Uint8Array) => { views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); parts.push(b); off += b.length; return views.length - 1; };
  const pos = add(f([0.1, 0, 0.2, 1.2, 0.3, -0.4, 0.5, 1.7, 0.1])), nor = add(f([0, 0, 1, 0, 0, 1, 0, 0, 1])), uv = add(f([0, 0, 1, 0, 0.5, 1]));
  const joints = add(new Uint8Array(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)), weights = add(f([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const morph = add(f([0, 0.01, 0, 0, 0, 0, 0, 0, 0]));
  // a joint whose inverse bind matrix is a translation (0, -1, 0)
  const ibm = add(f([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]));
  const tin = add(f([0, 1])), still = add(f([0, 0, 0, 1, 0, 0, 0, 1])), move = add(f([0, 0, 0, 1, 0, 0.38, 0, 0.92])), wts = add(f([0, 1]));
  const J = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Root', translation: [0, 1, 0] }, { name: 'Body', mesh: 0, skin: 0 }],
    skins: [{ joints: [0], inverseBindMatrices: 7 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, targets: [{ POSITION: 5 }] }], weights: [0], extras: { targetNames: ['smile'] } }],
    accessors: [
      { bufferView: pos, componentType: 5126, count: 3, type: 'VEC3', min: [0.1, 0, -0.4], max: [1.2, 1.7, 0.2] },
      { bufferView: nor, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: uv, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: joints, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: weights, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: morph, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0.01, 0] },
      { bufferView: tin, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: ibm, componentType: 5126, count: 1, type: 'MAT4' },
      { bufferView: still, componentType: 5126, count: 2, type: 'VEC4' },
      { bufferView: move, componentType: 5126, count: 2, type: 'VEC4' },
      { bufferView: wts, componentType: 5126, count: 2, type: 'SCALAR' },
    ],
    animations: [{ name: 'idle', samplers: [{ input: 6, output: 8 }, { input: 6, output: 9 }, { input: 6, output: 10 }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }, { sampler: 1, target: { node: 0, path: 'rotation' } }, { sampler: 2, target: { node: 1, path: 'weights' } }] }],
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  J.animations[0].channels.splice(1, 1);   // one rotation channel per node (keep the still one)
  J.animations[0].samplers.splice(1, 1); J.animations[0].channels[1].sampler = 1;
  const bin = new Uint8Array(off); let p = 0; for (const b of parts) { bin.set(b, p); p += b.length; }
  const js = new TextEncoder().encode(JSON.stringify(J)), jp = (4 - (js.length % 4)) % 4, bp = (4 - (bin.length % 4)) % 4;
  const out = new Uint8Array(12 + 8 + js.length + jp + 8 + bin.length + bp), d = new DataView(out.buffer);
  d.setUint32(0, 0x46546c67, true); d.setUint32(4, 2, true); d.setUint32(8, out.length, true);
  d.setUint32(12, js.length + jp, true); d.setUint32(16, 0x4e4f534a, true); out.set(js, 20); out.fill(0x20, 20 + js.length, 20 + js.length + jp);
  const q = 20 + js.length + jp; d.setUint32(q, bin.length + bp, true); d.setUint32(q + 4, 0x004e4942, true); out.set(bin, q + 8);
  return out;
}
const parse = (g: Uint8Array) => { const d = new DataView(g.buffer, g.byteOffset); const n = d.getUint32(12, true); return { J: JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + n))), bin: g.subarray(28 + n) }; };

test('the cast slimmer: no face shapes, quantized for the web (exact under skinning), floats for Godot, valid glTF', async () => {
  const src = tinyGlb();
  for (const quantize of [true, false]) {
    const { glb, report } = slimGlb(src, { quantize });
    const v = await validator.validateBytes(glb);
    assert.equal(v.issues.numErrors, 0, JSON.stringify(v.issues.messages.slice(0, 3)));
    const { J, bin } = parse(glb);
    assert.equal(report.morphTargets, 1);
    assert.equal(J.meshes[0].primitives[0].targets, undefined);
    assert.ok(J.animations[0].channels.every((c: any) => c.target.path !== 'weights'), 'face-shape channels go with the shapes');
    assert.equal(report.constantChannels, 1, 'the still channel keeps one key');
    assert.equal(J.extensionsUsed?.includes('KHR_mesh_quantization') ?? false, quantize);
    const P = J.accessors[J.meshes[0].primitives[0].attributes.POSITION];
    assert.equal(P.componentType, quantize ? 5123 : 5126);
    if (quantize) {
      // joint × IBM' × q == joint × IBM × v for every vertex: the dequantization lives in the IBM
      const ib = J.accessors[J.skins[0].inverseBindMatrices], vw = J.bufferViews[ib.bufferView], M = new Float32Array(bin.slice(vw.byteOffset, vw.byteOffset + 64).buffer);
      const pv = J.bufferViews[P.bufferView], dq = new DataView(bin.buffer, bin.byteOffset + pv.byteOffset);
      const orig = [[0.1, 0, 0.2], [1.2, 0.3, -0.4], [0.5, 1.7, 0.1]];
      orig.forEach((o, i) => {
        const q = [0, 1, 2].map((k) => dq.getUint16(i * 8 + k * 2, true) / 65535);
        const got = [0, 1, 2].map((r) => M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]);
        const want = [o[0], o[1] - 1, o[2]];
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - want[k]) < 1e-4, `vertex ${i}: ${got} vs ${want}`);
      });
    }
  }
  assert.ok(slimGlb(src).report.after < src.length);
});

test('vehicles: the wheels primitive becomes four wheel nodes under steer pivots at their hubs', async () => {
  const { initKernel, Studio } = await import('../src/index.ts');
  const { exportGame } = await import('../src/gameexport.ts');
  await initKernel();
  const s = new Studio();
  const car = (id: string, len: number, col: string) => s.call('new-creature', { id, name: id, parts: [{ kind: 'body', shape: 'box', size: [1.78, 0.62, len], height: 0.62, color: col }, { kind: 'wheels', id: 'wheels', axles: [{ z: len * 0.31, track: 1.56, r: 0.33, w: 0.24 }, { z: -len * 0.31, track: 1.56, r: 0.33, w: 0.24 }], ride: 0.3, travel: 0.08, color: '#23252a' }], position: [0, 0, 0] });
  assert.ok(car('car-a', 4.25, '#b8382c').ok);
  assert.ok(car('car-b', 7.5, '#2f6f9f').ok);
  const { selectForExport } = await import('../src/selection.ts');
  const doc = s.doc();
  // exported at the origin, both creatures sit at one spot: the evaluator's cache must still tell them apart
  const [a] = selectForExport(s as any, doc, { object: 'car-a', atOrigin: true }), [b] = selectForExport(s as any, doc, { object: 'car-b', atOrigin: true });
  assert.ok(a.res.ok && b.res.ok);
  assert.notDeepEqual(a.res.bbox, b.res.bbox, 'the second creature has its own body');
  const res = await exportGame([b], { target: 'web', baker: null, evaluateOp: (o, id) => s.evaluateOp(o, id) });
  const { glb, wheels } = rigWheels(res.glb);
  assert.equal(wheels, 4);
  const { J } = parse(glb);
  const steer = J.nodes.filter((n: any) => /^steer-/.test(n.name));
  assert.equal(steer.length, 4);
  assert.ok(steer.every((n: any) => Math.abs(n.translation[1] - 0.33) < 0.1), 'pivots at the hubs');
});
