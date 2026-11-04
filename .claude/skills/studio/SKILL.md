---
name: studio
description: Model 3D objects in the AI-first studio — create, modify, check, look at, and propose changes to parametric 3D models through the `studio` CLI while the human watches and reviews in the browser view. Use for /studio, or when the user asks to make, model, design, change, fix, compare, or export a 3D object (furniture, props, vases, buildings, parts) in this project.
---

# /studio — model in the AI-first 3D studio

You drive a headless modeling engine with the `./studio` CLI (run from the project root). The human watches a live view at **http://localhost:4517**, clicks parts to point at them, and reviews your proposals change by change there. Every action is a typed tool call that becomes one commit in a branching history — nothing is ever lost.

The user's request: **$ARGUMENTS**

## Start of every session

1. `./studio status` — auto-starts the engine daemon. If `views` is 0, tell the user once: "Open http://localhost:4517 to watch."
2. `./studio scene` — see what exists. Never recreate something that's there; modify it.
3. `./studio ops` once per session — the op vocabulary, anchors and tips.
4. If the request says "this", "that", "the selected …", or names no part: `./studio selection` — what the human clicked, with its size and the ops that made it.

## How models are built

- **Semantic** — `new-object --name … --type stool|chair|table|bench|shelf|cabin|vase|lamp|…`. Furniture types bring default checks (legs grounded, one piece, nothing below the floor). Add your own with `add-rule` (e.g. a `range` on height).
- **Parametric** — every meaningful dimension is a named param (`set-params`), referenced in op args as `"$name"`, so "make the legs thinner" is one `set-param`.
- **Construction** — typed ops via `add-op` / `set-op`:
  - Primitives: `box` (centered at `at`), `roundedBox` (box with rounded edges — prefer it for seats, tops, cushions), `cylinder` (Y-up, base at `at`, `r1`/`r2` for tapers), `sphere`.
  - Profiles: `extrude` — a floor-plane polygon `[[x,z],…]` pushed up by `h` (shaped tops, brackets, floor plans; `scaleTop` tapers, `twist` twists). `revolve` — a lathe from `[[radius,y],…]` (vases, bowls, turned legs, lamp bases). Profiles accept param expressions.
  - Modifiers: `smooth` (subdivision for organic shapes; `levels` 1–3, edges sharper than `sharpAngle` stay creased), `round` (rounds every edge by `r` but grows the shape by `r`), `trim` (keep one side of a plane; default cuts flat at the floor).
  - Transforms, booleans (`union`, `difference`, `intersect`, `hull`), instancers `placeAt` (a part on a named anchor of another op: `corners:bottom`, `center:top`, `edges:bottom`…, with `inset` and `splay`) and `array`.
  - Model a part once at the origin, then `placeAt` it. Never reference faces by number.
- `./studio add-op --help` prints the full schema and op reference. Op arguments always go inside `--args '{…}'`.
- Units: **meters and degrees**. Y is up, floor is y = 0. Dining seat ≈ 0.45 m, table ≈ 0.75 m, bar stool ≈ 0.75 m, door ≈ 2.0 × 0.9 m.

## The loop — numbers rule, pictures advise

For every step:
1. Make one meaningful change (one tool call = one reviewable step). Use `--label` on `set-op` / `set-params` to say *why* in plain words — the human reads it in the review panel.
2. Read the `checks` in the result. **If anything fails, fix it before moving on.** Checks are the authority on anything measurable — never argue with them from a picture.
3. At milestones (object roughly complete, before handing a proposal to the human, or when the request is about style or proportion): `./studio render --views front,side,iso`, then **Read the PNG files it returns**. Numbered dots match the `legend`; failing parts are red. Use images for "does it look like what was asked", not for measurements. If render says no view is connected, carry on with checks and `inspect`, and mention the view isn't open.

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

## Code mode (loops, many similar parts)

`./studio run --code "…"` or `--file script.js` runs JavaScript in a sandbox (no filesystem or network, 5 s): `studio.addOp({...})`, `studio.setParam({...})`, `studio.call('tool-name', {...})`, `console.log(...)`. Every call is still a normal, reviewable commit. Prefer plain tool calls for fewer than ~5 edits.

## Finishing

- `./studio check` — everything passes, or say plainly what still fails and why.
- Summarize in 2–4 lines: what you made, key dimensions, what to look at in the view.
- Export only when asked: `./studio export --format glb|obj|stl` → path in `.studio/exports/`. STL is millimetres, Z-up, for 3D printing.

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

A real vessel is hollow: trace the outside up, then the inside back down (wall thickness `$t`), in one revolve profile.

```bash
./studio new-object --name "Vase" --type vase --material ceramic --color "#c9b8a3"
./studio set-params --values '{"h":0.32,"t":0.006,"rBase":0.07,"rBelly":0.11,"rNeck":0.045,"rLip":0.055}' --label "32 cm vase, 6 mm wall"
./studio add-op --id body --op revolve --args '{"profile":[[0,0],["$rBase",0],["$rBelly","$h*0.38"],["$rNeck","$h*0.86"],["$rLip","$h"],["$rLip - $t","$h"],["$rNeck - $t","$h*0.86"],["$rBelly - $t","$h*0.38"],["$rBase - $t","$t"],[0,"$t"]]}'
./studio add-op --id vase --op smooth --inputs '["body"]' --args '{"levels":2,"sharpAngle":80}' --output true
./studio add-rule --rule '{"kind":"aboveFloor"}'
```

## Rules

- One tool call per meaningful change; never batch unrelated edits into one step.
- Never claim something is finished while a check fails.
- Don't invent commands or flags — `./studio help`, `./studio <command> --help`.
- If the daemon or view misbehaves: `./studio status`; restart with `./studio stop`, then any command.
