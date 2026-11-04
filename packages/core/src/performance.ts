// One performance per line (Decision 23): a short script — emotion, posture, gaze, gestures on words —
// compiled onto the character's own skeleton into one set of channels that share the line's beats:
// mouth (the speech shapes), face (expression shapes that follow the script's emotion, blinks and
// brow lifts), eyes (gaze and darts), hands (finger poses) and body (posture, head, arms), on top of
// the life layer (the character's idle: breathing, weight shifts). Gestures follow the shape real ones
// have — preparation, a stroke that lands just before the stressed syllable, a hold, a retraction —
// eased, with the forearm and hand trailing the upper arm, and gestures close together flow into each
// other instead of dropping to the side in between. Pure functions: line + script + rig → clip.
import { type Rig, type V3, type Q, qMul, qAxisAngle, qIdentity, handRotations, NAMED_HAND_POSES, forward } from './rig.ts';
import type { CharacterState, HandPose, LineClip, PerformanceScript, PerformanceGesture } from './types.ts';
import { bakeMotion, qSlerp, qAngle } from './motion.ts';
import { hashSeed, lineLife } from './life.ts';
import { EMOTION_SCALE } from './lipsync.ts';

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (u: number) => { const t = clamp(u); return t * t * (3 - 2 * t); };
const X = (d: number) => qAxisAngle([1, 0, 0], d);
const Y = (d: number) => qAxisAngle([0, 1, 0], d);
const Z = (d: number) => qAxisAngle([0, 0, 1], d);

/** An arm pose for the right side (mirrored for the left): how far the upper arm hangs down from the
 *  T-pose (74 ≈ at the side), swings forward, how much the elbow bends, and the wrist (wristX −60 ≈ palm up). */
export interface ArmPose { down: number; fwd: number; bend: number; wristX?: number; wristZ?: number }
export interface GestureDef {
  label: string;
  hands: 'right' | 'both' | 'none';
  arm?: ArmPose;
  hand?: string;                 // a named hand pose (open-palm, point, fist, relaxed, pinch)
  prep: number; hold: number; retract: number;   // s
  beat?: number;                 // degrees of the stroke's accent (a quick extra drop of the forearm)
  head?: { x?: number; y?: number; z?: number; shake?: number; nods?: number };   // degrees (+x = down)
  shoulders?: number;            // degrees of shoulder lift
  chest?: number;                // degrees of chest lean (+ = forward)
}

/** The gesture library: the common conversational gestures, as settings on the body kit. */
export const GESTURES: Record<string, GestureDef> = {
  'palm-down': { label: 'Palm down, pressing gently: "easy", "hold still"', hands: 'right', arm: { down: 60, fwd: 42, bend: 60, wristX: 12 }, hand: 'open-palm', prep: 0.38, hold: 0.45, retract: 0.5, beat: 5 },
  'open-palms': { label: 'Both palms open and up: explaining, offering', hands: 'both', arm: { down: 58, fwd: 30, bend: 66, wristX: -58 }, hand: 'open-palm', prep: 0.4, hold: 0.4, retract: 0.5, beat: 4 },
  point: { label: 'Point ahead (index finger): "that one", "there"', hands: 'right', arm: { down: 72, fwd: 74, bend: 10 }, hand: 'point', prep: 0.36, hold: 0.45, retract: 0.5, chest: -1 },
  present: { label: 'An open hand out, palm up: "here", "this is…"', hands: 'right', arm: { down: 60, fwd: 50, bend: 32, wristX: -60 }, hand: 'open-palm', prep: 0.38, hold: 0.45, retract: 0.5 },
  shrug: { label: 'Shrug: palms up, shoulders raised, head tilted', hands: 'both', arm: { down: 64, fwd: 12, bend: 68, wristX: -60 }, hand: 'open-palm', prep: 0.3, hold: 0.35, retract: 0.45, shoulders: 11, head: { z: 7 } },
  fist: { label: 'A loose fist that beats on the word: firm emphasis', hands: 'right', arm: { down: 66, fwd: 30, bend: 88, wristX: 18 }, hand: 'fist', prep: 0.32, hold: 0.32, retract: 0.45, beat: 10, chest: 2 },
  chop: { label: 'The edge of the hand chops down: decided, firm', hands: 'right', arm: { down: 62, fwd: 38, bend: 70, wristX: 72 }, hand: 'open-palm', prep: 0.32, hold: 0.3, retract: 0.45, beat: 12, chest: 2 },
  count: { label: 'Index finger up: "one", "first"', hands: 'right', arm: { down: 64, fwd: 28, bend: 98, wristX: -14 }, hand: 'point', prep: 0.34, hold: 0.4, retract: 0.45 },
  beckon: { label: 'Palm up, beckoning: "come here", "bring me"', hands: 'right', arm: { down: 62, fwd: 34, bend: 84, wristX: -66 }, hand: 'open-palm', prep: 0.34, hold: 0.45, retract: 0.45, beat: 9 },
  'hand-on-chest': { label: 'Hand to the chest: "I", sincerity', hands: 'right', arm: { down: 44, fwd: 28, bend: 112, wristX: 18 }, hand: 'relaxed', prep: 0.4, hold: 0.5, retract: 0.55, chest: -2 },
  'wave-off': { label: 'A dismissive flick of the hand: "never mind", "no"', hands: 'right', arm: { down: 60, fwd: 26, bend: 60, wristX: -30, wristZ: -20 }, hand: 'open-palm', prep: 0.3, hold: 0.25, retract: 0.45, beat: 14 },
  nod: { label: 'Nod: agreement, "yes", "good"', hands: 'none', prep: 0.15, hold: 0.45, retract: 0.25, head: { nods: 2, x: 7 } },
  'head-shake': { label: 'Shake the head: "no", "not"', hands: 'none', prep: 0.12, hold: 0.55, retract: 0.25, head: { shake: 9 } },
  'head-tilt': { label: 'Tilt the head: curious, gentle, a question', hands: 'none', prep: 0.3, hold: 0.6, retract: 0.4, head: { z: 9, x: -2 } },
  'look-down': { label: 'Look down for a moment: thinking, sad', hands: 'none', prep: 0.3, hold: 0.6, retract: 0.45, head: { x: 12 } },
};

