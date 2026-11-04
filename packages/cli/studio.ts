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
  const allNames = [...TOOLS.map((t) => t.name), ...DAEMON_TOOLS.map((t) => t.name), 'serve', 'stop', 'help', 'mcp'];

  if (!cmd || cmd === 'help' || cmd === '--help') {
    const one = rest[0] && (toolByName(rest[0]) ?? DAEMON_TOOLS.find((t) => t.name === rest[0]));
    if (one) return printToolHelp(rest[0]);
    console.log(`studio — AI-first 3D studio CLI (view: http://localhost:${PORT})
usage: studio <command> [--flag value]…   values are JSON when they look like JSON
       studio <command> --json '{"key": "value"}'
       studio <command> --help             full schema for one command
${toolsHelp()}

[daemon]
${DAEMON_TOOLS.map((t) => `  ${t.name.padEnd(17)} ${t.description}`).join('\n')}
  serve             Start the engine daemon in the foreground (normally auto-started).
  stop              Stop the daemon.
  mcp               Run the MCP adapter on stdio (same tools, for other agents).`);
    return;
  }
  if (rest.includes('--help')) return printToolHelp(cmd);
  if (cmd === 'serve') {
    const { startDaemon } = await import('../daemon/src/server.ts');
    const flags = parseFlags(rest);
    const port = Number(flags.port ?? PORT);
    const { url } = await startDaemon({ dir: DIR, port });
    console.log(`studio daemon: ${url}  (project ${DIR})`);
    return;
  }
  if (cmd === 'mcp') { await import('../mcp/server.ts'); return; }
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
  const args = parseFlags(rest);
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
  const body = await callTool(cmd, args);
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
