# Overnight build: 4–5 November 2026

What got built while you slept, what I checked myself, and anything that went wrong. All of it is committed on your Mac only. Nothing was pushed to GitHub.

## Done before you went to sleep
- **Face round** (merged; 101 tests pass).
  - **Changes:**
    - Painted eyes with catch-lights.
    - Lips with a smile or frown line.
    - Blush, freckles and stubble.
    - Dog markings and a proper forehead-to-muzzle step.
    - The heron's eye stripe.
    - The robot's glowing cheeks.
  - **Images:** `checkpoint-faces/after/faceted/faces.png`.
  - **Still weak:** the kid's smile reads like a stitched line, the smooth style isn't clearly better than the faceted one, and the dog's legs are still slim.
- **Game skills** (merged; 106 tests pass, installed into `~/.claude/skills`).
  - **Usage:** type `/x-decide-gaming <your game idea>` in any folder.
  - **Test run:** "a cozy game where you deliver bread at dawn", in `checkpoint-game-skills/bread-at-dawn/.decisions/`.
  - **Not yet tried on a real game:** playable option previews and playtest bots. Fire's Dying will be their first real use.

## Paused 7:41pm, resumed 8:13pm (usage window)
- **Fire's Dying** (web) and the **movable-parts framework** were paused so they wouldn't run the last 9% of the window dry. Both resumed after the reset.

## Progress overnight
(updated as each piece lands)

- **Movable-parts framework** (merged; 116 tests pass, view builds).
  - **What it does:** legs (2/4/6/8), bendy chains (tails, tentacles, snakes), wheels with springy suspension, hinges, springs, and grass that sways.
  - **Checks:** every motion is checked, and a timeline shows where a check fails. All the existing characters now count as combinations of these parts, and none of them moved or looked any different.
  - **Videos:** each one shows a live checklist, and I looked at the stills myself.
    - `checkpoint-phase8/crab/robot-crab.mp4`: a six-legged robot crab with a whip tail. It also includes a deliberately broken run where "feet planted" turns red.
    - `checkpoint-phase8/snake/snake.mp4`
    - `checkpoint-phase8/car/little-car.mp4`: a car on bumpy ground.
    - `checkpoint-phase8/windmill/windmill.mp4`
  - **Still weak:**
    - The creatures look blocky; the crab reads more like a robot spider.
    - Godot gets pre-recorded clips; feet and wheels adapting live only works on the web so far.
    - The new checks found a small hip snap in the bird-person's walk, which I noted to fix later.

- **Fire's Dying v1** (merged; 122 tests pass, including the game's own rules tests).
  - **Play it:** run `cd games/fires-dying && npm run play`, then open http://127.0.0.1:8123/. Move with WASD or the arrow keys, or tap where to go. E, Space or a tap uses things. R restarts.
  - **The game:** you're the apprentice. The smith calls out for tools, in his own voice, while the forge fire drains. You win by finishing the blade and lose if the fire goes out. There's a short cutscene at the start.
  - **Playtest by the bot:** it won in 195 s (16 tools) and lost in 51 s when it never fed the fire. Videos are in `games/fires-dying/playtest/` (`intro.mp4`, `win.mp4`, `lose.mp4`). I checked the stills: it reads as a real little game.
  - **Honest verdict:** a charming 3-minute toy, not yet a game you'd replay.
    - The tension between fetching tools and feeding the fire works, and the voiced calls make it feel alive.
    - It's too easy and repetitive, with only 5 items.
    - The fire is placeholder cones and the HUD is plain HTML.
  - **Problem log:** `games/fires-dying/PAIN.md` lists 14 places where the tools fell short. That's exactly what the effects and UI kit build is fixing now. The biggest was that three.js quietly renamed "Big hammer" to "Big_hammer", so the stations didn't exist.

