# Phase 8 bench proofs: animate anything

Things that aren't people (and one person tripping), each built from rig parts with the real CLI and daemon, checked, then rendered by `creature-preview --video true` or `motion-preview --video true` (headless Chrome, frame by frame).

Regenerate with `node bench/creatures.ts <task …>`. With no argument it runs every task: crab, spider, octopus, bird, fish, windmill, snake, car, trip. The key moments Claude wrote for the actions are in `bench/actions/*.json`.

| Folder | What it shows |
|---|---|
| `crab/` | The crab after its craft pass: an oval shell, claws that pinch, eyes on stalks, tapered legs on a tripod gait, a whip tail. Plays the sideways walk, idle, a live steered walk over bumps, then a walk replayed 1.6× too fast, where the timeline turns red. |
| `spider/` | Eight tapered legs on alternating tetrapods, plus an abdomen and pedipalps. Walk, idle and a live walk. |
| `octopus/` | Idle (arms curl), then **"the octopus pours tea"**: a one-off action from 15 key moments. It reaches, grips, lifts, tips, pours (the stream shows), tilts back, sets down and lets go. The second arm steadies the cup. Then a live segment where an arm follows a moving yellow goal through the runtime. There is a still for every key moment. |
| `octopus-noted/` | The same action after `action-note "slower, more weight"` and `"hold the pour longer"`. |
| `bird/` | Folded idle, then the flight cycle (four beats, then a glide, from the wing's proportions), a glide and a hover. |
| `bird-takeoff/` | **"The bird takes off, flies and lands"**: crouch, wings open, jump (the feet push off until they can't reach), climb, fly, glide, descend, flare, touch down, fold. |
| `fish/`, `eel/` | Carangiform and anguilliform swimming (travelling body waves), with fins. |
| `windmill/` | Sails turning with shader grass, then **"the windmill creaks to a stop"** (keyed rpm with stick-slip creak and a heavy settle). |
| `trip/` | **"Make him trip over the bucket"**: a kit humanoid (Tom, the blacksmith preset) catches his toe, lurches with his arms flung out, takes a catch step, steps around the bucket, steadies, and looks back. |
| `snake/`, `car/` | From weeks 13–14, unchanged. |

Each folder also holds `stills/` (three per loop segment, one per key moment for actions) and `creature.glb` (a node per bone, a clip per motion). The strip at the bottom right of each frame is the check timeline: one row per check across the clip's frames, red where it fails, with the playhead as a black bar.
