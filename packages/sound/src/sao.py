"""Stable Audio Open Small (Stability AI Community License) for foley and textures, run locally.

Needs, in ~/.studio-tools/venv:  pip install stable-audio-tools
and the weights (gated on Hugging Face: you accept Stability's licence with your own account, then
`hf auth login` and `hf download stabilityai/stable-audio-open-small` into
~/.studio-tools/models/stable-audio-open-small).

usage: python sao.py --prompt "..." --seconds 6 --seed 1 --out file.wav [--steps 8]
"""
import argparse
import json
import os
import sys

MODEL_DIR = os.path.expanduser(os.environ.get("STUDIO_SAO_DIR", "~/.studio-tools/models/stable-audio-open-small"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seconds", type=float, default=6)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cfg = os.path.join(MODEL_DIR, "model_config.json")
    ckpt = os.path.join(MODEL_DIR, "model.safetensors")
    if not (os.path.exists(cfg) and os.path.exists(ckpt)):
        print(json.dumps({"ok": False, "error": f"no weights in {MODEL_DIR}"}))
        sys.exit(2)
    import torch
    import torchaudio
    from stable_audio_tools.models.factory import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    with open(cfg) as f:
        config = json.load(f)
    model = create_model_from_config(config)
    model.load_state_dict(load_ckpt_state_dict(ckpt))
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = model.to(device).eval()
    sr = config["sample_rate"]
    seconds = min(a.seconds, 11.0)
    out = generate_diffusion_cond(
        model, steps=a.steps, cfg_scale=1.0, sampler_type="pingpong",
        conditioning=[{"prompt": a.prompt, "seconds_total": seconds}],
        sample_size=config["sample_size"], seed=a.seed, device=device,
    )
    audio = out[0][:, : int(seconds * sr)].to(torch.float32).cpu()
    audio = audio / max(1e-6, float(audio.abs().max())) * 0.9
    torchaudio.save(a.out, audio, sr)
    print(json.dumps({"ok": True, "file": a.out, "seconds": seconds, "device": device, "sampleRate": sr}))


if __name__ == "__main__":
    main()
