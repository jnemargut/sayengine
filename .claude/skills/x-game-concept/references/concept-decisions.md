# Concept decision catalogue

How to make each concept decision's four options genuinely different, what to compare, and what the visual shows.

## The fantasy (step 1)

Vary **who the player is** and **what the delight is**, not just the wording. A useful spread:

- the literal reading of the idea,
- a cozier or calmer reading,
- a more playful or chaotic reading,
- a reading built around a relationship or a place.

Compare: who it's for · the feeling in one word · the core verb it implies · how big it wants to be · undo cost.

Visual: a small poster card per option: the one-line fantasy in large type, a three-shape SVG scene sketch, and a "you would say…" quote.

## Three pillars (step 1)

A pillar is a short statement every feature must pass through ("Cozy, never rushed"). Each option is a set of three. Spread the sets across **pace**, **challenge** and **expression** so they lead to different games.

Compare: what each set makes you cut · what it makes easy · how well it fits the fantasy · undo cost.

Visual: three pillar cards per option, each with one example feature that **passes** (green tick) and one that **fails** (red cross), using this game's content.

## Toy, loop or story, and the core verb (step 1)

- **Toy**: fun to play with, no goal (Schell's lens of the toy).
- **Loop**: about 30 seconds of fun that repeats and grows ("30 seconds of fun").
- **Story**: one-time arcs, characters and choices.

Each option pairs a shape with a core verb (push, throw, build, talk, sneak, deliver…). Make at least one option a toy and one a loop.

Compare: how soon it's fun · what the grey box will be · how it grows into v1 · what the road variant becomes · undo cost.

Visual: a one-screen sketch of the verb (top-down or side view, SVG) plus a small loop diagram (circle of three to five steps) or arc diagram (a line with beats).

Research, when available: two or three games with a similar verb, and what made the verb fun. Cite.

## Working title and tone (step 1, one line)

Offer a working title drawn from the fantasy and a tone in three or four words ("warm, dry, a bit silly"). Store as `game.title` and `tone` with `from` the toy decision. If the user later picks a name that implies a different tone (a joke name, a pun), make a **tone** page: four levels of zaniness, including one that escalates during play, each shown as a sample job list, a sample line from a character, and a title-card mock-up. Tone and the title screen are then design decisions at step 6 (design catalogue).

## Fidelity target (step 1, light)

Only when the user has named a look or shared references. Four points on the realism scale, each shown as a small board: a mock-up or a quick render of the hero next to a doorway, the props it implies, and the honest build cost.

- simple shapes, stylised (cheapest, the studio kit as is),
- stylised with good materials (kit characters, free textures),
- stylised-realistic (proportions and faces close to life, free CC0 props, Blender or studio work on the hero),
- as realistic as free tools allow (CC0 scanned props and HDRI lighting, a hand-built hero).

Each card names where the models would come from, using only free sources (conventions §8): the studio, CC0 libraries, Blender, a local generator. Never a paid one. Compare: matches what the user said · hero character risk · build time · phone cost · undo cost. The recommendation follows `game.stated` unless it says plainly why not.

## Engine (optional)

Web (three.js: share by link, plays on phones) or Godot (desktop download, richer engine). Default web. Usually asked in one line, not a page.

## Scope of the first version (step 5)

Four scopes from smallest to largest. Each is a one-page design: map or flow, what's in, what's cut, minutes of play, number of characters, number of places. Quote playtest findings that argue for or against each. The recommendation is usually the smallest scope that still shows all three pillars.

Compare: minutes of play · pillars shown · build time · risk of not finishing · undo cost.

Each scope card also lists what scales with it (goals or jobs, secrets, session length, cameras, characters' routines), so the chosen card already holds the derived numbers.
