// README sizzle-reel footage: real frames of the studio's live view (the editor with its panels and
// timeline dock), one short MP4 + a representative still per beat, for bench/sizzle/compose.py.
// Each beat builds its scene through the real CLI and daemon in a fresh temp project, then drives the
// view in headless Chrome (window.__timeline setup/frame, as packages/daemon/src/viewcapture.ts does).
// No people: creatures, objects, effects and buildings only.
//   node bench/sizzle/capture.ts [beat …]      beats: vase stool spider octopus bird crab effects town timeline
//   STUDIO_PORT (default 4745), STUDIO_CHROME_PORT (9645), STUDIO_CHROME_SPAN (5)
// Output: bench/sizzle/footage/<beat>.mp4, <beat>.png (gitignored), work files in footage/_work/<beat>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

process.env.STUDIO_PORT ??= '4745';
process.env.STUDIO_CHROME_PORT ??= '9645';
process.env.STUDIO_CHROME_SPAN ??= '5';
const { withPage } = await import('../../packages/game/src/chrome.ts');
const { waitForView } = await import('../../packages/daemon/src/viewcapture.ts');
type Page = Parameters<Parameters<typeof withPage>[2]>[0];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FOOT = path.join(ROOT, 'bench/sizzle/footage');
const W = 1280, H = 720, FPS = 24;
const URL = `http://localhost:${process.env.STUDIO_PORT}`;
const run = promisify(execFile);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(FOOT, { recursive: true });

let proj = '';
const env = () => ({ ...process.env, STUDIO_HOME: path.join(proj, 'home') });
async function studio(...args: string[]): Promise<any> {
  const { stdout } = await run('node', [path.join(ROOT, 'packages/cli/studio.ts'), ...args], { cwd: proj, env: env(), maxBuffer: 64 << 20, timeout: 1200000 });
  const r = JSON.parse(stdout);
  if (!r.ok) throw new Error(`studio ${args[0]}: ${r.error}`);
  console.log(`  ✓ ${(r.summary ?? args[0]).slice(0, 160)}`);
  return r;
}
const J = (v: unknown) => JSON.stringify(v);

/** A fresh project with its own daemon (the Pocket Raleigh plaza cut in its world cache). */
async function project(name: string, fn: () => Promise<void>) {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), `studio-sizzle-${name}-`));
  fs.cpSync(path.join(ROOT, 'packages/core/test/fixtures/world'), path.join(proj, '.studio/cache/world'), { recursive: true });
  try { await studio('status'); await fn(); }
  finally { try { await studio('stop'); } catch { /* not running */ } fs.rmSync(proj, { recursive: true, force: true }); }
}

interface Seg { frameAt?: number; id: string; seconds?: number; play?: Record<string, string>; focus?: string; solo?: boolean; show?: string[]; select?: { object: string; part?: string }; from?: number; dir?: [number, number, number]; fill?: number }

/** One headless page on the view (retried once: a loaded machine can time a capture out). */
async function view<T>(fn: (p: Page) => Promise<T>): Promise<T> {
  const go = () => withPage(`${URL}/?capture=1&theme=light`, { width: W, height: H }, async (p) => { await waitForView(p); return fn(p); });
  try { return await go(); } catch (e: any) { console.log(`  ! ${e.message.slice(0, 200)} — retrying once`); return go(); }
}
const setup = (p: Page, s: Seg) => p.eval(`window.__timeline.setup(${J(s)})`, 300000);
const frame = (p: Page, t: number) => p.eval(`window.__timeline.frame(${t.toFixed(4)})`, 120000);
const shoot = async (p: Page, file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await p.screenshot({ format: 'png' })); return file; };

