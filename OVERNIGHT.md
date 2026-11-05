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
