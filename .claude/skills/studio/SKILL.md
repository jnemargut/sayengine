---
name: studio
description: Model 3D objects and small scenes in the AI-first studio — create, modify, give materials, arrange, check, look at, and propose changes to parametric 3D models through the `studio` CLI while the human watches, drags and reviews in the browser view. Use for /studio, or when the user asks to make, model, design, change, fix, compare, furnish, arrange, render, import a reference for, or export a 3D object (furniture, props, vases, buildings, parts) in this project — including game-ready assets for Godot or three.js (budgets, collision, baked textures) and things to 3D-print on the user's Bambu Lab A1 mini (print checks, text, screw holes, split to fit, a ready Bambu Studio project).
---

# /studio — model in the AI-first 3D studio

You drive a headless modeling engine with the `./studio` CLI (run from the project root). The human watches a live view at **http://localhost:4517**, clicks parts to point at them, drags objects and scrubs params by hand, and reviews your proposals change by change there. Every action (theirs or yours) is a typed tool call that becomes one commit in a branching history — nothing is ever lost.

The user's request: **$ARGUMENTS**

## Start of every session

1. `./studio status` — auto-starts the engine daemon. If `views` is 0, tell the user once: "Open http://localhost:4517 to watch."
2. `./studio scene` — see what exists. Never recreate something that's there; modify it.
3. `./studio ops` once per session — the op vocabulary, anchors and tips.
4. If the request says "this", "that", "the selected …", or names no part: `./studio selection` — what the human clicked, with its size and the ops that made it.
5. The human edits too. Steps by `human` in `./studio log` / `proposals` are theirs (drags, slider changes, dropped files): build on them, don't revert them.

## How models are built

- **Semantic** — `new-object --name … --type stool|chair|table|bench|shelf|cabin|vase|lamp|…`. Furniture types bring default checks (legs grounded, one piece, nothing below the floor). Add your own with `add-rule` (e.g. a `range` on height).
- **Parametric** — every meaningful dimension is a named param (`set-params`), referenced in op args as `"$name"`, so "make the legs thinner" is one `set-param`.
- **Construction** — typed ops via `add-op` / `set-op`:
  - Primitives: `box` (centered at `at`), `roundedBox` (box with rounded edges — prefer it for seats, tops, cushions), `cylinder` (Y-up, base at `at`, `r1`/`r2` for tapers), `sphere`.
  - Profiles: `extrude` — a floor-plane polygon `[[x,z],…]` pushed up by `h` (shaped tops, brackets, floor plans; `scaleTop` tapers, `twist` twists). `revolve` — a lathe from `[[radius,y],…]` (vases, bowls, turned legs, lamp bases). Profiles accept param expressions. Add `"curve": true` for flowing outlines: a smooth spline through your points, sharp turns (lip, foot) stay sharp — a few points then look hand-thrown, not faceted.
  - Modifiers: `smooth` (subdivision for organic shapes; `levels` 1–3, edges sharper than `sharpAngle` stay creased), `round` (rounds every edge by `r` but grows the shape by `r`), `trim` (keep one side of a plane; default cuts flat at the floor).
  - Transforms, booleans (`union`, `difference`, `intersect`, `hull`), instancers `placeAt` (a part on a named anchor of another op: `corners:bottom`, `center:top`, `edges:bottom`…, with `inset` and `splay`) and `array`.
  - Model a part once at the origin, then `placeAt` it. Never reference faces by number.
- `./studio add-op --help` prints the full schema and op reference. Op arguments always go inside `--args '{…}'`.
- Units: **meters and degrees**. Y is up, floor is y = 0. Dining seat ≈ 0.45 m, table ≈ 0.75 m, bar stool ≈ 0.75 m, door ≈ 2.0 × 0.9 m.

## Materials

