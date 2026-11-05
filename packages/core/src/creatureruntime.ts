// The live runtime for interactive parts (Decision 53 B): what a game runs when a creature is steered
// by the player or wanders over ground the bake never saw. Legs plant their feet in the world and step
// when a foot falls too far behind its home under the hip (reach-triggered, one gait group at a time);
// the body rides the planted feet. Wheels roll at ground speed, the front ones steer, and the body
// floats on damped springs over whatever is under each tyre. Everything else (tails, springs, hinges,
// grass) plays from a baked clip layered on top. Pure TypeScript, no engine: three.js, a web game or a
// test can drive it. Godot gets the baked clips (see the Phase 8 notes).
import { qAxisAngle, qIdentity, qMul, qRot, type Q, type V3 } from './rig.ts';
import { qInv } from './motion.ts';
import { chainLocals, gaitPhase, legPole, sampleClip, twoBoneKnee, type Creature, type CreatureClip, type LegsPartSpec, type WheelsPartSpec } from './rigparts.ts';

const D2R = Math.PI / 180, TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (u: number) => { const t = clamp(u); return t * t * (3 - 2 * t); };

export interface RuntimeInput {
  speed: number;                    // m/s along the creature's facing (+Z), or along `strafe` for legs
  turn?: number;                    // legs: yaw rate (deg/s); wheels: steering angle (deg, + is left)
  strafe?: V3;                      // legs: travel direction in the creature's frame (a crab: [1,0,0])
}
export interface RuntimePose { rot: Q[]; off: V3[]; pos: V3; yaw: number; down: boolean[]; reachMiss: number }

interface LegState { plant: V3; down: boolean; from: V3; to: V3; u: number; group: number }

export class CreatureRuntime {
  readonly c: Creature;
  pos: V3 = [0, 0, 0];
  yaw = 0;                          // radians about +Y
  t = 0;
  private ground: (x: number, z: number) => number;
  private layer?: CreatureClip;
  private legs: LegState[] = [];
  private legSpec?: LegsPartSpec;
  private wheels?: WheelsPartSpec;
  private body = { y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0 };
  private spin = 0;
  private stepTime = 0.3;
  private stepTrigger = 0.1;
  private bi: (n: string) => number;

  constructor(c: Creature, opts: { ground?: (x: number, z: number) => number; layer?: CreatureClip; pos?: V3; yaw?: number } = {}) {
    this.c = c;
    this.ground = opts.ground ?? (() => 0);
    this.layer = opts.layer;
    if (opts.pos) this.pos = [...opts.pos] as V3;
    this.yaw = opts.yaw ?? 0;
    this.bi = (n) => c.index.get(n)!;
    this.legSpec = c.def.parts.find((p): p is LegsPartSpec => p.kind === 'legs');
    this.wheels = c.def.parts.find((p): p is WheelsPartSpec => p.kind === 'wheels');
    if (this.legSpec) {
      const reach = this.legSpec.upper + this.legSpec.lower;
      this.stepTrigger = reach * 0.22;
      this.stepTime = 0.12 + reach * 0.35;
    }
    for (const leg of c.legs) {
      const w = this.toWorld(leg.foot);
      const p: V3 = [w[0], this.ground(w[0], w[2]), w[2]];
      this.legs.push({ plant: p, down: true, from: p, to: p, u: 0, group: gaitPhase(this.legSpec?.count ?? 2, leg.pair, leg.side) < 0.25 ? 0 : 1 });
    }
    const bodyGround = this.groundUnderBody();
    this.body.y = bodyGround;
  }

  /** Creature-frame point → world (ignores the body's bob; the root frame only). */
  toWorld(p: V3): V3 { return add(this.pos, qRot(qAxisAngle([0, 1, 0], this.yaw / D2R), p)); }
  toLocal(p: V3): V3 { return qRot(qAxisAngle([0, 1, 0], -this.yaw / D2R), sub(p, this.pos)); }

  private groundUnderBody(): number {
    if (!this.legs.length) return 0;
    return this.legs.reduce((s, l) => s + this.toLocal(l.plant)[1], 0) / this.legs.length;
  }

