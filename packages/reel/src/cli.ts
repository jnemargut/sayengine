// `studio reel <command>` — the reel module's hands (Decision 32). Runs in the CLI process: it drives Godot's
// movie mode, headless Chrome, librosa and ffmpeg; it never needs the studio daemon.
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from '../../cli/client.ts';

export const REEL_COMMANDS: Record<string, { description: string; flags: Record<string, string>; example: string }> = {
  music: { description: 'Make the reel\'s track (seeded stems arranged into its sections, a riser into the drop, hits) or take --file from the reel, then find its beats with librosa (~/.studio-tools/venv). Reports the track\'s loudness and how far the detected grid is from the known one.', flags: { '--project': 'game', '--reel': 'reel file (default reel/trailer.json)' }, example: 'studio reel music --project pocket-raleigh' },
  capture: { description: 'Capture the takes from the game itself: Godot movie mode (--write-movie at a fixed fps: no dropped frames) or --engine web (fixed step in headless Chrome; slow on software GL, use --size 480 for checks). Square frames; every shape is cropped from them. Writes a storyboard sheet to Read.', flags: { '--project': 'game', '--reel': 'reel file', '--engine': 'godot (default) | web', '--takes': 'comma-separated take ids (default all)', '--size': 'override the capture side (px)' }, example: 'studio reel capture --project pocket-raleigh --takes night-crown,night-plaza' },
  cut: { description: 'Cut the edit on the beats and render every shape (16:9, 1:1, 9:16) through one ffmpeg recipe each (written next to the videos as recipe-*.sh), with a still per shot and a sheet per shape to Read. Re-cutting never re-captures.', flags: { '--project': 'game', '--reel': 'reel file', '--out': 'output folder (default reel/out/<id>)', '--aspects': 'comma-separated (default all three)', '--engine': 'which capture to cut (godot | web)' }, example: 'studio reel cut --project pocket-raleigh --out checkpoint-pocket-raleigh/reel' },
  board: { description: 'A storyboard of the captured takes (first, middle, last frame each) to check framing before cutting.', flags: { '--project': 'game', '--reel': 'reel file', '--out': 'sheet path' }, example: 'studio reel board --project pocket-raleigh' },
  release: { description: 'Release checks on the cut videos (Decision 31): on-Mac OCR of sampled frames against the brand, team and wording lists (+ the game\'s proof/release-lists.json), required credit lines, every sound file licensed; writes release.json, CREDITS.md and REUSE.toml next to the videos.', flags: { '--project': 'game', '--reel': 'reel file', '--out': 'the cut\'s folder' }, example: 'studio reel release --project pocket-raleigh --out checkpoint-pocket-raleigh/reel' },
};

