---
name: x-game-build
description: "Action skill that turns a game's chosen decisions into .decisions/game-spec.json (every field citing the decision that set it), plans the build as numbered steps, and runs them through the AI-first studio and its /game engines as reviewable proposals: the grey-box toy, playable presets for feel decisions, and the first version. Stops with a small decision page whenever the build needs a choice no decision covered, and rebuilds only what a changed decision touches. Falls back to plain three.js or Godot when the studio isn't installed. Use when /x-decide-gaming or another game skill asks to build, rebuild or make presets."
disable-model-invocation: true
---

# x-game-build — decisions into something you can play

You are the build stage. You **execute on decisions that were already made** and never make judgment calls of your own: a gap that changes how the game plays or looks becomes a small decision page for the human (only in judgment mode, when the human has said to use your judgment, do you make the call yourself and log it). Everything you change is a studio proposal or a plain file change the human can review.

Input: **$ARGUMENTS** (a mode: `toy`, `presets <decision>`, `rebuild`, `v1`, `judgment`; or plain words)

Read first: `../x-decide-gaming/references/conventions.md`, `../x-decide-gaming/references/game-spec.md`. Modes in detail: `references/modes.md`. Unattended runs: `references/judgment-mode.md`. Proof of fixes and the tool-debt ledger: `references/verify-and-debt.md`. Without the studio: `references/without-studio.md`.

## Step 1 — where things stand

1. Read `.decisions/decisions.json` (chosen decisions, `game` block) and `.decisions/game-spec.json` if it exists.
2. Find the studio: `bash ../x-decide-gaming/scripts/find-studio.sh` → `$STUDIO` (a path) or none. With a path, run `"$STUDIO" status` and `"$STUDIO" game status` from the game's folder. No path → read `references/without-studio.md` and follow it; say once that the studio isn't installed.
   Read `"$STUDIO" help` each session rather than assuming what exists: new steps land often (a Blender-backed creature or people step, headless renders, a port flag). A second project needs its own `STUDIO_PORT`. Blender (`blender -b -P script.py`) is available for props and meshes when the studio has no step for them.
3. Pick the mode from the input or the road: step 2 → `toy`; a thinking skill asking for playable options → `presets`; a decision changed → `rebuild`; step 7 → `v1`. "Use your judgment", "overnight", "don't wait for me" → `judgment` (read `references/judgment-mode.md`; it wraps the other modes).
4. Privacy (conventions §9): the game lives outside the studio repo; never copy `references/` into builds; no absolute home paths in game files.

## Step 2 — compile the spec

Fold every chosen decision into `.decisions/game-spec.json`:

