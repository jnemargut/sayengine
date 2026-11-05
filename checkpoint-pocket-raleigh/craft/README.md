# Pocket Raleigh, part 3: the craft pass (Phase 4)

Fayetteville St now ends in its two real landmarks: the **NC State Capitol** at Union Square to the north and the **Duke Energy Center for the Performing Arts** to the south. The night is a real night: sodium and LED street light pools on the ground, shops spill light onto the sidewalk, and every light glows, in Godot 4.7.2 and in three.js. Both games are `games/pocket-raleigh` (Godot) and `games/pocket-raleigh-web` (three.js).

## What is here

- `eye-level-sheet.png`: Fayetteville St at eye level, both looks and both engines. The columns are day toy in Godot, day toy on the web, neon night in Godot, neon night on the web. The rows, top to bottom: looking north from City Plaza towards the Capitol, the Capitol close up from the head of the street, looking south towards the PAC, and the PAC close up from its plaza.
- `stills/day-toy/` and `stills/neon-night/`: all 14 pinned views, per engine, at full size (`godot-<view>.png`, `web-<view>.png`). Each folder's `parity.json` has the Godot-vs-web FLIP for every view.
- `ab/`: the night A/B sheets. A is on the left, B on the right. The picks are in `picks.jsonl`.
- `recipe/`: the scripts that made all of this. Run them from the repo root with a daemon on `STUDIO_PORT` (4660 here).
  - `landmarks.ts`: models the Capitol, the PAC, PNC Plaza and Wells Fargo Capitol Center. The sources are in its header.
  - `neon-night.json`: the final night look. `neon-night-v3.json` and `neon-night-v3.1.json` are the A/B rounds. `day-toy.json` is the day look as it is in the scene.
  - `look-record.ts`: puts a look file into the scene.
  - `quick-look.ts`: writes a look straight into both games, for fast A/B rounds.
  - `render.ts`: imports, renders the views in both engines and works out parity.
  - `fit-glow.ts`: the sweep that fitted the web glow to Godot's.
  - `view-keepalive.ts`: the headless studio view that the import's texture bake needs.
  - `collect.ts`: copies a render run in here.
  - `studio-repo.json`: the studio scene, with history.

## What changed

**Two neighbouring towns.** The Capitol and the PAC lie 180 m and 230 m beyond the old town's edge, so the street needed real blocks to run through. I fetched two more Overture/OSM/USGS areas, `raleigh-union-square` and `raleigh-south-fayetteville`, and built them as the towns "Union Square" and "South Fayetteville". They are offset so their bounding boxes meet the old one exactly.

Two DEM grids never sample alike, and the old town's rules had graded its ground towards its roads. Together these left steps of 0.8–3 m at both seams. A new `seam` option (`world-town --seam "Pocket Raleigh"`) feathers a neighbour's ground over 60 m towards the other town's built ground before the rules run.

To rebuild them:

```
studio world-fetch --name raleigh-union-square --bbox=-78.6413,35.7788,-78.6374,35.7818
studio world-fetch --name raleigh-south-fayetteville --bbox=-78.6413,35.7700,-78.6374,35.7737
studio world-town --name "Union Square" --source real --area raleigh-union-square --offset '[0,8,-447.687]' --seam "Pocket Raleigh"
studio world-town --name "South Fayetteville" --source real --area raleigh-south-fayetteville --offset '[0,-3.3,486.376]' --seam "Pocket Raleigh"
```

The offsets are the shift between bounding-box centres plus the difference between the DEM reference heights.

**The landmarks are modelled from references, not memory** (sources below). Each one is swapped in on its Overture footprint with the landmark fix.
- **NC State Capitol.**
  - A cruciform block of grey-tan gneiss, 42.7 × 48.8 m, over a rusticated ground storey.
  - Three storeys, a Doric entablature and a solid parapet.
  - Tetrastyle Doric porticoes on the east and west fronts only.
  - The south front faces Fayetteville St, so you see it head-on: five bays between antae.
  - The dome sits on an octagonal plinth and two round plinths, and its crown is about 30 m up. The dome is penny-bronze copper, not green, because it was re-clad in 2023–24.
  - The Washington statue stands on the south lawn.
