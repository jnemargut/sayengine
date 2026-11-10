// Motion checks on a rigged GLB's own clips (for creatures built outside the studio, e.g. by the
// Blender builder): the clips are sampled node by node and the same kind of checks the rig-part
// creatures get are run on them: loops close, paws stay on or above the floor, planted paws don't
// slide against the ground speed, nothing pops between frames, loops stay in place.
import type { Gltf } from '../importchar.ts';
import type { MotionCheck } from '../rigparts.ts';

type V3 = [number, number, number];
type Q = [number, number, number, number];

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const nlerp = (a: Q, b: Q, t: number): Q => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  const r: Q = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
  const l = Math.hypot(...r) || 1;
  return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
};

function accessor(g: Gltf, i: number): Float32Array {
  const a = g.json.accessors[i];
  const bv = g.json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type as string] ?? 1;
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (a.componentType !== 5126) throw new Error('motion checks read float accessors only');
  const stride = bv.byteStride ? bv.byteStride / 4 : n;
  const src = new Float32Array(g.bin.buffer, g.bin.byteOffset + off, (a.count - 1) * stride + n);
  if (stride === n) return src.slice();
  const out = new Float32Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = src[k * stride + c];
  return out;
}

export interface ClipSamples { name: string; fps: number; frames: number; extras: Record<string, any>; world: Map<number, V3[]>; rot: Map<number, Q[]> }

/** Sample every animation at `fps`: world position and world rotation of each node per frame. */
export function sampleClips(g: Gltf, fps = 30): ClipSamples[] {
  const nodes: any[] = g.json.nodes ?? [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => { parent[c] = i; }));
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number) => { if (seen.has(i)) return; if (parent[i] >= 0) visit(parent[i]); seen.add(i); order.push(i); };
  nodes.forEach((_, i) => visit(i));
  const out: ClipSamples[] = [];
  for (const anim of g.json.animations ?? []) {
    const tracks = new Map<number, { t?: [Float32Array, Float32Array]; r?: [Float32Array, Float32Array]; s?: [Float32Array, Float32Array] }>();
    let dur = 0;
    for (const ch of anim.channels) {
      const sm = anim.samplers[ch.sampler];
      const times = accessor(g, sm.input), vals = accessor(g, sm.output);
      dur = Math.max(dur, times[times.length - 1]);
      const tr = tracks.get(ch.target.node) ?? {};
      const key = ({ translation: 't', rotation: 'r', scale: 's' } as any)[ch.target.path];
      if (key) (tr as any)[key] = [times, vals];
      tracks.set(ch.target.node, tr);
    }
    const frames = Math.max(1, Math.round(dur * fps));
    const world = new Map<number, V3[]>(), rot = new Map<number, Q[]>();
    for (const i of order) { world.set(i, []); rot.set(i, []); }
    const sample = (tv: [Float32Array, Float32Array] | undefined, t: number, n: number): number[] | null => {
      if (!tv) return null;
      const [times, vals] = tv;
      let k = 0;
      while (k < times.length - 1 && times[k + 1] < t) k++;
      const k1 = Math.min(k + 1, times.length - 1);
      const u = k1 === k ? 0 : Math.min(1, Math.max(0, (t - times[k]) / (times[k1] - times[k])));
      const a = Array.from(vals.subarray(k * n, k * n + n)), b = Array.from(vals.subarray(k1 * n, k1 * n + n));
      if (n === 4) return nlerp(a as Q, b as Q, u);
      return a.map((x, c) => x + (b[c] - x) * u);
    };
    for (let f = 0; f <= frames; f++) {
      const t = Math.min(dur, f / fps);
      const W = new Map<number, { p: V3; q: Q; s: V3 }>();
      for (const i of order) {
        const n = nodes[i], tr = tracks.get(i);
        const T = (sample(tr?.t, t, 3) ?? n.translation ?? [0, 0, 0]) as V3;
        const R = (sample(tr?.r, t, 4) ?? n.rotation ?? [0, 0, 0, 1]) as Q;
        const S = (sample(tr?.s, t, 3) ?? n.scale ?? [1, 1, 1]) as V3;
        let w: { p: V3; q: Q; s: V3 };
        if (parent[i] < 0) w = { p: T, q: R, s: S };
        else {
          const P = W.get(parent[i])!;
          const lt: V3 = [T[0] * P.s[0], T[1] * P.s[1], T[2] * P.s[2]];
          const r = qrot(P.q, lt);
          w = { p: [P.p[0] + r[0], P.p[1] + r[1], P.p[2] + r[2]], q: qmul(P.q, R), s: [P.s[0] * S[0], P.s[1] * S[1], P.s[2] * S[2]] };
        }
        W.set(i, w);
        world.get(i)!.push(w.p); rot.get(i)!.push(w.q);
      }
    }
    out.push({ name: anim.name ?? `clip${out.length}`, fps, frames, extras: anim.extras ?? {}, world, rot });
  }
  return out;
}

