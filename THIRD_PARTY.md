# Third-party voice and lip-sync components

All local and free; nothing calls a paid or hosted service. (Libraries the studio already used, such as three.js, Manifold, esbuild and xatlas, are listed in `package.json`.)

| Component | Used for | Licence | How it arrives |
|---|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (ONNX build `onnx-community/Kokoro-82M-v1.0-ONNX`, q8) | Local text-to-speech for `studio say` when no recording is given. Voices such as `bm_george` (the default), `bm_lewis`, `am_michael` and `af_heart` ship with the model under the same licence. | Apache-2.0 | Model weights download from Hugging Face on first use (~90 MB), cached by transformers.js |
| [kokoro-js](https://www.npmjs.com/package/kokoro-js) 1.2.x | JavaScript runtime for Kokoro | Apache-2.0 | npm (optional dependency: without it, `say` needs `--audio`) |
| [phonemizer](https://www.npmjs.com/package/phonemizer) 1.2.x (also a kokoro-js dependency) | Text → phonemes for Kokoro, and for `studio say`, which turns the line's phonemes into all 15 speech shapes (TH, K, CH, R, N/L… not just Rhubarb's 9 mouth shapes) | Apache-2.0 package. It contains a WebAssembly build of **eSpeak NG, which is GPL-3.0**. | npm, through kokoro-js |
| onnxruntime-node / onnxruntime-web (kokoro-js dependencies) | Runs the model | MIT | npm |
| [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) 1.14.0 | Aligns line audio with its script into mouth shapes | MIT (it bundles PocketSphinx, BSD-style) | Release zip downloaded on the first `say` into `~/.cache/ai3d-studio` (or `STUDIO_TOOLS_DIR`); the MIT licence file is checked before use. `RHUBARB_BIN` points at a local copy instead |
| [opentype.js](https://github.com/opentypejs/opentype.js) 2.0.0 | Reads font outlines for the `text` op | MIT | npm |
| [Roboto](https://fonts.google.com/specimen/Roboto) Bold, via [@fontsource/roboto](https://fontsource.org/fonts/roboto) 5.3.x | The letters of the `text` op (turned into geometry for printing and models) | OFL-1.1 (font) / MIT (package) | npm |
| [Bambu Studio](https://github.com/bambulab/BambuStudio) (installed by you, not bundled) | `studio print` calls its command line to build and slice A1 mini projects, and opens the result in it | AGPL-3.0 (run as a separate program; nothing is linked or shipped) | Your own install at `/Applications/BambuStudio.app` (`BAMBU_STUDIO_APP` overrides) |

**About eSpeak NG (GPL-3.0).** It runs only on this machine: inside kokoro-js, to make test and placeholder voices, and in `studio say`, to turn a line's text into phonemes (only phoneme symbols come out; nothing from eSpeak is stored or exported). The studio doesn't link or ship it. Generated audio is output, not a derivative of eSpeak, but before shipping a game whose dialogue was voiced this way, check that with your own counsel, or record the lines and pass `--audio`.

## Sound and reel (Phase 4, Decisions 32–33)

| Component | Used for | Licence | How it arrives |
|---|---|---|---|
| [librosa](https://librosa.org) 1.0 (+ numba, soundfile) | Beat detection for reel cuts and beat-cut loops (`studio sound beats`, `studio reel music`). A separate tool: never shipped inside a game | ISC (librosa), BSD-2 (numba), BSD-3 (soundfile) | `~/.studio-tools/venv/bin/pip install librosa soundfile` |
| [Stable Audio Open Small](https://huggingface.co/stabilityai/stable-audio-open-small) (optional, **not installed**) | Foley and textures from text, ≤ 11 s (`studio sound sao`) | **Stability AI Community License** (checked 2026-11-05): free incl. commercial use while you and affiliates make < US$1M a year; commercial users must register with Stability; you own the outputs; distributing the model or a product using it needs a copy of the licence, a "Notice" file and "Powered by Stability AI" | Gated on Hugging Face: you accept the licence with your own account, then `hf auth login` + `hf download`. The studio never accepts it for you. Outputs get `LicenseRef-Stability-AI-Community` sidecars with the attribution line |
| [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) (optional, not installed) | Runs the model | MIT | `pip install stable-audio-tools` |
| CC0 recordings from [OpenGameArt](https://opengameart.org) (catalogue in `packages/sound/src/library.ts`): Fire Crackling (AntumDeluge), Fireplace Sound loop (PagDev), Hammer on Anvil (themightyglider), Blacksmith's Hammer (VishwaJai), Park ambiences (Thimras), High traffic road sounds (IgnasD), Mild Wind Background Noise (Bashar3A) | Ambience beds and foley | CC0-1.0 (per each work's page) | Fetched once into `~/.studio-tools/sound-library`; each file used in a pack gets a sidecar naming the work, author and page; credits list them as a courtesy |
| Apple Vision (`VNRecognizeTextRequest`) via a 30-line Swift helper | On-Mac OCR for release checks | part of macOS | Compiled once with `swiftc` into `~/.studio-tools/bin/studio-ocr-<hash>`; tesseract (Apache-2.0) is the fallback if installed |

The synth, beds and seeded stems are the studio's own code; what they render belongs to the game (packs default to CC0-1.0, set `licence`/`owner` in the spec). Meta's AudioCraft/MusicGen/AudioGen, MMAudio, AudioLDM2 and TangoFlux weights are non-commercial and are not used (a MusicGen cache found on this Mac is ignored).
