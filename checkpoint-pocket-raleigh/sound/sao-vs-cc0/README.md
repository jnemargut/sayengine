# Stable Audio Open Small vs CC0 recordings

Forge sounds for Fire's Dying. The `sao-*` files were made on this Mac by Stable Audio Open Small (seed 7, 8 steps, on the GPU, about 2 s each after a ~1 min model load). The `cc0-*` files are the CC0 recordings the game uses now.

| Sound | Stable Audio prompt | CC0 counterpart |
|---|---|---|
| `sao-hammer.wav` | blacksmith hammer striking hot steel on an anvil, three ringing clangs, close up, dry room | `cc0-hammer-on-anvil.wav` |
| `sao-forge.wav` | roaring coal forge fire, deep whoosh and crackle, steady loop | `cc0-fireplace-loop.wav` |
| `sao-crackle.wav` | small wood fire crackling, close, cozy | `cc0-fire-crackling.wav` |
| `sao-quench.wav` | red hot steel quenched in a bucket of water, violent sizzle and hiss | (none: the game uses a synth hiss) |
| `sao-bellows.wav` | old leather bellows pumped twice, airy whoosh, wooden creak | (none: the game uses a synth whoosh) |

Loudness differs between files (the generated ones are normalised to peak −0.9 dBFS), so judge character, not volume.

Licence: the generated sounds are outputs of Stable Audio Open Small under the Stability AI Community License (free under US$1M a year in revenue; register with Stability for commercial use). Credit "Powered by Stability AI". The CC0 files keep their own `licence.json` in `~/.studio-tools/sound-library`.

Make more: `./studio sound sao --prompt "…" --seconds 4 --seed 1 --out file.wav` (up to 11 s).
