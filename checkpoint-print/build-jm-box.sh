#!/bin/bash
# The printing proof: "/studio make a box with a sliding lid and my initials JM on top, and a hole
# for an M3 screw", then print it. Run from the repo root (./studio talks to the project's daemon).
set -e
S=./studio
$S new-object --name "JM box" --type box --material pla --color "#d8cfc0"
$S set-print-profile --object jm-box --printer a1-mini
$S set-params --object jm-box --values '{"W":0.06,"D":0.04,"H":0.03,"t":0.002,"lidT":0.002,"rail":0.001,"rim":0.0012}' --label "60 x 40 x 30 mm box, 2 mm walls, 2 mm sliding lid"
$S add-op --object jm-box --id shell --op roundedBox --part box --args '{"size":["$W","$H","$D"],"r":0.0015,"at":[0,"$H/2",0]}'
$S add-op --object jm-box --id cavity --op box --output false --args '{"size":["$W - 2*$t","$H","$D - 2*$t"],"at":[0,"$t + $H/2",0]}'
# the lid runs in a groove cut 1 mm into the side and back walls, open at the front, with $fitSlide of play
$S add-op --object jm-box --id groove --op box --output false --args '{"size":["$W - 2*$t + 2*$rail","$lidT + 2*$fitSlide","$D - $t + $rail + 0.002"],"at":[0,"$H - $rim - $lidT/2 - $fitSlide","$t/2 - $rail/2 + 0.001"]}'
$S add-op --object jm-box --id screw --op hole --output false --args '{"size":"M3","kind":"clearance","depth":"$t","at":[0,"$t",0]}'
$S add-op --object jm-box --id body --op difference --inputs '["shell","cavity","groove","screw"]' --output false
# the lid lies beside the box, flat, with a finger grip and the initials raised 0.8 mm
$S add-op --object jm-box --id lidPlate --op box --part lid --output false --args '{"size":["$W - 2*$t + 2*$rail - 2*$fitSlide","$lidT","$D - $t + $rail - $fitSlide"],"at":["$W/2 + 0.012 + ($W - 2*$t + 2*$rail)/2","$lidT/2",0]}'
$S add-op --object jm-box --id grip --op box --part lid --output false --args '{"size":[0.012,0.0012,0.002],"at":["$W/2 + 0.012 + ($W - 2*$t + 2*$rail)/2","$lidT + 0.0005","($D - $t + $rail - $fitSlide)/2 - 0.003"]}'
$S add-op --object jm-box --id initials --op text --part initials --output false --args '{"text":"JM","size":0.012,"depth":0.0008,"at":["$W/2 + 0.012 + ($W - 2*$t + 2*$rail)/2","$lidT - 0.0001",-0.002]}'
$S add-op --object jm-box --id lid --op union --inputs '["lidPlate","grip","initials"]' --output false
$S add-op --object jm-box --id kit --op union --inputs '["body","lid"]' --output true
$S check --object jm-box
$S print --object jm-box
