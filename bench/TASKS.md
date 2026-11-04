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
| 10 | `/studio make the seat walnut and the legs black metal, then show me a nice render` *(after task 1)* | per-part materials; Claude uses `render --style presentation` and Reads it; GLB export has both materials |
| 11 | `/studio put a ceramic vase on the stool` *(after task 1)* | `place-object --relation on`; "Rests on" and "Clear of other objects" pass; then `/studio make the stool bar height` keeps the vase on it |
| 12 | `/studio make a round dining table with four of these stools around it` *(after task 1)* | linked copies + `arrange --around`; all checks pass; changing the original stool changes all four |
| 13 | In the view: drag the vase across the seat, scrub seatH, then `/studio what did I change?` | your steps show as "you"; Claude reads `studio log` and describes them without reverting them |
| 14 | Drop any STL on the view (e.g. the one from task 9), then `/studio make a stool the same height as that scan` | the scan imports as a reference; Claude measures it with `inspect` and matches its height within 1 cm |
| 15 | `/studio make the stool a game asset for Godot` *(after task 1)* | `set-profile godot-desktop`, a collision op, all checks green; `export --target godot` writes a GLB that validates, with one baked material and a `-convcolonly` node; it opens in Godot with the grain visible |
| 16 | `/studio get the vase ready for a mobile web game` *(after task 6)* | the triangle budget flags it; Claude lowers segments, adds a hull collision and a lod op, and `export --target web` has `MSFT_lod`, a glazed (clearcoat) baked material, and passing unwrap checks |
| 17 | `/studio export the scene for the web` while a game object still fails a budget | Claude does not use `--force`: it reads the blocking checks from the export error, fixes them, then exports |
| 19 | `/game make a godot game from the stool and vase` *(after task 11)* | `game init` + `game import`; round trip has 0 warnings and the glaze arrives (`applied`); Claude screenshots the game and Reads it |
| 20 | `/game can a player walk up to the stool?` *(after 19)* | `game walk-to` reports reached, with the time; Claude says how far it stopped and where it started |
| 21 | `/game check the vase really sits on the stool in the game` *(after 19)* | `game test` with an `on` assertion (and `reachable`), all pass |
| 22 | `/game make a web version too` *(after 19)* | a second project with `--engine web`; clean import; screenshots look like the Godot ones |
| 23 | `/studio make the stool bar height`, then `/game update the game` *(after 19)* | Claude re-imports instead of editing the engine copy; `on` still passes at the new height |
| 24 | `/studio make a blacksmith character for Godot` | `new-character --preset blacksmith`, profile + capsule collision, all checks green (skin weights, 10 poses); `export --target godot` validates with a skin and face shapes and round-trips through Godot |
| 25 | `/studio make him smile and look a bit worried` *(after 24)* | `set-expression` with ARKit names (a wrong name is corrected from the suggestion); Claude renders `--views face` and Reads it |
| 26 | `/studio give the blacksmith a hammer` *(after 24)* | Claude builds a hammer and uses `hold`; "Fingers clear of Hammer" passes; `--views hands` render Read |
| 27 | `/studio get the apprentice ready for a mobile web game` | `web-mobile` profile: finger bones folded on export, shapes ≤ 33, triangle budget handled |
| 28 | `/studio have the blacksmith say "Bring me the big hammer"` *(after 24)* | `say` with the local voice; phonemes drive all 15 shapes; closure, F/V and OO, held and sync checks pass; teeth stay behind the lips; blinks and eye darts in the clip; `line-preview --video true`; Claude Reads the stills (closed, open, TH, F, OO, blink) |
| 29 | `/game make the forge yard a Godot game where I'm the apprentice` *(after 31)* | `game import --player Apprentice`; clean round trip; the blacksmith idles with his hammer; `characters.json` has the clips and speeds |
| 30 | `/game walk the apprentice up to the anvil` *(after 29)* | `walk-to --target Anvil --video true`: reached, as the apprentice, at the walk clip's speed; Claude Reads the stills (feet planted, idle at the end); walking through the forge is blocked |
| 31 | `/studio make a blacksmith and a little forge yard` | ~10 props with the godot-desktop profile and collision, the blacksmith holding a hammer, the apprentice; every check green (overlaps, grounding, one piece, motions) — `bench/forge.ts` is the reference |
| 32 | `/studio make him walk slower and more tired, and wave hello` | `set-motion --id walk --speed 0.9 --energy 0.15`, `set-motion --id wave --kind action --action wave`; motion checks green; `motion-preview --video true` stills Read |
| 33 | `/studio have him say it firmly, pressing his hand down on "still" and pointing at "this"` *(after 28)* | `perform --gestures "palm-down@still, point@this" --emotion firm`; with the hammer in his right hand the gestures go to the left; the performance check passes (strokes on the words, no pops, ends on the idle) — `bench/lesson.ts` is the reference |
| 34 | `/studio the apron looks like a board, the run looks like a jog, the strike is stiff, and he just slides from walking to standing` | the motion checks catch each (apron bend, run form, strike form, start/stop steps planted); the kit's apron bones, run, hammer strike and start/stop motions pass them |
| 35 | `/studio make "The Forge Lesson": a wide on the strike, then the three lines` *(after 31, 33)* | `new-cutscene` + four `set-shot`s (wide, medium, over-shoulder, close; lines `to` the listener); cutscene checks green (speakers in frame, cuts between words, 180° rule); `cutscene-preview --video true`; Claude Reads the storyboard frames |
| 36 | `/game play the cutscene in Godot and on the web` *(after 35)* | `game import` writes the cutscene (Godot: a generated AnimationPlayer scene); `game cutscene --id forge-lesson --video true` plays to the end in both, every clip found |
| 37 | `/game walk the apprentice to the anvil` *(after 34)* | the walk starts with a step off and ends with a stop step (feet planted), in both engines (`walk-to --video true`, stills Read) |

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
