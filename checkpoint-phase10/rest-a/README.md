# Phase 10 step 3, part A: looks, towns and the UI kit in the live view

`node bench/rest-a.ts` (ports 4720–4722, Chrome 9620–9629) runs the real daemon and view in headless Chrome. It drives them with real input and pointer events and saves the screenshots below. The images are gitignored. `report.json` holds what each action produced: steps, notes, fixes and checks.

## Screenshots

**1. Looks with sliders.** The town is the offline cut of Pocket Raleigh's plaza blocks: 27 buildings, `raleigh-mini`.
- `look-sliders.png`: the day-toy look's sliders after three releases. There are three steps, each with its note:
  - "warmer: white balance 6200 K → 5600 K"
  - "thicker fog: fog density 15% → 30%"
  - "sun lower: sun height 63° → 30°"
- `look-point-bubble.png`: Point mode. A click on a building opens "What's wrong here?" with quick chips.
- `look-point-pinned.png`: "too dark here" is pinned on that building. The note carries the look, the 3D point and the screen spot.
- `look-three.png`: "Show me three" gives warm and soft, cool and crisp, and rich and punchy:
  - three thumbnails of the same view
  - a per-section compare
  - Pick and "None of these"

**2. Towns: click to fix.**
- `town-selected.png`: a click on a building selects it by its stable id. The inspector shows its height, floors, roof, use and source (Overture GERS id, its data name).
- `town-fixed.png`: two word notes, "flat roof, two storeys taller" and then "brick". Each became one fix-layer entry and one step.
- `town-landmark.png`: "Swap in this landmark" puts a studio model (Lantern tower) on the footprint.

**3. The UI kit over the scene.**
- `ui-mobile-selected.png`: the forge HUD in a phone frame (844×390) with its safe area. The pump button is selected (`ui/pump`).
- `ui-mobile-overflow.png`: text size dragged to 44 px. "Text fits when translated" turns red on both screens.
- `ui-mobile-tap.png`: pump shrunk to 70 × 70 and filled `good`. Tap size fails on the phone (38 px).
- `ui-desktop.png`: the same kit on the desktop screen, where tap size passes.

## Verdict

All three work end to end in the real view: one step per release, words become fixes, and addresses use no typed ids. The town reads well in the view. Night lamps and glow come alive on `neon-night`. The bench uses day-toy, so it doesn't show them.

## What's weak

- **The look and the diorama camera don't fit.** Fog distances in a look are tuned for a street-level camera. The view frames the whole chunk from about 400 m away, so 40 %+ fog washes the town out. The slider is honest, but the picture misleads.
- **"Show me three" for looks only varies the grade.** The thumbnails are the current viewport re-graded with each take's LUT, using the main renderer. Takes that change the sun or fog would need the full scene light per take.
- **The bench needed two runs.** The machine's load average was over 30 with another agent running, and one headless screenshot timed out. `SCENES=town,ui node bench/rest-a.ts` re-runs only some scenes.
- **The town is the 27-building offline fixture.** The full `raleigh-city-plaza` cache isn't on this machine. Chunking (±140 m, ≤ 90 buildings) is built and tested but hasn't been run on the full town.
- **Godot honours only part of the UI element tokens.** It picks up text size and ink. Fill and padding still come from the theme, so the web and the view show more than Godot does.
- **Word notes are a phrase reader, not language understanding.** Anything it doesn't catch is said back ("I didn't catch…") rather than guessed.
- **Screenshots are in the dark theme** (headless Chrome default).
- **The history strip shows tool summaries.** The word notes appear in the review panel and in the report, not on the history chips.
