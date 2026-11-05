# Godot live IK (Decision 52, deferred in Phase 8)

Captured in Godot 4.7.2 (Forward+, Metal), 30 fps, by `node bench/godot-ik.ts`. Numbers are in `report.json`.

## What changed

- **Skinned creature export** (`packages/core/src/creatureskin.ts`, `creatureSkinnedGLB`):
  - One skin over the creature's bones, so Godot imports a `Skeleton3D`.
  - One skinned mesh. Each vertex rides its piece's bone at full weight, so it moves exactly like the node-per-bone export.
  - The same clips.
  - A weightless `.tip` joint at the end of every leg and chain, so an IK chain has an end bone.
  - `extras.ik` on the root lists the legs, chains and gait numbers. Godot imports these as node metadata.
  - The node-per-bone `creatureGLB` is untouched and stays the fallback.
- **`studio/creature_ik.gd`** (Godot template) is a `SkeletonModifier3D` that runs before Godot's own IK nodes. It does what the TypeScript `CreatureRuntime` does, with the same numbers:
  - Feet plant on the ground under them (a ray onto colliders, or a ground function) and step when they lag their home, one gait group at a time.
  - The body rides the planted feet on a spring (height, pitch, roll).
  - One `TwoBoneIK3D` bends every leg to its foot target, with a knee pole.
  - `reach(chain, goal)` adds a `FABRIK3D` and follows a moving goal with a critically damped spring, eased in and out.
  - Everything else keeps playing the baked clip.
- **`studio/foot_ik.gd`** is for kit humanoids, which already export skinned. The baked walk keeps playing. Then:
  - Each foot is lifted or lowered onto the ground under its heel and toe.
  - A swinging foot looks 12 cm ahead, so it clears a step's edge.
  - The hips drop so the lower foot still reaches.
  - A `TwoBoneIK3D` per leg bends the knee.
  - Feet keep the clip's orientation.
- **`studio/creature_ik_check.gd`** and `packages/game/test/godotik.test.ts` run a headless check that is part of `npm test`.

## The shots

| File | What | Measured |
|---|---|---|
| `stairs.mp4` | Apprentice (kit humanoid) walks its baked walk up five 15 cm steps onto a landing | Climbed 0.75 m. Planted soles within 0.4 cm of the step under them (p95 0.01 cm). A planted ankle drifts at most 0.4 cm. Toes never enter a step. |
| `crab.mp4` | Crab strafes 2.4 m over bumps of about ±15 cm, live | 75 footfalls. Universal motion checks on the Godot capture: **9/9 pass**. Planted feet slide at most 0.013 m/s (limit 0.033) and sit within 1.0 cm of the ground (limit 4.4). Fastest joint 328°/s. Feet on their IK targets to < 0.001 cm. |
| `baked.mp4` | The same crab and ground, baked walk only (the fallback) | Feet off the ground by up to 7.6 cm: **fails** "feet on the ground". |
| `spider.mp4` | Spider walks forward and turns 9°/s over the same ground, live | 100 footfalls, 2.1 m. Universal checks **9/9 pass**. Feet within 0.7 cm of the ground. Balance margin −1.8 cm (limit −4.7). |
| `reach.mp4` | Octopus arm 1 follows a yellow goal on a figure eight (FABRIK3D) | The tip sits on the followed point (mean 0.3 cm, p95 1.8 cm). It trails the goal itself by 4.4 cm on average (p95 5.6). That trail is the designed 1.6 Hz damped follow, the same as the web runtime. |

`stills/` holds four frames from each shot.

## Honest verdict

- **Stairs: works.** Feet land flat on each step, the knee of the higher leg folds, and the hips sink. It reads as climbing, not floating. It is still a flat-ground walk with feet moved onto the steps: the stride does not shorten and the body does not lean into the climb, so it looks a little like marching up.
- **Crab and spider: adapt live and pass the universal checks.** The baked fallback measurably floats and sinks on the same ground.
  - The live crab stands taller, with straighter legs, than in its baked crouch. The IK pole points the knees up and out, but the body height comes from the planted feet alone. It is correct, but stiltier than the baked walk.
  - The bumps are gentle on screen. The numbers show the difference more clearly than the stills do.
- **Tentacle: follows a moving goal.** FABRIK3D bends the arm at a few joints rather than spreading the bend along it, so the reaching arm shows a kink. The web runtime smooths its FABRIK result; Godot's node doesn't.
  - I tried a `JointLimitationCone3D` on every joint (32–60° cones) to spread the bend. The tip then missed its goal by 11–14 cm, so it is off. Spreading the bend needs a smoothing pass of our own after the FABRIK3D.
- **Not live in Godot yet:** springs (antennae) and wheels. Those still come from the baked clip.
- Some check rows are trivially satisfied for a live capture:
  - "Leg reach" is fed 0. The foot-to-target distance stands in for it.
  - "Ends in idle" doesn't apply.
- Ground under the creature comes from raycasts onto colliders, so the creature needs collision on its ground. A `ground_fn` callable also works.
