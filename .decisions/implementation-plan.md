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

## Status (2026-11-04)
- Week 0 ✓ materials, scenes, drag-to-edit, import (merged)
- Week 1 ✓ export contract: game profiles, collision/LOD ops, auto-unwrap + bake, glTF validator (merged)
- Week 2 ✓ `/game` skill: Godot + three.js back ends; export round-trips through the target engine (merged)
- Weeks 3–6 above are **superseded by Phase 3 below**, which builds the kit with faces and hands from the start.
- Godot upgraded to 4.7.2 (Homebrew) for IK, spring bones and retargeting; game tests and benchmarks pass on it.
- Next: Phase 3 week 3, to start when you say "auto mode".

## Low-Confidence Picks Worth Revisiting
- **D12 (E vs A):** if the bake step slips past week 1, ship week-5 assets with presets only (A) and add the bake after. Same shapes, no rework.
- **D16 (B vs A):** if the parametric walk isn't convincing by the end of week 4, use a library walk for the diorama and keep motion ops for the settings that work (speed, lean, bounce).

---

# Phase 3: Faces, Hands and Cutscenes (decisions 19–25, decided 2026-11-04)

## What We're Building
Characters that act in cutscenes: stylized faces that speak and emote, real fingers that gesture and grip, and a body that moves with them, all driven by one performance description per line. Claude directs cutscenes in words, you review them as storyboard frames, and one cutscene file plays in both Godot and three.js. **See it: `.decisions/preview.html`** (ledger 19–25, "Under the hood").

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 19 | Face detail | Stylized big-shape faces in the kit (same style as the body) | Strong | One-way |
| 20 | Face rig | 15 standard speech shapes + ARKit-named expression subset (~16) + jaw/eye/head bones | Strong | One-way |
| 21 | Lip sync | Any audio + script aligned locally (Rhubarb / Whisper) → smoothing with M/B/P closure | Strong | Two-way |
| 22 | Hands | Full fingers, poses as settings, grip sockets on props | Strong | One-way |
| 23 | Coherence | One performance script per line → shared-beat channels + procedural life layer | Strong | One-way |
| 24 | Cutscenes | Studio cutscene file → generated Godot AnimationPlayer + small three.js player; storyboard review | Strong | One-way |
| 25 | Milestone | "The Forge Lesson" by week 8, talking-face checkpoint at week 4 | Strong | Two-way |

## Implementation Steps (replaces Phase 2 weeks 3–6)
### Week 3: humanoid kit with face and hands (D14, D19, D20, D22)
- [ ] `character` template: proportions as settings; parts (hair, clothes, tools) as ops
- [ ] Skeleton: Godot humanoid bone names incl. fingers (3 joints each) + jaw, eyes, head; T-pose; ≤ 4 weights/vertex; twist bones at forearms; template-designed UV seams
- [ ] Face template: denser face region, ~15 speech + ~16 expression shape keys generated per character; glTF morph export (sparse, no morph normals on web) + a face-shape budget check
- [ ] Pose checks (joint volume, edge stretch, self-intersection, weight sums) + finger-through-prop check; thumbnails in review; bench task

