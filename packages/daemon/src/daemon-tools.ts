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
        views: { anyOf: [{ type: 'string', description: 'comma-separated, e.g. "front,side,iso" (presentation: "hero,front")' }, { type: 'array', items: { type: 'string', enum: ['front', 'side', 'top', 'iso', 'back', 'hero', 'low'] } }] },
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
    name: 'run',
    description: 'Code mode: run JavaScript in a QuickJS WASM sandbox with a `studio` API (studio.call(tool,args) or studio.setParam({...}), camelCase per tool) and console.log: --file x.js|x.ts or --code "…". No fs/network; 5 s, 64 MB. Each call is a normal commit. Use for loops/many similar parts.',
    flags: { type: 'object', properties: { file: { type: 'string' }, code: { type: 'string' } } },
  },
];
