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
| **Build** | Boxes, rounded boxes, cylinders (tapered), spheres; `extrude` any polygon along x/y/z (tops, gables, brackets); `revolve` a profile (vases, bowls, turned legs); `smooth` (subdivision), `round` (fillet every edge), `trim` (cut flat at the floor); booleans, hull, mirror; `placeAt` named anchors with splay; `array`. Every dimension is a named, editable parameter. |
| **Check** | Watertight, one connected piece, legs grounded, nothing below the floor, custom range rules. In-progress states show as *pending* rather than failures. |
| **Look** | `studio render` asks the open view for labeled front/side/top/3-4 images with crease edges, which Claude reads. |
| **Point** | Click any part in the viewport. The inspector shows its size and the ops that made it, and `studio selection` hands it to Claude ("make *this* thinner"). |
| **Review** | AI edits to existing things arrive as proposals: hover a change to highlight it, hold Space for "before", Keep/Undo each change, compare alternatives as thumbnails, then Commit. |
| **Script** | `studio run --code "…"` runs JavaScript in a QuickJS WebAssembly sandbox (no filesystem or network, 5 s, 64 MB); every call is still a normal commit. |
| **Export** | GLB, OBJ, STL (mm, Z-up for slicers). |
| **Other agents** | `studio mcp` serves the same tools over MCP: `claude mcp add studio -- node /path/to/AI3DModel/packages/cli/studio.ts mcp`. |
| **Theme** | Light/dark follows your OS; the header button cycles auto → light → dark. |

## Layout

| Path | What |
|---|---|
| `packages/core` | DOM-free engine: scene IR (`types.ts`), branching change log (`history.ts`), op graph on Manifold (`kernel.ts`), checks (`checks.ts`), the one typed tool registry (`tools.ts`), `Studio` facade, GLB/OBJ/STL export |
| `packages/daemon` | Owns the Studio, persists `.studio/repo.json`, serves the view, relays renders and selection, code-mode sandbox (`sandbox.ts`) |
| `packages/cli` | `studio.ts` (the CLI the skill calls; generated from the registry; JSON out; did-you-mean on bad commands/flags) + `client.ts` |
| `packages/mcp` | MCP stdio adapter generated from the same registry |
| `apps/view` | Three.js view in the Soft Premium tokens: scene tree · viewport with picking + checks · inspector · Claude Code feed + review · history |
| `.claude/skills/studio/SKILL.md` | The `/studio` playbook Claude Code follows |
| `bench/` | `run.ts` reference solutions (8 tasks), `TASKS.md` AI benchmark + results, `score.ts`, `break.ts` |
| `.decisions/` | The 10 architecture decisions, live preview, design tokens (light + dark), implementation plan |

## Commands

`./studio help` lists everything; `./studio <command> --help` prints one command's full schema. Highlights: `new-object`, `set-params`, `add-op`, `set-op`, `check`, `inspect`, `render`, `selection`, `propose`, `undo-step`, `commit-proposal`, `run`, `export`.

Environment: `STUDIO_PORT` (default 4517), `STUDIO_DIR` (default: current folder), `STUDIO_AUTHOR` (default `claude`).

## Tests

```bash
npm test        # 22 unit tests: engine, ops, checks, export, sandbox, CLI, MCP, view focus
npm run bench   # reference solutions for the 8 benchmark tasks
```

## Known limitations

- **No B-rep/CAD kernel.** Fillets are mesh-based (`roundedBox`, `round`); there is no STEP export. OCCT stays behind the kernel interface for when precision CAD is needed.
- **No face-level poly editing** (select a face, extrude, inset, bevel). Shapes come from typed ops and profiles; `smooth` covers organic forms. Sculpting, UVs, rigging and animation are out of scope for this version.
- Renders need the browser view open: the daemon asks the view to draw them.
- One daemon per port. Running `studio` in a second project while another daemon holds the port gives a clear error; set `STUDIO_PORT` per project.
- Merging a proposal onto a main that has moved applies the kept steps on top; there is no conflict UI.
