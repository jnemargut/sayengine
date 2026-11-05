// One-off actions for creatures (Decision 53 A): "the octopus pours tea". Claude writes the key moments
// as part goals (where a tentacle's tip goes, what it holds, how a held prop tilts, where the body is,
// what the wings and legs do, how fast a hinge turns); the studio solves every frame on top of the
// creature's idle: FABRIK for reaching chains, two-bone IK for legs, wing poses blended between modes,
// spin integrated from keyed speeds. A style follower (a damped spring per goal) gives weight: lag,
// overshoot and settle. Notes in plain words ("slower", "more weight", "hold the pour longer") edit the
// timing and style, so a reviewer can steer it without touching numbers. The universal checks run on the
// result, plus the props' own: a held prop stays in its grip, and a let-go prop rests on something.
// DOM-free.
import { qAxisAngle, qIdentity, qMul, qRot, type Q, type V3 } from './rig.ts';
import { qAngle, qInv, qSlerp, keyEase } from './motion.ts';
import { bakeCreature, bonePoint, chainLocals, legPole, creatureFK, fabrik, sampleClip, terrainHeight, twoBoneKnee, type ChainPartSpec, type Creature, type CreatureClip, type CreatureMotion, type FK, type HingePartSpec, type LegsPartSpec, type MotionCheck, type PartShape, type PropPartSpec, type WingPartSpec } from './rigparts.ts';
import { flightPlan, legTuck, mirrorQ, wingPose, type WingMode } from './wings.ts';

const TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** One key moment. Everything carries forward to later keys until a key changes it. */
export interface ActionKey {
  t: number;                                           // seconds (before tempo)
  label?: string;                                      // "grab the handle", "pour" (notes and stills refer to it)
  ease?: 'smooth' | 'in' | 'out' | 'back' | 'linear';  // the move INTO this key
  body?: { at?: V3; turn?: number; pitch?: number; roll?: number };   // offset from rest (m); degrees (turn: left +, pitch: nose down +)
  reach?: Record<string, V3 | null>;                   // chain id → where its tip goes (object space); null: back to its own motion
  hold?: Record<string, string | null>;                // prop id → chain id that holds it from here; null: let go
  props?: Record<string, { tilt?: number; axis?: V3 }>; // a prop's tilt (deg about axis, through its grip point)
  wings?: WingMode;                                    // fold, flap, glide, hover, spread
  legs?: 'plant' | 'tuck';                             // plant: feet on the ground under the body; tuck: folded up (flight)
  spin?: Record<string, number>;                       // hinge id → rpm
  creak?: number;                                      // 0..1: stick-slip judder in spinning hinges
  fx?: Record<string, boolean>;                        // effect props on/off (the tea stream)
}
export interface ActionStyle { tempo?: number; weight?: number; size?: number }
export interface ActionSpec { label: string; keys: ActionKey[]; style?: ActionStyle; notes?: string[]; asymmetric?: boolean }

// ── notes: plain words → style and timing ──────────────────────────────────────────────────────

interface Resolved { keys: ActionKey[]; style: Required<ActionStyle>; changes: string[] }

const NOTE_HELP = 'understood notes: slower / much slower / faster / much faster, more weight / heavier / lighter, bigger / smaller (subtler), hold <key label> longer, pause before <key label>, snappier';

