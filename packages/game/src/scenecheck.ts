// The motion of a scripted scene, measured (studio game scene-check). A scene can pass every check of what
// happens (the beats play, the stills look right) while a body shakes on every frame: stills cannot see
// motion. The game is stepped at a fixed rate and answers a small probe every step: where each body is, the
// way it faces, its clip, a few bones, the camera. From that trace, per beat and per body:
//   teleports and snap turns inside a shot · shaking (fast back-and-forth) · pose pops (a bone that jumps
//   against its own body: a clip switched with no blend) · gliding (travelling in a standing clip, or one way
//   while facing another) · walking on the spot · planted feet sliding · feet under the floor · bodies inside
//   each other · a stated contact that is not one (a hand "on" something it does not reach) · a camera that
//   shakes or sets off at full speed.
// The per-clip checks (loops close, joints do not pop, paws keep pace: core's creature and character motion
// checks) judge a clip on its own; this judges what the game does with the clips, in the world.
// Pure: analyse a trace here, play one in sceneplay.ts.
import type { MotionCheck } from '../../core/src/rigparts.ts';
import { ranges } from '../../core/src/blender/glbmotion.ts';

type V = number[];
export interface SceneBody {
  /** world position of the body's root (metres) and its heading about the up axis (radians; forward = [sin h, 0, cos h]; a constant offset is worked out from its walks) */
  p: V; h: number;
  clip?: string;
  scale?: number;
  /** this step's clip may travel (default: the clip's name matches limits.travelClips) */
  gait?: boolean;
  /** the floor under the body (default p[1]) */
  floor?: number;
  /** a radius for "bodies inside each other" (leave out where overlap is meant: a lap, a carried prop) */
  r?: number | null;
  /** world positions of a few bones (head, hips, hands, feet) */
  bones?: Record<string, V | null>;
  /** which bones are feet (default: names with foot, toe or paw) */
  feet?: string[];
}
export interface SceneStep {
  i?: number;
  /** the beat of the script this step belongs to */
  beat: string;
  bodies: Record<string, SceneBody>;
  /** camera position and unit forward */
  cam?: { p: V; f: V } | null;
  /** the script says this step is a cut (camera jumps are found without it) */
  cut?: boolean;
  /** contacts the script claims this step: the distance from the hand (paw, mouth) to what it touches */
  contacts?: Array<{ name: string; d: number; max?: number }>;
  /** screen points (CSS px) the strips should keep in their crop */
  screen?: number[][];
}

/** Thresholds. Rates, so they hold at any step length; lengths scale with the body's `scale`. */
export const SCENE_LIMITS = {
  speed: 3,            // m/s: faster inside a shot is a teleport
  turn: 430,           // °/s: faster inside a shot is a snap turn
  shakeHz: 6,          // back-and-forth at or above this rate is shaking (a walk's bob is 2 to 3)
  shakeMove: 0.03,     // m/s each way before a reversal counts (body, and camera)
  shakeTurn: 7,        // °/s each way (heading)
  shakeBone: 0.06,     // m/s each way (a bone against its body)
  pop: 2.1,            // m/s of a bone against its own body in one step (hands and feet get 1.8 times this)
  glide: 0.15,         // m/s: travelling this fast in a clip that does not travel is gliding
  crab: 40,            // °: travelling (over 0.25 m/s) this far off the way it faces
  glideSecs: 0.25,     // s of gliding a beat may have (a blend at each end of a walk)
  spotSecs: 0.5,       // s of a walking clip with no travel
  slideRatio: 0.35,    // planted-foot slide over distance travelled
  slideMin: 0.15,      // m of slide before the ratio counts
  sink: 0.03,          // m a foot may go under its floor
  overlap: 0.03,       // m two bodies may be inside each other
  reach: 0.06,         // m from a hand to what it touches (a contact's own `max` wins)
  camStart: 1,         // m/s the camera's speed may change in one step inside a shot
  travelClips: 'walk|trot|run|jog|sprint|gallop|zoomies|crawl|jump|hop|leap|fall|climb|swim|fly|carried|ride',
  strideClips: 'walk|trot|run|jog|sprint|gallop|zoomies',
};
export type SceneLimits = typeof SCENE_LIMITS & { bodies?: Record<string, Partial<{ speed: number; turn: number; pop: number }>> };

