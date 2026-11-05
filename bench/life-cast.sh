#!/bin/sh
# The Pocket Raleigh cast (Phase 4 week 12): studio characters and vehicles for the life module, built
# through the studio's own tools. Run from the repo root with a fresh .studio (STUDIO_PORT picks the daemon).
#   sh bench/life-cast.sh
set -e
S=./studio
q() { "$S" "$@" > /dev/null || { echo "failed: $*"; exit 1; }; }

# the towns (weeks 9-10)
q world-town --name "Pocket Raleigh" --source real --area raleigh-city-plaza --style raleigh-downtown
q world-town --name "River Twin" --source invented --seed 7 --description "mill town on a river, 1920s, 3 blocks" --offset '[380,0,0]'

# the player
q new-character --name Walker --preset apprentice --position '[3,0,30]'
q set-motion --object walker --id walk --speed 1.4 --energy 0.65
q set-motion --object walker --id idle --energy 0.5
q move-object --object walker --position '[3,0,30]' --rotation 180

# folk: body plans and looks drawn wide (no look-alikes), parked out of town
x=-60
folk() {
  id=$1; shift
  q new-character --id "$id" --position "[$x,0,-330]" "$@"
  q set-motion --object "$id" --id walk --kind walk --speed 1.3
  q set-motion --object "$id" --id idle --kind idle
  x=$((x + 6))
}
folk folk-ada   --name Ada  --preset default --shirt '#c8463a' --trousers '#2f3a4a' --skin '#e0b08a' --hairColor '#2a1d16' --hair bun
folk folk-bert  --name Bert --preset elder
folk folk-cleo  --name Cleo --preset kid
folk folk-dev   --name Dev  --preset blacksmith --shirt '#3f6b3a' --trousers '#4a4034' --skin '#8d5a3b'
folk folk-esme  --name Esme --plan human --height 1.68 --build 0.3 --skin '#f1c6a2' --shirt '#9fc7d9' --trousers '#7a6a8a' --hairColor '#d9b56a'
folk folk-faro  --name Faro --plan human --height 1.86 --build 0.65 --skin '#6b4630' --hairColor '#1a1a1a' --shirt '#e07a2a' --trousers '#2f3a4a'
folk folk-gwen  --name Gwen --plan lanky --height 1.76 --build 0.25 --skin '#c58c62' --shirt '#2f6f9f' --trousers '#3e352c' --hairColor '#5a3a22'
folk folk-hal   --name Hal  --preset elder --skin '#a8724c' --shirt '#3a5a40' --hairColor '#cfc8ba'
# held poses for the smart places: sit (benches), fish (piers), look-around (stalls)
for id in folk-ada folk-bert folk-dev folk-esme folk-faro folk-gwen folk-hal; do
  q set-motion --object "$id" --id sit --kind action --action sit
  q set-motion --object "$id" --id fish --kind action --action fish
  q set-motion --object "$id" --id browse --kind action --action look-around
done
q set-motion --object folk-cleo --id browse --kind action --action look-around
q set-motion --object folk-cleo --id fish --kind action --action fish

# the dog
q new-character --id dog-biscuit --name Biscuit --preset dog --position "[$x,0,-330]"