export async function reelCli(argv: string[], parseFlags: (a: string[]) => Record<string, unknown>): Promise<any> {
  const sub = argv.shift();
  if (!sub || sub === 'help' || sub === '--help') return { ok: true, usage: 'studio reel <command> [--flag value]…', commands: Object.fromEntries(Object.entries(REEL_COMMANDS).map(([k, v]) => [k, v.description])), examples: Object.values(REEL_COMMANDS).map((v) => v.example), order: 'music → capture → board (look) → cut → release; after an edit to the reel file only cut (and release) re-run' };
  const def = REEL_COMMANDS[sub];
  if (!def) return { ok: false, error: `unknown reel command "${sub}"`, commands: Object.keys(REEL_COMMANDS) };
  if (argv.includes('--help')) return { command: `reel ${sub}`, ...def };
  const a = parseFlags(argv);
  const known = Object.keys(def.flags).map((f) => f.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const unknown = Object.keys(a).filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`, flags: Object.keys(def.flags), example: def.example };
  try {
    const { resolveProject } = await import('../../game/src/project.ts');
    const { dir } = resolveProject(DIR, a.project);
    const M = await import('./make.ts');
    const reelFile = path.resolve(dir, String(a.reel ?? 'reel/trailer.json'));
    if (!fs.existsSync(reelFile)) return { ok: false, tool: `reel-${sub}`, error: `no reel file ${path.relative(DIR, reelFile)}`, hint: 'write one: takes (camera keys, look, crop per shape) + edit (take, beats, caption) — see .claude/skills/reel/SKILL.md' };
    const reel = M.readReel(reelFile), work = M.workDirFor(dir, reel);
    const out = path.resolve(DIR, String(a.out ?? path.join(dir, 'reel', 'out', reel.id)));
    const list = (v: unknown) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    switch (sub) {
      case 'music': return { ok: true, tool: 'reel-music', result: M.reelMusic(reel, work, `${path.basename(dir)} authors`) };
      case 'capture': {
        const r = await M.reelCapture(reel, dir, work, { engine: (a.engine as any) ?? 'godot', takes: list(a.takes), size: a.size as number | undefined });
        const board = M.storyboard(reel, work, path.join(work, 'storyboard.jpg'), (a.engine as any) ?? 'godot');
        return { ok: true, tool: 'reel-capture', result: { takes: r, storyboard: board } };
      }
      case 'board': return { ok: true, tool: 'reel-board', result: { storyboard: M.storyboard(reel, work, String(a.out ?? path.join(work, 'storyboard.jpg'))) } };
      case 'cut': return { ok: true, tool: 'reel-cut', result: await M.reelCut(reel, work, out, (list(a.aspects) as any) ?? undefined, (a.engine as any) ?? 'godot') };
      case 'release': {
        const R = await import('../../proof/src/release.ts');
        const cutFile = path.join(out, `${reel.id}-cut.json`);
        if (!fs.existsSync(cutFile)) return { ok: false, tool: 'reel-release', error: 'no cut yet', hint: 'studio reel cut first' };
        const cut = JSON.parse(fs.readFileSync(cutFile, 'utf8'));
        const lists = R.loadLists(dir);
        const extra = (cut.shots as any[]).filter((s) => s.caption).map((s) => (s.start + s.end) / 2).concat(cut.endCard ? [(cut.endCard.start + cut.endCard.end) / 2] : []);
        const videos = (cut.videos as any[]).map((v) => v.video);
        const texts = [...reel.edit.flatMap((e, i) => [e.caption, e.title?.text, e.title?.sub].filter(Boolean).map((t) => ({ where: `edit shot ${i + 1}`, text: t! }))), ...(reel.endCard ? [reel.endCard.title, reel.endCard.sub, reel.endCard.credit].filter(Boolean).map((t) => ({ where: 'end card', text: t! })) : [])];
        const r = R.releaseCheck({ media: videos, texts, lists, work: path.join(work, 'release'), soundDirs: [path.join(dir, 'assets', 'studio', 'sound'), work], videoExtra: Object.fromEntries(videos.map((v) => [v, extra])) });
        const music = fs.existsSync(path.join(work, 'music.wav.license')) ? fs.readFileSync(path.join(work, 'music.wav.license'), 'utf8') : '';
        const credits = [`# ${reel.title}: credits`, '', '- Pictures: captured from the game (Godot ' + 'movie mode); towns built from open data:', '  - Map data © OpenStreetMap contributors, ODbL 1.0 — <https://www.openstreetmap.org/copyright>', '  - Buildings: Overture Maps Foundation (ODbL 1.0 for OSM-derived data) — <https://overturemaps.org>', '  - Ground heights: USGS 3D Elevation Program (public domain)', `- Music: ${music.match(/Source: (.*)/)?.[1] ?? 'see music.wav.license'} — ${music.match(/SPDX-License-Identifier: (.*)/)?.[1] ?? '?'}`, '- Titles: drawn with the Mac\'s system fonts (Avenir Next), rendered to pixels (no font file is distributed)', ''].join('\n');
        fs.writeFileSync(path.join(out, 'CREDITS.md'), credits);
        fs.writeFileSync(path.join(out, 'REUSE.toml'), R.reuseToml([{ path: `${reel.id}-*.mp4`, copyright: [`${new Date().getFullYear()} ${path.basename(dir)} authors`, 'OpenStreetMap contributors', 'Overture Maps Foundation'], licence: 'LicenseRef-Produced-Work-ODbL', comment: 'a Produced Work from ODbL databases (OSM, Overture): the end card carries the attribution; music CC0-1.0 (generated)' }]));
        fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(r, null, 2));
        return { ok: r.ok, tool: 'reel-release', result: { ...r, textsSeen: r.textsSeen.length, report: path.join(out, 'release.json') }, ...(r.ok ? {} : { error: `${r.findings.length} finding(s) to review` }) };
      }
    }
  } catch (e: any) {
    return { ok: false, tool: `reel-${sub}`, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  }
  return { ok: false, error: 'unreachable' };
}
