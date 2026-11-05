# Live IK in a real Godot game: IK Yard

These shots come from a real game project, `games/ik-yard`, not the bench. They were captured in Godot 4.7.2 (Forward+, Metal) by `node games/ik-yard/proof.ts`, which uses `studio game feet`. The numbers are in `report.json`.

The game was built only through the studio tools and `/game` (`games/ik-yard/build.ts`): `new-object`/`add-op` for the yard, `new-character` for the Apprentice, `new-creature` for the crab and the spider, then `game init` and `game import --player Apprentice`. Nothing was wired by hand. The import:
- exported both creatures skinned with `extras.ik` (result: `Crab: skinned-live, 6 legs step and plant live`, `Spider: skinned-live, 8 legs…`)
- wrote the player's leg bones into its GLB
- left attaching `foot_ik.gd` and `creature_ik.gd` to the managed scripts

The game's own code (`game/main.gd`) has one addition: it asks the two creatures to `wander()`.

## The shots

| File | What | Planted feet vs the game's colliders (p95 float / sink) | Check |
|---|---|---|---|
| `walk.mp4` | The Apprentice walks up five 15 cm steps, across a landing and down a 14° slope (`game feet --walk`) | player 1.8 / 0.1 cm; crab 0 / 0; spider 0 / 0 | **pass** |
| `walk-baked.mp4` | The same walk with the live IK off (`--ik false`): the baked clips alone | player 14.8 / 3.3 cm; crab 4.8 / 14.8; spider 4.0 / 9.1 | **fails** (all three) |
| `creatures.mp4` | The crab and the spider wander mounds 10–17 cm high, with rocks, for 10 s | crab 0 / 0; spider 0 / 0 | **pass** |
| `creatures-baked.mp4` | The same, with baked walk clips | crab 4.8 / 14.8; spider 4.0 / 9.1 | **fails** |

`stills/` has six frames from each shot. Limits: humanoids 2.5 cm up / 2 cm down, creatures 4 % / 2 % of their size (the motion checks' own limits).

## Honest verdict

- **The pipeline works by default.** A plain `game import` gives a Godot game live feet for the player and live legs for the creatures. The import says which path each creature took. The feet check passes with the IK on and fails with it off, on the same ground.
- **Stairs: the feet land on the steps** and the knee folds. The player now climbs steps with an ordinary capsule (step-up in `player.gd`). It is still the flat-ground walk with the feet moved onto the steps: the stride doesn't shorten and the body doesn't lean. The worst single frames float 15 cm and sink 9 cm, on the frames when the body steps up and the rear foot comes along. Only the 95th percentile passes, so those spikes are visible if you look for them.
- **Slope: reads right.** Uphill feet lift, downhill feet drop, and the hips sink.
- **Crab and spider: legs land on the mounds and the rocks.** With the baked clip, the crab's belly sinks into a mound. The live crab stands tall on straight legs (known from the bench): correct, but stilty.
- The creature numbers are 0 because the IK puts each planted tip on the same ray it is measured against. So the check catches ground the leg can't reach and the baked fallback, but not subtle errors.
- The two creatures pass through each other if their circles overlap: there is no avoidance and they have no collider.
- The walk camera (the shared `walk-to` recorder) frames the player at the left edge, and the steps block the near foot for a moment.
- The mounds' shading is soft, so at the creatures' camera height the bumps read better in motion than in stills.
