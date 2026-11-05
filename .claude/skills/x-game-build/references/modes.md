# Build modes

Contents: toy · presets · rebuild · v1 · copying a web build into `.decisions/builds/`.

## toy (road step 2)

Goal: the core verb, playable, in about an hour.

- Grey props only (one material colour), plus the cheap mood pass from the road: one sky colour, one light colour, one accent colour.
- One space (a street, a room, a hill), one verb, one camera.
- The character (if any) from the studio kit with its walk and idle.
- Done means: the human can play the verb for a minute and something responds.
- If it isn't playable within one session, cut to one verb and one camera (road tripwire) and say so.

## presets <decision> (step 3 and any feel decision)

Goal: one build, four options to try, chosen with a URL parameter.

Web:
1. In `games/<slug>/src/presets.ts`, export the four option values (`{ A: {...}, B: {...}, C: {...}, D: {...} }`) named after the decision's options.
2. In the game code, read `new URLSearchParams(location.search).get('preset') ?? 'A'` and apply that preset's values (camera distance, acceleration, mass, brake, shake…).
3. Show the preset's name in a small corner label so the human knows which they're playing.
4. Copy the build (below) and give the thinking skill the four URLs: `builds/build-NNN/index.html?preset=A` … `?preset=D`.

Godot: one scene per preset is heavy. Prefer clips (`"$STUDIO" game walk-to --video true` per preset) for Godot games and say why on the page.

If the presets build would take more than about five minutes, make clips instead (conventions §5 fallback).

## rebuild

Update spec → find overlapping steps by `uses` → rerun those and their dependants → copy a new build → update the preview → report which steps reran and why.

## v1 (road step 7)

Build the chosen scope: every place, character and system in `scope`, the chosen look (`look.record`), world and cast. Then:
- run, screenshot every place, walk to every goal (`walk-to`), read every still;
- add tests for the rules that decide winning and losing;
- hand to `x-playtest` with the great-v1 checklist.

## Copying a web build into `.decisions/builds/`

The web game in `games/<slug>/` has `index.html` and `dist/game.js` after `"$STUDIO" game run` (it bundles with esbuild). Copy `index.html`, `dist/` and `assets/` into `.decisions/builds/build-NNN/`, keeping relative paths, so `preview.html` and decision pages can embed it in an iframe when served from `.decisions/` (`python3 -m http.server` in `.decisions/`, or the studio's view server). Increment NNN for every build; never overwrite an older build that a decision page links to.
