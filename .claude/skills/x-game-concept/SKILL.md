---
name: x-game-concept
description: "Thinking skill for the start of a game: turns a loose game idea into its fantasy in one line, three design pillars, whether it is a toy, a loop or a story, and the core verb to prototype (road step 1), and later scopes the first version on one page (road step 5). Presents each as a visual decision page with four options and waits for the human. Use when /x-decide-gaming routes a new game idea or a scope question here."
disable-model-invocation: true
---

# x-game-concept — what the game is

You are the concept stage of the game family. You surface the few decisions that define the game, show each as a visual page, and **stop for the human** after each one. You never build anything; the toy is built by `x-game-build` right after you.

Input: **$ARGUMENTS**

Before the first page, read the shared rules: `../x-decide-gaming/references/conventions.md` (record, pages, media) and `../x-decide-gaming/references/road.md` (the seven steps). For page HTML use `../x-decide-gaming/references/page-skeleton.md`. The decision catalogue for this stage is `references/concept-decisions.md`.

## Modifiers

Strip leading `/autodecide`, `/overdecide`, `/underdecide`. Auto: make every page, mark each `auto-picked`, then one batch review (`.decisions/auto-review.html`) at the end. Over: add the optional decisions from the catalogue. Under: only the fantasy and the toy.

## Step 1 — set up

1. Find the studio once: `bash ../x-decide-gaming/scripts/find-studio.sh` (run from this skill's folder, or use the router's folder). Note the path or "none".
2. If `.decisions/decisions.json` doesn't exist, create it with `projectName` (a short working title), `projectDescription` (the user's idea in their words), `createdAt`, `decisions: []` and the `game` block (`variant: null`, the seven road steps all `todo`, `next: 1`, `engine: null`, `studio: <path or null>`).
3. If it exists, read it. Never re-ask anything already decided.

## Step 2 — step 1 of the road (the first time)

Present these decisions **in order, one at a time**, each as a full page (four options, recommendation with confidence, case against, comparison table with an undo-cost row):

1. **The fantasy**: one line the player would say about it. Four genuinely different readings of the idea (who you are, what you do, why it's delightful).
2. **Three pillars**: four candidate sets of three short statements that every later feature must pass through.
3. **Toy, loop or story, and the core verb**: the shape of the fun and the one action the toy is built around. This also sets `game.variant` and picks the road variant.
4. *(optional with /overdecide)* **Engine**: web (three.js, share by link) or Godot (desktop download). Otherwise ask it in one line after decision 3, defaulting to web.

Visuals for these are **diagrams and one-page mock-ups** (section 5 of the conventions): a poster-style card with the one-liner and a tiny scene sketch for the fantasy; three pillar cards with an example feature that passes and one that fails each pillar for the pillars; a one-screen sketch of the verb plus a loop or arc diagram for the toy decision.

Research: for decision 3 only, and only if a subagent or web search is available, look up two or three games with a similar core verb and what made the verb fun. Cite them. Skip research for the fantasy and pillars.

After each answer: mark the card chosen, update `decisions.json`, `index.html` and `preview.html` (fill the fantasy and pillars blocks), and move on.

## Step 3 — hand off to the toy

When decision 3 is chosen:

1. Mark road step 1 `done` (closed by the decision ids) and set `next: 2`.
2. Write a stub `.decisions/game-spec.json` yourself **only if** `x-game-build` isn't about to run; otherwise leave it to the build. The stub has `version`, `game`, `fantasy`, `pillars`, `variant`, `toy` (each with `from`), and `open: []` (see `../x-decide-gaming/references/game-spec.md`).
3. Tell the user in two lines what's decided and that the next step is the toy: "Next: the toy, a grey box you can play in about an hour. Say 'build it'."
4. If they say yes, read `../x-game-build/SKILL.md` and follow it.

## Step 4 — scope (road step 5, later)

When routed here at step 5 (the loop has been playtested):

1. Read the latest playtest (`.decisions/playtests/`) and the current spec.
2. Present **one** decision, "What's in the first version": four scopes from smallest to largest, each drawn as a one-page design (Librande-style: the map or flow, what's in, what's cut, minutes of play), with the playtest's findings quoted where they argue for or against.
3. On choice, set `scope` in the spec via `x-game-build` (or note it for the build), mark step 5 done, `next: 6`.

## Rules

- One decision per page, one page at a time, then stop and wait.
- Four options that are really different; recommend one, with an honest confidence (`strong`, `lean`, `toss-up`; a toss-up names the tiebreaker).
- Plain English. The human may know nothing about game design terms; explain "pillar", "loop", "verb" the first time in the sentence that uses them.
- All content is about this game. No generic examples.
- Pages are self-contained HTML. Render each and look at it before opening it.
