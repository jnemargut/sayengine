// Every sound file carries its licence (Decision 33): a REUSE-style `<file>.license` sidecar next to it
// (SPDX-FileCopyrightText + SPDX-License-Identifier + where it came from), and the same record in the
// pack's sound.json. Credits (CREDITS.md) and the release check are built from these records, never by
// hand, so a file with no licence can't reach a build unnoticed.
import fs from 'node:fs';
import path from 'node:path';

export interface Licence {
  spdx: string;                    // CC0-1.0, CC-BY-4.0, LicenseRef-Stability-AI-Community, …
  copyright: string;               // "2026 AntumDeluge" / "2026 Pocket Raleigh (generated)"
  source: 'synth' | 'stems' | 'ambience' | 'library' | 'stable-audio-open-small' | 'mix';
  how: string;                     // "sfx clink seed strike-2", "OpenGameArt: Fire Crackling"
  url?: string;
  author?: string;
  attribution?: string;            // the line a credits page must show (required for CC-BY etc.)
  from?: string[];                 // a mix: the files it was made from
}

/** Licences that need nothing but a courtesy credit, and ones that need a line in the credits. */
export const NEEDS_ATTRIBUTION = (spdx: string) => !/^(CC0-1\.0|0BSD|Unlicense|LicenseRef-Studio-Generated)$/.test(spdx);
const KNOWN = /^(CC0-1\.0|CC-BY-[34]\.0|CC-BY-SA-[34]\.0|OFL-1\.1|MIT|0BSD|Unlicense|LicenseRef-[A-Za-z0-9.-]+)$/;

export function sidecarText(file: string, l: Licence): string {
  return [
    `SPDX-FileCopyrightText: ${l.copyright}`,
    `SPDX-License-Identifier: ${l.spdx}`,
    '',
    `Source: ${l.source} — ${l.how}`,
    ...(l.url ? [`URL: ${l.url}`] : []),
    ...(l.author ? [`Author: ${l.author}`] : []),
    ...(l.attribution ? [`Attribution: ${l.attribution}`] : []),
    ...(l.from?.length ? [`Made from: ${l.from.join(', ')}`] : []),
    `File: ${path.basename(file)}`,
    '',
  ].join('\n');
}
export function writeSidecar(file: string, l: Licence) {
  if (!KNOWN.test(l.spdx)) throw new Error(`${path.basename(file)}: "${l.spdx}" is not a licence the studio knows how to credit`);
  fs.writeFileSync(file + '.license', sidecarText(file, l));
}
export function readSidecar(file: string): Partial<Licence> | null {
  const f = file + '.license';
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  const get = (k: string) => t.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1];
  return { spdx: get('SPDX-License-Identifier'), copyright: get('SPDX-FileCopyrightText'), url: get('URL'), author: get('Author'), attribution: get('Attribution') };
}

const AUDIO = /\.(wav|ogg|mp3|m4a|flac|opus)$/i;
/** Every audio file under `dir` and whether it has a licence (sidecar, or an entry in sound.json). */
export function audit(dir: string) {
  const files: string[] = [];
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (AUDIO.test(e.name)) files.push(p); } };
  walk(dir);
  const rows = files.map((f) => { const l = readSidecar(f); return { file: path.relative(dir, f), spdx: l?.spdx ?? null, copyright: l?.copyright ?? null, ok: !!l?.spdx && KNOWN.test(l.spdx) && !!l.copyright, attribution: l?.attribution ?? null }; });
  return { files: rows.length, missing: rows.filter((r) => !r.ok).map((r) => r.file), rows };
}

/** CREDITS.md for a pack: what needs attribution first, then CC0/generated sources as a courtesy. */
export function creditsMarkdown(title: string, entries: Array<{ file: string; licence: Licence }>): string {
  const needs = entries.filter((e) => NEEDS_ATTRIBUTION(e.licence.spdx));
  const third = entries.filter((e) => !NEEDS_ATTRIBUTION(e.licence.spdx) && e.licence.source === 'library');
  const own = entries.filter((e) => !NEEDS_ATTRIBUTION(e.licence.spdx) && e.licence.source !== 'library');
  const byWork = new Map<string, { l: Licence; files: string[] }>();
  for (const e of [...needs, ...third]) { const k = e.licence.url ?? e.licence.how; const w = byWork.get(k) ?? { l: e.licence, files: [] }; w.files.push(e.file); byWork.set(k, w); }
  const lines = [`# ${title}: sound credits`, '', 'Generated from the licence sidecars (`<file>.license`, REUSE style). Do not edit by hand: re-run `studio sound credits`.', ''];
  const work = (w: { l: Licence; files: string[] }) => `- **${w.l.how}**${w.l.author ? ` by ${w.l.author}` : ''} — ${w.l.spdx}${w.l.url ? ` — <${w.l.url}>` : ''}${w.l.attribution ? `\n  ${w.l.attribution}` : ''}\n  files: ${w.files.join(', ')}`;
  if (needs.length) { lines.push('## Attribution required', ''); for (const w of byWork.values()) if (NEEDS_ATTRIBUTION(w.l.spdx)) lines.push(work(w)); lines.push(''); }
  if (third.length) { lines.push('## Public domain (CC0) recordings — credited as a courtesy', ''); for (const w of byWork.values()) if (!NEEDS_ATTRIBUTION(w.l.spdx)) lines.push(work(w)); lines.push(''); }
  if (own.length) {
    lines.push('## Made by the studio', '');
    const groups = new Map<string, string[]>();
    for (const e of own) { const k = `${e.licence.source} (${e.licence.spdx}, ${e.licence.copyright})`; groups.set(k, [...(groups.get(k) ?? []), e.file]); }
    for (const [k, fs_] of groups) lines.push(`- ${k}: ${fs_.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
