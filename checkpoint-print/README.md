# Printing path checkpoint (Decisions 43–46)

The request: *"/studio make a box with a sliding lid and my initials JM on top, and a hole for an M3 screw"*, then print it on a Bambu Lab A1 mini.

| File | What it is |
|---|---|
| `jm-box.3mf` | The Bambu Studio project `studio print` wrote: printer **Bambu Lab A1 mini 0.4 nozzle**, process **0.20mm Standard @BBL A1M**, filament **Bambu PLA Basic @BBL A1M - Copy** (your preset), two objects (`JM box box`, `JM box lid`) arranged on the plate. Background slice: about 34 min, 22 g of PLA, 150 layers, one plate. |
| `jm-box-hero.png`, `jm-box-top.png` | Presentation renders: the box (60 × 40 × 30 mm, 2 mm walls, a groove for the lid, an M3 clearance hole in the floor) and the 2 mm lid lying beside it with "JM" raised 0.8 mm and a finger grip. From above the initials read the right way round. |
| `fit-test.3mf`, `fit-test-top.png` | The fit-test coupon: five 6 mm holes, 0.10 / 0.15 / 0.20 / 0.30 / 0.40 mm gap per side, numbered 1–5, and a 6 mm pin. About 12 min, 4 g. |
| `build-jm-box.sh` | The exact `studio` calls that built and printed the box. |

All 8 checks pass on the box: watertight, nothing below the floor, 2 pieces each resting on the bed, fits the 180 mm bed, sealed, walls ≥ 0.84 mm (the rounded rim's sharp edge is noted, not failed), overhangs (4.7 cm² of groove ceiling: short spans that bridge), 43 cm² of base.

To print: open `jm-box.3mf` in Bambu Studio (or run `./studio print --object jm-box`, which opens it), look over the plate, press Print.
