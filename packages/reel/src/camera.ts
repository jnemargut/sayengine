// A take's camera move (Decision 32): keys spread evenly over the take, Catmull-Rom between them, a
// gentle ease. Pure and dependency-free: the reel module, Godot's reel.gd (same formula) and the live
// view's shots track all play the same move.
type V3 = [number, number, number];
export interface CamTake { fov: number; keys: Array<{ position: V3 | number[]; target: V3 | number[]; fov?: number }> }

const cr = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
/** The camera at u ∈ [0, 1] of a take: keys spread evenly, Catmull-Rom between them, a gentle ease. */
export function cameraAt(take: CamTake, u: number): { position: V3; target: V3; fov: number } {
  const K = take.keys, n = K.length - 1;
  if (n === 0) return { position: K[0].position as V3, target: K[0].target as V3, fov: K[0].fov ?? take.fov };
  const e = u * u * (3 - 2 * u) * 0.3 + u * 0.7;                // mostly linear (steady speed), eased at the ends
  const s = Math.min(n - 1e-9, Math.max(0, e * n)), i = Math.floor(s), f = s - i;
  const P = (k: number) => K[Math.max(0, Math.min(n, k))];
  const lerp3 = (key: 'position' | 'target'): V3 => [0, 1, 2].map((c) => cr(P(i - 1)[key][c], P(i)[key][c], P(i + 1)[key][c], P(i + 2)[key][c], f)) as V3;
  const fa = P(i).fov ?? take.fov, fb = P(i + 1).fov ?? take.fov;
  return { position: lerp3('position'), target: lerp3('target'), fov: fa + (fb - fa) * f };
}
