# Working together (shared by every studio skill: studio, look, sound, game, reel, world, life)

Decisions 61–64. The same few habits for any asset: models, looks, actions, sounds, cutscenes, towns.

## Before you propose anything

1. `./studio taste` reads the taste file: studio-wide (`~/.studio/taste.md`) plus this project's (`.studio/taste.md`).
   Follow the rules. When a choice leans on one, say so in plain words: "heavier base, per your taste file".
   Don't re-open a question a rule settles. For example, "the kid's smile is good enough" means you don't
   propose smile changes.
2. `./studio notes` lists the inbox. Open notes are the user's asks. Take one with
   `./studio notes on-it --id n3` and close it with `./studio notes done --id n3` once a kept step covers it.
   **Stale** notes point at a moment or part that's gone. Ask the user where they belong now
   (`notes repin --id n3 --at …`). Never guess a new spot for them.

## Pointing: moment addresses

- `./studio selection` gives an `address` for what the user clicked, plus its words ("Walnut stool / seat").
- `./studio address --object octopus --clock clip:pours-tea --near pour` points at a moment. Ticks run at 24,000 a
  second. Anchor to a named moment (`--near`, an action key label) whenever you can: notes then follow it
  when "slower" re-times the clip. A bare tick goes stale instead.
- Compact form for `--at` flags: `stool/leg#2`, `octopus@clip:pours-tea 3.4s ~pour`.
  Clocks: `none` (a part), `clip:<motion>`, `shot:<cutscene>`, `beats:<track>`, `sound:<file>`, `game` (+ seed, build).
- When you mention a time to the user, use the view's words ("1.4 s", "bar 9", "10:32", "shot 3"), never ticks.

## Steps: one word note, one step

- Each step answers about one word note: "slower", "warmer", "swap the clink". Pass the note with
  `--why "warmer"` on the tool call, and the review panel shows it on the step.
- Don't batch many small edits into a pile of steps the user will rubber-stamp. If `./studio review-stats` says
  more than 9 in 10 steps are kept without opening, make bigger steps.
- Renders are caches keyed by their recipe. The same recipe returns the cached PNG
  (`render … --cache false` forces a fresh one). History holds only recipes.
- "Keep" counts as reviewed only after the step's before/after was opened, with the view's **Before/after**
  button or `./studio open-step --step 2`. When you hand over a proposal, say which steps most need
  their before/after looked at.

## "Show me three"

Use it only when asked ("show me three", "give me options"):
`./studio show-three --title … --topic … --takes '[{label, traits, calls:[{tool,args}]}, ×3]'`.

- Make the takes **deliberately different**: a different idea each, not three nudges of one number. Takes
  less than 15% apart are refused.
- The result compares the takes per section. The user picks one with `./studio pick-take --take <label>`.
  That take is committed whole and the other two are discarded, never merged.
- Picks are logged. The same choice 3+ times becomes a taste rule by itself, with the source "from N picks".

## The "your call" card: after every proposal

`./studio card --asks '[…]'` adds the card. "I checked" is filled from the checks, so you don't write it.
"Your call" holds **at most 3 asks**, and only things checks can't judge (taste, feel, sound, readability):

- `pick` (2–5 options, each with `traits`), `yesno` (yes / not yet), `play60` (play it for 60 s, with `playable` =
  the change's stamp; asked once per playable change), `note` (a few typed words).
- Give each ask a `topic`. When the taste file answers that topic, the card skips the ask and says it leaned on the rule.
- Skipped asks wait in the notes inbox. Answers can become taste rules: `answer … --remember true` only when the
  user says "always…/never…/remember…". Never add a taste rule the user didn't state (`taste add --said true`),
  apart from the 3-pick patterns, which add themselves.
- **Overnight or unattended work never waits on an ask.** Use `card --unattended true` with a `guess` on each
  ask, carry on, and report the guesses as guesses. They wait in the inbox to be checked.

## Privacy

Notes, picks and taste live in `.studio/` and `~/.studio/`. Both are gitignored, as is any `taste.md`,
`notes.json` or `picks.json` in the repo. They reach the public repo only if the user opts in (`git add -f`).