/** The face for each emotion (expression shapes at full intensity); the mouth's speech shapes ride on top. */
export const EMOTION_FACE: Record<string, Record<string, number>> = {
  neutral: {},
  calm: { mouthSmileLeft: 0.12, mouthSmileRight: 0.12 },
  gentle: { mouthSmileLeft: 0.25, mouthSmileRight: 0.25, browInnerUp: 0.12 },
  firm: { browDownLeft: 0.38, browDownRight: 0.38, mouthFrownLeft: 0.08, mouthFrownRight: 0.08 },
  happy: { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, browOuterUpLeft: 0.12, browOuterUpRight: 0.12 },
  excited: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, cheekSquintLeft: 0.3, cheekSquintRight: 0.3, browInnerUp: 0.3, browOuterUpLeft: 0.35, browOuterUpRight: 0.35 },
  angry: { browDownLeft: 0.75, browDownRight: 0.75, noseSneerLeft: 0.35, noseSneerRight: 0.35, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 },
  sad: { browInnerUp: 0.6, mouthFrownLeft: 0.45, mouthFrownRight: 0.45 },
  scared: { browInnerUp: 0.7, browOuterUpLeft: 0.4, browOuterUpRight: 0.4, mouthFrownLeft: 0.15, mouthFrownRight: 0.15 },
  whisper: { browInnerUp: 0.15 },
};
/** Default posture per emotion (when the script doesn't say). */
const EMOTION_POSTURE: Record<string, NonNullable<PerformanceScript['posture']>> = { neutral: 'neutral', calm: 'neutral', gentle: 'lean-in', firm: 'upright', happy: 'upright', excited: 'upright', angry: 'proud', sad: 'slump', scared: 'guarded', whisper: 'lean-in' };
/** Posture as degrees on the spine (+x = forward), chest, neck and head, and shoulder lift. */
export const POSTURES: Record<string, { spine: number; chest: number; neck: number; head: number; shoulders: number }> = {
  neutral: { spine: 0, chest: 0, neck: 0, head: 0, shoulders: 0 },
  upright: { spine: -2, chest: -3, neck: 1, head: -1, shoulders: -1 },
  'lean-in': { spine: 5, chest: 4, neck: -4, head: -2, shoulders: 0 },
  slump: { spine: 7, chest: 6, neck: 3, head: 6, shoulders: -3 },
  proud: { spine: -3, chest: -6, neck: 2, head: -3, shoulders: -2 },
  guarded: { spine: 3, chest: 3, neck: -1, head: 2, shoulders: 5 },
};

