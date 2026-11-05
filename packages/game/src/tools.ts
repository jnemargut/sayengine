// The /game tools, described as JSON Schema so `studio game <cmd> --help`, the CLI's flag checks
// and the MCP adapter all come from one list (same pattern as DAEMON_TOOLS).
// CLI: `studio game init …` and `studio game-init …` are the same command; MCP names are `game-init` etc.

export interface GameTool { name: string; description: string; flags: { type: 'object'; properties: Record<string, any>; required?: string[] }; example: string }

const project = { type: 'string', description: 'game folder (path, or a name under games/). Optional when there is exactly one game.' };
const vec = { type: 'array', items: { type: 'number' }, description: '[x, z] (or [x, y, z]) in metres' };

export const GAME_TOOLS: GameTool[] = [
  {
    name: 'game-init',
    description: 'Create a game project wired to this studio. --engine godot (standalone games: desktop/Steam, text scenes, CLI-driven) or web (three.js + Rapier, for web apps and browser games). Writes games/<name>/ with a main scene that loads the studio scene, a play-test runner, and a .gitignore for engine caches. Your game code goes in game/ (Godot) or src/ (web); files under studio/ are managed and get overwritten.',
    flags: { type: 'object', properties: { name: { type: 'string' }, engine: { type: 'string', enum: ['godot', 'web'], default: 'godot' }, dir: { type: 'string', description: 'default games/<name>' }, force: { type: 'boolean', default: false } }, required: ['name'] },
    example: 'studio game init --name forge --engine godot',
  },
  {
    name: 'game-import',
    description: 'Export the studio scene (or --object) as GLB into the game (assets/studio/scene.glb) and import it into the engine. Returns the round-trip report: meshes, triangles, materials as the engine sees them, plus engine warnings/errors. Any engine warning fails the import unless --strict false. --player <character> makes that studio character the player: it is exported on its own (assets/studio/player.glb, with its walk/idle clips and what it holds) and starts where it stands in the studio; walk-to and the game\'s own controls then drive it, playing walk at the clip\'s speed and idle when it stops (--player none goes back to a capsule). Other characters stand in the scene playing idle. Clip speeds and loops go in assets/studio/characters.json. Never edit the engine copy — fix the asset in the studio and import again.',
    flags: { type: 'object', properties: { project, object: { type: 'string', description: 'one studio object instead of the whole scene' }, file: { type: 'string', description: 'import an existing .glb instead of exporting from the studio' }, strict: { type: 'boolean', default: true }, player: { type: 'string', description: 'studio character that is the player (none: a capsule)' } } },
    example: 'studio game import --project forge',
  },
  {
    name: 'game-run',
    description: 'Run the game headlessly for --seconds of game time (fixed 60 fps, faster than real time) and report what loaded (objects, sizes, triangles) plus every engine warning, error and print.',
    flags: { type: 'object', properties: { project, seconds: { type: 'number', default: 3 } } },
    example: 'studio game run --project forge --seconds 5',
  },
  {
    name: 'game-screenshot',
    description: 'Render the running game (not the studio view) and return PNG paths you can Read: --views iso,front,side,back,top,low. --object frames one object; --player [x,z] stands a play-test capsule there for scale. --page true captures the whole screen instead — the 3D plus the HUD and any HTML/Control UI over it (the web canvas alone misses HTML UI).',
    flags: { type: 'object', properties: { project, views: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string', enum: ['iso', 'front', 'side', 'back', 'top', 'low'] } }], default: 'iso,front' }, object: { type: 'string' }, player: vec, size: { type: 'number', default: 960, description: 'image width in px' }, page: { type: 'boolean', default: false, description: 'the whole screen as the player sees it: the game camera plus the HTML / Control UI over it (the UI kit\'s HUD is started); with --object the camera frames it' }, ui: { type: 'boolean', default: true }, seconds: { type: 'number', default: 1 }, values: { type: 'object', description: 'game values for effects, e.g. {"fire":0.6}' }, bubbles: { type: 'array', items: { type: 'object' }, description: '[{character, text}] speech bubbles to show' }, card: { type: 'object', description: '{title, sub}: a title/end card' } } },
    example: 'studio game screenshot --project forge --views iso,front',
  },
  {
    name: 'game-walk-to',
    description: 'Play-test: walk the player straight toward --target (object name or [x,z]) with gravity and collision. The player is the studio character set with `game import --player` (playing its walk clip at the clip\'s speed, idle when it stops, starting where it stands in the studio) or else a capsule (0.6 m wide, 1.7 m tall). Reports reached / blocked / timedOut, seconds, start, final position, distance short, and the path. --from [x,z] sets the start (default: the player character\'s spot, or 3 m out from the target). --screenshot true also returns an image of where it ended; --video true records the walk from a following camera as an MP4 (plus stills).',
    flags: { type: 'object', properties: { project, target: { anyOf: [{ type: 'string' }, vec] }, from: vec, speed: { type: 'number', description: 'm/s (default: the walk clip\'s speed, or 1.4)' }, reach: { type: 'number', default: 0.45, description: 'count as reached within this many metres of the target footprint' }, timeout: { type: 'number', default: 20 }, screenshot: { type: 'boolean', default: false }, video: { type: 'boolean', default: false } }, required: ['target'] },
    example: 'studio game walk-to --project forge --target "Walnut stool"',
  },
  {
    name: 'game-cutscene',
    description: 'Play a studio cutscene in the game (Decision 24): Godot plays the generated scene (res://assets/studio/cutscenes/<id>.tscn: an AnimationPlayer with the camera, voices and cues driving the characters\' clips); the web plays it with studio/cutscene.ts. Reports what played and any missing clip; --video true records it frame by frame and muxes the voices into an MP4 (plus stills, one per shot). `game import` writes the cutscenes first.',
    flags: { type: 'object', properties: { project, id: { type: 'string', description: 'cutscene id (studio cutscene lists them)' }, video: { type: 'boolean', default: false } }, required: ['id'] },
    example: 'studio game cutscene --project forge --id forge-lesson --video true',
  },
  {
    name: 'game-effect',
    description: 'Review a studio effect in the game (Decisions 56–57): plays it from the studio\'s review camera (it fills ~60% of the screen) and records an MP4 plus stills. --value 0.8 or [0, 1] (a ramp over the run) drives the game value it follows; --events [{at, name}] fires game events ([{at, burst: layer}] a burst directly); --play [{character, clip}] loops a character clip so motion triggers fire (sparks on "hammer-strike@impact"); --cpu true uses the CPU fallback (Godot). --against <project> plays it in that other game (the other engine) too and returns a side-by-side card and video and the Godot-vs-web parity, saved to the studio effect (its fx-parity check).',
    flags: { type: 'object', properties: { project, id: { type: 'string' }, seconds: { type: 'number', default: 4 }, value: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] }, events: { type: 'array', items: { type: 'object' } }, play: { type: 'array', items: { type: 'object' } }, cpu: { type: 'boolean', default: false }, against: { type: 'string', description: 'the other engine\'s game project, for the side-by-side card and parity' } }, required: ['id'] },
    example: 'studio game effect --project forge-godot --id forge-fire --value \'[0.2,1]\' --against forge-web',
  },
  {
    name: 'game-ui-sheet',
    description: 'Review the studio UI kit (Decision 58): renders a sheet of every part in the kit\'s CSS, the HUD on a 844×390 phone with pseudolocalised text and the safe area drawn, and the icons at 48 and 24 px on dark and light; then scores the icons at 24 px (legible, centred, distinct from each other) and saves the scores to the studio kit. Returns the PNG to Read. For the UI over the game in each engine: game screenshot --page true.',
    flags: { type: 'object', properties: { out: { type: 'string', description: 'folder (default .studio/ui-sheet)' } } },
    example: 'studio game ui-sheet',
  },
  {
    name: 'game-feet',
    description: 'Check that feet stay on the ground in the running game (Godot, Decision 52): watches every live foot (kit humanoids with studio/foot_ik.gd, creatures with studio/creature_ik.gd) for --seconds, or while the player walks to --walk (object or [x,z]), and measures each planted foot against the ground under it (rays onto the game\'s own colliders: steps, slopes, props). Fails when planted feet float or sink past the limit at the 95th percentile (humanoids 2.5 cm up / 2 cm down; creatures 4 % / 2 % of their size). --ik false turns the live IK off (baked clips only) to see the fallback on the same ground; --video true records it (a following camera on a walk, else --look {center, radius, dir}).',
    flags: { type: 'object', properties: { project, seconds: { type: 'number', default: 6 }, walk: { anyOf: [{ type: 'string' }, vec], description: 'the player walks here while feet are measured' }, from: vec, ik: { type: 'boolean', default: true }, video: { type: 'boolean', default: false }, look: { type: 'object', description: '{center:[x,y,z], radius, dir:[x,y,z]}: the camera for --video without --walk' } } },
    example: 'studio game feet --project ik-yard --walk Landing --video true',
  },
  {
    name: 'game-test',
    description: 'Run engine-side assertions and return pass/fail JSON. --assertions is a JSON array of {kind, …}: exists {node}, grounded {node, tolerance}, on {node, target, tolerance} (node rests on target), count {pattern, min, max}, reachable {target, from}, feet {seconds | walk, ik} (Godot: planted feet on the ground, as game feet). Godot also runs res://tests/test_*.gd (static func run(root) -> {pass, detail}); web runs tests registered with registerTest(name, fn) from studio/harness.ts.',
    flags: { type: 'object', properties: { project, assertions: { type: 'array', items: { type: 'object' } }, scripts: { type: 'boolean', default: true } } },
    example: 'studio game test --project forge --assertions \'[{"kind":"on","node":"Vase","target":"Walnut stool"},{"kind":"reachable","target":"Walnut stool"}]\'',
  },
  {
    name: 'game-status',
    description: 'Game projects in this studio (engine, last import, asset sizes) and whether each engine is available here (Godot path/version, Chrome for the web back end).',
    flags: { type: 'object', properties: { project } },
    example: 'studio game status',
  },
];

export const gameTool = (name: string) => GAME_TOOLS.find((t) => t.name === name || t.name === `game-${name}`);