/** Apply notes to an action, in order. Unknown notes are an error that lists what is understood. */
export function applyNotes(spec: ActionSpec, extra: string[] = []): Resolved {
  const style = { tempo: spec.style?.tempo ?? 1, weight: spec.style?.weight ?? 0.4, size: spec.style?.size ?? 1 };
  let keys = spec.keys.map((k) => ({ ...k }));
  const changes: string[] = [];
  const findKey = (name: string) => {
    const n = name.trim().toLowerCase();
    const i = keys.findIndex((k) => (k.label ?? '').toLowerCase() === n);
    if (i >= 0) return i;
    const j = keys.findIndex((k) => (k.label ?? '').toLowerCase().includes(n) || n.includes((k.label ?? '\u0000').toLowerCase()));
    if (j < 0) throw new Error(`no key labelled "${name}" (keys: ${keys.map((k) => k.label).filter(Boolean).join(', ')})`);
    return j;
  };
  const shiftAfter = (i: number, dt: number) => { keys = keys.map((k, j) => (j > i ? { ...k, t: k.t + dt } : k)); };
  for (const raw of [...(spec.notes ?? []), ...extra]) {
    const note = raw.toLowerCase().trim();
    let hit = false;
    const parts = note.split(/\s*(?:,|;| and )\s*/).filter(Boolean);
    for (const p of parts) {
      let m: RegExpMatchArray | null;
      if (/\bmuch slower\b|\bway slower\b/.test(p)) { style.tempo *= 1.5; changes.push('tempo ×1.5 (much slower)'); hit = true; }
      else if (/\bslower\b|take (its|his|her|their) time|more slowly/.test(p)) { style.tempo *= 1.25; changes.push('tempo ×1.25 (slower)'); hit = true; }
      else if (/\bmuch faster\b|\bway faster\b/.test(p)) { style.tempo /= 1.5; changes.push('tempo ÷1.5 (much faster)'); hit = true; }
      else if (/\bfaster\b|\bquicker\b|more quickly/.test(p)) { style.tempo /= 1.25; changes.push('tempo ÷1.25 (faster)'); hit = true; }
      else if (/\bsnappier\b|\bcrisper\b/.test(p)) { style.tempo /= 1.1; style.weight -= 0.15; changes.push('tempo ÷1.1, weight −0.15 (snappier)'); hit = true; }
      else if (/more weight|\bheavier\b|weightier|feel(s)? heavy/.test(p)) { style.weight += 0.25; changes.push('weight +0.25 (more lag, overshoot and settle)'); hit = true; }
      else if (/less weight|\blighter\b|floatier/.test(p)) { style.weight -= 0.25; changes.push('weight −0.25'); hit = true; }
      else if (/\bbigger\b|more exaggerated|broader|more cartoony/.test(p)) { style.size *= 1.2; changes.push('size ×1.2'); hit = true; }
      else if (/\bsmaller\b|\bsubtler\b|more subtle|less exaggerated/.test(p)) { style.size /= 1.2; changes.push('size ÷1.2'); hit = true; }
      else if ((m = p.match(/hold (?:the )?(.+?) (?:a bit |much |a lot )?longer/))) {
        const i = findKey(m[1]);
        const dt = /much|a lot/.test(p) ? 1 : 0.5;
        // a hold: the key repeats, later keys move back
        keys.splice(i + 1, 0, { ...keys[i], t: keys[i].t + dt, ease: 'linear', label: `${keys[i].label ?? 'key'} (held)` });
        shiftAfter(i + 1, dt);
        changes.push(`hold "${keys[i].label}" ${dt} s longer`); hit = true;
      } else if ((m = p.match(/pause (?:before|ahead of) (?:the )?(.+)/))) {
        const i = findKey(m[1]);
        if (i === 0) throw new Error('can\'t pause before the first key');
        keys.splice(i, 0, { ...keys[i - 1], t: keys[i - 1].t + (keys[i].t - keys[i - 1].t) * 0.2 + 0.001, ease: 'linear', label: `pause before ${keys[i].label}` });
        shiftAfter(i, 0.4);
        changes.push(`pause 0.4 s before "${keys[i + 1].label}"`); hit = true;
      }
    }
    if (!hit) throw new Error(`note "${raw}" not understood (${NOTE_HELP})`);
  }
  style.tempo = clamp(style.tempo, 0.3, 3); style.weight = clamp(style.weight, 0, 1); style.size = clamp(style.size, 0.4, 2.5);
  return { keys, style, changes };
}

