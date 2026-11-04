// Engine daemon: owns the Studio, persists it, serves the browser view, and relays
// renders between the CLI (Claude Code via the /studio skill) and the view.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { runSandboxed } from './sandbox.ts';
import { initKernel, Studio, DirAssets, toGLB, toOBJ, toSTL, TOOLS, formatOf, exportGame, validateGlb, afterExport, onAfterExport, type RepoData, type BakeRequest, type BakeResult } from '../../core/src/index.ts';

// Game exports (`export --target godot|web`) round-trip through the target engine: any import
// warning or error fails the export (decision 17). Skipped, not failed, when the engine isn't installed;
// STUDIO_ROUNDTRIP=0 turns it off.
onAfterExport(async ({ file, target }) => {
  if (!target || process.env.STUDIO_ROUNDTRIP === '0') return null;
  const engine = target === 'web' ? 'web' : 'godot';
  const game = await import('../../game/src/index.ts');
  const { findGodot } = await import('../../game/src/godot.ts');
  const { findChrome } = await import('../../game/src/chrome.ts');
  if (engine === 'godot' ? !findGodot() : !findChrome()) return { name: `round-trip (${engine})`, ok: true, detail: `skipped: ${engine === 'godot' ? 'Godot' : 'Chrome'} not installed` };
  const r: any = await game.roundTrip(file, engine);
  const problems = [...(r.errors ?? []), ...(r.warnings ?? [])];
  return { name: `round-trip (${engine})`, ok: r.ok && !problems.length, detail: problems.length ? problems.slice(0, 5).join('; ') : `${r.meshes ?? r.objects?.length ?? '?'} meshes, ${r.triangles ?? '?'} triangles, clean` };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_DIR = path.resolve(HERE, '../../../apps/view');

export { DAEMON_TOOLS } from './daemon-tools.ts';

export interface DaemonOptions { dir: string; port: number }

export async function startDaemon({ dir, port }: DaemonOptions) {
  await initKernel();
  const stateDir = path.join(dir, '.studio');
  fs.mkdirSync(path.join(stateDir, 'renders'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'exports'), { recursive: true });
  const repoFile = path.join(stateDir, 'repo.json');
  const data: RepoData | undefined = fs.existsSync(repoFile) ? JSON.parse(fs.readFileSync(repoFile, 'utf8')) : undefined;
  const studio = new Studio(data, { assets: new DirAssets(path.join(stateDir, 'assets'), dir) });
  studio.onPersist = (d) => {
    const tmp = repoFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, repoFile);
  };

  const activityFile = path.join(stateDir, 'activity.jsonl');
  studio.onActivity = (a) => fs.appendFileSync(activityFile, JSON.stringify(a) + '\n');
  if (fs.existsSync(activityFile)) {
    studio.activity = fs.readFileSync(activityFile, 'utf8').trim().split('\n').filter(Boolean).slice(-200).map((l) => JSON.parse(l));
  }

  const clients = new Set<WebSocket>();
  const pendingRenders = new Map<string, (msg: any) => void>();
  const pendingBakes = new Map<string, (msg: any) => void>();
  let renderSeq = 0;
  let selection: { object: string; part: string | null; time: string } | null = null;
  let broadcastTimer: NodeJS.Timeout | null = null;

  const sendState = (ws?: WebSocket) => {
    const msg = JSON.stringify({ type: 'state', state: studio.snapshot() });
    for (const c of ws ? [ws] : clients) if (c.readyState === 1) c.send(msg);
  };
  studio.onChange(() => {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => sendState(), 40);
  });

  /** Ask the open view to paint unwrapped parts into textures (lighting-free, islands dilated). */
  function bakeViaView(view: WebSocket, req: BakeRequest): Promise<BakeResult> {
    const id = `b${++renderSeq}`;
    const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pendingBakes.delete(id); reject(new Error('the view did not finish the texture bake within 90 s')); }, 90000);
      pendingBakes.set(id, (m) => {
        clearTimeout(t);
        if (m.error) return reject(new Error(`bake failed in the view: ${m.error}`));
        const png = (d: string) => new Uint8Array(Buffer.from(d.replace(/^data:image\/png;base64,/, ''), 'base64'));
        resolve({ baseColor: png(m.baseColor), metallicRoughness: png(m.metallicRoughness) });
      });
      view.send(JSON.stringify({ type: 'bake', id, size: req.size, padding: req.padding, parts: req.parts.map((p) => ({ name: p.name, material: p.material, bbox: p.bbox, positions: b64(p.positions), uvs: b64(p.uvs) })) }));
    });
  }

  async function daemonTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'selection': {
        if (!selection) return { ok: true, tool: name, result: { selected: null, note: 'nothing selected — ask the human to click a part in the view, or name it' } };
        const doc = studio.doc();
        const obj = doc.objects[selection.object];
        if (!obj) return { ok: true, tool: name, result: { selected: null, note: 'the selected object no longer exists' } };
        const res = studio.evaluate(obj);
        const part = selection.part ? res.parts.find((p) => p.name === selection!.part) : null;
        const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));
        return { ok: true, tool: name, result: {
          selected: { object: obj.id, name: obj.name, type: obj.semanticType, part: selection.part, since: selection.time },
          part: part ? { name: part.name, min: r4(part.bbox.min), max: r4(part.bbox.max), madeBy: part.ops } : null,
          hint: part ? `edit the op(s) ${part.ops.join(', ')} or the params they use (studio inspect --object ${obj.id})` : `whole object selected — studio inspect --object ${obj.id}`,
        } };
      }
      case 'status':
        return { ok: true, tool: name, result: { dir, port, active: studio.history.data.active, selection, views: clients.size, commits: Object.keys(studio.history.data.commits).length, url: `http://localhost:${port}` } };
      case 'render': {
        const view = [...clients].reverse().find((c) => c.readyState === 1);
        if (!view) return { ok: false, tool: name, error: 'no browser view is connected', hint: `open http://localhost:${port} in Chrome so the view can render` };
        const id = `r${++renderSeq}`;
        const views = typeof args.views === 'string' ? args.views.split(',').map((s: string) => s.trim()) : args.views ?? ['front', 'side', 'iso'];
        const reply = await new Promise<any>((resolve) => {
          const t = setTimeout(() => { pendingRenders.delete(id); resolve({ error: 'view did not answer within 20 s' }); }, 20000);
          pendingRenders.set(id, (m) => { clearTimeout(t); resolve(m); });
          const style = args.style === 'presentation' ? 'presentation' : 'labeled';
          const viewsFinal = style === 'presentation' && !args.views ? ['hero'] : views;
          view.send(JSON.stringify({ type: 'render', id, views: viewsFinal, style, size: Math.min(2400, Math.max(256, Number(args.size) || (style === 'presentation' ? 1600 : 768))), labels: style === 'labeled' && args.labels !== false, object: args.object, proposal: args.proposal }));
        });
        if (reply.error) return { ok: false, tool: name, error: reply.error };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const files = reply.images.map((img: { view: string; data: string }) => {
          const f = path.join(stateDir, 'renders', `${stamp}-${id}-${img.view}.png`);
          fs.writeFileSync(f, Buffer.from(img.data.replace(/^data:image\/png;base64,/, ''), 'base64'));
          return f;
        });
        return { ok: true, tool: name, result: args.style === 'presentation'
          ? { images: files, note: 'Presentation render: materials, environment light and soft shadows, no labels. Read it to judge the look; share the PNG.' }
          : { images: files, legend: reply.legend, note: 'Read these PNGs to look. Use them for proportion/style only — numbers from `studio check` are the authority.' } };
      }
      case 'export': {
        const doc = studio.doc();
        const ids = args.object ? [studio.findObject(doc, args.object).id] : doc.objectOrder;
        const items = ids.map((id) => ({ obj: doc.objects[id], res: studio.evaluate(doc.objects[id]) }));
        const bad = items.filter((i) => !i.res.ok).map((i) => i.obj.name);
        const opts = { includeReferences: !!args.includeReferences };
        const refs = items.filter((i) => i.obj.role === 'reference' && !opts.includeReferences).map((i) => i.obj.name);
        const target: 'godot' | 'web' | undefined = args.target;
        if (target && !['godot', 'web'].includes(target)) return { ok: false, tool: name, error: '--target must be godot or web' };
        const fmt = target ? 'glb' : (args.format ?? 'glb').toLowerCase();
        if (target && args.format && args.format !== 'glb') return { ok: false, tool: name, error: 'game export (--target) writes GLB; drop --format' };
        const base = args.object ? ids[0] : 'scene';
        const out = args.out ? path.resolve(dir, args.out) : path.join(stateDir, 'exports', target ? `${base}.${target}.glb` : `${base}.${fmt}`);
        let bytes: Uint8Array;
        let extra: Record<string, unknown> = {};
        if (target) {
          const models = items.filter((i) => i.obj.role !== 'reference' && i.res.ok);
          if (!models.length) return { ok: false, tool: name, error: 'nothing to export: no finished, non-reference objects' };
          // game checks must be green (pending = still building) unless --force
          const blocking = models.flatMap((i) => studio.checks(i.obj.id, doc).filter((c) => !c.pass && /^(budget-|collision|lod)/.test(c.id)).map((c) => `${i.obj.name}: ${c.label} — ${c.detail}`));
          if (blocking.length && !args.force) return { ok: false, tool: name, error: `game checks not green:\n${blocking.join('\n')}`, hint: 'fix them (studio check), or --force true to export anyway' };
          const bake = args.bake !== false;
          const view = [...clients].reverse().find((c) => c.readyState === 1);
          if (bake && !view) return { ok: false, tool: name, error: 'the texture bake needs the browser view, and none is connected', hint: `open http://localhost:${port} (or --bake false for untextured per-part materials)` };
          let res;
          try {
            res = await exportGame(models, { target, baker: bake ? (req) => bakeViaView(view!, req) : null, evaluateOp: (o, id) => studio.evaluateOp(o, id), ...(args.texture ? { texture: Number(args.texture) } : {}) });
          } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
          bytes = res.glb;
          const noProfile = models.filter((i) => !i.obj.profile).map((i) => i.obj.name);
          extra = { target, objectsReport: res.objects, ...(noProfile.length ? { noProfile: `${noProfile.join(', ')}: no game profile, so no budgets were checked (studio set-profile)` } : {}) };
        } else if (fmt === 'glb') bytes = toGLB(items, opts);
        else if (fmt === 'obj') bytes = new TextEncoder().encode(toOBJ(items, opts));
        else if (fmt === 'stl') bytes = toSTL(items, opts);
        else return { ok: false, tool: name, error: 'format must be glb, obj or stl' };
        let validation;
        if (fmt === 'glb') {
          validation = await validateGlb(bytes);
          if (!validation.ok) return { ok: false, tool: name, error: `glTF validator: ${validation.errors} error(s) — not written`, result: { validation } };
        }
        fs.writeFileSync(out, bytes);
        // after-export hooks (the engine round-trip plugs in here); a failing hook fails the export
        const hooks = [];
        for (const h of afterExport) {
          try { const r = await h({ file: out, target: target ?? null, glb: bytes, objects: ids }); if (r) hooks.push(r); }
          catch (e: any) { hooks.push({ name: 'hook', ok: false, detail: e.message }); }
        }
        const hooksOk = hooks.every((h) => h.ok);
        const result = { file: out, bytes: bytes.length, objects: ids.length - bad.length - refs.length, skipped: bad, ...(refs.length ? { referencesLeftOut: refs } : {}), ...(validation ? { validation: { errors: validation.errors, warnings: validation.warnings, ...(validation.messages.length ? { messages: validation.messages } : {}) } } : {}), ...extra, ...(hooks.length ? { afterExport: hooks } : {}) };
        return hooksOk ? { ok: true, tool: name, result } : { ok: false, tool: name, error: `after-export check failed: ${hooks.filter((h) => !h.ok).map((h) => `${h.name}: ${h.detail}`).join('; ')}`, result };
      }
      case 'run': {
        if (!args.file && typeof args.code !== 'string') return { ok: false, tool: name, error: '--file <script.js|.ts> or --code "<js>" is required' };
        const file = args.file ? path.resolve(dir, args.file) : 'inline.js';
        let src = args.file ? fs.readFileSync(file, 'utf8') : args.code;
        if (file.endsWith('.ts')) {
          const mod: any = await import('node:module');
          if (mod.stripTypeScriptTypes) src = mod.stripTypeScriptTypes(src);
        }
        const calls: any[] = [];
        const r = await runSandboxed(src, TOOLS.map((t) => t.name), (tool, a) => {
          const res = studio.call(tool, a, 'script');
          calls.push({ tool, ok: res.ok, summary: res.summary, error: res.error });
          if (!res.ok) throw new Error(res.error);
          return res.result ?? null;
        }, { filename: path.basename(file) });
        return r.ok ? { ok: true, tool: name, result: { calls, logs: r.logs } } : { ok: false, tool: name, error: r.error, result: { calls, logs: r.logs } };
      }
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'POST' && url.pathname === '/api/call') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { tool, args = {}, author = 'claude' } = JSON.parse(body || '{}');
        const d = await daemonTool(tool, args);
        return json(200, d ?? studio.call(tool, args, author));
      }
      if (url.pathname === '/api/state') return json(200, studio.snapshot());
      if (url.pathname.startsWith('/assets/')) {
        const id = url.pathname.slice(8);
        let bytes: Uint8Array;
        try { bytes = studio.assets.get(id); } catch { res.writeHead(404); return res.end('no such asset'); }
        const ext = id.split('.').pop();
        res.writeHead(200, { 'content-type': ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
        return res.end(bytes);
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        // drag-and-drop from the view: save under .studio/uploads, then import as the human
        const name = path.basename(url.searchParams.get('name') ?? 'upload');
        if (!formatOf(name)) return json(400, { ok: false, error: 'drop a .stl, .obj, .glb, .png or .jpg file' });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 200e6) return json(413, { ok: false, error: 'file larger than 200 MB' }); chunks.push(c as Buffer); }
        const up = path.join(stateDir, 'uploads');
        fs.mkdirSync(up, { recursive: true });
        const file = path.join(up, name);
        fs.writeFileSync(file, Buffer.concat(chunks));
        const args: any = { file };
        if (/\.(png|jpe?g)$/i.test(name)) { args.plane = url.searchParams.get('plane') ?? 'front'; args.size = Number(url.searchParams.get('size') ?? 1); }
        return json(200, studio.call('import', args, 'human'));
      }
      if (url.pathname === '/api/health') return json(200, { ok: true, dir });
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        json(200, { ok: true, stopped: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(VIEW_DIR, file);
      if (!full.startsWith(VIEW_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      const type = full.endsWith('.html') ? 'text/html' : full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(full).pipe(res);
    } catch (e: any) {
      json(500, { ok: false, error: e.message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    sendState(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'call') {
        const r = studio.call(m.tool, m.args ?? {}, 'human');
        ws.send(JSON.stringify({ type: 'call-result', id: m.id, result: r }));
      } else if (m.type === 'preview') {
        // live slider scrubbing: evaluate params on a scratch copy of the active branch, no commit
        try {
          const h = studio.history;
          const doc = m.branch && m.branch !== 'main' && h.data.proposals[m.branch] ? h.proposalDoc(h.proposal(m.branch)) : m.branch === 'main' ? h.mainDoc() : h.activeDoc();
          const o = studio.findObject(doc, m.object);
          for (const [k, v] of Object.entries(m.params ?? {})) if (o.params[k] && typeof v === 'number') o.params[k] = { ...o.params[k], value: v };
          studio.resolve(doc);
          ws.send(JSON.stringify({ type: 'preview', id: m.id, objects: studio.pack(doc) }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'preview', id: m.id, error: e.message }));
        }
      } else if (m.type === 'select') {
        selection = m.object ? { object: String(m.object), part: m.part ? String(m.part) : null, time: new Date().toISOString() } : null;
      } else if (m.type === 'bake-result') {
        pendingBakes.get(m.id)?.(m);
        pendingBakes.delete(m.id);
      } else if (m.type === 'render-result') {
        pendingRenders.get(m.id)?.(m);
        pendingRenders.delete(m.id);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, studio, url: `http://localhost:${port}` };
}