# vehicles from the wheel rig parts: four cars and a bus (full size, metres)
car() {
  id=$1; name=$2; col=$3; x2=$4
  q new-creature --id "$id" --name "$name" --position "[$x2,0,-345]" --parts "[
    {\"kind\":\"body\",\"shape\":\"box\",\"size\":[1.78,0.62,4.25],\"height\":0.62,\"color\":\"$col\"},
    {\"kind\":\"wheels\",\"id\":\"wheels\",\"axles\":[{\"z\":1.32,\"track\":1.56,\"r\":0.33,\"w\":0.24},{\"z\":-1.32,\"track\":1.56,\"r\":0.33,\"w\":0.24}],\"ride\":0.3,\"travel\":0.08,\"hz\":1.5,\"damp\":0.55,\"color\":\"#23252a\",\"hub\":\"#c9c2b4\"},
    {\"kind\":\"hinge\",\"id\":\"cabin\",\"at\":[0,0.93,-0.2],\"axis\":[1,0,0],\"shapes\":[
      {\"shape\":{\"kind\":\"box\",\"c\":[0,1.18,-0.25],\"size\":[1.6,0.5,2.2]},\"color\":\"#e9e2d4\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0,1.2,0.86],\"size\":[1.46,0.38,0.05]},\"color\":\"#9ec7dd\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0,1.2,-1.36],\"size\":[1.4,0.34,0.05]},\"color\":\"#9ec7dd\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0.81,1.2,-0.25],\"size\":[0.04,0.34,1.9]},\"color\":\"#9ec7dd\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[-0.81,1.2,-0.25],\"size\":[0.04,0.34,1.9]},\"color\":\"#9ec7dd\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0.6,0.72,2.13],\"size\":[0.3,0.14,0.04]},\"color\":\"#f4e7b2\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[-0.6,0.72,2.13],\"size\":[0.3,0.14,0.04]},\"color\":\"#f4e7b2\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0.62,0.72,-2.13],\"size\":[0.26,0.12,0.04]},\"color\":\"#b8382c\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[-0.62,0.72,-2.13],\"size\":[0.26,0.12,0.04]},\"color\":\"#b8382c\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0,0.42,2.15],\"size\":[1.82,0.12,0.12]},\"color\":\"#cfc8ba\"},
      {\"shape\":{\"kind\":\"box\",\"c\":[0,0.42,-2.15],\"size\":[1.82,0.12,0.12]},\"color\":\"#cfc8ba\"}],
     \"motion\":{\"kind\":\"still\"},\"limit\":{\"min\":-2,\"max\":2}}]" --motions '{"drive":{"kind":"drive","speed":8},"idle":{"kind":"still"}}'
}
car car-red   "Red Car"   '#b8382c' -60
car car-blue  "Blue Car"  '#2f6f9f' -54
car car-cream "Cream Car" '#e6d8b0' -48
car car-green "Green Car" '#3f6b3a' -42
q new-creature --id city-bus --name "City Bus" --position '[-30,0,-345]' --parts '[
  {"kind":"body","shape":"box","size":[2.5,2.3,10.4],"height":1.55,"color":"#d9a03a"},
  {"kind":"wheels","id":"wheels","axles":[{"z":3.6,"track":2.2,"r":0.48,"w":0.3},{"z":-3.4,"track":2.2,"r":0.48,"w":0.3}],"ride":0.55,"travel":0.06,"hz":1.2,"damp":0.6,"color":"#23252a","hub":"#c9c2b4"},
  {"kind":"hinge","id":"trim","at":[0,1.5,0],"axis":[1,0,0],"shapes":[
    {"shape":{"kind":"box","c":[0,1.95,0],"size":[2.54,0.75,9.6]},"color":"#9ec7dd"},
    {"shape":{"kind":"box","c":[0,2.75,0],"size":[2.4,0.1,10.2]},"color":"#efe6d2"},
    {"shape":{"kind":"box","c":[0,1.95,5.2],"size":[2.2,0.9,0.05]},"color":"#9ec7dd"},
    {"shape":{"kind":"box","c":[0,0.95,5.2],"size":[2.3,0.5,0.06]},"color":"#2f3a4a"},
    {"shape":{"kind":"box","c":[0.85,0.9,5.22],"size":[0.3,0.16,0.04]},"color":"#f4e7b2"},
    {"shape":{"kind":"box","c":[-0.85,0.9,5.22],"size":[0.3,0.16,0.04]},"color":"#f4e7b2"},
    {"shape":{"kind":"box","c":[1.26,1.2,2.6],"size":[0.04,1.7,1.1]},"color":"#2f3a4a"}],
   "motion":{"kind":"still"},"limit":{"min":-2,"max":2}}]' --motions '{"drive":{"kind":"drive","speed":7},"idle":{"kind":"still"}}'
echo "cast ready"
