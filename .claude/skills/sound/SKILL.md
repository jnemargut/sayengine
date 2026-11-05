---
name: sound
description: Give a game its sound — seeded synth game sounds (clinks, pickups, hits, steam, risers), ambience beds that follow game values (a fire's roar), CC0 library recordings cached and credited, seeded music stems that adapt to the action (Godot AudioStreamInteractive/Synchronized and a web runtime), beat-cut loops, a licence on every file and a credits list; listen through loudness numbers and spectrograms. Use for /sound, or when the user asks for sound effects, ambience, music, an adaptive soundtrack, audio credits or "make it sound like…".
---

# /sound — layered sound (Decision 33)

The user's request: **$ARGUMENTS**

Every command is `./studio sound <cmd>` (JSON out, no daemon). The right source for each kind of sound:

| Kind | Source | Command |
|---|---|---|
| UI, hits, pickups, clinks, steam, puffs, risers | synth: `kind + seed` (same samples everywhere) | `sound sfx --kind clink --seed strike-1` |
| Beds (forge roar, crackle, room, city hum, wind) | procedural seamless loops | `sound bed --kind forge-roar` |
| Real recordings (fire, wind, traffic, anvils) | CC0 library (OpenGameArt pages that say CC0) | `sound library --search fire`, `sound fetch --id …` |
| Foley/textures no CC0 recording covers | Stable Audio Open Small, local | `sound sao --prompt "…" --seconds 4 --seed 1`; in a pack, an event's `sao: [{prompt, seed, seconds}]` |

**Which source, by default:** a good CC0 recording first (the user found Stable Audio's results about equal to CC0 ones, and CC0 needs no licence or credit line). If no recording fits, generate it with Stable Audio Open Small (quench hiss, bellows, odd one-offs nobody recorded). Use the synth for UI blips, clinks, risers and anything that must vary by seed. In a pack, give a `sao` event synth `sounds` too: if the model can't run on a machine, the pack falls back to them and the report says so. A game that ships Stable Audio sounds must show "Powered by Stability AI" somewhere players see it (Fire's Dying puts it on the title card); CREDITS.md lists it automatically.
| Music | seeded stems: pad, arp, bass, hats, beat, lead | `sound stems --seed … --mood warm` |

## A game's sound pack

Write `games/<game>/sound/sound-spec.json` (see `games/fires-dying/sound/sound-spec.json`): `values`, `layers` (`bed` or `library`, `follow: {value, gain:[lo,hi], lowpass:[lo,hi]}`), `events` (variations + pitch spread), `music` (`seed`, `mood`, `value` = the intensity, `stings`). Then `./studio sound pack --project <game>` writes `assets/studio/sound/` (WAV + `<file>.license` each, `sound.json`, `CREDITS.md`) and the runtime:
- web: `const snd = await startSound(game)` from `studio/sound.ts`; `snd.setValue('fire', v)`, `snd.event('strike')`, `snd.endMusic('won')`. Audio unlocks on the first tap/key.
- Godot: `var snd = preload("res://studio/sound.gd").start(self)`; `set_value`, `event`, `end_music`.

Intensity 0..1 walks the ladder: calm (pad, arp) → + bass, hats → + beat → + lead; stems glide (~2 s), stings land on the next bar.

## Listen before you say it sounds good

`./studio sound listen --file x.wav [--loop]` → LUFS, true peak, clipping, band split, silences, loop seam, and a waveform + spectrogram PNG: **Read it**. For a game, render real play: `node games/fires-dying/sound/session.ts` (bot play + the pack mixed offline exactly as the runtime plays it, under the video). You cannot hear: say what the numbers and pictures show and what they can't (taste, "does the melody stick").

## Licences (don't skip)
- Every file gets a sidecar; `./studio sound credits --dir …` fails on any file without one.
- Never add a sound whose licence you can't name. Non-commercial models (MusicGen, AudioGen, MMAudio, AudioLDM2, TangoFlux) are out.
- Stable Audio Open Small: Stability AI Community License (free under US$1M revenue; register for commercial use; "Powered by Stability AI"). The user must accept it on Hugging Face themselves.
