# AI benchmark — Claude Code driving `/studio`

`npm run bench` proves the **engine** can express each task (scripted reference solutions).
This file is the **AI** benchmark: does Claude Code, using the `/studio` skill, get there on its own?

## Protocol

1. Fresh project state: `./studio stop && rm -rf .studio` (keeps nothing from previous runs).
2. Open http://localhost:4517 (renders need the view).
3. In Claude Code, run the prompt exactly as written. Don't help.
4. When it says it's done: `node bench/score.ts` and record the line in the table below.

## Tasks

| # | Prompt | Pass when |
|---|---|---|
| 1 | `/studio make a walnut stool, dining height` | all checks pass; seat height 0.43–0.47 m; 4 legs |
| 2 | `/studio splay the stool's legs like a mid-century stool` *(after task 1)* | a proposal exists; after you Commit it, splay > 0 and all checks pass |
| 3 | `/studio make a small cabin with a door and two windows` | all checks pass; door + 2 openings visible in renders |
| 4 | Run `node bench/break.ts` first, then `/studio the stool looks broken, fix it` | all checks pass without recreating the object |
| 5 | `/studio export the scene as GLB` | a .glb in `.studio/exports/` that opens in any glTF viewer |
| 6 | `/studio make a ceramic vase about 30 cm tall` | all checks pass; hollow (volume < 2 L of material); smooth silhouette in renders |
| 7 | `/studio show me two seat options for the stool` *(after task 1)* | two proposals, compared as thumbnails in the review panel; you commit one |
| 8 | Click one leg in the view, then `/studio make this leg's foot narrower` | Claude calls `studio selection`, edits the right op/param, in a proposal |
| 9 | `/studio export the stool for 3D printing` | an .stl in `.studio/exports/` that a slicer opens at the right size (mm) |

## What to record (from `node bench/score.ts`)

- **tool calls** and **failed calls** — fewer is better; failed calls show where the CLI/tool docs confuse the model
- **commits** and **proposals** — did it use proposals for changes?
- **renders** — did it look at its work?
- **checks** — final pass/fail per object
- your own 1–5 rating of **"does it look like what I asked for?"**

| Date | Task | Calls | Failed | Commits | Proposals | Renders | Checks | Looks right (1–5) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | 1 | 9 | 0 | 7 | — | 2 | 4/4 | 4 | Claude Code (Opus 5.5) driving the CLI with a headless view. Rounded seat, straight legs. |
| 2026-11-03 | 2 | 6 | 0 | +3 | p1 committed (1 of 4 undone by human) | 2 | 4/4 | 4 | 10° splay, tapered legs, trimmed flat. Found: set-params couldn't set units (fixed). |
| 2026-11-03 | 3 | 14 | 0 | 13 | — | 4 | 3/3 | 4 | Renders caught 3 problems checks couldn't: collapsed roof (Manifold binding bug, fixed), window merging into the door, openings invisible in flat renders (crease edges added). Check caught roof only touching walls (hint improved). |
| 2026-11-03 | 4 | 6 | 0 | +2 | p1 committed | 2 | 4/4 | 4 | Diagnosed both faults from check + code view in one pass. |
| 2026-11-03 | 5 | 2 | 0 | — | — | — | 4/4 | — | GLB valid (glTF 2, 1 mesh, walnut material); STL 0–450 mm Z-up. |

Run by the builder, not a blind run: tasks 6–9 and a fresh session using only the skill text are still worth doing yourself.
