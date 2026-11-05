# Pocket Raleigh, part 1: world + proof (Phase 4 weeks 9–10)

Three real blocks of downtown Raleigh along Fayetteville St (Hargett → Cabarrus, City Plaza in the middle) built from open data, plus an invented 1920s river-town twin 380 m east, both in one studio scene, imported into `games/pocket-raleigh` (Godot 4.7.2) and `games/pocket-raleigh-web` (three.js).

- `godot-vs-web-sheet.png`: the 8 pinned proof views. Each pair shows Godot on the left and web on the right. Rows: Fayetteville St looking north and south, Martin St looking west and the Raleigh aerial, the twin's Main Street and its aerial, then the twin across the river and both towns together.
- `stills/`: every view at full size, per engine.
- `walk-fayetteville-godot.mp4` + `walk-still.png`: the studio character (Walker) walks 55 m up Fayetteville St in Godot (`game walk-to … --video true`). The web build walks the same route (reached, 40 s). The twin's Main Street (220 m) is walkable too.
- `phone/`: the imitated phone run. WebKit at 390×844 @3x and Chrome with a 4× slower CPU walk Fayetteville St. Both ran at 60 fps (p50 17 ms, p95 18 ms) with 133 draw calls. This was on the Mac's GPU, so it is **not** a real-iPhone result.
- `proof-report.json`: FLIP per view against the previous approved run (the craft pass changed every view), budgets, and Godot-vs-web parity.

## How it looks (honest)

**It reads as a tidy, clean toy downtown. It doesn't read as Raleigh yet.**

What's right:
- The real footprints, heights and street grid.
- The tall towers stand where Raleigh's do.
- Fayetteville St has its wide sidewalks, because sidewalks are widened to the building line.

Most of what you see came from the craft pass:
- Facade schemes: punched windows, ribbon windows, and brick piers.
- Two-storey bases and cornices.
- Set-back crowns on the towers.
- Varied flat roofs.
- Crosswalks, multi-lobed trees, planters, benches and lamps.

Before the craft pass the town was literally tidy boxes, and the inset bug drew huge white slabs on the tower tops.

What's still generic:
- **No landmarks.** The towers have plain crowns and there are no City Plaza light masts.
- **Street level is mostly asphalt and beige.**
- **Every window grid is regular.**

The river twin is the more charming of the two: gables, pastel clapboard, a mill, a church, a green. Its lots are a bit too even.

The next lever is landmark models (the swap-in works) and richer regional rules, not more data. That is the pre-mortem's #1 risk, still open.

Godot and web differ in tone: the web is darker and more contrasty. That's week 11's look work.

## Data

Overture Maps (ODbL), © OpenStreetMap contributors (ODbL), USGS 3DEP (public domain). See `studio world-info --credits true` and `studio world-share`.
