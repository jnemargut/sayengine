"""FLIP picture diffs for the proof module (Decision 31), batched: one Python start for every pair.

Reads a JSON list of {ref, test, heatmap} on stdin and prints a JSON list of
{mean, p95, over (share of pixels with FLIP > 0.1), size} per pair. Uses NVIDIA's flip-evaluator
(BSD-3, `pip install flip-evaluator`), local and free. Run with `python -I`.
"""
import json
import sys

import numpy as np
import flip_evaluator as flip
from PIL import Image


def main() -> None:
    pairs = json.load(sys.stdin)
    out = []
    for p in pairs:
        try:
            ref = Image.open(p["ref"]).convert("RGB")
            test = Image.open(p["test"]).convert("RGB")
            if ref.size != test.size:
                out.append({"error": f"sizes differ: {ref.size} vs {test.size}"})
                continue
            r = np.asarray(ref, dtype=np.float32) / 255.0
            t = np.asarray(test, dtype=np.float32) / 255.0
            err, mean, _ = flip.evaluate(r, t, "LDR")
            e = np.asarray(err).reshape(r.shape[0], r.shape[1], -1)[:, :, 0]
            res = {"mean": round(float(mean), 5), "p95": round(float(np.percentile(e, 95)), 5), "over": round(float((e > 0.1).mean()), 5), "size": list(ref.size)}
            if p.get("heatmap"):
                heat = np.zeros((e.shape[0], e.shape[1], 3), dtype=np.uint8)
                v = np.clip(e * 4.0, 0, 1)
                heat[:, :, 0] = (255 * v).astype(np.uint8)
                heat[:, :, 1] = (255 * (1 - np.abs(v - 0.5) * 2) * (v > 0.02)).astype(np.uint8)
                heat[:, :, 2] = (90 * (1 - v)).astype(np.uint8)
                Image.fromarray(heat).save(p["heatmap"])
                res["heatmap"] = p["heatmap"]
            out.append(res)
        except Exception as ex:  # noqa: BLE001 - reported per pair
            out.append({"error": str(ex)})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
