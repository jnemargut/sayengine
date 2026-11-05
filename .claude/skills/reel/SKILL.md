---
name: reel
description: Make trailers and short clips from a game itself — a reel file (takes with camera moves, a look and a crop box per shape, plus an edit track cut to the music's beats), captured with Godot's movie mode or the web build at a fixed step, rendered to 16:9, 1:1 and 9:16 through ffmpeg recipes, with release checks (on-Mac OCR against brand, team and wording lists, credits, REUSE). Use for /reel, or when the user asks for a trailer, teaser, reel, clip, flythrough video, vertical/square version, or a re-cut.
---

# /reel — trailers are cutscene files, cut to the beat (Decision 32)

> **Working together** (decisions 61–64): before proposing, read `./studio taste` and `./studio notes`. Give each step its word note (`--why "warmer"`), point at moments with addresses, and end each proposal with a "your call" card of at most 3 asks. Overnight work never waits on an ask. See [../studio/working-together.md](../studio/working-together.md).

The user's request: **$ARGUMENTS**

A reel file lives in the game: `games/<game>/reel/<id>.json` (example: `games/pocket-raleigh/reel/trailer.json`).
- `takes`: `{id, look (day-toy | neon-night | null), seconds (longer than any cut: handles), fov (of the square frame; 70 ≈ 43° in a 16:9 crop), keys [{position, target}], crop {"16:9"|"1:1"|"9:16": {x, y, zoom}}}`
- `edit`: `[{take, beats, in, caption?, title?: {text, sub}}]`, `endCard {beats, title, sub, credit}`
- `music`: generated (`seed`, `mood`, `bpm`, `sections` with `riser`/`hit`) or `file`.

Craft: gameplay/the place in the first seconds, a hook by 10–15 s (the drop), cuts on beats, 8 beats for establishing shots and 4 in the drop. Keep captions inside the 9:16 safe box. Put the open-data credit on the end card (ODbL produced work).

## Steps (`./studio reel <cmd> --project <game>`)
1. `music` — the track + its beats (librosa, `~/.studio-tools/venv`). Read `music.png`.
2. `capture [--takes a,b]` — Godot movie mode at a fixed fps, square frames (`size`, default 1440). **Read the storyboard** and fix framing (walls, trees in front, empty sky) by editing keys, then re-capture only those takes. `--engine web --size 480` captures the web build at a fixed step (software GL: slow; use for parity checks).
3. `cut --out <folder>` — all three shapes; `recipe-*.sh` are the ffmpeg recipes. **Read the sheets.** A re-cut (swap shots, lengths, captions, another track) is: edit the reel file, run `cut` again — no capture.
4. `release --out <folder>` — OCR + word lists (+ the game's `proof/release-lists.json` with `allow`/`required`), sound licences, `CREDITS.md`, `REUSE.toml`. Brand hits on real landmarks are expected in a real town: allow the exact names you mean to show, don't hide the finding.

Never claim a trailer "looks great" from the numbers: say what the stills show, and what you couldn't check (pacing feel, the music's taste).
