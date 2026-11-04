# Week 4 checkpoint: the blacksmith talks

`lines.mp4` (12.5 s, 1280×720, H.264 + AAC) shows the blacksmith from the character kit saying three lines in a three-quarter close-up:

1. "Hold still. This will only take a second." (firm)
2. "Bring me the big hammer, and mind the embers." (firm; many M/B/P closures)
3. "Perfect. Now we wait for the metal to cool." (calm; F, OO)

`stills/` holds frames picked automatically:
- the rest face;
- a lip closure and the widest vowel for each line;
- the first TH, F/V and the longest OO across the lines (`-th`, `-f`, `-oo`);
- the first blink (`-blink`).

## What changed after the first review

The first version had a flat dark slot for a mouth, weak OO and F/V, staring eyes and only Rhubarb's 9 mouth shapes. Now:

- **Teeth and tongue.** The mouth is a chamber behind the lips with an upper and a lower row of teeth and a tongue. The upper teeth follow the head; the lower teeth and tongue follow the jaw. The tongue comes forward between the teeth on TH and lifts behind them on L, N, T and D. A check ("Teeth and tongue stay behind the lips") fails if any speech shape pushes them through the lips. At rest the lips meet.
- **Stronger OO and F/V.** OO pulls the corners in and pushes the lips forward. On F/V the upper lip lifts and the lower lip rolls back under the upper teeth. Short F/V and OO sounds get a guaranteed peak and hold, the way M/B/P closures already did, and a check ("F/V and OO sounds show") catches any that smoothing would average away.
- **Blinks and eye movement.** Every line gets seeded blinks (often at phrase pauses), small eye darts that come back to the listener, and a slight brow lift on the main stressed word of a phrase. They go into each `line:<id>` clip as eyelid and eye bone rotations plus blink and brow shape keys.
- **All 15 speech shapes.** The line's text is turned into phonemes locally (eSpeak NG via `phonemizer`). Those phonemes are placed in time on Rhubarb's shapes and silences, then mapped to the 15 Oculus visemes, so TH, K/G, CH/SH, R, S/Z, N/L, E and I each get their own shape. Rhubarb's 9 shapes stay as the fallback when there is no text.

## How it was made

Everything ran through the real CLI and daemon (`node bench/talking-face.ts`):

1. `new-character --preset blacksmith`
2. `say` for each line:
   - The voice is local Kokoro-82M with voice `bm_george` (Apache-2.0).
   - Rhubarb Lip Sync 1.14.0 (MIT) aligns the audio with the script. The line's phonemes (eSpeak NG, GPL-3.0, local only; see `THIRD_PARTY.md`) are fitted onto that timing.
   - The phonemes become smoothed curves for the 15 speech shapes, and the line gets its blinks, eye darts and brow lifts.
   - All closure, F/V and OO, held-shape and sync checks pass. Sync is within 10 ms.
3. `line-preview --video true`:
   - Exports the character as a validated GLB with its skin, face shapes and `line:<id>` clips.
   - Plays each clip in three.js in headless Chrome and captures every frame at 30 fps.
   - Muxes the frames with the line audio using ffmpeg.

To regenerate, run `node bench/talking-face.ts`. That command also writes `index.html` (an interactive player: click a line to hear it), the GLB and the WAVs here. Git ignores those files, so serve the folder to use the player.
