---
name: x-playtest
description: "Action skill that runs a question-led playtest of a game build: suggests what this test is for, has the human play and then type their thoughts (talking aloud is optional), runs bots through the studio's game runtime where available to measure stuck spots and timings, applies a great-first-version checklist, and writes a findings page where each finding links to the decision it questions with a one-line way to revisit it. Use when /x-decide-gaming routes a playtest here, or after a toy, loop or first-version build."
disable-model-invocation: true
---

# x-playtest — play it, learn, feed it back into decisions

You run playtests like experiments (Valve's approach): one question going in, play, notes, numbers, then findings that point at the decisions they question. You never change decisions on your own; you turn the human's notes into **concrete proposed changes** they can accept in one word, and apply only what they accept.

Input: **$ARGUMENTS** (may already contain the human's typed notes)

Read first: `../x-decide-gaming/references/conventions.md`. The checklist and bot recipes: `references/checklist.md`.

## Step 1 — set up

1. Read `.decisions/decisions.json`, `game-spec.json`, `build-plan.json`, the latest build in `.decisions/builds/`, and earlier playtests in `.decisions/playtests/`.
2. Find the studio (`bash ../x-decide-gaming/scripts/find-studio.sh`).
3. Number this playtest (`playtest-NNN`).

## Step 2 — the question

Suggest **one** question from the road step and the open risks, and let the human confirm or change it in one word:

- step 2 (toy): "Is it fun to play with, even without a goal?"
- step 3 (feel): "Does the [verb] feel good after five minutes, not just the first ten seconds?"
- step 4 (loop): "Does a lap make you want another lap?"
- step 7 (v1): "Does a newcomer get it without help, and does every pillar show up in play?"

## Step 3 — the human plays

Give them the build link (`.decisions/builds/build-NNN/index.html`, served from `.decisions/`) and a time box (five minutes for a toy or loop, ten for v1). Then ask them to **type** what they thought: fun moments, confusing moments, anything they wanted to do and couldn't. Talking aloud with a local transcription model is optional; only offer it if they ask. If their notes are already in the input, skip asking.

Don't lead them. Don't explain the game before they play unless the test is about the explanation.

## Step 4 — bots (when the studio is present)

While the human plays (or right after), run bots through the studio's game runtime to measure what people can't see. Recipes in `references/checklist.md`:

- `"$STUDIO" game walk-to --project <slug> --target <goal>` from several starts: reached, blocked, time.
- `"$STUDIO" game test --assertions …` for reachability of every goal and rules that must hold.
- `"$STUDIO" game run --seconds N` for errors and warnings.
- Read every still or screenshot you produce.

No studio, or a verb bots can't play (cozy, no goal): skip bots and say so on the page.

## Step 5 — findings

Turn the notes and numbers into findings. Each finding:

- says what happened in the player's words or the bot's numbers,
- is tagged fun / confusion / friction / bug / delight,
- **links to the decision it questions** (`decision-00N`), or to none,
- ends with a revisit line the human can copy: `revisit decision 5: handling feels too heavy on hills`.

Then apply the **great-v1 checklist** (`references/checklist.md`): each item yes / not yet / not tried, with evidence.

## Step 5b: notes into decision changes

A wish in the notes ("I want it to end when the list is done", "I wish there were hidden surprise things to do") is a design change, not just a finding. For each one, write a **proposed change**: the decision it changes, the change in one concrete line (what the rule becomes, with numbers where it has them), and what else it touches (spec paths, derived counts, tests). When a wish is vague, offer two or three concrete readings instead of one ("hidden secrets: listed with vague names / fully hidden / revealed at the end"). List them on the playtest page (step 6), then ask once in chat: "Apply 1 and 2? (yes / pick / no)".

On yes: add a `history` entry to each decision (`from: "playtest-NNN"`, conventions §11), cascade derived fields, and ask `x-game-build` to rebuild only what changed. A change that alters the fantasy, the pillars or the scope gets a full decision page instead.

## Step 6 — write it up

1. `.decisions/playtests/playtest-NNN.json` (question, notes verbatim, bot results, findings, proposed changes with their status, checklist) and `playtest-NNN.html` (same page style as decision pages: the question at the top, findings as cards, a **"What changed because of your notes"** section listing each accepted change with the note it came from and the decision it updated, checklist, bot numbers, links). Fill that section once the human has answered; until then it lists the proposals.
2. The next playtest's page opens with "Since last time": the changes from the previous playtest and whether they're in the build being tested.
3. Update `preview.html` (a "last playtest" line) and the road: a playtest at step 4 closes step 4; at step 7 it closes the road when the checklist passes and one newcomer round is done.
4. Open the page. In chat: two to four lines with the biggest finding, which decision it points at, and the proposed changes to accept.

## Rules

- One question per playtest.
- The human's notes are recorded verbatim; your summaries are separate.
- Fun is judged by people; numbers come from bots. Never claim a bot result shows something is fun.
- Before calling v1 done, at least one round with someone who hasn't seen the game. This round is always the human's to run, even after an unattended build.
- If the human skips typing notes twice, stop asking for a form: ask one question after each play instead.
