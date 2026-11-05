// Creature preview (Decisions 52–54 review): a self-contained folder with the exported creature (GLB,
// one clip per motion, plus the ground), a three.js page that plays each baked motion over its ground
// and live runtime segments, with the check timeline on every frame; optionally an MP4 rendered frame
// by frame in headless Chrome, plus stills.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../game/src/web.ts';
import { STUDIO_ROOT } from '../../../game/src/project.ts';
import { withPage } from '../../../game/src/chrome.ts';
import { bakeCreature, buildCreature, creatureChecks, type CreatureDef, type CreatureMotion, type TerrainSpec } from '../../../core/src/rigparts.ts';
import { creatureGLB, swayGodotShader } from '../../../core/src/creatures.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface LiveSegment { id: string; label: string; show: number; input: { speed: number; turn?: number; strafe?: [number, number, number]; turnWave?: number }; layer?: string; terrain?: TerrainSpec }
export interface CreaturePreviewOpts {
  motions?: string[];                                  // which baked motions (default: all)
  live?: LiveSegment[];                                // runtime segments
  broken?: Array<{ id: string; motion: string; label: string; travelScale: number }>;   // deliberately wrong replays, to show the timeline catching them
  view?: { dist?: number; height?: number; side?: number };
}
export interface CreaturePreviewResult { dir: string; page: string; glb: string; video?: string; frames?: number; seconds?: number; stills?: string[]; note?: string; checks: Record<string, { pass: boolean; failing: string[] }> }

export async function buildCreaturePreview(outDir: string, def: CreatureDef, motions: Record<string, CreatureMotion>, opts: CreaturePreviewOpts = {}): Promise<CreaturePreviewResult & { segments: any[] }> {
  fs.mkdirSync(outDir, { recursive: true });
  const c = buildCreature(def);
  const ids = opts.motions ?? Object.keys(motions);
  const clips = ids.map((id) => { if (!motions[id]) throw new Error(`no motion ${id}`); return bakeCreature(c, id, motions[id]); });
  const checks = Object.fromEntries(clips.map((cl) => [cl.id, creatureChecks(c, cl)]));
  // the GLB as engines get it (ground included, as its own node); the page builds its own ground to the travel's length
  const glb = creatureGLB(c, clips, { terrain: { size: 6 }, checks });
  fs.writeFileSync(path.join(outDir, 'creature.glb'), glb);
  const showOf = (d: number) => Math.max(4, Math.min(10, d * 2));
  const segments: any[] = clips.map((cl) => ({
    id: cl.id, motion: cl.id, label: `${def.name}: ${cl.id}${cl.speed ? `, ${cl.speed.toFixed(2)} m/s` : ''}`, show: showOf(cl.duration),
    duration: cl.duration, frames: cl.frames, loop: cl.loop, speed: cl.speed, dir: cl.dir, checks: checks[cl.id],
  }));
  for (const b of opts.broken ?? []) {
    const cl = clips.find((x) => x.id === b.motion)!;
    const k = creatureChecks(c, { ...cl, speed: cl.speed * b.travelScale });
    segments.push({ id: b.id, motion: cl.id, label: b.label, show: showOf(cl.duration) * 0.6, duration: cl.duration, frames: cl.frames, loop: true, speed: cl.speed, dir: cl.dir, travelScale: b.travelScale, checks: k });
  }
  for (const l of opts.live ?? []) segments.push({ id: l.id, label: l.label, show: l.show, live: { input: l.input, layer: l.layer, terrain: l.terrain }, checks: [] });
  fs.writeFileSync(path.join(outDir, 'creature.json'), JSON.stringify({ name: def.name, glb: 'creature.glb', def, motions, terrain: def.terrain, segments, view: opts.view }, null, 1));
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(outDir, 'index.html'));
  // shader sway parts: the Godot shader beside the GLB (the web player applies the same formula)
  for (const p of def.parts) if (p.kind === 'sway' && p.mode === 'shader') fs.writeFileSync(path.join(outDir, `${p.id}.sway.gdshader`), swayGodotShader(p));
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({ entryPoints: [path.join(HERE, 'main.ts')], outfile: path.join(outDir, 'player.js'), bundle: true, minify: true, format: 'esm', target: 'es2022', nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent' });
  } catch (e: any) { throw new Error(`could not bundle the creature player: ${(e.errors ?? [{ text: e.message }]).map((x: any) => x.text).join('; ')}`); }
  return {
    dir: outDir, page: path.join(outDir, 'index.html'), glb: path.join(outDir, 'creature.glb'), segments,
    checks: Object.fromEntries(Object.entries(checks).map(([id, ks]) => [id, { pass: ks.every((k) => k.pass), failing: ks.filter((k) => !k.pass).map((k) => k.name) }])),
  };
}

export async function captureCreatureVideo(outDir: string, segments: Array<{ id: string; show: number }>, opts: { width?: number; height?: number; fps?: number; keepFrames?: boolean; name?: string } = {}) {
  const W = opts.width ?? 1280, H = opts.height ?? 720, fps = opts.fps ?? 30;
  const frameDir = path.join(outDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const segs: Array<{ id: string; start: number; end: number }> = [];
  let t = 0;
  for (const s of segments) { segs.push({ id: s.id, start: t, end: t + s.show }); t += s.show; }
  const total = t, n = Math.ceil(total * fps);
  await serve(outDir, (url) => withPage(`${url}index.html?capture=1&w=${W}&h=${H}`, { width: W, height: H }, async (page) => {
    for (let i = 0; i < 300; i++) { if (await page.eval('!!window.__ready', 5000).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!(await page.eval('!!window.__ready'))) throw new Error(`creature player did not start: ${page.logs.map((l) => l.text).join('; ')}`);
    for (let f = 0; f < n; f++) {
      const tt = f / fps;
      const s = segs.find((x) => tt >= x.start && tt < x.end) ?? segs[segs.length - 1];
      const url64: string = await page.eval(`window.__frame(${JSON.stringify(s.id)}, ${(tt - s.start).toFixed(4)})`, 30000);
      fs.writeFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), Buffer.from(url64.split(',')[1], 'base64'));
    }
  }));
  const stillDir = path.join(outDir, 'stills');
  fs.rmSync(stillDir, { recursive: true, force: true });
  fs.mkdirSync(stillDir, { recursive: true });
  const stills: string[] = [];
  for (const s of segs) for (const [k, u] of [['a', 0.2], ['b', 0.55], ['c', 0.9]] as const) {
    const f = Math.min(n - 1, Math.round((s.start + (s.end - s.start) * u) * fps));
    const dst = path.join(stillDir, `${s.id}-${k}.png`);
    fs.copyFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.png`), dst);
    stills.push(dst);
  }
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) return { frames: n, seconds: total, stills, note: 'ffmpeg not found: frames are in frames/' };
  const video = path.join(outDir, `${opts.name ?? 'creature'}.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  return { video, frames: n, seconds: +total.toFixed(2), stills };
}
