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

PARITY_TABLE

The target was ≤ 0.15. VERDICT_PARITY

## How it looks from the street (honest)

VERDICT

## What's weak

WEAK
