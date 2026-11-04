// `studio print` (Decision 43): checks → each piece as an STL (mm, Z-up) → Bambu Studio's own
// command line builds an A1 mini project (your presets, flattened; laid on the bed, arranged) →
// the project opens in Bambu Studio, where you look at the plate and press Print. The studio
// never talks to the printer. If the command line fails, a checked STL opens instead and the
// result says why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRINTERS, localPositions, setFitDefaults, onFitRecorded, DEFAULT_FIT, type FitGaps, type Studio, type SceneObject, type EvalResult } from '../../core/src/index.ts';
import { findBambu, buildProject, openInBambu, read3mfEntry, runBambuCli, presetNames, type PresetChoice } from './bambu.ts';

// ── fit calibration lives with you, not with one project ───────────────
const CAL_FILE = () => process.env.STUDIO_PRINT_CALIBRATION ?? path.join(os.homedir(), '.config', 'ai-3d-studio', 'print-calibration.json');
export function installFitCalibration() {
  setFitDefaults(() => {
    try { const j = JSON.parse(fs.readFileSync(CAL_FILE(), 'utf8')); return { ...DEFAULT_FIT, ...(j.fit ?? {}) } as FitGaps; } catch { return DEFAULT_FIT; }
  });
  onFitRecorded((fit) => {
    try { fs.mkdirSync(path.dirname(CAL_FILE()), { recursive: true }); fs.writeFileSync(CAL_FILE(), JSON.stringify({ printer: 'a1-mini', fit, at: new Date().toISOString() }, null, 2)); } catch { /* not fatal */ }
  });
}

/** Your own copy of a filament preset (e.g. "Bambu PLA Basic @BBL A1M - Copy") if you made one, else the system preset. */
function defaultFilament(system: string): string {
  const names = presetNames('filament');
  const yours = names.find((n) => n.startsWith(`${system} - `)) ?? names.find((n) => n.startsWith(system) && n !== system && !n.includes('nozzle'));
  return yours ?? system;
}

