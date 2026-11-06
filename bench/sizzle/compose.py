"""Compose the README sizzle reel: a fake console types each prompt, the studio's view shows the result.

Usage: python3 bench/sizzle/compose.py <beats.json> <out-dir>
beats.json: [{"prompt": "...", "reply": ["..."], "clip": "path.mp4", "start": 0.0, "seconds": 2.6, "crop": [x, y, w, h]?}]
Writes <out-dir>/frames/%04d.png at FPS; make the GIF with make-gif.sh.
"""
import json, os, subprocess, sys, shutil, tempfile
from PIL import Image, ImageDraw, ImageFont

FPS = 12
W = 960
PAD = 16
TERM_W = 330
ED_X = PAD + TERM_W + 12
ED_W = W - ED_X - PAD
TOP = 44  # title area
VIEW_H = round((ED_W - 2) * 9 / 16)
H = TOP + 30 + VIEW_H + 1 + PAD
BG = (14, 15, 18)
PANEL = (24, 26, 31)
EDGE = (52, 56, 64)
INK = (226, 228, 232)
DIM = (120, 126, 138)
ACCENT = (232, 168, 106)  # warm, like the studio's "you" lines
OK = (126, 200, 150)

MONO = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13)
MONO_B = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13, index=1)
SANS = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 15)
SANS_S = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)


def wrap(text, font, width):
    words, lines, cur = text.split(" "), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if font.getlength(t) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def extract(clip, start, seconds, crop, size, tmp, patch=None, padc="0xFAFAF9"):
    os.makedirs(tmp, exist_ok=True)
    vf = []
    for x, y, w, h in patch or []:
        vf.append(f"drawbox=x={x}:y={y}:w={w}:h={h}:color={padc}:t=fill")
    if crop:
        x, y, w, h = crop
        vf.append(f"crop={w}:{h}:{x}:{y}")
    vf.append(f"fps={FPS}")
    vf.append(f"scale={size[0]}:{size[1]}:force_original_aspect_ratio=decrease:flags=lanczos")
    vf.append(f"pad={size[0]}:{size[1]}:(ow-iw)/2:(oh-ih)/2:color={padc}")
    args = ["ffmpeg", "-v", "error", "-y"]
    if clip.lower().endswith((".png", ".jpg")):
        args += ["-loop", "1", "-t", str(seconds), "-i", clip]
    else:
        args += ["-ss", str(start), "-t", str(seconds), "-i", clip]
    subprocess.run(args + ["-vf", ",".join(vf), os.path.join(tmp, "%04d.png")], check=True)
    return sorted(os.path.join(tmp, f) for f in os.listdir(tmp))


def window(d, box, title):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, 10, fill=PANEL, outline=EDGE)
    for i, c in enumerate([(236, 106, 94), (244, 191, 79), (98, 197, 84)]):
        d.ellipse((x0 + 12 + i * 16, y0 + 10, x0 + 22 + i * 16, y0 + 20), fill=c)
    d.text((x0 + 70, y0 + 8), title, font=SANS_S, fill=DIM)


def main():
    beats = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    fdir = os.path.join(out, "frames")
    shutil.rmtree(fdir, ignore_errors=True)
    os.makedirs(fdir)
    ed_box = (ED_X, TOP, ED_X + ED_W, H - PAD)
    view_size = (ED_W - 2, VIEW_H)
    term_box = (PAD, TOP, PAD + TERM_W, H - PAD)
    history = []  # (lines, color) already printed
    n = 0
    last_view = None
    tmp = tempfile.mkdtemp()
    for bi, b in enumerate(beats):
        frames = extract(b["clip"], b.get("start", 0), b["seconds"], b.get("crop"), view_size, os.path.join(tmp, str(bi)), b.get("patch"), b.get("pad", "0xFAFAF9"))
        type_s = b.get("type", min(0.6, 0.015 * len(b["prompt"]) + 0.15))
        total = int(round(b["seconds"] * FPS))
        type_f = int(type_s * FPS)
        for f in range(total + type_f):
            img = Image.new("RGB", (W, H), BG)
            d = ImageDraw.Draw(img)
            d.text((PAD, 12), "SayEngine", font=SANS, fill=INK)
            d.text((PAD + SANS.getlength("SayEngine") + 10, 15), "you type, it builds, you watch and keep", font=SANS_S, fill=DIM)
            window(d, term_box, "claude")
            window(d, ed_box, "studio view - localhost:4517")
            # console: history (dimmed), then the current prompt typing, then the reply
            lines = []
            for hl in history:
                lines.extend(hl)
            typed = b["prompt"][: int(len(b["prompt"]) * min(1, f / max(1, type_f)))]
            cur = [(l, ACCENT if i == 0 else ACCENT) for i, l in enumerate(wrap("> " + typed + ("▌" if f < type_f or (f // 6) % 2 == 0 else ""), MONO_B, TERM_W - 28))]
            reply = []
            if f >= type_f + 3:
                for r in b.get("reply", []):
                    reply += [(l, OK if r.startswith("✓") else DIM) for l in wrap(r, MONO, TERM_W - 28)]
                reply = reply[: max(0, (f - type_f - 3) // 3 + 1)]
            allines = lines + cur + reply
            lh = 18
            maxl = (term_box[3] - term_box[1] - 40) // lh
            allines = allines[-maxl:]
            y = term_box[1] + 32
            for text, col in allines:
                d.text((term_box[0] + 14, y), text, font=MONO_B if col == ACCENT else MONO, fill=col)
                y += lh
            # editor: previous result until the prompt is sent, then this beat's clip
            if f >= type_f:
                k = min(len(frames) - 1, f - type_f)
                last_view = Image.open(frames[k]).convert("RGB")
            if last_view is not None:
                img.paste(last_view, (ed_box[0] + 1, ed_box[1] + 29))
            else:
                d.text((ed_box[0] + 20, ed_box[1] + 60), "waiting for a prompt…", font=SANS_S, fill=DIM)
            img.save(os.path.join(fdir, f"{n:04d}.png"))
            n += 1
        history.append([(l, (150, 118, 88)) for l in wrap("> " + b["prompt"], MONO, TERM_W - 28)]
                       + [(l, (84, 120, 96) if r.startswith("✓") else (80, 84, 92)) for r in b.get("reply", [])[-1:] for l in wrap(r, MONO, TERM_W - 28)]
                       + [("", DIM)])
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{n} frames, {n / FPS:.1f} s")


main()
