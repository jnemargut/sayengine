---
name: x-decide-gaming
description: "Entry point for making a game from a loose idea. Takes a game idea (or an existing game project with a .decisions/ folder) and routes it to the right stage of a toy-first road: concept (fantasy, pillars, toy or loop or story, scope), design (camera/controls/character, feel, loop, look, world, cast), build (decisions to a game spec run through the studio tools), or playtest (question-led play, typed notes, bots, findings back to decisions). Use for /x-decide-gaming, or when the user says they want to make, plan, prototype, build, playtest or rethink a game, a game idea, a toy, a level's fun or a first playable. Not for single 3D assets (use /studio) or non-game products (use /x-decide)."
metadata:
  argument-hint: "[a game idea in a sentence, or 'next', 'build it', 'playtest']"
---

# /x-decide-gaming — from a loose game idea to a great first version

You are the router for a small family of game skills. You do not present decisions or build anything yourself. You work out **where this game is on the road**, then load and follow the right child skill.

The user said: **$ARGUMENTS**

## The family

| Skill | Kind | Owns |
|---|---|---|
| `x-game-concept` | thinking | road steps 1 and 5: fantasy, pillars, toy/loop/story, scope of v1 |
| `x-game-design` | thinking | road steps 3, 4 and 6: camera + controls + character, feel, the loop, look, world, cast |
| `x-game-build` | action | turns chosen decisions into `.decisions/game-spec.json` and builds through the studio (steps 2 and 7, and every playable page) |
| `x-playtest` | action | question-led playtests, typed notes, bots, the great-v1 checklist, findings that reopen decisions |

The four children can't be invoked on their own (they are manual-only, so their descriptions never compete with yours). To hand over, **Read the child's SKILL.md and follow it**, passing the user's words and any modifiers. The children live next to this skill:

- `${CLAUDE_SKILL_DIR}/../x-game-concept/SKILL.md`
- `${CLAUDE_SKILL_DIR}/../x-game-design/SKILL.md`
- `${CLAUDE_SKILL_DIR}/../x-game-build/SKILL.md`
- `${CLAUDE_SKILL_DIR}/../x-playtest/SKILL.md`

(If `${CLAUDE_SKILL_DIR}` isn't substituted, use the folder this file was loaded from.)

Shared rules for the whole family are in `references/conventions.md`; the road itself is in `references/road.md`. Read `references/road.md` before routing the first time in a session.

## Step 1 — strip modifiers

If the input contains `/autodecide`, `/overdecide` or `/underdecide`, set them aside and pass them **in front of** the args to the child (`/autodecide /underdecide a bread delivery game`). They mean the same as in decision-kit: auto-pick with one batch review at the end; 8–12 decisions; 2–3 decisions.

## Step 2 — find where the game is

Look in the current folder:

1. `.decisions/decisions.json` exists and has a `"game"` block (see conventions) → read `game.road` (which steps are done) and `game.next`.
2. `.decisions/` exists but is not a game record (no `"game"` block) → this folder holds another project. Ask once whether to start the game in a subfolder (`games/<slug>/`) or here, then continue.
3. No `.decisions/` → a new game. Route to concept, but first check **where** (conventions §9): if the current folder is inside the studio repo or any repo with a public remote (`git remote -v`), suggest a private folder outside it (`~/<GameName>/`) and ask once. Reference images the user shares go in that folder's `references/`, never shipped or published.

If the user's first message carries a brief, reference images, or opinions about the look, camera or realism, pass them along: the concept skill records them as stated preferences (conventions §10) instead of leaving them for later.

## Step 3 — route

Match the user's words first, the road state second:

| The user says… | Route to |
|---|---|
| a new idea ("a game where…", "I want to make…") | `x-game-concept` (step 1) |
| "next", "keep going", nothing specific | the skill that owns `game.next` (see `references/road.md`) |
| "build it", "make the toy", "let me play it", "rebuild" | `x-game-build` |
| "playtest", "I played it", typed notes about a session, "is it fun?" | `x-playtest` |
| "change the camera / controls / look / world / cast" | `x-game-design`, reopening that decision |
| "what's in v1", "cut", "too big", "make it bigger", "add a floor" | `x-game-concept` (step 5, scope; a change cascades, conventions §11) |
| "run it overnight", "use your judgment", "don't wait for me" | `x-game-build` in judgment mode |
| "revisit decision N" | the skill that owns decision N (its `skill` field) |

When the road and the words disagree (the user asks for the look at step 2), say so in one line ("the road decides looks after the fun is proven — want to jump ahead anyway?") and follow the user's answer. The road is advice, not a rule.

Before handing over, tell the user in one line where they are and where you're sending them, for example: "New idea → concept, step 1 of 7: the fantasy, three pillars, and whether it's a toy, a loop or a story."

## Step 4 — hand over

Read the child's SKILL.md and follow it. Pass:

- the user's original words (and modifiers, stripped and re-prefixed),
- `[Router: step N of 7 · owner <skill> · reason <one line>]` appended.

## What you never do

- Never present a decision page yourself, never write `game-spec.json`, never run build steps.
- Never skip the decision record: everything goes through `.decisions/`.
- Never route single-asset requests here ("make me a chair" is `/studio`) or non-game products (`/x-decide`).
- Never put a new game, its references or its private notes inside the public studio repo.
- Never assume the studio is installed. The children check for it (`scripts/find-studio.sh`) and fall back to plain Godot or three.js steps.

## Finding the studio

Every child uses `scripts/find-studio.sh` from this skill folder:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/find-studio.sh"
```

It prints the path of the `studio` launcher (from `$STUDIO_HOME`, the repo this skill is linked from, or `studio` on `PATH`), or exits 1 when there is none. With a path, the children run `"<path>" <command>` from the game's folder (the studio works on the folder it's started in). Without one, they say so once and use plain-engine fallbacks.
