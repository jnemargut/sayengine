# The toy-first road (decision 37)

Seven steps from a loose idea to a great first version. Every stage ends with something to **play**, not a document. Steps marked *play it* are built by `x-game-build`.

| Step | What | Owner | Ends with |
|---|---|---|---|
| 1 | The fantasy in one line · three pillars · toy, loop or story? · the core verb · a working title and tone (one line) · a light **fidelity target** when the user has shown references or named a look | `x-game-concept` | decide |
| 2 | **The toy**: the core verb in a grey box, plus a cheap mood pass (lighting colour, one palette) and a **character check** render of the hero (and the main other character, if any) | `x-game-build` | play it (about an hour after the idea) |
| 3 | Camera + controls + character, decided together · feel pass | `x-game-design` | play it (playable presets on the decision pages, each tried in the real space) |
| 4 | The loop around the toy · a 5-minute playtest | `x-game-design`, then `x-playtest` | play it |
| 5 | Scope v1 on one page: what's in, what's cut | `x-game-concept` | decide |
| 6 | Asset sources (first, before any look or cast render) · look · world and set dressing · cast · tone, title screen and logo if still thin | `x-game-design` | see it (renders, look-lab boards) |
| 7 | **First version**: small, finished, about 10 minutes of fun · great-v1 checklist · one round with newcomers | `x-game-build`, then `x-playtest` | play it |

## Why this order

- Find the fun ugly first; look comes last (Nintendo: gameplay first, then the art that suits it; Riot: ugly but fun).
- Camera, controls and character are one decision (studios lock the "3Cs" together and early).
- Feel is a design layer, not decoration, so it gets its own pass right after the 3Cs.
- A cheap mood pass at step 2 keeps playtests honest (a joyless grey box gets joyless feedback).
- Scope is decided once the fun is found, on one page (Librande-style), so it can be redrawn. When it is redrawn, everything that scales with it is recomputed at once (conventions §11).
- Look comes last, but **fidelity** doesn't: how realistic the game aims to be, and where its models come from, change how the characters are made. Settle the target early and lightly; settle the exact look at step 6. Characters get a cheap render at step 2 so a broken-looking hero is found while it is cheap to fix.
- A working title and tone from step 1 keep the name, title screen and jokes from arriving as late rework.

## Variants (asked at step 1)

- **Toy-led** (a thing that's fun to play with, no goal): skip "the loop" at step 4; ask instead "what makes you come back to it?".
- **Loop-led** (30 seconds of fun, repeated): the default road.
- **Story-led** (arcs, characters, dialogue): use the pitch-first order. Step 1 adds a one-page pitch and mood (key renders from the studio); the toy at step 2 is the core interaction of the story (talking, choosing, walking somewhere), and cast moves up to step 3.

## Where the game is

`decisions.json` holds `game.road`: one entry per step with `status` (`todo`, `doing`, `done`, `skipped`) and the decision ids or build ids that closed it. `game.next` is the first step that isn't done. The router reads this to route "next".

## Tripwires

- The first toy takes more than one session → cut step 2 to one verb and one camera.
- The user skips playing at steps 2–4 more than once → merge steps 3 and 4.
- More than three build stops for one toy → raise the threshold for what counts as a real gap (see the build skill).
- The same character needs more than two rework passes at step 6 → stop and reopen the fidelity or asset-source decision; the method, not the details, is probably wrong.
- The user has to ask for a consequence of their own change ("so there should be more jobs?") → the cascade rule was missed; recompute and say so.
