// Cast lineup (Decision 47 review): a folder with each character's GLB and a three.js page that stands
// them side by side; capture writes a lineup still and a turntable MP4 (headless Chrome + ffmpeg).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../game/src/web.ts';
import { STUDIO_ROOT } from '../../../game/src/project.ts';
import { withPage } from '../../../game/src/chrome.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export interface CastMember { id: string; name: string; label: string; glb: Uint8Array; height: number; idle: string | null; headH?: number; headY?: number; alt?: Uint8Array }

/** `styles` names the two style families when members carry an `alt` GLB: the player toggles between them. */
export async function buildCastLineup(outDir: string, title: string, cast: CastMember[], styles?: [string, string]): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const members = cast.map((c) => { fs.writeFileSync(path.join(outDir, `${c.id}.glb`), c.glb); if (c.alt) fs.writeFileSync(path.join(outDir, `${c.id}.alt.glb`), c.alt); return { ...(c.alt ? { alt: `${c.id}.alt.glb` } : {}), id: c.id, name: c.name, label: c.label, glb: `${c.id}.glb`, height: c.height, idle: c.idle, headH: c.headH, headY: c.headY, headZ: (c as any).headZ }; });
  fs.writeFileSync(path.join(outDir, 'cast.json'), JSON.stringify({ title, cast: members, ...(styles ? { styles } : {}) }, null, 2));
  fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Cast lineup</title><style>html,body{margin:0;background:#ece6dc}#stage canvas{width:100%;height:auto;display:block}</style></head><body><div id="stage"></div><script type="module" src="player.js"></script></body></html>`);
  const esbuild = await import('esbuild');
  await esbuild.build({ entryPoints: [path.join(HERE, 'main.ts')], outfile: path.join(outDir, 'player.js'), bundle: true, minify: true, format: 'esm', target: 'es2022', nodePaths: [path.join(STUDIO_ROOT, 'node_modules')], logLevel: 'silent' });
  return path.join(outDir, 'index.html');
}

/** A lineup still (three-quarter view) and a turntable video (one full turn while idling). */
export async function captureCast(outDir: string, opts: { width?: number; height?: number; fps?: number; seconds?: number } = {}): Promise<{ still: string; front: string; faces: string; video?: string; note?: string }> {
  const W = opts.width ?? 1600, H = opts.height ?? 800, fps = opts.fps ?? 30, secs = opts.seconds ?? 8;
  const frameDir = path.join(outDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const still = path.join(outDir, 'lineup.png'), front = path.join(outDir, 'lineup-front.png'), faces = path.join(outDir, 'faces.png');
  const n = Math.round(secs * fps);
  await serve(outDir, (url) => withPage(`${url}index.html?capture=1&w=${W}&h=${H}`, { width: W, height: H }, async (page) => {
    for (let i = 0; i < 300; i++) { if (await page.eval('!!window.__ready', 5000).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    if (!(await page.eval('!!window.__ready'))) throw new Error(`cast lineup did not start: ${page.logs.map((l) => l.text).join('; ')}`);
    const shot = async (t: number, yaw: number, file: string) => { const u: string = await page.eval(`window.__frame(${t}, ${yaw})`); fs.writeFileSync(file, Buffer.from(u.split(',')[1], 'base64')); };
    await shot(1.2, 28, still);
    await shot(1.2, 0, front);
    const fu: string = await page.eval('window.__faces(1.2)');
    fs.writeFileSync(faces, Buffer.from(fu.split(',')[1], 'base64'));
    const bu: string = await page.eval('window.__bodies(1.2)');
    fs.writeFileSync(path.join(outDir, 'bodies.png'), Buffer.from(bu.split(',')[1], 'base64'));
    if (process.env.CAST_STILLS_ONLY) return;
    for (let f = 0; f < n; f++) await shot(f / fps, (360 * f) / n, path.join(frameDir, `${String(f).padStart(5, '0')}.png`));
  }));
  if (process.env.CAST_STILLS_ONLY) return { still, front, faces, note: 'stills only (CAST_STILLS_ONLY)' };
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) return { still, front, faces, note: 'ffmpeg not found: turntable frames are in frames/' };
  const video = path.join(outDir, 'turntable.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { still, front, faces, video };
}