/** Split a mesh into its separate pieces (shared positions join triangles). */
function splitPieces(p: Float32Array, idx: Uint32Array): Array<{ positions: Float32Array; indices: Uint32Array }> {
  const n = p.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p[i * 3] * 1e5)},${Math.round(p[i * 3 + 1] * 1e5)},${Math.round(p[i * 3 + 2] * 1e5)}`;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i); else join(i, j);
  }
  for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    const g = groups.get(r) ?? [];
    g.push(t);
    groups.set(r, g);
  }
  return [...groups.values()].map((tris) => {
    const map = new Map<number, number>();
    const pos: number[] = [], ind: number[] = [];
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      let m = map.get(v);
      if (m === undefined) { m = pos.length / 3; map.set(v, m); pos.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]); }
      ind.push(m);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(ind) };
  });
}

/** Binary STL in millimetres, Z-up, resting on z = 0. */
function stlBytes(p: Float32Array, idx: Uint32Array): Uint8Array {
  let minY = Infinity;
  for (let i = 1; i < p.length; i += 3) minY = Math.min(minY, p[i]);
  const tris = idx.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const head = 'ai-3d-studio print (mm, Z-up)';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  const at = (v: number) => [p[v * 3] * 1000, -p[v * 3 + 2] * 1000, (p[v * 3 + 1] - minY) * 1000];
  for (let t = 0; t < tris; t++) {
    const a = at(idx[t * 3]), b = at(idx[t * 3 + 1]), c = at(idx[t * 3 + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [nx / l, ny / l, nz / l, ...a, ...b, ...c]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

export interface PrintArgs { object?: string; out?: string; open?: boolean; estimate?: boolean; force?: boolean; orient?: boolean }

export async function printTool(studio: Studio, dir: string, stateDir: string, args: PrintArgs): Promise<any> {
  const name = 'print';
  const doc = studio.doc();
  let obj: SceneObject;
  try {
    obj = args.object ? studio.findObject(doc, args.object)
      : (doc.objectOrder.map((id) => doc.objects[id]).filter((o) => o?.print).pop() ?? studio.findObject(doc, undefined));
  } catch (e: any) { return { ok: false, tool: name, error: e.message }; }
  const res: EvalResult = studio.evaluate(obj);
  if (!res.ok) return { ok: false, tool: name, error: `${obj.name} doesn't evaluate: ${res.error}` };
  const notes: string[] = [];
  if (!obj.print) notes.push(`${obj.name} has no print profile: printing with the A1 mini defaults (studio set-print-profile adds the print checks while you model)`);
  const printer = PRINTERS[obj.print?.printer ?? 'a1-mini'];

  // checks must be green: failing = refuse (pending = not finished); --force true prints anyway
  const checks = studio.checks(obj.id, doc);
  const blocking = checks.filter((c) => !c.pass && (c.pending || /^(print-|geometry|watertight|connected|aboveFloor)/.test(c.id)));
  if (blocking.length && !args.force) {
    return { ok: false, tool: name, error: `not ready to print:\n${blocking.map((c) => `${c.pending ? '[pending] ' : ''}${c.label} — ${c.detail}`).join('\n')}`, hint: 'fix these (studio check; studio print-fix --fix lay-flat|chamfer|split), or --force true to print anyway' };
  }
  const advice = checks.filter((c) => c.id === 'print-overhangs' || c.id === 'print-base').map((c) => `${c.label}: ${c.detail}`);

  // each separate piece as its own STL, so Bambu Studio places them as separate objects
  const outDir = path.join(stateDir, 'prints');
  const work = path.join(outDir, `.work-${obj.id}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const local = localPositions(obj, res);
  const pieces = splitPieces(local, res.indices);
  const stls = pieces.map((pc, i) => {
    const f = path.join(work, pieces.length > 1 ? `${obj.id}-${i + 1}.stl` : `${obj.id}.stl`);
    fs.writeFileSync(f, stlBytes(pc.positions, pc.indices));
    return f;
  });

  const out = args.out ? path.resolve(dir, args.out) : path.join(outDir, `${obj.id}.3mf`);
  const presets: PresetChoice = {
    machine: printer.bambu.machine,
    process: obj.print?.process ?? printer.bambu.process,
    filament: obj.print?.filament ?? defaultFilament(printer.bambu.filament),
  };
  const app = findBambu();
  const fallback = (why: string) => {
    const stl = path.join(outDir, `${obj.id}.stl`);
    fs.copyFileSync(stls[0], stl);
    const extra = stls.slice(1).map((s, i) => { const f = path.join(outDir, `${obj.id}-${i + 2}.stl`); fs.copyFileSync(s, f); return f; });
    const opened = args.open === false || !app ? { opened: false } : openInBambu(stl);
    return {
      ok: true, tool: name, result: {
        file: stl, files: [stl, ...extra], fallback: why, opened: opened.opened,
        next: `In Bambu Studio: choose printer "${presets.machine}", filament "${presets.filament}", then press Print.`,
        checks: advice, notes,
      },
    };
  };
  if (!app) return fallback('Bambu Studio is not installed at /Applications/BambuStudio.app (set BAMBU_STUDIO_APP to its path)');

  let built;
  try { built = await buildProject(stls, out, presets, path.join(work, 'presets'), { orient: !!args.orient }); }
  catch (e: any) { return fallback(`could not prepare the presets: ${e.message}`); }
  if (!built.ok) return fallback(`Bambu Studio's command line failed (exit ${built.code}): ${built.out.split('\n').filter((l) => /error|fail/i.test(l)).slice(-3).join(' | ') || 'no project written'}`);

  // what the project says
  let project: Record<string, unknown> = {};
  try {
    const j = JSON.parse(read3mfEntry(out, 'Metadata/project_settings.config') ?? '{}');
    project = { printer: j.printer_model, printerPreset: j.printer_settings_id, process: j.print_settings_id, filament: Array.isArray(j.filament_settings_id) ? j.filament_settings_id[0] : j.filament_settings_id };
  } catch { /* leave empty */ }
  if (project.printer && !String(project.printer).includes('A1 mini')) notes.push(`the project says printer "${project.printer}" — check it in Bambu Studio`);

  // a quick estimate: slice a copy in the background (the project you open stays unsliced)
  let estimate: Record<string, unknown> | null = null;
  if (args.estimate !== false) {
    const sdir = path.join(work, 'slice');
    fs.mkdirSync(sdir, { recursive: true });
    const r = await runBambuCli(['--slice', '0', '--outputdir', sdir, out], 180000);
    const g = path.join(sdir, 'plate_1.gcode');
    if (fs.existsSync(g)) {
      const head = fs.readFileSync(g, 'utf8').slice(0, 2000);
      const pick = (re: RegExp) => re.exec(head)?.[1];
      estimate = {
        time: pick(/total estimated time: ([^\n;]+)/), layers: Number(pick(/total layer number: (\d+)/)) || undefined,
        filamentM: pick(/total filament length \[mm\] : ([\d.]+)/) ? +(Number(pick(/total filament length \[mm\] : ([\d.]+)/)) / 1000).toFixed(2) : undefined,
        grams: pick(/total filament weight \[g\] : ([\d.]+)/) ? Number(pick(/total filament weight \[g\] : ([\d.]+)/)) : undefined,
        plates: fs.readdirSync(sdir).filter((f) => /^plate_\d+\.gcode$/.test(f)).length,
      };
    } else if (!r.ok) notes.push('no time estimate: the background slice did not finish (the project itself is fine)');
  }
  const opened = args.open === false ? { opened: false, note: '--open false' } : openInBambu(out);
  return {
    ok: true, tool: name, result: {
      file: out, pieces: stls.length, presets: { ...presets, note: 'flattened into complete presets for the command line' }, project, estimate,
      opened: opened.opened, ...(opened.note ? { openNote: opened.note } : {}),
      next: opened.opened ? 'Bambu Studio is open with the project on the plate: look it over (supports, orientation), then press Print.' : `Open ${out} in Bambu Studio, look it over, press Print.`,
      checks: advice, notes, bambuStudio: app.version,
    },
  };
}
