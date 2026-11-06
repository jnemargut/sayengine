#!/usr/bin/env node
// `studio` CLI — the hands of the /studio Claude Code skill (Decision 5, custom).
// Every command is a typed tool from @studio/core, sent to the local engine daemon.
// Output is JSON on stdout; exit code 1 when the tool reports an error.
import { BASE, PORT, DIR, healthy, ensureDaemon, callTool } from './client.ts';

function parseFlags(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" — use --flag value (quote values with spaces)`);
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let raw: string;
    if (eq > 0) raw = a.slice(eq + 1);
    else if (i + 1 < argv.length && !/^--[a-zA-Z]/.test(argv[i + 1])) raw = argv[++i];
    else raw = 'true';
    let val: unknown = raw;
    if (/^[\[{"]|^-?\.?\d|^(true|false|null)$/.test(raw)) { try { val = JSON.parse(raw.replace(/^(-?)\./, '$10.')); } catch { val = raw; } }
    if (key === 'json' && val && typeof val === 'object') Object.assign(out, val);
    else out[key] = val;
  }
  return out;
}

function closest(word: string, list: string[]): string[] {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return list.map((n) => [n, d(word, n) - (n.includes(word) || word.includes(n) ? 2 : 0)] as const).sort((x, y) => x[1] - y[1]).filter(([, s]) => s <= 3).slice(0, 3).map(([n]) => n);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { TOOLS, toolsHelp, toolByName } = await import('../core/src/tools.ts');
  const { DAEMON_TOOLS } = await import('../daemon/src/daemon-tools.ts');
  const allNames = [...TOOLS.map((t) => t.name), ...DAEMON_TOOLS.map((t) => t.name), 'serve', 'stop', 'help', 'mcp', 'install-skills', 'world-fetch', 'proof', 'look', 'sound', 'reel'];

  if (!cmd || cmd === 'help' || cmd === '--help') {
    const one = rest[0] && (toolByName(rest[0]) ?? DAEMON_TOOLS.find((t) => t.name === rest[0]));
    if (one) return printToolHelp(rest[0]);
    console.log(`studio — AI-first 3D studio CLI (view: http://localhost:${PORT})
usage: studio <command> [--flag value]…   values are JSON when they look like JSON
       studio <command> --json '{"key": "value"}'
       studio <command> --help             full schema for one command
       studio <command> … --why "slower"   the word note this step answers (shown on the step in review)
       studio notes [list|add|on-it|done|reopen|stale|repin|refresh]   the notes inbox (--text, --at, --id)
       studio taste [list|add|learn]       the taste file (add needs --said true: the user said it outright)
${toolsHelp()}

[daemon]
${DAEMON_TOOLS.map((t) => `  ${t.name.padEnd(17)} ${t.description}`).join('\n')}
  serve             Start the engine daemon in the foreground (normally auto-started).
  stop              Stop the daemon.
  mcp               Run the MCP adapter on stdio (same tools, for other agents).
  install-skills    Link /x-decide-gaming and the game skills into ~/.claude/skills (--copy, --all, --bin <dir>).
  world-fetch       Fetch and cache open data for an area: --name <area> --bbox west,south,east,north (Overture
                    buildings, USGS 3DEP ground, OSM streets/water/parks → .studio/cache/world/<area>). Then world-town.
  proof <cmd>       Pinned views in Godot + web, FLIP diffs, budgets, imitated phone (studio proof help).
  look board|ab|pick  The look's gates on the rendered views (colourfulness, palette, local style score), an
                    A | B sheet, and logged A/B picks (looks are never scored out of 10).
  sound <cmd>       Game sounds from settings, ambience beds, seeded music stems, CC0 library, sound packs
                    for Godot + web, listening reports, licences and credits (studio sound help).
  reel <cmd>        Trailers as cutscene files cut to the beat: music, capture (Godot movie mode / web fixed
                    step), cut (16:9, 1:1, 9:16 via ffmpeg recipes), release checks (studio reel help).

[game]  (studio game <command> --help for flags)
  game init         Create a game project (Godot or web/three.js) under games/<name>.
  game import       Export the studio scene into the game and round-trip it through the engine.
  game run          Run the game headlessly; report what loaded plus engine warnings/errors.
  game screenshot   Render the running game; returns PNG paths to Read.
  game walk-to      Play-test: walk a capsule player to an object; reached / blocked / path.
  game test         Engine-side assertions (exists, grounded, on, count, reachable) + test scripts.
  game status       Game projects here and which engines are available.`);
    return;
  }
  if (rest[0] === 'help' && (cmd === 'notes' || cmd === 'taste')) return printToolHelp(cmd);
  if (rest.includes('--help') && cmd !== 'game' && !cmd.startsWith('game-') && cmd !== 'install-skills' && cmd !== 'world-fetch' && cmd !== 'proof' && cmd !== 'look' && cmd !== 'sound' && cmd !== 'reel') return printToolHelp(cmd);
  if (cmd === 'serve') {
    const { startDaemon } = await import('../daemon/src/server.ts');
    const flags = parseFlags(rest);
    const port = Number(flags.port ?? PORT);
    try {
      const { url } = await startDaemon({ dir: DIR, port });
      console.log(`studio daemon: ${url}  (project ${DIR})`);
    } catch (e: any) {
      console.error(`studio daemon: ${e.message}`);
      process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
    }
    return;
  }
  if (cmd === 'mcp') { await import('../mcp/server.ts'); return; }
  if (cmd === 'install-skills') {
    const flags = parseFlags(rest);
    if (flags.help) { console.log(JSON.stringify({ command: 'install-skills', description: 'Link the game planning skills (/x-decide-gaming and its four children) into ~/.claude/skills so they work in any folder.', flags: { '--dest': 'skills folder (default ~/.claude/skills)', '--copy': 'copy instead of link', '--all': 'also /studio and /game', '--force': 'replace existing entries not linked to this repo', '--bin': 'also link the studio launcher into this folder (e.g. ~/bin)' } }, null, 2)); return; }
    const { installSkills } = await import('./install-skills.ts');
    const body = installSkills({ dest: flags.dest as string | undefined, copy: !!flags.copy, all: !!flags.all, force: !!flags.force, bin: flags.bin as string | undefined });
    console.log(JSON.stringify(body, null, 2));
    if (!body.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'world-fetch') {
    const flags = parseFlags(rest);
    if (flags.help || !flags.name || !flags.bbox) { console.log(JSON.stringify({ command: 'world-fetch', description: 'Fetch and cache the open data for an area once (Decision 27): Overture buildings (the free overturemaps CLI), USGS 3DEP ground heights and OpenStreetMap streets, water and parks. Cached under .studio/cache/world/<name>; rebuilds never touch the network. Credits: ODbL (OSM, Overture), public domain (USGS).', flags: { '--name': 'area name, e.g. raleigh-fayetteville', '--bbox': 'west,south,east,north in degrees (a few blocks; < 5 km)', '--spacing': 'ground sample spacing in metres (default 6)', '--force': 'fetch again even when cached' }, example: 'studio world-fetch --name raleigh-fayetteville --bbox=-78.6420,35.7738,-78.6360,35.7792' }, null, 2)); if (!flags.help) process.exitCode = 1; return; }
    process.env.STUDIO_DIR ??= DIR;
    const { fetchArea } = await import('../core/src/world/fetch.ts');
    try { console.log(JSON.stringify({ ok: true, tool: 'world-fetch', result: await fetchArea(String(flags.name), flags.bbox as any, { spacing: flags.spacing as number | undefined, force: !!flags.force }) }, null, 2)); }
    catch (e: any) { console.log(JSON.stringify({ ok: false, tool: 'world-fetch', error: e.message, ...(e.hint ? { hint: e.hint } : {}) }, null, 2)); process.exitCode = 1; }
    return;
  }
  if (cmd === 'proof' || cmd === 'look') {
    const { proofCli } = await import('../proof/src/cli.ts');
    // studio look board|ab|pick = studio proof look-board|look-ab|look-pick
    const body = await proofCli(cmd === 'look' ? (rest.length && !['help', '--help'].includes(rest[0]) ? [`look-${rest[0]}`, ...rest.slice(1)] : ['help']) : rest, parseFlags);
    console.log(JSON.stringify(body, null, 2));
    if (body.ok === false) process.exitCode = 1;
    return;
  }
  if (cmd === 'sound' || cmd === 'reel') {
    const body = cmd === 'sound' ? await (await import('../sound/src/cli.ts')).soundCli(rest, parseFlags) : await (await import('../reel/src/cli.ts')).reelCli(rest, parseFlags);
    console.log(JSON.stringify(body, null, 2));
    if (body.ok === false) process.exitCode = 1;
    return;
  }
  if (cmd === 'game' || cmd.startsWith('game-')) {
    const { gameCli } = await import('./game.ts');
    const body = await gameCli(cmd, rest, parseFlags, closest);
    console.log(JSON.stringify(body, null, 2));
    if (body.ok === false) process.exitCode = 1;
    return;
  }
  if (cmd === 'stop') {
    if (!(await healthy())) { console.log(JSON.stringify({ ok: true, stopped: false, note: 'daemon was not running' })); return; }
    try { await fetch(`${BASE}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* exiting */ }
    for (let i = 0; i < 20 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    console.log(JSON.stringify({ ok: true, stopped: true }));
    return;
  }
  if (!allNames.includes(cmd)) {
    const near = closest(cmd, allNames);
    console.log(JSON.stringify({ ok: false, error: `unknown command "${cmd}"`, didYouMean: near, hint: '`studio help` lists every command' }, null, 2));
    process.exitCode = 1;
    return;
  }
  // studio notes add --text …  /  studio taste add …: the first word is the action
  const restArgs = (cmd === 'notes' || cmd === 'taste') && rest[0] && !rest[0].startsWith('--') ? ['--action', rest[0], ...rest.slice(1)] : rest;
  const args = parseFlags(restArgs);
  // --why "slower": the word note a step answers (Decision 62); it rides on the step, not the tool
  const why = typeof args.why === 'string' ? args.why : undefined;
  delete args.why;
  const tool = toolByName(cmd);
  const dtool = DAEMON_TOOLS.find((t) => t.name === cmd);
  if (tool || dtool) {
    const known = tool ? Object.keys(tool.input.shape) : Object.keys(dtool!.flags.properties);
    const unknown = Object.keys(args).filter((k) => !known.includes(k));
    if (unknown.length) {
      console.log(JSON.stringify({
        ok: false, tool: cmd,
        error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`,
        didYouMean: Object.fromEntries(unknown.map((u) => [`--${u}`, closest(u, known).map((k) => `--${k}`)])),
        flags: known.map((k) => `--${k}`),
        hint: cmd === 'add-op' || cmd === 'set-op' ? `op arguments go inside --args, e.g. --args '{"${unknown[0]}": …}' — see studio ${cmd} --help` : `studio ${cmd} --help`,
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  const note = await ensureDaemon();
  if (note) process.stderr.write(`studio: ${note}\n`);
  const body = await callTool(cmd, args, undefined, why);
  console.log(JSON.stringify(body, null, 2));
  if (!body.ok) process.exitCode = 1;
}

async function printToolHelp(name: string) {
  const { toolByName, OP_REFERENCE } = await import('../core/src/tools.ts');
  const { DAEMON_TOOLS } = await import('../daemon/src/daemon-tools.ts');
  const { z } = await import('zod');
  const t = toolByName(name);
  if (t) {
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as any;
    const flags = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]: [string, any]) => [`--${k}`, { ...v, required: (schema.required ?? []).includes(k) || undefined }]));
    console.log(JSON.stringify({ command: name, mode: t.mode, mutates: t.mutates, description: t.description, flags, example: t.example, ...(name === 'add-op' || name === 'set-op' ? { ops: OP_REFERENCE } : {}) }, null, 2));
    return;
  }
  const d = DAEMON_TOOLS.find((x) => x.name === name);
  console.log(JSON.stringify(d ? { command: name, description: d.description, flags: d.flags } : { ok: false, error: `unknown command "${name}"` }, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exitCode = 1;
});