- Each leaf object gets `from: "dN"` (the decision that set it). Keep the decision's `spec` field in `decisions.json` in step with the paths it sets.
- Anything the build needs that no decision covers goes into `open` with a stated default and `kind`:
  - `small` (doesn't change how it plays or looks: file names, a collision margin, spawn offsets) → use the default, list it in the report.
  - `real` (changes how it plays or looks: what happens when the cart tips, how many lives, where the camera starts) → **stop**. Make a gap page (two to four options, conventions §4 "gap pages"), add it to `decisions.json` with `skill: "x-game-build"`, open it, and wait. Resume when it's chosen; the field leaves `open` with `from` set to the gap page.
- Tripwire: more than three `real` gaps for one toy → raise the bar (treat the less important ones as `small`) and tell the human you did.
- Derived fields (counts and lengths that scale with scope) are recomputed whenever their source changes; then check the spec against the record (game-spec.md, "Derived fields"). A chosen decision missing from the spec is a bug to fix before building.

## Step 3 — plan the steps

Write `.decisions/build-plan.json`: numbered steps, each one studio proposal or one engine change, each listing the spec paths it `uses` (see game-spec.md). Typical toy plan:

1. `"$STUDIO" new-object` / `add-op`… the toy's props in grey (via the `/studio` playbook in the studio repo), each step a proposal.
2. A character, if the verb needs one (`"$STUDIO" new-character` with the chosen body plan).
3. `"$STUDIO" game init --name <slug> --engine <web|godot>` once.
4. `"$STUDIO" game import --project <slug> [--player <character>]` (round trip must be clean).
5. Game code for the verb in `games/<slug>/src/` (web) or `game/` (Godot): plain code with small tests (`registerTest` on web, `tests/test_*.gd` on Godot).
6. `"$STUDIO" game run`, `game screenshot`, `game walk-to --video true`; read every PNG.

## Step 4 — run, step by step

For each step: do it, read the result, fix and retry once on failure, then mark it `done` with its proposal id. Never edit the engine copies under `assets/studio/`; change the model in the studio and import again. Keep `build-plan.json` current: every build adds its steps, not only the first toy.

**Studio first.** When a step hits a gap in the studio (no tool, a broken export, a missing preset) and the fix would help any game, prefer fixing or proposing it in the studio over a workaround in game code. A workaround is fine when the fix is specific to this game or would block the build for long; either way, log it in the tool-debt ledger (`references/verify-and-debt.md`). Changes to the studio use generic wording, never the game's name or content.

## Step 5 — hand back

1. Copy the playable web build into `.decisions/builds/build-NNN/` (an `index.html` that runs from a static server; see `references/modes.md`). For Godot, record the run command and stills instead.
   - **Deploy after the checks pass.** When the game has a live site, every build that passes its checks goes to the static host (free tiers such as Cloudflare Pages or GitHub Pages), followed by one request for a shipped file to confirm it is live. Run `"$STUDIO" game release --check true --site <url>` first. It fails on missing or relative share tags, private words in shipped text, files too big for the host, and local paths. A deploy script also refuses private or oversized files on its own, so a hand-run deploy is safe too. Never deploy a build that failed a check.
2. Update `preview.html`'s play window to the new build, and the road (`game.road`, `game.next`).
3. Report in four to six lines: what was built, which decisions it came from, the `small` defaults you used, what to look at, and the next step on the road ("Next: camera, controls and character, step 3. Say 'next'.").
4. If a thinking skill asked for presets, return to it (read its SKILL.md and continue there).

## Rebuilds

When a decision changes: update the spec paths it sets, find the steps whose `uses` overlap, rerun only those (and steps after them that depend on them), and say which steps reran.

## Checks that earn their time

- **Slow audits can be skipped only when the user says so.** Give every long audit (framing over every event, repeated physics runs, full bot sweeps) a SKIP switch, an environment variable or a flag. Leave it off by default. Turn it on only when the user asks for a faster turn, and print `SKIPPED <audit> (user said so)` in the build report so the gap stays visible.
- **The framing audit keeps the subject's surface drawn.** Any camera cut that fades occluders (`studio/cutaway.ts`) needs an audit that checks, at each beat, that the subject, the event's target and the surface under the subject are still visible. Use a visibility check plus a pixel comparison against an unfaded frame. Find the support with a ray down from the subject, not "everything below its feet". A physics beat varies between runs, so audit it N times in a row.
- **Ease every state change.** Characters moved by rules or routines are drawn with `studio/ease.ts`: they turn along the shortest arc and never pop, and they snap only on a declared cut.

## Rules

- No silent judgment calls. `real` gaps → a page (in judgment mode: a logged call). `small` gaps → defaults listed afterwards.
- Every step is reviewable: studio steps are proposals; code changes are small and tested.
- Look at every screenshot and still before saying something works.
- **Never claim a visual fix you can't see.** Every claimed fix shows in a fresh render from a verified fresh build, side by side with the previous render (`references/verify-and-debt.md`). Subagent reports count only with those images.
- At the end of v1, offer to fold the tool-debt ledger back into the studio: "PAIN.md has N items; M are general. Want me to take them to the studio?"
- Never suggest buying an asset or a paid service.
- Local and free tools only; log licences in `.decisions/credits.json`.
