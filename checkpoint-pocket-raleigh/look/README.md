# Pocket Raleigh, part 2: the look (Phase 4 week 11)

Two looks, **day toy** and **neon night**, made as look records in the studio and imported into both games: `games/pocket-raleigh` (Godot 4.7.2) and `games/pocket-raleigh-web` (three.js). The same pinned views, rendered by each engine, are below.

- `both-looks-both-engines.png` is the sheet. Each row is one view. The columns are day toy in Godot, day toy on the web, neon night in Godot, neon night on the web. The rows, top to bottom: Fayetteville St looking north, City Plaza, Martin St looking west, the skyline from the south, the Raleigh aerial, and the twin's Main Street.
- `stills/day-toy/`, `stills/neon-night/` hold all 10 views per engine at full size. Each folder's `parity.json` has the Godot-vs-web FLIP for every view.
- `flythrough-godot-vs-web.mp4` is 8 s long, with Godot on the left and the web on the right. The camera goes up Fayetteville St to City Plaza, rises past PNC Plaza's crown and pulls out to the aerial: first in day toy, then in neon night. Both engines render it as pinned frames. `flythrough-still-*.png` are single frames from it.
- `board-day-toy.json` and `board-neon-night.json` are the look gates for every view in both engines: colourfulness, palette match and style score.
- `ab-day-toy.png` and `ab-neon-night.png` are the A/B sheets (A on the left, B on the right). `picks.jsonl` records the picks and why. No look was scored out of 10.
- `recipe/` has the studio scene (`studio-repo.json`: towns, fix layer, landmark models and both looks, with history) and the scripts that modelled the landmarks (`landmarks.ts`), placed the masts (`masts.ts`) and rendered the flythrough (`fly.ts`). Run them from the repo root with a daemon on `STUDIO_PORT`.
- `style-score.json` holds the local DINOv2-small scores. See "What's weak" below.

## Parity (Godot vs web, FLIP mean, 10 pinned views)

| | before (week 10) | day toy | neon night |
|---|---|---|---|
| worst view | 0.46 | **0.110** (twin river) | **0.088** (Raleigh aerial) |
| best view | 0.34 | 0.054 | 0.040 |

The target was ≤ 0.15, and every view meets it. Five things closed the gap:

1. **One pinned tonemapper.** Neither engine picks its own. Both output Reinhard `x/(1+x)` (Godot uses `TONE_MAPPER_REINHARDT` with white 1000). The look's 33³ LUT undoes that and applies the real curve and grade. Godot gets the LUT as a lossless strip sliced into a Texture3D. The web gets it from one full-screen pass that does the same three steps and samples the LUT the way Godot does.
2. **Lambert diffuse in Godot.** Godot's default Burley diffuse brightens surfaces seen at a grazing angle, such as the river-town grass.
3. **Matched lighting.** Godot has no background reflections (three.js has no environment map). Three.js light energies are multiplied by π, and an ambient light replaces the hemisphere.
4. **A measured Godot 4.7 quirk.** With fog on, the BG_COLOR sky is decoded from sRGB twice, so it gets pre-encoded once more.
5. **No shadows from flat layers.** Ground, streets, parks and water cast no shadows in either engine.

What's left of the difference is shadow-map filtering and anti-aliasing. The two engines also agree on the gates: each engine's colourfulness is within about 1–2 points of the other's on the same view.

## Gates and picks

- **Day toy v1** came out too saturated. Its colourfulness was above the 30–55 range on 10 of 20 view renders (river twin at 81).
- **v2** lowered saturation from 1.12 to 1.0 and vibrance from 0.15 to 0.05. It fails on 2 of 20 (the twin's river view, 65–67). Palette match is 0.56–0.84, and all pass.
- **Picked v2.** Reds and greens stop shouting, and the street still reads as a toy.
- **Neon night v1** was one violet wash. **Picked v2**, with a blue sky, less saturation and warmer highlights: materials and brick read again, and the lit windows carry the mood.
- **Neon night gates:**
  - colourfulness is 43–61; four aerial/skyline renders sit just over 60;
  - palette match fails on the river twin's views, whose colours aren't in the neon palette.

## How it looks (honest)

**Day toy.** Looking north up Fayetteville St, the Wells Fargo Capitol Center closes the vista: rose granite with a copper-green hipped top. From City Plaza you see two of the four light masts, PNC Plaza's glass shaft rising over the plaza, and the Wells Fargo top down the street. PNC's pale crown shows from the aerial and the flythrough. Brick pavers run along the curbs. There are café umbrellas, city banners on the lamp posts, blade signs and parked cars. Windows are no longer a uniform grid: some have blinds, some are lit, a few are blank, and some come in pairs. Next to week 10 this is a livelier, more specific street.

**Neon night** is the stronger of the two. The towers are full of lit windows, PNC's crown and the light masts glow, and cyan and magenta signs show at street level. From the air it reads as a city at night.

**Does it read as Raleigh?** Partly. Someone who knows downtown would likely recognise the skyline from the plaza or the air, and the light masts at City Plaza. At eye level on Fayetteville St it is still "a nice toy downtown": the street walls are rule-built boxes. The things that make that street Raleigh at eye level are missing:

- the State Capitol closing the north vista;
- the Duke Energy Center for the Performing Arts at the south end;
- the real storefronts.

The landmark shapes come from memory of the skyline, not from survey data or photos.

## What's weak

- **No bloom and no pools of lamp light.** The night has neither, so its lights are glowing surfaces, not lights. Bloom would need matching glow in Godot and on the web, and parity would have to be re-earned.
- **Toon shading is in the look record but not drawn.** The outline is drawn in both engines.
- **No user reference pictures yet.** The palette gate ran against each look's own palette.
- **The style score barely separates the two looks.** DINOv2-small takes about 2 s per picture on this Mac. Both looks score about 0.70 against the week-10 stills; same-look views score 0.62 and day-vs-neon 0.57. It responds mostly to content, not style. That is Decision 29's tripwire: try CSD, or keep only colourfulness and A/B.
- **Lit windows all glow one constant warm colour.** They are also a little dense on the towers.
- **The bake fallback is partial.** It grades vertex and base colours exactly under the look's reference light. Textures only get a graded factor, not graded texels.
- **The light masts had to ride in the town.** A stand-alone studio object is baked to one texture on export, so its "lamp" part couldn't glow on its own. A new fix kind (`--place`) puts the studio model in the town as a landmark node, without replacing a building, and keeps its material classes.
