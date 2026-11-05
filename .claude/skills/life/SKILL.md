---
name: life
description: Give a studio town life — folk, a dog walker, cars and a bus going about a seeded day (by hour, season and event) on one baked walk mesh and lane graph, played by matching small runtimes in Godot (GDScript) and the web (TypeScript), checked by a sped-up headless day before you look. Use for /life, or when the user asks for people, crowds, pedestrians, NPCs walking around, traffic, cars, a bus, a market day, a dog walker, or "make the town feel alive".
---

# /life — folk, animals and traffic (Decision 30)

> **Working together** (decisions 61–64): before proposing, read `./studio taste` and `./studio notes`. Give each step its word note (`--why "warmer"`), point at moments with addresses, and end each proposal with a "your call" card of at most 3 asks. Overnight work never waits on an ask. See [../studio/working-together.md](../studio/working-together.md).

**Dumb people, smart places.** Places say what they offer — a bench "sit ×2", a market stall "browse ×2 + tend", a pier "fish ×2", a park "walk the dog", a bus stop "wait ×3", a door "come and go" — and the seeded schedule sends the cast to them. Everything is baked once in the studio from the town plan (`/world`) and exported as one `life.json` that both engines read; nothing is navmeshed twice.

The user's request: **$ARGUMENTS**

## 1. A town and a cast

- Towns first (`/world`). Then the cast, from the studio's own body plans — vary them (the cast check flags look-alikes):
  `studio new-character --id folk-ada --name Ada --preset default --shirt '#c8463a' …` and `set-motion --id walk --kind walk --speed 1.3`, `--id idle --kind idle`. Give sitters `set-motion --id sit --kind action --action sit` (a held seated pose), anglers `--id fish --action fish`, browsers `--id browse --action look-around`. A four-legged character (`--preset dog`) becomes the dog; give it to a walker.
- Vehicles from the wheel rig parts: `studio new-creature --id car-red --parts '[{"kind":"body",…},{"kind":"wheels",…},…]'` (full size: ~4.2 m cars, ~10.4 m bus; a body longer than 7 m is a bus). See `bench/life-cast.sh` for the Pocket Raleigh cast.
- Idle variety: give folk `nod`, `shrug`, `point`, `pickup` action clips too; the views play one now and then while someone stands, browses, tends a stall or chats. Anglers hold a rod: `studio hold --character folk-x --hand right --prop rod-x` (the views show it only while fishing).
- Export them at the origin for the games: `bench/life-export.sh` (characters with baked textures — the studio view must be open, `bench/studio-view-headless.ts` keeps one open — and vehicles with per-part materials, all in one daemon session). It ends with `bench/life-slim.ts`: face shapes dropped (crowds don't talk), 8-bit weights/joints and 16-bit UVs, still channels to one key, quantized positions/normals for the web (Godot's glTF import has no KHR_mesh_quantization, so it keeps floats there), and the vehicles' wheels split into `steer-*`/`wheel-*` nodes the views spin and steer. A folk GLB goes from ~5.7 MB to ~2.1 MB (Godot) / ~1.6 MB (web).

## 2. Bake the day

`studio life-bake --out games/<game>/assets/studio --seed 1 --day saturday --season autumn --event market --start 10.6 --player walker`

