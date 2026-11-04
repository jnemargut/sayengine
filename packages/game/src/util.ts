// Pure helpers shared by both back ends (unit-tested in packages/game/test).

export const VIEWS = ['iso', 'front', 'side', 'back', 'top', 'low'] as const;
export type View = (typeof VIEWS)[number];

/** "iso,front" | ["iso","front"] → validated view list. */
export function parseViews(v: unknown, fallback: View[] = ['iso', 'front']): View[] {
  if (v === undefined || v === null || v === '') return fallback;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((s) => !(VIEWS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`unknown view${bad.length > 1 ? 's' : ''} ${bad.join(', ')} — use ${VIEWS.join(', ')}`);
  return [...new Set(list)] as View[];
}

/** Camera direction for a view (unnormalized), the same table the Godot runner uses. */
export function viewDir(view: string): [number, number, number] {
  switch (view) {
    case 'front': return [0, 0.18, 1];
    case 'back': return [0, 0.18, -1];
    case 'side': return [1, 0.18, 0];
    case 'top': return [0.001, 1, 0.001];
    case 'low': return [0.9, 0.12, 1.1];
    default: return [1, 0.75, 1.15];
  }
}

export interface Box { min: [number, number, number]; max: [number, number, number] }

/** Camera placement that frames a box from a view direction with a vertical fov (degrees). */
export function frame(box: Box, view: string, fovDeg = 40): { position: [number, number, number]; target: [number, number, number]; near: number; far: number } {
  const c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2) as [number, number, number];
  const r = Math.max(Math.hypot(...[0, 1, 2].map((k) => box.max[k] - box.min[k])) / 2, 0.4);
  const d = viewDir(view);
  const l = Math.hypot(...d);
  const dist = (r / Math.tan((fovDeg * Math.PI) / 360)) * 1.1;
  return { position: [0, 1, 2].map((k) => c[k] + (d[k] / l) * dist) as [number, number, number], target: c, near: Math.max(dist - r * 3, 0.02), far: dist + r * 6 };
}

/** Distance in the floor plane from a point to a box's footprint (0 inside). */
export function xzDistToBox(p: [number, number, number], b: Box): number {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]);
  const dz = Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]);
  return Math.hypot(dx, dz);
}

/** Candidate spawn points around a target box, nearest-first in a fixed order (+z first). */
export function spawnCandidates(b: Box, distance = 3): Array<[number, number, number]> {
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const ext = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
  const dirs: Array<[number, number]> = [[0, 1], [1, 0], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]];
  return dirs.map(([x, z]) => [cx + x * (ext + distance), 0, cz + z * (ext + distance)]);
}

/** A walk target: an object name, or [x,z] / [x,y,z] in metres. */
export function parseTarget(t: unknown): string | [number, number, number] {
  if (Array.isArray(t)) {
    if (t.length === 2 && t.every((n) => typeof n === 'number')) return [t[0], 0, t[1]];
    if (t.length === 3 && t.every((n) => typeof n === 'number')) return t as [number, number, number];
    throw new Error('target as coordinates must be [x, z] or [x, y, z] in metres');
  }
  if (typeof t === 'string' && t.trim()) {
    if (/^\s*\[/.test(t)) return parseTarget(JSON.parse(t));
    return t.trim();
  }
  throw new Error('--target is required: an object name ("Walnut stool") or [x, z]');
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Split Godot console output into the runner's JSON result, import reports, warnings and errors. */
export function parseGodotOutput(text: string): { result: any | null; imports: any[]; warnings: string[]; errors: string[]; prints: string[] } {
  const out = { result: null as any, imports: [] as any[], warnings: [] as string[], errors: [] as string[], prints: [] as string[] };
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('STUDIO_RESULT ')) { try { out.result = JSON.parse(line.slice(14)); } catch { out.errors.push(`unreadable runner result: ${line.slice(0, 200)}`); } continue; }
    if (line.startsWith('STUDIO_IMPORT ')) { try { out.imports.push(JSON.parse(line.slice(14))); } catch { /* ignore */ } continue; }
    // "at: …" continuation lines belong to the previous warning/error
    const at = lines[i + 1]?.replace(ANSI, '').trim();
    const where = at && /^at: /.test(at) ? ` (${at.slice(4)})` : '';
    if (/^(SCRIPT )?ERROR:/.test(line) || /^USER ERROR:/.test(line)) { out.errors.push(line.replace(/^(SCRIPT |USER )?ERROR:\s*/, '') + where); continue; }
    if (/^(USER )?WARNING:/.test(line)) { out.warnings.push(line.replace(/^(USER )?WARNING:\s*/, '') + where); continue; }
    if (/^at: /.test(line) || /^Godot Engine v/.test(line) || /^\[\s*\d+% \]/.test(line) || /DONE/.test(line)) continue;
    out.prints.push(line);
  }
  return out;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}
