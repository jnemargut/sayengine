# Implementation Plan: AI-First 3D Studio

## What We're Building
A 3D creation environment where AI agents create, inspect, modify and revise models through typed tools, and a human directs and reviews. You drive it from Claude Code with a `/studio` skill; the browser is a live view for watching, inspecting and keeping/undoing AI changes.
**See it: `.decisions/preview.html`** — the living preview is the visual spec. The working prototype lives in this repo (see README.md).

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 1 | Where the app runs | Headless DOM-free core + browser view (Electron later) | Strong | One-way |
| 2 | Scene source of truth | Records + branching change log; proposals are branches | Strong | One-way |
| 3 | Construction model | Typed op graph + readable code view, named params & anchors | Strong | One-way |
| 4 | Geometry kernel | Kernel interface; Manifold now, EditMesh/OpenSubdiv/OCCT later | Strong | One-way |
| 5 | How AI talks to the app | **Custom:** `/studio` Claude Code skill → `studio` CLI (from the zod tool registry) → engine daemon; MCP adapter optional later | User's call | Mostly one-way |
| 6 | AI perception | Deterministic checks every commit (authority) + labeled separate renders at milestones | Strong | Two-way |
| 7 | Visual direction | Soft Premium (Instrument Sans, stone + sage) — tokens in `tokens.css` | Lean (toss-up with Technical Documentary) | Two-way |
| 8 | Workspace layout | Docked panels (user's call over a lean toward Viewport Stage) | User's call | Two-way |
| 9 | Change review | Change-by-change Keep/Undo with viewport highlight, Space for before | Strong | Two-way |
| 10 | Build sequence | Thin vertical slice, then thicken | Strong | Two-way |

## Implementation Steps

### Slice (built — 2026-11-03)
- [x] Monorepo (npm workspaces), Node ≥ 23.6 native TypeScript, `./studio` launcher
- [x] `@studio/core`: Scene IR, branching log with proposals + per-step undo with dependency tracking, expression params, 13 ops on Manifold with per-part provenance, named anchors, checks (grounded / connected / aboveFloor / range), code view, GLB/OBJ export, zod tool registry (25 tools)
- [x] Daemon: persistence, websocket view sync, render relay, export, code mode (`run`)
- [x] CLI generated from the registry, auto-starts the daemon, JSON output
- [x] View: docked Soft Premium layout, live mirror, checks chips, inspector sliders (human edits are commits too), Claude Code activity feed, change-by-change review, Space for before, labeled renders for the AI
- [x] `/studio` skill playbook
- [x] Tests (7 unit) + reference benchmark (5 tasks pass headless)

### Thicken (built — 2026-11-03, overnight)
- [x] Ran the AI benchmark (Claude Code driving the CLI, headless view) and fixed every stumble it found: `set-params` can set units; in-progress states are *pending*, not failures; `check` returns one shape; did-you-mean for bad commands/flags; `<command> --help` schemas; "touching isn't joined" hint; clear missing-arg errors
- [x] Renders for the AI draw crease edges (openings were invisible in flat front views); the viewport uses creased normals (smooth curves, crisp edges)
- [x] Viewport picking: click a part, see its size and the ops that made it; `studio selection` hands it to Claude
- [x] Op vocabulary: `roundedBox`, `extrude` (x/y/z, either winding, taper/twist), `revolve`, `smooth` (subdivision), `round` (Minkowski fillet), `trim` (floor cut). Fixed a Manifold binding bug (numeric `scaleTop` collapsed shapes)
- [x] QuickJS-WASM sandbox for `studio run` (no fs/network, 5 s, 64 MB; `--code` or `--file`)
- [x] Alternatives UX: proposal thumbnails in the review panel
- [x] Dark variant of the Soft Premium tokens (OS-following, header toggle; AI renders stay light)
- [x] STL export (mm, Z-up)
- [x] MCP adapter generated from the same registry (`studio mcp`)
- [x] Tests 7 → 19 (ops, pending checks, STL, sandbox, CLI guard rails, MCP); reference benchmark 5 → 8 tasks

### Deliberately not built (decide when a benchmark demands it)
- [ ] **OCCT / B-rep** for true CAD fillets and STEP export: about 50 MB of WASM plus a second document kind. Mesh fillets (`roundedBox`, `round`) cover the visual need today. Tripwire: a real request for STEP or for tolerance-exact fillets.
- [ ] **Face-level poly editing** (EditMesh: select face → extrude/inset/bevel). Typed ops + profiles + `smooth` covered all 9 benchmark prompts. Tripwire from D3: > 40% of benchmark objects need raw mesh escapes.
- [ ] Sculpting, UVs/texturing, rigging, animation: out of scope for this version (per the original 6-week plan).

## Assumptions & Tripwires
| Assumption | Revisit if… | Affects |
|---|---|---|
| Scenes stay < ~2 GB of geometry | scenes approach 2–3 GB or native SDKs needed → Electron | D1 |
| Edits flow through one validated tool pipeline | two agents need simultaneous edits to one object → Loro under the record API | D2 |
| Typed ops cover most objects | > 40% of benchmark objects need raw mesh escapes → add modifier-stack layer | D3 |
| Manifold booleans are reliable | artifacts in > 5% of runs → mesh repair / OCCT booleans | D4 |
| Claude Code is the only driver | other agents/users need it → generate the MCP adapter | D5 |
| Images add value beyond checks | renders change outcomes in < 10% of runs → on-demand only | D6 |
| Light UI is fine | repeated dark-mode requests → ship dark tokens first | D7 |
| Per-change review gets used | whole-proposal accept > 90% → collapse behind "details" | D9 |
| Slice end-to-end by day 12 | it isn't → cut scope | D10 |

## Pre-Mortem
It's six months later and this didn't work. Most likely reasons:
1. **The op vocabulary was too thin for "general purpose"** — everything beyond furniture/architecture needed raw meshes the engine couldn't edit. *Early warning:* benchmark prompts outside hard-surface keep failing or Claude keeps asking for ops that don't exist.
2. **Claude was good at building, bad at taste** — checks pass, renders look clumsy, and you rate "looks right" ≤ 2. *Early warning:* score.ts shows few renders per task; proportions ignored the request.
3. **The review UI was ceremony** — you clicked Commit on every proposal without reading. *Early warning:* tripwire on D9 (whole-proposal accept > 90%).

## Low-Confidence Picks Worth Revisiting
- **D7 Soft Premium vs Technical Documentary** — settle after a week of real use: if you live in the Construction panel and code view, switch tokens to Technical Documentary.
- **D8 Docked panels** — if the viewport feels cramped on the MacBook Air screen, try the Viewport Stage layout (floating inspector + dock toggle).

## Decision History
`.decisions/index.html` for all decisions · `.decisions/preview.html` for the composite mockup · `.decisions/decisions.json` for the machine-readable record.
