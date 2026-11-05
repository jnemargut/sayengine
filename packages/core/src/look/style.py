# The look's local style score (Decision 29): DINOv2-small (facebook/dinov2-small, Apache-2.0, ~90 MB,
# downloaded once to the Hugging Face cache, then fully offline) embeds each picture; the score is the
# cosine similarity between a render and each reference picture (CLS token + mean of the patch tokens).
# Free and local: run with ~/.studio-tools/venv (pip install torch transformers pillow).
# stdin: {"items": [{"image": "a.png", "refs": ["r1.png", ...]}]}  stdout: [{"image", "scores": [...], "mean"}]
import json, sys, os
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel

MODEL = os.environ.get("STUDIO_STYLE_MODEL", "facebook/dinov2-small")

def main():
    req = json.load(sys.stdin)
    proc = AutoImageProcessor.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL).eval()
    cache = {}
    def emb(path):
        if path in cache:
            return cache[path]
        im = Image.open(path).convert("RGB")
        with torch.no_grad():
            out = model(**proc(images=im, return_tensors="pt")).last_hidden_state[0]
        v = torch.cat([out[0], out[1:].mean(0)])
        v = v / v.norm()
        cache[path] = v
        return v
    res = []
    for it in req["items"]:
        a = emb(it["image"])
        scores = [round(float((a * emb(r)).sum()), 4) for r in it.get("refs", [])]
        res.append({"image": it["image"], "scores": scores, "mean": round(sum(scores) / len(scores), 4) if scores else None})
    json.dump(res, sys.stdout)

if __name__ == "__main__":
    main()
