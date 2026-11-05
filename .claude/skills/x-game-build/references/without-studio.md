# Building without the studio

When `find-studio.sh` finds nothing, everything else in the game family still works: the record, the pages, the spec, the road. Only the tools change. Say once: "The studio isn't installed here, so I'll build with plain three.js (or Godot) and use simple shapes."

## Web (three.js)

- Create `games/<slug>/` with `index.html`, `src/main.ts`, `package.json` (three, and esbuild for bundling; both MIT).
- Props are primitive meshes (boxes, cylinders, capsules) in grey; the character is a capsule with a nose so its facing reads.
- Movement and collisions: simple code first; add a physics library (Rapier, Apache-2.0) only if the verb needs it.
- Presets: the same `?preset=` pattern as with the studio.
- Look at it: bundle, serve the folder, take screenshots with headless Chrome (`--headless --screenshot`), and read them.

## Godot

- `godot --headless --path games/<slug> --quit` to import; scenes and GDScript are plain text.
- Props as `CSGBox3D` / `CSGCylinder3D`, the player as a `CharacterBody3D` with a capsule.
- Screenshots: run with `--write-movie out.png --fixed-fps 30 --quit-after N` and read the frames.

## What's lost without the studio

Proposals with keep/undo per step, the studio's checks (budgets, collision, overlap, grounding), character kits with faces and motion, look-lab looks, and renders for look/world/cast pages (use simple screenshots instead and say so on the page).
