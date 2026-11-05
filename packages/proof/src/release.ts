// Release checks (Decision 31, Mac only): read every still and sampled video frame with the Mac's own OCR
// (Apple Vision through a tiny Swift helper, compiled once into ~/.studio-tools/bin), match the text
// against brand, team and wording lists, confirm required credit lines are present, and check that
// every sound file carries a licence (REUSE-style sidecars) — then write CREDITS.md + REUSE.toml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export interface Lists { brands: string[]; teams: string[]; wording: string[]; required: string[]; allow: string[] }
export interface OcrLine { text: string; confidence: number; box: [number, number, number, number] }

/** Build the Swift OCR helper once (rebuilt when ocr.swift changes). Falls back to tesseract. */
export function ocrTool(): { bin: string; kind: 'vision' | 'tesseract' } | null {
  const src = path.join(HERE, 'ocr.swift');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10);
  const bin = path.join(os.homedir(), '.studio-tools', 'bin', `studio-ocr-${hash}`);
  if (fs.existsSync(bin)) return { bin, kind: 'vision' };
  if (process.platform === 'darwin' && spawnSync('which', ['swiftc']).status === 0) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const r = spawnSync('swiftc', ['-O', src, '-o', bin], { encoding: 'utf8', timeout: 180000 });
    if (r.status === 0) return { bin, kind: 'vision' };
  }
  const t = spawnSync('which', ['tesseract'], { encoding: 'utf8' });
  return t.status === 0 ? { bin: t.stdout.trim(), kind: 'tesseract' } : null;
}

export function ocr(files: string[]): Array<{ file: string; lines: OcrLine[]; error?: string }> {
  const tool = ocrTool();
  if (!tool) throw Object.assign(new Error('no OCR on this machine'), { hint: 'needs macOS with swiftc (Xcode command line tools) or `brew install tesseract`' });
  const out: Array<{ file: string; lines: OcrLine[]; error?: string }> = [];
  if (tool.kind === 'vision') {
    for (let i = 0; i < files.length; i += 40) {
      const r = spawnSync(tool.bin, files.slice(i, i + 40), { encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20 });
      for (const l of (r.stdout ?? '').split('\n').filter(Boolean)) { const j = JSON.parse(l); out.push({ file: j.file, lines: j.lines ?? [], ...(j.error ? { error: j.error } : {}) }); }
    }
  } else for (const f of files) {
    const r = spawnSync(tool.bin, [f, '-', '--psm', '11'], { encoding: 'utf8' });
    out.push({ file: f, lines: (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text, confidence: 1, box: [0, 0, 0, 0] as [number, number, number, number] })) });
  }
  return out;
}

export function loadLists(gameDir?: string): Lists {
  const base = JSON.parse(fs.readFileSync(path.join(HERE, 'release-lists.json'), 'utf8'));
  const own = gameDir && fs.existsSync(path.join(gameDir, 'proof', 'release-lists.json')) ? JSON.parse(fs.readFileSync(path.join(gameDir, 'proof', 'release-lists.json'), 'utf8')) : {};
  const k = (n: keyof Lists) => [...new Set([...(base[n] ?? []), ...(own[n] ?? [])])];
  return { brands: k('brands'), teams: k('teams'), wording: k('wording'), required: k('required'), allow: k('allow') };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’]/g, "'");
/** Whole-word, case- and accent-insensitive hits of list words in a text (allowed phrases removed first). */
export function matchWords(text: string, words: string[], allow: string[] = []): string[] {
  let t = norm(text);
  for (const a of allow) t = t.replace(new RegExp(`(^|[^a-z0-9])${esc(norm(a))}(?=$|[^a-z0-9])`, 'g'), '$1 ');
  return words.filter((w) => new RegExp(`(^|[^a-z0-9])${esc(norm(w)).replace(/\\ /g, '[\\s-]+')}(?=$|[^a-z0-9])`).test(t));
}

/** Frames from a video: one every `every` seconds plus any extra times (captions), as PNGs in `dir`. */
export function sampleFrames(video: string, dir: string, every = 2, extra: number[] = []): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(video).replace(/\.\w+$/, '');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', `fps=1/${every}`, path.join(dir, `${base}-%03d.png`)]);
  for (const t of extra) spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', path.join(dir, `${base}-at${t.toFixed(2)}.png`)]);
  return fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith('.png')).sort().map((f) => path.join(dir, f));
}