- **Effects, UI kit and /game fixes** (merged; 131 tests pass).
  - **Effects:** one effect file plays in both Godot and the web. It can follow a game value (fire size) or fire on a motion moment (sparks on each hammer strike).
    - **What's built:** forge fire, sparks, chimney smoke, embers and rain.
    - **Matching between engines:** fire and embers match well. Sparks, smoke and rain still look different in each engine. Rain is the worst: it's weak on the web.
    - **Comparison images:** `checkpoint-effects-ui/all-cards.png`.
  - **UI kit:** a forge-style theme for both engines.
    - **What's built:** bars, item slots, buttons, title cards, and a speech bubble that follows a character.
    - **Icons:** six for tools (tongs, charcoal, hammer, file, bucket, blade).
    - **Checks:** contrast, text overflow when translated, and tap size.
    - **Pictures:** `checkpoint-effects-ui/ui-over-forge-web.png` and the `ui-sheet` folder.
  - **/game fixes:** all eight from the Fire's Dying log.
    - Object names survive export.
    - The player can be customised.
    - `say()` for voiced lines.
    - `hold()` for props.
    - Hand props need no collider.
    - Placing on furniture picks its flat top.
    - Screenshots include the HUD.
    - All voice audio is exported.

- **Fire's Dying v1.1** (merged; 135 tests pass, view builds).
  - **Play it:** `cd games/fires-dying && npm run play`, then http://127.0.0.1:8123/. R or Enter replays from the end card.
  - **What's new:**
    - 20 jobs instead of 16, and two new tools (chisel, whetstone).
    - A bellows to pump, and a quench step every fifth job (carry the bucket to the tub).
    - The smith gets impatient near the end, and making him wait costs fire.
    - Real fire, sparks, smoke and embers, plus the new HUD: bars, a "he wants" slot with an icon, a carrying slot, and title and end cards with Play again.
  - **Bot playtest:** won in 4:01, lost in 85 s when it never fed the fire, and the fire died at 62 s when it stood still. Play again works in all three. I looked at the stills: the HUD and the carried items read clearly.
  - **Honest verdict:** a real 4–5 minute game you'd play twice, not ten times.
    - Every job is still "walk there, press E".
    - The camera is far enough out that carried tools are small.
    - Nothing brings you back except your time.
  - **Effect matching between engines** (0.25 or less = match): fire 0.09, embers 0.28, sparks 0.30, rain 0.45, smoke 0.52.
    - Four real bugs fixed: sideways web rain, short web sparks, dark web colours, and every Godot particle living longest.
    - Smoke still rises higher on the web, cause not found.
    - Rain is noted as a candidate for Effekseer.
  - **Problem log:** `PAIN.md` has the new problems. The biggest: `game import` quietly wrote empty effects and UI data. It now says so.

## Where things stand
- **Tool freeze (your decision 59):** no new tool modules until you've shared Fire's Dying. So I stopped here rather than starting Pocket Raleigh.
- **Your move:** play it, share it with someone, and tell me what felt off. Next up after that: Pocket Raleigh, wings and fins, and one-off actions.

## 5 November, daytime (you lifted the freeze)
- **Pocket Raleigh: built and merged.**
  - World (real downtown plus an invented river town), proof, looks (day and night, with glow), people and traffic, sound and trailers.
  - The State Capitol and the four landmarks were modelled from reference sources.
- **Animate anything: built and merged.**
  - Wings, swimming, the octopus, spider, bird and fish, and one-off actions with word notes.
  - Live feet in Godot, now on by default in `/game`.
- **Craft pass on the creatures.**
  - Feathers, spider legs, the octopus wrapping round the teapot, the fish's seams, and the dog's legs.
  - The kid's smile and the PAC are "good enough" (your call).
- **Effects now match between Godot and the web.**
  - Smoke went from 0.31 to 0.11, and rain from 0.42 to 0.07.
  - Fixing that also fixed a real web bug.
- **Stable Audio Open Small runs locally.**
  - Your verdict was that it's about equal to the CC0 recordings, so it fills gaps only.
  - Fire's Dying uses it for the quench and the bellows.
