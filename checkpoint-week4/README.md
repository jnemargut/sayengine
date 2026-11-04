# Week 4 checkpoint: the blacksmith talks

`lines.mp4` (12.5 s, 1280×720, H.264 + AAC) shows the blacksmith from the character kit saying three lines in a three-quarter close-up:

1. "Hold still. This will only take a second." (firm)
2. "Bring me the big hammer, and mind the embers." (firm; many M/B/P closures)
3. "Perfect. Now we wait for the metal to cool." (calm)

`stills/` holds frames picked automatically: the rest face, plus a lip closure and the widest vowel for each line.

## How it was made

Everything ran through the real CLI and daemon (`node bench/talking-face.ts`):

1. `new-character --preset blacksmith`
2. `say` for each line:
   - The voice is local Kokoro-82M with voice `bm_george` (Apache-2.0).
   - Rhubarb Lip Sync 1.14.0 (MIT) aligns the audio with the script.
   - The alignment becomes smoothed curves for the 15 speech shapes.
   - All closure, held-shape and sync checks pass. Sync is within 20 ms.
3. `line-preview --video true`:
   - Exports the character as a validated GLB with its skin, face shapes and `line:<id>` clips.
   - Plays each clip in three.js in headless Chrome and captures every frame at 30 fps.
   - Muxes the frames with the line audio using ffmpeg.

To regenerate, run `node bench/talking-face.ts`. That command also writes `index.html` (an interactive player: click a line to hear it), the GLB and the WAVs here. Git ignores those files, so serve the folder to use the player.