// ── the solver ───────────────────────────────────────────────────────────────────────────────────

interface KeyState {
  t: number; label: string; ease: ActionKey['ease'];
  at: V3; turn: number; pitch: number; roll: number;
  reach: Record<string, V3 | null>; hold: Record<string, string | null>; tilt: Record<string, { tilt: number; axis: V3 }>;
  wings: WingMode; legs: 'plant' | 'tuck'; spin: Record<string, number>; creak: number; fx: Record<string, boolean>;
  plant: { at: V3; turn: number };
}

/** A damped spring that follows a goal: weight → lower frequency, less damping (lag, overshoot, settle). */
class Follow {
  x: number[]; v: number[]; w0: number; z: number;
  constructor(x0: number[], w0: number, z: number) { this.x = [...x0]; this.v = x0.map(() => 0); this.w0 = w0; this.z = z; }
  step(goal: number[], dt: number) {
    const n = 4, h = dt / n;
    for (let s = 0; s < n; s++) for (let k = 0; k < goal.length; k++) {
      const a = -this.w0 * this.w0 * (this.x[k] - goal[k]) - 2 * this.z * this.w0 * this.v[k];
      this.v[k] += a * h; this.x[k] += this.v[k] * h;
    }
    return this.x;
  }
}

export function validateAction(c: Creature, spec: ActionSpec) {
  if (!spec.keys?.length) throw new Error('an action needs keys');
  const chains = new Set(c.def.parts.filter((p) => p.kind === 'chain').map((p) => (p as ChainPartSpec).id));
  const props = new Set(c.def.parts.filter((p) => p.kind === 'prop').map((p) => (p as PropPartSpec).id));
  const hinges = new Set(c.def.parts.filter((p) => p.kind === 'hinge').map((p) => (p as HingePartSpec).id));
  let last = -Infinity;
  for (const k of spec.keys) {
    if (!(k.t >= 0)) throw new Error(`key "${k.label ?? k.t}": t must be ≥ 0`);
    if (k.t < last) throw new Error(`keys must be in time order (${k.t} after ${last})`);
    last = k.t;
    for (const id of Object.keys(k.reach ?? {})) if (!chains.has(id)) throw new Error(`key "${k.label ?? k.t}": no chain "${id}" (chains: ${[...chains].join(', ') || 'none'})`);
    for (const [p, ch] of Object.entries(k.hold ?? {})) { if (!props.has(p)) throw new Error(`no prop "${p}" (props: ${[...props].join(', ') || 'none'})`); if (ch && !chains.has(ch)) throw new Error(`no chain "${ch}" to hold ${p}`); }
    for (const p of Object.keys(k.props ?? {})) if (!props.has(p)) throw new Error(`no prop "${p}"`);
    for (const h of Object.keys(k.spin ?? {})) if (!hinges.has(h)) throw new Error(`no hinge "${h}" (hinges: ${[...hinges].join(', ') || 'none'})`);
    for (const f of Object.keys(k.fx ?? {})) if (!c.fx.has(f)) throw new Error(`no effect prop "${f}"`);
    if (k.wings && !c.wings.length) throw new Error(`${c.def.name} has no wings`);
  }
}

