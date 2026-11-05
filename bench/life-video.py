#!/usr/bin/env python3
"""Encode the town-life frame sequences (bench/life-web-capture.ts, games/pocket-raleigh/game/life_capture.gd)
into the checkpoint videos: one MP4 per engine (the shots back to back) and a side-by-side of the two.
  python3 bench/life-video.py <godot frames dir> <web frames dir> <out dir>"""
import os, subprocess, sys

god, web, out = (os.path.abspath(a) for a in sys.argv[1:4])
os.makedirs(out, exist_ok=True)
shots = sorted({f.rsplit('-', 1)[0] for f in os.listdir(god) if f.startswith('video-') and f.endswith('.png')})
def run(args):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)
for eng, d in (('godot', god), ('web', web)):
    parts = []
    for s in shots:
        p = os.path.join(out, f'.{eng}-{s}.mp4')
        run(['-framerate', '30', '-i', os.path.join(d, f'{s}-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', p])
        parts.append(p)
    lst = os.path.join(out, f'.{eng}-list.txt')
    with open(lst, 'w') as f:
        f.write(''.join(f"file '{p}'\n" for p in parts))
    run(['-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', os.path.join(out, f'saturday-{eng}.mp4')])
    for p in parts + [lst]:
        os.remove(p)
run(['-i', os.path.join(out, 'saturday-godot.mp4'), '-i', os.path.join(out, 'saturday-web.mp4'), '-filter_complex',
     '[0]scale=960:-2[a];[1]scale=960:-2[b];[a][b]hstack=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', os.path.join(out, 'saturday-godot-vs-web.mp4')])
print('videos:', ', '.join(sorted(f for f in os.listdir(out) if f.endswith('.mp4'))))
