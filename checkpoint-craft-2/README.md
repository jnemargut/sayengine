# Creature craft pass 2

Before and after, same cameras. "Before" is `main` at 4b22d0f (the Phase 8 bench and the face round); "after" is branch `phase8/creature-craft`.

| Sheet | What changed |
|---|---|
| `bird-idle.png`, `bird-idle-close.png` | The folded wing is a teardrop of overlapping feathers: tapered, curved, cambered feathers in two colour bands, on bones that pivot as the wing folds, so the primaries stack along the hand instead of fanning out as spikes. A feathered tail fan and scapulars. |
| `bird-fly.png`, `bird-glide.png` | Spread, the same rows (coverts, secondaries, a fan of six primaries, an alula) read as a feathered wing. The fan half-closes on the upstroke. |
| `spider-walk.png`, `spider-idle.png` | Legs in segments (femur, bowed tibia, metatarsus) with knuckles, pale joint bands and bristles, mid-brown against the darker body and the light floor, knees high above the body. |
| `octopus-grip.png`, `octopus-grip-close.png`, `octopus-pour.png` | The arm curls round the teapot handle (a coil solve on its last, shorter segments) and uncurls after it lets go. The pot rides the coil's centre, so "held props stay in the grip" passes. |
| `fish-swim.png` | No ridges where the tail's segments meet. |
| `kid-faceted.png`, `kid-smooth.png` | A curved smile with thickness: the lips and opening are built in slices so the resting smile bends smoothly, the lower lip is fuller, the mouth narrower, and the corners get a short dimple instead of a long crease. |
| `dog-faceted.png`, `dog-smooth.png` | A tapered haunch and upper arm with mass, a thicker forearm, broad padded paws. |
| `faces/before|after/{faceted,smooth}/faces.png` | The whole cast's faces, to check the other mouths didn't change. `checks.txt` lists every check per character. |

`after/` holds the bench videos (`node bench/creatures.ts spider octopus bird fish --out …`) and their stills.
