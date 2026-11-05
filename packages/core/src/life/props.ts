// The smart places' own props (Decision 30): market stalls with awnings, piers over the water, bus-stop
// signs and traffic-signal heads, as one small GLB for both engines. Signal lamps come lit and unlit: the
// lit ones are separate nodes named "lit:<sig>:<group>:<red|amber|green>:<k>" that the game shows and
// hides from the runtime's signal state (unlit lamps stay as dark glass).
import { GlbBuilder } from '../glb.ts';
import type { Prop } from './bake.ts';

type V3 = [number, number, number];
interface Mesh { pos: number[]; nrm: number[] }

/** An oriented box: centre, half sizes, yaw (about y). */
function box(m: Mesh, c: V3, h: V3, yaw: number, tilt = 0) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  // local → world: tilt about local x, then yaw about y (local +z is "forward")
  const xf = (p: V3): V3 => { const y = p[1] * ct - p[2] * st, z = p[1] * st + p[2] * ct; return [c[0] + p[0] * cs + z * sn, c[1] + y, c[2] - p[0] * sn + z * cs]; };
  const nf = (n: V3): V3 => { const y = n[1] * ct - n[2] * st, z = n[1] * st + n[2] * ct; return [n[0] * cs + z * sn, y, -n[0] * sn + z * cs]; };
  const faces: Array<[V3, V3[]]> = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
    [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
  ];
  for (const [n, q] of faces) {
    const P = q.map((v) => xf([v[0] * h[0], v[1] * h[1], v[2] * h[2]]));
    const N = nf(n);
    for (const i of [0, 1, 2, 0, 2, 3]) { m.pos.push(...P[i]); m.nrm.push(...N); }
  }
}

