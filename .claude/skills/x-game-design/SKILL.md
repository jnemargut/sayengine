---
name: x-game-design
description: "Thinking skill for shaping a game once its toy exists: decides camera, controls and character together with a feel pass (road step 3), the loop around the toy (step 4), and the look, world and cast (step 6), each as a visual decision page with four options. Feel choices are shown as playable web toy presets, looks as studio renders, motion as clips, loops as diagrams. Use when /x-decide-gaming routes a design question here."
disable-model-invocation: true
---

# x-game-design — how the game plays, then how it looks

You are the design stage. You decide what makes the toy feel good and what surrounds it, one visual page at a time, and **stop for the human** after each. You don't build; you ask `x-game-build` for playable presets and builds.

Input: **$ARGUMENTS**

Read first: `../x-decide-gaming/references/conventions.md`, `../x-decide-gaming/references/road.md`, and for pages `../x-decide-gaming/references/page-skeleton.md`. This stage's catalogue: `references/design-decisions.md`.

## Modifiers

As in the concept skill: `/autodecide` (make every page, auto-pick, one batch review), `/overdecide` (include optional decisions), `/underdecide` (only the starred ones below).

## Before anything

1. Read `.decisions/decisions.json` and `game-spec.json`. Never re-ask what's decided.
2. Check `game.next`. This skill owns steps 3, 4 and 6. If the toy (step 2) hasn't been built, say so and offer to build it first ("the feel decisions need something to play").
3. Find the studio (`bash ../x-decide-gaming/scripts/find-studio.sh`).

## Step 3 — camera, controls, character, feel

Present in order:

1. **★ Camera + controls + character** (one decision; studios lock these together): four combinations that suit the toy's verb. Visual: **playable presets**, so ask `x-game-build` (presets mode) for one web build of the current toy with four presets (A–D) and embed each in its card.
2. **★ Feel**: four feel presets for the core verb (for example heavy, floaty, snappy, drifty), with the feel tweaks named in plain English (acceleration, weight, braking, screen shake, little sounds). Visual: playable presets again.
3. *(optional)* **Juice**: which small reactions to add first (dust, squash, a sound, camera shake). Visual: clips or presets.

On each choice: update the record, ask the build skill to fold it into the spec and rebuild the toy (only the parts the decision touches), update the preview's play window. Then mark step 3 done, `next: 4`.

## Step 4 — the loop

1. **★ The loop**: four loops built around the toy (for a loop-led game) or four "reasons to come back" (for a toy-led game) or four opening scenes (for a story-led game). Visual: a loop diagram per option, with the toy's verb at the centre and the time each lap takes.
2. On choice: the build adds the loop to the toy (a grey-box version: goals, a counter, a simple win).
3. Then hand to `x-playtest` for the 5-minute playtest: read `../x-playtest/SKILL.md` and follow it. Mark step 4 done when the playtest is in, `next: 5` (scope, in the concept skill).

## Step 6 — look, world, cast

Only after scope (step 5) is chosen:

1. **★ The look**: four looks for this game. Visual: **studio renders** of the actual toy scene in each look (on look-lab boards with the colourfulness and palette numbers when the look lab exists; otherwise renders with a palette strip). Name what each look does to readability and mood.
2. **World**: real place, invented place, or a remix of real streets and invented buildings (the studio's town pipeline when present), plus size. Visual: renders or a top-down map of each.
3. **Cast**: who's in it. Visual: studio character renders (cast lineup), one card per casting option, each a set of characters with their body plans, faces and a one-line role.
4. *(optional)* **Sound and music direction**: four directions as short descriptions plus reference sounds the studio's sound module can make; clips when available.

On each choice, the build skill updates the spec and rebuilds what changed. Mark step 6 done, `next: 7`.

## Rules

- The media follow decision 38: **feel → playable presets; look/world/cast → renders; motion → clips; loop → diagrams.** If a playable page would take more than about five minutes, use clips for that decision and say why. No studio → diagrams, said once.
- Four genuinely different options, a recommendation with honest confidence, the case against, a comparison table with undo cost.
- Explain terms in the sentence that uses them ("the 3Cs — camera, controls and character").
- Content is always this game's characters, places and verbs.
- Never fill a preview block with an undecided guess.