/** Solve an action motion into a clip (not looping; it settles into idle). */
export function bakeAction(c: Creature, id: string, m: CreatureMotion, fps = 30): CreatureClip {
  const spec = m.action;
  if (!spec) throw new Error('an action motion needs its key moments (action.keys)');
  validateAction(c, spec);
  const { keys: rawKeys, style, changes } = applyNotes(spec);
  const tempo = style.tempo, W = style.weight, S = style.size;
  const n = c.bones.length;
  const bi = (name: string) => c.index.get(name)!;
  const B = bi('Body');
  const bodyRest = c.bones[B].head;
  const chains = c.def.parts.filter((p): p is ChainPartSpec => p.kind === 'chain');
  const props = c.def.parts.filter((p): p is PropPartSpec => p.kind === 'prop');
  const hinges = c.def.parts.filter((p): p is HingePartSpec => p.kind === 'hinge');
  const wingSpec = c.def.parts.find((p): p is WingPartSpec => p.kind === 'wing');
  const legSpec = c.def.parts.find((p): p is LegsPartSpec => p.kind === 'legs');
  // carry every goal forward from key to key
  const states: KeyState[] = [];
  for (const k of rawKeys) {
    const p = states[states.length - 1];
    const s: KeyState = p ? { ...p, reach: { ...p.reach }, hold: { ...p.hold }, tilt: { ...p.tilt }, spin: { ...p.spin }, fx: { ...p.fx } } : {
      t: 0, label: '', ease: 'smooth', at: [0, 0, 0], turn: 0, pitch: 0, roll: 0, reach: {}, hold: {}, tilt: {}, wings: 'fold', legs: 'plant',
      spin: Object.fromEntries(hinges.filter((h) => h.motion.kind === 'spin').map((h) => [h.id, (h.motion as any).rpm])), creak: 0, fx: {}, plant: { at: [0, 0, 0], turn: 0 },
    };
    s.t = k.t * tempo; s.label = k.label ?? `key ${states.length + 1}`; s.ease = k.ease ?? 'smooth';
    if (k.body?.at) s.at = mul(k.body.at, S);
    if (k.body?.turn !== undefined) s.turn = k.body.turn * S;
    if (k.body?.pitch !== undefined) s.pitch = k.body.pitch * S;
    if (k.body?.roll !== undefined) s.roll = k.body.roll * S;
    Object.assign(s.reach, k.reach ?? {});
    Object.assign(s.hold, k.hold ?? {});
    for (const [pid, v] of Object.entries(k.props ?? {})) s.tilt[pid] = { tilt: (v.tilt ?? s.tilt[pid]?.tilt ?? 0) * (v.tilt !== undefined ? S : 1), axis: norm(v.axis ?? s.tilt[pid]?.axis ?? [0, 0, 1]) };
    if (k.wings) s.wings = k.wings;
    if (k.legs) s.legs = k.legs;
    if (!p || k.legs === 'plant') s.plant = { at: [...s.at] as V3, turn: s.turn };   // feet land where the body is at this key
    Object.assign(s.spin, k.spin ?? {});
    if (k.creak !== undefined) s.creak = k.creak;
    Object.assign(s.fx, k.fx ?? {});
    states.push(s);
  }
  if (states[0].t > 0) states.unshift({ ...states[0], t: 0, label: 'start' });
  const lastT = states[states.length - 1].t;
  const duration0 = lastT + 0.5 + 0.7 * W;                      // room to settle
  const frames = Math.max(4, Math.round(duration0 * fps));
  const duration = frames / fps;
  // the idle underneath (tentacles curl, wings folded, feet planted)
  const idle = bakeCreature(c, '_idle', { kind: 'idle', duration: Math.max(2, Math.round(duration / 3) * 3) }, fps);
  const endPose = sampleClip(idle, duration).rot;
  const w0 = TAU * lerp(4.2, 1.7, W), zeta = lerp(0.95, 0.5, W);
  const followers = new Map<string, Follow>();
  const follow = (key: string, goal: number[], dt: number) => {
    let fo = followers.get(key);
    if (!fo) { fo = new Follow(goal, w0, zeta); followers.set(key, fo); return [...goal]; }
    return [...fo.step(goal, dt)];
  };
  const beatHz = wingSpec ? flightPlan(wingSpec).freq : 0;
  const rot: Q[][] = [], off: V3[][] = [], contacts: boolean[][] = [], held: Array<Record<string, string>> = [], grip: Array<Record<string, number>> = [];
  let reachMiss = 0;
  const spinAngle: Record<string, number> = {};
  const lastJoints = new Map<string, V3[]>();
  const holdState: Record<string, { chain: string; offset: V3 } | null> = {};
  const propWorld: Record<string, V3> = Object.fromEntries(props.map((p) => [p.id, [0, 0, 0] as V3]));
  const segOf = (t: number) => { let i = 0; while (i + 1 < states.length && states[i + 1].t <= t) i++; return i; };
  const ground = (x: number, z: number) => terrainHeight(c.def.terrain, x, z);
  const rotY = (v: V3, deg: number) => qRot(qAxisAngle([0, 1, 0], deg), v);
  for (let f = 0; f <= frames; f++) {
    const t = f / fps, dt = 1 / fps;
    const base = sampleClip(idle, t);
    const R: Q[] = base.rot.map((q) => [...q] as Q);
    const O: V3[] = base.off.map((o) => [...o] as V3);
    const down: boolean[] = new Array(c.contacts.length).fill(false);
    const i = segOf(t);
    const a = states[i], b = states[Math.min(states.length - 1, i + 1)];
    const u = b === a ? 1 : clamp((t - a.t) / Math.max(1e-6, b.t - a.t));
    const e = b.ease === 'linear' ? u : keyEase(b.ease as any, u);
    // ── the body ──
    const at = follow('body.at', lerp3(a.at, b.at, e) as number[], dt) as V3;
    const [turn, pitch, roll] = follow('body.rot', [lerp(a.turn, b.turn, e), lerp(a.pitch, b.pitch, e), lerp(a.roll, b.roll, e)], dt);
    const bodyQ = qMul(qAxisAngle([0, 1, 0], turn), qMul(qAxisAngle([1, 0, 0], pitch), qAxisAngle([0, 0, 1], roll)));
    O[B] = add(O[B], at);
    R[B] = qMul(bodyQ, R[B]);
    // ── wings: blended between the two keys' modes; flapping lifts the body a little ──
    if (wingSpec) {
      const pa = wingPose(wingSpec, a.wings, beatHz * t, t), pb = wingPose(wingSpec, b.wings, beatHz * t, t);
      const k = a.wings === b.wings ? 0 : e;
      // folding and unfolding lift the wing clear of the body on the way (birds raise them to unfold)
      const lift = (a.wings === 'fold') !== (b.wings === 'fold') ? 36 * Math.sqrt(Math.sin(Math.PI * k)) : 0;
      const arm = qMul(qAxisAngle([0, 0, 1], lift), qSlerp(pa.arm, pb.arm, k)), fore = qSlerp(pa.fore, pb.fore, k), hand = qSlerp(pa.hand, pb.hand, k);
      for (const w of c.wings) {
        const mq = (q: Q) => (w.side > 0 ? q : mirrorQ(q));
        R[bi(w.arm)] = mq(arm); R[bi(w.fore)] = mq(fore); R[bi(w.hand)] = mq(hand);
      }
      O[B][1] += 0.02 * (wingSpec.length * 2) * lerp(pa.bob, pb.bob, k);
    }
    const bHead = add(bodyRest, O[B]);
    // ── legs: planted under where the body is at each key, or tucked; a leg that can't reach lifts ──
    if (legSpec) {
      for (const leg of c.legs) {
        const hipB = c.bones[bi(leg.hip)], kneeB = c.bones[bi(leg.knee)];
        const l1 = len(sub(hipB.tail, hipB.head)), l2 = len(sub(kneeB.tail, kneeB.head));
        const reachL = l1 + l2;
        const hipW = add(bHead, qRot(R[B], sub(hipB.head, bodyRest)));
        const plantAt = (s: { at: V3; turn: number }): V3 => { const p = add(rotY(leg.foot, s.turn), [s.at[0], 0, s.at[2]]); return [p[0], ground(p[0], p[2]), p[2]]; };
        const tuckAt = (): V3 => add(bHead, qRot(R[B], sub(legTuck(c, leg), bodyRest)));
        const A = a.legs === 'plant' ? plantAt(a.plant) : tuckAt(), Bt = b.legs === 'plant' ? plantAt(b.plant) : tuckAt();
        let target = lerp3(A, Bt, a.legs === b.legs ? e : e);
        const moved = a.legs === 'plant' && b.legs === 'plant' && len(sub(A, Bt)) > 0.01;
        if (moved) target[1] += Math.sin(Math.PI * e) * (legSpec.lift ?? 0.35) * legSpec.upper;
        let isDown = a.legs === 'plant' && b.legs === 'plant' && !moved;
        if (a.legs === 'plant' && b.legs === 'tuck' && e < 0.02) isDown = true;
        if (len(sub(target, hipW)) > reachL * 0.94) { target = add(hipW, mul(norm(sub(target, hipW)), Math.min(len(sub(target, hipW)), reachL * 0.985))); isDown = false; }
        // a foot in the air eases toward its target (no snaps); a planted one stays exactly put
        // (followed in the body's frame, so a flying bird's tucked feet don't trail behind it)
        const fkey = `foot.${leg.hip}`;
        if (isDown) followers.delete(fkey);
        else {
          const local = follow(fkey, qRot(qInv(R[B]), sub(target, bHead)) as number[], dt) as V3;
          target = add(bHead, qRot(R[B], local));
        }
        const ik = twoBoneKnee(hipW, target, l1, l2, legPole(leg, R[B]));
        if (isDown) reachMiss = Math.max(reachMiss, ik.miss);
        const locals = chainLocals(c, [leg.hip, leg.knee], [hipW, ik.knee, ik.foot], R[B]);
        R[bi(leg.hip)] = locals[0]; R[bi(leg.knee)] = locals[1];
        c.contacts.forEach((cd, ci) => { if (cd.bone === leg.knee) down[ci] = isDown && Math.abs(target[1] - ground(target[0], target[2])) < 0.01; });
      }
    }
    // ── hinges: keyed speed, integrated (with creak: stick-slip) ──
    for (const h of hinges) {
      if (h.motion.kind !== 'spin') continue;
      const goal = lerp(a.spin[h.id] ?? 0, b.spin[h.id] ?? 0, e);
      const [rpm] = follow(`spin.${h.id}`, [goal], dt);
      const creak = lerp(a.creak, b.creak, e);
      const judder = 1 - creak * Math.pow(0.5 + 0.5 * Math.sin(TAU * 1.6 * t), 3);
      spinAngle[h.id] = (spinAngle[h.id] ?? 0) + ((rpm * judder) / 60) * 360 * dt;
      R[bi(h.id)] = qAxisAngle(norm(h.axis), spinAngle[h.id]);
    }
    // ── chains: reach for their goals from wherever their own motion has them ──
    let fk = creatureFK(c, R, O);
    for (const ch of chains) {
      const ga = a.reach[ch.id] ?? null, gb = b.reach[ch.id] ?? null;
      const names = Array.from({ length: ch.segments }, (_, k) => `${ch.id}.${k + 1}`);
      const first = bi(names[0]);
      const joints: V3[] = [fk.pos[first], ...names.map((nm) => bonePoint(c, fk, bi(nm), c.bones[bi(nm)].tail))];
      const idleTip = joints[joints.length - 1];
      let T: V3 | null = null, w = 0;
      if (ga && gb) {
        T = lerp3(ga, gb, e); w = 1;
        const d = len(sub(ga, gb));
        if (d > 0.05) T = add(T, [0, Math.sin(Math.PI * e) * 0.22 * d * S, 0]);
      } else if (gb) { T = gb; w = e; } else if (ga) { T = ga; w = 1 - e; }
      // the goal and how much the chain follows it are smoothed separately, so a chain at rest plays
      // its own motion exactly and a reach eases in and out of it
      const tKey = `reach.${ch.id}`;
      const Tf = T ? follow(tKey, T as number[], dt) as V3 : (followers.get(tKey)?.x as V3 | undefined);
      const [wf] = follow(`w.${ch.id}`, [w], dt);
      if (!Tf || wf < 1e-3) { followers.delete(tKey); lastJoints.delete(ch.id); continue; }
      const P = lerp3(idleTip, Tf, clamp(wf, 0, 1));
      const parentRot = c.parents[first] >= 0 ? fk.rot[c.parents[first]] : qIdentity();
      const lim = c.limits[names[0]];
      // FABRIK from the chain's own pose, then relax the kinks (a few smoothing rounds, re-reaching each
      // time) so slack in a long tentacle spreads along it instead of folding one joint
      const segL = joints.slice(1).map((q, k) => len(sub(q, joints[k])));
      let solved = fabrik(joints, P, 24);
      for (let r = 0; r < 3; r++) {
        const sm = solved.map((q, k) => (k === 0 || k === solved.length - 1 ? q : lerp3(q, lerp3(solved[k - 1], solved[k + 1], 0.5), 0.6)));
        // back to the true segment lengths (smoothing shortens them), then reach again
        for (let k = 1; k < sm.length; k++) sm[k] = add(sm[k - 1], mul(norm(sub(sm[k], sm[k - 1])), segL[k - 1]));
        solved = fabrik(sm, P, 30);
      }
      void lim; void lastJoints;
      const locals = chainLocals(c, names, solved, parentRot);
      names.forEach((nm, k) => { R[bi(nm)] = locals[k]; });
    }
    fk = creatureFK(c, R, O);
    // ── props: held ones ride their chain's tip (keeping the offset they were picked up with) ──
    const heldNow: Record<string, string> = {}, gripNow: Record<string, number> = {};
    for (const p of props) {
      if (p.parent) continue;
      const pi = bi(p.id);
      const holder = a.hold[p.id] ?? null;
      const [tilt] = follow(`tilt.${p.id}`, [lerp(a.tilt[p.id]?.tilt ?? 0, b.tilt[p.id]?.tilt ?? 0, e)], dt);
      const axis = b.tilt[p.id]?.axis ?? a.tilt[p.id]?.axis ?? [0, 0, 1];
      R[pi] = qAxisAngle(axis, tilt);
      if (holder) {
        const ch = chains.find((x) => x.id === holder)!;
        const tipB = bi(`${ch.id}.${ch.segments}`);
        const tip = bonePoint(c, fk, tipB, c.bones[tipB].tail);
        if (!holdState[p.id] || holdState[p.id]!.chain !== holder) holdState[p.id] = { chain: holder, offset: sub(add(c.bones[pi].head, propWorld[p.id]), tip) };
        O[pi] = sub(add(tip, holdState[p.id]!.offset), c.bones[pi].head);
        heldNow[p.id] = holder;
        gripNow[p.id] = r3(len(holdState[p.id]!.offset));
      } else { holdState[p.id] = null; O[pi] = [...propWorld[p.id]] as V3; }
      propWorld[p.id] = [...O[pi]] as V3;
    }
    // effects ride their parent, stay upright, and show or hide
    for (const p of props) {
      if (!p.parent || !p.fx) continue;
      const vis = (u >= 1 ? b.fx[p.id] : a.fx[p.id]) ? 1 : 0;      // on from its key until the key that turns it off
      const pi = bi(p.id), par = bi(p.parent);
      O[pi] = mul(p.fx.hide, 1 - vis);
      R[pi] = qInv(R[par]);
    }
    rot.push(R); off.push(O); contacts.push(down); held.push(heldNow); grip.push(gripNow);
  }
  const notes = [`${spec.label}: ${states.length} key moments, tempo ×${r3(tempo)}, weight ${r3(W)}, size ×${r3(S)}`, ...changes];
  if (spec.asymmetric) notes.push('asymmetric wings');
  return {
    id, kind: 'action', fps, frames, duration, loop: false, speed: 0, dir: [0, 0, 1], rot, off, contacts, notes, reachMiss, endPose, held, grip,
    keys: states.map((s) => ({ t: r3(s.t), label: s.label })),
  };
}

