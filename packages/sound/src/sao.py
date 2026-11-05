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
    ckpt = next((p for p in (os.path.join(MODEL_DIR, n) for n in ("model.safetensors", "model.ckpt")) if os.path.exists(p)), None)
    if not (os.path.exists(cfg) and ckpt):
        print(json.dumps({"ok": False, "error": f"no weights in {MODEL_DIR}"}))
        sys.exit(2)
    import torch
    try:
        import torchaudio  # noqa: F401
    except ImportError:
        # torchaudio has no build for every torch release. stable-audio-tools only uses it to resample
        # input audio, which text-to-audio never does, so a stand-in for this process is enough.
        import types
        ta = types.ModuleType("torchaudio")
        tf = types.ModuleType("torchaudio.transforms")

        class Resample(torch.nn.Module):
            def __init__(self, *a, **k):
                raise RuntimeError("resampling needs torchaudio, which is not installed")
        tf.Resample = Resample
        ta.transforms = tf
        import importlib.machinery
        ta.__spec__ = importlib.machinery.ModuleSpec("torchaudio", None)
        tf.__spec__ = importlib.machinery.ModuleSpec("torchaudio.transforms", None)
        ta.__version__ = "0.0-stub"
        sys.modules["torchaudio"], sys.modules["torchaudio.transforms"] = ta, tf
    import soundfile
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
    soundfile.write(a.out, audio.numpy().T, sr, subtype="PCM_16")
    print(json.dumps({"ok": True, "file": a.out, "seconds": seconds, "device": device, "sampleRate": sr}))


if __name__ == "__main__":
    main()
