#!/bin/zsh
# Frames from compose.py → an optimised GIF (one shared palette, light dithering).
#   bench/sizzle/make-gif.sh <out-dir> <out.gif> [width]
set -euo pipefail
DIR=$1; OUT=$2; WIDTH=${3:-960}
FPS=12
ffmpeg -v error -y -framerate $FPS -i "$DIR/frames/%04d.png" \
  -vf "scale=$WIDTH:-1:flags=lanczos,palettegen=max_colors=160:stats_mode=diff" "$DIR/palette.png"
ffmpeg -v error -y -framerate $FPS -i "$DIR/frames/%04d.png" -i "$DIR/palette.png" \
  -lavfi "scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$OUT"
ls -lh "$OUT"