- **Duke Energy Center for the Performing Arts.**
  - Memorial Auditorium's six-column Doric portico stands on the street's axis, in front of a glass outer lobby.
  - The Meymandi and Fletcher wings sit either side, with mullioned glass fronts and metal canopies. The fly tower and the rear theatre are behind.
  - The massing is my estimate, fitted to the 135 × 114 m footprint.
- **PNC Plaza (revised).** It is now "three stacked glass boxes with a metal pyramid on top": blue glass, a precast band at 130–137 m, the pyramid to 151 m and a spire to 164 m. The spire is lit white at night. It replaces the earlier from-memory fins and stepped lantern.
- **Wells Fargo Capitol Center (revised).** It is now a dark rose-brown granite grid over glass, with a mid setback and a **triangular gable** at the top, and an antenna to 122 m. The earlier copper-green hipped roof was wrong: the building has no copper top.

**Night v3** (A/B pick over v2, then v3.1 over v3: `ab/picks.jsonl`).
- The sky is near-black navy (`#0a1019`), not purple.
- The ambient is neutral grey-blue at a quarter of v2's level. Shadows are neutral, with no violet lift or tint.
- Lamp heads are two kinds, chosen per lamp: old sodium (amber `#ffa04a`) and new white LED (`#fff0dc`).
- Shop windows are their own class, lit warm from inside.
- The Capitol and the PAC portico are floodlit (a `flood` class).
- Lit windows are softer than v2's.

**Glow (bloom) in both engines** (`look.bloom`).
- **Godot** uses its Environment glow: additive, with linear upscale. The threshold, softness, intensity and 7 level weights come from the look record.
- **The web** runs a mip chain built after Godot's: Godot's 7-tap gaussian weights, the same smoothstep threshold on the first level, half resolution per level, and the levels added in linear HDR before the pinned transport tonemapper.
- **How it was fitted.** I measured the web's overall gain against fixed Godot frames. A gain of 0.6 gave a mean FLIP of 0.114; for comparison, 0 gave 0.150, 1.0 gave 0.120 and 1.6 gave 0.142.
- **What didn't fit.** Adding the glow after the tonemapper in sRGB was worse (0.17–0.21), and so was a full-resolution first level (0.148).

**Light on the ground.** The town mesh has a new "Light pools" node: flat fans whose vertex colours fall off from the centre. In both engines they are unlit, additive, unfogged and never write depth. Their alpha is 0 in the GLB, so a renderer without the look draws nothing.
- There is a pool under every street lamp, sodium or LED to match the head.
- There is a wider pool under the City Plaza light masts. It is found from the model's `lamp` parts.
- There is a spill strip in front of every lit shopfront. The spill colour varies per shop: warm, neutral, or cool LED.

**Storefronts.** Each street front now gets one of four kinds:
- plate glass;
- a painted frame with a kick plate and transom;
- mullioned panes;
- a recessed door bay.

Fronts also get one of six frame colours and a fabric awning, a flat metal canopy, or neither. Before this, every storefront was the same glass-and-awning bay.

**Smaller and cheaper.** Town meshes are now indexed: identical corners are welded. The scene GLB is 38.6 MB with 462k triangles. Without the welding it was 50.2 MB, over the 40 MB budget.

**Tooling.**
- `STUDIO_WEB_PORT` and `STUDIO_CHROME_SPAN` keep the web server and Chrome inside a fixed port range.
- Chrome may now take up to 40 s to start, because 10 s wasn't enough on a loaded machine.
- The daemon and game test ports can be overridden with `TEST_DAEMON_PORT` and `TEST_GAME_PORT`.

## Sources

- **NC State Capitol.**
  - NRHP nomination: https://npgallery.nps.gov/NRHP/GetAsset/NHLS/70000476_text (plan, porticoes, storeys, antae, dome plinths).
  - https://northcarolinahistory.org/encyclopedia/north-carolina-state-capitol/ (dimensions, gneiss, dome height 97.5 ft).
  - https://en.wikipedia.org/wiki/North_Carolina_State_Capitol (coordinates, south side and the Washington statue).
  - NC DNCR 2024-06-28 reopening release and the N&O/AOL story on the copper replacement (penny copper, 2023–24).
  - NCpedia Union Square: https://www.ncpedia.org/union-square.
  - Overture footprint ov:a50fcb09 (44 × 48 m).
