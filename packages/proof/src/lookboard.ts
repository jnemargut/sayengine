// `studio look board|ab|pick` — the look's reference board and gates (Decision 29), on the pictures the
// engines actually rendered (the latest proof run, or a fresh one). Numbers first: colourfulness range,
// palette match, a local style score (DINOv2-small via ~/.studio-tools/venv, optional). Then a human —
// or Claude — picks between two versions, A or B, never a score out of 10; picks are logged.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../../game/src/project.ts';
import { decodePng } from '../../core/src/look/png.ts';
import { boardGates, type GateResult } from '../../core/src/look/gates.ts';
import { contactSheet, proofViews } from './proof.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLE_PY = path.join(HERE, '..', '..', 'core', 'src', 'look', 'style.py');

/** The python that can run the style model (torch + transformers), or null. */
export function findStylePython(): string | null {
  const c = [process.env.STYLE_PYTHON, path.join(process.env.HOME ?? '', '.studio-tools', 'venv', 'bin', 'python')].filter(Boolean) as string[];
  for (const p of c) if (fs.existsSync(p)) { const r = spawnSync(p, ['-I', '-c', 'import torch, transformers, PIL'], { encoding: 'utf8' }); if (r.status === 0) return p; }
  return null;
}

/** Local style scores: mean cosine similarity of each image to the references (DINOv2-small). */
export function styleScores(images: string[], refs: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = Object.fromEntries(images.map((i) => [i, null]));
  if (!refs.length || !images.length) return out;
  const py = findStylePython();
  if (!py) return out;
  const r = spawnSync(py, ['-I', STYLE_PY], { input: JSON.stringify({ items: images.map((image) => ({ image, refs })) }), encoding: 'utf8', maxBuffer: 16 << 20, timeout: 600000, env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' } });
  if (r.status !== 0) throw new Error(`style model failed: ${(r.stderr || r.stdout).slice(-400)}`);
  for (const x of JSON.parse(r.stdout)) out[x.image] = x.mean;
  return out;
}

function latestRun(dir: string): string | null {
  const root = path.join(dir, '.studio-game', 'proof');
  if (!fs.existsSync(root)) return null;
  const runs = fs.readdirSync(root).filter((d) => !d.startsWith('phone-') && fs.existsSync(path.join(root, d, 'report.json'))).sort();
  return runs.length ? path.join(root, runs[runs.length - 1]) : null;
}

export interface BoardRow { engine: string; view: string; image: string; gates: GateResult[] }
/** studio look board: gates for every rendered view against the active look's board. */
export async function lookBoard(studioDir: string, project: string, opts: { against?: string; render?: boolean } = {}) {
  const { dir } = resolveProject(studioDir, project);
  const lookFile = path.join(dir, 'assets', 'studio', 'look', 'look.json');
  if (!fs.existsSync(lookFile)) throw Object.assign(new Error('this game has no look yet'), { hint: 'studio look-new --preset day-toy, then studio game import' });
  const look = JSON.parse(fs.readFileSync(lookFile, 'utf8'));
  let run = opts.render ? null : latestRun(dir);
  if (!run) run = (await proofViews(studioDir, project, { against: opts.against })).run;
  const refs = (look.board?.references ?? []).map((r: string) => path.resolve(studioDir, r)).filter((f: string) => fs.existsSync(f));
  const refImgs = refs.filter((f: string) => f.endsWith('.png')).map((f: string) => decodePng(new Uint8Array(fs.readFileSync(f))));
  const files: Array<{ engine: string; view: string; image: string }> = [];
  for (const engine of ['godot', 'web']) {
    const d = path.join(run!, engine);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.png') && !x.includes('.diff')).sort()) files.push({ engine, view: f.replace(/\.png$/, ''), image: path.join(d, f) });
  }
  if (!files.length) throw new Error(`no pictures in ${run}`);
  const style = styleScores(files.map((f) => f.image), refs);
  const rows: BoardRow[] = files.map((f) => ({ ...f, gates: boardGates(decodePng(new Uint8Array(fs.readFileSync(f.image))), look.board, look.palette ?? {}, refImgs, style[f.image]) }));
  const summary: Record<string, { pass: number; fail: number; unset: number; values: number[] }> = {};
  for (const r of rows) for (const g of r.gates) {
    const s = (summary[g.name] ??= { pass: 0, fail: 0, unset: 0, values: [] });
    if (g.pass === true) s.pass++; else if (g.pass === false) s.fail++; else s.unset++;
    if (typeof g.value === 'number') s.values.push(g.value);
  }
  const sheet = contactSheet([...refs.filter((f: string) => /\.(png|jpe?g)$/i.test(f)), ...files.map((f) => f.image)], 4, path.join(run!, `board-${look.name}.png`));
  const report = {
    ok: rows.every((r) => r.gates.every((g) => g.pass !== false)), look: look.name, run: path.relative(studioDir, run!), references: refs.map((r: string) => path.relative(studioDir, r)),
    targets: look.board ?? null, styleModel: refs.length ? (findStylePython() ? 'DINOv2-small (local)' : 'not installed: ~/.studio-tools/venv/bin/pip install torch transformers') : 'no reference pictures',
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { pass: v.pass, fail: v.fail, notSet: v.unset, range: v.values.length ? [Math.min(...v.values), Math.max(...v.values)] : null }])),
    views: rows.map((r) => ({ engine: r.engine, view: r.view, ...Object.fromEntries(r.gates.map((g) => [g.name, g.value])), failing: r.gates.filter((g) => g.pass === false).map((g) => `${g.name} ${g.value} (target ${g.target})`) })),
    sheet: sheet ? path.relative(studioDir, sheet) : null,
    note: 'Numbers catch "too saturated", not "no charm": look at the sheet, then pick A/B (studio look ab / look pick). Never score a look out of 10.',
  };
  fs.writeFileSync(path.join(run!, `board-${look.name}.json`), JSON.stringify(report, null, 2));
  return report;
}

