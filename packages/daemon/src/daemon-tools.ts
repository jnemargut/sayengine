// Tools the daemon owns (they need the filesystem or the browser view), described as
// JSON Schema so the CLI help and the MCP adapter can expose them next to the registry.
export interface DaemonTool { name: string; description: string; flags: { type: 'object'; properties: Record<string, any>; required?: string[] } }

export const DAEMON_TOOLS: DaemonTool[] = [
  {
    name: 'selection',
    description: 'What the human has selected in the view (click a part in the viewport or scene tree): object, part, its bounding box and the ops that made it. Use it to resolve "this", "that leg", "the selected part".',
    flags: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Daemon status: project dir, active branch, connected views, current selection.',
    flags: { type: 'object', properties: {} },
  },
  {
    name: 'render',
    description: 'Ask the open browser view to render images. Default (--style labeled): --views front,side,top,iso,back with numbered part labels and edges; returns PNG paths you can Read plus a legend. --style presentation: a finished-looking image (materials, environment light, soft shadows, no labels) from a 3/4 "hero" camera, 1600 px; use it when the human wants to see or share the result. --object <id>, --proposal p1, --size px.',
    flags: {
      type: 'object', properties: {
        views: { anyOf: [{ type: 'string', description: 'comma-separated, e.g. "front,side,iso" (presentation: "hero,front"; characters: "face,face-34,hands")' }, { type: 'array', items: { type: 'string', enum: ['front', 'side', 'top', 'iso', 'back', 'hero', 'low', 'face', 'face-34', 'hands'] } }] },
        style: { type: 'string', enum: ['labeled', 'presentation'], default: 'labeled' },
        size: { type: 'number', description: 'image width in px (labeled 768, presentation 1600)' },
        labels: { type: 'boolean', default: true }, object: { type: 'string' }, proposal: { type: 'string' },
      },
    },
  },
  {
    name: 'export',
    description: 'Write an asset. Plain: --format glb|obj|stl (GLB keeps PBR materials per part; STL is mm, Z-up for printing). Game: --target godot|web unwraps every part, bakes materials (colour, wood grain, roughness, metalness) into one texture pair per object through the open view, adds collision nodes (Godot -convcolonly; extras.collision for three.js) and distance versions (web: MSFT_lod), and refuses if game checks fail (--force true overrides). --texture px overrides the profile; --bake false skips textures. Every GLB is checked by the Khronos glTF validator (errors = not written). [--object id] [--out path]; references are left out unless --include-references true. A character exported with --object brings the props in its hands. --exclude ids leaves objects (and what they hold) out; --at-origin true exports the --object at the origin facing +Z (a game player model).',
    flags: { type: 'object', properties: {
      format: { type: 'string', enum: ['glb', 'obj', 'stl'], default: 'glb' }, target: { type: 'string', enum: ['godot', 'web'] },
      texture: { type: 'number', enum: [128, 256, 512, 1024, 2048, 4096] }, bake: { type: 'boolean', default: true }, force: { type: 'boolean', default: false },
      object: { type: 'string' }, out: { type: 'string' }, includeReferences: { type: 'boolean', default: false },
      exclude: { type: 'string', description: 'comma-separated object ids to leave out' }, atOrigin: { type: 'boolean', default: false },
    } },
  },
  {
    name: 'print',
    description: 'Print it (Decision 43): runs the print checks (refuses if any fail, --force true overrides), writes each separate piece as an STL, has Bambu Studio\'s own command line build a project for your printer (Bambu Lab A1 mini 0.4 nozzle, 0.20mm Standard, your PLA preset; laid on the bed and arranged), slices a copy in the background for a time/filament estimate, and opens the project in Bambu Studio. You look at the plate and press Print there; the studio never talks to the printer. If Bambu Studio\'s command line fails, a checked STL opens instead and the result says why. [--object id] [--out path.3mf] [--open false] [--estimate false] [--orient true: let Bambu Studio pick the orientation]',
    flags: { type: 'object', properties: {
      object: { type: 'string' }, out: { type: 'string' }, open: { type: 'boolean', default: true }, estimate: { type: 'boolean', default: true },
      force: { type: 'boolean', default: false }, orient: { type: 'boolean', default: false },
    } },
  },
  {
    name: 'say',
    description: 'Give a character a spoken line (Decision 21): the line is voiced by a local, free text-to-speech model (Kokoro-82M; --voice bm_george, bm_lewis, am_michael, am_adam, af_heart, bf_emma…) or comes from your recording (--audio path.wav), is aligned with the script by Rhubarb Lip Sync, its text is turned into phonemes locally (eSpeak NG) and fitted onto that timing, and becomes smoothed curves for all 15 speech shapes (neighbouring sounds overlap; lips always close on M/B/P, F/V and OO always show; --phonemes false uses only the 9 Rhubarb shapes; --emotion scales how wide the mouth opens: neutral, calm, gentle, firm, happy, excited, angry, sad, scared, whisper). The line also gets seeded blinks, eye darts and brow lifts. One reviewable step; checks report closures, F/V and OO, held shapes and sync. Exports carry it as a "line:<id>" animation clip (speech + blink/brow shape keys, eye and eyelid rotations).',
    flags: { type: 'object', required: ['text'], properties: {
      object: { type: 'string' }, text: { type: 'string', description: 'the words spoken (also the alignment script)' }, id: { type: 'string', description: 'line id (default: from the first words)' },
      voice: { type: 'string', description: 'local voice (Kokoro): bm_george, bm_lewis, am_michael, am_adam, af_heart, bf_emma…' }, audio: { type: 'string', description: 'your own .wav instead of the local voice' }, phonemes: { type: 'boolean', default: true, description: 'false: only the 9 Rhubarb mouth shapes (no phonemizer)' },
      emotion: { type: 'string', enum: ['neutral', 'calm', 'gentle', 'firm', 'happy', 'excited', 'angry', 'sad', 'scared', 'whisper'], default: 'neutral' },
    } },
  },
  {
    name: 'line-preview',
    description: 'Review a character\'s spoken lines: writes a folder with the exported character (GLB with its "line:<id>" clips), the line audio and a player page (click a line: the three.js character speaks it in close-up, in sync with the audio). --video true also renders every frame in headless Chrome and muxes an MP4 with ffmpeg (lines.mp4), plus stills. [--object id] [--out dir]',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, lines: { type: 'string', description: 'comma-separated line ids (default: all)' } } },
  },
  {
    name: 'motion-preview',
    description: 'Review a character\'s motions (walk, run, idle, turn, actions): writes a folder with the exported character (GLB with its motion clips) and a player page where each motion travels at its own speed over half-metre squares, so sliding feet would show. --video true renders an MP4 (motions.mp4) of them all in headless Chrome, plus two stills per motion. [--object id] [--motions walk,idle] [--out dir]',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, motions: { type: 'string', description: 'comma-separated motion ids (default: all)' } } },
  },
  {
    name: 'creature-preview',
    description: 'Review a creature made of rig parts (Decisions 52–54): writes a folder with the exported creature (creature.glb: a node per bone, a clip per motion, the ground) and a three.js player. Baked motions travel at their speed over half-metre squares on the creature\'s own ground; legged and wheeled creatures also get a live segment, steered by the runtime over uneven ground (feet step when out of reach, tyres on springs). Every frame carries the check timeline (red = the frames where a check fails). --video true renders an MP4 plus three stills per segment. --demo-failure true adds a replay with the body moving faster than the feet, to show the timeline catching sliding feet. [--object id] [--motions a,b] [--live false] [--out dir]',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, motions: { type: 'string' }, live: { type: 'boolean', default: true }, demoFailure: { type: 'boolean', default: false } } },
  },
  {
    name: 'cutscene-data',
    description: 'Every cutscene as the timeline the engine players read (shots with camera keys, cues per character, events), with its voices as base64 WAV. `studio game import` uses it.',
    flags: { type: 'object', properties: {} },
  },
  {
    name: 'cutscene-preview',
    description: 'Review a cutscene (Decision 24): writes a folder with the studio scene (GLB with every character\'s clips), the cutscene timeline, the line audio and the three.js cutscene player (the same one web games use), plus storyboard.html — one frame per shot with its framing, lines and the checks (Read the storyboard PNGs to look). --video true also renders every frame in headless Chrome and muxes an MP4 with the voices. --id cutscene [--out dir]',
    flags: { type: 'object', properties: { id: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false } } },
  },
  {
    name: 'run',
    description: 'Code mode: run JavaScript in a QuickJS WASM sandbox with a `studio` API (studio.call(tool,args) or studio.setParam({...}), camelCase per tool) and console.log: --file x.js|x.ts or --code "…". No fs/network; 5 s, 64 MB. Each call is a normal commit. Use for loops/many similar parts.',
    flags: { type: 'object', properties: { file: { type: 'string' }, code: { type: 'string' } } },
  },
];