export interface ReleaseFinding { kind: 'brand' | 'team' | 'wording' | 'required-missing' | 'licence-missing'; word: string; where: string[] }

/** Check text found in media (OCR) and text we already know (captions, store copy) against the lists. */
export function checkText(found: Array<{ where: string; text: string }>, lists: Lists): { findings: ReleaseFinding[]; seen: string[] } {
  const hits = new Map<string, ReleaseFinding>();
  const add = (kind: ReleaseFinding['kind'], word: string, where: string) => { const k = `${kind}:${word}`; const f = hits.get(k) ?? { kind, word, where: [] }; if (!f.where.includes(where)) f.where.push(where); hits.set(k, f); };
  for (const { where, text } of found) {
    for (const w of matchWords(text, lists.brands, lists.allow)) add('brand', w, where);
    for (const w of matchWords(text, lists.teams, lists.allow)) add('team', w, where);
    for (const w of matchWords(text, lists.wording, lists.allow)) add('wording', w, where);
  }
  const all = found.map((f) => f.text).join('\n');
  for (const r of lists.required) if (!matchWords(all, [r]).length) add('required-missing', r, '(nowhere)');
  return { findings: [...hits.values()], seen: [...new Set(found.map((f) => f.text))] };
}

/** Audio/video files under `dirs` and whether each has a REUSE licence (sidecar `.license` or REUSE.toml). */
export function licenceAudit(dirs: string[]) {
  const media = /\.(wav|ogg|mp3|m4a|flac|opus)$/i;
  const rows: Array<{ file: string; licence: string | null; copyright: string | null }> = [];
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (media.test(e.name)) {
    const side = p + '.license', t = fs.existsSync(side) ? fs.readFileSync(side, 'utf8') : '';
    rows.push({ file: p, licence: t.match(/SPDX-License-Identifier: (.*)/)?.[1] ?? null, copyright: t.match(/SPDX-FileCopyrightText: (.*)/)?.[1] ?? null });
  } } };
  for (const d of dirs) walk(d);
  return { files: rows.length, missing: rows.filter((r) => !r.licence || !r.copyright).map((r) => r.file), rows };
}

/** REUSE.toml annotations for produced media (a trailer): what it was made from and under which terms. */
export function reuseToml(entries: Array<{ path: string; copyright: string[]; licence: string; comment?: string }>): string {
  return ['version = 1', '', ...entries.flatMap((e) => [
    '[[annotations]]', `path = ${JSON.stringify(e.path)}`, 'precedence = "aggregate"',
    `SPDX-FileCopyrightText = [${e.copyright.map((c) => JSON.stringify(c)).join(', ')}]`,
    `SPDX-License-Identifier = ${JSON.stringify(e.licence)}`, ...(e.comment ? [`# ${e.comment}`] : []), '',
  ])].join('\n');
}

/** The whole release check over media files (stills, videos) and known texts. */
export function releaseCheck(opts: { media: string[]; texts?: Array<{ where: string; text: string }>; lists: Lists; work: string; soundDirs?: string[]; videoExtra?: Record<string, number[]> }) {
  const images: string[] = [];
  for (const m of opts.media) {
    if (/\.(mp4|mov|webm)$/i.test(m)) images.push(...sampleFrames(m, path.join(opts.work, 'frames'), 2, opts.videoExtra?.[m] ?? []));
    else if (/\.(png|jpe?g)$/i.test(m)) images.push(m);
  }
  const read = ocr(images);
  const found = [...read.flatMap((r) => r.lines.filter((l) => l.confidence >= 0.3).map((l) => ({ where: path.relative(process.cwd(), r.file), text: l.text }))), ...(opts.texts ?? [])];
  const { findings, seen } = checkText(found, opts.lists);
  const lic = licenceAudit(opts.soundDirs ?? []);
  for (const f of lic.missing) findings.push({ kind: 'licence-missing', word: path.basename(f), where: [f] });
  return { ok: findings.length === 0, images: images.length, ocrErrors: read.filter((r) => r.error).map((r) => `${r.file}: ${r.error}`), textsSeen: seen.slice(0, 200), findings, licences: { files: lic.files, missing: lic.missing.length } };
}