- Give every object a real material: `new-object … --material walnut` (a preset), or later `set-material --preset oak`. Presets (`./studio materials`): walnut, oak, maple, ash (procedural wood grain), painted-wood, glazed-ceramic, matte-ceramic, terracotta, brushed-metal, black-metal, brass, plastic, glass, concrete, fabric.
- Colour-able presets (painted-wood, glazed-ceramic, plastic, fabric): add `--color "#2f5d62"`. Any field overrides the preset (`--roughness`, `--metalness`, `--clearcoat`, `--transmission`).
- Mixed materials: `set-material --part "leg*" --preset black-metal` changes just those parts (globs match `leg#1…leg#4`). Part names come from `--part` on add-op, so name parts by what they are.
- GLB export carries the materials (PBR, per part).

## Scenes: several objects

- Never compute positions by hand from bounding boxes. Use relations — they re-solve when anything changes size:
  - `place-object --object vase --relation on --target "Walnut stool"` (centred on top; `--offset '[dx,dz]'` to shift it)
  - `--relation next-to --side left|right|front|back --gap 0.1`, `--relation under` (centred under, on the floor), `--relation align --axis x|z --edge min|center|max`, `--relation free` (drop the relation).
- Sets of the same thing: `duplicate-object --object stool --count 3` makes **linked copies** (edit the original — all follow; `unlink` to customise one), then `arrange --objects '["stool","stool-2","stool-3","stool-4"]' --around table --radius 0.62 --start 45` (or `--along table --side front --spacing 0.5`). Objects face the target; an object's front is +Z.
- `move-object --position … --rotation deg` puts something at absolute coordinates (and drops its relation).
- New objects start clear to the right of the scene, so building one never collides with another.
- Scene checks: **Clear of other objects** (nothing passes through anything) and **Rests on X** (for `on`: at least half its base sits on X's top surface). Fix them like any other failing check.

## The loop — numbers rule, pictures advise

For every step:
1. Make one meaningful change (one tool call = one reviewable step). Use `--label` on `set-op` / `set-params` to say *why* in plain words — the human reads it in the review panel.
2. Read the `checks` in the result. **If anything fails, fix it before moving on.** Checks are the authority on anything measurable — never argue with them from a picture.
3. At milestones (object roughly complete, before handing a proposal to the human, or when the request is about style or proportion): `./studio render --views front,side,iso`, then **Read the PNG files it returns**. Numbered dots match the `legend`; failing parts are red. Use images for "does it look like what was asked", not for measurements. If render says no view is connected, carry on with checks and `inspect`, and mention the view isn't open.
4. When the human wants to *see* or *share* the result ("show me", "render it nicely", end of a big piece of work): `./studio render --style presentation` (materials, soft shadows, studio backdrop, no labels; `--views hero,low,front`). Read it before you hand it over.

Common fixes:
- Splayed legs: length `"($seatH - $seatT) / cos($legSplay)"`, then wrap the final union in `trim` (default = floor plane) so the feet sit flat: `add-op --id flat --op trim --inputs '["stool"]' --output true`.
- "N separate pieces" → something isn't touching; check `inset` on `placeAt` and positions with `./studio inspect`.
- "not connected to output" → an op isn't used; union it in or `remove-op` it.
- A tool error lists valid values, a `didYouMean`, or a hint. Read it and retry once with the correction — don't guess a third time; run `./studio <command> --help`.

## Proposals — how the human stays in control

- **New object in an empty scene**: build directly on main.
- **Any change to something that exists, or any request for alternatives** → `./studio propose --title "…"` first, make the changes as separate steps, then stop and say: "Proposal p1 is ready in the view — keep or undo each change, then Commit." Don't commit unless the user says so ("just do it", "commit it").
- Alternatives ("show me three backrests") → one proposal per alternative: `propose`, edit, `switch --branch main`, `propose` again… The view shows each as a thumbnail to compare side by side.
- After review, `./studio proposals` shows what the human kept or undid; continue from there.
- `./studio undo` reverts the last step on the active branch (as a new commit).

## References (imports)

- `./studio import --file scan.stl` (or .obj/.glb): a translucent reference object, not exported. Measure it with `inspect --object <id>` and model around it. STL defaults to mm, Z-up; OBJ/GLB to metres, Y-up — override with `--units`, `--up`, `--scale`.
- A watertight import can be cut or joined: `add-op --op mesh --args '{"asset":"<id from import>","format":"stl","units":"mm","up":"z"}'` inside your object.
- `./studio import --file sketch.png --plane front --size 0.6` puts an image behind the model (front/side/top, width in m); front/side renders include it, so model until the outline matches it.
- The human can also drop files on the view; they show up as `human` import steps.

## Game assets (Godot / three.js)

When the request mentions a game, Godot, three.js, the web, "game-ready", or a triangle/texture budget:
1. `./studio set-profile --profile godot-desktop` (Steam/desktop, Godot) · `web` (three.js, desktop browser) · `web-mobile` (phones). The profile adds checks after every step: triangles, baked texture size, materials, bones, "Has a collision shape", and on web "Distance versions (LOD)". Over budget while still building shows as *pending*; once the object is finished it fails — fix it like any other check (the detail says how).
2. Add a physics shape: `add-op --id col --op collision --inputs '["<output>"]' --args '{"shape":"hull"}'` (`box` for crates, `capsule` for characters/posts, `sphere`). The "covers the mesh" check must pass — if it says only 77% is inside, use `hull`.
3. Too many triangles: lower `segments` on cylinders/revolves first; on web add `add-op --id lod1 --op lod --inputs '["<output>"]' --args '{"ratio":0.4}'` for distance. collision and lod ops are side products: never use them as inputs, never set them as the output.
4. Materials stay presets: export bakes every opaque part (wood grain, colour, roughness, metalness) into one texture pair, so walnut + black metal is still one material. Glaze (clearcoat) and glass get their own. Keep the "Materials within budget" check green by not mixing glaze and glass on mobile.
5. `./studio export --target godot` (or `web`) — needs the view open (it paints the textures). It refuses while game checks fail, writes `.studio/exports/<object>.<target>.glb`, and reports the unwrap: even texel density, padded islands, no stretch — all must pass. `--texture 512` lowers the bake; `--bake false` exports untextured per-part materials when no view is open. Every GLB passes the Khronos validator or isn't written.

## 3D printing (Bambu Lab A1 mini)

When the request is to print something, or mentions a printer, PLA, Bambu, "for printing", a lid that fits, screw holes, or engraved/raised text. The user's printer is a **Bambu Lab A1 mini: 180 mm cube, 0.4 nozzle, one spool (always one colour)**.
1. `./studio set-print-profile --printer a1-mini` right after `new-object`. Print checks then run after every step: **fits the bed**, **sealed**, **walls ≥ 0.84 mm** (two nozzle lines; aim for 1.2 mm+), **overhangs needing support** (advice), **flat base** (advice). It also adds params `fitPress`, `fitSlide`, `fitLoose` (metres per side — the user's measured gaps once a fit-test is recorded).
2. Model in metres as usual; the object prints the way it stands (lowest point on the bed). Parts that must fit together use the gaps: a lid `"$innerW - 2*$fitSlide"`, a peg in a hole `"$pegR + $fitPress"`. Lay separate pieces (box and lid, parts to assemble) side by side on the floor in one object — pieces that each rest on the bed pass "one connected piece"; a piece floating in the air still fails.
3. Print helpers (`./studio ops` → print):
   - `text {text, size: cap height, depth, at, axis: y (lying flat, read from above) | z (standing, facing front)}` — union to raise, difference to engrave. Cap height ≥ 5 mm keeps strokes printable (a check says when it's too small).
   - `hole {size: M3, kind: clearance | tap | insert, depth, at}` — goes *down* from `at`; difference it. `head: true` adds a counterbore.
   - `split` (or `print-fix --fix split`) cuts a too-long model in two with pin holes and adds the pins; the cut face needs ~8 mm for pins, otherwise glue.
   - `chamfer` (or `print-fix --fix chamfer`) bevels the bottom edge against the squashed first layer.
4. Fixes are reviewable steps: `./studio print-fix --fix lay-flat` turns it onto the side that needs the least support (tell the human the before/after it reports). Propose first if they'd want to compare.
5. **`./studio print`** — refuses while print checks fail (`--force true` overrides), then has Bambu Studio's own command line build a project for the A1 mini (the user's PLA preset, laid on the bed, arranged; each piece its own object), slices a copy for a time/filament estimate, and opens the project in Bambu Studio. Tell the human: "It's open in Bambu Studio — look over the plate, then press Print." The studio never talks to the printer. If Bambu Studio's command line fails, a checked STL opens instead and the result says why.
6. First print of a project with fits? Offer the coupon: `./studio fit-test`, `./studio print --object fit-test`; after printing, ask which hole was snug / slid / loose and record it: `./studio fit-result --press 2 --slide 3 --loose 5` (updates every printable object and is remembered).
7. Look before printing: `./studio render --style presentation --views hero,top` and Read it — text reads correctly from above, holes where asked, nothing floating.

## Characters (people)

Characters come from a kit, not from ops: `./studio new-character --name Blacksmith --preset blacksmith` (presets `default`, `blacksmith`, `apprentice`; proportions `--height 1.8 --build 0.85 --headSize --armLength --legLength --handSize`, `--hair short|none`). The figure is rigged on creation: Godot humanoid bones (fingers, Jaw, Eyes, eyelids), ≤ 4 skin weights per vertex, and 33 face shapes (15 speech shapes + ARKit-named expressions). Checks: "Skin weights", "Bends cleanly in 10 test poses" (`./studio pose-check` shows each pose's worst joint, stretch, self-intersections; clothing clipping is reported separately).
- **Face**: `./studio set-expression --values '{"mouthSmileLeft":0.6,"mouthSmileRight":0.6,"browInnerUp":0.4}'` (`--reset true` clears). Wrong names get suggestions. Blinks (`eyeBlinkLeft/Right`) turn the eyelid bones.
- **Body**: `./studio set-pose --bones '{"LeftUpperArm":[0,0,-60]}'` (degrees, local X/Y/Z; body bones only).
- **Hands**: `./studio set-hand --hand right --pose fist|relaxed|point|pinch|open-palm` or `--curl 0.7` / `--curl '{"index":0.2}'`, `--thumb`, `--spread`.
- **Holding**: `./studio hold --character blacksmith --hand right --prop hammer` finds the handle (auto grip socket), places the prop in the hand and closes each finger until it touches; "Fingers clear of Hammer" must pass. `set-grip` overrides the socket; `release` lets go.
- **Look**: `./studio render --views face,face-34,hands` for close-ups. `./studio character` lists bones, shapes, poses and lines.
- **Spoken lines**: `./studio say --text "Hold still." --emotion firm` voices the line locally (Kokoro, default voice `bm_george`; `--voice am_michael`…; or `--audio my.wav`), aligns it with Rhubarb, and stores smoothed speech-shape curves (M/B/P always close; pauses rest). Checks: lips close, no shape held too long, mouth within 90 ms of the voice. Review with `./studio line-preview --video true` → Read the `stills` (closed on M/B/P, open on vowels), give the human the MP4 / player page. Exports carry each line as a `line:<id>` clip.
- **Motion** (settings, not keyframes): every new character has `idle` and `walk`. `./studio set-motion --object blacksmith --id walk --speed 1.1 --energy 0.3` tunes one (`--stride --bounce --armSwing --lean --sway --energy 0..1`); add more with `--kind run|idle|turn|action` (`--turn 90` = to his left; `--action wave|nod|shrug|point|hammer-strike|pick-up|look-around`). Motions are baked onto the character's own skeleton on export — legs solved so planted feet never slide, heel-to-toe — and re-fit when the body changes. Hands keep their pose and grip; a held prop rides the hand. Idle carries the life layer (breathing, weight shifts, head drift, blinks, glances); lines carry blinks, glances, breathing and small nods. Checks per motion: "feet planted (loops)" and "bends cleanly". `./studio motions` lists them with speed/stride and the action library. Look with `./studio motion-preview --video true` and Read the `stills` (two per motion; walks travel over half-metre squares, so sliding feet show). Exports carry each as a clip named by its id (in place; `extras.speed` is how fast a game should move the character).
- Game profiles budget bones and face shapes; `web-mobile` folds finger bones into the hand on export.

## Code mode (loops, many similar parts)

`./studio run --code "…"` or `--file script.js` runs JavaScript in a sandbox (no filesystem or network, 5 s): `studio.addOp({...})`, `studio.setParam({...})`, `studio.call('tool-name', {...})`, `console.log(...)`. Every call is still a normal, reviewable commit. Prefer plain tool calls for fewer than ~5 edits.

## Finishing

- `./studio check` — everything passes, or say plainly what still fails and why.
- Summarize in 2–4 lines: what you made, key dimensions, what to look at in the view.
- Export only when asked: `./studio export --format glb|obj|stl` → path in `.studio/exports/`. STL is millimetres, Z-up; to print, use `./studio print` instead (see 3D printing). For games: `./studio export --target godot|web` (see Game assets).

## Example: "/studio make a walnut stool"

```bash
./studio new-object --name "Walnut stool" --type stool --material walnut --color "#6b4a33"
./studio set-params --values '{"seatH":0.45,"seatT":0.03,"seatW":0.36,"seatR":0.008,"legR":0.016,"legSplay":0}' --label "Dining-height stool proportions"
./studio add-op --id seat --op roundedBox --part seat --args '{"size":["$seatW","$seatT","$seatW"],"r":"$seatR","at":[0,"$seatH - $seatT/2",0]}'
./studio add-op --id leg --op cylinder --part leg --output false --args '{"r":"$legR","h":"($seatH - $seatT) / cos($legSplay) + 0.01"}'
./studio add-op --id legs --op placeAt --inputs '["leg"]' --output false --args '{"target":"seat","anchor":"corners:bottom","inset":0.04,"splay":"$legSplay"}'
./studio add-op --id body --op union --inputs '["seat","legs"]' --output false
./studio add-op --id stool --op trim --inputs '["body"]' --output true
./studio render --views front,iso      # then Read the two PNGs
```

## Example: "/studio make a ceramic vase"

A real vessel is hollow: trace the outside up, then the inside back down (wall thickness `$t`), in one revolve profile. `curve: true` makes the silhouette flow.

```bash
./studio new-object --name "Vase" --type vase --material glazed-ceramic --color "#2f5d62"
./studio set-params --values '{"h":0.32,"t":0.006,"rBase":0.07,"rBelly":0.11,"rNeck":0.045,"rLip":0.055}' --label "32 cm vase, 6 mm wall"
./studio add-op --id vase --op revolve --args '{"curve":true,"profile":[[0,0],["$rBase",0],["$rBelly","$h*0.38"],["$rNeck","$h*0.86"],["$rLip","$h"],["$rLip - $t","$h"],["$rNeck - $t","$h*0.86"],["$rBelly - $t","$h*0.38"],["$rBase - $t","$t"],[0,"$t"]]}'
./studio add-rule --rule '{"kind":"aboveFloor"}'
```

## Example: "/studio put the vase on the stool and make four of them around a table"

```bash
./studio place-object --object vase --relation on --target "Walnut stool"
./studio set-material --object walnut-stool --part "leg*" --preset black-metal
./studio duplicate-object --object walnut-stool --count 3
./studio arrange --objects '["walnut-stool","walnut-stool-2","walnut-stool-3","walnut-stool-4"]' --around table --radius 0.62 --start 45
./studio check                                   # Clear of other objects, Rests on Walnut stool
./studio render --style presentation             # then Read it
```

## Example: "/studio make the stool a game asset for Godot"

```bash
./studio set-profile --object walnut-stool --profile godot-desktop     # budgets appear as checks
./studio add-op --object walnut-stool --id col --op collision --inputs '["stool"]' --args '{"shape":"hull"}'
./studio check --object walnut-stool                                   # all green, incl. "Collision covers the mesh"
./studio export --target godot --object walnut-stool                   # bake + validate → .studio/exports/walnut-stool.godot.glb
```
Tell the user the file path, the triangle count against the budget, and the unwrap report (texel density, islands, stretch).

## Rules

- One tool call per meaningful change; never batch unrelated edits into one step.
- Never claim something is finished while a check fails.
- Don't invent commands or flags — `./studio help`, `./studio <command> --help`.
- If the daemon or view misbehaves: `./studio status`; restart with `./studio stop`, then any command.
- To put models into a game (Godot or a three.js web game), use `/game` — `./studio game --help`.