// ── prop checks ──────────────────────────────────────────────────────────────────────────────────

function shapeBottom(s: PartShape): number {
  switch (s.kind) {
    case 'box': return s.c[1] - s.size[1] / 2;
    case 'ball': return s.c[1] - s.r * (s.scale?.[1] ?? 1);
    case 'seg': {
      // the cross-section's reach downward: none for an upright cylinder, its radius lying flat
      const d = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
      const k = Math.sqrt(Math.max(0, 1 - (d[1] / l) ** 2));
      return Math.min(s.a[1] - s.r1 * k, s.b[1] - s.r2 * k);
    }
    case 'wheel': return s.c[1] - s.r;
    case 'blade': return Math.min(s.a[1], s.b[1]);
  }
}

/** Props: a held prop stays in its grip; one that isn't held rests upright on the ground or on a surface. */
export function propChecks(c: Creature, clip: CreatureClip, _fks: FK[]): MotionCheck[] {
  const props = c.def.parts.filter((p): p is PropPartSpec => p.kind === 'prop' && !p.parent);
  if (!props.length) return [];
  const F = clip.frames + 1;
  const out: MotionCheck[] = [];
  const ranges = (bad: boolean[]) => { const r: Array<[number, number]> = []; let s = -1; bad.forEach((x, i) => { if (x && s < 0) s = i; if (!x && s >= 0) { r.push([s, i - 1]); s = -1; } }); if (s >= 0) r.push([s, bad.length - 1]); return r; };
  const gb = new Array(F).fill(false);
  let gw = 0;
  for (let f = 0; f < F; f++) for (const v of Object.values(clip.grip?.[f] ?? {})) { if (v > 0.025) gb[f] = true; gw = Math.max(gw, v); }
  if (clip.held?.some((h) => Object.keys(h).length)) out.push({ name: 'held props stay in the grip', pass: !gb.some(Boolean), worst: r3(gw), limit: 0.025, unit: 'm', frames: ranges(gb), detail: 'a picked-up prop sits at the tip that holds it (it doesn\'t float beside it)' });
  const rb = new Array(F).fill(false);
  let rw = 0, who = '';
  const surfaces = props.filter((p) => p.surface !== undefined);
  for (const p of props) {
    const bottom0 = Math.min(...p.shapes.map((s) => shapeBottom(s.shape)));
    const pi = c.index.get(p.id)!;
    for (let f = 0; f < F; f++) {
      if (clip.held?.[f]?.[p.id]) continue;
      const y = bottom0 + clip.off[f][pi][1];
      const supports = [0, ...surfaces.filter((s) => s !== p).map((s) => s.surface! + clip.off[f][c.index.get(s.id)!][1])];
      const gap = Math.min(...supports.map((h) => Math.abs(y - h)));
      const tilted = qAngle(clip.rot[f][pi], qIdentity());
      if (gap > 0.015 || tilted > 4) { rb[f] = true; if (gap > rw) { rw = gap; who = p.id; } }
    }
  }
  out.push({ name: 'props rest on something', pass: !rb.some(Boolean), worst: r3(rw), limit: 0.015, unit: 'm', frames: ranges(rb), detail: who ? `${who} floats or sinks ${r3(rw)} m, or stands tilted, while nothing holds it` : 'every prop that isn\'t held stands upright on the ground or a surface' });
  return out;
}

/** A short description of an action for tool output. */
export function describeAction(clip: CreatureClip): string {
  return `${clip.duration.toFixed(2)} s, ${clip.keys?.length ?? 0} keys: ${(clip.keys ?? []).map((k) => `${k.label}@${k.t}s`).join(', ')}`;
}

export { NOTE_HELP };
