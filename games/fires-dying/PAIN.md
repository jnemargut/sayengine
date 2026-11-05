# Fire's Dying: pain log

Every point where a missing or weak studio tool hurt while making this tiny game. Each one says which part of the plan it argues for. This list drives the next work: effects, the UI kit, and whatever else it shows.

## v1.1 (5 November 2026): what the new tools fixed, and what they showed

### Status of the v1 list
| # | Pain | Now |
|---|------|-----|
| 1 | Placeholder fire (cones) | **Fixed.** The studio's forge fire follows the game's `fire` value; sparks fire on each hammer strike's impact (motion trigger, no game code); chimney smoke; embers when charcoal goes in or the bellows blow. |
| 2 | Hand-made HUD, bubble, cards | **Fixed.** The UI kit draws the fire and blade bars, the "he wants" slot and line, the carrying slot, the hint, a Use button for touch, the cards and the bubble. The game keeps one CSS rule (an icon inside a bubble). |
| 3 | No item icons | **Fixed.** Six house icons plus three of the game's own (chisel, whetstone, bellows) through `ui-icon --svg`, linted to the house style. The bubble and the "he wants" slot show the icon. |
| 4 | Canvas-only captures (`snap()`) | **Fixed.** `play.ts` captures the whole page (`page.screenshot`, now with JPEG). `snap()` is gone. |
| 5 | No pathfinding | **Still hand-rolled** (via / detour / back-out). Hand props no longer have colliders, so the sack and bucket no longer wedge the apprentice. |
| 6 | No interaction system | **Still game code** (as decided). `useOf()` now drives both the action and the hint, which removed a class of hint/action mismatches. |
| 7 | Private player | **Fixed.** `controls: 'none'` gives `sc.player`; the keyboard-nulling hack is gone. |
| 8 | Manual line playback | **Fixed.** `say()`; the mixer lookup and `new Audio()` are gone. |
| 9 | Line audio not exported | **Fixed**, but only once the build script passed `gameData()` (see A below). `assets/voice/` is deleted. |
| 10 | No "carried" form | **Mostly fixed.** `hold()` puts the grip in the palm. See H below. |
| 11 | Hand props needed colliders | **Fixed.** `set-profile --kind hand-prop`. |
| 12 | Overlap checks | **Partly fixed.** It still cost two rebuilds (see L). |
| 13 | "Good lad." mouth 130 ms early | **Fixed in play.** `say()` delays the mouth by the measured offset. The studio check still flags it. |
| 14 | Names renamed by GLTFLoader | **Fixed.** `named(game, 'Big hammer')`; the sanitising is gone. |

### New in v1.1
- **A. `game import` wrote empty effects, UI and lines with no warning.** The game's build script gave the import no `gameData()`, so it wrote `effects.json = []`, `ui.json = null` and `lines.json = {}`. The first sign was `say()` failing in the playtest. The import result now says so (`note`). → `/game` fixed.
- **B–E. Effect parity bugs in the compilers** (found by measuring, fixed in `packages/game/src/effects.ts` and `packages/core/src/effects.ts`):
  - **B.** quarks' `RectangleEmitter` emits from the rectangle's *edge*, sideways. Web rain was a ring of horizontal streaks. Boxes now use a fine `GridEmitter`.
  - **C.** The streak length formula subtracted the speed, so web sparks were about half as long as Godot's.
  - **D.** quarks' particle shader skips three's colour-space step, so linearised palette colours came out about 20% darker. The palette's sRGB values now go straight to quarks.
  - **E.** Godot had no lifetime randomness: every particle lived for the longest life. Added `lifetime_randomness`.
  - **Also:** alpha-blended web layers carry alpha^1.6, because Godot blends see-through layers in linear light.
- **F. UI kit bar text didn't scale.** `.ui-bar .text` had a fixed 20 px font, so on a phone it overflowed a 16 px bar (the review-sheet clip). It now inherits the bar's scaled size, the default heat bar is 40 tall, and tooltips have no vertical padding. The sheet's bubble no longer overlaps the title card. → UI kit fixed.
- **G. Bubbles ran on the wall clock.** In a stepped capture they vanished early or late, and the old end card (a `setTimeout`) never showed. Bubbles now time by `game.time` when the game keeps one; the end card is on the game clock too. "Play again" works in the capture.
- **H. `hold()` moves the real prop.** For a source like the charcoal sack (which should stay put), the game clones the node and gives the copy its own `studioName`, then holds that. It's four lines, but `hold(…, { copy: true })` would be cleaner.
- **I. Cards have a fixed height and no button.** The kit's card is a title and one line. The game appends paragraphs and a "Play again" button itself and sizes the card from the text length. → UI kit: a card with body text and actions that sizes to its content.
- **J. No icon-in-bubble part.** The game has one CSS rule for it. → UI kit.
- **K. `say()` resolves on `setTimeout`.** The game doesn't await it (the smith's busy time comes from `lines.json`), so it's harmless here. In a stepped capture its promise is still on wall time.
- **L. A laid-down cylinder runs 0 → h, not centred.** The chisel grip floated and the bellows nozzle went into the forge, so two rebuilds. The studio checks named both exactly ("2 separate pieces", "overlaps Forge by 102 cm³"), so it was cheap.
- **M. Every asset build re-synthesises all 15 voice lines** (about 3 of its 4 minutes). → voice: cache by text and voice.
- **N. Two effects still don't match across engines.** Smoke now matches in colour and coverage, but the web column rises higher than Godot's, and the cause wasn't found. Web rain drops are under a pixel wide and barely register. Rain is an **Effekseer candidate**. Numbers are in the v1.1 report.

## Missing tools (the game needed them, the studio had nothing)

