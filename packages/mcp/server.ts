// MCP adapter (Decision 5, "optional later"): the same registry, served over MCP stdio so
// agents other than Claude Code's /studio skill can drive the studio. Generated, not hand-kept:
// tool list + JSON Schemas come from @studio/core TOOLS and DAEMON_TOOLS.
//
//   claude mcp add studio -- node /path/to/AI3DModel/packages/cli/studio.ts mcp
//   (or any MCP client: command `node packages/cli/studio.ts mcp`, cwd = your project)
import readline from 'node:readline';
import fs from 'node:fs';
import { z } from 'zod';
import { TOOLS } from '../core/src/tools.ts';
import { DAEMON_TOOLS } from '../daemon/src/daemon-tools.ts';
import { ensureDaemon, callTool } from '../cli/client.ts';
import { GAME_TOOLS } from '../game/src/tools.ts';

const PROTOCOL = '2025-06-18';

const tools = [
  ...TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as any;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description + (t.example ? `\nCLI equivalent: ${t.example}` : ''),
      inputSchema: schema,
      annotations: { readOnlyHint: !t.mutates, destructiveHint: false, idempotentHint: !t.mutates },
    };
  }),
  ...DAEMON_TOOLS.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.flags,
    annotations: { readOnlyHint: t.name === 'selection' || t.name === 'status' || t.name === 'render' },
  })),
  ...GAME_TOOLS.map((t) => ({
    name: t.name, description: `${t.description}\nCLI equivalent: ${t.example}`, inputSchema: t.flags,
    annotations: { readOnlyHint: t.name === 'game-status' || t.name === 'game-screenshot', destructiveHint: false },
  })),
];

const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id: unknown, result: object) => send({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m: any) {
  const { id, method, params } = m;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-3d-studio', version: '0.2.0' },
        instructions: 'AI-first 3D studio. Units: meters, degrees, Y-up, floor y=0. Loop: new-object → set-params → add-op (call `ops` for the vocabulary) → check after every change → render (needs the browser view open at http://localhost:4517) and Read the PNGs → fix. Use propose for alternatives the human should review. Checks are the authority; images advise.',
      });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools });
    case 'tools/call': {
      const name = params?.name;
      if (!tools.find((t) => t.name === name)) return fail(id, -32602, `unknown tool ${name}`);
      try {
        let r: any;
        if (name.startsWith('game-')) {
          const { runGame } = await import('../game/src/index.ts');
          const { gameContext } = await import('../cli/game.ts');
          r = await runGame(name, params?.arguments ?? {}, await gameContext());
        } else {
          await ensureDaemon();
          r = await callTool(name, params?.arguments ?? {}, process.env.STUDIO_AUTHOR ?? 'mcp');
        }
        const content: any[] = [{ type: 'text', text: JSON.stringify(r, null, 2) }];
        if ((name === 'render' || name === 'game-screenshot' || name === 'game-walk-to') && r.ok) {
          for (const im of r.result?.images ?? []) {
            const f = typeof im === 'string' ? im : im.file;
            try { content.push({ type: 'image', mimeType: 'image/png', data: fs.readFileSync(f).toString('base64') }); } catch { /* path still in text */ }
          }
        }
        return reply(id, { content, isError: !r.ok });
      } catch (e: any) {
        return reply(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true });
      }
    }
    default:
      if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m: any;
  try { m = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  handle(m).catch((e) => fail(m?.id ?? null, -32603, e.message));
});
