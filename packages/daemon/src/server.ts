// Engine daemon: owns the Studio, persists it, serves the browser view, and relays
// renders between the CLI (Claude Code via the /studio skill) and the view.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { selectForExport } from '../../core/src/selection.ts';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { runSandboxed } from './sandbox.ts';
import { curvesFromCues, curvesFromVisemeCues, syncOffset, restInSilence, EMOTION_SCALE } from '../../core/src/lipsync.ts';
import { alignPhonemes, ipaTokens, phonemeVisemeCues } from '../../core/src/phonemes.ts';
import { initKernel, Studio, DirAssets, toGLB, toOBJ, toSTL, TOOLS, formatOf, exportGame, validateGlb, afterExport, onAfterExport, type RepoData, type BakeRequest, type BakeResult } from '../../core/src/index.ts';
import { setWorldCacheDir, worldNodes, addTownsToGlb, landmarkObjects, landmarkMeshes, townView } from '../../core/src/world/index.ts';
import { lifeForView, lifeDay } from '../../core/src/life/view.ts';
import { FsIO, RenderCache, renderKey, stamp } from '../../core/src/collab/index.ts';

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
  const limit = Number(process.env.STUDIO_ROUNDTRIP_TIMEOUT_MS ?? 240000);
  let timer: NodeJS.Timeout | undefined;
  const r: any = await Promise.race([
    game.roundTrip(file, engine),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, errors: [`${engine} round-trip timed out after ${Math.round(limit / 1000)} s`] }), limit); }),
  ]).finally(() => clearTimeout(timer));
  const problems = [...(r.errors ?? []), ...(r.warnings ?? [])];
  return { name: `round-trip (${engine})`, ok: r.ok && !problems.length, detail: problems.length ? problems.slice(0, 5).join('; ') : `${r.meshes ?? r.objects?.length ?? '?'} meshes, ${r.triangles ?? '?'} triangles, clean` };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_DIR = path.resolve(HERE, '../../../apps/view');

export { DAEMON_TOOLS } from './daemon-tools.ts';
import { printTool, installFitCalibration } from './print.ts';
import { TimelineService } from './timeline.ts';
import { viewPreview } from './previews.ts';

export interface DaemonOptions { dir: string; port: number; /** serve an existing in-process studio (benches) instead of loading one from dir */ studio?: Studio }

