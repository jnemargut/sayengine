---
name: x-game-design
description: "Thinking skill for shaping a game once its toy exists: decides camera, controls and character together with a feel pass (road step 3), the loop around the toy (step 4), and asset sources, look, world and set dressing, cast, tone and title screen (step 6), each as a visual decision page with four options. Feel choices are shown as playable web toy presets, looks as studio renders, motion as clips, loops as diagrams. Use when /x-decide-gaming routes a design question here."
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

1. **★ Camera + controls + character** (one decision; studios lock these together): four combinations that suit the toy's verb. Visual: **playable presets**, so ask `x-game-build` (presets mode) for one web build of the current toy with four presets (A–D) and embed each in its card. Each preset must work in the toy's real space (conventions §4); if the space is too small to judge one (a high camera in small rooms), say so on its card or swap it. Put the character check render (from the toy build) on the page; if the hero or the main other character reads wrong ("looks like a dog", "a mannequin"), say so here and log it for the fidelity or cast work rather than waiting for step 6.
2. **★ Feel**: four feel presets for the core verb (for example heavy, floaty, snappy, drifty), with the feel tweaks named in plain English (acceleration, weight, braking, screen shake, little sounds). Visual: playable presets again. In a systemic game, each card says how the preset meets the system, measured ("the owner never hears a landing in any preset"), so the human isn't choosing numbers whose effect nobody saw.
3. *(optional)* **Juice**: which small reactions to add first (dust, squash, a sound, camera shake). Visual: clips or presets.

On each choice: update the record, ask the build skill to fold it into the spec and rebuild the toy (only the parts the decision touches), update the preview's play window. Then mark step 3 done, `next: 4`.

## Step 4 — the loop

1. **★ The loop**: four loops built around the toy (for a loop-led game) or four "reasons to come back" (for a toy-led game) or four opening scenes (for a story-led game). Visual: a loop diagram per option, with the toy's verb at the centre and the time each lap takes.
2. On choice: the build adds the loop to the toy (a grey-box version: goals, a counter, a simple win).
3. Then hand to `x-playtest` for the 5-minute playtest: read `../x-playtest/SKILL.md` and follow it. Mark step 4 done when the playtest is in, `next: 5` (scope, in the concept skill).

## Step 6 — look, world, cast

Only after scope (step 5) is chosen. Order matters: decide where things come from before rendering looks, or the renders show models that will be thrown away.

1. **★ Asset sources** (skip only if the fidelity target already settled it): for props, the world, the hero and the people, where each comes from: the studio kit, a free CC0 library, Blender (headless, local), or a local generator. Free only; never a paid option. Visual: one render of the same prop and the hero from each source. Check `"$STUDIO" help` for what the studio can make today (a creature or people step may exist) before writing the cards.
2. **★ The look**: four looks for this game, rendered with the chosen sources. Visual: **studio renders** of the actual toy scene in each look (on look-lab boards with the colourfulness and palette numbers when the look lab exists; otherwise renders with a palette strip). Name what each look does to readability and mood.
3. **World**: real place, invented place, or a remix of real streets and invented buildings (the studio's town pipeline when present), plus size. Skip with a note when scope already fixes it. Visual: renders or a top-down map of each.
4. **Set dressing**: how lived-in the place is and what the stuff says about the characters who live there (catalogue). Visual: renders of one room or street dressed each way.
5. **Cast**: who's in it. Visual: studio character renders (cast lineup), one card per casting option, each a set of characters with their body plans, faces and a one-line role.
6. **Tone, title screen and logo**, when the working title or tone is still thin or has changed (catalogue). Visual: title-screen stills or a short clip.
7. *(optional)* **Sound and music direction**: four directions as short descriptions plus reference sounds the studio's sound module can make; clips when available.

On each choice, the build skill updates the spec and rebuilds what changed. Mark step 6 done, `next: 7`.

## Rules

- The media follow decision 38: **feel → playable presets; look/world/cast → renders; motion → clips; loop → diagrams.** If a playable page would take more than about five minutes, use clips for that decision and say why. No studio → diagrams, said once.
- Four genuinely different options, a recommendation with honest confidence, the case against, a comparison table with undo cost.
- Explain terms in the sentence that uses them ("the 3Cs — camera, controls and character").
- Content is always this game's characters, places and verbs.
- Never fill a preview block with an undecided guess.
- Show `game.stated` at the top of any page it touches, and honour it or argue against it in plain words (conventions §10).
- When a choice changes later, follow conventions §11 (history entry, cascade, recompile).
