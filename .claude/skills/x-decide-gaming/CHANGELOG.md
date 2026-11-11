# Changelog: the game skills

## 2026-11: lessons from a later build (v1 to a live site)

**Building (x-game-build)**
- Deploy each build that passes its checks to a free static host and confirm it is live. `studio game release` makes the favicon set, the manifest, the share card and the OG/Twitter tags, and its check blocks private words and local paths. Why: the icons and share card took the most manual steps of the release, and a private word nearly shipped.
- Slow audits get a SKIP switch, used only on the user's say-so and reported as skipped. Why: long audits slowed small iterations, and a silent skip would hide regressions.
- The framing audit checks that the subject's surface stays drawn, with the support found by a ray down and physics beats run several times. Why: a cutaway faded the bed and rug the subject stood on, then a height rule made every chair unfadeable.
- Character state changes ease, with the heading on the shortest arc and turn-rate limits (`studio/ease.ts`). Why: a lerp with a large k spun a character more than 1000°/s and popped it metres.

**Playtesting (x-playtest)**
- Classify interactions before counting them. For example, toys are play, not mischief. Why: batting a toy counted as trouble and got the player punished.
- Bots play the way a player does: they click an event again and wait for it to end. Why: a bot that clicked while a gag was playing cancelled it, then reported goals as unreachable that a person reaches easily.

**Studio**
- The game runner no longer leaks headless Chromes when it is killed. There is a soft-cartoon look preset, a sticker UI style, cutaway protection and a pose easer in the web kit.

## 2026-11: lessons from the first full run

One game went down the whole road (concept to an unattended v1 build). These changes fix what hurt. The road is still seven steps and the router's routing is unchanged.

**Decide the hard-to-undo things earlier**
- Stated preferences: a brief, references or opinions in the first message are recorded in `game.stated` and shown on every page they touch, instead of being written off as "decided later" (conventions §10). Why: the user asked for a warm, fairly realistic look up front, and it was only addressed after the cast had been rendered in a toy-like style.
- A light **fidelity target** at step 1 when the user names a look or shares references (concept catalogue), and an **asset sources** decision at the start of step 6, before any look or cast render (design catalogue). Why: realism and where models come from were settled last, so earlier renders were thrown away.
- A **character check** render of the hero and the main other character from the toy on (build modes, conventions §5). Why: "it reads as the wrong animal" and "the person looks like a mannequin" surfaced only at the cast page, and the hero took many rework passes.
- A working title and tone in one line at step 1, and tone, title screen and logo pages in the design catalogue. Why: a late name changed the tone and needed new pages.
- **Set dressing** (how lived-in, what the stuff says about the characters) added to step 6. Why: it had no place and came up as extra pages.

**Keep the record honest**
- Scope changes cascade: derived counts (goals, secrets, session length, cameras, routines) are recomputed at once and announced; derived spec fields are marked; the spec is checked against the record after every compile (conventions §11, game-spec "Derived fields"). Why: scope grew and the user had to ask for the consequences, and the spec kept stale numbers.
- Playtest notes become concrete proposed changes with history entries, and the playtest page shows "What changed because of your notes"; the next one opens with "Since last time" (x-playtest step 5b). Why: the best loop changes came from typed notes, and turning them into decisions was manual.

**Pages that can be trusted**
- Playable presets are tried in the real space before the page is shown; an untestable one is fixed, swapped or flagged. Why: a high camera couldn't be judged in small rooms.
- Systemic games: feel pages say, measured, how each option meets the other characters' senses, and perception numbers are never `small` defaults. Why: feel presets changed noise that the other character never heard, which nobody could see from the page.
- No paid options, ever, not even as one of four (conventions §8). Why: a page offered a bought model as an option.

**Building**
- Verification: every claimed visual fix needs a verified fresh build (hash, build stamp, no filtered errors) and a side-by-side before/after render (`x-game-build/references/verify-and-debt.md`). Why: a stale bundle went unnoticed for several rounds and fixes were reported that weren't visible.
- Studio first, and a tool-debt ledger (`PAIN.md`) with an offer at the end of v1 to fold general items back into the studio. Why: the game is also a test bed for the tools, and about sixty workarounds piled up in game code.
- Judgment mode for long unattended runs: a judgment log with before/after images and a required "rough still" list, progress notes per milestone, a resume file, and the newcomer round left as the one human step (`x-game-build/references/judgment-mode.md`). Why: the overnight run worked well this way; now it's a mode rather than an improvisation.
- Blender (headless, free) for props and meshes when the studio has no step, and read `studio help` each session for new steps (a creature or people step, headless renders, a port flag) instead of assuming.
- Keep `build-plan.json` current after the first toy.

**Privacy**
- A new game defaults to its own folder outside the (public) studio repo; references live in `references/` and are never shipped, published or copied into pages; no absolute home paths in game files; a pre-commit check that nothing private is staged (conventions §9).

**Not changed**
- The seven-step road and the router's routes (two routes added: scope growth and judgment mode).
- The rule that the camera, controls and character are one decision, and that the look comes after the fun.
