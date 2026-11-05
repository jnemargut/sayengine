#!/bin/sh
# Re-make the Pocket Raleigh trailer from the reel file (games/pocket-raleigh/reel/trailer.json).
# After the life module merges (folk, cars, a bus), re-capture so the takes show them; the cut, the
# music and the recipes are unchanged. Run from the repo root. ~6 min capture + ~4 min cut on an M2.
#   sh checkpoint-pocket-raleigh/reel/recut.sh            # everything
#   sh checkpoint-pocket-raleigh/reel/recut.sh cut        # only re-cut (after editing the edit track)
set -e
OUT=checkpoint-pocket-raleigh/reel
if [ "$1" != "cut" ]; then
  ./studio reel music   --project pocket-raleigh
  ./studio reel capture --project pocket-raleigh        # Godot movie mode, every take; Read the storyboard
fi
./studio reel cut     --project pocket-raleigh --out "$OUT"
./studio reel release --project pocket-raleigh --out "$OUT"
