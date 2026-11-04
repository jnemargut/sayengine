// Deterministic checks — the authority on anything measurable (Decision 6).
import { evalExpr } from './expr.ts';
import type { EvalResult } from './kernel.ts';
import { DEFAULT_RULES, type Rule, type SceneObject } from './types.ts';

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
  parts?: string[]; // failing parts, for highlighting
  pending?: boolean; // "not finished yet" (no output, unused op, part not built yet) — expected mid-build, must clear before done
}

const TOL = 0.001; // 1 mm

function globToRegex(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\#]/g, '\\$&')).join('.*') + '$');
}

export function rulesFor(obj: SceneObject): Rule[] {
  return obj.rules.length ? obj.rules : DEFAULT_RULES[obj.semanticType] ?? DEFAULT_RULES.default;
}

const mm = (m: number) => `${(m * 1000).toFixed(1)} mm`;

export function runChecks(obj: SceneObject, res: EvalResult): CheckResult[] {
  const out: CheckResult[] = [];
  if (!obj.output) {
    out.push({ id: 'geometry', label: 'Has geometry', pass: false, pending: true, detail: 'no output op yet — add ops and set an output' });
    return out;
  }
  if (!res.ok) {
    out.push({
      id: 'geometry', label: 'Geometry evaluates', pass: false,
      detail: res.error ? `${res.errorOp ? `op "${res.errorOp}": ` : ''}${res.error}` : 'evaluation failed',
    });
    return out;
  }
  out.push({ id: 'watertight', label: 'Watertight solid', pass: res.status === 'NoError', detail: `${res.triangles} triangles, status ${res.status}` });
  if (res.unusedOps.length) {
    out.push({ id: 'unused', label: 'All ops used', pass: false, pending: true, detail: `not connected to output: ${res.unusedOps.join(', ')}` });
  }
  const params = Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value]));
  const b = res.bbox!;
  const measures = { ...params, width: b.max[0] - b.min[0], height: b.max[1] - b.min[1], depth: b.max[2] - b.min[2] };

  for (const [i, rule] of rulesFor(obj).entries()) {
    switch (rule.kind) {
      case 'grounded': {
        const re = globToRegex(rule.parts);
        const parts = res.parts.filter((p) => re.test(p.name));
        if (!parts.length) {
          out.push({ id: `grounded-${i}`, label: rule.label ?? `Parts "${rule.parts}" touch the floor`, pass: false, pending: true, detail: `no parts named "${rule.parts}" yet` });
          break;
        }
        const bad = parts.filter((p) => Math.abs(p.bbox.min[1]) > TOL);
        out.push({
          id: `grounded-${i}`,
          label: rule.label ?? `All ${parts.length} ${rule.parts.replace('*', '')}s grounded`,
          pass: bad.length === 0,
          detail: bad.length
            ? bad.map((p) => `${p.name} ${p.bbox.min[1] > 0 ? `floats ${mm(p.bbox.min[1])} above` : `sinks ${mm(-p.bbox.min[1])} below`} the floor`).join('; ')
            : `${parts.length} part(s) within 1 mm of y = 0`,
          parts: bad.map((p) => p.name),
        });
        break;
      }
      case 'connected':
        out.push({
          id: `connected-${i}`, label: rule.label ?? 'One connected piece', pass: res.components === 1,
          detail: res.components === 1 ? 'single solid' : `${res.components} separate pieces — something is floating, or two parts only touch face-to-face (that counts as separate: sink one into the other by 1–2 mm)`,
        });
        break;
      case 'aboveFloor': {
        const below = res.parts.filter((p) => p.bbox.min[1] < -TOL);
        out.push({
          id: `aboveFloor-${i}`, label: rule.label ?? 'Nothing below the floor', pass: below.length === 0,
          detail: below.length ? below.map((p) => `${p.name} min y ${mm(p.bbox.min[1])}`).join('; ') : `lowest point ${mm(b.min[1])}`,
          parts: below.map((p) => p.name),
        });
        break;
      }
      case 'range': {
        let v: number;
        try { v = evalExpr(rule.expr, measures); } catch (e: any) {
          out.push({ id: `range-${i}`, label: rule.label ?? rule.expr, pass: false, detail: e.message });
          break;
        }
        const pass = v >= rule.min - 1e-9 && v <= rule.max + 1e-9;
        out.push({
          id: `range-${i}`, label: rule.label ?? `${rule.expr} in ${rule.min}–${rule.max}`, pass,
          detail: `${rule.expr} = ${+v.toFixed(4)} (allowed ${rule.min}–${rule.max})`,
        });
        break;
      }
    }
  }
  return out;
}
