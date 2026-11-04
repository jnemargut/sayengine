# Week 8 checkpoint: "The Forge Lesson"

The blacksmith and the apprentice in the forge yard. The cutscene has four shots and three lines:

1. **Wide:** the blacksmith strikes the anvil.
2. **Medium on the blacksmith (push-in):** "Hold still. This will only take a second."
3. **Over the blacksmith's shoulder:** the apprentice says "Is it supposed to glow like that?"
4. **Close on the blacksmith (push-in):** "Perfect. Now we wait for the metal to cool."

Voices are local Kokoro-82M (Apache-2.0): `bm_george` for the blacksmith, `bm_lewis` for the apprentice. Each line is performed with the whole body (`perform`): emotion, posture, gestures on words and gaze to the listener. Because the hammer is in the blacksmith's right hand, his gestures go to his left. One studio cutscene file is played by three players:

| File | What it is |
|---|---|
| `forge-lesson-preview.mp4` | The studio's preview (`cutscene-preview --video true`), using the three.js player |
| `forge-lesson-web.mp4` | A web game (`game import` + `game cutscene`), using the same player as `studio/cutscene.ts` |
| `forge-lesson-godot.mp4` | A Godot game, playing the generated `assets/studio/cutscenes/forge-lesson.tscn` (an AnimationPlayer with camera, voice and cue tracks) |
| `storyboard.html`, `storyboard/` | One frame per shot, its lines and every check |
| `cutscene.json`, `checks.json` | The timeline the players read, and the checks |

## The motion fixes (each has a check)

| File | What changed |
|---|---|
| `before-after/apron-walk.png` | **Apron:** it hangs on two apron bones. It swings on springs and bends as the knees push it, instead of rotating like one plank. |
| `before-after/run.png` | **Run:** both feet leave the ground for about half the stride. It leans further forward, the heel folds up behind, the arms pump, and cadence is 150–195 steps/min. |
| `before-after/strike.png` | **Hammer strike:** it winds up (weight back, chest turned away), comes down fast, sinks into the knees at impact, follows through, then settles. |
| `motions-*.mp4` | The fixed motions in motion, plus the new start and stop steps |
| `walk-start-stop-godot.mp4`, `walk-start-stop-web.mp4` | The apprentice as the player steps off into the walk and ends with a stop step, feet planted, in both engines |

In each before/after sheet, the top row is week 6 and the bottom row is now.

To rebuild everything: `node bench/forge-lesson.ts` (a few minutes; needs Chrome, Godot, ffmpeg and the local voice).
