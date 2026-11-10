# Judgment mode (long unattended runs)

For when the human says "use your judgment", "do it overnight", "don't wait for me, log it". It wraps the other modes (usually `v1` or a large `rebuild`). Set `game.mode: "judgment"` while it runs and back to `attended` at the end.

## What changes

- **Gaps don't stop the build.** A `real` gap that would normally become a gap page is decided by you, following the chosen decisions, the pillars and `game.stated`, and logged as a judgment call. Only stop for a one-way door that would be expensive to undo (deleting work, changing the fantasy or the scope, anything costing money, anything touching privacy); log it as a question and move to other work.
- **Studio steps can't wait for review** (nobody is watching the view), so they may go straight in, but each is logged with its studio step or commit id so it can be undone.
- Everything else holds: the free and local rule, privacy, the verification rule, the tool-debt ledger.

## The judgment log (`.decisions/OVERNIGHT-<name>.md`)

Start it before the first step with the standing inputs (the decisions and history entries that drive the run, in a few bullets). Then one section per milestone:

```
## Step 2: <milestone>
- Before: .decisions/renders/<thing>-before.jpg   After: .decisions/renders/<thing>-after.jpg
- Judgment calls:
  - **<the call, bold>**, then why, in one or two lines, naming the decision or pillar it follows.
- Checks: tests passing, frame time, build hash.
- Rough still: what's visibly not right yet.
```

Rules for the log:

- Every judgment call is bold and has a reason tied to a decision, a pillar or something the user said. A call you can't tie to anything is a question for the human, not a call.
- Every visual change has before and after images from a verified fresh build (`verify-and-debt.md`).
- **"Rough still"** is required: list what isn't good yet. A log with no rough edges is not believable.
- Write the section when the milestone ends, not at the end of the night: if the run dies, the log is the resume point.
- Keep a short `RESUME.md` beside it: where things stand, the last good build, how to play it, what was in progress.

## Progress notes

After each milestone, also update `preview.html` (latest build), `game.road`, and add a one-line note to `game.notes`. If a chat is open, post one line per milestone ("Step 2 done: free textures in every room, build-010, 60 fps; rough: the floor tiles read too strong").

## The one human step

Judgment mode can build v1 but cannot finish it. The newcomer round (someone who has never seen the game plays it) is always left for the human, and so is the verdict on fun. End the run with: the log's link, the list of calls the human may want to reverse (one line each, copyable: `revisit: the exit moved to the new room`), open questions, and "Next: one round with a newcomer."
