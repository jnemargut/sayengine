---
name: game
description: Turn studio scenes into playable games and check them in a real engine — create a Godot (standalone/desktop) or three.js (web) game project, import studio assets, run it headlessly, screenshot it, walk a play-test player around, and run assertions, through the `studio game` CLI. Use for /game, or when the user asks to make, run, test, play-test or preview a game, level or web scene from what they modeled in this project.
---

# /game — studio scenes into real engines

> **Working together** (decisions 61–64): before proposing, read `./studio taste` and `./studio notes`. Give each step its word note (`--why "warmer"`), point at moments with addresses, and end each proposal with a "your call" card of at most 3 asks. Overnight work never waits on an ask. See [../studio/working-together.md](../studio/working-together.md).

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

Motions arrive as clips named by their id (`idle`, `walk`, `wave`…; several characters in one file → `<id>:walk`), in place, with `extras.speed`. A prop in a hand is a child of the hand joint. `game import` writes `assets/studio/characters.json` (clips, loops, speeds); the managed `studio/characters.gd` (Godot) and `startCharacters()` in `studio/harness.ts` (web) start every character on its idle, each on its own player/mixer.

**The player is a studio character**: `./studio game import --project forge --player Apprentice` exports that character on its own (`player.glb`, with what it holds) and leaves it out of the scene. It starts where it stood in the studio; `walk-to` and the game's own controls (arrow keys / WASD in the generated main scene, camera following) play its walk clip at the speed the body actually moves and idle when it stops. `--player none` goes back to a capsule. Characters in the scene block the way with a capsule. `./studio game walk-to --project forge --target Anvil --video true` records the walk from a following camera (MP4 + 3 stills): Read the stills — feet planted, facing the way it walks, idle at the end.

## Live feet and creatures (Godot, Decision 52) — on by default

- **Kit humanoids plant their feet live.** The player (and any scene character alone in its skeleton) gets the managed `studio/foot_ik.gd`: the baked walk plays, and each foot lands on what the game's own colliders say is under it (steps, slopes, curbs, props), hips dropping so the lower foot reaches. The leg bones travel in the GLB (`extras.character.footIk`). The player also climbs ledges up to 0.32 m (`step_height`), so stairs work with a plain capsule. Nothing to wire.
- **Creatures come in as their own GLBs** (`assets/studio/creatures/<id>.glb`, listed in `creatures.json`). `game import` picks the path per creature and reports it under `result.creatures`: `skinned-live` (a Skeleton3D plus `extras.ik`; `studio/creature_ik.gd` is attached and steps and plants the legs live, reaching chains through FABRIK3D) or `baked` (node per bone, the clips only) for wheels, shader grass, or a skinned file that fails the validator. `--baked true` forces the fallback. They stand where they stood in the studio playing idle.
- Make creatures move from game code: `var crab = CHARS.creature(studio, "Crab")` then `crab.wander(center, radius)`, or steer it yourself with `crab.speed`, `crab.turn`, `crab.strafe`; `crab.reach("arm1", point)`.
- Ground is always the game's colliders (raycasts), so anything with collision counts. Creatures have no static collider of their own.
- **Check it:** `./studio game feet --project <name> --walk <object|[x,z]> [--video true]` walks the player there and measures every live foot (player and creatures) against the ground under it. It fails when planted feet float or sink past the limit at the 95th percentile (humanoids 2.5 cm up / 2 cm down; creatures 4 % / 2 % of their size). Without `--walk` it watches for `--seconds` (`--look {center, radius, dir}` frames the video). `--ik false` shows what the baked clips alone do on the same ground. Also `game test` kind `feet`. Example game: `games/ik-yard` (`build.ts`, `proof.ts`).
- Not live yet: humanoid stride and lean on stairs (it's the flat walk with feet moved onto the steps), springs and wheels in Godot, the web engine (creatures aren't exported to web games yet).

**Game code helpers** (web, `studio/harness.ts` and `studio/ui.ts`; Godot equivalents in `studio/effects.gd`, `studio/ui.gd`):
- `named(game, 'Big hammer')` finds a studio object by its studio name (GLTFLoader renames nodes; every node carries `extras.studioName`).
- `hold(game, 'Blacksmith', 'Big hammer', 'right')` parents a prop to the hand bone at its grip socket (exported per character and hand). Mark carried props `studio set-profile --kind hand-prop`: no collider, and a grip socket in the export.
- `startCharacters(game, { controls: 'none' })` makes the studio player without keyboard controls; drive `game.characters.player.move(dir, speed, dt)` + `.sync(dt)` yourself. `controls: true` keeps WASD. `game.characters.actors[name].play(clip, {once})` plays any clip.
- `say(game, 'Blacksmith', 'good-lad')` plays the line's voice, its `line:<id>` clip (shifted by the line's measured lip-sync offset) and a speech bubble over the speaker. `game import` writes every recorded line to `assets/studio/lines/` (`lines.json` + WAVs).

## Before the engine: the studio's timeline (Phase 10)

Check motion, voice lines, cutscenes, effects and sounds in the studio's live view first: they all play on one
timeline there (`./studio timeline` lists tracks, moments and red stretches where motion checks fail). The
engines then play the same clips, cutscene files and effect recipes; `game screenshot`/`walk-to` remain the
proof that they play in the engine.

## Effects and UI (Decisions 56–58)

- Effects are made in the studio (`studio add-effect --preset forge-fire|sparks|chimney-smoke|embers|rain`, `--value fire` to follow a 0–1 game value, `--triggers '[{"on":"Blacksmith:strike@impact","layer":"burst"}]'` or a game event name). `game import` compiles them: Godot `.tscn` (GPU particles, a CPU twin per layer, shape effects with a scrolling-noise shader) and web three.quarks JSON with the same shader. In game code: `const fx = await startEffects(game)` / `EFFECTS.start(self)`; `fx.setValue('fire', 0.4)`; `fx.event('fed')`. Motion-tied bursts fire by themselves.
- `./studio game effect --project <godot game> --id forge-fire --value '[0.2,1]' --against <web game>` plays it from the studio's review camera in both engines: MP4s, a side-by-side card (PNG + MP4) and the Godot-vs-web parity, saved to the effect's `fx-parity` check. Watch the videos / Read the card.
- The UI kit comes from the studio (`studio ui-kit --preset forge`, `studio ui-icon --names '[…]'`): `game import` writes a Godot Theme (`assets/studio/ui/theme.tres`) or `ui.css`, the font and SVG icons. In game code: `startUI(game)` / `UI.start(self)` builds the HUD; `setBar`, `setText`, `card(title, sub)`, `bubble(node, text)`. `./studio game ui-sheet` renders the kit's review sheet and scores the icons.
- `./studio game screenshot --project <name> --page true` captures the whole screen — 3D plus the HUD and any HTML/Control UI (the web canvas alone misses HTML). `--bubbles '[{"character":"Blacksmith","text":"…"}]'`, `--values '{"fire":0.6}'`.

Not yet (later passes): pathfinding around obstacles (`walk-to` goes straight) and interactables.

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
