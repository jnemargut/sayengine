# Conventions shared by the game skills

## Contents
1. The three rules
2. Where files go
3. `decisions.json` (decision-kit format plus a `game` block)
4. Decision pages
5. What the four options show (decision 38)
6. The living preview (decision 39)
7. Using the studio, and working without it
8. Licences, free and local only
9. Privacy: where the game lives
10. What the user already said (stated preferences)
11. Changing a chosen decision (history, cascades)

## 1. The three rules (decision-kit)

Thinking skills (`x-game-concept`, `x-game-design`) **show** each decision as a visual HTML page with four options, a recommendation and a comparison table, **wait** for the human to choose, and **remember** every decision in `.decisions/`. Action skills (`x-game-build`, `x-playtest`) execute on chosen decisions and never make judgment calls: a gap that needs judgment becomes a small decision page (rule below).

The human can answer "Option B", "Option B because …" (store the reasoning), "Option B but …" (regenerate that card), "more options" (add E–H), or their own answer (gets a full card, `chosenOption: "custom"`). Never ask for reasoning; store it when volunteered. If they override a STRONG PICK, set `dissent: true`.

## 2. Where files go

All inside the game's folder (see section 9 for where that folder goes):

```
.decisions/
  decisions.json          the record (below)
  decision-NNN-slug.html  one page per decision
  index.html              all decisions, progress, links
  preview.html            the living one-page design (section 6)
  game-spec.json          compiled by x-game-build (see game-spec.md)
  builds/                 web toys and builds the pages embed (build-NNN/)
  playtests/              playtest-NNN.html + .json
  credits.json            licence of every asset (section 8)
  renders/                character checks, before/after pairs
  OVERNIGHT-<name>.md     judgment log of an unattended run (x-game-build)
  RESUME.md               where things stand, for picking up later
references/               the user's private reference images (section 9): never shipped
PAIN.md                   the tool-debt ledger, in the game's code folder (x-game-build)
```

Numbering continues across the whole game (concept and design share one sequence).

## 3. `decisions.json`

decision-kit's format (`projectName`, `projectDescription`, `createdAt`, `decisions[]` with `id`, `slug`, `title`, `category`, `status` (`pending` · `presented` · `chosen` · `auto-picked`), `chosenOption`, `chosenTitle`, `options{}`, `recommended`, `confidence` (`strong` · `lean` · `toss-up`), `caseAgainst`, `assumptions[]`, `tripwires[]`, `sources[]`, `htmlFile`, `decidedAt`, `reasoning`, `stakes`, `reversibility`)

plus, on each decision:

- `skill`: which skill owns it (`x-game-concept`, `x-game-design`, or `x-game-build` for gap pages),
- `step`: the road step (1–7),
- `spec`: the `game-spec.json` paths this decision sets (for example `["handling.preset", "camera.kind"]`), so a change rebuilds only those parts,
- `history[]` (once it changes after being chosen): `{ "date", "from": "user" | "playtest-NNN" | "scope-cascade", "change": "<one line>" }` (section 11),

and one top-level `game` block:

```json
"game": {
  "variant": "loop",
  "road": [ { "step": 1, "status": "done", "closedBy": [1, 2, 3] }, { "step": 2, "status": "todo" } ],
  "next": 2,
  "engine": "web",
  "studio": "/path/to/studio or null",
  "stated": [ { "what": "warm, fairly realistic look", "source": "first message + 3 reference images", "decidedBy": "fidelity" } ],
  "mode": "attended"
}
```

