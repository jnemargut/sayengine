---
name: game
description: Turn studio scenes into playable games and check them in a real engine — create a Godot (standalone/desktop) or three.js (web) game project, import studio assets, run it headlessly, screenshot it, walk a play-test player around, and run assertions, through the `studio game` CLI. Use for /game, or when the user asks to make, run, test, play-test or preview a game, level or web scene from what they modeled in this project.
---

# /game — studio scenes into real engines

The studio makes things; real engines run games (decision 13). `./studio game <command>` drives **Godot** for standalone games and **three.js + Rapier** for web apps and browser games, headlessly, and returns JSON plus PNG paths you can Read. You never click around an engine editor.

The user's request: **$ARGUMENTS**

## Which engine

- **Godot** (`--engine godot`): standalone games, desktop/Steam later, a real editor the human can open. Scenes and GDScript are plain text you can read and edit.
- **Web** (`--engine web`): a three.js page — web apps, browser games, anything that should open from a link. TypeScript in `src/`.
- Unsure → ask once ("a downloadable game or something that runs in the browser?"). Both can exist side by side; assets are shared.

## Start

1. `./studio game status` — existing game projects and which engines are installed here.
2. No project yet → `./studio game init --name <name> --engine godot|web` (creates `games/<name>/`).
3. `./studio scene` — what's in the studio. Build or fix assets with `/studio` first; the game only ever gets copies.

## The loop

1. **Import**: `./studio game import --project <name>` exports the studio scene as GLB into the game and round-trips it through the engine. Read `roundTrip`: objects, triangles, materials as the engine sees them, `applied` (studio materials the importer dropped and the studio re-applied), `notCarried` (e.g. procedural wood grain until the bake exists), warnings, errors. **Any warning or error fails the import** — fix the asset in the studio and import again.
2. **Look**: `./studio game screenshot --project <name> --views iso,front` → Read every PNG. This is the engine's own renderer, not the studio view. `--player [x,z]` stands a 1.7 m capsule in the shot for scale.
3. **Play-test**: `./studio game walk-to --project <name> --target "Walnut stool"` walks a capsule player (gravity + collision) straight to the object. Read `reached` / `blocked` / `timedOut`, `final`, `distanceToTarget`, `path`. `--from [x,z]` to choose the start, `--screenshot true` to see where it stopped.
4. **Assert**: `./studio game test --project <name> --assertions '[…]'` with kinds `exists {node}`, `grounded {node}`, `on {node, target}` (rests on), `count {pattern, min, max}`, `reachable {target, from}`. Godot also runs `res://tests/test_*.gd` (`static func run(root) -> {pass, detail}`); web runs tests registered with `registerTest(name, fn)` from `studio/harness.ts`.
5. **Run**: `./studio game run --project <name> --seconds 5` runs the game headlessly (fixed 60 fps) and returns every engine warning, error and print — use after editing game code.

## Characters

Studio characters import as one skinned mesh with a Godot humanoid skeleton (plus `LeftUpperLid`/`RightUpperLid`), face shapes as glTF morph targets named in `extras.targetNames`, and animations: `pose` (the studio pose and expression, step keys) and one `line:<id>` per spoken line (face-shape weights at 30 fps; the clip's `extras` carry the text, audio asset and emotion). Play a line by starting its clip and its audio together; use only the bone tracks of `pose` while a line plays so the two don't average. On `web-mobile` finger bones are folded into the hands.

## Rules

- **Never edit the engine copies of studio assets** (`assets/studio/`). Change the model with `/studio`, then `game import` again. Materials come from the studio on every import.
- Files under `studio/` in a game project are managed and get overwritten. Game code goes in `game/` (Godot) or `src/` (web) — those are never touched.
- Numbers rule, pictures advise: `walk-to` and `test` are the authority on reachability and placement; screenshots are for "does it look right".
- Report plainly: if import shows warnings, or the player is blocked, say so with the numbers.

## Example: "/game make a little godot scene from the stool and vase"

```bash
./studio game status
./studio game init --name forge --engine godot
./studio game import --project forge                 # read roundTrip: 0 warnings, glaze clearcoat applied
./studio game screenshot --project forge --views iso,front    # Read both PNGs
./studio game walk-to --project forge --target "Walnut stool" --screenshot true
./studio game test --project forge --assertions '[{"kind":"on","node":"Vase","target":"Walnut stool"},{"kind":"reachable","target":"Walnut stool"}]'
```

Then summarize in 2–3 lines: where the game is (`games/forge/`), what the round trip and play-test showed, and how to open it (`godot --path games/forge` or open the project in Godot; web: any static server on the folder after `game run`).
