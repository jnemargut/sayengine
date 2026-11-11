// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// Camera cutaway protection: "fade what stands between the camera and the subject", without ever fading the
// subject, the surface it stands on, the event's target, or the place a thrown object started from. Pure
// geometry on world-space boxes (no three.js), so a game, a bot and a framing audit can all ask the same question:
//   const cut = cutaway({ camera, subject: { points: [head, chest, feet] }, feet, boxes, protect: [targetId],
//                         thrown: { start: mugStart, now: mugNow } });
//   for (const b of boxes) fadeMesh(b.id, cut.fade.includes(b.id));
// Two lessons from playtests are built in:
//   - the support is found by a ray down from the feet (and from each protected point), never by a height test:
//     "everything below the feet" made every chair in a room unfadeable once the subject stood on a counter;
//   - protection holds in every beat, a thrown object's flight included: the camera following it must not fade
//     the shelf it left, and what blocks the flying object itself is cut like any other occluder.
// A physics beat varies run to run, so audit framing over several runs, not one.

export type V3 = [number, number, number];
export interface CutBox { id: string; min: V3; max: V3 }
export interface CutawayInput {
  camera: V3;
  /** points on the subject the camera must see (head, chest, feet...) */
  subject: { id?: string; points: V3[] };
  /** the subject's feet: the support is the first box a ray straight down from here meets */
  feet?: V3;
  /** candidate occluders, as world-space axis-aligned boxes */
  boxes: CutBox[];
  /** ids never faded (the event's target, a character in the shot) */
  protect?: string[];
  /** points that must stay on screen (the event's point): what holds them and what they rest on is kept */
  points?: V3[];
  /** a thrown object: its start point stays protected in every beat; `now` (its position in flight) must be seen */
  thrown?: { start: V3; now?: V3 };
  /** how far below a point a support may be (m) */
  maxDrop?: number;
  /** slack (m) around protected points and at the ends of each sight line */
  margin?: number;
}
export interface Cutaway {
  /** boxes to fade: they block a sight line and nothing protects them */
  fade: string[];
  /** boxes that block a sight line but are protected (and why) */
  kept: Array<{ id: string; why: string }>;
  /** the support set: boxes found under the feet and under each protected point */
  support: string[];
}

/** Does the segment a→b pass through the box (shrunk by `inset` at both ends of the segment)? Slab test. */
export function segmentHitsBox(a: V3, b: V3, box: { min: V3; max: V3 }, inset = 0): boolean {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-9) return false;
  let t0 = inset / len, t1 = 1 - inset / len;
  if (t1 <= t0) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (a[i] < box.min[i] || a[i] > box.max[i]) return false; continue; }
    let u = (box.min[i] - a[i]) / d[i], v = (box.max[i] - a[i]) / d[i];
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t1 < t0) return false;
  }
  return true;
}

/** The box a ray straight down from p meets first (its top within maxDrop below p), or null. */
export function supportUnder(p: V3, boxes: CutBox[], maxDrop = 1.5, margin = 0.02): CutBox | null {
  let best: CutBox | null = null, bestTop = -Infinity;
  for (const b of boxes) {
    if (p[0] < b.min[0] - margin || p[0] > b.max[0] + margin || p[2] < b.min[2] - margin || p[2] > b.max[2] + margin) continue;
    const top = Math.min(b.max[1], p[1] + margin);   // a point inside a box rests on that box
    if (b.min[1] > p[1] + margin || p[1] - top > maxDrop) continue;
    if (top > bestTop) { bestTop = top; best = b; }
  }
  return best;
}

const inside = (p: V3, b: CutBox, m: number) => p[0] >= b.min[0] - m && p[0] <= b.max[0] + m && p[1] >= b.min[1] - m && p[1] <= b.max[1] + m && p[2] >= b.min[2] - m && p[2] <= b.max[2] + m;

/** What to fade between the camera and the subject, and what must never be faded. */
export function cutaway(o: CutawayInput): Cutaway {
  const margin = o.margin ?? 0.05, maxDrop = o.maxDrop ?? 1.5;
  const why = new Map<string, string>();
  const keep = (id: string, reason: string) => { if (!why.has(id)) why.set(id, reason); };
  if (o.subject.id) keep(o.subject.id, 'subject');
  for (const id of o.protect ?? []) keep(id, 'protected');
  const support: string[] = [];
  const others = o.boxes.filter((b) => b.id !== o.subject.id);
  const under = (p: V3, label: string) => { const s = supportUnder(p, others, maxDrop); if (s) { keep(s.id, label); if (!support.includes(s.id)) support.push(s.id); } };
  if (o.feet) under(o.feet, 'support');
  const held: V3[] = [...(o.points ?? []), ...(o.thrown ? [o.thrown.start] : [])];
  for (const p of held) {
    under(p, o.thrown && p === o.thrown.start ? 'thrown from' : 'holds a protected point');
    for (const b of o.boxes) if (inside(p, b, margin)) keep(b.id, o.thrown && p === o.thrown.start ? 'thrown from' : 'holds a protected point');
  }
  // sight lines: the camera to each subject point, each protected point and the thrown object in flight
  const sights: V3[] = [...o.subject.points, ...(o.points ?? []), ...(o.thrown?.now ? [o.thrown.now] : [])];
  const fade: string[] = [], kept: Cutaway['kept'] = [];
  for (const b of o.boxes) {
    if (!sights.some((p) => segmentHitsBox(o.camera, p, b, margin))) continue;
    const w = why.get(b.id);
    if (w) kept.push({ id: b.id, why: w }); else fade.push(b.id);
  }
  return { fade, kept, support };
}
