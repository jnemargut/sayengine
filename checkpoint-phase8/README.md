# Phase 8 bench proofs: animate anything

Four things that aren't people, each one built from rig parts with the real CLI and daemon. Each is checked and then rendered by `creature-preview --video true` (headless Chrome, frame by frame).

To regenerate one, run `node bench/creatures.ts crab` (or `snake`, `car`, `windmill`). With no argument it runs all four.

| Folder | What it shows |
|---|---|
| `crab/robot-crab.mp4` | The six-legged robot crab: tripod gait, a whip tail and spring antennae. It plays in this order: the baked sideways walk, idle, a live steered walk over bumps from the TypeScript runtime (feet step when they fall out of reach), then the walk replayed 1.6× too fast. In that last part the timeline turns red where the feet slide. |
| `snake/snake.mp4` | Serpentine slither. The body follows its own path, and the belly slides only along itself. |
| `car/little-car.mp4` | Wheels roll at ground speed over a bumpy road (whole wheel turns per road loop). The body pitches and bounces on damped springs, and the aerial lags behind. Then a live segment steers over bumps. |
| `windmill/windmill.mp4` | Sails spin at 15 rpm, and the cap swings within its ±15° limit. The grass sways using shader sway, with two fields of blades bent in the vertex shader. |

Each folder also holds:
- `stills/`: three frames per segment
- `creature.glb`: a node per bone and a clip per motion. It passes the glTF validator and imports into Godot 4.7.2 with no warnings.
- `*.sway.gdshader`: the windmill's grass shader for Godot

The strip at the bottom right of each frame is the check timeline. There is one row per check across the clip's frames. A row is green where the check passes and red where it fails, and the black bar is the playhead.
