"""Beat detection for the reel and the loop cutter (Decisions 32-33): librosa (ISC licence) in the studio's
own venv (~/.studio-tools/venv). A separate tool: never shipped inside a game.

usage: python beats.py <audio file> [--bpm-hint N]
prints JSON: {bpm, beats: [s...], downbeats: [s...], onsets: [s...], duration}
"""
import json
import sys

import numpy as np
import librosa


def main():
    path = sys.argv[1]
    hint = None
    if "--bpm-hint" in sys.argv:
        hint = float(sys.argv[sys.argv.index("--bpm-hint") + 1])
    y, sr = librosa.load(path, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr)
    kw = {"start_bpm": hint} if hint else {}
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=sr, units="frames", **kw)
    beats = librosa.frames_to_time(frames, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    # downbeats: of the four phases, the one whose beats carry the most low-end onset energy
    low = librosa.onset.onset_strength(y=y, sr=sr, fmax=200, n_mels=32)
    strength = [float(np.mean([low[f] for f in frames[p::4]])) if len(frames[p::4]) else 0.0 for p in range(4)]
    phase = int(np.argmax(strength)) if len(frames) >= 4 else 0
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time")
    print(json.dumps({
        "bpm": round(bpm, 2),
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in beats[phase::4]],
        "downbeatPhase": phase,
        "onsets": [round(float(t), 4) for t in onsets],
        "duration": round(float(len(y) / sr), 4),
        "tool": f"librosa {librosa.__version__}",
    }))


if __name__ == "__main__":
    main()