export interface SceneCheck extends MotionCheck { beat: string; body: string; advisory?: boolean }
export interface SceneReport {
  pass: boolean; dt: number; steps: number; secs: number;
  beats: Record<string, { secs: number; cuts: number; clipSwitches: number; bodies: Record<string, Record<string, number | string>>; cam?: Record<string, number> }>;
  totals: Record<string, number>;
  checks: SceneCheck[];
  /** one line per failed check: "beat / body: name — detail (steps a–b)" */
  fails: string[];
  /** which shot every step is in (a new one at each cut and each beat) */
  shot: number[];
}

const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const distH = (a: V, b: V) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const ang = (a: number, b: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const DEG = 180 / Math.PI;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const r2 = (x: number) => +x.toFixed(2), r3 = (x: number) => +x.toFixed(3);

/** Steps where a number reverses fast: at least shakeHz back-and-forths a second over a 0.4 s window. */
function shaking(vals: Array<number | null>, cut: boolean[], epsPerStep: number, dt: number, hz: number): boolean[] {
  const n = vals.length, rev = new Array<boolean>(n).fill(false), bad = new Array<boolean>(n).fill(false);
  for (let i = 2; i < n; i++) {
    if (cut[i] || cut[i - 1]) continue;
    const a = vals[i - 2], b = vals[i - 1], c = vals[i];
    if (a == null || b == null || c == null) continue;
    const v0 = b - a, v1 = c - b;
    if (v0 * v1 < 0 && Math.min(Math.abs(v0), Math.abs(v1)) > epsPerStep) rev[i] = true;
  }
  const W = Math.max(4, Math.round(0.4 / dt)), need = Math.max(3, Math.ceil(2 * hz * W * dt));
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (rev[i]) count++;
    if (i >= W && rev[i - W]) count--;
    if (count >= need) for (let k = Math.max(0, i - W + 1); k <= i; k++) if (rev[k]) bad[k] = true;
  }
  return bad;
}
const any = (...arrs: boolean[][]) => arrs[0].map((_, i) => arrs.some((a) => a[i]));