- **Backed up to your private GitHub.**
  - The history was slimmed: a clone is about 8 MB, the game files are on LFS, and the demo media is on a release.
  - The licence is Apache-2.0.

## Phase 10: Working together (decisions 60–65)
- **Step 1, the shared core: merged.** 227 tests pass.
  - **Moment addresses:** a note on "pour" follows the moment when it's retimed. If the moment is gone, the note is marked stale and never moved silently.
  - **Steps:** every step carries its word note, and "kept" only counts once you've opened its before/after.
  - **Show me three:** three takes, each at least 15% different from the others.
  - **Notes inbox and taste file:** `~/.studio/taste.md` has your two verdicts in it.
  - **"Your call" cards:** the sound question gets skipped because of your taste file.
  - Screenshot: `checkpoint-phase10/core/view-card-and-notes.png`.
  - **Still weak:**
    - There's no timeline yet, so you can't point at a moment in the view.
    - "Show me three" only compares in the CLI.
- **Step 2, the timeline: merged.** 243 tests pass. Both benches re-ran on merged main with no view errors.
  - **The dock:** a timeline sits under the live view with a track per thing that moves: motions, voice lines, cutscenes, effects, sounds and music. It has play, loop and scrub.
  - **Red stretches:** failed motion checks show as red stretches. The smith's strike really snaps too fast at 0.97 s.
  - **Pointing:** click a bone while it moves and you get its moment, e.g. "RightHand at the strike's impact". Say "slower" and the clip becomes one step, with the pinned note following the impact.
  - **Effects and sound:** sparks fire on each impact and their knobs are sliders. Sounds have their own tracks, with "show me three" for sounds as a listen-and-pick card.
  - **One place to watch:** the separate preview players are gone. Every preview now opens or records the real view.
  - **Speed:** about 2 ms a frame on the M2.
  - **Still weak:**
    - Recorded videos have no sound.
    - Walks play in place.
    - Some old benches were rewritten but not re-run end to end.
  - Screenshots are in `checkpoint-phase10/timeline/`.
- **Step 3a, looks, towns and the UI kit in the view: merged.** 236 tests, 235 pass. The one failure is a headless Chrome check on the speech bubble that times out under load and passes on its own (4/4). The view builds.
  - **Looks:** sliders for exposure, white balance, contrast, saturation, fog, sun and lamps. Letting go of a slider makes one step with a note like "warmer: 6200 K → 5600 K". "Show me three" gives three grades side by side with a pick card.
  - **Towns:** click a building to select it by its stable id. Say "flat roof, two storeys taller" and it becomes one fix. Landmarks can be swapped from the inspector.
  - **UI kit:** the HUD draws over the scene in a phone or desktop frame. Click a button to point at it. The contrast, overflow and tap-size checks update live.
  - Screenshots are in `checkpoint-phase10/rest-a/`.
  - **Still weak:**
    - Only a 27-building cut of the town has been tried in the view.
    - Fog washes out the overview camera.
    - "Show me three" only varies the grade.
    - Godot honours only text size and colour from the per-button UI settings.
- **Step 3b, town life and trailers in the view: merged.** That finishes Phase 10.
  - **Day clock:** a day strip on the timeline runs 00:00–24:00 and plays up to 600× speed. It charts how many people are out.
  - **People:** click a person to see their plan for the day. Type "go to the café at 9 instead" and it becomes one step, nobody else's day changes, and the 13 day checks re-run (13/13 pass).
  - **Trailers:** a trailer's shots sit on a shots track with beat marks and play through each shot's camera. Each shot has Keep, Redo (only that shot changes) and "show me three": orbit, push in and crane up, 37–46% apart. Your pick goes into the taste file.
  - Screenshots are in `checkpoint-phase10/rest-b/`.
  - **Still weak:**
    - People are simple stand-ins and look like dots from the overview.
    - The trailer was framed for the full town, but the view only has the 27-building cut.
    - Beat marks are a steady grid; the final cut uses the detected beats.