1. **The forge fire is a placeholder.**
   - Today it's three flat-shaded cones, a point light and a sine-wave flicker, written by hand in `main.ts`.
   - What's missing:
     - no flame shapes or scrolling noise
     - no sparks when the hammer strikes
     - no smoke from the chimney
     - no embers when charcoal is tipped in
   - The fire level is the game's central readout, and it reads as "orange cones". → **Effects (D56)**: a forge fire whose size follows a game value; spark bursts on the `strike` motion event and on "fed".
2. **The HUD and the speech bubble are hand-written HTML and CSS.**
   - The fire bar, blade bar, "He wants", "Carrying", the hint line and the title/end cards are all hand-made.
   - They don't follow the look, so the colours are copied by hand from the forge.
   - Nothing checks contrast or tap size.
   - The bubble's position over the smith's head is projected by hand every frame. → **UI kit (D58)**:
     - a dialogue/speech-bubble part that tracks a character
     - bars, item slots, title/end cards
3. **No item icons.**
   - "He wants: tongs" is text.
   - An icon in the bubble would read faster than words, especially on a phone. → **UI kit icons (D58)**.
4. **No way to screenshot the HTML UI from the harness.**
   - Canvas captures miss the HUD, so `main.ts` has a `snap()` that redraws the HUD onto a 2D canvas only for the playtest video.
   - That's duplicate UI code. → The proof gate / reel capture should screenshot the whole page, not only the WebGL canvas.
5. **No pathfinding for the player.**
   - Tap-to-walk walks in a straight line.
   - The first headless run lost because the apprentice stood stuck behind the charcoal sack holding the tongs for 40 s.
   - Worse: the harness's "stop" step carries the capsule forward a little after you let go. Twice it carried the apprentice into the sack's collider and wedged him there, so even sideways moves came out at zero speed.
   - Sliding sideways wasn't enough: once he'd handed a tool over from behind the anvil, the way to the charcoal sack was blocked by the forge and the smith, and he dithered there until the fire died.
   - Fixed by hand in the game: back out 15 cm when wedged, then walk via the open floor where he starts, then slide sideways if still blocked. It works for this one room only. The harness's stop step should check its own collision. → **Life module (D30)**: a baked walk mesh and paths, usable for the player's tap-to-walk too, not only NPCs.
6. **No interaction/"use" system.**
   - Stations, reach distances, "what is near me", the hint text and tap-to-use are all hand-rolled.
   - Every small game will rewrite this.
   - This is gameplay code, so by the "can Claude tell by reading it?" test it stays code, not a studio tool. But `/game` templates could ship a tiny reusable `interactables.ts`.

## Weak tools (they existed but fought me)

7. **The harness's player is private.**
   - `studio/harness.ts` makes the walking apprentice only through `startCharacters({ controls: true })`, and it hard-wires WASD and its own follow camera.
   - To add tap-to-walk and a fixed camera, the game takes `sc.keyboard` and sets it to `null` to stop the built-in controls. That's a hack on a managed file's internals.
   - → `/game`: export the Player class, or offer `controls: 'none'` with the player still made.
8. **Playing a character's line in-game is manual.**
   - Find the smith's mixer by its group name, cross-fade idle into `line:<id>`, play the WAV yourself, fade back.
   - The cutscene player does all of this, but only inside a cutscene. → `/game`: a small `say(character, lineId)` runtime helper next to the cutscene player.
9. **Line audio isn't exported for gameplay.**
   - `game import` writes audio only for lines used in cutscenes.
   - The builder had to write `assets/voice/*.wav` itself, beside the studio's copy. → `game import` should export every recorded line's audio (or a flag for it).
10. **Hand-held props have no "carried" form.**
    - Holding the tongs means cloning the shelf object's node and placing it at the `RightHand` bone each frame with guessed offsets.
    - The charcoal sack has to be shrunk to 55%.
    - The studio has `hold`/grips for the cutscene characters, but the game can't ask for them at runtime. → Grip sockets (D22) exported per prop, plus a runtime "hold this" helper.
11. **Godot-desktop profile checks on hand props.**
    - Every tiny hand tool failed "has a collision shape" under the profile, so they got hull colliders that the game doesn't want.
    - → Profiles could know "hand prop" vs "furniture".
12. **Overlap checks for things set on things.**
    - The blade on the anvil kept failing "clear of other objects" by under 1 cm³ until it was raised 6 mm by hand.
    - `place-object on` failed because the anvil's horn tip is its highest point, not its face.
    - → `place-object on` should pick the largest flat top, not the highest point.
13. **"Good lad." lip sync is 130 ms early.**
    - The short line's sync check fails, and nothing fixes it automatically.
    - It's minor, but the check could offer a shift.

14. **Studio object names don't survive into three.js.**
   - The studio names things "Big hammer", "Charcoal sack". three's GLTF loader quietly rewrites them to "Big_hammer", "Charcoal_sack", so `getObjectByName('Big hammer')` returns nothing and there's no error.
   - Cost: the first full playtest looked like a pathfinding failure. Actually three of the five stations didn't exist, so the apprentice could never fetch the hammer or feed the fire.
   - The web template should export a `named()` helper (or a manifest of object name → node name) so game code can use the names it sees in the studio.

## Fine as they were

- `/studio` props: shelf, tongs, file, sack, bucket, big hammer, blade. Each took 1–3 tries, and every check named the exact fix.
- The voices: 10 Kokoro lines, aligned, lip-synced and performed with gestures, in about 90 s with one script.
- The intro cutscene: two `set-shot` calls, played unchanged by the game's cutscene player.
- `game import`: one call for the scene, the player, character clips and the cutscene.