/** Analyse a trace of fixed steps. `dt` is the step in seconds. */
export function analyseScene(tr: SceneStep[], dt = 1 / 30, limits: Partial<SceneLimits> = {}): SceneReport {
  const L: SceneLimits = { ...SCENE_LIMITS, ...limits };
  const n = tr.length, id = (k: number) => tr[k].i ?? k;
  const travels = new RegExp(L.travelClips, 'i'), strides = new RegExp(L.strideClips, 'i');
  // cuts: said by the script, or the camera jumps, or steps are missing
  const cut = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    const a = tr[i - 1].cam, b = tr[i].cam;
    const jump = a && b ? dist(a.p, b.p) > 7.5 * dt || a.f[0] * b.f[0] + a.f[1] * b.f[1] + a.f[2] * b.f[2] < Math.cos(12 / DEG) : !!a !== !!b;
    cut[i] = !!tr[i].cut || jump || id(i) !== id(i - 1) + 1;
  }
  if (n) cut[0] = true;
  const shot = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) shot[i] = shot[i - 1] + (cut[i] || tr[i].beat !== tr[i - 1].beat ? 1 : 0);
  const beats: string[] = [], names: string[] = [];
  for (const s of tr) { if (!beats.includes(s.beat)) beats.push(s.beat); for (const k of Object.keys(s.bodies ?? {})) if (!names.includes(k)) names.push(k); }

  const checks: SceneCheck[] = [];
  const report: SceneReport = { pass: true, dt, steps: n, secs: r2(n * dt), beats: {}, totals: {}, checks, fails: [], shot };
  for (const b of beats) report.beats[b] = { secs: r2(tr.filter((s) => s.beat === b).length * dt), cuts: tr.filter((s, i) => s.beat === b && cut[i] && i > 0).length, clipSwitches: 0, bodies: {} };
  const inBeat = (b: string) => tr.map((s) => s.beat === b);
  const stepRanges = (bad: boolean[]) => ranges(bad).map(([a, z]) => [id(a), id(z)] as [number, number]);
  /** one check per beat: `bad` marks steps; `pass` (given the beat's bad count and the beat's steps) decides */
  const add = (name: string, body: string, bad: boolean[], val: number[], limit: number, unit: string, detail: (worst: number, count: number, beat: string) => string, o: { advisory?: boolean; pass?: (count: number, mask: boolean[]) => boolean; worst?: (mask: boolean[]) => number; metric?: string } = {}) => {
    for (const beat of beats) {
      const mask = inBeat(beat), here = bad.map((x, i) => x && mask[i]), count = here.filter(Boolean).length;
      const worst = o.worst ? o.worst(mask) : val.reduce((m, v, i) => (mask[i] && v > m ? v : m), 0);
      const pass = o.pass ? o.pass(count, mask) : count === 0;
      const key = o.metric ?? name;
      if (body && body !== 'camera' && !body.includes('+')) (report.beats[beat].bodies[body] ??= {})[key] = o.worst ? r2(worst) : count;
      report.totals[key] = unit === 'of travel' ? r2(Math.max(report.totals[key] ?? 0, worst)) : r2((report.totals[key] ?? 0) + (o.worst ? worst : count));
      if (!count && pass) continue;
      checks.push({ name, beat, body, pass, worst: r3(worst), limit, unit, frames: pass ? [] : stepRanges(here), detail: detail(worst, count, beat), ...(o.advisory ? { advisory: true } : {}) });
    }
  };

  for (const who of names) {
    const B = tr.map((s) => s.bodies?.[who] ?? null);
    const lim = { speed: L.speed, turn: L.turn, pop: L.pop, ...(L.bodies?.[who] ?? {}) };
    const hv = new Array<number>(n).fill(0), isGait = B.map((b) => !!b && (b.gait ?? travels.test(b.clip ?? ''))), isStride = B.map((b) => !!b && strides.test(b.clip ?? ''));
    for (let i = 1; i < n; i++) if (B[i] && B[i - 1]) hv[i] = distH(B[i - 1]!.p, B[i]!.p) / dt;
    // the turn between the heading the probe gives and the way the body really walks
    const offs: number[] = [];
    for (let i = 1; i < n; i++) if (B[i] && B[i - 1] && !cut[i] && isStride[i] && hv[i] > 0.5) offs.push(ang(B[i]!.h, Math.atan2(B[i]!.p[0] - B[i - 1]!.p[0], B[i]!.p[2] - B[i - 1]!.p[2])));
    const hOff = median(offs) ?? 0;

    const tele = new Array<boolean>(n).fill(false), teleV = new Array<number>(n).fill(0), snap = new Array<boolean>(n).fill(false), snapV = new Array<number>(n).fill(0);
    const pop = new Array<boolean>(n).fill(false), popV = new Array<number>(n).fill(0), popN = new Array<number>(n).fill(0), popWho = new Array<string>(n).fill('');
    const glide = new Array<boolean>(n).fill(false), spot = new Array<boolean>(n).fill(false);
    for (let i = 1; i < n; i++) {
      const a = B[i - 1], b = B[i];
      if (!a || !b) continue;
      if ((a.clip ?? '') !== (b.clip ?? '')) report.beats[tr[i].beat].clipSwitches++;
      if (cut[i]) continue;
      const sc = b.scale ?? 1, turn = Math.abs(ang(a.h, b.h));
      teleV[i] = dist(a.p, b.p) / dt; tele[i] = teleV[i] > lim.speed * Math.max(1, sc);
      snapV[i] = turn * DEG / dt; snap[i] = snapV[i] > lim.turn;
      if (!tele[i] && Math.abs((a.scale ?? 1) - sc) < 0.002) for (const k of Object.keys(b.bones ?? {})) {
        const p0 = a.bones?.[k], p1 = b.bones![k];
        if (!p0 || !p1) continue;
        const r0 = [p0[0] - a.p[0], p0[1] - a.p[1], p0[2] - a.p[2]], r1 = [p1[0] - b.p[0], p1[1] - b.p[1], p1[2] - b.p[2]];
        const d = (dist(r0, r1) - turn * Math.hypot(r1[0], r1[2])) / dt / sc, end = /hand|wrist|paw|foot|toe/i.test(k) ? 1.8 : 1;
        if (d / end > popN[i]) { popN[i] = d / end; popV[i] = d; popWho[i] = k; }
        if (d > lim.pop * end) pop[i] = true;
      }
      // gliding: travelling in a clip that stands, or one way while facing another
      const off = hv[i] > 0.25 ? Math.abs(ang(b.h + hOff, Math.atan2(b.p[0] - a.p[0], b.p[2] - a.p[2]))) * DEG : 0;
      glide[i] = !tele[i] && ((hv[i] > L.glide * sc && !isGait[i]) || (isStride[i] && off > L.crab));
      spot[i] = isStride[i] && hv[i] < 0.05 * sc;
    }
    add('no teleports', who, tele, teleV, lim.speed, 'm/s', (w, c) => `${who} moves ${(w * dt).toFixed(2)} m in one step, ${c} time(s), inside a shot`);
    add('no snap turns', who, snap, snapV, lim.turn, '°/s', (w, c) => `${who} turns ${(w * dt).toFixed(0)}° in one step, ${c} time(s): ease the heading`);
    const axes = [0, 1, 2].map((k) => shaking(B.map((b) => (b ? b.p[k] : null)), cut, L.shakeMove * dt, dt, L.shakeHz));
    // the heading unwrapped, so a turn through ±180° is not a reversal
    const hs: Array<number | null> = []; { let acc = 0; for (let i = 0; i < n; i++) { const b = B[i]; if (!b) { hs.push(null); continue; } const prev = i > 0 ? B[i - 1] : null; if (prev) acc += ang(prev.h, b.h); else acc = b.h; hs.push(acc); } }
    const shH = shaking(hs, cut, L.shakeTurn / DEG * dt, dt, L.shakeHz);
    add('no shake', who, any(...axes, shH), [], L.shakeHz, 'Hz', (_w, c) => `${who}'s ${axes.some((a) => a.some(Boolean)) ? 'position' : 'heading'} reverses on ${c} step(s) at ${L.shakeHz} Hz or more: two things are moving it (one owner per body)`);
    const boneNames = [...new Set(B.flatMap((b) => Object.keys(b?.bones ?? {})))];
    if (boneNames.length) {
      const bs = boneNames.flatMap((k) => [0, 1, 2].map((ax) => shaking(B.map((b) => { const q = b?.bones?.[k]; return b && q ? (q[ax] - b.p[ax]) / (b.scale ?? 1) : null; }), cut, L.shakeBone * dt, dt, L.shakeHz)));
      add('no bone shake', who, any(...bs), [], L.shakeHz, 'Hz', (_w, c) => `a bone of ${who} reverses on ${c} step(s) (fine for small fast work such as typing or eating; look at the strip)`, { advisory: true });
      add('no pose pops', who, pop, popV, lim.pop, 'm/s', (w, _c, beat) => { const i = Math.max(1, popV.findIndex((v, k) => v === w && tr[k].beat === beat)); return `${who}'s ${popWho[i] || 'bone'} jumps ${(w * dt * 100).toFixed(0)} cm against the body in one step (${B[i - 1]?.clip ?? '?'} → ${B[i]?.clip ?? '?'}): a clip switched with no blend, or a part clip played as the whole body`; });
    }
    add('no gliding', who, glide, hv, L.glideSecs, 's', (_w, c) => `${who} travels ${(c * dt).toFixed(2)} s in a clip that does not travel, or off the way it faces`, { pass: (c) => c * dt <= L.glideSecs, worst: (m) => glide.filter((x, i) => x && m[i]).length * dt, metric: 'glide s' });
    add('no walking on the spot', who, spot, [], L.spotSecs, 's', (_w, c) => `${who} plays a walking clip for ${(c * dt).toFixed(2)} s without moving`, { pass: (c) => c * dt <= L.spotSecs, worst: (m) => spot.filter((x, i) => x && m[i]).length * dt, metric: 'on the spot s' });

    // feet: the lower foot, while it is down, should stay where it is; no foot under its floor
    const feet = B.find((b) => b?.feet)?.feet ?? boneNames.filter((k) => /foot|toe|paw/i.test(k));
    if (feet.length) {
      const low = (b: SceneBody | null): [string, number] | null => { if (!b) return null; let best: [string, number] | null = null; for (const k of feet) { const q = b.bones?.[k]; if (q && (!best || q[1] - (b.floor ?? b.p[1]) < best[1])) best = [k, q[1] - (b.floor ?? b.p[1])]; } return best; };
      const lows = B.map(low);
      const walking = lows.filter((l, i) => l && isStride[i] && hv[i] > 0.5).map((l) => l![1]);
      const sole = median(walking.length ? walking : lows.filter(Boolean).map((l) => l![1])) ?? 0;
      const slide = new Array<number>(n).fill(0), slip = new Array<boolean>(n).fill(false), sink = new Array<boolean>(n).fill(false), sinkV = new Array<number>(n).fill(0), trav = new Array<number>(n).fill(0);
      for (let i = 1; i < n; i++) {
        const a = B[i - 1], b = B[i], l0 = lows[i - 1], l1 = lows[i];
        if (!a || !b || !l0 || !l1) continue;
        const sc = b.scale ?? 1;
        if (sole - l1[1] > L.sink * sc) { sink[i] = true; sinkV[i] = sole - l1[1]; }
        if (cut[i] || tele[i]) continue;
        trav[i] = hv[i] * dt;
        const f0 = a.bones![l1[0]], f1 = b.bones![l1[0]];
        if (f0 && f1 && hv[i] > 0.1 * sc && l1[1] - sole < 0.02 * sc && f0[1] - (a.floor ?? a.p[1]) - sole < 0.02 * sc) { slide[i] = distH(f0, f1); slip[i] = slide[i] > 0.5 * trav[i]; }
      }
      const sum = (xs: number[], m: boolean[]) => xs.reduce((t, v, i) => t + (m[i] ? v : 0), 0);
      add('planted feet hold', who, slip, [], L.slideRatio, 'of travel', (w, _c, beat) => { const m = inBeat(beat); return `${who}'s planted foot slides ${sum(slide, m).toFixed(2)} m over ${sum(trav, m).toFixed(2)} m of travel (${(w * 100).toFixed(0)}%): the clip's stride does not match the speed`; }, { pass: (_c, m) => { const s = sum(slide, m); return !(s > L.slideMin && s / (sum(trav, m) || 1) > L.slideRatio); }, worst: (m) => sum(slide, m) / (sum(trav, m) || 1), metric: 'foot slide' });
      add('feet above the floor', who, sink, sinkV, L.sink, 'm', (w) => `a foot of ${who} goes ${(w * 100).toFixed(1)} cm under its floor`);
    }
  }

  // bodies inside each other (those that give a radius)
  for (let x = 0; x < names.length; x++) for (let y = x + 1; y < names.length; y++) {
    const bad = new Array<boolean>(n).fill(false), val = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const a = tr[i].bodies?.[names[x]], b = tr[i].bodies?.[names[y]];
      if (!a || !b || a.r == null || b.r == null || Math.abs(a.p[1] - b.p[1]) > 0.5) continue;
      val[i] = a.r * (a.scale ?? 1) + b.r * (b.scale ?? 1) - distH(a.p, b.p); bad[i] = val[i] > L.overlap;
    }
    if (bad.some(Boolean)) add('bodies apart', `${names[x]}+${names[y]}`, bad, val, L.overlap, 'm', (w) => `${names[x]} and ${names[y]} are ${(w * 100).toFixed(0)} cm inside each other`);
  }
  // stated contacts: the hand is where the script says it is
  const contactNames = [...new Set(tr.flatMap((s) => (s.contacts ?? []).map((c) => c.name)))];
  for (const cn of contactNames) {
    const bad = new Array<boolean>(n).fill(false), val = new Array<number>(n).fill(0); let seen = 0;
    tr.forEach((s, i) => { const c = s.contacts?.find((q) => q.name === cn); if (!c) return; seen++; val[i] = c.d; bad[i] = c.d > (c.max ?? L.reach); });
    report.totals[`contact ${cn} steps`] = seen;
    add('hands reach', cn, bad, val, L.reach, 'm', (w) => `${cn}: ${(w * 100).toFixed(0)} cm from what it touches: move the stand point until it reaches`, { metric: `contact ${cn} misses` });
  }
  // the camera
  if (tr.some((s) => s.cam)) {
    const C = tr.map((s) => s.cam ?? null);
    const sh = any(...[0, 1, 2].flatMap((k) => [shaking(C.map((c) => (c ? c.p[k] : null)), cut, L.shakeMove * dt, dt, L.shakeHz), shaking(C.map((c) => (c ? c.f[k] : null)), cut, L.shakeMove * dt, dt, L.shakeHz)]));
    add('camera steady', 'camera', sh, [], L.shakeHz, 'Hz', (_w, c) => `the camera reverses on ${c} step(s): one lean, not a shake`, { metric: 'camera shake' });
    const sp = new Array<number>(n).fill(0), jerk = new Array<boolean>(n).fill(false), jv = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) if (C[i] && C[i - 1] && !cut[i]) sp[i] = dist(C[i - 1]!.p, C[i]!.p) / dt;
    for (let i = 2; i < n; i++) if (!cut[i] && !cut[i - 1]) { jv[i] = Math.abs(sp[i] - sp[i - 1]); jerk[i] = jv[i] > L.camStart; }
    add('camera eases', 'camera', jerk, jv, L.camStart, 'm/s per step', (w) => `the camera's speed changes by ${w.toFixed(1)} m/s in one step: ease it out and in`, { metric: 'camera jolts' });
    for (const b of beats) { const m = inBeat(b); report.beats[b].cam = { maxSpeed: r2(sp.reduce((t, v, i) => (m[i] && v > t ? v : t), 0)) }; }
  }

  for (const c of checks) if (!c.pass && !c.advisory) { report.pass = false; report.fails.push(`${c.beat} / ${c.body}: ${c.name}: ${c.detail} (steps ${c.frames.map(([a, z]) => (a === z ? a : `${a}–${z}`)).slice(0, 6).join(', ')}${c.frames.length > 6 ? ', …' : ''})`); }
  return report;
}

