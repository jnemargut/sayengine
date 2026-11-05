# Pocket Raleigh, part 2: life (Phase 4 weeks 12–13)

A seeded Saturday in autumn, market day, 10:36 am, on Fayetteville St and in the river twin. Both engines play the same baked day: Godot 4.7.2 with the GDScript runtime and the web (three.js) with the TypeScript one.

## What's here

- `saturday-godot.mp4`, `saturday-web.mp4`, `saturday-godot-vs-web.mp4` (side by side): four 6–8 s shots.
  1. The Raleigh dog walker (Faro and Biscuit) along a sidewalk, with a car passing.
  2. A walker on the twin's sidewalk.
  3. The bus on its loop.
  4. A walker on Fayetteville St past a signal.
- `stills/godot/` and `stills/web/`: the same shots in each engine.
  - A bench sitter with the dog sitting at his feet.
  - Market stalls on the plaza and on the green.
  - Two anglers with rods on a pier.
  - Folk walking, the bus and a car.
  - The shared walk mesh drawn as a blue overlay (`walk-mesh-*`).
- `godot-vs-web-sheet.png`: every still, Godot left and web right. They match pose for pose, because the two runtimes agree to 1e-12 m.
- `life-report.json`: bake stats, the headless-day checks and the parity result.

Regenerate:

```sh
sh bench/life-cast.sh
sh bench/life-export.sh
sh bench/life-export-vehicles.sh
node bench/life.ts
node bench/life-shots.ts > bench/life-shots.json
```

Then capture with `games/pocket-raleigh/game/life_capture.gd` and `bench/life-web-capture.ts`, and encode with `bench/life-video.py` and `bench/life-stills.py`.

## Numbers

- **Places:** 113 benches, 10 market stalls, 2 piers with rods, 3 bus stops, 2 parks and about 90 doors.
- **Walk mesh and lanes:** about 3,000 walk nodes, 86 crossings, 257 car-lane edges and 21 signals.
- **The day:** 170 folk drawn from 8 studio characters on 5 body plans, 2 dog walkers and about 425 outings. 17 cars make about 2,700 trips, and the bus runs a loop with 3 stops.
- **Parity (D30's tripwire, 0.5 m):** worst **5.6e-13 m** over 1,307 positions in 120 s, with no visibility mismatch.
- **Headless hour (9:30–10:30, scripted player):** 9 of 13 checks pass.
  - Pass: no overlaps, nobody inside a building, no car hits, no car-on-car, no red-light runs, the leash, one sitter per seat, cars brake for the player.
  - Fail: folk stay on the walk (353 samples), one pop of 0.59 m, gridlock (9 vehicles held more than 150 s) and folk making room for the player (2 samples).

## How it looks (honest)

**Alive in places, robotic in others: a quiet toy town on a slow Saturday morning, not a bustling one.**

What works:
- Faro walking Biscuit on the leash down a sidewalk while a car passes is the best moment. It reads as a life, not a test.
- The sitter on the bench with his dog sitting at his feet, and the two anglers on the pier with rods and lines over the water, both read immediately. The places do their job.
- Folk keep right and pass each other. Cars stop at the lines, the signal heads change colour, and the bus pulls along its loop.
- Both engines show the same moment, frame for frame.

What's robotic or weak:
- **Thin on screen.** About 50 folk are out across two towns, so most frames hold 1–3 people.
- **The stalls look stiff.** Stall keepers and browsers stand frozen in a held pose.
- **Movement is mechanical.** Walkers stick close to the sidewalk centre lines at near-equal speeds, and there are no glances, chats or idle variety.
- **Folk pop in and out at building doors.** There's no door to open.
- **The vehicles are rigid.** They are static meshes (the wheels don't turn), and the cars look the same apart from their colour.
- **The market framing is poor.** The Raleigh stalls stand near the plaza's edge by the buildings rather than in a lively cluster.
- **The follow cameras pass through trees.**
- **The headless day is not green** (see Numbers). A full 24 hours on the final code hasn't been re-run.