export async function startDaemon({ dir, port, studio: given }: DaemonOptions) {
  await initKernel();
  installFitCalibration();
  const stateDir = path.join(dir, '.studio');
  fs.mkdirSync(path.join(stateDir, 'renders'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'exports'), { recursive: true });
  const repoFile = path.join(stateDir, 'repo.json');
  const data: RepoData | undefined = fs.existsSync(repoFile) ? JSON.parse(fs.readFileSync(repoFile, 'utf8')) : undefined;
  const studio = given ?? new Studio(data, { assets: new DirAssets(path.join(stateDir, 'assets'), dir) });
  setWorldCacheDir(path.join(stateDir, 'cache', 'world'));
  // notes, picks and the project taste file live in .studio (gitignored); studio-wide taste in ~/.studio
  studio.collab.setIO(new FsIO(dir));
  // renders are caches keyed by the recipe that made them (Decision 62): never history, re-made on demand
  const renderCache = new RenderCache(path.join(stateDir, 'cache', 'renders'));
  // the one timeline the view plays (Phase 10 step 2): built from recipes, GLBs and WAVs cached by stamp
  const timelines = new TimelineService(studio, new RenderCache(path.join(stateDir, 'cache', 'timeline'), 200));
  let viewMoment: { seconds: number } | null = null;
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
  // headless capture pages (creature-preview --video, benches) are views too, but they close when the
  // capture ends: renders and bakes go to a person's view first
  const capturePages = new WeakSet<WebSocket>();
  const pickView = (not?: Set<WebSocket>) => {
    const open = [...clients].reverse().filter((c) => c.readyState === 1 && !not?.has(c));
    return open.find((c) => !capturePages.has(c)) ?? open[0];
  };
  const pendingOn = new Map<WebSocket, Set<string>>();     // render ids asked of each view
  const pendingRetry = new Map<string, () => void>();       // render id → ask again elsewhere
  const pendingRenders = new Map<string, (msg: any) => void>();
  const pendingBakes = new Map<string, (msg: any) => void>();
  let renderSeq = 0;
  let broadcastTimer: NodeJS.Timeout | null = null;

  const sendState = (ws?: WebSocket) => {
    // a bad state must never take the whole studio down: log it, keep serving
    let msg: string;
    try { msg = JSON.stringify({ type: 'state', state: studio.snapshot() }); }
    catch (e) { console.error('studio daemon: could not build the view state:', e); return; }
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

  /**
   * Ask a view to render and wait for its answer. A heavy scene on a loaded machine can take a while
   * (first shader compile, a big creature's mesh, the view busy with a timeline): each try waits
   * RENDER_WAIT_MS; a view that closes or stays silent is asked again (another view if there is one,
   * else the same one, whose late answer to the first ask also counts).
   */
  function askView(first: WebSocket, msg: (id: string) => object, tries = 3): Promise<any> {
    const wait = Number(process.env.STUDIO_RENDER_WAIT_MS ?? 45000);
    return new Promise((resolve) => {
      const ids: string[] = [];
      const tried = new Set<WebSocket>();
      let timer: NodeJS.Timeout | null = null, done = false;
      const finish = (m: any) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        for (const id of ids) { pendingRenders.delete(id); pendingRetry.delete(id); for (const set of pendingOn.values()) set.delete(id); }
        resolve(m);
      };
      const ask = (view: WebSocket | undefined) => {
        if (done) return;
        if (!view || ids.length >= tries) {
          return finish({ error: `the view did not answer a render within ${Math.round((wait * ids.length) / 1000)} s (${ids.length} tries)`, hint: `the view may be busy (a capture, a heavy scene): try again, or open http://localhost:${port} in a visible Chrome tab` });
        }
        const id = `r${++renderSeq}`;
        ids.push(id); tried.add(view);
        pendingRenders.set(id, finish);
        if (!pendingOn.has(view)) pendingOn.set(view, new Set());
        pendingOn.get(view)!.add(id);
        pendingRetry.set(id, () => ask(pickView(tried) ?? pickView()));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => ask(pickView(tried) ?? (view.readyState === 1 ? view : pickView())), wait);
        try { view.send(JSON.stringify(msg(id))); } catch { ask(pickView(tried)); }
      };
      ask(first);
    });
  }

  async function daemonTool(name: string, args: any, author = 'claude'): Promise<any> {
    switch (name) {
      case 'say': {
        // a spoken line: local voice (or your recording) → Rhubarb alignment with the script →
        // smoothed speech-shape curves → one reviewable step (set-line)
        const voice = await import('./voice.ts');
        const doc = studio.doc();
        const obj = studio.findObject(doc, args.object);
        if (obj.semanticType !== 'character') return { ok: false, tool: name, error: `${obj.name} is not a character` };
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, tool: name, error: 'say needs --text (the words spoken)', hint: `studio say --object ${obj.id} --text "Hold still."` };
        const emotion = String(args.emotion ?? 'neutral');
        if (!EMOTION_SCALE[emotion]) return { ok: false, tool: name, error: `unknown emotion "${emotion}"`, hint: `one of ${Object.keys(EMOTION_SCALE).join(', ')}` };
        let wav: Uint8Array, voiceName: string | undefined;
        try {
          if (args.audio) wav = new Uint8Array(fs.readFileSync(path.resolve(dir, String(args.audio))));
          else { voiceName = String(args.voice ?? 'bm_george'); wav = await voice.speak(text, voiceName); }
        } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
        const audio = studio.assets.put(wav, 'wav');
        const tmp = path.join(stateDir, 'assets', audio);
        const wavPath = fs.existsSync(tmp) ? tmp : (() => { const t = path.join(stateDir, `line-${Date.now()}.wav`); fs.writeFileSync(t, wav); return t; })();
        let aligned;
        try { aligned = await voice.align(wavPath, text); } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
        const fps = 30;
        const energy = voice.loudness(wav, 100);
        const cues = restInSilence(aligned.cues, energy, 100);
        // all 15 speech shapes: the text's phonemes (local eSpeak NG), placed in time on Rhubarb's
        // shapes and silences; Rhubarb's 9 shapes alone when the text can't be phonemized
        const ipa = args.phonemes === false ? null : await voice.phonemize(text);
        const phonemes = ipa ? alignPhonemes(ipaTokens(ipa), cues, aligned.duration) : [];
        const curves = phonemes.length
          ? curvesFromVisemeCues(phonemeVisemeCues(phonemes, aligned.duration), aligned.duration, fps, emotion)
          : curvesFromCues(cues, aligned.duration, fps, emotion);
        const sync = syncOffset(curves, fps, energy, 100);
        const id = String(args.id ?? (text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'line'));
        const line = {
          text, audio, ...(voiceName ? { voice: voiceName, voiceLicence: 'Kokoro-82M, Apache-2.0' } : {}), emotion, duration: +aligned.duration.toFixed(3), fps, cues, curves,
          ...(phonemes.length ? { phonemes: phonemes.map(({ mix: _m, ...p }) => p) } : {}),
          aligner: phonemes.length ? 'rhubarb-1.14.0 + espeak-ng phonemes' : 'rhubarb-1.14.0', sync,
        };
        const r = studio.call('set-line', { object: obj.id, id, line }, author);
        if (r.ok) (r as any).result = { ...(r.result as any), audio: `/assets/${audio}`, sync, shapes: [...new Set(cues.map((c) => c.shape))].join('') };
        return r;
      }
      case 'selection': {
        const selection = studio.selection;
        if (!selection) return { ok: true, tool: name, result: { selected: null, note: 'nothing selected — ask the human to click a part in the view, or name it' } };
        const doc = studio.doc();
        const obj = doc.objects[selection.object];
        if (!obj) return { ok: true, tool: name, result: { selected: null, note: 'the selected object no longer exists' } };
        const res = studio.evaluate(obj);
        const part = selection.part ? res.parts.find((p) => p.name === selection!.part) : null;
        const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));
        // a moment address for what's selected (Decision 61): notes and cards point with it
        const address = studio.collab.address('selection', doc);
        return { ok: true, tool: name, result: {
          selected: { object: obj.id, name: obj.name, type: obj.semanticType, part: selection.part, since: selection.time },
          address, words: studio.collab.describe(address, doc),
          part: part ? { name: part.name, min: r4(part.bbox.min), max: r4(part.bbox.max), madeBy: part.ops } : null,
          hint: part ? `edit the op(s) ${part.ops.join(', ')} or the params they use (studio inspect --object ${obj.id})` : `whole object selected — studio inspect --object ${obj.id}`,
        } };
      }
      case 'status':
        return { ok: true, tool: name, result: { dir, port, active: studio.history.data.active, selection: studio.selection, review: studio.collab.stats(), views: clients.size, commits: Object.keys(studio.history.data.commits).length, url: `http://localhost:${port}` } };
      case 'render': {
        const view = pickView();
        if (!view) return { ok: false, tool: name, error: 'no browser view is connected', hint: `open http://localhost:${port} in Chrome so the view can render` };
        const views = typeof args.views === 'string' ? args.views.split(',').map((s: string) => s.trim()) : args.views ?? ['front', 'side', 'iso'];
        // the cache key: the recipe of what is shown (that doc, or one object of it), the look, and how
        const h = studio.history;
        const shown = args.proposal && h.data.proposals[args.proposal] ? h.proposalDoc(h.proposal(args.proposal)) : h.activeDoc();
        const recipe = args.object ? shown.objects[studio.findObject(shown, args.object).id] : { objects: shown.objectOrder.map((k) => shown.objects[k]), look: (shown as any).look ?? null };
        const key = renderKey(stamp(recipe), { views, style: args.style ?? 'labeled', size: args.size ?? null, labels: args.labels ?? true, theme: 'light' });
        const names = views.map((v: string) => `${v}.png`);
        const hit = args.cache === false ? null : renderCache.get(key, names);
        if (hit && args.style === 'presentation') return { ok: true, tool: name, result: { images: hit, cached: true, key, note: 'From the render cache (same recipe as before). Read it to judge the look; share the PNG.' } };
        if (hit) return { ok: true, tool: name, result: { images: hit, cached: true, key, note: 'From the render cache (same recipe as before). Read these PNGs to look; numbers from `studio check` are the authority.' } };
        const style = args.style === 'presentation' ? 'presentation' : 'labeled';
        const viewsFinal = style === 'presentation' && !args.views ? ['hero'] : views;
        const reply = await askView(view, (id) => ({ type: 'render', id, views: viewsFinal, style, size: Math.min(2400, Math.max(256, Number(args.size) || (style === 'presentation' ? 1600 : 768))), labels: style === 'labeled' && args.labels !== false, object: args.object, proposal: args.proposal }));
        if (reply.error) return { ok: false, tool: name, error: reply.error, ...(reply.hint ? { hint: reply.hint } : {}) };
        const when = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const files = reply.images.map((img: { view: string; data: string }) => {
          const bytes = Buffer.from(img.data.replace(/^data:image\/png;base64,/, ''), 'base64');
          renderCache.put(key, `${img.view}.png`, bytes);
          const f = path.join(stateDir, 'renders', `${when}-${reply.id ?? `r${renderSeq}`}-${img.view}.png`);
          fs.writeFileSync(f, bytes);
          return f;
        });
        return { ok: true, tool: name, result: args.style === 'presentation'
          ? { images: files, key, note: 'Presentation render: materials, environment light and soft shadows, no labels. Read it to judge the look; share the PNG.' }
          : { images: files, key, legend: reply.legend, note: 'Read these PNGs to look. Use them for proportion/style only — numbers from `studio check` are the authority.' } };
      }
      case 'print':
        // 3D printing (Decision 43): checks → Bambu Studio project for your printer → opens in the app
        return printTool(studio, dir, stateDir, args);
      case 'export': {
        const doc = studio.doc();
        // a character comes with the props in its hands; --exclude drops objects (and what they hold);
        // --at-origin stands the object at the origin facing +Z
        let items;
        // towns (Decision 27) export with the scene; studio objects a town uses as landmarks export inside it
        const towns = !args.object && doc.world && Object.keys(doc.world.towns ?? {}).length ? doc.world : null;
        const landmarks = towns ? landmarkObjects(towns).filter((id) => doc.objects[id]) : [];
        if (landmarks.length) args.exclude = [...String(args.exclude ?? '').split(',').filter(Boolean), ...landmarks].join(',');
        try { items = selectForExport(studio, doc, { object: args.object, exclude: args.exclude, atOrigin: !!args.atOrigin }); }
        catch (e: any) { return { ok: false, tool: name, error: e.message }; }
        const ids = items.map((i) => i.obj.id);
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
          if (!models.length && !towns) return { ok: false, tool: name, error: 'nothing to export: no finished, non-reference objects' };
          // game checks must be green (pending = still building) unless --force
          const blocking = models.flatMap((i) => studio.checks(i.obj.id, doc).filter((c) => !c.pass && /^(budget-|collision|lod)/.test(c.id)).map((c) => `${i.obj.name}: ${c.label} — ${c.detail}`));
          if (blocking.length && !args.force) return { ok: false, tool: name, error: `game checks not green:\n${blocking.join('\n')}`, hint: 'fix them (studio check), or --force true to export anyway' };
          const bake = args.bake !== false;
          const view = pickView();
          if (bake && !view && models.length) return { ok: false, tool: name, error: 'the texture bake needs the browser view, and none is connected', hint: `open http://localhost:${port} (or --bake false for untextured per-part materials)` };
          let res;
          try {
            res = await exportGame(models, { target, baker: bake ? (req) => bakeViaView(view!, req) : null, evaluateOp: (o, id) => studio.evaluateOp(o, id), ...(args.texture ? { texture: Number(args.texture) } : {}), ...(towns ? { extend: (B: any) => addTownsToGlb(B, worldNodes(towns, landmarkMeshes(studio, doc))) } : {}) });
          } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
          bytes = res.glb;
          const noProfile = models.filter((i) => !i.obj.profile).map((i) => i.obj.name);
          extra = { target, objectsReport: res.objects, ...(res.extended ? { towns: res.extended } : {}), ...(noProfile.length ? { noProfile: `${noProfile.join(', ')}: no game profile, so no budgets were checked (studio set-profile)` } : {}) };
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
      case 'line-preview': case 'motion-preview': case 'creature-preview': case 'cutscene-preview':
        // the separate players are retired: these play on the live view's timeline (and capture it with --video)
        return viewPreview(name, args, { studio, timelines, viewUrl: `http://localhost:${port}`, outDir: (n) => path.join(stateDir, 'exports', n), dir });
      case 'timeline': {
        // the scene timeline for Claude: tracks per system, red stretches, moments (and the view's current moment)
        const play = args.play ? Object.fromEntries(String(args.play).split(',').map((x: string) => x.trim().split(':'))) : undefined;
        try {
          const r = timelines.summary(String(args.branch ?? 'main'), { play, cutscene: args.cutscene }, args.at !== undefined ? Number(args.at) : viewMoment?.seconds, args.object ? { object: studio.findObject(studio.doc(), args.object).id, part: args.part ?? null } : studio.selection ? { object: studio.selection.object, part: studio.selection.part } : undefined);
          return { ok: true, tool: name, summary: `${r.tracks.length} track(s), ${r.seconds} s; ${r.red.length ? `${r.red.length} red stretch(es)` : 'no failed checks'}`, result: { ...r, view: `http://localhost:${port}` } };
        } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
      }
      case 'cutscene-data': {
        // every cutscene as the timeline the engine players read, with its voices (for `studio game import`)
        const doc = studio.doc();
        const { cutsceneTimeline } = await import('../../core/src/cutscene.ts');
        const bundles: any[] = [], errors: string[] = [];
        for (const cs of Object.values((doc as any).cutscenes ?? {}) as any[]) {
          try {
            const timeline = cutsceneTimeline(studio, doc, cs);
            const audio: Record<string, string> = {};
            for (const c of timeline.cues) if (c.audio && !audio[c.audio]) { try { audio[c.audio] = Buffer.from(studio.assets.get(c.audio)).toString('base64'); } catch { /* no audio */ } }
            bundles.push({ timeline, audio });
          } catch (e: any) { errors.push(`${cs.id}: ${e.message}`); }
        }
        return errors.length ? { ok: false, tool: name, error: errors.join('; ') } : { ok: true, tool: name, result: { cutscenes: bundles } };
      }
      case 'game-creatures': {
        // creatures into a game (Decision 52, live IK by default): skinned + extras.ik, else baked clips
        const { exportGameCreatures } = await import('../../core/src/gamecreatures.ts');
        try { return { ok: true, tool: name, result: { creatures: await exportGameCreatures(studio.doc(), path.resolve(dir, String(args.outDir)), { baked: !!args.baked }) } }; }
        catch (e: any) { return { ok: false, tool: name, error: e.message }; }
      }
      case 'game-data': {
        const { gameData } = await import('../../core/src/gamedata.ts');
        try { return { ok: true, tool: name, result: gameData(studio) }; } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
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
        const { tool, args = {}, author = 'claude', why } = JSON.parse(body || '{}');
        const d = await daemonTool(tool, args, author);
        return json(200, d ?? studio.call(tool, args, author, why ? { why } : {}));
      }
      if (url.pathname === '/api/state') return json(200, studio.snapshot());
      if (url.pathname === '/api/town') {
        // one chunk of a town for the live view (Phase 10 step 3): never the whole town on an 8 GB Mac
        const doc: any = url.searchParams.get('branch') === 'main' ? studio.mainDoc() : studio.doc();
        const name = url.searchParams.get('name') ?? Object.keys(doc.world?.towns ?? {})[0];
        const spec = name ? doc.world?.towns?.[name] : null;
        if (!spec) return json(404, { ok: false, error: `no town "${name ?? ''}"` });
        const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
        const cx = num('cx'), cz = num('cz');
        const tv = townView(spec, doc.world, landmarkMeshes(studio, doc), { ...(cx !== undefined && cz !== undefined ? { center: [cx, cz] } : {}), ...(num('radius') ? { radius: num('radius') } : {}), ...(num('max') ? { maxBuildings: num('max') } : {}) });
        return json(200, { ok: true, ...tv });
      }
      if (url.pathname === '/api/life' || url.pathname === '/api/life/checks') {
        // town life for the view (Phase 10 step 3b): the first town's baked day (capped cast), and its headless day checks
        const doc: any = url.searchParams.get('branch') === 'active' ? studio.doc() : studio.mainDoc();
        try {
          if (url.pathname === '/api/life/checks') {
            const day = lifeDay(doc);
            return json(200, { ok: true, from: day.from, to: day.to, ms: day.ms, checks: day.checks, peak: day.peak, byHour: day.byHour });
          }
          const v = lifeForView(doc);
          return v ? json(200, { ok: true, ...v }) : json(404, { ok: false, error: 'life is not on in this scene (studio life-on)' });
        } catch (e: any) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/font/ui.woff') {
        // the UI kit's OFL font, so the view measures text the way the checks do
        try {
          const f = fileURLToPath(import.meta.resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff'));
          res.writeHead(200, { 'content-type': 'font/woff', 'cache-control': 'max-age=86400' });
          return res.end(fs.readFileSync(f));
        } catch { res.writeHead(404); return res.end('no font'); }
      }
      if (url.pathname === '/api/timeline') {
        const q = url.searchParams;
        const play = q.get('play') ? Object.fromEntries(q.get('play')!.split(',').filter(Boolean).map((x) => x.split(':'))) : undefined;
        const tl = timelines.get(q.get('branch') ?? 'main', { play, ...(q.get('cutscene') ? { cutscene: q.get('cutscene')! } : {}) });
        if (q.get('have') === tl.stamp) return json(200, { same: true, stamp: tl.stamp });
        return json(200, tl);
      }
      if (url.pathname.startsWith('/api/timeline/asset/')) {
        const a = timelines.asset(url.pathname.slice(20));
        if (!a) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': a.type, 'cache-control': 'max-age=3600' });
        return res.end(Buffer.from(a.bytes));
      }
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
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    if (/[?&]capture=1/.test(req.url ?? '') || /Headless/i.test(String(req.headers['user-agent'] ?? ''))) capturePages.add(ws);
    sendState(ws);
    ws.on('close', () => {
      clients.delete(ws);
      // renders this view was asked for go to another view now, not after a timeout
      const ids = [...(pendingOn.get(ws) ?? [])];
      pendingOn.delete(ws);
      for (const id of ids) { const retry = pendingRetry.get(id); pendingRetry.delete(id); retry?.(); }
    });
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'call') {
        const r = studio.call(m.tool, m.args ?? {}, 'human', m.why ? { why: String(m.why) } : {});
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
        if (m.seconds !== undefined) viewMoment = { seconds: Number(m.seconds) };
        studio.selection = m.object ? { object: String(m.object), part: m.part ? String(m.part) : null, ...(m.clock ? { clock: m.clock, seconds: Number(m.seconds ?? 0), ...(m.near ? { near: String(m.near) } : {}) } : {}), time: new Date().toISOString() } : null;
      } else if (m.type === 'bake-result') {
        pendingBakes.get(m.id)?.(m);
        pendingBakes.delete(m.id);
      } else if (m.type === 'render-result') {
        pendingRenders.get(m.id)?.(m);
        pendingRenders.delete(m.id);
        pendingRetry.delete(m.id);
      }
    });
  });

  // tool calls (a video capture of a heavy creature) can run for many minutes: no request timeout
  server.requestTimeout = 0;
  // the port taken shows up on the WebSocket server too: report it once, through listen's rejection
  wss.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: any) => reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`port ${port} is already in use (another studio daemon?) — not starting a second one`), { code: 'EADDRINUSE' }) : e));
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, studio, url: `http://localhost:${port}` };
}