export function propsGlb(props: Prop[]): Uint8Array {
  const B = new GlbBuilder();
  const mats = new Map<string, number>();
  const mat = (name: string, color: string, rough = 0.8, emissive?: string) => {
    const key = `${name}|${color}|${emissive ?? ''}`;
    let i = mats.get(key);
    if (i === undefined) {
      const c = parseInt(color.slice(1), 16), lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const m: any = { name, pbrMetallicRoughness: { baseColorFactor: [lin((c >> 16) & 255), lin((c >> 8) & 255), lin(c & 255), 1], metallicFactor: 0, roughnessFactor: rough } };
      if (emissive) { const e = parseInt(emissive.slice(1), 16); m.emissiveFactor = [lin((e >> 16) & 255), lin((e >> 8) & 255), lin(e & 255)]; }
      B.gltf.materials.push(m);
      i = B.gltf.materials.length - 1;
      mats.set(key, i);
    }
    return i;
  };
  const node = (name: string, parts: Array<{ m: number; mesh: Mesh }>, extras: Record<string, unknown> = {}) => {
    const prims = parts.filter((p) => p.mesh.pos.length).map((p) => ({ attributes: { POSITION: B.accessor(new Float32Array(p.mesh.pos), 'VEC3', true), NORMAL: B.accessor(new Float32Array(p.mesh.nrm), 'VEC3') }, material: p.m }));
    if (!prims.length) return -1;
    B.gltf.meshes.push({ name, primitives: prims });
    B.gltf.nodes.push({ name, mesh: B.gltf.meshes.length - 1, extras: { studioName: name, semanticType: 'life-prop', ...extras } });
    return B.gltf.nodes.length - 1;
  };
  const root: number[] = [];
  const wood = mat('prop wood', '#8a6a48'), dark = mat('prop dark', '#2c3030', 0.6), cream = mat('prop cream', '#efe6d2'), pole = mat('prop pole', '#3a4048', 0.5);
  const glass = mat('lamp off', '#1d2124', 0.3);
  const LIT: Record<string, string> = { red: '#ff3b2a', amber: '#ffb020', green: '#3cff7a' };
  let k = 0;
  for (const p of props) {
    const [x, y, z] = p.at, yaw = p.yaw;
    if (p.kind === 'stall') {
      const w = p.size?.[0] ?? 2.6, d = p.size?.[1] ?? 1.4;
      const body: Mesh = { pos: [], nrm: [] }, top: Mesh = { pos: [], nrm: [] }, legs: Mesh = { pos: [], nrm: [] };
      const off = (lx: number, lz: number): V3 => [x + lx * Math.cos(yaw) + lz * Math.sin(yaw), 0, z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
      const at = (lx: number, ly: number, lz: number): V3 => { const q = off(lx, lz); return [q[0], y + ly, q[2]]; };
      box(body, at(0, 0.45, 0), [w / 2, 0.45, d / 2 - 0.15], yaw);                           // the counter
      box(body, at(0, 0.93, 0.25), [w / 2 - 0.1, 0.03, 0.35], yaw);                           // produce crates on top
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(legs, at(sx * (w / 2 - 0.06), 1.15, sz * (d / 2 - 0.06)), [0.04, 1.15, 0.04], yaw);
      box(top, at(0, 2.3, 0.15), [w / 2 + 0.2, 0.04, d / 2 + 0.45], yaw, -0.22);              // the awning, tipped toward the customers
      const n = node(`stall ${k}`, [{ m: wood, mesh: body }, { m: dark, mesh: legs }, { m: mat('awning', p.colour ?? '#c8463a'), mesh: top }], { town: p.town });
      if (n >= 0) root.push(n);
    } else if (p.kind === 'pier') {
      const L = p.size?.[0] ?? 10, W = p.size?.[1] ?? 2.4;
      const deck: Mesh = { pos: [], nrm: [] }, posts: Mesh = { pos: [], nrm: [] };
      const at = (lx: number, ly: number, lz: number): V3 => [x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y + ly, z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
      box(deck, at(0, -0.06, 0), [W / 2, 0.06, L / 2], yaw);
      for (let s = -L / 2 + 0.4; s <= L / 2; s += 2.2) for (const sx of [-1, 1]) box(posts, at(sx * (W / 2 - 0.1), -0.9, s), [0.09, 0.9, 0.09], yaw);
      for (const sx of [-1, 1]) box(posts, at(sx * (W / 2 - 0.05), 0.45, L / 4), [0.04, 0.04, L / 4], yaw);  // rails on the outer half
      const n = node(`pier ${k}`, [{ m: wood, mesh: deck }, { m: mat('pier post', '#5a4632'), mesh: posts }], { town: p.town });
      if (n >= 0) root.push(n);
    } else if (p.kind === 'busstop') {
      const m: Mesh = { pos: [], nrm: [] }, sign: Mesh = { pos: [], nrm: [] };
      box(m, [x, y + 1.3, z], [0.05, 1.3, 0.05], yaw);
      box(sign, [x, y + 2.5, z], [0.32, 0.22, 0.03], yaw);
      const n = node(`bus stop ${k}`, [{ m: pole, mesh: m }, { m: mat('bus sign', '#2f6f9f'), mesh: sign }], { town: p.town });
      if (n >= 0) root.push(n);
    } else if (p.kind === 'signal') {
      const m: Mesh = { pos: [], nrm: [] }, head: Mesh = { pos: [], nrm: [] }, off: Mesh = { pos: [], nrm: [] };
      box(m, [x, y + 1.6, z], [0.06, 1.6, 0.06], yaw);
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      box(head, [x + fx * 0.08, y + 3.0, z + fz * 0.08], [0.17, 0.48, 0.12], yaw);
      const lampAt = (j: number): V3 => [x + fx * 0.21, y + 3.32 - j * 0.32, z + fz * 0.21];
      for (let j = 0; j < 3; j++) box(off, lampAt(j), [0.1, 0.1, 0.02], yaw);
      const n = node(`signal ${p.sig}:${p.group} ${k}`, [{ m: pole, mesh: m }, { m: dark, mesh: head }, { m: glass, mesh: off }], { town: p.town, sig: p.sig, group: p.group });
      if (n >= 0) root.push(n);
      (['red', 'amber', 'green'] as const).forEach((c, j) => {
        const lit: Mesh = { pos: [], nrm: [] };
        const q = lampAt(j);
        box(lit, [q[0] + fx * 0.005, q[1], q[2] + fz * 0.005], [0.1, 0.1, 0.02], yaw);
        const ln = node(`lit:${p.sig}:${p.group}:${c}:${k}`, [{ m: mat(`lamp ${c}`, LIT[c], 0.4, LIT[c]), mesh: lit }], { sig: p.sig, group: p.group, lamp: c });
        if (ln >= 0) root.push(ln);
      });
    }
    k++;
  }
  B.gltf.nodes.push({ name: 'Life props', children: root, extras: { studioName: 'Life props', semanticType: 'life' } });
  B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1);
  return B.build();
}
