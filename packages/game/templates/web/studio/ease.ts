// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// Character state transitions: the rules (or the AI, or a routine) say where a character IS; what is drawn eases
// there. Position, height and heading move together, the heading along the shortest arc, each with a hard rate
// limit, and nothing ever snaps except on a declared cut (a new scene, a teleport the story asks for).
//   const ease = new PoseEaser({ speed: 3, turn: Math.PI });
//   function tick(dt) { const p = ease.update(logical, dt, { walking: npc.walking }); npc.root.position.set(p.x, p.y, p.z); npc.root.rotation.y = p.heading; }
// The lesson behind it: turning with lerp(k = dt·8) hits k = 1 on a long frame, so a character spun 1350°/s at
// the ends of a pacing loop, popped metres when a routine moved it, and turned 340° the long way round from
// 350° to 10°. Here a 350° → 10° turn is 20°, and no frame turns faster than the limit.

export interface Pose { x: number; y: number; z: number; /** radians, any range */ heading: number }
export interface EaseLimits {
  /** max ground speed while easing (m/s) */
  speed: number;
  /** max vertical speed (m/s): steps, hops onto furniture, sitting down */
  climb: number;
  /** max turn rate when walking (rad/s) */
  turnWalking: number;
  /** max turn rate otherwise (rad/s): turning on the spot, gestures */
  turn: number;
  /** how quickly the drawn pose closes on the logical one (1/s); the rate limits cap it */
  response: number;
}
export const EASE_DEFAULTS: EaseLimits = { speed: 3, climb: 2, turnWalking: 2 * Math.PI, turn: Math.PI, response: 10 };

/** The shortest signed turn from `from` to `to` (radians), in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d <= -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d;
}
/** An angle in [0, 2π). */
export const wrapAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Close a gap smoothly: an exponential approach (frame-rate independent), never faster than maxRate. */
function approach(gap: number, dt: number, response: number, maxRate: number): number {
  const smooth = gap * (1 - Math.exp(-response * dt));
  const cap = maxRate * dt;
  return Math.max(-cap, Math.min(cap, smooth));
}

/** One step of the drawn pose toward the logical pose. `cut` snaps (a declared cut only). */
export function easePose(drawn: Pose, logical: Pose, dt: number, limits: Partial<EaseLimits> = {}, opts: { walking?: boolean; cut?: boolean } = {}): Pose {
  if (opts.cut || !(dt > 0)) return opts.cut ? { ...logical, heading: wrapAngle(logical.heading) } : { ...drawn };
  const L = { ...EASE_DEFAULTS, ...limits };
  const dx = logical.x - drawn.x, dz = logical.z - drawn.z, dist = Math.hypot(dx, dz);
  const move = dist > 1e-9 ? approach(dist, dt, L.response, L.speed) : 0;
  const k = dist > 1e-9 ? move / dist : 0;
  const dh = angleDelta(drawn.heading, logical.heading);
  return {
    x: drawn.x + dx * k,
    z: drawn.z + dz * k,
    y: drawn.y + approach(logical.y - drawn.y, dt, L.response, L.climb),
    heading: wrapAngle(drawn.heading + approach(dh, dt, L.response, opts.walking ? L.turnWalking : L.turn)),
  };
}

/** The drawn pose of one character, eased toward wherever the logic puts it. */
export class PoseEaser {
  drawn: Pose | null = null;
  limits: Partial<EaseLimits>;
  constructor(limits: Partial<EaseLimits> = {}) { this.limits = limits; }
  /** Move the drawn pose one frame toward `logical`; the first call (or `cut`) places it exactly. */
  update(logical: Pose, dt: number, opts: { walking?: boolean; cut?: boolean } = {}): Pose {
    this.drawn = !this.drawn || opts.cut ? { ...logical, heading: wrapAngle(logical.heading) } : easePose(this.drawn, logical, dt, this.limits, opts);
    return this.drawn;
  }
  /** Declare a cut: the next update snaps. */
  cut() { this.drawn = null; }
}
