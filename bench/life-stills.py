#!/usr/bin/env python3
"""Copy the town-life stills of both engines into the checkpoint and build the Godot-vs-web sheet
(each row: Godot left, web right).  python3 bench/life-stills.py <godot dir> <web dir> <out dir>"""
import os, shutil, subprocess, sys

god, web, out = (os.path.abspath(a) for a in sys.argv[1:4])
names = sorted(f[:-9] for f in os.listdir(god) if f.endswith('-0000.png') and not f.startswith('video-'))
for eng, d in (('godot', god), ('web', web)):
    os.makedirs(os.path.join(out, 'stills', eng), exist_ok=True)
    for n in names:
        src = os.path.join(d, f'{n}-0000.png')
        if os.path.exists(src):
            shutil.copy(src, os.path.join(out, 'stills', eng, f'{n}.png'))
rows = [n for n in names if os.path.exists(os.path.join(web, f'{n}-0000.png'))]
args, filt = [], []
for i, n in enumerate(rows):
    args += ['-i', os.path.join(god, f'{n}-0000.png'), '-i', os.path.join(web, f'{n}-0000.png')]
    filt.append(f'[{2 * i}][{2 * i + 1}]hstack=2,scale=1280:-2[r{i}]')
filt.append(''.join(f'[r{i}]' for i in range(len(rows))) + f'vstack={len(rows)}')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args, '-filter_complex', ';'.join(filt), os.path.join(out, 'godot-vs-web-sheet.png')], check=True)
print('stills:', ', '.join(rows))