/** Frames of a segment from `from` for `seconds` of clip time, `speed` × real time. */
async function frames(p: Page, dir: string, s: Seg, seconds: number, speed = 1, start = 0) {
  const n = Math.round(seconds * FPS);
  // SIZZLE_TEST=1: only the first, middle and last frames, to check the framing
  const fs_ = process.env.SIZZLE_TEST ? [0, n >> 1, n - 1] : [...Array(n).keys()];
  for (const f of fs_) { await frame(p, (s.from ?? 0) + (f / FPS) * speed); await shoot(p, path.join(dir, `${String(start + f).padStart(5, '0')}.png`)); }
  return start + n;
}
function encode(frameDir: string, out: string) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', String(FPS), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}
/** Stills held for given seconds → an MP4 (the build-up clips, the look switch). xfade: crossfade seconds between stills. */
function slideshow(stills: Array<{ file: string; hold: number }>, out: string, xfade = 0) {
  const args = ['-y', '-loglevel', 'error'];
  for (const s of stills) args.push('-loop', '1', '-framerate', String(FPS), '-t', String(s.hold + xfade), '-i', s.file);
  let filter = stills.map((_, i) => `[${i}:v]format=yuv420p,setsar=1[v${i}]`).join(';'), last = 'v0';
  if (xfade) {
    // each input runs hold + xfade; fade k starts where the holds before it end
    let offset = 0;
    for (let i = 1; i < stills.length; i++) { offset += stills[i - 1].hold; filter += `;[${last}][v${i}]xfade=transition=fade:duration=${xfade}:offset=${offset.toFixed(3)}[x${i}]`; last = `x${i}`; }
  } else if (stills.length > 1) { filter += `;${stills.map((_, i) => `[v${i}]`).join('')}concat=n=${stills.length}:v=1:a=0[out]`; last = 'out'; }
  args.push('-filter_complex', filter, '-map', `[${last}]`, '-r', String(FPS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}
const duration = (f: string) => +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim();
const work = (beat: string) => { const d = path.join(FOOT, '_work', beat); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const done = (beat: string, still: string) => { fs.copyFileSync(still, path.join(FOOT, `${beat}.png`)); console.log(`  → footage/${beat}.mp4 (${duration(path.join(FOOT, `${beat}.mp4`)).toFixed(2)} s), footage/${beat}.png`); };

/** Point the view's camera at a box with the orbit controls, as a person would: a right-drag pans the box
 * to the middle, wheel clicks zoom until it spans `want` of the viewport (the capture's own framing uses the
 * creature's whole rig, and a prop hidden 3 m under the floor — the octopus's tea stream — widens it). */
async function aim(p: Page, box: { min: number[]; max: number[] }, want = 0.6) {
  await p.eval('Element.prototype.setPointerCapture = function () {}; Element.prototype.releasePointerCapture = function () {}; true');
  const c = box.min.map((v, i) => (v + box.max[i]) / 2);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]]);
  for (let i = 0; i < 10; i++) {
    const m: any = await p.eval(`(() => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); const pts = ${J(corners)}.map((q) => window.__studioView.project(q)); const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); const [x, y] = window.__studioView.project(${J(c)}); return { x, y, cx: r.left + r.width / 2, cy: r.top + r.height * 0.45, span: Math.max((Math.max(...xs) - Math.min(...xs)) / r.width, (Math.max(...ys) - Math.min(...ys)) / r.height) }; })()`);
    const off = Math.hypot(m.x - m.cx, m.y - m.cy), zoom = Math.round(Math.log(want / m.span) / Math.log(1 / 0.95));
    console.log(`  aim ${i}: off ${off.toFixed(0)} px, span ${m.span.toFixed(2)}`);
    if (off < 10 && Math.abs(zoom) < 2) return;
    await p.eval(`(() => { const cv = document.querySelector('#viewport canvas'); const ev = (t, x, y) => cv.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 2, buttons: t === 'pointerup' ? 0 : 2, pointerId: 7, pointerType: 'mouse', bubbles: true }));
      if (${off >= 10}) { ev('pointerdown', ${m.x}, ${m.y}); for (let k = 1; k <= 8; k++) ev('pointermove', ${m.x} + (${m.cx - m.x}) * k / 8, ${m.y} + (${m.cy - m.y}) * k / 8); ev('pointerup', ${m.cx}, ${m.cy}); }
      for (let k = 0; k < ${Math.min(30, Math.abs(zoom))}; k++) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: ${zoom > 0 ? -100 : 100}, deltaMode: 0, clientX: ${m.cx}, clientY: ${m.cy}, bubbles: true, cancelable: true }));
      return true; })()`);
    await wait(4000);   // the view's own loop eases the camera there (damped orbit controls)
  }
}

/** A motion clip of one object, recorded straight from the view. */
async function motionClip(beat: string, s: Seg, seconds: number, speed = 1, stillAt = 0.5, box?: { min: number[]; max: number[] }, want?: number) {
  const dir = work(beat), fdir = path.join(dir, 'frames');
  // frameAt: frame the camera at that moment (a prop hidden below the floor at other times would widen the box)
  await view(async (p) => { await setup(p, { ...s, from: s.frameAt ?? s.from }); if (box) await aim(p, box, want); await frames(p, fdir, s, seconds, speed); });
  if (process.env.SIZZLE_TEST) { console.log(`  test frames in ${fdir}`); return; }
  encode(fdir, path.join(FOOT, `${beat}.mp4`));
  const n = fs.readdirSync(fdir).length;
  done(beat, path.join(fdir, `${String(Math.min(n - 1, Math.round(n * stillAt))).padStart(5, '0')}.png`));
}

