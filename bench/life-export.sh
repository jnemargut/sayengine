#!/bin/sh
# Export the Pocket Raleigh cast (bench/life-cast.sh) for both engines: one GLB per body plan / vehicle,
# at the origin facing +Z, baked textures (the studio view must be open). The Godot export (checked by a
# Godot round-trip) is shared with the web build: characters and vehicles carry no engine-specific nodes.
#   sh bench/life-export.sh [ids…]
S=./studio
ROOT=$(pwd)
G="$ROOT/games/pocket-raleigh/assets/studio/life"
W="$ROOT/games/pocket-raleigh-web/assets/studio/life"
mkdir -p "$G" "$W"
IDS=${*:-"folk-ada folk-bert folk-cleo folk-dev folk-esme folk-faro folk-gwen folk-hal dog-biscuit car-red car-blue car-cream car-green city-bus"}
for id in $IDS; do
  out=$("$S" export --object "$id" --target godot --atOrigin true --texture 256 --out "$G/$id.glb" 2>&1)
  case "$out" in
    *'"ok": true'*) cp "$G/$id.glb" "$W/$id.glb"; echo "ok   $id $(wc -c < "$G/$id.glb") bytes" ;;
    *) echo "FAIL $id: $(echo "$out" | grep '"error"' | cut -c1-240)" ;;
  esac
done
