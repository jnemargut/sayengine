// Capture from the live view (Phase 10 step 2): the five separate players (motion, creature, cast,
// cutscene, line) are gone; previews, bench videos and stills are frames of the real view, in headless
// Chrome, with the timeline dock (tracks, red stretches, moments) in every frame. The view exposes
// window.__timeline: setup(segment) → loads that scene timeline; frame(t) → poses everything at t.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withPage, type Page } from '../../game/src/chrome.ts';

export interface ViewSegment {
  id: string;
  label?: string;
  seconds: number;                          // how long it plays in the video
  branch?: string;                          // main (default) or a proposal
  play?: Record<string, string>;            // object → motion
  cutscene?: string;                        // cutscene mode (the shot clock drives the camera)
  focus?: string;                           // frame this object (default: the whole scene)
  close?: 'face' | 'body';                  // face: a close-up on the focus's head (voice lines)
  solo?: boolean;                           // hide everything but the focus and what it holds
  show?: string[];                          // with solo: also these objects
  stillsAt?: Array<{ name: string; t: number }>;   // stills at these segment times (default: three across)
  select?: { object: string; part?: string };      // a selection (shows its moment address in the dock)
  from?: number;                            // start at this master time (s)
}
export interface ViewCapture { video?: string; frames: number; seconds: number; stills: string[]; note?: string; view: string; frameMs?: { mean: number; p95: number } }

const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function waitForView(page: Page) {
  for (let i = 0; i < 600; i++) { if (await page.eval('!!(window.__timeline && window.__timeline.ready())', 5000).catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`the view did not start: ${page.logs.map((l) => l.text).join('; ').slice(0, 600)}`);
}

/** Frames of the view for each segment → an MP4 (ffmpeg) and stills. */
export async function captureFromView(viewUrl: string, outDir: string, segments: ViewSegment[], opts: { width?: number; height?: number; fps?: number; name?: string; keepFrames?: boolean; jpeg?: boolean } = {}): Promise<ViewCapture> {
  const W = opts.width ?? 1280, H = opts.height ?? 720, fps = opts.fps ?? 24;
  fs.mkdirSync(outDir, { recursive: true });
  const frameDir = path.join(outDir, 'frames'), stillDir = path.join(outDir, 'stills');
  for (const d of [frameDir, stillDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const stills: string[] = [];
  let n = 0;
  await withPage(`${viewUrl}/?capture=1&theme=light`, { width: W, height: H }, async (page) => {
    await waitForView(page);
    for (const seg of segments) {
      await page.eval(`window.__timeline.setup(${JSON.stringify(seg)})`, 180000);
      const count = Math.max(1, Math.round(seg.seconds * fps));
      const wanted = new Map<number, string>();
      const at = seg.stillsAt?.length ? seg.stillsAt : [{ name: 'a', t: seg.seconds * 0.2 }, { name: 'b', t: seg.seconds * 0.55 }, { name: 'c', t: seg.seconds * 0.9 }];
      at.forEach((s, i) => wanted.set(Math.min(count - 1, Math.round(s.t * fps)), `${seg.id}-${String(i + 1).padStart(2, '0')}-${slug(s.name)}`));
      for (let f = 0; f < count; f++) {
        await page.eval(`window.__timeline.frame(${((seg.from ?? 0) + f / fps).toFixed(4)})`, 60000);
        const png = await page.screenshot({ format: 'png' });
        const file = path.join(frameDir, `${String(n++).padStart(5, '0')}.png`);
        fs.writeFileSync(file, png);
        const still = wanted.get(f);
        if (still) { const dst = path.join(stillDir, `${still}.png`); fs.copyFileSync(file, dst); stills.push(dst); }
      }
    }
  });
  const seconds = +(n / fps).toFixed(2);
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) return { frames: n, seconds, stills, note: 'ffmpeg not found: frames are in frames/', view: viewUrl };
  const video = path.join(outDir, `${opts.name ?? 'view'}.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', video], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  if (!opts.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  return { video, frames: n, seconds, stills, view: viewUrl };
}

/** One still of the view after a setup (a cast line-up, a storyboard frame). */
export async function stillsFromView(viewUrl: string, outDir: string, shots: Array<ViewSegment & { t: number; name: string }>, opts: { width?: number; height?: number } = {}): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  await withPage(`${viewUrl}/?capture=1&theme=light`, { width: opts.width ?? 1280, height: opts.height ?? 720 }, async (page) => {
    await waitForView(page);
    for (const s of shots) {
      await page.eval(`window.__timeline.setup(${JSON.stringify(s)})`, 180000);
      await page.eval(`window.__timeline.frame(${s.t})`, 60000);
      const f = path.join(outDir, `${s.name}.png`);
      fs.writeFileSync(f, await page.screenshot({ format: 'png' }));
      out.push(f);
    }
  });
  return out;
}
