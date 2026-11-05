# Effects parity v1.2 (Godot vs web)

From `npm run bench:effects`. Scores are 0 for identical, and 0.25 or less passes. Each card shows Godot on the left and the web on the right. `parity.json` has both engines' statistics.

| Effect | v1.1 | v1.2 | |
|---|---|---|---|
| forge fire | 0.09 | **0.087** | match (no regression) |
| sparks | 0.30 | **0.143** | match |
| embers | 0.28 | **0.143** | match |
| chimney smoke | 0.52 | **0.313** | still differs |
| rain | 0.45 | **0.419** | still differs |

## What was wrong and what changed (compilers and the review capture; no effect file changed)

1. **Smoke: the web column rose much higher than Godot's.**
   - The cause was Godot's turbulence, not velocity, gravity or the curves. Those were already identical in units.
   - Godot's turbulence turns a particle's *velocity direction* toward a noise direction by `influence` every 30 fps step, and keeps its speed. three.quarks' Noise only wobbles the *position* by at most `turbulence × 0.6` m.
   - At the old influence (0.014–0.021 for smoke), a 4 s puff's direction was scrambled within about a second, so it wandered instead of rising.
   - Fix: `turbulenceInfluence()` in `core/src/effects.ts` sizes the influence so the drift over a life is about the web's wobble. Smoke is now 0.0013, embers 0.010, and the forge-fire embers 0.0066.
   - The Godot column now rises like the web's: the centres are 5 % of the screen apart, down from 26 %.
2. **Sparks: the web was 15–25 % darker.**
   - Godot adds `a·lin(c)` in linear light, which reads as about `c·a^(1/2.2)` on screen. The web added `a·c` in sRGB.
   - Fix: additive layers carry alpha^(1/2.2), with six keys over life (a two-key 1 → 0 ramp gives an exponent nothing to bend). The particle uses Godot's dot shape raised to the same exponent.
   - The see-through rule is now computed from the blend equation (`alphaGamma()`). The old rule split "dark" and "pale" at a linear luminance of 0.5, which counted rain's pale blue as dark and thinned it.
3. **Godot sparks stood upright.** The stretched material used a fixed-Y billboard, so every spark was a vertical bar whichever way it flew. This was visible on the v1.1 card and the score hid it. Godot streaks now use `transform_align = Z_BILLBOARD_Y_TO_VELOCITY`. Both engines now draw radial streaks.
4. **Rain: drops under a pixel wide.**
   - The web review captured frames as JPEG. Chroma subsampling smeared 1 px blue streaks into the background, so they fell under the diff threshold. Web review frames are now PNG, the same as Godot's.
   - Stretched particles are now a **streak**, soft across and solid along their length, in both engines. Before, they were a stretched round dot that faded to a point at both ends.
   - The drops are now 1–1.5 px wide and the same length in both engines (checked at 6× zoom). Web rain coverage rose from 0.1 % to 0.5 %, against Godot's 0.9 %.

## Why smoke and rain still differ

The two engines render the review yard differently, before any effect is drawn:

| | Godot | web |
|---|---|---|
| back wall (sRGB) | 0.84 | 0.65 |
| floor under the rain | 0.74 | 0.59 |

The web backdrop is about 23 % darker. The parity score compares the absolute colour of changed pixels and counts pixels that change by at least 16 levels. That puts see-through layers in a bind:

- **Smoke:** the colour term alone is 0.16 apart, and the web's backdrop sits below Godot's measured smoke colour. Making web smoke denser would raise its coverage but darken its colour further.
- **Rain:** pale blue drops over a mid-grey web wall clear the threshold less often than over Godot's light wall. The web drops are counted mostly high in the frame, so the centres sit 21 % apart. Coverage alone would pass (38 % apart, which scores 0.19).

The next step is not in the effect compilers. Either:
- match the yard's lighting between the engines (a look on the forge bench), or
- score parity against each engine's own backdrop contrast.

I didn't change the score.
