# Phase 10 step 2: everything that moves, on one timeline

`node bench/timeline.ts` (STUDIO_PORT=4711, STUDIO_CHROME_PORT=9610, STUDIO_CHROME_SPAN=9) builds the forge yard
(bench/forge.ts), adds sparks on the strike's impact, the forge fire, a clink on the impact and the forge's roar as a
bed, pins a note on the smith's hand just after the impact, and renders the real live view headless with the timeline
dock. Media (PNG, MP4) is gitignored; `report.json` holds the tracks, the red stretches, the moment address at the
impact, the slider step, the word-note step, the three takes and the measured frame time.

| File | What it shows |
| --- | --- |
| `01-swing-red-stretch.png` | The smith mid-downswing at 0.98 s, on the red stretch: "no pops (joint speed)" fails (1390°/s > 1260) once per pass of the 1.8 s strike. Named moments (windup, impact) on the track; the pinned note (1) just after each impact. |
| `02-impact-sparks-clink-note.png` | Just after the impact: sparks in the air (bursting on the moment that fires them), the clink's waveform starting under the playhead, the forge roar bed, the note marker. The side panel shows the moment address (`blacksmith@clip:strike 28320t ~impact #…`). |
| `03-effect-sliders.png` | The sparks track selected: its knobs as sliders. Releasing one made a step labelled with what moved (`report.json` → `sliderStep`). |
| `04-word-note-step-after.png` | "slower" pressed on the strike: one step in proposal p1. The after plays: the strike is 2.27 s, the impact at 1.35 s, the pinned note followed the impact, and the pop's red stretch is gone (all checks pass). |
| `05-word-note-step-before.png` | Before (main) on the same timeline: the 1.8 s strike with its red stretch. |
| `06-sound-show-three.png` | `sound-three` on the clink: three takes (brighter ring, heavier, dull thud), each a proposal, and the listen-and-pick "your call" ask in the dock. |
| `forge-timeline.mp4` | A short capture from the view (headless, frame by frame): the swing, sparks and dock playing. No audio track (see below). |

Frame time is measured separately in Chrome on the GPU (Metal) with the forge playing the clip, sparks, the fire and
both sounds together (`report.json` → `frameTime`). The screenshots and video come from headless Chrome with
SwiftShader (software GL), which is why the dock there reads "software GL" instead of a frame time.

Known gaps: captured videos have no audio; the clips play in place (a walk doesn't travel over the ground); the
forge checkpoint has no recorded voice line, so lip sync in the view is covered by the code path and tests, not seen here.
