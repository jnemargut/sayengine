# Fire's Dying: pain log

Every point where a missing or weak studio tool hurt while making this tiny game. Each one says which part of the plan it argues for. This list drives the next work: effects, the UI kit, and whatever else it shows.

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
   - Fixed with a crude "slide sideways when blocked, back out 15 cm when wedged" in the game. The harness's stop step should check its own collision. → **Life module (D30)**: a baked walk mesh and paths, usable for the player's tap-to-walk too, not only NPCs.
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