`stated` is section 10. `mode` is `attended` (default) or `judgment` (x-game-build's unattended mode).

## 4. Decision pages

Use `page-skeleton.md` for the HTML and CSS (self-contained; no external scripts; Google Fonts only if needed). Every page has, in order:

1. Header: decision number, title, category badge, door badge (🚪 one-way / 🔁 two-way), stakes badge, a short description that says why this matters **for this game**, a link to `preview.html`, and the "Respond with" line.
2. Four option cards (A–D): label, a pick badge and confidence badge on the recommended one, title, **the visual** (section 5), a "what it feels like" line, a plain-English summary, works-well-when / watch-out-for.
3. **The case against my pick**: two to four honest sentences, no strawman.
4. Assumptions and tripwires.
5. Comparison table, including an **Undo cost** row.
6. Research context with linked sources, when research ran (a "where sources disagree" box when they do).

Content is always about this game: its fantasy, its verbs, its places. Never "Item A" or lorem ipsum. Plain English: explain any term in the same sentence.

Before a page with playable presets is shown, play each preset in the game's **actual space** (a bot walk or a scripted run plus stills). A preset that can't be judged there (a high camera that clips over the walls of small rooms, a jump that can't reach the counter) is fixed, replaced, or flagged on its card as "untestable here, because …". Never ship four options of which one can't really be tried.

**Systemic games** (other characters perceive the player: hearing, sight, suspicion): a page that changes the player's numbers (feel, noise, speed) also says how each option meets the system, in a measured line per card ("the owner never heard a landing in any preset"; "B's landings reach the owner from the next room"). Numbers that set how the system perceives the player are never a `small` default: they are part of the decision or a gap page.

After writing a page: render it and look at it (the `render` skill if available, otherwise headless Chrome), fix anything clipped or empty, update `index.html`, then open the page and stop.

**Gap pages** (from `x-game-build`) use the same skeleton with only two to four options, a one-paragraph context ("the build needs to know …"), and no research section.

## 5. What the four options show (decision 38)

Choose the medium by the kind of choice. Judge each choice the way a player meets it.

| Kind of choice | The visual on each card |
|---|---|
| Toy, camera, controls, handling, feel | **A playable toy**: one small web build with four presets; each card embeds or links its preset (`builds/build-NNN/index.html?preset=B`). Ask `x-game-build` for a preset build (its "presets" mode). |
| Look, world, cast, set dressing | **Studio renders** of the actual scene or character, on look-lab boards when the look lab exists |
| Who the player is and the main other character | **A cheap character check render** from step 2 on (front, side, three-quarter, next to a person or a doorway for scale), so "it reads as the wrong animal" or "the person looks like a mannequin" shows up before the look decision |
| Title screen, logo | A still or a short clip of each, with the working title in it |
| Motion, cutscenes, one-off actions | **Short clips** (4–8 s MP4 from the studio's motion or cutscene preview) |
| Loop, scope, pillars, fantasy, rules | **Diagrams and one-page mock-ups** in HTML/SVG |

Fallbacks: a playable page that takes more than about five minutes → clips for that decision. No studio → diagrams, and say so once.

## 6. The living preview (decision 39)

`preview.html` is a one-page game design that fills in as decisions are made:

- A ledger strip at the top: one chip per decision (done, or grey with the step that decides it).
- Title and the one-line fantasy.
- **Play it now**: the latest build embedded (`builds/build-NNN/index.html` in an iframe), or "no build yet: step 2 makes the toy".
- Blocks: pillars · controls · loop · scope · look · world · cast. Undecided blocks stay grey and say which step decides them. Never fill a block with a guess.

Update it after every chosen decision and every build. Open it when it first exists and when a build lands; otherwise mention it updated.

## 7. Using the studio, and working without it

Find the launcher with `bash <x-decide-gaming>/scripts/find-studio.sh`. Run it from the game folder: `"$STUDIO" <command>`. Useful commands: `"$STUDIO" help`, `"$STUDIO" status`, `"$STUDIO" game status`, `"$STUDIO" game init`, `"$STUDIO" render`, and the `/studio` and `/game` skills' playbooks (read them from the studio repo's `.claude/skills/` when you need detail). Build steps are studio **proposals** the human can keep or undo.

Without the studio: say so once, write plain three.js (web) or Godot code directly, take screenshots with headless Chrome or Godot's `--write-movie`, and keep every other convention.

Blender (free, GPL) is a fair tool for props, meshes, retopology, baking and renders when it is installed (`blender --version`; run it headless with `blender -b -P script.py`). Prefer the studio's own Blender-backed steps when its help lists them; check `"$STUDIO" help` at build time rather than assuming what exists.

## 8. Licences, free and local only

Use local, free tools and models only. **Never offer an option that costs money** (a bought model, a paid asset store, a paid API), not even as one of four: the free route is the option. Free sources, in rough order of fit: built in the studio · CC0 libraries (Poly Haven, ambientCG, Kenney, Quaternius) · built in Blender · generated with a local model. Record the licence of every asset, voice, font, sound and model in `.decisions/credits.json` (`{ "file": …, "source": …, "licence": … }`). Never pull in non-commercial assets for a game that may be sold without saying so on the page.

## 9. Privacy: where the game lives

The studio repo may be public; the user's game usually isn't.

- A new game defaults to **its own folder outside the studio repo** (for example `~/<GameName>/`). If the current folder is inside the studio repo or any repo with a public remote, say so and suggest a folder outside it before writing anything.
- Reference images the user shares go in `references/` at the game's root. They are for looking at only: never copied into pages, builds, renders, commits to a public repo, or published artifacts. Pages describe them in words ("the character-sheet reference").
- Game code that needs the studio uses `find-studio.sh` or `$STUDIO_HOME`, never an absolute home path written into files that might be shared.
- Before any commit or publish from a game skill: check that nothing under `references/` (and no file copied from it) is staged, and that nothing private is going into the studio repo. Changes that belong in the studio (a general tool fix) go there with generic wording: "a cat game", not the game's name.

## 10. What the user already said (stated preferences)

Users often arrive with a brief, reference images or strong opinions about things the road decides later (the look, the camera, realism). Record each in `game.stated` the first time it appears, with where it came from and which decision will settle it. Then:

- every later page on that topic shows the stated preference at the top and either honours it in the recommendation or says plainly why it argues against it;
- a stated preference about **fidelity** (how realistic) or **asset sources** is not deferred to step 6: it gets the light fidelity decision at step 1 (concept catalogue), because it changes how the characters and props are made from the first toy;
- never write "decided later" against something the user has said without making a page or a one-line confirmation for it.

## 11. Changing a chosen decision (history, cascades)

When a chosen decision changes (the user's words, a playtest, a later decision):

1. Add a `history` entry to it (section 3) and update its card and `chosenTitle` if the choice itself changed.
2. **Cascade.** Find every spec field derived from it and recompute them in the same turn. Scope is the usual case: more rooms or places scale the number of jobs or goals, secrets, the session length, the cameras, the cast's routines and the build plan. Say what you recomputed in one line ("scope grew to 9 rooms, so: 8 jobs, 12 secrets, a 12-minute day, 10 cameras. Say if any of those are wrong"). Each recomputed field gets a history entry with `from: "scope-cascade"` on the decision that owns it.
3. Recompile `game-spec.json` (only `x-game-build` writes it; ask it to) and update `preview.html`. The spec must never lag the record: a chosen scope with no `scope` block in the spec, or a session length that still has the old number, is a bug.
