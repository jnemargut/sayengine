---
name: world
description: Build towns in the studio — a few real blocks of a US town from open data (Overture buildings, USGS ground, OpenStreetMap streets, water and parks) or an invented town from a style plus a street sketch or a short description — then fix buildings by hand in a fix layer that survives rebuilds, swap in landmark models, and walk the town in Godot or the web through /game. Use for /world, or when the user asks to make a town, neighbourhood, street, city block or village, real or made up.
---

# /world — towns, real or invented (Decisions 26–28)

One pipeline for every town: a **source** (real data, invented, or a remix of real streets with invented buildings) becomes a **town plan** (streets, lots, buildings with height, floors, roof and use, water, parks, every feature with a stable ID), the shared **rules** clean it up (square outlines, roofs from the roof type, clamp silly values, grade roads, per-region style), and the town's **fix layer** re-applies your hand fixes on every rebuild. No splats (Decision 28): towns are low-poly meshes.

The user's request: **$ARGUMENTS**

## Real places

1. `./studio world-fetch --name raleigh-city-plaza --bbox=-78.6413,35.7737,-78.6374,35.7788` — fetched once and cached under `.studio/cache/world/<name>` (a few blocks: keep it under ~600 m). Needs the free `overturemaps` CLI (`python3 -m venv ~/.studio-tools/venv && ~/.studio-tools/venv/bin/pip install overturemaps`). US only (USGS ground).
2. `./studio world-town --name "Pocket Raleigh" --source real --area raleigh-city-plaza --style raleigh-downtown` — returns buildings, streets, the tallest, what the rules did, fixes and credits.
3. `./studio check` — the `town:<name>` rows: every fix finds its building, no overlaps, nothing standing in a street, the triangle budget, credits.

## Invented and remixed towns

- `./studio world-town --name "River Twin" --source invented --seed 7 --description "mill town on a river, 1920s, 3 blocks" --offset '[380,0,0]'`
- Or write the street sketch yourself: `--sketch '{"streets":[{"name":"Main Street","kind":"tertiary","points":[[-120,0],[120,0]]}],"river":{"points":[[-150,60],[150,60]],"width":26},"green":[[-30,-60],[30,-60],[30,-15],[-30,-15]]}'`.
- `--source remix --area <fetched area>` keeps the real streets and ground and invents the buildings.
- Building IDs are `inv:<seed>:<street>:<side><n>`: the same seed and sketch give the same lots, so fixes survive a regenerate. A new `--seed` is a new town.

## Fixing buildings (the fix layer)

- Find the id: `./studio world-info --town "Pocket Raleigh" --near [x,z]` (x east, z south, metres from the town centre).
- `./studio world-fix --town "Pocket Raleigh" --id ov:… --set '{"roof":"hip","height":24,"wall":"#c9bea8"}' --note "why"`; `--hide true` for data mistakes (skybridges, tanks); `--model <studio object>` swaps in a landmark you modelled with /studio (it stands on the footprint, `--model-rotation` degrees).
- Each fix is keyed by id **and** position: after a data refresh (`world-fetch --force true`) a fix whose id vanished lands by position, and one with no building left is flagged by `studio check`. Undo / `world-unfix --index n` remove fixes.
- Styles: `raleigh-downtown`, `river-town-1920s`, `generic`. If a town reads as tidy boxes, fix the **style rules** (`packages/core/src/world/styles.ts`, `mesh.ts`) before adding more fixes.

## Into the game

`./studio game import --project <game>` carries every town in the scene GLB (one node per town, buildings merged into chunks with vertex colours: a few dozen draw calls). Players spawn on the ground under their start. Walk it: `./studio game walk-to --project <game> --from [x,z] --target [x,z] --video true`. Prove it with `/proof`-style checks: `./studio proof views` and `./studio proof phone` (see `../studio/SKILL.md` for the studio basics).

## Credits (ODbL)

Real towns use OpenStreetMap and Overture data under the ODbL: show `./studio world-info --credits true` text in the game's about screen, and share the derived data with `./studio world-share --town <name>` (town-plan.json, fixes.json, CREDITS.txt). Building names from the data stay data: never put brand or business names on signs.
