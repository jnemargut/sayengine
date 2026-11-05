# Pocket Raleigh checkpoint, part 4: the 30 s trailer (Phase 4 week 14, Decisions 32 and 31)

Made by the reel module (`packages/reel/`, `studio reel …`, skill `/reel`) from one reel file: `games/pocket-raleigh/reel/trailer.json` (10 takes + an edit track + an end card). **Re-run with `sh checkpoint-pocket-raleigh/reel/recut.sh`** (`… recut.sh cut` to re-cut only) — that's the plan once the life module (folk, cars, a bus) merges.

## Files

- `trailer-16x9.mp4` (1920×1080), `trailer-1x1.mp4` (1080×1080), `trailer-9x16.mp4` (1080×1920) — 30.03 s each, 30 fps, AAC music.
- `sheet-*.jpg` — the middle frame of every shot per shape; `stills/<shape>/` the same at full size. `storyboard.jpg` — first/middle/last frame of every captured take (square).
- `recipe-*.sh` + `filter-*.txt` — **the final edit as ffmpeg recipes**: trim each shot from its take, crop that shape's box, scale, concat, the title/caption PNGs over their shots, fades, music. Running one re-renders that shape without Godot.
- `trailer-cut.json` — shots on the beat grid, cut timing vs detected beats, warnings.
- `music.m4a`, `music.png` (waveform + spectrogram), `music-plan.json`, `music.license`, `beats.json` (librosa's grid).
- `release.json`, `CREDITS.md`, `REUSE.toml` — the release check.

## How it was made

1. **Music:** seed `pocket-raleigh-trailer`, mood night, 128 bpm (16 bars = 30 s): A minor, i–III–VII–VI seeded stems (`music-plan.json`) arranged as intro (pad + arp, 4 bars) → build (+ bass, hats, 4) → **drop at 15.0 s** (riser into it, a hit on it, full kit + lead, 6) → end (2, hit on the end card, the chord rings out). −14.9 LUFS, true peak −1.2 dBFS.
2. **Beats:** librosa 1.0 in `~/.studio-tools/venv` found 128.07 bpm after regularisation (raw 129.2); it found no beats in the percussion-free intro, so cuts there sit on the steady grid it implies. Cuts vs the nearest detected beat: 9 of 10 cuts within **14 ms** (median 5 ms); the grid is ~36 ms behind the true one (librosa's frame latency) — about one frame.
3. **Capture:** Godot 4.7.2 movie mode (`--write-movie … --fixed-fps 30`), one run per take with its look (day toy / neon night: the take's look.json is put in place before the game starts and its LUT strip swapped in), **1920×1920 square frames** (an `override.cfg` sets the viewport for the run), ~20–48 s per take, 10 takes. Every shape is a crop of the same frames: 16:9 and 9:16 at native 1080p.
4. **Cut:** 10 shots of 8/8/8/4/4 beats (day) and 4/4/4/4/8 (night) + an 8-beat end card. Titles/captions are PNGs drawn by headless Chrome (this ffmpeg has no drawtext); captions sit inside the 9:16 safe box.
5. **Release check (Decision 31):** 66 sampled frames OCR'd on the Mac (Apple Vision via a small Swift helper) against the brand/team/wording lists plus `games/pocket-raleigh/proof/release-lists.json` (requires "OpenStreetMap" and "Overture" to be readable; allows the landmark names as places). **0 findings**: the end-card ODbL credit was read in the video. Music licence present.

Web fixed-step capture works too (`--engine web`): see "Web" below.

## Honest verdict

**What works:** it reads as a real little trailer. Gameplay-place in the first second, the title over the street, a clear day half and a hard switch to neon night on the drop at 15 s (the "Day toy. Neon night." card lands on the hit), captions that say what's real and what's invented, the lit-window aerial as the closer, and a legible ODbL credit. Cuts land on the beat. The three shapes are cropped sensibly; the vertical one keeps the towers.

**What's weak:**
- **It's a flyover of an empty town.** No people, cars, bus or movement in the world — every shot is a camera move over a static diorama. That is the biggest gap and the reason for the re-cut after the life module.
- **No game-play.** Decision 32's craft rule says gameplay in the first seconds; Pocket Raleigh has nothing to play yet, so this is a place trailer.
- Camera moves are hand-placed keys checked on a storyboard (two takes were reframed after a wall and a tree filled the frame); some are still plain (twin aerial shows the edge of the world slab; the night skyline shot floats the town over blue).
- The night look has no bloom, so "neon" is lit windows on a navy sky; it reads, but it's flat.
- Titles are plain (system font, a scrim) — fine, not designed.
- The music: see the sound README's verdict — tidy, in key, structured (you can see intro/build/riser/drop/end in `music.png`), but generic synth. I could not listen to it.
- Encodes are large (36 MB for the 16:9) at CRF 22 on noisy 1080p; fine for review, not a store upload.
