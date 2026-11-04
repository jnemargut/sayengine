// Readable "program" view of an object's op graph (Decision 3: stored as typed ops, shown as code).
import type { SceneObject } from './types.ts';

const fmt = (v: unknown): string => {
  if (typeof v === 'number') return String(+v.toFixed(5));
  if (typeof v === 'string') return /^[A-Za-z_]\w*$/.test(v) && !v.startsWith('$') ? JSON.stringify(v) : v.includes(':') ? v : v;
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join(', ')} }`;
  return String(v);
};

export function codeView(obj: SceneObject): string {
  const lines: string[] = [];
  lines.push(`// ${obj.name} (${obj.semanticType})${obj.description ? ' — ' + obj.description : ''}`);
  for (const [k, p] of Object.entries(obj.params)) {
    const unit = p.unit === 'deg' ? '°' : p.unit === 'm' ? ' m' : '';
    const range = p.min !== undefined || p.max !== undefined ? `   // ${p.min ?? ''}…${p.max ?? ''}` : '';
    lines.push(`param ${k} = ${+p.value.toFixed(5)}${unit}${range}`);
  }
  if (Object.keys(obj.params).length) lines.push('');
  const w = Math.max(4, ...obj.opOrder.map((id) => id.length));
  for (const id of obj.opOrder) {
    const n = obj.ops[id];
    if (!n) continue;
    const args = Object.entries(n.args ?? {}).map(([k, v]) => `${k}: ${fmt(v)}`);
    const inputs = n.inputs?.length ? n.inputs.join(', ') : '';
    const inner = [inputs, ...args].filter(Boolean).join(', ');
    const part = n.part && n.part !== id ? `   // part "${n.part}"` : '';
    const out = obj.output === id ? '   ← output' : '';
    lines.push(`${id.padEnd(w)} = ${n.op}(${inner})${part}${out}`);
  }
  if (!obj.opOrder.length) lines.push('// no construction ops yet');
  return lines.join('\n');
}