const ranges = (bad: boolean[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let s = -1;
  bad.forEach((b, i) => { if (b && s < 0) s = i; if (!b && s >= 0) { out.push([s, i - 1]); s = -1; } });
  if (s >= 0) out.push([s, bad.length - 1]);
  return out;
};
const r3 = (x: number) => +x.toFixed(3);

/** Checks for one sampled clip. `paws` are the node indices of the feet; `root` the top bone. */
export function clipChecks(c: ClipSamples, paws: number[], root: number | null, loop: boolean, speed: number, jointNodes: number[]): MotionCheck[] {
  const checks: MotionCheck[] = [];
  const popLimit = loop ? 30 : 45;      // one-shots (a jump's push, a swat) are allowed to be snappier
  const nF = c.frames + 1;
  // loops close: every joint ends where it started
  if (loop) {
    let worst = 0;
    for (const j of jointNodes) { const w = c.world.get(j)!; const a = w[0], b = w[nF - 1]; worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
    checks.push({ name: 'loop closes', pass: worst < 0.005, worst: r3(worst), limit: 0.005, unit: 'm', frames: worst < 0.005 ? [] : [[nF - 1, nF - 1]], detail: `last frame meets the first within ${(worst * 1000).toFixed(1)} mm` });
  }
  // paws on or above the floor
  {
    const bad: boolean[] = []; let worst = 0;
    for (let f = 0; f < nF; f++) {
      let low = Infinity;
      for (const p of paws) low = Math.min(low, c.world.get(p)![f][1]);
      worst = Math.min(worst, low); bad.push(low < -0.012);
    }
    checks.push({ name: 'paws above the floor', pass: !bad.some(Boolean), worst: r3(worst), limit: -0.012, unit: 'm', frames: ranges(bad), detail: bad.some(Boolean) ? `a paw goes ${(-worst * 1000).toFixed(0)} mm below the floor` : 'no paw sinks into the floor' });
  }
  // planted paws hold still against the ground moving under them at the clip's speed
  if (speed > 0 && paws.length) {
    const bad = new Array(nF).fill(false); let worst = 0;
    for (const p of paws) {
      const w = c.world.get(p)!;
      const floor = Math.min(...w.map((x) => x[1]));
      for (let f = 1; f < nF; f++) {
        const contact = w[f][1] < floor + 0.006 && w[f - 1][1] < floor + 0.006;
        if (!contact) continue;
        // in place: a planted paw travels backward (-Z, the creature faces +Z) at the ground speed
        const v = (w[f][2] - w[f - 1][2]) * c.fps;
        const slip = Math.abs(v + speed);
        worst = Math.max(worst, slip);
        if (slip > Math.max(0.06, speed * 0.35)) bad[f] = true;
      }
    }
    checks.push({ name: 'planted paws keep pace with the ground', pass: !bad.some(Boolean), worst: r3(worst), limit: r3(Math.max(0.06, speed * 0.35)), unit: 'm/s', frames: ranges(bad), detail: `worst slip ${worst.toFixed(3)} m/s against ${speed} m/s` });
  }
  // no pops: no joint turns more than 30 degrees between frames
  {
    const bad = new Array(nF).fill(false); let worst = 0;
    for (const j of jointNodes) {
      const q = c.rot.get(j)!;
      for (let f = 1; f < nF; f++) {
        const d = Math.abs(q[f][0] * q[f - 1][0] + q[f][1] * q[f - 1][1] + q[f][2] * q[f - 1][2] + q[f][3] * q[f - 1][3]);
        const deg = (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
        worst = Math.max(worst, deg);
        if (deg > popLimit) bad[f] = true;
      }
    }
    checks.push({ name: 'no pops', pass: !bad.some(Boolean), worst: +worst.toFixed(1), limit: popLimit, unit: '°/frame', frames: ranges(bad), detail: `fastest joint turn ${worst.toFixed(1)}° per frame` });
  }
  // loops stay in place (games move the creature by extras.speed)
  if (loop && root !== null) {
    const w = c.world.get(root)!;
    let worst = 0;
    for (const p of w) worst = Math.max(worst, Math.hypot(p[0] - w[0][0], p[2] - w[0][2]));
    checks.push({ name: 'stays in place', pass: worst < 0.04, worst: r3(worst), limit: 0.04, unit: 'm', frames: [], detail: `the root wanders ${(worst * 100).toFixed(1)} cm` });
  }
  return checks;
}

/** Motion checks for every clip of a rigged GLB. Paws are found by name (toe/paw/foot ends). */
export function glbMotionChecks(g: Gltf, fps = 30): Record<string, MotionCheck[]> {
  const nodes: any[] = g.json.nodes ?? [];
  const joints: number[] = g.json.skins?.[0]?.joints ?? [];
  const byName = (re: RegExp) => joints.filter((j) => re.test(nodes[j]?.name ?? ''));
  let paws = byName(/(^|[._-])(f_toe|r_toe|toe|paw)([._-]|$)/i);
  if (!paws.length) paws = byName(/foot|hand/i);
  const rootIdx = joints.find((j) => /^root$/i.test(nodes[j]?.name ?? '')) ?? joints[0] ?? null;
  const out: Record<string, MotionCheck[]> = {};
  for (const c of sampleClips(g, fps)) {
    const loop = c.extras.loop !== undefined ? !!c.extras.loop : !/jump|land|swat|hit|attack|die|start|stop/i.test(c.name);
    const speed = Number(c.extras.speed ?? 0) || 0;
    out[c.name] = clipChecks(c, paws, rootIdx, loop, speed, joints);
  }
  return out;
}
