# Weeks 5–6: motion, life and the walkable forge yard

Regenerate everything here with `node bench/week6.ts`. It takes about two minutes and needs Chrome, Godot 4.7 and ffmpeg.

## The videos

| File | What it shows |
|---|---|
| `motions-blacksmith.mp4` | The blacksmith's idle, walk and hammer strike. The hammer stays in his hand throughout. |
| `motions-apprentice.mp4` | The apprentice's idle, walk, wave, run, a 90° turn and look-around. |
| `walk-godot.mp4` | Godot 4.7: the apprentice (the player) walks up to the anvil and stops on idle, while the blacksmith idles by the forge. |
| `walk-web.mp4` | The same diorama in the three.js + Rapier web game. |

In the motion videos, walks and runs travel over half-metre squares, so a sliding foot would show.

`stills/` holds two frames per motion, three per walk, and an overview of the yard in each engine.

## How it's made

- **The yard:** the yard is `bench/forge.ts`, one studio call per step. Every prop has the `godot-desktop` profile and a collision shape, and every check is green.
- **Motions are settings:** the characters' motions come from `set-motion`, for example `--id walk --speed 1.25 --energy 0.65`. They are baked onto each character's skeleton on export.
- **Legs and feet:** the legs are solved with IK against planned foot paths that roll from heel to toe, so a planted foot stays planted. The worst slip measured is under 1 cm, which is what the check allows.
- **The player:** `game import --player Apprentice` exports the apprentice on its own. The Godot runner and the web harness then drive the actual kit character, playing walk at the clip's speed and idle when it stops.

## The walk was a crouch, now fixed (`gait/`)

Your feedback: "the walking looks awkward, like the dude walking is moving in a weird crouch". It was.

**Why:** the hips were set at one height for the whole cycle. That height was low enough for the legs to reach both ends of the stride at once.

**The fix:** the hips now vault over the planted leg like an inverted pendulum. They ride as high as that leg reaches nearly straight, are highest at mid-stance and dip only where both feet are down. They never go above standing height. The foot also lands slightly closer under the body, and a brisker walk pushes off harder over the toes instead of dipping deeper.

| Apprentice, default walk (1.27 m/s) | Before | After |
|---|---|---|
| Hips, average height vs standing | 91% | 97% |
| Lowest hips | 90% | 92% |
| Hip rise and fall | 2.0 cm (flat, low) | 5.6 cm (±2.8) |
| Planted knee at mid-stance | 136° (44° bent) | 172° (nearly straight) |
| Swinging knee, most bent | 72° | 55° |
| Planted foot slide | ≤ 3 mm | ≤ 2 mm |

- `gait/before-after.png`: the same three moments of the walk, before (top) and after (bottom).
- `gait/before-after-walk.mp4`: the two walks side by side.
- `gait/before/`: the old frames and video.

**New check on every walk:**
- the hips must average at least 95% of standing height
- the planted knee must be at least 165° at mid-stance

A crouch fails it (there's a test that fakes one). It holds for all three presets at 0.9, 1.3 and 1.8 m/s.

## Weak spots, honestly

- **Clothes:** the blacksmith's leather apron is rigid. There's no cloth simulation, so it swings like a board when he walks and clips the thighs.
- **Running:** it reads as a run, but the stance is long and low (knees bend up to ~105°). It looks more like a jog than a sprint.
- **The strike:** the hammer strike is keyframed by hand from a small library. It works, but it's stiff compared with the walk.
- **Transitions:**
  - walk → idle cross-fades over 0.25 s, with no start or stop steps
  - turning while walking is just the body rotating; there's no turn-on-the-spot during walk-to
- **Several NPCs:** in Godot each one gets its own AnimationPlayer sharing the clip library. That works, but it hasn't been tried with more than one non-player character in a scene.
- **Renders:** the videos use untextured materials (no bake), because the bake needs the studio's browser view open.
