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

export interface DaemonOptions { dir: string; port: number }

export async function startDaemon({ dir, port }: DaemonOptions) {
  await initKernel();
  installFitCalibration();
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
      case 'print':
        // 3D printing (Decision 43): checks → Bambu Studio project for your printer → opens in the app
        return printTool(studio, dir, stateDir, args);
      case 'export': {
        const doc = studio.doc();
        // a character comes with the props in its hands; --exclude drops objects (and what they hold);
        // --at-origin stands the object at the origin facing +Z
        let items;
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
      case 'line-preview': {
        // the character's lines as a reviewable folder: GLB + audio + player page (+ MP4 with --video)
        const doc = studio.doc();
        const obj = studio.findObject(doc, args.object);
        const all = Object.entries(obj.character?.lines ?? {});
        if (!all.length) return { ok: false, tool: name, error: `${obj.name} has no lines yet`, hint: `studio say --object ${obj.id} --text "…"` };
        const want = args.lines ? String(args.lines).split(',').map((x) => x.trim()) : null;
        const picked = want ? all.filter(([id]) => want.includes(id)) : all;
        if (!picked.length) return { ok: false, tool: name, error: `no line ${want!.join(', ')}`, hint: `lines: ${all.map(([id]) => id).join(', ')}` };
        const res = studio.evaluate(obj);
        if (!res.ok) return { ok: false, tool: name, error: `${obj.name} does not build` };
        const glb = toGLB([{ obj, res }], {});
        const validation = await validateGlb(glb);
        if (!validation.ok) return { ok: false, tool: name, error: `glTF validator: ${validation.errors} error(s)`, result: { validation } };
        const lines = picked.map(([id, l]) => ({ id, text: l.text, emotion: l.emotion, duration: l.duration, cues: l.cues, phonemes: l.phonemes, blinks: l.life?.blinks, wav: studio.assets.get(l.audio) }));
        const out = args.out ? path.resolve(dir, String(args.out)) : path.join(stateDir, 'exports', `${obj.id}-lines`);
        const lp = await import('./lineplayer/make.ts');
        try {
          let r = await lp.buildLinePreview(out, obj.name, glb, lines);
          if (args.video) r = { ...r, ...(await lp.captureVideo(out, lines)) };
          return { ok: true, tool: name, summary: `${lines.length} line(s) of ${obj.name}${r.video ? ` → ${r.video}` : ''}`, result: { ...r, lines: lines.map((l) => l.id), note: `open ${r.page} in a browser (serve the folder, e.g. npx http-server, since it loads files)${r.video ? '; the MP4 plays anywhere' : ''}` } };
        } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
      }
      case 'motion-preview': {
        const doc = studio.doc();
        const obj = studio.findObject(doc, args.object);
        const all = Object.entries(obj.character?.motions ?? {});
        if (!all.length) return { ok: false, tool: name, error: `${obj.name} has no motions`, hint: `studio set-motion --object ${obj.id} --id walk --kind walk` };
        const want = args.motions ? String(args.motions).split(',').map((x) => x.trim()) : null;
        const picked = want ? all.filter(([id]) => want.includes(id)) : all;
        if (!picked.length) return { ok: false, tool: name, error: `no motion ${want!.join(', ')}`, hint: `motions: ${all.map(([id]) => id).join(', ')}` };
        const res = studio.evaluate(obj);
        if (!res.ok || !res.rig) return { ok: false, tool: name, error: `${obj.name} does not build` };
        // the character alone, at the origin and facing +Z, so the page can walk it along its own axis
        const solo = { ...obj, position: [0, 0, 0] as [number, number, number], rotation: 0 };
        // --with: other scene objects to stand beside it (a bucket to trip over), placed relative to the
        // character (--at [x,y,z] for the first, else where they are relative to it)
        const extras = (args.with ? String(args.with).split(',').map((x) => x.trim()).filter(Boolean) : []).map((ref, i) => {
          const o = studio.findObject(doc, ref);
          const at = i === 0 && args.at ? (typeof args.at === 'string' ? JSON.parse(args.at) : args.at) : [o.position[0] - obj.position[0], o.position[1] - obj.position[1], o.position[2] - obj.position[2]];
          const moved = { ...o, position: at as [number, number, number] };
          return { obj: moved, res: studio.evaluate(moved) };
        });
        const glb = toGLB([{ obj: solo, res: studio.evaluate(solo) }, ...extras], {});
        const validation = await validateGlb(glb);
        if (!validation.ok) return { ok: false, tool: name, error: `glTF validator: ${validation.errors} error(s)`, result: { validation } };
        const { bakeMotion } = await import('../../core/src/motion.ts');
        const mp = await import('./motionplayer/make.ts');
        const motions = picked.map(([id, spec]) => {
          const c = bakeMotion(id, spec, res.rig!.rig, obj.character);
          const what = spec.kind === 'action' ? (spec.label ?? spec.action!) : spec.kind;
          return { id, kind: spec.kind, label: `${obj.name}: ${id}${id === what ? '' : ` (${what})`}${c.speed ? `, ${c.speed.toFixed(2)} m/s` : ''}`, duration: c.duration, loop: c.loop, speed: c.speed, show: mp.showTime(c) };
        });
        const out = args.out ? path.resolve(dir, String(args.out)) : path.join(stateDir, 'exports', `${obj.id}-motions`);
        try {
          let r: any = await mp.buildMotionPreview(out, obj.name, glb, motions);
          if (args.video) r = { ...r, ...(await mp.captureMotionVideo(out, motions)) };
          return { ok: true, tool: name, summary: `${motions.length} motion(s) of ${obj.name}${r.video ? ` → ${r.video}` : ''}`, result: { ...r, motions: motions.map((m) => m.id), note: `open ${r.page} in a browser (serve the folder, e.g. npx http-server)${r.video ? '; Read the stills to look at the poses' : ''}` } };
        } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
      }
      case 'creature-preview': {
        const doc = studio.doc();
        const obj = studio.findObject(doc, args.object);
        if (!obj.creature) return { ok: false, tool: name, error: `${obj.name} is not a creature`, hint: 'studio new-creature --preset crab' };
        const cp = await import('./creatureplayer/make.ts');
        const { def, motions } = obj.creature;
        const want = args.motions ? String(args.motions).split(',').map((x) => x.trim()) : undefined;
        const legs = def.parts.find((p: any) => p.kind === 'legs') as any, wheels = def.parts.some((p: any) => p.kind === 'wheels');
        const walk = Object.entries(motions).find(([, m]: any) => m.kind === 'walk') as any;
        const bumpy = { period: 6, bumps: [{ amp: 0.045, k: 1 }, { amp: 0.03, k: 2, kx: 3 }, { amp: 0.012, k: 7, kx: 5 }] };
        const live: any[] = [];
        if (args.live !== false && legs) live.push({ id: 'live-walk', label: `${def.name}: live, steered in a curve over bumps (runtime)`, show: 8, input: { speed: walk?.[1].speed ?? 0.3, strafe: walk?.[1].dir ?? [0, 0, 1], turn: 16 }, layer: Object.keys(motions).find((k) => motions[k].kind === 'idle'), terrain: bumpy });
        if (args.live !== false && wheels) live.push({ id: 'live-drive', label: `${def.name}: live, steering over bumps (runtime)`, show: 8, input: { speed: 1.4, turn: 18, turnWave: 8 }, terrain: { ...bumpy, bumps: bumpy.bumps.map((b) => ({ ...b, amp: b.amp * 1.4 })) } });
        const broken = args.demoFailure && walk ? [{ id: 'broken-walk', motion: walk[0], label: `${def.name}: ${walk[0]} replayed 1.6× too fast (feet slide: the checks catch it)`, travelScale: 1.6 }] : [];
        const out = args.out ? path.resolve(dir, String(args.out)) : path.join(stateDir, 'exports', `${obj.id}-creature`);
        try {
          let r: any = await cp.buildCreaturePreview(out, def, motions, { motions: want, live, broken });
          const validation = await validateGlb(fs.readFileSync(r.glb));
          if (!validation.ok) return { ok: false, tool: name, error: `glTF validator: ${validation.errors} error(s)`, result: { validation } };
          if (args.video) r = { ...r, ...(await cp.captureCreatureVideo(out, r.segments, { name: obj.id })) };
          const segs = r.segments.map((s: any) => s.id);
          delete r.segments;
          const failing = Object.entries<any>(r.checks).filter(([, v]) => !v.pass).map(([k, v]) => `${k}: ${v.failing.join(', ')}`);
          return { ok: true, tool: name, summary: `${segs.length} segment(s) of ${obj.name}${failing.length ? ` — failing: ${failing.join('; ')}` : ', every motion check passes'}${r.video ? ` → ${r.video}` : ''}`, result: { ...r, segments: segs, note: `open ${r.page} in a browser (serve the folder)${r.video ? '; Read the stills to look' : ''}` } };
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
      case 'game-data': {
        const { gameData } = await import('../../core/src/gamedata.ts');
        try { return { ok: true, tool: name, result: gameData(studio) }; } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
      }
      case 'cutscene-preview': {
        const doc = studio.doc();
        const all = (doc as any).cutscenes ?? {};
        const cs = all[String(args.id ?? '')] ?? (Object.keys(all).length === 1 && !args.id ? Object.values(all)[0] : null);
        if (!cs) return { ok: false, tool: name, error: args.id ? `no cutscene "${args.id}"` : 'which cutscene? --id', hint: `cutscenes: ${Object.keys(all).join(', ') || 'none (studio new-cutscene)'}` };
        const { cutsceneTimeline, cutsceneChecks } = await import('../../core/src/cutscene.ts');
        let tl;
        try { tl = cutsceneTimeline(studio, doc, cs as any); } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
        const checks = cutsceneChecks(studio, doc, cs as any);
        let items;
        try { items = selectForExport(studio, doc, {}); } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
        const glb = toGLB(items.filter((i) => i.obj.role !== 'reference' && i.res.ok), {});
        const validation = await validateGlb(glb);
        if (!validation.ok) return { ok: false, tool: name, error: `glTF validator: ${validation.errors} error(s)`, result: { validation } };
        const audio: Record<string, Uint8Array> = {};
        for (const c of tl.cues) if (c.audio && !audio[c.audio]) { try { audio[c.audio] = studio.assets.get(c.audio); } catch { /* a test line without audio */ } }
        const out = args.out ? path.resolve(dir, String(args.out)) : path.join(stateDir, 'exports', `${(cs as any).id}-cutscene`);
        const cp = await import('./cutsceneplayer/make.ts');
        try {
          const b = await cp.buildCutscenePreview(out, glb, tl, audio);
          const cap = await cp.captureCutscene(out, tl, { video: !!args.video });
          const sb = cp.writeStoryboard(out, tl, cap.boards, checks, { video: cap.video ? path.basename(cap.video) : undefined });
          const failing = checks.filter((c) => !c.pass);
          return { ok: true, tool: name, summary: `${tl.shots.length} shots, ${tl.duration.toFixed(1)} s${cap.video ? ` → ${cap.video}` : ''}${failing.length ? `; ${failing.length} check(s) failing` : ''}`, result: { ...b, storyboard: sb, storyboardFrames: cap.stills, ...(cap.video ? { video: cap.video, frames: cap.frames } : {}), seconds: tl.duration, checks, note: 'Read the storyboard PNGs to look at each shot; open storyboard.html (or the MP4) to review the whole cutscene' } };
        } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
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
        const d = await daemonTool(tool, args, author);
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
