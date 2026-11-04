// Tiny, safe arithmetic evaluator for parametric op arguments.
// Supports: numbers, $param / param names, + - * / ^, parentheses, unary minus,
// and functions sin cos tan (degrees), sqrt, abs, min, max, rad, deg.
// No property access, no calls outside the whitelist, no strings.

export type Num = number | string;
export type ParamValues = Record<string, number>;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  rad: (d) => (d * Math.PI) / 180,
  deg: (r) => (r * 180) / Math.PI,
};

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '-' || src[j + 1] === '+')) j++;
        j++;
      }
      const v = Number(src.slice(i, j));
      if (Number.isNaN(v)) throw new Error(`bad number "${src.slice(i, j)}"`);
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (/[$A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j).replace(/^\$/, '') });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected character "${c}" in expression "${src}"`);
  }
  return out;
}

export function evalExpr(src: string, params: ParamValues): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (v?: string) => {
    const t = toks[p++];
    if (!t || (v !== undefined && !(t.t === 'op' && t.v === v))) throw new Error(`expected "${v}" in "${src}"`);
    return t;
  };
  const expr = (): number => {
    let v = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take().v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take().v;
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (peek()?.t === 'op' && peek().v === '^') { take(); return Math.pow(b, power()); }
    return b;
  };
  const unary = (): number => {
    if (peek()?.t === 'op' && peek().v === '-') { take(); return -unary(); }
    if (peek()?.t === 'op' && peek().v === '+') { take(); return unary(); }
    return atom();
  };
  const atom = (): number => {
    const t = take();
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = expr(); take(')'); return v; }
    if (t.t === 'id') {
      if (peek()?.t === 'op' && peek().v === '(') {
        const fn = FUNCS[t.v];
        if (!fn) throw new Error(`unknown function "${t.v}"`);
        take('(');
        const args: number[] = [expr()];
        while (peek()?.t === 'op' && peek().v === ',') { take(); args.push(expr()); }
        take(')');
        return fn(...args);
      }
      if (!(t.v in params)) throw new Error(`unknown parameter "$${t.v}"`);
      return params[t.v];
    }
    throw new Error(`unexpected token in "${src}"`);
  };
  const v = expr();
  if (p !== toks.length) throw new Error(`trailing input in "${src}"`);
  if (!Number.isFinite(v)) throw new Error(`"${src}" is not a finite number`);
  return v;
}

export function num(x: unknown, params: ParamValues, what = 'value'): number {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new Error(`${what} is not finite`);
    return x;
  }
  if (typeof x === 'string') return evalExpr(x, params);
  throw new Error(`${what} must be a number or expression, got ${JSON.stringify(x)}`);
}

export function vec3(x: unknown, params: ParamValues, what = 'vector'): [number, number, number] {
  if (!Array.isArray(x) || x.length !== 3) throw new Error(`${what} must be [x, y, z]`);
  return [num(x[0], params, what), num(x[1], params, what), num(x[2], params, what)];
}

/** Names of parameters referenced anywhere inside a JSON-ish value. */
export function referencedParams(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === 'string') {
    for (const m of x.matchAll(/\$?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!(m[1] in FUNCS)) out.add(m[1]);
    }
  } else if (Array.isArray(x)) x.forEach((v) => referencedParams(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => referencedParams(v, out));
  return out;
}