/** studio look ab: A beside B for each view (folders of stills or two pictures), one sheet to Read. */
export function lookAB(studioDir: string, a: string, b: string, opts: { views?: string[]; out?: string } = {}) {
  const A = path.resolve(studioDir, a), B = path.resolve(studioDir, b);
  const pairs: Array<[string, string]> = [];
  if (fs.statSync(A).isDirectory()) {
    for (const f of fs.readdirSync(A).filter((x) => x.endsWith('.png')).sort()) {
      const v = f.replace(/\.png$/, '');
      if (opts.views && !opts.views.some((w) => v.includes(w))) continue;
      if (fs.existsSync(path.join(B, f))) pairs.push([path.join(A, f), path.join(B, f)]);
    }
  } else pairs.push([A, B]);
  if (!pairs.length) throw new Error('no matching pictures in A and B');
  const out = path.resolve(studioDir, opts.out ?? path.join('.studio', 'look', `ab-${Date.now()}.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const sheet = contactSheet(pairs.flat(), 2, out, 640);
  return { sheet: sheet ? path.relative(studioDir, sheet) : null, pairs: pairs.length, layout: 'each row: A (left) | B (right)', next: 'studio look pick --a <A> --b <B> --pick A|B --why "…"' };
}

/** studio look pick: log an A/B choice (the only way a look is judged). */
export function lookPick(studioDir: string, a: string, b: string, pick: string, why: string, log?: string, author = process.env.STUDIO_AUTHOR ?? 'claude') {
  if (!/^[AB]$/.test(pick)) throw new Error('--pick must be A or B (looks are judged by A/B picks, never scores)');
  if (!why?.trim()) throw new Error('--why: say what made the pick (one line)');
  const f = path.resolve(studioDir, log ?? path.join('.studio', 'look', 'picks.jsonl'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const entry = { time: new Date().toISOString(), author, a, b, pick, why };
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  return { logged: path.relative(studioDir, f), ...entry };
}