- **Duke Energy Center (now the Martin Marietta Center).**
  - https://en.wikipedia.org/wiki/Raleigh_Memorial_Auditorium (Doric portico on the Fayetteville St axis, facing the Capitol).
  - https://www.martinmariettacenter.com/history (replica columns in front of a glass outer lobby; the wings either side).
  - https://ncarchitects.lib.ncsu.edu/people/P000413.
  - Overture footprint ov:d7a935a6. The column count (six) comes from one photo caption only.
- **PNC Plaza.**
  - https://skyscraperpage.com/b44421 (roof 130 m, pyramid 137–151 m, spire 164 m).
  - https://en.wikipedia.org/wiki/PNC_Plaza_(Raleigh).
  - https://community.dtraleigh.com/t/pnc-plaza-looking-back/483 ("three glass boxes stacked with a metal pyramid on top").
  - https://waltermagazine.com/art-and-culture/spotlight-canes-city/ (the spire is LED-lit, white).
- **Wells Fargo Capitol Center.**
  - https://skyscraperpage.com/b847 (roof 119 m, antenna 122 m, 30 floors).
  - https://community.dtraleigh.com/t/wells-fargo-building/374 (dark brown; no pyramid).
  - LocalWiki as quoted in search results ("triangular gable at the very top"; the page itself was down).
- **Town data.** Overture Maps (ODbL), © OpenStreetMap contributors (ODbL), USGS 3DEP (public domain).

## Parity (Godot vs web, FLIP mean, 14 pinned views)

| view | day toy | neon night |
|---|---|---|
| fayetteville-north | 0.083 | 0.045 |
| fayetteville-south | 0.079 | 0.058 |
| martin-west | 0.085 | 0.036 |
| raleigh-aerial | 0.103 | 0.063 |
| twin-main-street | 0.079 | 0.044 |
| twin-aerial | 0.077 | 0.031 |
| twin-river | 0.110 | 0.027 |
| both-towns | 0.071 | 0.039 |
| city-plaza | 0.088 | **0.121** |
| skyline-south | 0.066 | 0.032 |
| eye-north-capitol (new) | 0.078 | 0.087 |
| eye-south-pac (new) | 0.080 | 0.076 |
| capitol-close (new) | 0.074 | 0.026 |
| pac-close (new) | 0.072 | 0.034 |
| **worst** | **0.110** | **0.121** |

The target was ≤ 0.15, and every view meets it in both looks.

Getting there took four measured fixes:

1. **The glow chain fitted to Godot.** I swept the web's gain against fixed Godot frames:

   | web glow gain | mean FLIP, three night views |
   |---|---|
   | 0 (no glow) | 0.150 |
   | 0.3 | 0.126 |
   | **0.6** | **0.114** |
   | 1.0 | 0.120 |
   | 1.6 | 0.142 |

   Gain 0.6 was best. Two other orders were tested and dropped: adding the glow after the tonemapper in sRGB (0.17–0.21) and a full-resolution first level (0.148).
2. **Pools sat on the road and z-fought it in Godot.** They now float 20 cm above the ground.
3. **Godot reads a material's albedo colour as sRGB.** A pool energy of 0.6 came out as 0.32 in linear light in Godot, but 0.6 on the web. With v3.1 that put fayetteville-south at 0.167. `look.gd` now encodes the linear value once, and that view dropped to 0.058.
4. **Every pool, spill and glow is the same geometry and record in both engines.** Only the glow chain is engine-specific.

What's left: city-plaza is the worst view at 0.121. It has the mast pools and the most glow, and Godot's halo is still a little tighter and brighter at the core than the web's. The rest is shadow filtering and anti-aliasing, as in week 11.

## How it looks from the street (honest)

**It now reads as Raleigh from the head of the street, and only half-reads from City Plaza.**

- **The Capitol close-up** (`capitol-close`, about 130 m out at the top of Fayetteville St) is the best picture this project has made of Raleigh.
  - It shows the pale stone block with its pilastered five-bay south front, the porticoes side-on, and the copper dome on its drum, framed by the street wall and parked cars.
  - By day it is unmistakably the State Capitol at the end of the street. At night it is floodlit cream against a black sky.
  - The dome loses most of its copper at night, because the flood class lights stone and copper alike.
