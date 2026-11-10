# `game-spec.json` (decision 40)

Contents: shape · the `from` rule · derived fields · open fields · step list · partial rebuilds · example.

The spec is what chosen decisions compile into, and what `x-game-build` builds from. It lives at `.decisions/game-spec.json`. Only `x-game-build` writes it.

## Shape

```json
{
  "version": 1,
  "game": { "title": "Bread at Dawn", "engine": "web", "from": "d1" },
  "tone":     { "line": "gentle, dry jokes", "from": "d1" },
  "fidelity": { "target": "stylised-realistic", "from": "d4" },
  "fantasy": { "line": "Deliver warm bread across a sleepy hill town before the sun is up", "from": "d1" },
  "pillars": { "items": ["Cozy, never rushed", "Hills are the puzzle", "The town wakes as you go"], "from": "d2" },
  "variant": { "kind": "loop", "from": "d3" },
  "toy":      { "verb": "push a bread cart", "props": ["cart", "bread crate"], "space": "grey hill street", "from": "d3" },
  "camera":   { "kind": "follow-high", "distance": 7, "from": "d4" },
  "controls": { "move": "WASD / left stick", "actions": { "brake": "Space", "hand-over": "E" }, "from": "d4" },
  "character":{ "plan": "chibi", "preset": "baker", "from": "d4" },
  "handling": { "preset": "heavy", "mass": 1.4, "accel": 3.2, "from": "d5" },
  "loop":     { "steps": ["load", "route", "push and brake", "deliver", "town wakes"], "from": "d6" },
  "scope":    { "streets": 4, "minutes": 10, "goals": 8, "cut": ["market", "rain"], "from": "d8" },
  "sources":  { "props": "CC0 library", "hero": "studio kit", "people": "studio kit", "from": "d9" },
  "look":     { "record": "dawn-toy", "from": "d10" },
  "world":    { "source": "invented", "brief": "small hill town, 4 streets", "dressing": "lived-in, flour everywhere", "from": "d11" },
  "cast":     { "characters": [{ "name": "Baker", "plan": "chibi" }], "from": "d12" },
  "title":    { "screen": "the cart rolls in at dawn", "from": "d13" },
  "open": []
}
```

## The `from` rule

Every leaf object carries `from: "dN"`, the decision that set it. Fields set by a gap page carry that gap page's id. A field with no decision behind it is **not allowed**: put it in `open` instead (below) and use a stated default.

## Derived fields

Some fields follow from others rather than from their own decision: the number of goals, secrets or jobs, the session length, the number of cameras, a routine's timetable, all usually scale with `scope`. Mark them `"from": "d8", "derived": true`. When the source decision changes, recompute every derived field in the same pass, list them in the report, and add a `from: "scope-cascade"` history entry (conventions §11). Checks and tests that assert these numbers change with them, and the report says so.

After every compile, check the spec against the record: every chosen decision with a `spec` list has those paths present, and no field still holds a number a later history entry replaced.

## Open fields

`open` lists what the build needed but no decision covered:

```json
"open": [ { "path": "toy.tipping", "default": "cart rights itself after 1 s", "kind": "small", "note": "listed after the build" } ]
```

- `kind: "small"`: low stakes, doesn't change how the game plays or looks → the build uses the default and lists it afterwards in its report. In a systemic game, numbers for how other characters perceive the player (hearing range, sight cone, suspicion) are not small.
- `kind: "real"`: changes how it plays or looks → the build **stops** and makes a gap page (two to four options) before continuing. Once chosen, the field moves out of `open` with `from` set to the gap page.

## Step list

`x-game-build` turns the spec into numbered steps, each one studio proposal or one engine change, each naming the spec paths it uses:

```json
{ "id": "s3", "uses": ["handling", "camera"], "tool": "studio game import --engine web", "status": "done", "proposal": "p4" }
```

The list is saved as `.decisions/build-plan.json` alongside the spec.

## Partial rebuilds

When a decision changes, its `spec` paths change; rerun only the steps whose `uses` overlap those paths, plus steps that depend on them. Report which steps reran.

## Example: from two chosen decisions

After step 1 only (fantasy and pillars chosen, toy not yet built), the spec is a stub: `game`, `fantasy`, `pillars` filled with `from`, everything else absent, and `open` empty.
