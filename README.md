# AI-First 3D Studio

You direct, Claude Code models, the browser shows it. A `/studio` Claude Code skill drives a headless modeling engine through the `studio` CLI; every change is a typed, checked, reversible commit; AI changes arrive as proposals you review change by change in the browser view.

```
You in Claude Code ──/studio──▶ studio CLI ──HTTP──▶ engine daemon (Node) ◀──websocket──▶ browser view
                                 (typed tools)        @studio/core: scene IR,              docked panels,
other agents ──MCP (stdio)──▶ same tools ──┘          branching log, op graph,             picking, review,
                                                      Manifold kernel, checks              renders for the AI
```

## Quick start

```bash
npm install
npm run build:view          # bundles the browser view
./studio status             # starts the engine daemon (auto-starts on any command)
open http://localhost:4517  # the live view
```

Then in Claude Code, from this folder: `/studio make a walnut stool`.

## What you can do

| | |
|---|---|
| **Build** | Boxes, rounded boxes, cylinders (tapered), spheres; `extrude` any polygon along x/y/z (tops, gables, brackets); `revolve` a profile (vases, bowls, turned legs), with `curve: true` for a smooth spline outline; `smooth` (subdivision), `round` (fillet every edge), `trim` (cut flat at the floor); booleans, hull, mirror; `placeAt` named anchors with splay; `array`. Every dimension is a named, editable parameter. |
| **Materials** | PBR presets: walnut, oak, maple, ash (procedural wood grain, no UVs), painted wood, glazed and matte ceramic, terracotta, brushed and black metal, brass, plastic, glass, concrete, fabric. Per object or per part (`set-material --part "leg*" --preset black-metal`); any value can be overridden. Exported to GLB as glTF PBR (clearcoat, transmission, IOR). |
| **Arrange** | Relations that re-solve when sizes change: `place-object` on / under / next to / aligned with another object; `arrange` objects around or along one; linked copies (`duplicate-object`) that follow the original. Scene checks: nothing passes through anything; things placed on something actually rest on its top. |
| **Check** | Watertight, one connected piece, legs grounded, nothing below the floor, custom range rules. In-progress states show as *pending* rather than failures. |
| **Look** | `studio render` asks the open view for labeled front/side/top/3-4 images with crease edges, which Claude reads. `--style presentation` makes a finished image to show people: materials under studio light, soft contact shadows, a seamless backdrop. The viewport uses the same lighting. |
| **Point** | Click any part in the viewport. The inspector shows its size and the ops that made it, and `studio selection` hands it to Claude ("make *this* thinner"). |
| **Edit by hand** | Scrub a parameter slider and the model updates live; releasing commits one step. Drag an object with the gizmo (Move: on the floor; Turn: about Y), or drag a part whose position is its own. A placed object keeps its relation: dragging the vase along the seat changes its offset and it stays on the stool. Your edits appear as "you" steps next to Claude's, in proposals too. |
| **Review** | AI edits to existing things arrive as proposals: hover a change to highlight it, hold Space for "before", Keep/Undo each change, compare alternatives as thumbnails, then Commit. |
| **Script** | `studio run --code "…"` runs JavaScript in a QuickJS WebAssembly sandbox (no filesystem or network, 5 s, 64 MB); every call is still a normal commit. |
| **Import** | `studio import` (or drop a file on the view): STL/OBJ/GLB become translucent, measurable reference objects (watertight ones can be cut or joined with a `mesh` op); PNG/JPG become a backdrop plane (front/side/top) that renders include, so Claude can model to match a sketch. References are never exported. |
| **Game assets** | `set-profile godot-desktop \| web \| web-mobile` turns budgets into checks after every step (triangles, baked texture, materials, bones), pending while still building. `collision` ops (box, hull, capsule, sphere) with a "covers the mesh" check; `lod` ops make distance versions. |
| **Characters** | `new-character` builds a rigged person from a kit (presets, proportions): Godot humanoid skeleton with fingers, jaw, eyes and lids; auto skin weights (≤ 4); 15 speech shapes + ARKit-named expressions; `set-expression`, `set-pose`, `set-hand` (named poses), `hold` a prop with an automatic grip and a finger-penetration check; 10 canonical pose checks. Close-up views `face`, `face-34`, `hands`. |
| **Lip sync** | `say --text "…"` voices a line with a local, free voice (Kokoro-82M) or your WAV, aligns it with Rhubarb Lip Sync, and bakes smoothed speech-shape curves (coarticulation, closed lips on M/B/P, rests in pauses, emotion) with closure / held-shape / sync checks. `line-preview --video true` renders the exported character speaking in close-up to an MP4 (ffmpeg) plus a player page. |
| **Export** | GLB (with materials), OBJ, STL (mm, Z-up for slicers). `export --target godot\|web` unwraps every part (xatlas), has the view bake materials, wood grain included, into one lighting-free texture pair per asset, reports texel density, island padding and stretch, and writes collision nodes (Godot `-convcolonly`, `extras.collision` for three.js) and distance versions (web, `MSFT_lod`). Every GLB passes the Khronos glTF validator or isn't written; after-export hooks (the engine round-trip) can fail an export. |
| **3D printing** | `set-print-profile --printer a1-mini` (Bambu Lab A1 mini: 180 mm cube, 0.4 nozzle, one spool) adds print checks after every step: fits the bed (each piece), sealed, walls ≥ 0.84 mm, overhangs needing support, flat base. Print helper ops: `text` (raised or engraved, Roboto Bold), `hole` (M2–M5 clearance / tap / heat-set insert, counterbore), `split` (cut to fit with pin holes and pins), `chamfer` (bottom edge); fit gaps as params (`$fitPress`, `$fitSlide`, `$fitLoose`) calibrated by a printed `fit-test` coupon. `print-fix --fix lay-flat \| chamfer \| split` applies a fix as one reviewable step. `studio print` has Bambu Studio's own command line build an A1 mini project (your PLA preset, arranged, one object per piece), slices a copy for a time/filament estimate, and opens it in Bambu Studio — you press Print there; the studio never talks to the printer. |
| **Games** | `/game` turns studio scenes into games: `studio game init --engine godot` (standalone) or `--engine web` (three.js + Rapier), then `import` (round-trips the GLB through the engine and fails on any warning), `screenshot` (the engine's own renderer), `walk-to` (a capsule player with physics: reached / blocked), `test` (on, grounded, reachable… assertions) and `run`, all headless. |
| **Other agents** | `studio mcp` serves the same tools over MCP: `claude mcp add studio -- node /path/to/AI3DModel/packages/cli/studio.ts mcp`. |
| **Theme** | Light/dark follows your OS; the header button cycles auto → light → dark. |

## Layout

| Path | What |
|---|---|
| `packages/core` | DOM-free engine: scene IR (`types.ts`), branching change log (`history.ts`), op graph on Manifold (`kernel.ts`), checks (`checks.ts`), placement relations and linked copies (`scene.ts`), material presets (`materials.ts`), importers and asset store (`importers.ts`, `assets.ts`), the one typed tool registry (`tools.ts`), `Studio` facade, GLB/OBJ/STL export |
| `packages/daemon` | Owns the Studio, persists `.studio/repo.json`, serves the view, relays renders and selection, code-mode sandbox (`sandbox.ts`) |
| `packages/cli` | `studio.ts` (the CLI the skill calls; generated from the registry; JSON out; did-you-mean on bad commands/flags) + `client.ts` |
| `packages/mcp` | MCP stdio adapter generated from the same registry |
| `packages/game` | `/game` back ends: Godot driven from its command line (`godot.ts`, templates/godot with a post-import script and a play-test runner) and three.js + Rapier in headless Chrome (`web.ts`, `chrome.ts`, templates/web with a harness). `roundTrip(glb, engine)` for export checks |
| `apps/view` | Three.js view in the Soft Premium tokens: scene tree · viewport with picking, gizmo and drop-to-import · inspector with live sliders · Claude Code feed + review · history. `look.ts` holds the shared look (PBR materials, wood-grain shader, environment light, shadows) |
| `.claude/skills/studio/SKILL.md` | The `/studio` playbook Claude Code follows |
| `.claude/skills/game/SKILL.md` | The `/game` playbook: import, look, play-test, assert, run |
| `bench/` | `run.ts` reference solutions (21 tasks), `talking-face.ts` (the lip-sync checkpoint video), `TASKS.md` AI benchmark + results, `score.ts`, `break.ts` |
| `.decisions/` | The 10 architecture decisions, live preview, design tokens (light + dark), implementation plan |

## Games (`/game`)

The studio makes assets; real engines run games. Game projects live in `games/<name>/` with their own `.gitignore` for engine caches.

```bash
./studio game init --name forge --engine godot     # or --engine web (three.js + Rapier)
./studio game import --project forge               # export + engine round trip: objects, triangles, materials, warnings
./studio game screenshot --project forge --views iso,front
./studio game walk-to --project forge --target "Walnut stool"
./studio game import --project forge --player Apprentice   # a studio character is the player: walk/idle clips, WASD in the game
./studio game walk-to --project forge --target Anvil --video true
./studio game test --project forge --assertions '[{"kind":"on","node":"Vase","target":"Walnut stool"}]'
```

- **Godot**: Godot 4 (`brew install --cask godot`, or set `GODOT_BIN`). Import, run and tests run headless; screenshots open a window off-screen for a moment (headless Godot has no renderer). A post-import script re-applies studio material features Godot's glTF importer drops (glaze clearcoat, glass transmission) and adds collision.
- **Web**: Google Chrome (or `CHROME_BIN`). The game is bundled with esbuild from `src/main.ts`; three.js and Rapier come from the studio's `node_modules`.
- Never edit `assets/studio/` or `studio/` inside a game: they're rewritten on every import. Your game code goes in `game/` (Godot) or `src/` (web).

## Commands

`./studio help` lists everything; `./studio <command> --help` prints one command's full schema. Highlights: `new-object`, `set-params`, `add-op`, `set-op`, `check`, `inspect`, `render`, `selection`, `propose`, `undo-step`, `commit-proposal`, `run`, `export`.

Environment: `STUDIO_PORT` (default 4517), `STUDIO_DIR` (default: current folder), `STUDIO_AUTHOR` (default `claude`).

## Tests

```bash
npm test        # all tests: engine, ops, checks, materials, scenes, drags, imports, game profiles + bake export, /game back ends, daemon, sandbox, CLI, MCP, view focus
npm run bench   # reference solutions: studio tasks + /game tasks on each installed engine
```

## Known limitations

- **No B-rep/CAD kernel.** Fillets are mesh-based (`roundedBox`, `round`); there is no STEP export. OCCT stays behind the kernel interface for when precision CAD is needed.
- **Materials are looks, not textures.** Wood grain is procedural (no UVs, no image textures); exported GLBs carry PBR values and the grain parameters in `extras`, not baked textures.
- **Relations are one per object** (on / next to / around…). Chains work (a glass on a tray on a table); two simultaneous constraints on one object do not.
- **Characters**: one stylized kit (no sculpting); Rhubarb drives 9 mouth shapes that map onto the 15 speech shapes, so TH/kk/CH/RR are only approximated; no tongue or teeth; morph normals aren't exported; no forearm twist bones; clothing is part of the mesh (no cloth). Rhubarb (MIT) downloads on first `say` to `~/.cache/ai3d-studio` (or set `RHUBARB_BIN`); the Kokoro model downloads on first use (~90 MB). Licences in `THIRD_PARTY.md`.
- **No face-level poly editing** (select a face, extrude, inset, bevel). Shapes come from typed ops and profiles; `smooth` covers organic forms. Sculpting is out of scope.
- Renders need the browser view open: the daemon asks the view to draw them.
- One daemon per port. Running `studio` in a second project while another daemon holds the port gives a clear error; set `STUDIO_PORT` per project.
- Merging a proposal onto a main that has moved applies the kept steps on top; there is no conflict UI.
