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
        cache: { type: 'boolean', default: true, description: 'renders are cached by the recipe that made them; false re-renders' },
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
    description: 'Play a character\'s spoken lines in the live view (Phase 10: the separate line player is retired): each line is a voice track on the view\'s timeline with its waveform and word moments; the character speaks it in sync (lip sync on the line\'s clip). Returns the view link; --video true captures the real view in headless Chrome to an MP4 with stills.',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, lines: { type: 'string', description: 'comma-separated line ids (default: all)' } } },
  },
  {
    name: 'motion-preview',
    description: 'Play a character\'s motions in the live view, in the scene (Phase 10: the separate motion player is retired): the clip runs on the view\'s timeline with its named moments and the motion checks as red stretches where they fail. Returns the view link; --video true captures the view to an MP4 (frames of the real view, the timeline dock in every frame) with a still at every named moment.',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, motions: { type: 'string', description: 'comma-separated motion ids (default: all)' }, with: { type: 'string', description: 'other scene objects to show beside the character (comma-separated), e.g. the bucket it trips over' }, at: { type: 'string', description: 'JSON [x,y,z]: where the first --with object stands, relative to the character' } } },
  },
  {
    name: 'creature-preview',
    description: 'Play a rig-part creature\'s motions in the live view, in the scene (Phase 10: the separate creature player is retired): each clip on the view\'s timeline, its part and universal checks as red stretches where they fail, its key moments named. Returns the view link and the checks; --video true captures the view to an MP4 with stills at the key moments.',
    flags: { type: 'object', properties: { object: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false }, motions: { type: 'string' }, live: { type: 'boolean', default: true }, demoFailure: { type: 'boolean', default: false } } },
  },
  {
    name: 'timeline',
    description: 'The live view\'s one timeline (Phase 10 step 2): every track (motion clips, voice lines, a cutscene\'s shots, effects, sounds, music) with its clock, named moments and failed motion checks as red stretches (in seconds), plus the moment the view is on as an address (scrub in the view and select a bone or part). --play "blacksmith:strike,apprentice:wave" picks the clips; --cutscene <id> plays a cutscene on the shot clock; --branch p1 a proposal.',
    flags: { type: 'object', properties: { branch: { type: 'string' }, play: { type: 'string' }, cutscene: { type: 'string' }, at: { type: 'number', description: 'scene seconds (default: where the view is)' }, object: { type: 'string' }, part: { type: 'string' } } },
  },
  {
    name: 'cutscene-data',
    description: 'Every cutscene as the timeline the engine players read (shots with camera keys, cues per character, events), with its voices as base64 WAV. `studio game import` uses it.',
    flags: { type: 'object', properties: {} },
  },
  {
    name: 'game-creatures',
    description: 'Every creature in the scene as its own game GLB (what `studio game import` writes to assets/studio/creatures/): skinned with extras.ik for the live legs and reach when it can be (studio/creature_ik.gd), else the node-per-bone baked clips. Returns, per creature, the file, which path it took and why, where it stands, and its motions. --out-dir folder; --baked true forces the baked path.',
    flags: { type: 'object', properties: { outDir: { type: 'string' }, baked: { type: 'boolean', default: false } }, required: ['outDir'] },
  },
  {
    name: 'game-data',
    description: 'What `studio game import` writes besides the GLB (Phase 9): every effect with its position and resolved colours, the UI kit (tokens, HUD layout, icons), and every recorded character line with its audio as base64 WAV.',
    flags: { type: 'object', properties: {} },
  },
  {
    name: 'cutscene-preview',
    description: 'Play a cutscene in the live view on the shot clock (Phase 10: the separate cutscene player is retired): shot markers on the timeline, the camera cutting on them, lines as waveform tracks. Captures the view (an MP4 with --video true; always one still per shot plus storyboard.html with the cutscene checks).',
    flags: { type: 'object', properties: { id: { type: 'string' }, out: { type: 'string' }, video: { type: 'boolean', default: false } } },
  },
  {
    name: 'run',
    description: 'Code mode: run JavaScript in a QuickJS WASM sandbox with a `studio` API (studio.call(tool,args) or studio.setParam({...}), camelCase per tool) and console.log: --file x.js|x.ts or --code "…". No fs/network; 5 s, 64 MB. Each call is a normal commit. Use for loops/many similar parts.',
    flags: { type: 'object', properties: { file: { type: 'string' }, code: { type: 'string' } } },
  },
];
