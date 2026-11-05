#!/bin/sh
# Export the Pocket Raleigh cast (bench/life-cast.sh) for both engines: one GLB per body plan / vehicle,
# at the origin facing +Z. Characters get baked textures (the studio view must be open:
# bench/studio-view-headless.ts keeps one open); vehicles keep per-part materials (--bake false). All in one
# daemon session: the evaluator's cache now keys creatures by their definition, so a second vehicle no longer
# comes out with the first one's body. Then bench/life-slim.ts slims every GLB (no face shapes, quantized
# vertices, still channels to one key) and gives the vehicles wheel nodes the engines turn and steer.
#   sh bench/life-export.sh [ids…]        (STUDIO_DIR / STUDIO_PORT pick the cast project and its daemon)
S=${STUDIO_BIN:-./studio}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
G="$ROOT/games/pocket-raleigh/assets/studio/life"
W="$ROOT/games/pocket-raleigh-web/assets/studio/life"
mkdir -p "$G" "$W"
IDS=${*:-"folk-ada folk-bert folk-cleo folk-dev folk-esme folk-faro folk-gwen folk-hal dog-biscuit car-red car-blue car-cream car-green city-bus"}
for id in $IDS; do
  case "$id" in
    car-*|city-bus) flags="--bake false" ;;
    *) flags="--texture 256" ;;
  esac
  out=$("$S" export --object "$id" --target godot --atOrigin true $flags --out "$G/$id.glb" 2>&1)
  case "$out" in
    *'"ok": true'*) cp "$G/$id.glb" "$W/$id.glb"; echo "ok   $id $(wc -c < "$G/$id.glb") bytes" ;;
    *) echo "FAIL $id: $(echo "$out" | grep '"error"' | cut -c1-240)" ;;
  esac
done
node "$ROOT/bench/life-slim.ts"