/** A model built step by step: a still of the view after each step, then a build-up clip. */
async function buildUp(beat: string, steps: Array<{ args: string[]; shot?: boolean }>, framing: Partial<Seg>, box?: { min: number[]; max: number[] }) {
  const dir = work(beat);
  const stills: string[] = [];
  await view(async (p) => {
    let framed = false;
    for (const st of steps) {
      await studio(...st.args);
      if (st.shot === false) continue;
      await wait(2500);
      // the first shown step frames the camera; later steps keep it (the model grows in place)
      if (!framed) { await setup(p, { id: beat, seconds: 1, ...framing }); if (box) await aim(p, box, 0.75); framed = true; } else await p.eval('window.__timeline.refresh()', 300000);
      await wait(1500);
      await frame(p, 0);
      stills.push(await shoot(p, path.join(dir, `step-${String(stills.length + 1).padStart(2, '0')}.png`)));
    }
  });
  slideshow(stills.map((file, i) => ({ file, hold: i === stills.length - 1 ? 1.1 : 0.5 })), path.join(FOOT, `${beat}.mp4`));
  done(beat, stills.at(-1)!);
}

const action = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/actions', `${name}.json`), 'utf8'));
async function perform(id: string, file: string) {
  const a = action(file);
  await studio('perform-action', '--object', id, '--action', a.action, '--id', a.id, '--keys', J(a.keys), ...(a.style ? ['--style', J(a.style)] : []));
  return a.id as string;
}
const creature = async (preset: string) => (await studio('new-creature', '--preset', preset)).result.id as string;

