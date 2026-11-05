// The old preview commands, redirected to the live view (Phase 10 step 2). motion-preview,
// creature-preview, line-preview and cutscene-preview no longer write a separate player page: they say
// what to play on the view's timeline, give its link, and with --video true capture the real view
// (headless Chrome) frame by frame into an MP4 with stills at the named moments.
import fs from 'node:fs';
import path from 'node:path';
import { buildCreature, bakeCreature, creatureChecks } from '../../core/src/rigparts.ts';
import { cutsceneChecks } from '../../core/src/cutscene.ts';
import { toSeconds } from '../../core/src/collab/movetimeline.ts';
import { captureFromView, type ViewSegment } from './viewcapture.ts';
import type { TimelineService } from './timeline.ts';

export const PREVIEW_TOOLS = ['line-preview', 'motion-preview', 'creature-preview', 'cutscene-preview'];

interface Ctx { studio: any; timelines: TimelineService; viewUrl: string; outDir: (name: string) => string; dir: string }

const showTime = (d: number, loop: boolean) => (loop ? Math.max(2.5, Math.min(8, d * 2)) : d + 0.5);
const list = (v: unknown) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);
const link = (url: string, q: Record<string, string>) => `${url}/?${new URLSearchParams(q).toString()}`;

export async function viewPreview(name: string, args: any, c: Ctx): Promise<any> {
  const doc = c.studio.doc();
  const fail = (error: string, hint?: string) => ({ ok: false, tool: name, error, ...(hint ? { hint } : {}) });
  let segs: ViewSegment[] = [], extra: Record<string, unknown> = {}, viewLink = c.viewUrl, out: string, label: string;

  if (name === 'motion-preview' || name === 'creature-preview') {
    const obj = c.studio.findObject(doc, args.object);
    const motions: Record<string, any> = obj.creature?.motions ?? obj.character?.motions ?? {};
    if (name === 'creature-preview' && !obj.creature) return fail(`${obj.name} is not a creature`, 'studio new-creature --preset crab');
    if (!Object.keys(motions).length) return fail(`${obj.name} has no motions`, `studio set-motion --object ${obj.id} --id walk --kind walk`);
    const want = list(args.motions);
    const picked = want ? want.filter((m) => motions[m]) : Object.keys(motions);
    if (!picked.length) return fail(`no motion ${want!.join(', ')}`, `motions: ${Object.keys(motions).join(', ')}`);
    const also = list(args.with)?.map((r) => c.studio.findObject(doc, r).id) ?? [];
    for (const mid of picked) {
      const tl = c.timelines.get('main', { play: { [obj.id]: mid } });
      const tr = tl.tracks.find((t) => t.id === `motion:${obj.id}`)!;
      if (tr.error) return fail(`${obj.name} ${mid}: ${tr.error}`);
      const d = toSeconds(tr.length), loop = motions[mid].kind !== 'action';
      const named = tr.markers.filter((m) => m.kind === 'moment' && !/\(held\)|^pause/.test(m.name));
      segs.push({ id: mid, label: `${obj.name}: ${mid}`, seconds: showTime(d, loop), play: { [obj.id]: mid }, focus: obj.id, solo: !also.length, show: also,
        stillsAt: named.length ? named.map((m) => ({ name: m.name, t: Math.min(d - 0.03, toSeconds(m.at) + 0.04) })) : undefined });
    }
    if (obj.creature) {
      const cr = buildCreature(obj.creature.def);
      extra.checks = Object.fromEntries(picked.map((mid) => { const ks = creatureChecks(cr, bakeCreature(cr, mid, motions[mid])); return [mid, { pass: ks.every((k) => k.pass), failing: ks.filter((k) => !k.pass).map((k) => k.name) }]; }));
      if (args.demoFailure || args.live === true) extra.dropped = 'the live-runtime and deliberately-broken segments of the old creature player are gone: the view plays the baked clips, with the red stretches on the timeline';
    }
    viewLink = link(c.viewUrl, { focus: obj.id, play: `${obj.id}:${picked[0]}` });
    out = c.outDir(`${obj.id}-${obj.creature ? 'creature' : 'motions'}`);
    label = `${segs.length} motion(s) of ${obj.name}`;
  } else if (name === 'line-preview') {
    const obj = c.studio.findObject(doc, args.object);
    const all = Object.keys(obj.character?.lines ?? {});
    if (!all.length) return fail(`${obj.name} has no lines yet`, `studio say --object ${obj.id} --text "…"`);
    const want = list(args.lines);
    const picked = want ? want.filter((l) => all.includes(l)) : all;
    if (!picked.length) return fail(`no line ${want!.join(', ')}`, `lines: ${all.join(', ')}`);
    const tl = c.timelines.get('main', {});
    for (const lid of picked) {
      const tr = tl.tracks.find((t) => t.id === `voice:${obj.id}:${lid}`)!;
      segs.push({ id: lid, label: tr.label, seconds: toSeconds(tr.length) + 0.6, from: Math.max(0, toSeconds(tr.start) - 0.25), focus: obj.id, close: 'face', solo: true });
    }
    viewLink = link(c.viewUrl, { focus: obj.id, track: `voice:${obj.id}:${picked[0]}` });
    out = c.outDir(`${obj.id}-lines`);
    label = `${segs.length} line(s) of ${obj.name}`;
  } else {
    const all = doc.cutscenes ?? {};
    const cs: any = all[String(args.id ?? '')] ?? (Object.keys(all).length === 1 && !args.id ? Object.values(all)[0] : null);
    if (!cs) return fail(args.id ? `no cutscene "${args.id}"` : 'which cutscene? --id', `cutscenes: ${Object.keys(all).join(', ') || 'none (studio new-cutscene)'}`);
    let tl;
    try { tl = c.timelines.get('main', { cutscene: cs.id }); } catch (e: any) { return fail(e.message); }
    const shots = tl.tracks[0].markers.filter((m) => m.kind === 'shot');
    segs = [{ id: cs.id, label: cs.title ?? cs.id, seconds: toSeconds(tl.length), cutscene: cs.id, stillsAt: shots.map((m) => ({ name: m.name, t: toSeconds(m.at) + Math.min(0.6, toSeconds(m.len ?? 0) / 2) })) }];
    const checks = cutsceneChecks(c.studio, doc, cs);
    extra = { checks, shots: shots.map((m) => ({ shot: m.name, at: +toSeconds(m.at).toFixed(2) })), seconds: +toSeconds(tl.length).toFixed(2) };
    viewLink = link(c.viewUrl, { cutscene: cs.id });
    out = c.outDir(`${cs.id}-cutscene`);
    label = `${shots.length} shots, ${toSeconds(tl.length).toFixed(1)} s`;
  }
  if (args.out) out = path.resolve(c.dir, String(args.out));
  const result: any = { view: viewLink, playsIn: 'the live view (the timeline dock at the bottom)', segments: segs.map((s) => s.id), ...extra };
  if (args.video || name === 'cutscene-preview') {
    try {
      const cap = await captureFromView(c.viewUrl, out, segs, { name: name === 'cutscene-preview' ? 'cutscene' : name.replace('-preview', 's') });
      Object.assign(result, { dir: out, video: cap.video, stills: cap.stills, frames: cap.frames, seconds: cap.seconds, ...(cap.note ? { note: cap.note } : {}) });
      if (name === 'cutscene-preview') result.storyboard = writeStoryboard(out, cap.stills, extra.checks as any[]);
    } catch (e: any) { return fail(`capture from the view failed: ${e.message}`); }
  }
  const failing = extra.checks && !Array.isArray(extra.checks) ? Object.entries<any>(extra.checks).filter(([, v]) => !v.pass).map(([k, v]) => `${k}: ${v.failing.join(', ')}`) : [];
  return { ok: true, tool: name, summary: `${label} — play it in the view: ${viewLink}${failing.length ? ` — failing: ${failing.join('; ')}` : ''}${result.video ? ` → ${result.video}` : ''}`, result: { ...result, note: result.video ? 'Read the stills to look; the MP4 is frames of the live view with its timeline' : `open ${viewLink} (the view plays it on the timeline); --video true for an MP4 and stills` } };
}

/** A storyboard page: one frame of the view per shot, with the cutscene checks. */
function writeStoryboard(dir: string, stills: string[], checks: Array<{ label: string; pass: boolean; detail: string }>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const html = `<!doctype html><meta charset="utf-8"><title>Storyboard</title><style>body{font:14px system-ui;margin:24px;background:#faf9f7;color:#1c1917}img{width:100%;border-radius:6px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}.bad{color:#a3241a}</style>
<h1>Storyboard</h1><ul>${checks.map((k) => `<li class="${k.pass ? '' : 'bad'}">${k.pass ? '✓' : '✗'} ${esc(k.label)} — ${esc(k.detail)}</li>`).join('')}</ul>
<div class="g">${stills.map((s) => `<figure><img src="stills/${esc(path.basename(s))}"><figcaption>${esc(path.basename(s, '.png'))}</figcaption></figure>`).join('')}</div>`;
  const f = path.join(dir, 'storyboard.html');
  fs.writeFileSync(f, html);
  return f;
}