### Week 4: voice and lip sync + checkpoint (D21)
- [ ] `studio line` tool: audio file + script → alignment (Rhubarb, Whisper timings) → 15 shapes → smoothing (coarticulation, M/B/P closure, emotion scale)
- [x] Checks: lips closed on every M/B/P; no shape held unnaturally; sync offset
- [ ] Test voices: a **local, free** text-to-speech model (user's call, 2026-11-04), no paid services. Candidates: Kokoro-82M (Apache-2.0, runs locally via kokoro-js / ONNX) first, Piper as fallback; confirm each voice's licence before use
- [ ] **Checkpoint:** one close-up line rendered for you to judge. Tripwire: not reading as speech after a week of tuning → revisit 19–21

### Week 5: motion, life and hands (D16, D22, D23)
- [ ] Motion ops `walk`, `idle` with settings; baked to clips
- [ ] Life layer: blinks (random), eye saccades (talking/listening modes), breathing, weight shifts, seeded
- [ ] `set-hand` poses (curl/spread/thumb) + named poses; `hold` with grip sockets generated for studio props

### Week 6: walking diorama (D18)
- [ ] Blacksmith + forge yard; `/game play it in godot`; same scene on the web; tripwire as before

### Week 7: one performance (D23)
- [ ] Performance script per line (emotion, gaze, gestures, grip, posture) → compiled channels sharing beats
- [ ] Gesture library (palm-down, point, shrug, fist, open palms, count…) on the hand poses + body kit
- [ ] Webcam capture (MediaPipe) as an optional override source, later if time allows

### Week 8: cutscenes (D24, D25)
- [ ] Cutscene file (shots, cameras, cuts, lines, audio, events, engine escape hatch); storyboard frames; keep/undo per shot
- [ ] Export → generated Godot AnimationPlayer scene; three.js cutscene player
- [ ] **"The Forge Lesson"**: 2 characters, 4 shots, 3 lines, plays in both engines. Bench tasks; tripwire: not playing in Godot → defer three.js player

### Status of weeks 5–8 (2026-11-04)
- **Week 5: built** (bee38ea).
  - Parametric walk, run, idle and turn motions, plus library actions, with IK legs and planted feet.
  - A life layer in idle and in lines.
  - Hands and held props carried through motion.
  - The crouched walk is fixed and has its own check: hips ≥ 95% of standing height, planted knee ≥ 165°.
- **Week 6: built.**
  - The forge yard plays in Godot and on the web, with the apprentice as the player walking up to the anvil.
- **Week 7: built.** `perform` adds one performance per line:
  - emotion on the face, and beats that change it mid-line
  - posture
  - gaze toward the listener
  - gestures on words from a 15-gesture library: the stroke lands just before the stressed syllable, the forearm and hand trail, close gestures flow into each other, and a hand holding a prop is left alone
  
  It compiles onto the idle as one full-body `line:<id>` clip, with a performance check. `--auto` picks gestures from the words. Webcam capture was not built.
- **Week 7–8 motion fixes** (required by you). Each has a check:
  - The apron swings on two spring-driven bones that never pass behind the knees, and it bends.
  - The run has flight, lean, heel recovery and 150–195 steps/min.
  - The hammer strike has a wind-up, a fast downswing, knees that soften at impact, and a settle.
  - Start and stop steps: feet stay planted (≤ 3 mm), and both game players use them when movement starts and stops.
- **Week 8: built.**
  - The cutscene file: shots framed on characters (close, medium, two-shot, over-shoulder, wide, custom, with push-in, pull-out and drift), lines with listeners, actions, events, and an engine escape hatch.
  - Checks: speakers in frame, cuts between words, and the 180° rule; an unspecified side keeps to the established axis.
  - `cutscene-preview`: a storyboard plus an MP4.
  - `game import` writes a generated Godot AnimationPlayer scene and the three.js player.
  - `game cutscene` plays it in either engine.
- **"The Forge Lesson": done.** Two characters, four shots and three lines in local Kokoro voices play in both engines. `node bench/forge-lesson.ts` writes `checkpoint-week8/`.
- **Not done:**
  - Storyboard thumbnails inside the studio's own view (the storyboard is an HTML page next to the preview).
  - The webcam override.

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| Stylized faces hold close-ups | Close-up renders look lifeless after tuning → denser face region or hero heads | D19 |
| Speech mostly from audio/text, not phone capture | You start capturing on a phone → extend to full ARKit 52 | D20 |
| Smoothing makes aligned lip sync read as speech | Week-4 checkpoint fails → Audio2Face on hero lines (cloud) | D21 |
| Finger bones fit web/mobile budgets | Bone budget fails repeatedly → drop finger bones in those profiles | D22 |
| Rule-driven performances feel alive | Repetitive across 20+ lines → gesture variation + webcam overrides | D23 |
| The cutscene format stays small | Grows past ~15 shot/event kinds → push extras to engine escape hatches | D24 |

## Pre-Mortem
It's six months later and the cutscenes didn't work. Most likely reasons:
1. **Mouths read as robotic.** The smoothing pass never got past "technically synced". *Early warning:* the week-4 checkpoint passes only after lowering the bar.
2. **The week-3 kit was too ambitious.** Body, face and hands with clean weights at once produced a template full of deformation bugs that everything else inherited. *Early warning:* pose checks keep failing at knuckles, jaw or shoulders into week 5.
3. **Performances felt mechanical.** The same gestures on every line. *Early warning:* in the week-8 scene, you can predict each gesture before it happens.

## Decision History
`.decisions/index.html` for all decisions · `.decisions/preview.html` for the composite mockup · `.decisions/decisions.json` for the machine-readable record.


# Phase 4: The Tool Suite (decisions 26–34, decided 2026-11-04)

## What We're Building
Six new studio modules, each turning a pain from the Raleigh Terrarium audit into a tool: **world** (towns, real or invented), **look** (whole-scene looks), **life** (folk, animals, vehicles), **proof** (pictures and release checks), **reel** (trailers) and **sound**. They are proven together on "Pocket Raleigh": three real blocks of downtown Raleigh plus an invented river town, walkable in Godot and on the web. The audit is in `.decisions/terrarium-audit.html`. **See it: `.decisions/preview.html`**.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 26 | Shape of the suite | One studio, modules on demand (each a tool group + skill) | Strong | One-way |
| 27 | Real places to scenes | Custom: one town pipeline, real or invented, with fix layers | Your call | One-way |
| 28 | Splats | No splats | Your call | One-way |
| 29 | Look lab | Looks as data, reference boards, measured targets | Strong | Two-way |
| 30 | Life, crowds and traffic | Smart places, seeded schedules, one set of lanes | Strong | Two-way |
| 31 | Proof gate | Mac only: pinned views, picture diffs, imitated phone, word lists | Your call over A | Two-way |
| 32 | Capture and trailers | Trailers are cutscene files, cut to the beat | Strong | Two-way |
| 33 | Sound and music | Layered: synth, Stable Audio Open Small, CC0 libraries, seeded stems | Lean | Two-way |
| 34 | Build order | Pocket Raleigh, weeks 9–14, after Phase 3 week 8 | Strong | Two-way |

## Implementation Steps (start after Phase 3 week 8)

Each module is a folder in the monorepo with its own ops, checks, CLI tool group and small skill. `/studio` is always loaded; the others load only when needed (D26).

### Status (2026-11-05): weeks 9–10 built on `phase4/world-proof`
**Built:** the world module (`packages/core/src/world/`, tool group `world-*`, skill `/world`) and the proof module (`packages/proof/`, `studio proof …`, skill `/proof`). Proof target: `games/pocket-raleigh` (Godot 4.7.2) and `games/pocket-raleigh-web` (three.js): three real blocks of Fayetteville St around City Plaza plus an invented river-town twin, walkable in both (walk-to reaches in both engines). Pictures and a walk video: `checkpoint-pocket-raleigh/world/`. 145 tests; `npm run bench:world` 7/7.

**Weak (honest):**
- **It reads as a clean toy downtown, not yet as Raleigh.** The skyline heights are right (the real tall towers stand where they should) and a craft pass added facade schemes, two-storey bases, cornices, tower crowns, crosswalks, varied trees and sidewalk furniture, but nothing is Raleigh-specific: no landmark models yet (the swap-in works; nobody has modelled the Wells Fargo crown or the City Plaza light towers), and street level is dominated by plain asphalt. The pre-mortem's #1 risk is still live: the next lever is landmarks + regional style rules, not more data.
- The river twin is the more charming of the two (gables, colours, a mill, a church, a green); its lots are a little too regular.
- Ground under the town is flat beige between buildings (parking lots read as empty).
- Godot and the web differ in tone (FLIP parity ≈ 0.4: different tonemappers and ambient) — that's week 11's look work.
- The imitated phone runs on the Mac's GPU: 60 fps in WebKit at 390×844 @3x and in Chrome with the CPU slowed 4×. That says little about a real iPhone's GPU or memory (Decision 31's accepted risk).
- No per-building nodes in the engines: buildings are merged into ~110 m chunks with vertex colours (≈ 90 draw calls in Godot, ≈ 180 on the web with shadows, down from 1,700); the per-building ids ride in the chunk's extras.
- Fetching needs the network and the free `overturemaps` CLI (`~/.studio-tools/venv`); USGS ground is US only.

### Week 9: world, real
- [x] Town plan format: streets, lots, buildings (height, floors, roof type, use), water, parks, with a stable ID on every feature. *(`world/plan.ts`; ids `ov:<GERS>`, `osm:w<id>`, `inv:<seed>:<lot>`)*
- [x] Real source: fetch and cache Overture buildings, USGS 3DEP ground, and OSM roads, water and parks for an area. *(`studio world-fetch`; overturemaps CLI, the 3DEP ImageServer as raw float32, Overpass; cached in `.studio/cache/world/<area>`; a 56 KB offline test fixture)*
- [x] Building rules:
  - square up outlines *(minimum rectangle or orthogonal snapping)*
  - roofs from the roof type *(flat + parapet, gable, hip, shed, pyramid, dome)*
  - clamp silly values *(height, floors, 12:1 slenderness, pitched roofs only on simple outlines)*
  - grade roads *(≤ 8%, the ground pulled to the road)*
  - per-region style rules *(`raleigh-downtown`, `river-town-1920s`; sidewalks widen to the building line)*
- [x] Fix layer, keyed by Overture building ID with a position fallback. Every rebuild re-applies the fixes, and a check flags any fix that has lost its building. Landmarks can be swapped for studio models. *(tested through a simulated data refresh: id changed → lands by position; building gone → `world-fixes` check fails)*
- [x] Credits and shared data as the open-data licence (ODbL) requires. *(`world-info --credits`, `world-share`, the GLB's `asset.copyright`; data names never become node names)*

### Week 10: world, invented + proof
- [x] Invented source: a style plus a street sketch, or a short description, becomes the same town plan. IDs come from seed + lot. *(description parsing is keyword rules; Claude writes the sketch for anything richer)*
- [x] Remix source: real streets with invented buildings.
- [x] proof (D31, Mac only): pinned clock and seed, fixed views in Godot and web, FLIP picture diffs, budgets, a phone-sized WebKit window with a throttled CPU. *(`proof init/views/approve/phone`; the throttle is Chrome's — WebKit can't be CPU-throttled, so the phone run does both)*

### Week 11: look
- [x] Look record:
  - tonemapper, pinned *(neither engine picks one: both output Reinhard x/(1+x) as a "transport", and the LUT undoes it and applies the look's curve — neutral, aces, filmic, reinhard or linear)*
  - 33³ colour grade *(exposure, white balance, contrast, lift/gamma/gain, split toning, saturation and vibrance in Oklab)*
  - toon and outline *(outline drawn in both engines from the depth buffer; **toon is in the record but not drawn yet**)*
  - palette
  - fog, sky and light
  - material tweaks *(by shading class: towns now carry `lit` windows, `lamp`, `neon` and `sign` classes a night look lights up)*
- [x] The look drives the studio view (viewport, thumbnails, presentation renders), Godot (the LUT as a lossless strip sliced into a Texture3D), three.js (one grade pass wrapping `renderer.render`), and bakes. Reels will render through the same games. *(`packages/core/src/look/`, tools `look-*`, skill `/look`)*
- [x] Bake fallback for renderers without colour grading *(Godot Compatibility, or `fallback: "bake"`: the grade is baked into the GLB's vertex and base colours on import, exact under the look's reference light)*.
- [x] Reference boards and gates: colourfulness range, palette match, and a local style score (DINOv2-small in `~/.studio-tools/venv`). Claude judges only by A/B picks (`studio look board|ab|pick`; picks are logged).
- [x] Two looks: "day toy" and "neon night" on Pocket Raleigh, both engines. Pictures, sheet and flythrough: `checkpoint-pocket-raleigh/look/`.

### Status (2026-11-05): week 11 built on `phase4/look`
**Parity fixed:** Godot vs web FLIP on the 10 pinned views is 0.054–0.110 with day toy and 0.040–0.088 with neon night (was 0.34–0.46). What it took: the shared transport + LUT, Lambert diffuse in Godot (its default Burley brightens grazing views), no background reflections in Godot, light energies ×π in three.js, an ambient light instead of a hemisphere, and a measured Godot 4.7 quirk (with fog on, the BG_COLOR sky is sRGB-decoded twice). What is left is shadow-map filtering and anti-aliasing.

**Craft against "generic toy downtown":** PNC Plaza and Wells Fargo Capitol Center are studio models swapped in with the landmark fix; the four City Plaza light masts are one studio model placed four times by a new fix kind (`--place`, a prop that replaces no building). The `raleigh-downtown` style rules now break the window grids (lit windows, blinds, blank bays, paired windows, attic rows, curtain walls in bays) and give the street level brick pavers, parked cars, café tables under umbrellas, lamp-post banners, blade signs and lawn patches.

**Weak (honest):**
- Looking at the stills: it reads as **a downtown with Raleigh's skyline**, not as Fayetteville Street at eye level. From the plaza you see the PNC crown, the Wells Fargo top and the light masts, which is a real gain; but the street walls are still rule-built boxes, and nothing at street level (the Capitol at the north end, the Performing Arts Center at the south end, the real storefronts) says Raleigh.
- The landmark shapes are from memory of the skyline, not a survey or photos (none were available locally).
- Neon night has no glow (bloom) and no pools of lamp light on the ground: lights are emissive surfaces, not lights. Bloom would need matching Godot glow and a web bloom; parity would have to be re-earned.
- There are no user reference pictures yet, so the palette gate ran against the look's own palette and the targets are a first guess. The local style score (DINOv2-small, ~2 s a picture) barely separates the two looks (both ≈ 0.70 against the week-10 stills): it responds to content more than style. That trips Decision 29's tripwire: try CSD, or keep only colourfulness and A/B.
- The gates did their job once: day toy v1 was above the colourfulness range on 10 of 20 renders; v2 (less saturation) fails 2 and was picked A/B (`checkpoint-pocket-raleigh/look/picks.jsonl`).
- Toon shading is not drawn. Window lighting is per pane, at one constant warm colour.
- Bake fallback: textures keep only a graded factor, not graded texels.

### Week 12: life, people
- [ ] Smart places: benches, stalls, piers, dog walks.
- [ ] Seeded cast and schedules by hour, season and event.
- [ ] One baked walk mesh and lane graph, with the same polygons exported to both engines.
- [ ] Small runtimes in TypeScript and GDScript with shared tests.
- [ ] A sped-up headless day checks overlaps, wall crossings, pops and player collision.

### Week 13: life, vehicles + sound
- [ ] Cars and a bus on lanes: car following, stop lines, braking for the player.
- [ ] sound:
  - synth for game sounds
  - Stable Audio Open Small and CC0 libraries for foley and ambience
  - seeded stems that adapt to the action (Godot interactive streams and a web version)
  - beat-cut loops
  - a licence on every file, feeding the credits

### Week 14: reel + milestone
- [ ] Reel: a cutscene file plus an edit track.
  - Godot movie mode and web fixed-step capture.
  - Beat cuts, with beat detection by librosa as a separate tool.
  - A crop box per shot for 16:9, 1:1 and 9:16.
  - The final edit written as an ffmpeg recipe.
- [ ] Release checks: on-Mac OCR against brand and team lists, a wording list, and REUSE credits.
- [ ] **Milestone, Pocket Raleigh:**
  - three real blocks plus an invented twin, walkable in Godot and web
  - two looks
  - folk, cars and a bus on a seeded Saturday, with sound
  - a 30 s trailer
  - a roof fix that survives a data refresh

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| Modules stay separate inside one daemon | `/studio` edits take more than 200 ms while a town is loaded → move world building into a worker process | D26 |
| Overture IDs stay stable | More than 10% of fixes lose their building on a refresh → key by position + shape | D27 |
| Rule-built buildings look good enough | Generic in the look lab → regional style rules before more data | D27, D29 |
| Godot and web colours match closely | They visibly differ after pinning the tonemapper → bake the grade for the web | D29 |
| Two life runtimes agree | More than 0.5 m apart on the same seed → one shared core (WASM + GDExtension) | D30 |
| Mac-only proof is enough | A phone-only bug reaches players → add the real-iPhone tier from D31 option A | D31 |
| ACE-Step weights can be shipped | Licence not clearly commercial → no song generation | D33 |
| A game idea doesn't take over | One does → switch to "build what the game needs" at a week boundary | D34 |

## Pre-Mortem
It's six months later and the suite didn't pay off. Most likely reasons:
1. **Towns looked generic.** The rules made tidy boxes with no charm, the opposite of Terrarium's appeal. *Early warning:* week 9's blocks need many hand fixes before they read as Raleigh.
2. **The phone bit back.** Mac-only proof passed, but iPhone Safari froze or fizzed again. *Early warning:* the first real-phone try of Pocket Raleigh shows problems the imitated phone missed.
3. **The modules tangled.** One daemon grew a Terrarium-style 5,000-line file. *Early warning:* a change to one module keeps breaking another's tests.

## Low-Confidence Picks Worth Revisiting
- **D33, sound (Lean):** the music half is unproven. A first listen to seeded stems in week 13 settles it.
- **D31, proof (your call over A):** watch for phone-only bugs and add the iPhone tier if one appears.


# Phase 5: Game Planning Skills (decisions 35–42, decided 2026-11-04)

## What We're Building
`/x-decide-gaming` takes a loose game idea to a great first playable. It surfaces the decisions decision-kit style (visual pages, you pick, everything recorded) and hands each stage to the studio tools to build. Toy first: you get something to play about an hour after the idea, and the look comes last. Reference: https://github.com/jnemargut/decision-kit.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 35 | Shape of the family | Router + `x-game-concept`, `x-game-design` (thinking) + `x-game-build`, `x-playtest` (action) | Strong | One-way |
| 36 | Where it lives | Ships in the studio repo (private now, public when finished); an install step links it into `~/.claude/skills` | Strong (after your note) | One-way |
| 37 | Idea to first version | Toy first, then grow it: fantasy/pillars → grey-box toy → 3Cs + feel → loop + playtest → one-page scope → look/world/cast → v1 | Strong | One-way |
| 38 | What a decision page shows | Playable toy presets for feel, studio renders for looks, clips for motion, diagrams for loop/scope | Strong | Two-way |
| 39 | Living preview | One-page design with the current build embedded, plus a decision ledger | Strong | Two-way |
| 40 | Hand-off to building | `game-spec.json` (each field cites a decision) → build steps as studio proposals; stop at real gaps; partial rebuilds | Strong | One-way |
| 41 | Playtests | Question-led; you play then **type** notes (talking aloud optional); bots measure; great-v1 checklist; findings link to decisions | Your change to A | Two-way |
| 42 | Milestone | Build alongside weeks 9–14; week 15: your own idea to a great v1 | Strong | Two-way |

## Status (2026-11-05)
Built on `phase5/game-skills` (instruction layer complete; not yet used on a real game):
- **Skills:** `.claude/skills/x-decide-gaming` (router, the only one Claude can invoke on its own) plus the manual-only `x-game-concept`, `x-game-design`, `x-game-build` and `x-playtest`.
- **Shared references:** in the router's `references/`: road, conventions, page skeleton, game-spec.
- **Locating the studio:** `scripts/find-studio.sh` finds it from any folder.
- **Installing:** `./studio install-skills` links the family into `~/.claude/skills` (`--copy`, `--all`, `--bin`, `--force`; never clobbers foreign folders).
- **Validation:** decision-kit's validator rules are ported into `packages/cli/test/skills.test.ts` and run in `npm test`. That test also checks that only the router auto-invokes and checks install-skills.
- **Trigger fixtures:** `bench/skills/triggers.json` (3+ should and should-not per skill). These aren't run against a live model yet.
- **Dry run:** "a cozy game where you deliver bread at dawn" through concept: two decision pages, index, one-page preview, and a game-spec stub, in `checkpoint-game-skills/bread-at-dawn/.decisions/`.

Not done yet:
- The playable-preset path (decision 38) and the bots in `x-playtest` are written as instructions but not exercised end to end. The first real use is the tiny game.

## Implementation Steps (run alongside Phase 4, weeks 9–14)

### Weeks 9–10: planning half
- [ ] `skills/x-decide-gaming`: the router, and the only skill Claude can invoke on its own. It routes by stage and passes `/autodecide`, `/overdecide` and `/underdecide` through. The four child skills are manual-only.
- [ ] `skills/x-game-concept`: one-line fantasy, 3 pillars, toy / loop / story, scope. Story-led ideas get the pitch-first order.
- [ ] `skills/x-game-design`: the 3Cs, a feel pass, loop, look, world, cast.
- [ ] Playable decision pages: a parametric web toy with four presets, built via `/game`. Fall back to clips if a page takes more than 5 minutes, or to diagrams if the studio is missing.
- [ ] Every skill writes decision-kit's `.decisions/` format and stays under 500 lines, with `references/` one level deep.

### Weeks 11–12: building
- [ ] `game-spec.json` schema. Each field carries a `from: dN` decision reference, plus named settings for anything not settled yet.
- [ ] `skills/x-game-build`:
  - Turn the spec into a step list of `/studio`, `/game`, world and look calls.
  - Run each step as a studio proposal with its checks.
  - Stop with a small decision page at gaps that change how the game plays or looks; fill small gaps with defaults and list them afterwards.
  - Rebuild only the parts a changed decision affects.
- [ ] The one-page living preview (`.decisions/preview.html`): pitch, pillars, controls, loop, scope and look blocks, plus the embedded web build. Undecided blocks stay grey.

### Weeks 13–14: playtests and packaging
- [ ] `skills/x-playtest`:
  - Claude suggests the question for each playtest.
  - You play, then type your notes. Talking aloud with local transcription is optional.
  - Bots play the game using the life runtime.
  - A great-v1 checklist: 30 seconds of fun, a newcomer gets it, the pillars show.
  - Each finding links to a decision, with a one-click "revisit".
- [ ] `./studio install-skills` links the skills into `~/.claude/skills`.
- [ ] Decision-kit's `validate-skills.py` runs in the studio's tests.
- [ ] At least 3 trigger evals per skill: should-trigger and should-not-trigger.

### Week 15: milestone
- [ ] You bring a game idea, and `/x-decide-gaming` takes it to a played, playtested first version in about a week.
- [ ] Before calling v1 done, run one round with real newcomers.

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| A grey-box toy can be built in about an hour | It takes more than a session → one verb, one camera | D37 |
| Only the router is auto-invoked | Wrong skill fires → narrow its description and add evals | D35 |
| Playable pages stay quick | More than 5 minutes per page → use clips for that decision | D38 |
| Build stops are rare | More than 3 stops per toy → raise the gap threshold | D40 |
| You'll have an idea for week 15 | None by week 14 → make Pocket Raleigh the game (option D) | D42 |
| The planning half is useful without the studio | Someone asks for it → publish a decision-kit game tier | D36 |

## Pre-Mortem
It's six months later and nobody uses `/x-decide-gaming`, including you. Most likely reasons:
1. **Too slow to fun.** Decision pages and playable presets took longer than just prototyping. *Early warning:* in week 15, the first toy arrives after more than one session.
2. **Decision fatigue.** Build stops and playtest forms piled up. *Early warning:* you start answering "just pick" more than half the time.
3. **The build skill lagged the tools.** Modules changed under it and builds broke. *Early warning:* the build skill gets two breaking fixes in a single week.


# Phase 6: Printing Path (decisions 43–46, decided 2026-11-04)

## What We're Building
An easy, occasional path from "/studio make X" to a print on your Bambu Lab A1 mini (single spool, no AMS) using Bambu Studio 2.08 on this Mac. You type one command, glance at the plate and press Print.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 43 | Path to print | `/studio print`: checks run, Bambu Studio's command line builds an A1 mini project, it opens in Bambu Studio, and you press Print. If the command line fails, it falls back to a checked STL | Strong | One-way |
| 44 | Checks | A print profile (A1 mini, 0.4 nozzle, PLA) with live checks; fixes come as proposals | Strong | Two-way |
| 45 | Colour | One colour, always (your call over a pause-and-swap option) | Your call | Two-way |
| 46 | Helpers | `fit` (named gaps), `fit-test` coupon, `text`, `hole`, `split` with pegs | Strong | Two-way |

## Implementation Steps
- [ ] **Print profile `a1-mini-pla`**, with live checks:
  - fits the bed (180 mm cube, 5 mm margin)
  - sealed shape
  - minimum wall 0.8 mm (warn below 1.2 mm)
  - overhang estimate (support below 30° from horizontal)
  - base area
  - features under 0.4 mm
- [ ] **Fix proposals:**
  - orient for fewest supports
  - thicken thin walls
  - 0.4 mm bottom chamfer
  - split (from the helpers)
- [ ] **Helper ops:**
  - `fit` gaps as params (`$fit.press`, `$fit.slide`, `$fit.loose`)
  - `fit-test` coupon, plus a `set-fit` command to record which slot fit
  - `text` using a bundled open font, with strokes of at least 0.8 mm
  - `hole` (M2–M5 clearance, self-tap, heat-set insert)
  - `split` with pegs and holes
- [ ] **`studio print`:**
  1. Run the checks.
  2. Export the STL in mm.
  3. Merge the A1 mini printer, process and filament presets into full JSON files. This avoids the Apple Silicon crash in issue #9636.
  4. Run `BambuStudio --orient --arrange 1 --ensure-on-bed --load-settings ... --load-filaments ... --export-3mf`.
  5. Run `open -a BambuStudio`.
  - If the command line fails, fall back to the STL plus `open -a BambuStudio`, and say why.
  - Use the user's "Bambu PLA Basic @BBL A1M" preset by default, and allow choosing a filament by name.
- [ ] **Install self-test:** build a test cube project through the command line once.
- [ ] **`/studio` skill update:** a "printing" section, plus an example "make a box with a sliding lid".

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| The Bambu Studio command line works with merged presets | It breaks twice after updates → make the STL fallback the default | D43 |
| Overhang estimates are close to what the slicer finds | Often off → show as a hint only | D44 |
| One colour is enough | You ask for two-tone prints → revisit D45 option A | D45 |
| Five helpers are enough | You ask for a thread, gear or hinge twice → add that helper | D46 |


# Phase 7: Characters That Don't Look Alike (decisions 47–51, decided 2026-11-04)

## What We're Building
The studio makes characters from words, starting with each one's skeleton. Every body plan gets its own body, a face made of parts that each know how to talk, and hair and outfits. Motion is computed from each body's proportions. Outside rigged characters come in through a side door. **New order:** weeks 9–11 are characters, weeks 12–17 are Pocket Raleigh (Phase 4) with the game skills alongside (Phase 5), and week 18 is your own game idea.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 47 | How characters are made | Skeleton first: body plans → blob bodies → face parts → hair and outfits → style family; cast outline check | Strong | One-way |
| 48 | Motion for any body | Computed from proportions (stride and cadence from leg length, IK feet), style settings, body-relative checks | Strong | One-way |
| 49 | Faces | Face parts carry their own 15 speech shapes and expressions | Strong | Two-way |
| 50 | Outside characters | Rigged glTF/VRM import, automatic bone map, our own retargeter, faces from the model's own shapes, VRM licence check, a report | Strong | Two-way |
| 51 | When | Right after week 8, before Pocket Raleigh | Lean | Two-way |

## Implementation Steps
### Week 9: bodies
- [x] Body plans: today's human, plus chibi, lanky, stocky and beaked biped. Standard humanoid bone names apply where they fit.
- [x] Bodies are smooth-blended shapes around the bones, with automatic skin weights.
- [x] Style families and palettes.
- [x] Cast outline check: a new character must differ from the existing cast.
- [x] A reference picture can steer proportions and colour.
### Week 10: motion and faces
- [x] Generalise the week 5–6 walk, run, idle and turn:
  - stride and cadence scale with leg length
  - feet placed with IK
  - style settings: waddle, swagger, shuffle, bounce
- [x] Make the checks body-relative: upright, no foot slide, no crouch.
- [x] Face parts: the human mouth (with teeth and tongue), a cartoon mouth, a beak, a muzzle, and a grille. Each defines the same 15 speech shapes and the same expression names. Add 3 eye and brow styles.
- [x] A blend step where parts meet the head.
- [x] Per-face checks: M/B/P closure, and speech shapes that look distinct from each other.
### Week 11: side door and proof
- [x] Import rigged glTF/GLB/VRM:
  - automatic map to humanoid names
  - our own retargeter (rest-pose fix and hip-height scale)
  - faces from the model's own shapes, in order: ARKit → VRM vowels with synthesised consonants → jaw → eyes
  - read the VRM licence and warn
  - a "what carried over" report
  - unrigged models stay props
- [x] Recast The Forge Lesson with two new, clearly different characters, in both engines.
- [x] Bench tasks, plus a cast-variety benchmark.

### Week 12 (added 2026-11-04 at your request): four legs, tails and wings
- [x] Quadruped body plan (`--plan quadruped`, `--preset dog`), skeleton first: a level spine (Hips → Spine → Chest → UpperChest), neck and head forward, front legs on the arm bone names and hind legs on the leg names, so export and both engines treat it like any character. The face is the studio's face kit on a long snout (muzzle by default, so the same 15 speech shapes and lip sync), with new upright ears.
- [x] Gaits from leg length (Froude number): walk (lateral sequence LH → LF → RH → RF), trot (diagonal pairs land together), rotary gallop; stride per Alexander, capped by what the legs reach; IK paws, with the cannon swinging with the leg. Life: idle (breathing, head turns, tail wag), sit (paws step under, hocks flat), lie down (paws step out). `set-motion --kind trot|gallop|sit|lie`.
- [x] Checks: planted paws don't slide, all four paws grounded in stance, the back doesn't sag between hips and withers, legs reach; footfall order named in the detail. Canonical skin poses for four legs are mid-trot, sit and lie.
- [x] Tail add-on (`--tail`, any plan): a bone chain that wags (travelling wave) and lags the body's rise and fall. Wings add-on (`--wings`, any plan): folded on edge along the body, a flap cycle (`set-motion --flap 2`, beats per second; whole beats per loop). No flight.
- [x] Proof: the Dog and the Heron Courier (a lanky skeleton with a beak, wings and a tail) in the cast lineup; dog walk → trot → gallop → sit → lie, heron walk + flap, in `checkpoint-phase7/motions/`. Bench tasks C3, C4.

### Status (2026-11-04, branch `phase7/characters`, not merged)
- Weeks 9–12 built. 101 tests, every bench green (`run`, `game`, `diorama`, `lesson`; C1–C4 are new), `build:view` green.
- Body plans: human, chibi, lanky, stocky, beaked, quadruped. Face parts: 5 mouths, 3 eye styles, 3 brow styles, 5 noses, 4 ears, 4 hairs; 3 style families; 5 palettes; 10 presets. Every plan × gait style passes the upright walk and run checks.
- The Forge Lesson is recast: a stocky, bald, bushy-browed smith (1.42 m, swagger) and a lanky, tufted apprentice (1.9 m), both engines (bench 36g/36w, `checkpoint-phase7/forge-lesson/`).
- Import: Mixamo, VRM 0/1 and generic names (and VRoid `J_Bip_`); rest-pose fix tested on an A-posed rig; KayKit was not downloaded, the test uses a generated outside rig.
- Artefacts: `checkpoint-phase7/cast/lineup.png`, `faces.png`, `turntable.mp4`; per-plan clips in `checkpoint-phase7/motions/`.
- Weak spots to judge: the dog's head is a long-snouted version of the human head (reads fox/horse more than dog); the quadruped's sit is a pose blend, not a weight shift; wings have no feathers; the cast check is an outline + face-part score, not a learned judgement.

### Craft and appeal pass (2026-11-04, branch `phase7/craft`, not merged)
You chose this before Pocket Raleigh because the cast "no longer look alike, but don't look designed yet".
- **Shape language** (`--shape round|square|triangle`, defaulting to each plan's): head widths, the torso's taper and boxiness, and the jaw.
  - The smith and the robot are square, the apprentice, goblin and heron triangle, the kid, elder, marsh bird and dog round.
- **Limbs with volume:** each limb segment is three oval rings hulled (start, muscle bulge, end), so arms swell at the deltoid and biceps and narrow to the wrist, and legs swell at the thigh and calf and narrow to the ankle. The lanky plan is thicker (0.66 → 0.82).
- **Hands:** bigger (hand ×1.12–1.5 per plan), with padded palms and chunkier fingers spaced so they don't fuse. Shoes have a heel and a toe cap.
- **Head planes:** a brow ridge, cheekbones and jaw corners (square) or a pointed chin (triangle). Brows sit on the ridge and are bolder.
- **Eyes:** about 15% bigger and wider set, with a catch-light bead on each eye.
- **Clothes with thickness:** a collar, a belt with an accent-colour buckle, sleeve hems (short sleeves) or cuffs (long sleeves), and trouser hems. Each look has a value plan and one accent colour.
- **Bird legs** (`legs: bird`, on the marsh bird and heron): a short feathered drumstick under a plumage skirt, a thin scaled shank with joint bands, and three splayed toes plus a back toe.
- **Dog:**
  - floppy ears (a new `floppy` ear part) and a shorter, boxier muzzle narrower than the skull
  - a broad dark nose pad (`nose.pad`) and a deeper barrel
  - The legs are still thinner than ideal: thicker ones failed the lie/sit skin checks.
- **Wings:** layered feather cards. Four secondaries, five fanned primaries and a covert pad per wing. The flap sweeps back and rises higher, so both wings read from the side.
- **The Forge Lesson:**
  - the wide shot now favours the face of whoever acts in it, so the smith is three-quarter front at the anvil
  - he stands at the anvil, so the hammer lands on it
  - a motion's still is taken at its key moment (the strike's impact) in both engines
- **Budgets:** every cast member is under 20k triangles (13.3k–18.4k). Hull limbs use coarser edge loops, big heads refine less, and big pupils use fewer segments.
- **Checks:** 101 tests; `run`, `game`, `diorama` and `lesson` benches all green; `build:view` green; every cast member passes all its checks.
- **Artefacts:** `checkpoint-craft/before|after/` (`lineup.png`, `faces.png`, `bodies.png` at the same cameras: the "before" set is the Phase 7 GLBs re-rendered), `checkpoint-craft/forge-lesson/` (before/after strike stills, both engines' MP4s), `checkpoint-craft/motions/`.

### Face appeal round (branch `phase7/faces`)
- **Painted face layer** (`facepaint.ts`): one procedural 1024² atlas per character, painted in Node from the face spec and encoded as PNG.
  - Three regions, each with UVs projected from bind-pose corners:
    - head: a cylinder around the head axis, with a back-seam fix
    - body: a cylinder along the torso
    - iris: planar per eye
  - A part opts in with `Material.paint` (`head`, `body` or `iris`). The look carries a `FacePaint`:
    - lashes, smile lines, blush, freckles, stubble and wrinkles
    - markings: dog (muzzle, blaze, eye patch, saddle), feathers or heron (scallops, eye stripe, cap), robot (seams, rivets, LED cheeks)
  - Iris painting: radial gradient, streaks, limbal ring and top shadow. Catch-lights are bigger, plus a second small glint.
  - The texture rides on the skinned mesh, so it follows speech and expression shapes.
  - It goes out in the plain GLB (three.js and the look lab) and in the game export. In the game export, painted groups skip the bake; Godot and the web both show it, see the Forge Lesson stills.
- **Rest expression per personality:** a new `mood` (warm, cheerful, gentle, proud, nervous, grumpy, neutral) is set on every preset.
  - It is applied to the rest positions after `buildRig`, so speech shapes add on top: a scaled smile or frown shape, plus a mouth-corner curve that moves teeth and tongue with the lips.
  - Mouths are wider: 0.44·hw cartoon, 0.35·hw lips, 0.26·hw muzzle.
  - The teeth-behind-lips check reads max skin z over ±2 cells instead of ±1. **Tripwire:** at ±1 a smiling smooth-style apprentice shows a 1.5–4 mm corner poke in "oh"/"ou". If corners visibly poke, curve the teeth less than the lips.
- **Dog:**
  - The skull "stop" comes from two shapes: the muzzle is a separate hull rooted inside the skull (`head.extra`), unioned before refinement.
  - Lower legs and forelegs are 15–28% thicker (`LK = 0.5`). The full delta (`LK = 1`) collapsed the folded lower leg in "lie" to 63%, and wider weight smoothing made it worse.
  - The heavy (build 1) and light (build 0) variants already failed "lie" before this round; that is unchanged.
- **Smooth style family:** 58° creased normals in both exporters; 12 limb sides, or 10 for winged characters and quadrupeds, where 12 failed the arm-volume and lie checks; smooth quadrupeds refine the head 1.2× coarser, to stay under 20k.
  - The cast player toggles faceted ↔ smooth (`?style=alt`, with a button). `bench/faces.ts` writes `after/player/`.
  - Faceted stays the default: smooth softens bodies, but the heads still show their hull facets.
- **Proof:** `checkpoint-faces/`:
  - `before|after/{faceted,smooth}/` (`faces.png`, `bodies.png`, lineups at the same cameras)
  - `after/player/` (style toggle; GLBs are git-ignored)
  - `talking-face/` (week 4 lines rerecorded)
  - `forge-lesson/` (Godot and web stills and MP4s)
- **Still weak:**
  - The kid's wide cartoon mouth reads as a thin pink line or stitched grin in close-up.
  - Lashes are faint at gameplay distance.
  - Smooth heads aren't truly smooth: no subdivision of head or hands, only normals.
  - The grumpy smith's rest reads flat rather than characterful.

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| Blob bodies can look crafted | Three new characters still read as cousins → style families before more body plans | D47 |
| Computed motion has enough character | A body plan still looks generic after its style pass → hand-tuned walk override | D48 |
| Face parts blend into the head | Parts look stuck on → blend step | D49 |
| Imports are rare | You import unrigged models repeatedly → add a skeleton-adder | D50 |


# Phase 8: Animate Anything (decisions 52–55, decided 2026-11-04)

## What We're Building
Anything you ask for moves. Skeletons are built from rig parts, and each part brings its own procedural motion. Claude directs one-off actions as key poses, and IK fills in the rest. Each part declares what "correct" means for it, so checks come for free. All of this is local, free and shippable; the research found that every AI motion model is humanoid-only, non-commercial, or needs CUDA.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 52 | Skeletons | Rig parts: legs ×N, chains, wings, fins/body wave, wheels/tracks, hinges/sliders, springs, shader sway. Body plans become part combos | Strong | One-way |
| 53 | One-off motion | Claude writes key moments as part goals; the studio solves with IK, easing and spring follow-through; your notes edit it; an optional webcam (MediaPipe) start for human actions | Strong | One-way |
| 54 | Checks | Each part declares its contacts, limits and form; universal checks for penetration, balance, pops, loops and the idle end; a timeline of failures; clip plus key-moment stills | Strong | Two-way |
| 55 | When | Core parts in weeks 13–14, Pocket Raleigh in weeks 15–20 with wings, fins and one-off actions alongside, your game in week 21 | Lean | Two-way |

## Implementation Steps
### Weeks 13–14: framework and core parts
- [x] Rig-part framework. Each part has bones, goals (tip/foot targets, angles), a procedural motion generator, style settings, and declared checks.
- [x] Legs ×N:
  - gait scheduling for 2/4/6/8 legs
  - IK foot targets that step when out of reach
  - body height and tilt follow the feet
- [x] Chains:
  - follow-the-leader and FABRIK
  - wave, coil and reach
  - snake serpentine motion
- [x] Wheels and tracks: roll at ground speed, steer, springy suspension.
- [x] Hinges and sliders, with limits.
- [x] Springs.
- [x] Shader sway for plants and flags.
- [x] Re-express the human, chibi, lanky, stocky, beaked and quadruped plans (after the craft pass) as part combos, with no visual or motion change and all existing checks still green.
- [x] Universal checks:
  - foot/contact sliding, body-relative
  - self and world penetration
  - balance for legged bodies
  - joint and hinge limits
  - velocity and jerk pops
  - loop closure
  - ending in idle
- [x] Failure timeline in the preview.
- [~] Live runtime for interactive parts: Godot 4.6 IK nodes plus a matching TypeScript runtime. Everything else is baked to clips. *(TS runtime done; Godot gets baked clips, IK nodes deferred: see status)*
### Status of weeks 13–14 (2026-11-04, branch `phase8/rig-parts`, not merged)
Built:
- [x] **Framework** (`core/src/rigparts.ts`). A creature is a list of part specs. Each part brings:
  - its bones
  - its pieces (rigid shapes on bones)
  - its contacts, limits and declared checks
  - a procedural motion in `bakeCreature`

  Clips are local rotations plus translation offsets, in place, with `speed` and `dir`. Loops fit whole frames: the cycle and the speed are rescaled, and swings and spins fit whole periods. The loop check compares the pose computed at t = duration with frame 0 (`clip.seam`), not a copy of it.
- [x] **Legs ×N:**
  - tripod gait for 6, tetrapod for 8, lateral sequence for 4, alternate for 2
  - analytic two-bone IK
  - stance stride = speed × duty × cycle, so planted feet don't move
  - body height and pitch/roll follow the planted feet

  Reach-triggered stepping is in the live runtime.
- [x] **Chains:**
  - FABRIK (reach)
  - follow-the-leader serpentine (arc-length walk along the body's own path)
  - wave, whip and coil
- [x] **Wheels:**
  - roll at ground speed (whole turns per road loop)
  - damped-spring suspension (body heave, pitch and roll)
  - struts that stay upright
  - steering in the runtime
- [x] **Hinges and sliders** (spin, swing, still, with limits) and **springs** (they lag behind their parent's acceleration, then settle).
- [x] **Sway:** a bone per blade (baked), or `mode: 'shader'` (one mesh). The shader version uses the same formula (`swayDeg`) in the three.js player (`onBeforeCompile`) and in a generated Godot `*.sway.gdshader`.
- [x] **Universal checks + part checks** (`creatureChecks`), each with failing frame ranges:
  - contact sliding in body lengths per second (feet 3 %, bellies 6 % sideways)
  - feet and belly on the ground
  - leg reach
  - world penetration, and self penetration between non-neighbouring bones
  - balance (centre of mass over the support polygon with three or more feet down)
  - joint and hinge limits
  - pops (joint speed) and jolts (body acceleration)
  - loop closure, or ends in idle
  - wheels roll at ground speed, tyres touch, suspension within travel
  - shader sway bend limit

  `studio motion-checks` lists them. `Studio.checks` adds one row per creature motion.
- [x] **Body plans as part combos:** `BODY_PLAN_PARTS` describes each kit plan (human, chibi, lanky, stocky, beaked, quadruped, with tails and wings) as parts. The kit's generation and motion code is unchanged, so there is no visible or motion change. `characterMotionChecks` runs the universal checks (heel and ball planted, pops, loop) on kit clips.

  One real finding: the **birdfolk walk's hips drop 57 mm and jump back in one frame at each heel strike**, and the spring tail whips with it at 1950°/s. It was left as is (no motion change in this phase) and pinned in the test. Fix it in the kit's walk planner.
- [x] **Tools:** `new-creature` (presets crab, snake, car, windmill, or `--parts`), `add-part`, `set-creature-motion`, `motion-checks`, the kernel `creature` op (hull per piece), and the daemon's `creature-preview` (player, video, stills, failure timeline on every frame, plus `--demo-failure`).
- [x] **Runtime:**
  - Everything bakes to clips in `creature.glb`: a node per bone with TRS channels, no skin. It passes the glTF validator, and the four presets import into Godot 4.7.2 with their clips and no warnings.
  - The live TS runtime (`creatureruntime.ts`) handles reach-triggered stepping (one gait group at a time) and wheels with spring suspension and bicycle-model steering over any ground function. Other parts are layered from a baked clip. The player has live segments driven by it.
  - **Godot IK nodes deferred:** the node-per-bone export has no `Skeleton3D`, so 4.6+ `SkeletonModifier3D` IK (TwoBoneIK3D, FABRIK3D) can't attach. Godot gets the baked clips. Live IK in Godot needs a skinned creature export first.
- [x] **Bench proofs:** `node bench/creatures.ts crab|snake|car|windmill` writes videos and stills to `checkpoint-phase8/`. All motion checks pass. The crab video includes a deliberately broken replay that shows the timeline in red.

Weak or not done:
- [ ] **Looks:** the creatures are blocky (boxes, few-sided segments, flat shading). The crab reads as a spidery robot. The grass is dark and its shadows don't sway.
- [ ] **Godot:** the sway `.gdshader` is generated but not yet compiled in Godot, and nothing applies it on import.
- [ ] **Runtime coverage:** the runtime covers legs and wheels only. Live chains (a reaching tentacle) and live springs come with one-off actions (weeks 15–20).
- [ ] **Self penetration** uses bounding spheres per piece. That is coarse for thin parts.

### Weeks 15–20, alongside Pocket Raleigh
- [x] Wings: flap, glide, fold, hover, flight cycle.
- [x] Fins and body wave.
- [x] Octopus and spider presets.
- [x] One-off actions:
  - `perform-action "the octopus pours tea"` → key moments → solve → checks → a reviewable clip
  - notes edit timing and style
  - [ ] optional MediaPipe webcam start for human actions *(skipped: not cheap)*
- [x] Bench tasks: a crab robot with a whip tail, an octopus pouring tea, a windmill creaking to a stop, a car on a bumpy road. Added: a bird takes off, flies and lands; a fish (and an eel) swims; "make him trip over the bucket".

### Status of weeks 15–20 (2026-11-05, branch `phase8/wings-fins-actions`, not merged)
Built:
- [x] **Wings** (`core/src/wings.ts`, `wing` part): a mirrored pair of arm, forearm and hand bones with a feathered leading edge, coverts and a fan of primaries.
  - Poses: fold (a Z-fold against the flank), flap (a 55 % downstroke, pronation on the way down, the wing flexing on the way up, the outer wing lagging the arm), glide, hover (body pitched up, a sweeping stroke) and spread.
  - From the proportions: the beat rate is f ≈ 3.9 / span^0.9, the stroke is wider for short wings, the cruising speed comes from the span, and long narrow wings (aspect ratio > 6) fly in bursts of four beats between glides.
  - Motions `fly`, `glide` and `hover` (`--altitude`). Legs tuck in flight.
  - Checks: wings clear the body (blade corners against the body ellipsoid), the stroke is symmetric (right = mirror of left), the stroke is within −68°…80°, and the measured beat is within 0.6–1.6× of what the wing size predicts. Wing bones get a pop limit sized to their beat.
- [x] **Swimming and fins:** a chain with `motion: 'swim'` (`swim: 'fish'` carangiform, or `'eel'` anguilliform) carries a travelling wave: λ ≈ 1 L or 0.6 L, tail amplitude ±0.1 L or ±0.075 L, beat from speed ÷ slip ÷ λ. The head recoils against the tail. `fin` parts flutter or ride along, and mirrored pairs beat together.
  - Checks: the body wave runs tailward faster than the fish moves (slip measured from the clip by cross-correlating the lateral swing at two points; a fish ≈ 0.7, an eel ≈ 0.45), the tail beat is in range, and the head stays steady (≤ 15°).
- [x] **Presets:** `octopus` (eight curling arms with sucker strips, a table, a teapot, a cup and a tea stream as props), `spider` (eight tapered legs on tetrapods, abdomen, pedipalps), `bird`, `fish`, `eel`. The crab got a craft pass: a smooth oval shell with a lighter top and a pale belly, two claws with pinching pincers (a hinge riding the claw chain), eyes on stalks, warm-coloured tapered legs with dark tips.
- [x] **Craft pass on meshes** (all creatures): smooth per-vertex normals, tapered segments with an elliptical cross-section (`squash`) and domed ends (`round`), legs that taper to points (`taper`, `footColor`), toes, sucker strips (`under`). Boxes stay faceted, and `flat: true` keeps a faceted segment for robots.
- [x] **One-off actions (D53)** (`core/src/actions.ts`, tools `perform-action` and `action-note`): Claude writes key moments as part goals (`body`, `reach`, `hold`, `props` tilt, `wings`, `legs`, `spin`, `creak`, `fx`). These carry forward from key to key.
  - Solving runs on top of the creature's idle: FABRIK reaching (then smoothed so slack spreads along a tentacle instead of kinking one joint), two-bone IK legs that plant where the body is at a `plant` key and lift by themselves when they can't reach (a take-off), wing modes blended (lifting the wing clear while it folds or unfolds), and hinge speeds integrated, with stick-slip creak.
  - Props: held props ride the tip with the offset they were picked up with. Effects show and hide on their keys.
  - A weight follower (a damped spring per goal) gives lag, overshoot and settle.
  - Notes in words: slower / much slower / faster, more weight / lighter, bigger / subtler, snappier, "hold the pour longer", "pause before the lift". Unknown notes are refused, with the list of notes it understands.
  - Checks: the universal ones (it ends in its idle pose, spinners excepted), plus: held props stay in the grip (≤ 2.5 cm), and let-go props rest upright on the ground or a surface.
  - Chain locals are now twist-free (the smallest turn from the parent), so a cone limit means the joint's bend.
- [x] **Kit characters:** `perform-action` takes the character action format with new `feet` (offsets that carry, y lifts), `pitch` (hips tip forward), `label` and tempo notes. `motion-preview --with Bucket --at [x,y,z]` shows props beside the character. `characterMotionChecks` gained a leg-reach row.
- [x] **Bird-person hip snap fixed (if cheap):** the walk planner's hip height is now a short window minimum, averaged, instead of a hard switch when a foot lands. The birdfolk walk's 57 mm one-frame drop is now at most ~37 mm/frame, its pops are gone, and every kit clip passes the universal checks (the pinned finding in the test is now `[]`). Hips sit a touch lower at double support.
- [x] **Live runtime:** `CreatureRuntime.reach(chain, goal | null)` makes a tentacle follow a moving goal live (critically damped follow, eased weight, the same smoothed FABRIK), and springs react live to the root's acceleration. The creature preview has a live segment where an octopus arm follows a yellow goal.
- [x] **Bench:** `node bench/creatures.ts [crab spider octopus bird fish windmill snake car trip]` (ports 4630/9510 by default). It writes `checkpoint-phase8/{crab,spider,octopus,octopus-noted,bird,bird-takeoff,fish,eel,windmill,trip}` with videos and stills, including a still at every key moment of an action. Every check passes. The action keys Claude wrote are in `bench/actions/*.json`.
- Tests: 148 (was 135), including `core/test/wingsactions.test.ts`.

Weak or not done:
- [ ] MediaPipe webcam start: skipped.
- [ ] Godot still gets baked clips only (no skinned creature export, so no live IK there). The runtime's live reach and springs are TypeScript (web).
- [ ] Self penetration still uses bounding spheres per piece, so thin feathers and the trip's foot against the bucket aren't judged precisely (the bucket isn't part of the character's checks at all).
- [ ] Action keys are hand-placed numbers. The octopus took several rounds of checks to find a layout where idle-curling arms don't brush the table, which is the D53 tripwire territory for complex scenes.


## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| Procedural parts look alive with style settings | A part looks generic → hand-tuned overrides per creature | D52 |
| Godot 4.6 IK nodes are usable | They misbehave → bake those motions to clips for Godot | D52 |
| Claude's key poses read well | Common human actions take 3+ rounds of notes → a small CC0 clip library as starting points | D53 |
| General checks catch most problems | You spot a problem the checks passed → add the rule to that part | D54 |
| The framework is done in 2 weeks | Not done by the end of week 14 → start Pocket Raleigh anyway | D55 |


# Phase 9: Effects, UI Art, and a Tiny Real Game (decisions 56–59, decided 2026-11-04)

## The test that decides what gets a tool
A tool is needed only when Claude can't tell whether something is right by reading what it wrote. Gameplay logic, menu logic, saving and shipping builds are ordinary code and checklists that Claude handles directly. Effects and how UI looks only show on screen, so they get studio modules.

## Decisions Made
| # | Decision | Choice | Confidence | Reversibility |
|---|---|---|---|---|
| 56 | Effects | A studio effect file: shape-based effects first, plus particles. It compiles to Godot particles (with a CPU fallback) and to three.quarks. Colours come from the look lab, and effects can be triggered by motion events. | Strong | One-way |
| 57 | Effect checks | Per profile: overdraw estimate, peak particles, fallback, colours. Plus a Godot vs web frame diff and automatic warm-up. Review is side by side, in the scene. | Strong | Two-way |
| 58 | UI art | A kit generated from look tokens, output as a Godot Theme plus web CSS. SVG icons in a house style, rendered and scored. OFL fonts. Checks for contrast, text overflow, tap size and safe area. | Strong | One-way |
| 59 | Order | A tiny real game now. Effects and UI shaped by what it lacks. Then a tool freeze until it's shared. | Strong | Two-way |

## Order from here
1. **Now:** the face appeal round (running).
2. **Weeks 13–14:** the tiny game (one room, about 5 minutes of play, existing characters, motion and cutscenes), alongside the rig-part framework (Phase 8 core).
3. **Weeks 15–16:** effects and the UI kit, built to what the tiny game was missing. Then tiny game v1.1, shared with a few people.
4. **Weeks 17–22:** Pocket Raleigh, the rest of animate anything, and the game skills.
5. **Rule:** no new tool modules are decided or started until the tiny game is shared.

## Implementation Steps
### Tiny game (weeks 13–14)
- [ ] You pick the idea, or take the suggestion: "the apprentice fetches tools for the smith before the fire dies".
- [ ] Engine: Godot or web, your choice.
- [ ] Gameplay is plain code with tests.
- [ ] Uses the recast characters, motion, a cutscene intro and voices.
- [ ] Record every point where a missing tool hurt. That list drives weeks 15–16.

### Status, weeks 15–16 (2026-11-05, branch `phase9/effects-ui`, not merged)
Built in main's codebase for Fire's Dying to adopt in its v1.1 pass (the game branch is untouched).
- **The one-hour particle test:** Godot 4.7.2 GL Compatibility renders GPUParticles3D, turbulence, trails and CPUParticles3D on the Mac. Godot's web export templates aren't installed here, so the browser itself is untested. The desktop Compatibility renderer stands in for it, and the CPU twins are the safety net. The web runtime turns them on by default only for web builds on phones.
- **Effects (core `effects.ts`, game `effects.ts`, `effects.gd`, studio `effects.ts`):**
  - Format: particle layers (shape, rate, bursts, life, speed, size over life, colour/alpha ramps, gravity, drag, turbulence, stretch) and shape layers (flame, ring, arc and puff cards with a shared scrolling-noise shader).
  - Godot `.tscn`: GPU particles plus a CPU twin per layer.
  - three.quarks 0.17.1 JSON, pinned exactly, with a round-trip test.
  - Palette names (`look.palette` when a look lab exists).
  - `--value` makes an effect follow a 0–1 game value.
  - Triggers: game events, or motion moments (`Blacksmith:strike@impact`, with the motion id resolved to its action).
  - Checks: peak particles and overdraw per profile, fallback (and what it loses), palette ΔE, warm-up, and parity.
  - Tools: `add-effect`, `set-effect`, `remove-effect`, `effect-info`, `effect-review`.
  - `game effect --against` renders both engines from one review camera. It returns MP4s, a side-by-side card and a parity score, and saves the score to the effect.
- **UI kit (core `uikit.ts`, `ui.gd`, studio `ui.ts`):**
  - Forge tokens with the Roboto OFL font. Parts: panel, button, bar, slot, tooltip, card, label, and a bubble that tracks a character.
  - Output: a Godot Theme and web CSS.
  - Six house SVG icons, linted to SVG Tiny and scored at 24 px.
  - Checks: contrast, pseudolocalised overflow, tap size, text size, safe area, icon contrast, and font licence.
  - `game ui-sheet` renders the review sheet. `game screenshot --page true` captures the 3D plus the UI in both engines.
- **/game fixes (pain log):**
  - #4: whole-page capture.
  - #7: `Player` exported, `controls: 'none'`, and start/stop step travel through the character controller.
  - #8/#13: `say()` plays voice, clip and bubble, shifted by the line's measured sync.
  - #9: every line's audio is exported.
  - #10: `extras.grip` and per-hand `extras.hold`, plus `hold()`.
  - #11: a `hand-prop` profile kind with no collider.
  - #12: `place-object on` uses the largest flat top.
  - #14: `extras.studioName` and `named()`.
  - Not done: #5 pathfinding and #6 interactables, left for later.
- **Proof:** `npm run bench:effects`, 13 tasks, all passing.
  - Godot vs web parity: forge fire matches (0.09). Embers 0.28, sparks 0.43 and smoke 0.43 drift. Rain differs at 0.77.
  - Tripwire D56: smoke, sparks and rain drift visibly between engines. Next, tune them, or try Effekseer for those types.

### Effects (weeks 15–16)
- [x] First, a one-hour Mac test: GPU particles, trails and turbulence in Godot's web renderer.
- [x] Effect format: emitters, lifetime behaviours, bursts, and shape effects (flame meshes, arcs, rings) with scrolling noise.
- [x] Compile to Godot `.tres` plus the CPU fallback, and to three.quarks JSON (pinned version, round-trip test).
- [x] Look-lab colours, and triggers from motion events.
- [ ] Checks:
  - overdraw estimate
  - peak particle count
  - fallback present
  - palette
  - Godot vs web frame diff
  - warm-up at load
- [x] Side-by-side review card.

### UI kit (weeks 15–16)
- [x] UI tokens derived from the look lab: palette, OFL font, border/corner style, shadows.
- [x] Parts: panel, button, bar, slot, tooltip, dialogue box. Output as a Godot Theme `.tres` (StyleBoxFlat and 9-slice) plus a web CSS overlay.
- [x] SVG icons in a house style, linted to SVG Tiny, rendered and scored. CC0 pack fallback, with credits.
- [x] Checks: contrast (4.5:1 and 3:1), pseudolocalised text overflow, tap targets of 44 px or more, safe area.
- [x] Review: a UI sheet, plus the UI over game screenshots.

## Assumptions & Tripwires
| Assumption | Revisit if... | Affects |
|---|---|---|
| The tiny game fits in 2 weeks | Not playable by the end of week 14 → cut scope | D59 |
| Effects look the same in both engines | They drift visibly → try Effekseer for that type | D56 |
| AI icons are consistent | They're inconsistent after scoring → use a recoloured CC0 pack | D58 |
| The tool freeze holds | A new tool idea comes up → note it, decide after the tiny game ships | D59 |
