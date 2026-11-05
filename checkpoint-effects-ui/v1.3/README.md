# Effects parity v1.3 (Godot vs web)

From `npm run bench:effects`. Scores are 0 for identical, and 0.25 or less passes. The score is unchanged from v1.2. Each card shows Godot on the left and the web on the right. `parity.json` has both engines' statistics.

| Effect | v1.2 | v1.3 | |
|---|---|---|---|
| forge fire | 0.087 | **0.025** | match |
| sparks | 0.143 | **0.139** | match |
| embers | 0.143 | **0.080** | match |
| chimney smoke | 0.313 | **0.107** | match (was over) |
| rain | 0.419 | **0.067** | match (was over) |

All five effects now pass.

## What changed

1. **The same lighting in both engines.**
   - The bench yard now gets a studio look, the same way Pocket Raleigh does (`look-new --preset day-toy`). Its outline is off, because an outline would ink the particle edges.
   - Before, each engine fell back to its own default environment. Now one look record drives the sun, ambient light, sky, fog, tonemap and grade in both.
   - `FX_NO_LOOK=1` runs the v1.2 setup.
   - The backdrops now match. Mean sRGB with the effect hidden, Godot vs web:

     | | Godot | web |
     |---|---|---|
     | rain: wall (upper middle) | 0.79 | 0.78 |
     | rain: floor (lower middle) | 0.67 | 0.66 |
     | smoke: wall | 0.78 | 0.77 |
     | sky | 0.76 / 0.85 / 0.90 | identical |

     In v1.2 the wall was 0.84 in Godot and 0.65 on the web.

2. **Web effects under a graded look are compiled for linear light** (`quarksGroup(b, { linear })`, chosen by `writeGameData` when the web look is in grade mode).
   - A graded look renders the web scene into a linear HDR target, then the grade pass encodes it, the same as Godot.
   - The web compiler had been built for three's sRGB canvas: palette sRGB values passed through raw, alpha raised to 1/2.2 for additive layers, and an exponent for see-through ones.
   - Inside the look's linear target, that compensation was applied twice. The first run with the look but without this fix scored worse on three effects:

     | Effect | v1.2 | look, no fix |
     |---|---|---|
     | smoke | 0.313 | 0.433 |
     | embers | 0.143 | 0.319 |
     | sparks | 0.143 | 0.176 |
     | rain | 0.419 | 0.189 |
     | fire | 0.087 | 0.027 |

     Web smoke was pale and thin, and web embers were cream instead of orange.
   - With the fix, colours go in linear, alpha is unchanged, and the particle uses Godot's own dot.
   - Web games without a look are compiled exactly as before.

## What still differs (visible on the cards, not in the score)

- **Shadows:** the web's are soft and wide, Godot's are hard. This is clearest under the table on the sparks and rain cards.
- **Hearth shading:** the web shades the hearth's recess darker, a little like ambient occlusion.
- **Embers:** the web embers sit a little lower in the hearth. The centres are 4 % of the screen apart.
- **Sparks:** web coverage is 28 % below Godot's, though the colour is within 3 %.
