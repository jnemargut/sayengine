# Build modes

Contents: toy · character check · presets · rebuild · v1 · props and meshes with Blender · copying a web build into `.decisions/builds/`.

## toy (road step 2)

Goal: the core verb, playable, in about an hour.

- Grey props only (one material colour), plus the cheap mood pass from the road: one sky colour, one light colour, one accent colour.
- One space (a street, a room, a hill), one verb, one camera.
- The character (if any) from the studio kit with its walk and idle.
- Done means: the human can play the verb for a minute and something responds.
- If it isn't playable within one session, cut to one verb and one camera (road tripwire) and say so.
- Also make the **character check** (below) and put it in the report.

## character check (step 2, and whenever a character changes)

A cheap render of the hero and the main other character, before anyone decides the look:

- front, side and three-quarter, plus one shot at gameplay distance in the toy's space, next to a doorway or a person for scale;
- at the fidelity target if one is set (`fidelity` in the spec), otherwise kit defaults;
- one honest line under it: does it read as what it should be? ("reads as a dog, not a cat: long body, stilt legs"; "reads as a mannequin: hard waist seam, arms crossed at rest").

If it reads wrong, say so in the report and log the cause in the tool-debt ledger. Don't wait for the cast page to discover it.

## presets <decision> (step 3 and any feel decision)

Goal: one build, four options to try, chosen with a URL parameter.

Web:
1. In `games/<slug>/src/presets.ts`, export the four option values (`{ A: {...}, B: {...}, C: {...}, D: {...} }`) named after the decision's options.
2. In the game code, read `new URLSearchParams(location.search).get('preset') ?? 'A'` and apply that preset's values (camera distance, acceleration, mass, brake, shake…).
3. Show the preset's name in a small corner label so the human knows which they're playing.
4. **Try each preset in the real space** before handing back: a scripted run or `walk-to` per preset, plus a still. A preset that can't be judged there gets fixed, swapped, or a one-line "untestable here, because …" for its card.
5. Systemic games: measure how each preset meets the other characters' senses (did the owner hear a landing, from where) and give the thinking skill one line per preset.
6. Copy the build (below) and give the thinking skill the four URLs: `builds/build-NNN/index.html?preset=A` … `?preset=D`.

Godot: one scene per preset is heavy. Prefer clips (`"$STUDIO" game walk-to --video true` per preset) for Godot games and say why on the page.

If the presets build would take more than about five minutes, make clips instead (conventions §5 fallback).

## rebuild

Update spec → find overlapping steps by `uses` → rerun those and their dependants → copy a new build → update the preview → report which steps reran and why.

## v1 (road step 7)

Before building: recompile the spec and check derived fields against the current scope (a scope that grew since the loop was built usually means more goals, a longer session and more cameras). Then build the chosen scope: every place, character and system in `scope`, the chosen look (`look.record`), sources, world and dressing, cast, title screen. Then:
- run, screenshot every place, walk to every goal (`walk-to`), read every still;
- add tests for the rules that decide winning and losing; tests that assert scope numbers change with the scope, on purpose, and the report says so;
- hand to `x-playtest` with the great-v1 checklist;
- offer to fold the tool-debt ledger into the studio (`verify-and-debt.md`).

## Props and meshes with Blender

When the studio has no step for a prop or mesh (or a Blender-backed step it lists in `help`), Blender is a free, local option:

- run headless: `blender -b -P make_prop.py -- --out assets/props/<name>.glb`; keep the script in the game's repo so the prop can be rebuilt;
- export glTF (`bpy.ops.export_scene.gltf`), apply transforms, metres, Y-up for three.js; keep a simple collision proxy next to it;
- render a still of every new prop (`bpy.ops.render.render(write_still=True)`) and read it before using it;
- prefer the studio's own creature or people step when `"$STUDIO" help` lists one: it keeps characters checkable and exportable;
- log each Blender-made asset in `credits.json` (made locally, the licence you give it).

## Copying a web build into `.decisions/builds/`

The web game in `games/<slug>/` has `index.html` and `dist/game.js` after `"$STUDIO" game run` (it bundles with esbuild). Copy `index.html`, `dist/` and `assets/` into `.decisions/builds/build-NNN/`, keeping relative paths, so `preview.html` and decision pages can embed it in an iframe when served from `.decisions/` (`python3 -m http.server` in `.decisions/`, or the studio's view server). Increment NNN for every build; never overwrite an older build that a decision page links to.
