# Pocket Raleigh, life v2: the polish pass

The same seeded Saturday in autumn (market day, 10:36 am) on Fayetteville St and in the river twin, after a
polish pass on what the first life build reported as weak. Both engines still play one baked day: Godot 4.7.2
with the GDScript runtime and the web (three.js) with the TypeScript one.

## What's here

- (no videos this round: the video shots are in `bench/life-shots.ts`; capture them and run `bench/life-video.py`)
- `stills/godot/` and `stills/web/`: the same shots in each engine; `godot-vs-web-sheet.png` puts them side by side.
- `life-report.json`: the Saturday hour (9:30–10:30) through the final code, with the parity run.
- `headless-day-24h.json`: a whole day (5:00 to 5:00) through the final code.

Regenerate (from the repo root):

```sh
sh bench/life-cast.sh            # the cast (LIFE_CAST_TOWNS=0: cast only); then, with a view open
node bench/studio-view-headless.ts &   # (or the studio view in a browser)
sh bench/life-export.sh          # export + slim (bench/life-slim.ts)
node bench/life.ts               # bake, the Saturday hour, parity  (--from 5 --hours 24 for a whole day)
node bench/life-shots.ts > shots.json
```

Then capture with `games/pocket-raleigh/game/life_capture.gd` and `bench/life-web-capture.ts`, and encode
with `bench/life-video.py` and `bench/life-stills.py`.

## Numbers (final code)

- **Whole day (5:00 to 5:00): 12 of 13 pass.**
  - Fails *no two folk in one spot*: 3 samples, worst 0.20 m, each involving a friend.
  - Close to the limits: squeeze-pasts 1,319 (limit 1,440) and off-walk grazes 22 (limit about 26).
  - Clean: no pops, no car hits, no car on car, no red-light runs, no gridlock, the leash, one sitter per seat, folk making room for the player and cars braking for the player.
- **Saturday hour (9:30–10:30): 12 of 13 pass.**
  - Fails *few squeeze-pasts*: 320 against a limit of 60, from one knot that keeps slipping past each other.
  - Peak 80 folk out, up from 47.
- **Parity (D30, 0.5 m tripwire): passes with a worst gap of 0.10 m** over 2,004 positions in 120 s, with no visibility mismatch.
  - That is not machine precision any more (it was 5.6e-13 m). An exact tie in a threshold test rounds differently in the two languages.
  - I fixed one tie; at least one remains.
- **Cast GLBs:** 51.5 MB per game before, 19 MB (Godot) and 14 MB (web) now.
  - Face shapes are dropped.
  - Weights and joints are 8-bit, UVs 16-bit, and still channels keep a single key.
  - On the web only, positions and normals are quantized. Godot's glTF import does not support that.

## How it looks (honest)

**Better, not yet lively.**

What improved, comparing the stills to v1:
- Anglers hold a rod in the right hand instead of standing T-posed.
- Pairs of friends walk together.
- Browsers stand at the stalls of the market ring.
- The dog walker and the bench sitter still read well.
- Both engines match frame for frame.

What's still weak:
- The streets are still thin at 10:36, with one to three people in most frames.
- The market shot fell back to a top-down view, because no tree-free side view was found.
- The bus shot has a tree in the foreground.
- Idle variety, the fades at doors and the turning wheels only show in motion, and no videos were captured this round.

