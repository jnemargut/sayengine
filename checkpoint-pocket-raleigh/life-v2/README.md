# Pocket Raleigh, life v2: the polish pass

The same seeded Saturday in autumn (market day, 10:36 am) on Fayetteville St and in the river twin, after a
polish pass on what the first life build reported as weak. Both engines still play one baked day: Godot 4.7.2
with the GDScript runtime and the web (three.js) with the TypeScript one.

## What's here

- `saturday-godot.mp4`, `saturday-web.mp4`, `saturday-godot-vs-web.mp4` (side by side): the market from the
  open side of its ring of stalls, a dog walker, friends on Fayetteville St, a street in the twin, a car and
  the bus (wheels turning, front wheels steering).
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

RESULTS_PLACEHOLDER
