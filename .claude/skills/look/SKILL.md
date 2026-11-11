---
name: look
description: Give a whole scene or game a look — a pinned tonemapper, a 33³ colour grade, toon and outline, palette, fog, sky and light, material tweaks (lit windows, lamps, neon) — as one record that drives the studio view, Godot, three.js, bakes and thumbnails; check it against reference pictures with measured gates (colourfulness range, palette match, a local style score) and judge versions only by A/B picks. Use for /look, or when the user asks for a mood, time of day, colour grade, "make it look like this picture", "less saturated", night, neon, toy, or for Godot and web to look the same.
---

# /look — looks as data, reference boards, measured targets (Decision 29)

> **Working together** (decisions 61–64): before proposing, read `./studio taste` and `./studio notes`. Give each step its word note (`--why "warmer"`), point at moments with addresses, and end each proposal with a "your call" card of at most 3 asks. Overnight work never waits on an ask. See [../studio/working-together.md](../studio/working-together.md).

A look is **one record** in the scene (`doc.look`), with history and undo like everything else. It drives:
the studio view, thumbnails and presentation renders · Godot (Environment + the LUT as a Texture3D) · three.js (one grade pass) · the bake fallback (renderers without colour grading) · reels later (they render through the same games).

The user's request: **$ARGUMENTS**

## How the engines stay the same (don't undo this)

Neither engine picks its own tonemapper. Both output the **transport** — Reinhard `x/(1+x)`, sRGB-encoded — and the look's 33³ LUT undoes it, applies the pinned curve (`neutral`, `aces`, `filmic`, `reinhard`, `linear`) and the grade. Godot also shades Lambert (not Burley), has no background reflections, flat town layers cast no shadows in both, and light energies map ×π into three.js. Godot vs web FLIP on Pocket Raleigh's pinned views: ≤ 0.11 (day) and ≤ 0.09 (night). If parity drifts, measure with `/proof` before touching the look.

## Make and change a look

- `./studio look-new --preset day-toy` (or `neon-night`, `studio-neutral`, or `--record {...}`); `--activate false` keeps the current one active.
- `./studio look-set --look day-toy --set '{"grade":{"saturation":0.92}}'` — a partial record, deep-merged; `null` removes a key. "Not too saturated" is `grade.saturation` / `vibrance`, then check the colourfulness gate.
- `./studio look-use --look neon-night` (or `none`); `./studio look-info --record true`.
- Record fields: `tonemap {curve, exposure}`, `grade {temperature, tint, contrast, saturation, vibrance, lift, gamma, gain, shadows{color,amount}, highlights{color,amount}}`, `lutSize` (33), `toon {enabled, bands}`, `outline {enabled, width px, color, threshold}`, `palette {name: #hex}`, `sky {color}`, `fog {enabled, color, begin, end}`, `light {sun {color, energy, elevation, azimuth, shadows}, ambient {color, energy}}`, `materials {class: {emission, emissionEnergy, roughness, metalness, tint}}`, `bloom {enabled, threshold, softness, intensity, levels[7]}` (glow: Godot Environment glow, additive; the web runs a mip chain fitted to it — `GLOW_GAIN` in the web template; re-fit with `checkpoint-pocket-raleigh/craft/recipe/fit-glow.ts` if Godot changes), `style {preset grade|soft-cartoon, saturation, shadow, band [lo,hi], highlight [lo,hi,amount], calm, ink, inkWidth, exclude {additive, noDepthWrite, shaderMaterials, names[]}, precompile}` (web only; `soft-cartoon` replaces the grade/outline pass: albedo + lit + normal/id passes, two soft light bands and a highlight, saturation, coloured ink that darkens the edge pixel rather than painting it black; light pools, depthWrite-false and shader-material meshes such as fur shells, and meshes named like `whisker` pass through untouched; `precompile` runs `renderer.compile` on every pass so its first frame does not stutter), `fallback auto|grade|bake`, `board {references, colourfulness [min,max], paletteMatch, styleMin}`.
- Material classes: towns carry `matte`, `glossy`, `metal`, `water`, plus `lit` (some windows), `lamp` (sodium street lamps), `led` (white LED lamps), `neon` (blade signs), `sign` (sign bands), `shop` (shop windows), `flood` (floodlit landmark stone) and `pool` (light pools under lamps and masts, shop spill on the sidewalk: additive, unlit, drawn only when the look gives `pool` an `emissionEnergy`; its vertex colours carry the falloff and hue). A studio model's part joins a class when its material name ends in that word (`set-material --name "lantern lamp"`) — only when the model rides in a town (landmark or placed prop); stand-alone studio objects are baked to one texture.
- **toon is in the record but not drawn yet** (say so if asked).

## In the live view: sliders, pointing, three takes (Phase 10)

- With a look active, the view's Look panel has sliders for exposure, white balance (Kelvin; lower = warmer), contrast, saturation, fog density (0–100 %), sun height, direction, colour (Kelvin) and strength, and — on looks with lamps or glow — lamp strength and glow. Dragging previews in the viewport only; **releasing is one `look-set` step** with its word note, e.g. "warmer: white balance 6200 K → 5600 K". When you change a look yourself, give the same kind of note: `look-set … --why "thicker fog: fog density 15% → 40%"` (`knobStep` in `packages/core/src/look/knobs.ts` writes it).
- "Sky, fog, sun and lamps too" (on by default) shows the whole look in the viewport, not only the grade.
- **Point**: the user clicks a spot ("too dark here"). The note is pinned on the thing under it (a model part, a town building, or `look:<name>` on empty sky) with a `region` (the look, the 3D point, the screen spot). `./studio notes` shows it; read the region before changing anything, and fix it locally if you can (a lamp, a material class) before re-grading the whole look.
- **Show me three** (the panel's button, or `show-three` with `lookTakes(look)`): warm and soft / cool and crisp / rich and punchy, rendered side by side under the same view with a per-section compare and a pick card. Picks feed the taste file like any other.

## Into the games

`./studio game import --project <game>` writes `assets/studio/look/` (`look.json`, `lut.png` strip, `look.cube`). The game's `main.gd` / `main.ts` call `LOOK.apply(self)` / `applyLook(game)`. Godot's Compatibility renderer (or `fallback: "bake"`) gets the grade **baked into the GLB's colours** instead (exact under the look's reference light; textures keep only a graded factor).

## Judge it: numbers first, then A/B

1. `./studio proof views --project <godot game> --against <web game>` (pinned views in both engines + parity).
2. `./studio look board --project <godot game>` → per view and engine: colourfulness (Hasler–Süsstrunk M vs the board's range), palette match (vs the reference pictures, else the look palette) and a style score (DINOv2-small, local, vs the references; needs `~/.studio-tools/venv/bin/pip install torch transformers`). Read the sheet.
3. Compare versions: `./studio look ab --a <stills A> --b <stills B> --views city-plaza,skyline-south` → Read the sheet, then `./studio look pick --a … --b … --pick A|B --why "…"`. **Never score a look out of 10**; numbers catch "too saturated", not "no charm".
