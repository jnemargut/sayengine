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
    description: 'Export the studio scene (or --object) as GLB into the game (assets/studio/scene.glb) and import it into the engine. Returns the round-trip report: meshes, triangles, materials as the engine sees them, plus engine warnings/errors. Any engine warning fails the import unless --strict false. Never edit the engine copy — fix the asset in the studio and import again.',
    flags: { type: 'object', properties: { project, object: { type: 'string', description: 'one studio object instead of the whole scene' }, file: { type: 'string', description: 'import an existing .glb instead of exporting from the studio' }, strict: { type: 'boolean', default: true } } },
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
    description: 'Render the running game (not the studio view) and return PNG paths you can Read: --views iso,front,side,back,top,low. --object frames one object; --player [x,z] stands a play-test capsule there for scale.',
    flags: { type: 'object', properties: { project, views: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string', enum: ['iso', 'front', 'side', 'back', 'top', 'low'] } }], default: 'iso,front' }, object: { type: 'string' }, player: vec, size: { type: 'number', default: 960, description: 'image width in px' } } },
    example: 'studio game screenshot --project forge --views iso,front',
  },
  {
    name: 'game-walk-to',
    description: 'Play-test: spawn a capsule player (0.6 m wide, 1.7 m tall, gravity + collision) and walk it straight toward --target (object name or [x,z]) at --speed m/s. Reports reached / blocked / timedOut, seconds, start, final position, distance short, and the path. --from [x,z] sets the start (default: 3 m out from the target, first clear side). --screenshot true also returns an image of where it ended.',
    flags: { type: 'object', properties: { project, target: { anyOf: [{ type: 'string' }, vec] }, from: vec, speed: { type: 'number', default: 1.4 }, reach: { type: 'number', default: 0.45, description: 'count as reached within this many metres of the target footprint' }, timeout: { type: 'number', default: 20 }, screenshot: { type: 'boolean', default: false } }, required: ['target'] },
    example: 'studio game walk-to --project forge --target "Walnut stool"',
  },
  {
    name: 'game-test',
    description: 'Run engine-side assertions and return pass/fail JSON. --assertions is a JSON array of {kind, …}: exists {node}, grounded {node, tolerance}, on {node, target, tolerance} (node rests on target), count {pattern, min, max}, reachable {target, from}. Godot also runs res://tests/test_*.gd (static func run(root) -> {pass, detail}); web runs tests registered with registerTest(name, fn) from studio/harness.ts.',
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
