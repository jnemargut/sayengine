# Third-party voice and lip-sync components

All local and free; nothing calls a paid or hosted service. (Libraries the studio already used, such as three.js, Manifold, esbuild and xatlas, are listed in `package.json`.)

| Component | Used for | Licence | How it arrives |
|---|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (ONNX build `onnx-community/Kokoro-82M-v1.0-ONNX`, q8) | Local text-to-speech for `studio say` when no recording is given. Voices such as `bm_george` (the default), `bm_lewis`, `am_michael` and `af_heart` ship with the model under the same licence. | Apache-2.0 | Model weights download from Hugging Face on first use (~90 MB), cached by transformers.js |
| [kokoro-js](https://www.npmjs.com/package/kokoro-js) 1.2.x | JavaScript runtime for Kokoro | Apache-2.0 | npm (optional dependency: without it, `say` needs `--audio`) |
| [phonemizer](https://www.npmjs.com/package/phonemizer) 1.2.x (also a kokoro-js dependency) | Text → phonemes for Kokoro, and for `studio say`, which turns the line's phonemes into all 15 speech shapes (TH, K, CH, R, N/L… not just Rhubarb's 9 mouth shapes) | Apache-2.0 package. It contains a WebAssembly build of **eSpeak NG, which is GPL-3.0**. | npm, through kokoro-js |
| onnxruntime-node / onnxruntime-web (kokoro-js dependencies) | Runs the model | MIT | npm |
| [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) 1.14.0 | Aligns line audio with its script into mouth shapes | MIT (it bundles PocketSphinx, BSD-style) | Release zip downloaded on the first `say` into `~/.cache/ai3d-studio` (or `STUDIO_TOOLS_DIR`); the MIT licence file is checked before use. `RHUBARB_BIN` points at a local copy instead |

**About eSpeak NG (GPL-3.0).** It runs only on this machine: inside kokoro-js, to make test and placeholder voices, and in `studio say`, to turn a line's text into phonemes (only phoneme symbols come out; nothing from eSpeak is stored or exported). The studio doesn't link or ship it. Generated audio is output, not a derivative of eSpeak, but before shipping a game whose dialogue was voiced this way, check that with your own counsel, or record the lines and pass `--audio`.
