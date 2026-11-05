---
name: x-game-build
description: "Action skill that turns a game's chosen decisions into .decisions/game-spec.json (every field citing the decision that set it), plans the build as numbered steps, and runs them through the AI-first studio and its /game engines as reviewable proposals: the grey-box toy, playable presets for feel decisions, and the first version. Stops with a small decision page whenever the build needs a choice no decision covered, and rebuilds only what a changed decision touches. Falls back to plain three.js or Godot when the studio isn't installed. Use when /x-decide-gaming or another game skill asks to build, rebuild or make presets."
disable-model-invocation: true
---

# x-game-build — decisions into something you can play

You are the build stage. You **execute on decisions that were already made** and never make judgment calls of your own: a gap that changes how the game plays or looks becomes a small decision page for the human. Everything you change is a studio proposal or a plain file change the human can review.

Input: **$ARGUMENTS** (a mode: `toy`, `presets <decision>`, `rebuild`, `v1`; or plain words)

Read first: `../x-decide-gaming/references/conventions.md`, `../x-decide-gaming/references/game-spec.md`. Modes in detail: `references/modes.md`. Without the studio: `references/without-studio.md`.

## Step 1 — where things stand

1. Read `.decisions/decisions.json` (chosen decisions, `game` block) and `.decisions/game-spec.json` if it exists.
2. Find the studio: `bash ../x-decide-gaming/scripts/find-studio.sh` → `$STUDIO` (a path) or none. With a path, run `"$STUDIO" status` and `"$STUDIO" game status` from the game's folder. No path → read `references/without-studio.md` and follow it; say once that the studio isn't installed.
3. Pick the mode from the input or the road: step 2 → `toy`; a thinking skill asking for playable options → `presets`; a decision changed → `rebuild`; step 7 → `v1`.

## Step 2 — compile the spec

Fold every chosen decision into `.decisions/game-spec.json`:

- Each leaf object gets `from: "dN"` (the decision that set it). Keep the decision's `spec` field in `decisions.json` in step with the paths it sets.
- Anything the build needs that no decision covers goes into `open` with a stated default and `kind`:
  - `small` (doesn't change how it plays or looks: file names, a collision margin, spawn offsets) → use the default, list it in the report.
  - `real` (changes how it plays or looks: what happens when the cart tips, how many lives, where the camera starts) → **stop**. Make a gap page (two to four options, conventions §4 "gap pages"), add it to `decisions.json` with `skill: "x-game-build"`, open it, and wait. Resume when it's chosen; the field leaves `open` with `from` set to the gap page.
- Tripwire: more than three `real` gaps for one toy → raise the bar (treat the less important ones as `small`) and tell the human you did.

## Step 3 — plan the steps

Write `.decisions/build-plan.json`: numbered steps, each one studio proposal or one engine change, each listing the spec paths it `uses` (see game-spec.md). Typical toy plan:

1. `"$STUDIO" new-object` / `add-op`… the toy's props in grey (via the `/studio` playbook in the studio repo), each step a proposal.
2. A character, if the verb needs one (`"$STUDIO" new-character` with the chosen body plan).
3. `"$STUDIO" game init --name <slug> --engine <web|godot>` once.
4. `"$STUDIO" game import --project <slug> [--player <character>]` (round trip must be clean).
5. Game code for the verb in `games/<slug>/src/` (web) or `game/` (Godot): plain code with small tests (`registerTest` on web, `tests/test_*.gd` on Godot).
6. `"$STUDIO" game run`, `game screenshot`, `game walk-to --video true`; read every PNG.

## Step 4 — run, step by step

For each step: do it, read the result, fix and retry once on failure, then mark it `done` with its proposal id. Never edit the engine copies under `assets/studio/`; change the model in the studio and import again.

## Step 5 — hand back

1. Copy the playable web build into `.decisions/builds/build-NNN/` (an `index.html` that runs from a static server; see `references/modes.md`). For Godot, record the run command and stills instead.
2. Update `preview.html`'s play window to the new build, and the road (`game.road`, `game.next`).
3. Report in four to six lines: what was built, which decisions it came from, the `small` defaults you used, what to look at, and the next step on the road ("Next: camera, controls and character, step 3 — say 'next'").
4. If a thinking skill asked for presets, return to it (read its SKILL.md and continue there).

## Rebuilds

When a decision changes: update the spec paths it sets, find the steps whose `uses` overlap, rerun only those (and steps after them that depend on them), and say which steps reran.

## Rules

- No silent judgment calls. `real` gaps → a page. `small` gaps → defaults listed afterwards.
- Every step is reviewable: studio steps are proposals; code changes are small and tested.
- Look at every screenshot and still before saying something works.
- Local and free tools only; log licences in `.decisions/credits.json`.
