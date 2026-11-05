#!/bin/sh
# Export the wheel-rig vehicles one per fresh daemon (the evaluator caches a creature's mesh by its op,
# which every creature shares, so a second creature in one session comes out with the first one's body).
# Per-part materials (no texture bake): the vehicles are flat-coloured parts anyway.
S=./studio
ROOT=$(pwd)
G="$ROOT/games/pocket-raleigh/assets/studio/life"
W="$ROOT/games/pocket-raleigh-web/assets/studio/life"
for id in ${*:-car-red car-blue car-cream car-green city-bus}; do
  "$S" stop > /dev/null 2>&1
  out=$("$S" export --object "$id" --target godot --atOrigin true --bake false --out "$G/$id.glb" 2>&1)
  case "$out" in
    *'"ok": true'*) cp "$G/$id.glb" "$W/$id.glb"; echo "ok   $id $(wc -c < "$G/$id.glb") bytes" ;;
    *) echo "FAIL $id: $(echo "$out" | grep '"error"' | cut -c1-240)" ;;
  esac
done