  step(dt: number, input: RuntimeInput): RuntimePose {
    const c = this.c;
    const n = c.bones.length;
    this.t += dt;
    const base = this.layer ? sampleClip(this.layer, this.t) : null;
    const R: Q[] = base ? base.rot.map((q) => [...q] as Q) : Array.from({ length: n }, () => qIdentity());
    const O: V3[] = base ? base.off.map((o) => [...o] as V3) : Array.from({ length: n }, () => [0, 0, 0] as V3);
    const down: boolean[] = new Array(c.contacts.length).fill(false);
    let reachMiss = 0;
    const B = this.bi('Body');
    const bodyRest = c.bones[B].head;

    // ── move the root ──
    if (this.wheels) {
      const front = Math.max(...this.wheels.axles.map((a) => a.z)), back = Math.min(...this.wheels.axles.map((a) => a.z));
      const wb = Math.max(0.1, front - back);
      const steer = (input.turn ?? 0) * D2R;
      this.yaw += (input.speed * Math.tan(steer) / wb) * dt;           // bicycle model about the rear axle
    } else this.yaw += (input.turn ?? 0) * D2R * dt;
    const dirL: V3 = input.strafe ? (() => { const l = len(input.strafe!) || 1; return mul(input.strafe!, 1 / l); })() : [0, 0, 1];
    const vel = qRot(qAxisAngle([0, 1, 0], this.yaw / D2R), mul(dirL, input.speed));
    this.pos = add(this.pos, mul(vel, dt));
    this.pos[1] = 0;

    // ── legs: plant, trigger a step when a foot lags its home, the body rides the feet ──
    if (this.legSpec && this.legs.length) {
      const lp = this.legSpec;
      const swinging = this.legs.filter((l) => !l.down);
      const busyGroup = swinging.length ? swinging[0].group : -1;
      // homes: under the hips, a little ahead along the velocity so a step lands past centre
      const lead = mul(vel, this.stepTime * 0.6);
      const homes = c.legs.map((leg) => { const w = add(this.toWorld(leg.foot), lead); return [w[0], this.ground(w[0], w[2]), w[2]] as V3; });
      // the group whose feet lag most steps first (the other group holds the body)
      const lagOf = (g: number) => Math.max(0, ...this.legs.map((l, i) => (l.group === g && l.down ? len(sub(l.plant, homes[i])) : 0)));
      const wantGroup = busyGroup >= 0 ? -1 : (lagOf(0) >= lagOf(1) ? 0 : 1);
      if (wantGroup >= 0 && lagOf(wantGroup) > this.stepTrigger) {
        this.legs.forEach((l, i) => { if (l.group === wantGroup && len(sub(l.plant, homes[i])) > this.stepTrigger * 0.3) { l.down = false; l.u = 0; l.from = l.plant; } });
      }
      const feet: V3[] = [];
      this.legs.forEach((l, i) => {
        if (!l.down) {
          l.to = homes[i];
          l.u += dt / this.stepTime;
          if (l.u >= 1) { l.down = true; l.plant = l.to; }
        }
        const p = l.down ? l.plant : (() => { const s = smooth(l.u); const q = lerp3(l.from, l.to, s); q[1] += Math.sin(Math.PI * l.u) * (lp.lift ?? 0.35) * lp.upper; return q; })();
        feet.push(p);
      });
      // body: mean planted height, tilted to the feet's plane, smoothed by a spring
      const loc = feet.map((p) => this.toLocal(p));
      const planted = this.legs.map((l, i) => ({ l, p: loc[i], leg: c.legs[i] })).filter((x) => x.l.down);
      const meanY = (xs: typeof planted) => xs.reduce((s, x) => s + x.p[1], 0) / Math.max(1, xs.length);
      const meanZ = (xs: typeof planted) => xs.reduce((s, x) => s + x.leg.foot[2], 0) / Math.max(1, xs.length);
      const meanX = (xs: typeof planted) => xs.reduce((s, x) => s + x.leg.foot[0], 0) / Math.max(1, xs.length);
      const fr = planted.filter((x) => x.leg.foot[2] > 0), bk = planted.filter((x) => x.leg.foot[2] < 0);
      const lf = planted.filter((x) => x.leg.side > 0), rt = planted.filter((x) => x.leg.side < 0);
      const tY = meanY(planted);
      const tP = fr.length && bk.length ? -Math.atan2(meanY(fr) - meanY(bk), meanZ(fr) - meanZ(bk)) / D2R * 0.8 : this.body.pitch;
      const tR = lf.length && rt.length ? Math.atan2(meanY(lf) - meanY(rt), meanX(lf) - meanX(rt)) / D2R * 0.8 : this.body.roll;
      this.spring(dt, tY, tP, tR, 3.2, 0.9);
      O[B] = [0, this.body.y, 0];
      R[B] = qMul(qAxisAngle([1, 0, 0], this.body.pitch), qAxisAngle([0, 0, 1], this.body.roll));
      const bHead = add(bodyRest, O[B]);
      c.legs.forEach((leg, i) => {
        const hipB = c.bones[this.bi(leg.hip)], kneeB = c.bones[this.bi(leg.knee)];
        const hipL = add(bHead, qRot(R[B], sub(hipB.head, bodyRest)));
        const l1 = len(sub(hipB.tail, hipB.head)), l2 = len(sub(kneeB.tail, kneeB.head));
        const ik = twoBoneKnee(hipL, loc[i], l1, l2, legPole(leg, R[B]));
        reachMiss = Math.max(reachMiss, ik.miss);
        const locals = chainLocals(c, [leg.hip, leg.knee], [hipL, ik.knee, ik.foot], R[B]);
        R[this.bi(leg.hip)] = locals[0];
        R[this.bi(leg.knee)] = locals[1];
        c.contacts.forEach((cd, ci) => { if (cd.bone === leg.knee) down[ci] = this.legs[i].down; });
      });
    }

    // ── wheels: hubs on the ground under each tyre, the body on springs, front wheels steer ──
    if (this.wheels) {
      const w = this.wheels;
      const hubs = c.contacts.filter((cd) => cd.kind === 'wheel').map((cd) => {
        const wi = this.bi(cd.bone), si = c.parents[wi];
        const g = this.toWorld(cd.at);
        return { wi, si, at: c.bones[wi].head, ground: this.ground(g[0], g[2]) };
      });
      const mean = (xs: typeof hubs) => xs.reduce((s, h) => s + h.ground, 0) / Math.max(1, xs.length);
      const fz = hubs.filter((h) => h.at[2] > 0), bz = hubs.filter((h) => h.at[2] <= 0);
      const lx = hubs.filter((h) => h.at[0] > 0), rx = hubs.filter((h) => h.at[0] <= 0);
      const wb = Math.max(0.1, (fz[0]?.at[2] ?? 0) - (bz[0]?.at[2] ?? 0)), tr = Math.max(0.1, (lx[0]?.at[0] ?? 0) - (rx[0]?.at[0] ?? 0));
      this.spring(dt, mean(hubs), -Math.atan2(mean(fz) - mean(bz), wb) / D2R, Math.atan2(mean(lx) - mean(rx), tr) / D2R, w.hz ?? 1.6, w.damp ?? 0.55);
      O[B] = [0, this.body.y, 0];
      R[B] = qMul(qAxisAngle([1, 0, 0], this.body.pitch), qAxisAngle([0, 0, 1], this.body.roll));
      const bHead = add(bodyRest, O[B]);
      const r = w.axles[0].r;
      this.spin += (input.speed * dt) / r / D2R;
      const steer = input.turn ?? 0;
      const upW = qRot(R[B], [0, 1, 0]);
      for (const h of hubs) {
        const top = add(bHead, qRot(R[B], sub(c.bones[h.si].head, bodyRest)));
        const slide = (h.ground + h.at[1] - top[1]) / Math.max(0.2, upW[1]);
        O[h.si] = [0, clamp(slide, -w.travel * 1.5, w.travel * 1.5), 0];
        R[h.si] = h.at[2] > 0 ? qMul(qInv(R[B]), qAxisAngle([0, 1, 0], steer)) : qInv(R[B]);
        R[h.wi] = qAxisAngle([1, 0, 0], this.spin % 360);
      }
      c.contacts.forEach((cd, ci) => { if (cd.kind === 'wheel') down[ci] = true; });
    }
    return { rot: R, off: O, pos: [...this.pos] as V3, yaw: this.yaw, down, reachMiss };
  }

  /** Where each planted foot is in the world (for tests: planted feet never move). */
  plants(): Array<{ at: V3; down: boolean }> { return this.legs.map((l) => ({ at: [...l.plant] as V3, down: l.down })); }

  private spring(dt: number, y: number, pitch: number, roll: number, hz: number, damp: number) {
    const w0 = TAU * hz, z = damp;
    const s = (x: number, v: number, tg: number): [number, number] => { const a = -w0 * w0 * (x - tg) - 2 * z * w0 * v; const nv = v + a * dt; return [x + nv * dt, nv]; };
    [this.body.y, this.body.vy] = s(this.body.y, this.body.vy, y);
    [this.body.pitch, this.body.vp] = s(this.body.pitch, this.body.vp, pitch);
    [this.body.roll, this.body.vr] = s(this.body.roll, this.body.vr, roll);
  }
}
