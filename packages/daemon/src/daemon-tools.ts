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
    description: 'Write an asset. Plain: --format glb|obj|stl (GLB keeps PBR materials per part; STL is mm, Z-up for printing). Game: --target godot|web unwraps every part, bakes materials (colour, wood grain, roughness, metalness) into one texture pair per object through the open view, adds collision nodes (Godot -convcolonly; extras.collision for three.js) and distance versions (web: MSFT_lod), and refuses if game checks fail (--force true overrides). --texture px overrides the profile; --bake false skips textures. Every GLB is checked by the Khronos glTF validator (errors = not written). [--object id] [--out path]; references are left out unless --include-references true.',
    flags: { type: 'object', properties: {
      format: { type: 'string', enum: ['glb', 'obj', 'stl'], default: 'glb' }, target: { type: 'string', enum: ['godot', 'web'] },
      texture: { type: 'number', enum: [128, 256, 512, 1024, 2048, 4096] }, bake: { type: 'boolean', default: true }, force: { type: 'boolean', default: false },
      object: { type: 'string' }, out: { type: 'string' }, includeReferences: { type: 'boolean', default: false },
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
    name: 'run',
    description: 'Code mode: run JavaScript in a QuickJS WASM sandbox with a `studio` API (studio.call(tool,args) or studio.setParam({...}), camelCase per tool) and console.log: --file x.js|x.ts or --code "…". No fs/network; 5 s, 64 MB. Each call is a normal commit. Use for loops/many similar parts.',
    flags: { type: 'object', properties: { file: { type: 'string' }, code: { type: 'string' } } },
  },
];
