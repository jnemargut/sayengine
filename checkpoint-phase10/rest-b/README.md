# Phase 10 step 3, part B: town life with a day clock, and trailers on the timeline

`node bench/rest-b.ts` (STUDIO_PORT=4730…, STUDIO_CHROME_PORT=9630, STUDIO_CHROME_SPAN=10) runs the real daemon and
view in headless Chrome, drives them with input and pointer events, and saves the screenshots below. The images are
gitignored. `report.json` holds what each action produced: steps, notes, addresses, day checks, take groups, picks.
`SCENES=reel node bench/rest-b.ts` re-runs one scene (the report is merged).

The town is the offline cut of Pocket Raleigh's plaza blocks (`raleigh-mini`, 27 buildings), with the day-toy look.

## 1. Town life with a day clock

The cast is four studio characters (Ada, Dev, Esme, Faro) and two cars, parked out of town; `life-on --folk 24
--cars 3` bakes a Saturday for the chunk: 32 people (24 folk plus friends walking with them), capped for the Mac.

- `life-day-overview.png`: the chunk at 08:30 with the **day strip** on the dock: play, ×1 / ×10 / ×60 / ×600, the
  time, how many are out right now, and a bar chart of people out through the day (every 10 minutes). The master
  timeline hides itself when nothing else moves.
- `life-person.png`: after dragging the strip back to 08:40 and clicking a person (a real pointer click on the
  canvas; hit on the first try). The inspector: June, "looks like Faro", out and about, lives at Home ff0b5b, now
  "sitting on bench 15"; her day as one line per outing with each stop and its time; the day checks (13 of 13
  pass). In the town: a ring under her, her walks as lines, a pin on each stop. Her stops are blocks on the strip.
  The view sent `person:raleigh-5`, clock `day`, 08:40, anchored to "bench 15 (2)" (`report.json` → `address`).
- `life-redirected.png`: "go to the café at 9 instead" typed into the inspector and Redirect pressed. One step
  (`life-redirect`, note "go to the café at 9 instead", the only change `life.redirects`). The outing that
  overlapped 9:00 is gone. In its place: 09:00–09:42, "09:01 goes into Shop b0524a (40 min)" in orange (a café is a
  shop door; this is the shop nearest her home). Her afternoon is unchanged. The headless day re-ran on the new plan
  (24 h sped up, ~11 s here) and all 13 checks pass. The orange block on the strip is the redirected stop.
- `life-walking-to-cafe.png`: the strip dragged to 09:01: "walking", on her way there.

## 2. Trailers on the timeline

`reel-import` brings in `games/pocket-raleigh/reel/trailer.json`, keeping the three day shots of the plaza blocks
(the night and river-twin shots need towns this scene doesn't have).

- `reel-shot1.png`: the **shots** track (segments `1 day-street`, `2 day-plaza`, `3 day-aerial`, `end card`, with
  beat and bar ticks). Selecting it turns on **Shot camera**: the viewport looks through shot 1's camera at 1.9 s,
  with the 16:9 frame the export crops marked. The side panel offers Keep / Redo / Show me three for the shot under
  the playhead.
- `reel-redo.png`: Keep on shot 1 (✓ on its segment, one step "keep shot 1"). Then Redo on shot 2: one step
  "redo shot 2" that adds the take `day-plaza-orbit` (a slow orbit round the plaza) and points shot 2 at it. The
  step changes only `reel.takes.3`, `reel.edit.1.take` and `made.day-plaza-orbit`; the other shots and every old take
  are byte-identical (`report.json` → `redo`).
- `reel-three.png`: Show me three on shot 3: an orbit, a push in and a crane up, side by side over the scene (first
  and last frame of each move, rendered from the scene with the main renderer). The camera moves are 37–46 % apart
  (≥ 15 % required) and the take docs 80 % apart. Opening the compare marks the takes as seen.
- `reel-playing.png`: after Pick on "a push in" (committed whole, the other two discarded, the pick logged with
  topic `reel-shot`, chosen trait `push`, rejected `orbit` and `crane`), the cut playing through the shot cameras
  from the start.

`reel-export` then writes the reel file back and says what to capture: `studio reel capture --takes
day-plaza-orbit,day-aerial-push`, then `studio reel cut` (the same ffmpeg recipe as before).

## What's weak

- **Folk are stand-ins.** In the view each person is a capsule, legs, head and hair in their cast colours, and a car
  is a box. The slim cast GLBs the games use would be truer and heavier. From the diorama camera a person is a few
  pixels, so the bench frames them from close and high, and even then the walking shot is hard to read.
- **The cast is parked in view.** The characters life draws from stand at z = −330, outside the chunk, and show as
  dots in the overview. They are kept out of the scene timeline and are never auto-selected, but they aren't hidden.
- **Few people are out at 08:30.** The Saturday curve has the town filling up from 09:00. The overview is honest but
  thin; the bar chart on the strip shows the shape of the day.
- **A redirect takes a while.** It costs a re-bake (~4 s) plus a 24 h headless day (~7–11 s on this loaded machine)
  before the checks are back. The panel says "Running the day headless…" while that happens.
- **The words reader is phrases, not language.** It picks up a time ("at 9", "3pm", "14:30"), a place (café / shop /
  bench / market / pier / bus stop / park, or a place's own name) and a stay ("for an hour"). Anything else is said
  back as "I didn't catch…".
- **The trailer was framed for the full town.** On the 27-building cut the street shot starts outside the chunk, so
  its lower edge shows the diorama's edge and the sky under it. The `raleigh-city-plaza` cache isn't on this machine.
- **The beat marks are a grid.** The shots track uses a steady grid at the reel's bpm. The final cut snaps to
  librosa's detected beats. On the generated track they agree; on a recorded track they may differ by a frame or two.
- **The view uses the scene's look for every shot**, not each take's own look (day-toy or neon-night).
- **New takes still need a Godot capture** before `reel cut`. The view only shows the camera move over the scene.
- **Software GL is slow.** In headless Chrome (SwiftShader) a frame of the town takes about a second. The three
  thumbnails take about a minute, and ×600 moves the day about 5 minutes per 5 s of wall time. On the Mac's GPU
  (Metal) this is not measured here; step 2 measured the forge at 1.9 ms of work per frame.
- **Screenshots are in the dark theme** (headless Chrome's default).