export interface ResolvedGesture { gesture: string; hand: 'right' | 'left' | 'both' | 'none'; word?: string; target: number; stroke: number; start: number; end: number; size: number; note?: string }
export interface PerformanceClip {
  fps: number; frames: number; duration: number;
  local: Q[][];                  // [frame][bone]
  hips: V3[];                    // hips offset per frame
  shapes: Record<string, number[]>;   // every face shape per frame (speech + emotion + blinks/brows), 0..1
  gestures: ResolvedGesture[];
  notes: string[];
}

/** Words of a line with their times: start, end and the stressed syllable (from the phonemes when present). */
export function lineWords(line: Pick<LineClip, 'text' | 'duration' | 'phonemes' | 'cues'>) {
  const words = (line.text.match(/[A-Za-z0-9']+/g) ?? []).map((w) => w.toLowerCase());
  const out = words.map((w) => ({ word: w, start: NaN, end: NaN, stress: NaN }));
  const vowel = /[aeiouɑɐʌɒɔɛæɪʊəɚɜiuoy]/;
  if (line.phonemes?.length) {
    for (const p of line.phonemes) {
      const o = out[p.word];
      if (!o) continue;
      o.start = Number.isNaN(o.start) ? p.start : Math.min(o.start, p.start);
      o.end = Number.isNaN(o.end) ? p.end : Math.max(o.end, p.end);
      if (vowel.test(p.ph) && (Number.isNaN(o.stress) || p.stress === 1)) o.stress = p.start + 0.4 * (p.end - p.start);
    }
  }
  // no phonemes (or gaps): spread the words over the voiced cues by length
  const voiced = line.cues.filter((c) => c.shape !== 'X');
  const v0 = voiced[0]?.start ?? 0.05, v1 = voiced[voiced.length - 1]?.end ?? line.duration - 0.05;
  const total = words.reduce((a, w) => a + w.length + 1, 0) || 1;
  let acc = 0;
  out.forEach((o, i) => {
    const a = v0 + ((v1 - v0) * acc) / total; acc += words[i].length + 1;
    const b = v0 + ((v1 - v0) * acc) / total;
    if (Number.isNaN(o.start)) { o.start = a; o.end = b; }
    if (Number.isNaN(o.stress)) o.stress = o.start + 0.35 * (o.end - o.start);
  });
  return out;
}

/** Find a word: "hammer", "hammer#2" (the second "hammer") or an index. */
export function findWord(words: ReturnType<typeof lineWords>, ref: string | number): number {
  if (typeof ref === 'number') return ref >= 0 && ref < words.length ? ref : -1;
  const [w, nth] = ref.toLowerCase().replace(/[^a-z0-9'#]/g, '').split('#');
  let k = Number(nth || 1);
  for (let i = 0; i < words.length; i++) if (words[i].word === w && --k === 0) return i;
  return -1;
}

const WORD_RULES: Array<[RegExp, string]> = [
  [/^(still|easy|calm|slow|slowly|careful|carefully|gently|steady|wait|mind|quiet)$/, 'palm-down'],
  [/^(this|that|there|those|these|yonder)$/, 'point'],
  [/^(here)$/, 'present'],
  [/^(one|first|two|second|three|third|once)$/, 'count'],
  [/^(bring|come|give|fetch|hand)$/, 'beckon'],
  [/^(no|never|nothing|nobody|not|don't|can't|won't)$/, 'head-shake'],
  [/^(yes|good|right|perfect|okay|aye|exactly|fine|well)$/, 'nod'],
  [/^(i|me|my|myself)$/, 'hand-on-chest'],
];

/** A performance from the words and emotion alone (Decision 23's rules): deictic words point, "still"
 *  presses down, numbers count, "no" shakes the head, "yes"/"perfect" nod; a firm line chops on its main
 *  stress, a question opens the palms. At most one gesture every ~1.2 s. */
export function autoPerformance(line: Pick<LineClip, 'text' | 'duration' | 'phonemes' | 'cues' | 'emotion'>): PerformanceScript {
  const words = lineWords(line);
  const gestures: PerformanceGesture[] = [];
  let last = -9;
  const add = (g: string, i: number) => {
    const t = words[i].stress;
    if (t - last < 1.2 || t < 0.25) return;
    const sameKind = gestures.filter((x) => x.gesture === g).length;
    if (sameKind >= 2) return;
    gestures.push({ gesture: g, word: i }); last = t;
  };
  for (let i = 0; i < words.length; i++) {
    const rule = WORD_RULES.find(([re]) => re.test(words[i].word));
    if (rule && !(rule[1] === 'hand-on-chest' && i > 1)) add(rule[1], i);
  }
  if (!gestures.some((g) => GESTURES[g.gesture].hands !== 'none')) {
    // nothing deictic: one gesture on the line's main stress, by emotion
    const main = words.reduce((b, w, i) => (w.end - w.start > words[b].end - words[b].start && w.word.length > 3 ? i : b), 0);
    const e = line.emotion;
    const g = line.text.trim().endsWith('?') ? 'open-palms' : e === 'firm' || e === 'angry' ? 'chop' : e === 'happy' || e === 'excited' || e === 'gentle' ? 'open-palms' : e === 'sad' ? 'look-down' : 'palm-down';
    if (words.length) add(g, main);
  }
  gestures.sort((a, b) => words[a.word as number].stress - words[b.word as number].stress);
  return { emotion: line.emotion, gestures: gestures.map((g) => ({ ...g, word: `${words[g.word as number].word}#${words.slice(0, (g.word as number) + 1).filter((w) => w.word === words[g.word as number].word).length}` })), auto: true };
}

const armQ = (side: 'Left' | 'Right', a: ArmPose): Record<string, Q> => {
  const sx = side === 'Left' ? 1 : -1;
  return {
    [`${side}UpperArm`]: qMul(X(-a.fwd), Z(-sx * a.down)),
    [`${side}LowerArm`]: Y(-sx * a.bend),
    [`${side}Hand`]: qMul(X(a.wristX ?? 0), Z(sx * (a.wristZ ?? 4))),
  };
};
const lerpHand = (a: HandPose, b: HandPose, t: number): HandPose => ({
  thumb: a.thumb + (b.thumb - a.thumb) * t, index: a.index + (b.index - a.index) * t, middle: a.middle + (b.middle - a.middle) * t,
  ring: a.ring + (b.ring - a.ring) * t, little: a.little + (b.little - a.little) * t, spread: a.spread + (b.spread - a.spread) * t,
});
/** Arrival: starts and lands softly (smootherstep), with a little overshoot (≈ 4 %) just before landing, so a stroke has a touch of follow-through. */
const arrive = (u: number) => { const t = clamp(u); return t * t * t * (t * (6 * t - 15) + 10) + 0.09 * Math.sin(Math.PI * t) ** 2 * t * t; };

/** Resolve the script's gestures to times (stroke ~0.08 s before the stressed syllable) and hands (a hand holding a prop doesn't gesture). */
export function resolveGestures(line: Pick<LineClip, 'text' | 'duration' | 'phonemes' | 'cues'>, script: PerformanceScript, holds: CharacterState['holds'] = {}): { gestures: ResolvedGesture[]; notes: string[] } {
  const words = lineWords(line);
  const notes: string[] = [];
  const out: ResolvedGesture[] = [];
  for (const g of script.gestures ?? []) {
    const def = GESTURES[g.gesture];
    if (!def) { notes.push(`no gesture "${g.gesture}"`); continue; }
    let target: number, word: string | undefined;
    if (g.at !== undefined) target = g.at;
    else if (g.word !== undefined) {
      const i = findWord(words, g.word);
      if (i < 0) { notes.push(`"${g.word}" is not a word of the line`); continue; }
      target = words[i].stress; word = words[i].word;
    } else target = words[0]?.stress ?? 0.3;
    let hand: ResolvedGesture['hand'] = def.hands === 'none' ? 'none' : g.hand ?? def.hands;
    let note: string | undefined;
    const busy = (h: 'left' | 'right') => !!holds?.[h];
    if (hand === 'both' && (busy('left') || busy('right'))) { hand = busy('right') ? 'left' : 'right'; note = `one hand holds ${holds?.[busy('right') ? 'right' : 'left']}: ${g.gesture} with the ${hand} only`; }
    else if ((hand === 'right' || hand === 'left') && busy(hand)) {
      const other = hand === 'right' ? 'left' : 'right';
      if (busy(other)) { notes.push(`${g.gesture}: both hands are full`); continue; }
      note = `the ${hand} hand holds ${holds?.[hand]}: ${g.gesture} with the ${other}`; hand = other;
    }
    if (note) notes.push(note);
    const stroke = Math.max(def.prep * 0.6, target - 0.08);
    const hold = g.hold ?? def.hold;
    out.push({ gesture: g.gesture, hand, ...(word ? { word } : {}), target: +target.toFixed(3), stroke: +stroke.toFixed(3), start: +(stroke - def.prep).toFixed(3), end: +(stroke + hold + def.retract).toFixed(3), size: clamp(g.size ?? 1, 0.3, 1.5), ...(note ? { note } : {}) });
  }
  out.sort((a, b) => a.stroke - b.stroke);
  return { gestures: out, notes };
}

/**
 * Compile a line's performance onto the rig. `look` is where the listener is (yaw, pitch degrees from the
 * body's facing; a cutscene fills it in), so the head and eyes find them.
 */
export function compilePerformance(rig: Rig, state: CharacterState | undefined, line: LineClip, script: PerformanceScript, opts: { look?: [number, number] } = {}): PerformanceClip {
  const fps = line.fps;
  const N = line.curves.sil?.length ?? Math.ceil(line.duration * fps) + 1;
  const frames = N - 1;
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const emotion = script.emotion ?? line.emotion;
  const intensity = clamp(script.intensity ?? 1, 0, 1.5);
  const energy = clamp(0.35 + 0.35 * ((EMOTION_SCALE[emotion] ?? 1) - 0.8) + 0.1 * intensity, 0.15, 0.95);
  // the life layer underneath: the character's idle (breathing, weight shift, blinks between darts)
  const idleSpec = { ...(state?.motions?.[script.idle ?? 'idle'] ?? { kind: 'idle' as const }), kind: 'idle' as const, duration: Math.max(1, frames / fps), energy, seed: hashSeed(line.text) };
  const base = bakeMotion('_perf', idleSpec, rig, state, fps);
  const life = line.life ?? lineLife(line);
  const { gestures, notes } = resolveGestures(line, script, state?.holds);
  const holds = state?.holds ?? {};
  const restHand = { left: state?.hands?.left ?? NAMED_HAND_POSES.relaxed, right: state?.hands?.right ?? NAMED_HAND_POSES.relaxed };
  const posture = POSTURES[script.posture ?? EMOTION_POSTURE[emotion] ?? 'neutral'] ?? POSTURES.neutral;
  const look = script.look ?? opts.look ?? [0, 0];
  const gaze = script.gaze ?? 'listener';
  const words = lineWords(line);

  // ── per hand: a chain of gesture segments; close ones flow into each other ──
  type Seg = { g: ResolvedGesture; def: GestureDef; tA: number; tS: number; tH: number; tE: number; fromPrev: boolean; toNext: boolean };
  const chains: Record<'left' | 'right', Seg[]> = { left: [], right: [] };
  for (const g of gestures) {
    const def = GESTURES[g.gesture];
    const sides: Array<'left' | 'right'> = g.hand === 'both' ? ['left', 'right'] : g.hand === 'none' ? [] : [g.hand];
    for (const side of sides) chains[side].push({ g, def, tA: g.start, tS: g.stroke, tH: g.stroke + (g.end - g.stroke - def.retract), tE: g.end, fromPrev: false, toNext: false });
  }
  for (const side of ['left', 'right'] as const) {
    const c = chains[side];
    for (let i = 0; i + 1 < c.length; i++) if (c[i + 1].tA < c[i].tE + 0.25) { c[i].toNext = true; c[i + 1].fromPrev = true; c[i + 1].tA = Math.min(c[i + 1].tA, Math.max(c[i].tS + 0.1, c[i].tH)); c[i].tH = Math.min(c[i].tH, c[i + 1].tA); }
  }
  const armPose = (seg: Seg, side: 'Left' | 'Right') => {
    const a = seg.def.arm!;
    const k = seg.g.size;
    // a smaller gesture stays closer to the hanging arm
    return armQ(side, { down: 74 + (a.down - 74) * k, fwd: a.fwd * k, bend: 14 + (a.bend - 14) * k, wristX: (a.wristX ?? 0) * Math.min(1, k + 0.2), wristZ: a.wristZ });
  };
  const armBones = (side: 'Left' | 'Right') => [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`];
  // where each arm is at time t: a pose (or null = hanging, the idle's) and its weight, per bone (the
  // forearm and hand trail the upper arm by a few frames)
  const armAt = (side: 'Left' | 'Right', t: number, lag: number): { from: Record<string, Q> | null; to: Record<string, Q> | null; w: number; hand: { a: HandPose | null; b: HandPose | null } ; beat: number } => {
    const c = chains[side === 'Left' ? 'left' : 'right'];
    const tt = t - lag;
    for (let i = 0; i < c.length; i++) {
      const s = c[i];
      const pose = armPose(s, side), hp = NAMED_HAND_POSES[s.def.hand ?? 'relaxed'];
      if (tt < s.tA) break;
      if (tt <= s.tS) {
        const prev = s.fromPrev ? c[i - 1] : null;
        return { from: prev ? armPose(prev, side) : null, to: pose, w: arrive((tt - s.tA) / Math.max(0.05, s.tS - s.tA)), hand: { a: prev ? NAMED_HAND_POSES[prev.def.hand ?? 'relaxed'] : null, b: hp }, beat: 0 };
      }
      if (tt <= s.tH) {
        const since = tt - s.tS;
        return { from: null, to: pose, w: 1, hand: { a: null, b: hp }, beat: (s.def.beat ?? 0) * s.g.size * Math.exp(-since / 0.09) * Math.sin(Math.min(Math.PI, since / 0.11 * Math.PI)) };
      }
      if (s.toNext) continue;
      if (tt <= s.tE) return { from: pose, to: null, w: ease((tt - s.tH) / Math.max(0.05, s.tE - s.tH)), hand: { a: hp, b: null }, beat: 0 };
    }
    return { from: null, to: null, w: 0, hand: { a: null, b: null }, beat: 0 };
  };

  // ── emotion over time (beats can change it mid-line) ──
  const beats = [{ t: 0, emotion, intensity }, ...(script.beats ?? []).map((b) => {
    let t = b.at ?? 0;
    if (b.word !== undefined) { const i = findWord(words, b.word); if (i >= 0) t = words[i].start; else notes.push(`beat "${b.word}" is not a word of the line`); }
    return { t, emotion: b.emotion ?? emotion, intensity: clamp(b.intensity ?? intensity, 0, 1.5) };
  })].sort((a, b) => a.t - b.t);
  const faceAt = (t: number): Record<string, number> => {
    let i = 0;
    while (i + 1 < beats.length && beats[i + 1].t <= t) i++;
    const cur = beats[i], prev = beats[Math.max(0, i - 1)];
    const u = i === 0 ? 1 : ease((t - cur.t) / 0.35);
    const ramp = ease((t + 0.15) / 0.35);       // the face settles into the emotion as the line starts
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(EMOTION_FACE[prev.emotion] ?? {})) out[k] = (out[k] ?? 0) + v * prev.intensity * (1 - u);
    for (const [k, v] of Object.entries(EMOTION_FACE[cur.emotion] ?? {})) out[k] = (out[k] ?? 0) + v * cur.intensity * u;
    for (const k of Object.keys(out)) out[k] = clamp(out[k] * ramp);
    return out;
  };

  const local: Q[][] = [], hips: V3[] = [];
  const shapes: Record<string, number[]> = {};
  for (const n of rig.shapeNames) shapes[n] = new Array(N).fill(0);
  const expr = state?.expression ?? {};
  const at = (a: number[] | undefined, f: number) => (a ? a[Math.min(f, a.length - 1)] ?? 0 : 0);
  const set = (q: Q[], name: string, r: Q) => { const i = idx.get(name); if (i !== undefined) q[i] = r; };
  const mulOn = (q: Q[], name: string, r: Q) => { const i = idx.get(name); if (i !== undefined) q[i] = qMul(q[i], r); };
  for (let f = 0; f < N; f++) {
    const t = f / fps;
    const q = base.local[Math.min(f, base.frames)].slice();
    hips.push(base.hips[Math.min(f, base.frames)]);
    // posture: eases in over the first 0.4 s and holds
    const pw = ease((t + 0.1) / 0.5);
    let chestAdd = 0, shoulderAdd = 0;
    // head-only gestures and gesture extras (chest, shoulders, head tilt)
    let hx = 0, hy = 0, hz = 0;
    for (const g of gestures) {
      const def = GESTURES[g.gesture];
      if (t < g.start || t > g.end) continue;
      const env = t < g.stroke ? ease((t - g.start) / Math.max(0.05, g.stroke - g.start)) : t < g.end - def.retract ? 1 : 1 - ease((t - (g.end - def.retract)) / def.retract);
      chestAdd += (def.chest ?? 0) * env * g.size; shoulderAdd += (def.shoulders ?? 0) * env * g.size;
      const h = def.head;
      if (h) {
        const since = t - g.stroke;
        hx += (h.x ?? 0) * env * g.size; hy += 0; hz += (h.z ?? 0) * env * g.size;
        if (h.nods && since > 0) hx += (h.x ?? 7) * 0.6 * Math.sin(Math.min(h.nods, since / 0.22) * Math.PI) * env;
        if (h.shake && since > -0.05) hy += h.shake * Math.sin((since / 0.2) * Math.PI) * env * g.size;
      }
    }
    mulOn(q, 'Spine', X(posture.spine * pw));
    mulOn(q, 'Chest', X((posture.chest + chestAdd) * pw));
    mulOn(q, 'Neck', X(posture.neck * pw));
    mulOn(q, 'LeftShoulder', Z((posture.shoulders + shoulderAdd) * pw));
    mulOn(q, 'RightShoulder', Z(-(posture.shoulders + shoulderAdd) * pw));
    // the head: the line's nods and drift (life), the listener's direction, the posture and head gestures
    const lb = life.body;
    const gz = gaze === 'down' ? [0, -14] : gaze === 'up' ? [0, 10] : gaze === 'away' ? [t < frames / fps * 0.45 ? 22 : 0, -3] : [0, 0];
    const lookYaw = look[0] + gz[0], lookPitch = look[1] + gz[1];
    const headPitch = at(lb?.headPitch, f) + posture.head * pw + hx - lookPitch * 0.4;
    const headYaw = at(lb?.headYaw, f) + lookYaw * 0.45 + hy;
    mulOn(q, 'Neck', qMul(Y(headYaw * 0.4), X(headPitch * 0.35)));
    mulOn(q, 'Head', qMul(qMul(Y(headYaw * 0.6), X(headPitch * 0.65)), Z(hz)));
    // eyes: the line's darts around the listener (what the head didn't turn, the eyes do)
    const eyeYaw = at(life.gaze.yaw, f) + lookYaw * 0.55, eyePitch = at(life.gaze.pitch, f) + lookPitch * 0.6;
    for (const e of ['LeftEye', 'RightEye']) { const i = idx.get(e); if (i !== undefined) q[i] = qMul(qIdentity(), qMul(Y(eyeYaw), X(-eyePitch))); }
    // arms and hands
    for (const side of ['Left', 'Right'] as const) {
      const key = side === 'Left' ? 'left' : 'right';
      if (holds[key]) continue;                  // a hand holding a prop keeps the idle's hold
      const names = armBones(side);
      const lags = [0, 0.045, 0.075];
      names.forEach((n, k) => {
        const i = idx.get(n);
        if (i === undefined) return;
        const st = armAt(side, t, lags[k]);
        if (!st.from && !st.to) return;
        const hang = q[i];
        const A = st.from ? st.from[n] : hang, B = st.to ? st.to[n] : hang;
        let r = qSlerp(A, B, st.w);
        if (k === 1 && st.beat) r = qMul(r, Y((side === 'Left' ? -1 : 1) * -st.beat));
        q[i] = r;
      });
      const st = armAt(side, t, 0.03);
      if (st.hand.a || st.hand.b) {
        const h = lerpHand(st.hand.a ?? restHand[key], st.hand.b ?? restHand[key], clamp(st.w));
        for (const [n, r] of Object.entries(handRotations(side, h))) set(q, n, r);
      }
    }
    // eyelids: the line's blinks
    const blink = at(life.curves.eyeBlinkLeft, f);
    for (const l of rig.spec.lids) set(q, l.bone, X(l.closeDeg * Math.max(blink, expr[l.bone === 'LeftUpperLid' ? 'eyeBlinkLeft' : 'eyeBlinkRight'] ?? 0)));
    local.push(q);
    // face: speech shapes, then the emotion (smiles and brows live with speech), blinks and brow lifts
    const face = faceAt(t);
    for (const n of rig.shapeNames) {
      const sp = line.curves[n]?.[f];
      let v = Math.max(sp ?? 0, expr[n] ?? 0);
      if (face[n]) v = clamp(Math.max(v, face[n]));
      const lv = life.curves[n]?.[f];
      if (lv !== undefined) v = n.startsWith('eyeBlink') ? Math.max(v, lv) : clamp(v + lv);
      shapes[n][f] = +v.toFixed(3);
    }
  }
  return { fps, frames, duration: line.duration, local, hips, shapes, gestures, notes };
}

/** Checks on a performance: gestures land on their words, nothing pops, the arms end where the idle is
 *  (so the next clip blends), hands stay clear of the body, and the face shows the emotion. */
export function performanceReport(rig: Rig, line: LineClip, script: PerformanceScript, clip: PerformanceClip, state?: CharacterState) {
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const fails: string[] = [];
  let worstSync = 0;
  for (const g of clip.gestures) if (g.word !== undefined) worstSync = Math.max(worstSync, Math.abs(g.stroke + 0.08 - g.target));
  // angular speed of the arms and head (degrees/s): a pop shows up as a spike
  const watch = ['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm', 'Head', 'Neck', 'Chest'].map((n) => idx.get(n)!).filter((i) => i !== undefined);
  let pop = 0, popAt = 0;
  for (let f = 1; f < clip.local.length; f++) for (const i of watch) { const v = qAngle(clip.local[f - 1][i], clip.local[f][i]) * clip.fps; if (v > pop) { pop = v; popAt = f / clip.fps; } }
  // the arms return to the idle by the end (unless a gesture is still held when the line ends)
  const last = clip.local[clip.local.length - 1];
  const idleEnd = bakeMotion('_end', { kind: 'idle', duration: Math.max(1, clip.frames / clip.fps), seed: hashSeed(line.text), energy: 0.5 }, rig, state, clip.fps);
  let endGap = 0;
  for (const n of ['LeftUpperArm', 'RightUpperArm']) { const i = idx.get(n)!; endGap = Math.max(endGap, qAngle(last[i], idleEnd.local[Math.min(idleEnd.frames, clip.local.length - 1)][i])); }
  const heldAtEnd = clip.gestures.some((g) => g.end > clip.duration + 0.05 && g.hand !== 'none');
  // hands clear of the torso: the wrist not inside a box around the chest
  let inside = 0;
  const s = rig.spec.s;
  for (let f = 0; f < clip.local.length; f += 3) {
    const P = forward(rig.bones, rig.parents, clip.local[f]);
    const ch = P.worldP[idx.get('Chest')!], top = P.worldP[idx.get('Neck')!];
    for (const h of ['LeftHand', 'RightHand']) {
      const p = P.worldP[idx.get(h)!];
      if (Math.abs(p[0] - ch[0]) < 0.1 * s && p[1] > ch[1] - 0.12 * s && p[1] < top[1] && p[2] < ch[2] + 0.06 * s && p[2] > ch[2] - 0.1 * s) inside++;
    }
  }
  const emotion = script.emotion ?? line.emotion;
  const want = Object.keys(EMOTION_FACE[emotion] ?? {});
  const mid = Math.floor(clip.local.length / 2);
  const shown = want.length ? Math.max(...want.map((k) => clip.shapes[k]?.[mid] ?? 0)) : 1;
  if (worstSync > 0.12) fails.push(`a gesture lands ${(worstSync * 1000).toFixed(0)} ms off its word`);
  if (pop > 900) fails.push(`something pops at ${popAt.toFixed(2)} s (${pop.toFixed(0)}°/s)`);
  if (endGap > 10 && !heldAtEnd) fails.push(`the arms end ${endGap.toFixed(0)}° away from the idle (they won't blend into it)`);
  if (inside) fails.push(`a hand passes into the chest (${inside} frame(s))`);
  if (want.length && shown < 0.08) fails.push(`the face doesn't show "${emotion}"`);
  for (const n of clip.notes) if (/no gesture|not a word|both hands are full/.test(n)) fails.push(n);
  const g = clip.gestures.map((x) => `${x.gesture}${x.word ? ` on "${x.word}"` : ''}${x.hand !== 'none' && x.hand !== 'right' ? ` (${x.hand})` : ''}`);
  return {
    pass: !fails.length,
    worstSync: +worstSync.toFixed(3), pop: +pop.toFixed(0), endGap: +endGap.toFixed(1),
    detail: fails.length ? fails.join('; ') : `${g.length ? g.join(', ') : 'no gestures'}; strokes within ${(worstSync * 1000).toFixed(0)} ms of their words, no pops (≤ ${pop.toFixed(0)}°/s), ends on the idle${clip.notes.length ? `; ${clip.notes.join('; ')}` : ''}`,
  };
}
