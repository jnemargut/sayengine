# Phase 10, step 1: the shared core for working together (decisions 61–64)

Regenerate: `STUDIO_CHROME_PORT=9600 STUDIO_CHROME_SPAN=10 node bench/collab.ts` (daemon on port 4701).
The screenshots are local only (checkpoint media is gitignored); `report.json` holds the notes, the card and
the review counters the run produced.

What the run does, on a walnut stool in the real live view (headless Chrome):

1. Builds a stool with a footrest, and pins three notes as you: on the seat, on the footrest, on a leg.
2. Removes the footrest on main. The footrest note goes **stale** ("walnut-stool/footrest no longer exists"),
   stays in the panel in red, and is no longer pinned in the viewport. It is never moved somewhere else.
3. Opens a proposal with four steps, each with its word note: "thinner legs", "a touch lower" (the model),
   "warmer light" and "warmer" (a look, on the same history).
4. Opens step 1's before/after, then keeps it: that keep counts as reviewed.
5. Adds a "your call" card with four asks. The sound ask is answered by the studio-wide taste file
   ("CC0 first…, you said, 5 Nov 2026"), so the card skips it and says so. Three asks remain.
6. In the view: presses **Before/after** on step 2 (the viewport shows the before), answers the legs pick,
   and skips the light ask. The skipped ask lands in the notes inbox as n4.

| Screenshot | Shows |
|---|---|
| `view-card-and-notes.png` | Notes panel (stale / open / on it), pins on the seat and leg, steps with word notes and Before/after, the card ("I checked" 4 pass, "Your call" 3 asks, one answered by taste) |
| `view-before-after.png` | Step 2's before (main) in the viewport, badge "Before · press After to compare" |
| `view-answered-skipped.png` | The pick answered ("You: 13 mm"), the light ask skipped, and note n4 "Your call (skipped)" in the inbox |
