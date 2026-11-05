# Pocket Raleigh checkpoint, part 3: sound (Phase 4 week 13, Decision 33)

The sound module (`packages/sound/`, `studio sound …`, skill `/sound`) proven on **Fire's Dying**, whose web build now has a full sound pass.

## What's here

- `fires-dying/fires-dying-sound-pass.mp4` — 75 s of the play-test bot playing the web build (fixed steps, 15 fps of real game time) with the sound pass under it. The audio is the game's own pack mixed offline from a trace of what the runtime was told (the fire value, the music's intensity, each event), using the same curves, smoothing and ladder as `studio/sound.ts` — headless Chrome can't record its own audio output.
- `fires-dying/session.m4a`, `session.png` (waveform + spectrogram), `session.json` (events, the intensity over time, loudness).
- `stems-fires-dying/level0–3.m4a` + `.png` — the seeded stems (seed `fires-dying`, mood forge: E♭ minor, 96 bpm, i–iv–VI–V, 8-bar loop) at each rung of the intensity ladder: calm (pad, arp) → + bass, hats → + beat → + lead.
- The pack itself: `games/fires-dying/assets/studio/sound/` (built from `games/fires-dying/sound/sound-spec.json`; 24 WAVs (32 kHz, ≈ 15 MB), each with a `.license` sidecar; `sound.json`; `CREDITS.md`).

## The sound pass

| Layer / event | Source | Behaviour |
|---|---|---|
| forge roar | procedural bed (brown noise, body resonance, gusts), seed `fires-dying` | gain 0.04→1 and low-pass 260→2600 Hz follow the fire |
| fire crackle | CC0: "Fireplace Sound loop" by PagDev (OpenGameArt), cut to a 10 s crossfaded loop | gain and low-pass follow the fire |
| yard | CC0: "Park ambiences (wind)" by Thimras | a quiet constant bed |
| hammer clinks | synth `clink` × 4 seeds (inharmonic anvil modes), ±3 % pitch | on every strike impact (the sparks' motion trigger) |
| pickup / deliver / wrong / fed / pumped / quench | synth (sfxr pickup, chime, buzz, thud, bellows puff, steam hiss) | on the game's events |
| music | seeded stems + won/lost stings | intensity = 0.2 + low fire + a waiting smith + progress; stings on the next bar |

Numbers for the 75 s session: −19.3 LUFS integrated, LRA 6.6 LU, true peak −1.6 dBFS, no clipping; energy split low 43 % / mid 51 % / high 7 %. Over the session the intensity moved 0.2 → 0.72 (fire down to 0.27) → back to 0.45 after a feed; 6 clinks, 7 pickups, 5 deliveries, 1 feed, 1 pump, 1 quench.

## Honest verdict on the music (D33's "unproven" half)

I can't hear. What I can say from the numbers and pictures:
- **It is musically correct and tidy:** every note is in key (tested), the minor V is raised so cadences pull home, chords are voice-led, loops are exact to the sample and seamless (seam check ≤ 1.3 for tonal stems), the ladder is monotonic in loudness, the mix isn't clipped or mud (low/mid/high ≈ 33/51/16 % at full intensity).
- **It will sound like a competent synth demo loop, not a composed score.** Six PolyBLEP saws, sines and noise drums through simple filters and a Freeverb; one 8-bar loop with a seeded 2-bar motif. Expect "pleasant lo-fi chiptune / synthwave background", repetitive after a minute or two, with no real instruments, no dynamics within a phrase, and a melody that is plausible rather than memorable. That matches the risk Decision 33 named ("seeded stems may sound like background loops").
- **The adaptive part works mechanically** in both engines (tested in Godot headless and in Chrome): stems stay sample-locked and fade by intensity over ~2 s.
- **Tripwire:** listen to `stems-fires-dying/level3.m4a` and the sound-pass video. If you'd mute it, D33's tiebreaker applies: try a song model for music only (ACE-Step, licence permitting).

## Stable Audio Open Small: not run (honest)

`./studio sound sao` reports what blocks it on this Mac:
1. **Gated weights.** You must accept the Stability AI Community License on Hugging Face with your own account; I won't do that for you.
2. `stable-audio-tools` isn't installed (and pins older torch; likely its own venv).
3. **Disk:** 4 GB free on the home disk; weights + T5 + packages need ≈ 3–4 GB.

It is **not** too heavy for the 8 GB M2 in memory terms (≈ 341 M-parameter DiT + autoencoder + T5-base ≈ 2 GB fp32). The runner (`packages/sound/src/sao.py`) and licence handling are written but untested end to end. Licence (checked 2026-11-05): free including commercial use under US$1M annual revenue; register with Stability for commercial use; outputs are yours; products using the model need the Notice + "Powered by Stability AI". Recorded in `THIRD_PARTY.md`. **Fallback used:** CC0 recordings from OpenGameArt, cached in `~/.studio-tools/sound-library`, credited per file, plus the procedural beds.

## Re-run
`./studio sound pack --project fires-dying` then `node games/fires-dying/sound/session.ts 75`.
