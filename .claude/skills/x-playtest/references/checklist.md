# Great-v1 checklist and bot recipes

## The great-v1 checklist

Mark each **yes**, **not yet** or **not tried**, with the evidence (a note, a number, a still).

1. **The core fun repeats.** The 30 seconds of fun (or the toy's pull) still holds after five minutes. Evidence: the player's notes, whether they played past the time box.
2. **A newcomer gets it without help.** Someone who hasn't seen the game starts playing within a minute without being told how. Evidence: a newcomer round (required before v1 is called done).
3. **Every pillar shows up in play.** For each pillar, name the moment in play that shows it. Evidence: notes and stills.
4. **Feel is deliberate.** The verb has responses (sound, motion, small reactions); nothing feels floaty unless that's the chosen feel.
5. **Nothing blocks progress.** Every goal is reachable; no stuck spots. Evidence: bot results.
6. **It ends.** There's a finish (or a natural resting point for a toy), and it feels earned.
7. **It runs well.** No engine errors or warnings; frame time fine on the target device. Evidence: `game run`, the proof checks.
8. **The first ten seconds are good.** The opening shows the fantasy and the verb right away.

## Bot recipes (studio present)

- **Reachability:** `"$STUDIO" game test --project <slug> --assertions '[{"kind":"reachable","target":"<goal>"}]'` for every goal in the spec's scope.
- **Stuck spots:** `"$STUDIO" game walk-to --project <slug> --target <goal> --from [x,z] --screenshot true` from four to eight starts around the space; report `blocked` and where.
- **Lap time:** walk-to each step of the loop in order; sum the times; compare with the loop decision's stated lap time.
- **Health:** `"$STUDIO" game run --project <slug> --seconds 30`; any error or warning is a finding tagged bug.
- **Video:** `--video true` on one walk for the page; read its stills.

Bots measure. They don't judge fun, and the page must say so.

## Finding card fields

`id`, `tag` (fun · confusion · friction · bug · delight), `what` (verbatim quote or numbers), `decision` (id or null), `revisit` (one copyable line), `evidence` (paths to stills or JSON).