- Writes `life.json` (walk polygons, car lanes split at junctions with stop lines and signals, crossings, smart places, the cast and every outing, cars' trips and the bus loop with its stops) and `life-props.glb` (stalls, piers + rods, bus-stop signs, signal heads whose lit lamps the games switch).
- The runtimes ship with the game templates: `studio/life.ts` (web; a byte copy of `packages/core/src/life/runtime.ts`) + `studio/lifeview.ts`, and `studio/life.gd` + `studio/life_view.gd` (Godot). Start them with `startLife(game)` / `LIFE.start(self)` (see `games/pocket-raleigh*/`).
- Same seed → the same day; another seed → another day. The bake for two towns takes ~40 s.

## 3. Check it before you look

`studio life-day --from 5 --hours 24` (or `node bench/life.ts --hours 1`) runs the day sped up through the same runtime the web plays, with a scripted player walking a sidewalk and crossing mid-block, and reports: nobody inside anybody or a building, folk stay on the walk, no pops (no jump past the body's speed + 0.3 m in a 0.1 s tick), no car hits anyone or another car, nobody runs a red, no gridlock, the dog at leash length, one sitter per seat, folk make room for the player and cars brake for them. A red row comes with the game-times it happened at.

**Parity (D30's tripwire):** `node bench/life.ts` also runs `studio/life_parity.gd` in headless Godot on the same day and compares every agent and vehicle with the TypeScript runtime: they must agree within 0.5 m (they agree to ~1e-12 m: same fixed tick, same order, same formulas, no randomness at run time). If they ever drift past 0.5 m, the plan says: one shared core (WASM + GDExtension).

## 4. In the live view, with a day clock (Phase 10)

`studio life-on --folk 24 --cars 3 [--day saturday --start 8.5]` plays the first town's day in the live view on the
same runtime (one town, at most 40 folk and 6 cars: an 8 GB Mac; the folk are light stand-ins in their cast
colours, not the slim GLBs). The timeline dock gets a **day** strip: drag it over 00:00–24:00, play at ×1–×600;
it shows how many are out through the day and the selected person's stops.
- Click a person: the inspector says who they are (a name, who they look like, their role, where they live, who
  they're with) and their plan with times, and draws their walks and stops in the town.
- `studio life-person --who <id>` reads the same. `studio life-redirect --who <id> --words "go to the café at 9
  instead"` (or `--place <id> --at 9 --stay 40`) is one step: the overlapping outings are dropped, a new outing to
  that place is drawn with its own random source (nobody else's day moves), then the headless day checks above
  re-run (~8 s for the mini town) and come back pass/fail, in the panel too. A café is a shop door; "bench 4",
  "the market", "the pier", "the bus stop", "the park" and a building's label work too. `--undo true` puts their
  own day back.
- A person is `person:<id>` on the `day` clock (see working-together.md). Redirects live in `doc.life.redirects`
  (recipes, on the shared history); the bake applies them.

## Rules the runtimes keep (change both together)

- Fixed 0.1 s tick; drawing interpolates. Plain arrays in index order; `sqrt/atan2/sin/cos/floor/fmod` only; no randomness at run time.
- Folk keep right on the walk (each at their own distance from the middle, `lane`), pass on the left only where it's wide, follow slower walkers, never step into anyone (they hold, then sidestep; a face-to-face pair stuck 3 s in a pinch — or anyone stuck 8 s in a knot — slips past at 0.15 m and the check counts it), wait for the walk signal at crossings — or cross an empty street — and always look both ways; a turning vehicle in the junction goes first, and anyone caught on a crossing by a vehicle stopped across their way steps back.
- Friends: a companion (`owner` + the leader's `pal`) walks beside their friend (behind where side by side would take the oncoming side), stands at the act's `pal` spot and chats; the leader waits if they fall behind; friends keep 0.42 m apart (the check uses that limit for them). Strolls stop now and then for a look (`look` acts).
- Blends into and out of a spot are speed-limited (`bl` = distance / 1.1 m/s), so a long step never pops.
- Cars: IDM car following, stop lines on red (and amber when they can stop), no left turns, one turn at a time through a junction box, the bus holds the box and dwells 12 s at its stops; any person or the player ahead of the nose brakes them, right in front stops them dead. Turning, they wait at the line for anyone on (or walking up to) a crossing where the turn goes; the bus also waits until no vehicle stands (or will stop) where its body swings, and others hold 6 m back while it turns. A vehicle never drives its body into anyone or another vehicle a moment ahead (`poseAhead`).
- Edit `packages/core/src/life/runtime.ts` and `packages/game/templates/godot/studio/life.gd` line for line, then run `node --test packages/game/test/life.test.ts` (the parity test).
