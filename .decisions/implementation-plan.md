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

---

# Phase 2: Game Tools (decisions 11–18, decided 2026-11-04)

## What We're Building
The studio stays the place game assets get made: props, level pieces and characters, each with checks, history and keep-or-undo review. Real engines run the games: Godot for standalone games, three.js for web apps and browser games. A new `/game` skill lets Claude import, run, screenshot and play-test in either engine. Everything the AI finds hard (shapes, materials, rigs, motion) is made once in the studio and shared by both targets. **See it: `.decisions/preview.html`** (ledger chips 11–18 and the "Under the hood" strip).

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 11 | Shape of the toolset | Asset forge + a real engine | Strong | One-way |
| 12 | Art style | Low-poly + procedural materials baked to textures (E, added on request) | Lean → user chose E | One-way |
| 13 | Game targets | Godot for standalone, three.js for web; one asset contract (revised on request) | Strong | One-way |
| 14 | Character shape | Parametric character kits (import as reference) | Strong | One-way |
| 15 | Materials → textures | Auto-unwrap (xatlas) + bake per asset | Strong | Two-way |
| 16 | Animation | Parametric motion ops; library clips for one-off actions (user chose B over lean A) | Lean → user chose B | One-way |
| 17 | Game-ready checks | Live game-profile checks + engine round-trip on export | Strong | Two-way |
| 18 | First milestone | Walk around a tiny diorama, end of week 5 | Strong | Two-way |

## Implementation Steps
### 0. Prerequisite: in-flight features
- [ ] Review and merge the background branch `features/materials-scenes-drag-import` (material presets, scene placement, drag-to-edit, import). The diorama needs presets and placement.

### Week 1: export contract (D12, D15, D17)
- [ ] `export --target godot|web` with a game profile per object (`set-profile`): triangle / texture / bone budgets as checks, pending while mid-build
- [ ] Auto-unwrap (xatlas WASM) + lighting-free GPU bake of material presets in the view → one texture per asset; checks: texel density, island padding, stretch
- [ ] Generated ops: `collision` (box / hull / capsule) and `lod` (simplified copies)
- [ ] Khronos glTF validator on every export; unit tests + bench task 10 (baked prop)

### Week 2: `/game` skill, two back ends (D13, D17)
- [ ] `.claude/skills/game/SKILL.md` + `studio game` commands: `import`, `run`, `screenshot`, `walk-to`, `test`
- [ ] Godot back end: project template, import script that applies studio materials, `--headless --import`, windowed screenshot / `--write-movie` frames
- [ ] three.js back end: minimal viewer + Rapier, run through the headless Chrome the studio already uses
- [ ] Round-trip test on export (Godot import warnings + three.js load) fails the export; bench task 11

### Week 3: humanoid kit (D14)
- [ ] `character` template: settings for height, build, head size, limb lengths; parts (hair, clothes, tools) as ops
- [ ] Skeleton with Godot humanoid bone names, T-pose, ≤ 4 weights per vertex, twist bones at forearms; template-designed UV seams
- [ ] Pose-check suite (about 10 poses): joint volume ratio, edge stretch, self-intersection, weight sums; pose thumbnails in the review panel; bench task 12

### Week 4: motion ops (D16)
- [ ] `motion` ops: `walk`, `idle` (later `run`) with settings (stride, bounce, lean, arm swing, speed); preview in the view; baked to glTF clips on export
- [ ] Library clip import for one-off actions (CC0 first; licence recorded on the clip)
- [ ] Engine IK hooks: Godot foot planting / look-at; three.js equivalent; bench task 13

### Week 5: the diorama (D18)
- [ ] `/studio make a blacksmith and a little forge yard` → ~10 props + one kit character, all profiles green
- [ ] `/game play it in godot` → Claude walks the character to the anvil, screenshots; same assets in a three.js page
- [ ] **Tripwire:** not walking in Godot by end of week 5 → stop features, cut scope

### Week 6: benchmark and harden
- [ ] Bench task 14 (the diorama end to end) + run tasks 10–14 as the AI; fix what they find; update README and both skills

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| Goal is making games, not selling an engine | You want to sell the engine | D11 |
| Low-poly + baked materials gives a recognizable look | Playtesters call it generic → toon/outline shader, art-direct palette | D12 |
| Projects are usually one target | Same game wanted on both 2+ times → portable level format (D13 option D) | D13 |
| Kits cover the characters you want | Characters feel samey after 10+, or a body type is needed 3+ times → AI-generated parts or a new template | D14 |
| Early projects are small | Texture budget check fails → add atlas mode | D15 |
| Parametric walks can look natural | Walk still reads robotic after tuning → library locomotion as fallback | D16 |
| Live checks stay fast | Steps noticeably slower → move round-trip to export only | D17 |
| Character walks in Godot by week 5 | It doesn't → cut scope | D18 |

## Pre-Mortem
It's six months later and the game tools didn't work. Most likely reasons:
1. **The hand-off kept breaking.** Godot or three.js imports drifted from the studio (materials, skins, clips), and every fix was engine-specific. *Early warning:* the round-trip test is the most-failed check in weeks 2–5.
2. **Parametric motion looked robotic,** and fixing it ate the schedule. *Early warning:* week 4 ends with the walk "working" but nobody wants to watch it; you reach for library clips for locomotion.
3. **Two engines doubled the agent's failure surface.** Claude was fine in one and fumbled the other. *Early warning:* `/game` bench tasks pass in one back end and fail in the other more than half the time.

## Low-Confidence Picks Worth Revisiting
- **D12 (E vs A):** if the bake step slips past week 1, ship week-5 assets with presets only (A) and add the bake after. Same shapes, no rework.
- **D16 (B vs A):** if the parametric walk isn't convincing by the end of week 4, use a library walk for the diorama and keep motion ops for the settings that work (speed, lean, bounce).

## Decision History
`.decisions/index.html` for all decisions · `.decisions/preview.html` for the composite mockup · `.decisions/decisions.json` for the machine-readable record.