/** The report as text: a line per beat and body, then what failed. */
export function sceneText(rep: SceneReport, label = 'scene'): string {
  const out = [`SCENE MOTION ${label}: ${rep.pass ? 'ok' : 'FAILS'} (${rep.steps} steps of 1/${Math.round(1 / rep.dt)} s, ${rep.secs} s)`, ''];
  for (const [beat, m] of Object.entries(rep.beats)) {
    out.push(`── ${beat}  [${m.secs} s, ${m.cuts} cut(s), ${m.clipSwitches} clip switch(es)${m.cam ? `, camera up to ${m.cam.maxSpeed} m/s` : ''}]`);
    for (const [who, v] of Object.entries(m.bodies)) out.push(`   ${who}: ${Object.entries(v).map(([k, x]) => `${k.replace(/^no /, '')} ${x}`).join('  ')}`);
  }
  out.push('', rep.fails.length ? 'FAILS' : 'no fails', ...rep.fails.map((f) => '  ' + f));
  const adv = rep.checks.filter((c) => c.advisory && !c.pass);
  if (adv.length) out.push('', 'LOOK AT (not a fail by itself)', ...adv.map((c) => `  ${c.beat} / ${c.body}: ${c.detail}`));
  return out.join('\n');
}

/** Two reports side by side (before → after), by total. */
export function compareScenes(a: SceneReport, b: SceneReport): string {
  const keys = [...new Set([...Object.keys(a.totals), ...Object.keys(b.totals)])];
  return [`${'total'.padEnd(28)} ${'before'.padStart(9)} ${'after'.padStart(9)}`, `${'seconds'.padEnd(28)} ${String(a.secs).padStart(9)} ${String(b.secs).padStart(9)}`, ...keys.map((k) => `${k.replace(/^no /, '').padEnd(28)} ${String(a.totals[k] ?? '-').padStart(9)} ${String(b.totals[k] ?? '-').padStart(9)}`)].join('\n');
}