- **Looking north from City Plaza** (`eye-north-capitol`), the Capitol closes the vista, as it does in life. But it is small: about 450 m away and 30 m tall, it fills a few dozen pixels.
  - The light masts, the Wells Fargo slab and the street wall do more of the work of saying "Fayetteville St" than the Capitol does.
  - At night it is a small warm shape at the end of a dark street lined with lamps, which is about right.
- **Looking south** (`eye-south-pac`), the PAC is too far (about 600 m) and too low (about 20 m) to read. It is a pale block at the vanishing point, half-hidden by trees.
  - Close up (`pac-close`), the six-column portico with lit glass behind it reads as Memorial Auditorium.
  - But the wings are plain buff boxes with mullioned glass, so it reads as "a civic auditorium", not specifically the PAC.
- **The night** is a real improvement on v2.
  - It has dark skies, darker facades, and two colours of street light. The shops glow onto the sidewalk and the lamps have halos.
  - Lamp light now lies on the pavement instead of only on the lamp heads.
  - It reads as a city at night, not a blue toy.
- **The street walls are still rule-built.** The new storefront kinds give the ground floor some rhythm, but the upper floors are the same window grids as before.

Overall: from the plaza it is "a downtown that ends at a domed capitol". Someone who knows Raleigh would probably get it. Someone who doesn't would see a generic capitol-at-the-end-of-Main-Street. From the head of the street, it is Raleigh.

## What's weak

- **The vista ends are small.** Real perspective makes the Capitol tiny from City Plaza; a game camera or a slightly taller model would read better. I kept the real distances and heights.
- **The PAC's massing is estimated.** Only the footprint is surveyed, and the six-column count rests on one photo caption. The wings are plain boxes.
- **Pools and glow are not real lights.**
  - Pools are flat additive fans 20 cm off the ground. They don't light walls, trees or cars, and at a grazing angle you can see they float.
  - The mast pools are still a large, even disc.
  - The glow is a screen effect, not light.
- **The big shopfront on the east side of City Plaza is still a white lightbox at night.** The shop class is one energy for every pane: a large single pane saturates.
- **The flood class is one constant warm emission.** It lights the Capitol's copper dome the same as its stone, so the dome nearly vanishes at night.
- **The second A/B pick (v3.1 over v3) was made before the Godot pool-colour fix.** At that time Godot showed v3.1's pools at about half strength. After the fix, Godot's pools are brighter than in that sheet and match the web's. I didn't re-run the A/B.
- **The seams between towns are smooth now, but not invisible.** The neighbouring towns' streets are graded on their own, and Fayetteville St changes width at the north seam (tertiary vs residential in OSM).
- **The day stills were rendered before the pools were lifted 20 cm.** Pools don't draw by day (alpha 0), so the pictures are unaffected.
- **The scene GLB is 38.6 MB, close to the 40 MB budget.** The two new towns doubled the ground and tree count.
- **The phone check (`proof phone`) was not re-run.** There are now about 460k triangles and more transparent geometry (pools), plus a glow chain on the web, so the phone frame time is unmeasured.
- **The studio `check` flags "one connected piece"** for the Capitol (the Washington statue stands apart) and for the PAC. These are landmarks, not printable objects.
- **The style score was not re-run.** Decision 29's tripwire stands.
- **Three test expectations changed on purpose.**
  - The world test's shading-class bound went from 8 to 12, for `led`, `shop`, `flood` and `pool`.
  - The look test now expects v3's magenta (`#ff4fb0`).
  - The proof test's draw-call bound went from 60 to 80. Its 3-block test town now draws 70 calls from the aerial: the new classes add a primitive per chunk, plus the pools node. The real game budget is 1500.
- **Running the suite inside a 10-port Chrome range takes `STUDIO_CHROME_SPAN=10` and `--test-concurrency=2`.** That run is 169/169 green. With a 3-port span, or with full parallelism, test Chromes collide: the proof and web-runtime tests then flake, and they pass when run alone.
