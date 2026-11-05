// `studio game <cmd>` — the hands of the /game skill. Runs in the CLI process (it drives Godot or
// headless Chrome); only `import` talks to the engine daemon, to export the studio scene as GLB.
import { DIR, ensureDaemon, callTool } from './client.ts';

export async function gameContext() {
  const { DAEMON_TOOLS } = await import('../daemon/src/daemon-tools.ts');
  const exportTool = DAEMON_TOOLS.find((t) => t.name === 'export');
  const supportsTarget = !!exportTool?.flags.properties.target;
  return {
    studioDir: DIR,
    async exportGlb(out: string, object: string | undefined, engine: 'godot' | 'web', opts: { exclude?: string[]; atOrigin?: boolean } = {}) {
      const note = await ensureDaemon();
      if (note) process.stderr.write(`studio: ${note}\n`);
      // Week 1's `export --target godot|web` adds the engine-specific contract; plain GLB until then.
      return callTool('export', { format: 'glb', out, ...(object ? { object } : {}), ...(supportsTarget ? { target: engine } : {}), ...(opts.exclude?.length ? { exclude: opts.exclude.join(',') } : {}), ...(opts.atOrigin ? { atOrigin: true } : {}) });
    },
    async objectInfo(object: string) {
      const note = await ensureDaemon();
      if (note) process.stderr.write(`studio: ${note}\n`);
      const r: any = await callTool('scene', {});
      const objs: any[] = r.result?.objects ?? [];
      const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, ' ').trim();
      const o = objs.find((x) => x.id === object) ?? objs.find((x) => norm(x.name) === norm(object));
      return o ? { id: o.id, name: o.name, position: o.position, rotation: o.rotation ?? 0, character: o.type === 'character' || o.semanticType === 'character' } : null;
    },
    async cutscenes() {
      if (!DAEMON_TOOLS.some((t) => t.name === 'cutscene-data')) return [];
      const r: any = await callTool('cutscene-data', {});
      if (!r.ok) throw new Error(`cutscenes: ${r.error}`);
      return r.result?.cutscenes ?? [];
    },
    async studioCall(tool: string, args: Record<string, unknown>) {
      const r: any = await callTool(tool, args);
      return { ok: !!r.ok, error: r.error, result: r.result };
    },
    async gameData() {
      if (!DAEMON_TOOLS.some((t) => t.name === 'game-data')) return null;
      const r: any = await callTool('game-data', {});
      if (!r.ok) throw new Error(`effects, UI and lines: ${r.error}`);
      return r.result ?? null;
    },
  };
}

/** Returns the JSON to print. `argv` is everything after `game` (or after `game-<cmd>`). */
export async function gameCli(cmd: string, argv: string[], parseFlags: (a: string[]) => Record<string, unknown>, closest: (w: string, l: string[]) => string[]): Promise<any> {
  const { GAME_TOOLS, gameTool, runGame } = await import('../game/src/index.ts');
  const sub = cmd === 'game' ? argv.shift() : cmd.slice(5);
  const names = GAME_TOOLS.map((t) => t.name.slice(5));
  if (!sub || sub === 'help' || sub === '--help') {
    return { ok: true, usage: 'studio game <command> [--flag value]…  (also: studio game-<command>)', commands: Object.fromEntries(GAME_TOOLS.map((t) => [t.name.slice(5), t.description])), examples: GAME_TOOLS.map((t) => t.example) };
  }
  const tool = gameTool(sub);
  if (!tool) return { ok: false, error: `unknown game command "${sub}"`, didYouMean: closest(sub, names), commands: names };
  if (argv.includes('--help')) return { command: `game ${sub}`, description: tool.description, flags: Object.fromEntries(Object.entries(tool.flags.properties).map(([k, v]) => [`--${k}`, { ...v, required: tool.flags.required?.includes(k) || undefined }])), example: tool.example };
  const args = parseFlags(argv);
  const known = Object.keys(tool.flags.properties);
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, tool: tool.name, error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`, didYouMean: Object.fromEntries(unknown.map((u) => [`--${u}`, closest(u, known).map((k) => `--${k}`)])), flags: known.map((k) => `--${k}`), hint: `studio game ${sub} --help` };
  const missing = (tool.flags.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) return { ok: false, tool: tool.name, error: `missing ${missing.map((m) => `--${m}`).join(', ')}`, example: tool.example };
  return runGame(tool.name, args as any, await gameContext());
}