const BEATS: Record<string, () => Promise<void>> = {
  async vase() {
    const profile = { curve: false, profile: [[0, 0], ['$rBase', 0], ['$rBelly', '$h*0.38'], ['$rNeck', '$h*0.86'], ['$rLip', '$h'], ['$rLip - $t', '$h'], ['$rNeck - $t', '$h*0.86'], ['$rBelly - $t', '$h*0.38'], ['$rBase - $t', '$t'], [0, '$t']] };
    await buildUp('vase', [
      { args: ['new-object', '--name', 'Vase', '--type', 'vase', '--material', 'glazed-ceramic', '--color', '#2f5d62'], shot: false },
      { args: ['set-params', '--values', J({ h: 0.32, t: 0.006, rBase: 0.08, rBelly: 0.08, rNeck: 0.08, rLip: 0.08 }), '--label', 'a 32 cm blank'], shot: false },
      { args: ['add-op', '--id', 'body', '--op', 'revolve', '--args', J(profile), '--output', 'true', '--why', 'revolve a profile'] },
      { args: ['set-params', '--values', J({ rBase: 0.07, rBelly: 0.11 }), '--label', 'wider belly'] },
      { args: ['set-params', '--values', J({ rNeck: 0.045, rLip: 0.055 }), '--label', 'narrow neck, flared lip'] },
      { args: ['set-op', '--id', 'body', '--args', J({ curve: true }), '--label', 'flowing outline'] },
      { args: ['add-op', '--id', 'vase', '--op', 'smooth', '--inputs', J(['body']), '--args', J({ levels: 2 }), '--output', 'true', '--why', 'smooth'] },
      { args: ['set-material', '--preset', 'glazed-ceramic', '--color', '#b5543a', '--why', 'warmer glaze'] },
    ], { dir: [1, 0.45, 1.25], fill: 0.85 });
  },
  async stool() {
    // the legs grow 1 cm long and are trimmed flat at the floor (splayed legs otherwise dip below it)
    await buildUp('stool', [
      { args: ['new-object', '--name', 'Walnut stool', '--type', 'stool', '--material', 'walnut'], shot: false },
      { args: ['set-params', '--values', J({ seatH: 0.45, seatW: 0.36, seatT: 0.04, legR: 0.018, legSplay: { value: 4, unit: 'deg' } }), '--label', 'dining-height stool'], shot: false },
      { args: ['add-op', '--id', 'seat', '--op', 'roundedBox', '--part', 'seat', '--args', J({ size: ['$seatW', '$seatT', '$seatW'], r: 0.012, at: [0, '$seatH - $seatT/2', 0] }), '--output', 'true'] },
      { args: ['add-op', '--id', 'leg', '--op', 'cylinder', '--part', 'leg', '--args', J({ r: '$legR', h: '($seatH - $seatT) / cos($legSplay) + 0.01', at: [0, 0, 0] }), '--output', 'false'], shot: false },
      { args: ['add-op', '--id', 'legs', '--op', 'placeAt', '--inputs', J(['leg']), '--args', J({ target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' }), '--output', 'false'], shot: false },
      { args: ['add-op', '--id', 'joined', '--op', 'union', '--inputs', J(['seat', 'legs']), '--output', 'true'], shot: false },
      { args: ['add-op', '--id', 'stool', '--op', 'trim', '--inputs', J(['joined']), '--output', 'true', '--why', 'legs on the floor'] },
      { args: ['set-material', '--part', 'leg*', '--preset', 'black-metal', '--why', 'black legs'] },
      { args: ['set-params', '--values', J({ legSplay: { value: 10, unit: 'deg' } }), '--label', 'more splay'] },
      { args: ['set-params', '--values', J({ seatH: 0.65 }), '--label', 'bar height'] },
    ], { dir: [1, 0.55, 1.25], fill: 0.8 }, { min: [-0.3, 0, -0.3], max: [0.3, 0.66, 0.3] });
  },
  async spider() {
    const id = await creature('spider');
    await motionClip('spider', { id: 'walk', play: { [id]: 'walk' }, focus: id, solo: true, dir: [1, 0.55, 1.2], fill: 0.62 }, 3.2);
  },
  async octopus() {
    const id = await creature('octopus');
    const mid = await perform(id, 'octopus-pours-tea');
    // over the cup, the tip, the pour and the stop (3.6 → 7.6 s of the 10.4 s action, at 1.25×)
    const box = (await studio('inspect', '--object', id)).result.bbox;
    await motionClip('octopus', { id: mid, play: { [id]: mid }, focus: id, solo: true, from: 3.6, dir: [1, 0.5, 1.3], fill: 0.6 }, 3.2, 1.25, 0.6, box, 0.7);
  },
  async bird() {
    const id = await creature('bird');
    const mid = await perform(id, 'bird-takes-off');
    // it flies 12.7 m: two side-on shots, the take-off (0 → 2.1 s) and the landing (4.9 → 7.2 s, a little fast)
    const dir = work('bird'), fdir = path.join(dir, 'frames');
    const side: [number, number, number] = [1, 0.28, 0.12];
    await view(async (p) => {
      await setup(p, { id: mid, play: { [id]: mid }, focus: id, solo: true, dir: side });
      await aim(p, { min: [-0.3, 0, -0.4], max: [0.3, 1.0, 1.9] }, 0.8);
      let n = await frames(p, fdir, { id: mid, from: 0 }, 2.1);
      await setup(p, { id: mid, play: { [id]: mid }, focus: id, solo: true, from: 7.2, dir: side });
      await aim(p, { min: [-0.3, 0, 11.1], max: [0.3, 1.0, 13.2] }, 0.8);
      n = await frames(p, fdir, { id: mid, from: 4.9 }, 1.9, 1.2, n);
    });
    if (process.env.SIZZLE_TEST) return;
    encode(fdir, path.join(FOOT, 'bird.mp4'));
    done('bird', path.join(fdir, '00035.png'));
  },
  async crab() {
    const id = await creature('crab');
    await motionClip('crab', { id: 'walk', play: { [id]: 'walk' }, focus: id, solo: true, dir: [0.8, 0.6, 1.3], fill: 0.62 }, 3.2);
  },
  async snake() {
    const id = await creature('snake');
    await motionClip('snake', { id: 'slither', play: { [id]: 'slither' }, focus: id, solo: true, dir: [0.6, 0.9, 1], fill: 0.6 }, 3.2);
  },
  async fish() {
    const id = await creature('fish');
    await motionClip('fish', { id: 'swim', play: { [id]: 'swim' }, focus: id, solo: true, dir: [0.4, 0.5, 1.3], fill: 0.62 }, 3.2);
  },
  async effects() {
    // a little forge with no one at it: a brick hearth with its fire, a chimney smoking, an anvil
    await studio('new-object', '--name', 'Hearth', '--type', 'hearth', '--material', 'terracotta', '--color', '#8a4b36', '--position', J([0, 0, 0]));
    await studio('add-op', '--id', 'base', '--op', 'roundedBox', '--args', J({ size: [0.8, 0.6, 0.6], r: 0.03, at: [0, 0.3, 0] }), '--output', 'true');
    await studio('new-object', '--name', 'Chimney', '--type', 'chimney', '--material', 'concrete', '--color', '#8d8a86', '--position', J([0, 0, -0.45]));
    await studio('add-op', '--object', 'chimney', '--id', 'stack', '--op', 'cylinder', '--args', J({ r1: 0.42, r2: 0.24, h: 1.7, at: [0, 0, 0] }), '--output', 'true');
    await studio('new-object', '--name', 'Anvil', '--type', 'anvil', '--material', 'brushed-metal', '--color', '#5d636b', '--position', J([0.85, 0, 0.3]));
    await studio('add-op', '--object', 'anvil', '--id', 'block', '--op', 'box', '--args', J({ size: [0.5, 0.18, 0.22], at: [0, 0.5, 0] }));
    await studio('add-op', '--object', 'anvil', '--id', 'foot', '--op', 'box', '--args', J({ size: [0.26, 0.42, 0.18], at: [0, 0.21, 0] }), '--output', 'false');
    await studio('add-op', '--object', 'anvil', '--id', 'anvil', '--op', 'union', '--inputs', J(['block', 'foot']), '--output', 'true');
    await studio('add-effect', '--id', 'forge-fire', '--preset', 'forge-fire', '--on', 'hearth');
    await studio('set-effect', '--id', 'forge-fire', '--valueDefault', '1');
    await studio('add-effect', '--id', 'chimney-smoke', '--preset', 'chimney-smoke', '--at', J([0, 1.7, -0.45]));
    // no trigger: a one-shot effect bursts at t = 0 on the scene timeline
    await studio('add-effect', '--id', 'sparks', '--preset', 'sparks', '--at', J([0.85, 0.6, 0.3]), '--triggers', '[]');
    await studio('add-effect', '--id', 'embers', '--preset', 'embers', '--at', J([0, 0.65, 0]), '--triggers', '[]');
    // framed on the hearth, anvil and the first metre of smoke above the chimney
    await motionClip('effects', { id: 'forge', dir: [1, 0.32, 1.5], fill: 0.72 }, 3.4, 1, 0.1, { min: [-0.5, 0, -0.8], max: [1.15, 2.7, 0.5] }, 0.82);
  },
  async town() {
    await studio('world-town', '--name', 'Pocket Raleigh', '--source', 'real', '--area', 'raleigh-mini', '--style', 'raleigh-downtown');
    await studio('look-new', '--preset', 'day-toy');
    const dir = work('town');
    const shots: string[] = [];
    await view(async (p) => {
      await p.eval(`new Promise((r) => { const t = setInterval(() => { if (window.__studioView.townIds().length) { clearInterval(t); r(true); } }, 200); })`, 300000);
      await wait(3000);
      await setup(p, { id: 'town' }); await frame(p, 0); await wait(1500); await frame(p, 0);
      shots.push(await shoot(p, path.join(dir, 'day.png')));
      await studio('look-new', '--preset', 'neon-night');
      await wait(6000);
      await frame(p, 0); await wait(1500); await frame(p, 0);
      shots.push(await shoot(p, path.join(dir, 'night.png')));
    });
    fs.copyFileSync(shots[0], path.join(FOOT, 'town-day.png'));
    fs.copyFileSync(shots[1], path.join(FOOT, 'town-night.png'));
    slideshow([{ file: shots[0], hold: 1.4 }, { file: shots[1], hold: 1.6 }], path.join(FOOT, 'town.mp4'), 0.7);
    slideshow([{ file: shots[0], hold: 2.5 }], path.join(FOOT, 'town-day.mp4'));
    slideshow([{ file: shots[1], hold: 2.5 }], path.join(FOOT, 'town-night.mp4'));
    done('town', shots[1]);
  },
  async timeline() {
    const id = await creature('spider');
    // a leg bone selected: the dock shows the moment address of that bone as the clip plays
    await motionClip('timeline', { id: 'walk', play: { [id]: 'walk' }, focus: id, solo: true, select: { object: id, part: 'legs.L1.upper' }, dir: [1, 0.6, 1.2], fill: 0.62 }, 3.4, 1, 0.6);
  },
};

const picked = process.argv.slice(2).length ? process.argv.slice(2) : ['vase', 'stool', 'spider', 'octopus', 'bird', 'crab', 'effects', 'town', 'timeline'];
for (const b of picked) {
  if (!BEATS[b]) throw new Error(`unknown beat ${b} (${Object.keys(BEATS).join(', ')})`);
  console.log(`▶ ${b}`);
  const t0 = Date.now();
  try { await project(b, BEATS[b]); console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
  catch (e: any) { console.error(`  ✗ ${b}: ${e.message}`); process.exitCode = 1; }
}
process.exit(process.exitCode ?? 0);
