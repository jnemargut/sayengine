# Conventions shared by the game skills

## Contents
1. The three rules
2. Where files go
3. `decisions.json` (decision-kit format plus a `game` block)
4. Decision pages
5. What the four options show (decision 38)
6. The living preview (decision 39)
7. Using the studio, and working without it
8. Licences and local-only

## 1. The three rules (decision-kit)

Thinking skills (`x-game-concept`, `x-game-design`) **show** each decision as a visual HTML page with four options, a recommendation and a comparison table, **wait** for the human to choose, and **remember** every decision in `.decisions/`. Action skills (`x-game-build`, `x-playtest`) execute on chosen decisions and never make judgment calls: a gap that needs judgment becomes a small decision page (rule below).

The human can answer "Option B", "Option B because …" (store the reasoning), "Option B but …" (regenerate that card), "more options" (add E–H), or their own answer (gets a full card, `chosenOption: "custom"`). Never ask for reasoning; store it when volunteered. If they override a STRONG PICK, set `dissent: true`.

## 2. Where files go

All inside the game's folder:

```
.decisions/
  decisions.json          the record (below)
  decision-NNN-slug.html  one page per decision
  index.html              all decisions, progress, links
  preview.html            the living one-page design (section 6)
  game-spec.json          compiled by x-game-build (see game-spec.md)
  builds/                 web toys and builds the pages embed (build-NNN/)
  playtests/              playtest-NNN.html + .json
```

Numbering continues across the whole game (concept and design share one sequence).

## 3. `decisions.json`

decision-kit's format (`projectName`, `projectDescription`, `createdAt`, `decisions[]` with `id`, `slug`, `title`, `category`, `status` (`pending` · `presented` · `chosen` · `auto-picked`), `chosenOption`, `chosenTitle`, `options{}`, `recommended`, `confidence` (`strong` · `lean` · `toss-up`), `caseAgainst`, `assumptions[]`, `tripwires[]`, `sources[]`, `htmlFile`, `decidedAt`, `reasoning`, `stakes`, `reversibility`)

plus, on each decision:

- `skill`: which skill owns it (`x-game-concept`, `x-game-design`, or `x-game-build` for gap pages),
- `step`: the road step (1–7),
- `spec`: the `game-spec.json` paths this decision sets (for example `["handling.preset", "camera.kind"]`), so a change rebuilds only those parts,

and one top-level `game` block:

```json
"game": {
  "variant": "loop",
  "road": [ { "step": 1, "status": "done", "closedBy": [1, 2, 3] }, { "step": 2, "status": "todo" } ],
  "next": 2,
  "engine": "web",
  "studio": "/path/to/studio or null"
}
```

## 4. Decision pages

Use `page-skeleton.md` for the HTML and CSS (self-contained; no external scripts; Google Fonts only if needed). Every page has, in order:

1. Header: decision number, title, category badge, door badge (🚪 one-way / 🔁 two-way), stakes badge, a short description that says why this matters **for this game**, a link to `preview.html`, and the "Respond with" line.
2. Four option cards (A–D): label, a pick badge and confidence badge on the recommended one, title, **the visual** (section 5), a "what it feels like" line, a plain-English summary, works-well-when / watch-out-for.
3. **The case against my pick**: two to four honest sentences, no strawman.
4. Assumptions and tripwires.
5. Comparison table, including an **Undo cost** row.
6. Research context with linked sources, when research ran (a "where sources disagree" box when they do).

Content is always about this game: its fantasy, its verbs, its places. Never "Item A" or lorem ipsum. Plain English: explain any term in the same sentence.

After writing a page: render it and look at it (the `render` skill if available, otherwise headless Chrome), fix anything clipped or empty, update `index.html`, then open the page and stop.

**Gap pages** (from `x-game-build`) use the same skeleton with only two to four options, a one-paragraph context ("the build needs to know …"), and no research section.

## 5. What the four options show (decision 38)

Choose the medium by the kind of choice. Judge each choice the way a player meets it.

| Kind of choice | The visual on each card |
|---|---|
| Toy, camera, controls, handling, feel | **A playable toy**: one small web build with four presets; each card embeds or links its preset (`builds/build-NNN/index.html?preset=B`). Ask `x-game-build` for a preset build (its "presets" mode). |
| Look, world, cast | **Studio renders** of the actual scene or character, on look-lab boards when the look lab exists |
| Motion, cutscenes, one-off actions | **Short clips** (4–8 s MP4 from the studio's motion or cutscene preview) |
| Loop, scope, pillars, fantasy, rules | **Diagrams and one-page mock-ups** in HTML/SVG |

Fallbacks: a playable page that takes more than about five minutes → clips for that decision. No studio → diagrams, and say so once.

## 6. The living preview (decision 39)

`preview.html` is a one-page game design that fills in as decisions are made:

- A ledger strip at the top: one chip per decision (done, or grey with the step that decides it).
- Title and the one-line fantasy.
- **Play it now**: the latest build embedded (`builds/build-NNN/index.html` in an iframe), or "no build yet — step 2 makes the toy".
- Blocks: pillars · controls · loop · scope · look · world · cast. Undecided blocks stay grey and say which step decides them. Never fill a block with a guess.

Update it after every chosen decision and every build. Open it when it first exists and when a build lands; otherwise mention it updated.

## 7. Using the studio, and working without it

Find the launcher with `bash <x-decide-gaming>/scripts/find-studio.sh`. Run it from the game folder: `"$STUDIO" <command>`. Useful commands: `"$STUDIO" help`, `"$STUDIO" status`, `"$STUDIO" game status`, `"$STUDIO" game init`, `"$STUDIO" render`, and the `/studio` and `/game` skills' playbooks (read them from the studio repo's `.claude/skills/` when you need detail). Build steps are studio **proposals** the human can keep or undo.

Without the studio: say so once, write plain three.js (web) or Godot code directly, take screenshots with headless Chrome or Godot's `--write-movie`, and keep every other convention.

## 8. Licences and local-only

Use local, free tools and models only. Record the licence of every asset, voice, font, sound and model in `.decisions/credits.json` (`{ "file": …, "source": …, "licence": … }`). Never pull in non-commercial assets for a game that may be sold without saying so on the page.
