// Studio: the headless engine facade. One instance per project. DOM-free.
import { History, getAt, setAt, type Change, type Commit, type RepoData } from './history.ts';
import { evaluateObject, type EvalResult } from './kernel.ts';
import { runChecks, type CheckResult } from './checks.ts';
import { codeView } from './codeview.ts';
import { referencedParams } from './expr.ts';
import { toolByName, type ToolCtx } from './tools.ts';
import type { SceneDoc, SceneObject } from './types.ts';

export interface CallResult {
  ok: boolean;
  tool: string;
  branch: string;
  commit?: string;
  summary?: string;
  result?: unknown;
  checks?: Record<string, { passed: number; failed: number; failures: CheckResult[]; pending?: string[] }>;
  error?: string;
  hint?: string;
}

export interface Activity { time: string; author: string; tool: string; args: string; ok: boolean; summary?: string; error?: string }

const clone = <T>(x: T): T => structuredClone(x);

export class Studio {
  history: History;
  activity: Activity[] = [];
  private evalCache = new Map<string, EvalResult>();
  private listeners = new Set<() => void>();
  onPersist?: (data: RepoData) => void;

  constructor(data?: RepoData) { this.history = new History(data); }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.onPersist?.(this.history.data); for (const fn of this.listeners) fn(); }

  doc(): SceneDoc { return this.history.activeDoc(); }

  findObject(doc: SceneDoc, ref?: string): SceneObject {
    if (!ref) {
      const last = doc.objectOrder[doc.objectOrder.length - 1];
      if (!last) throw new Error('no objects yet — start with `studio new-object`');
      return doc.objects[last];
    }
    if (doc.objects[ref]) return doc.objects[ref];
    const byName = Object.values(doc.objects).find((o) => o.name.toLowerCase() === ref.toLowerCase());
    if (!byName) throw new Error(`no object "${ref}" (have: ${doc.objectOrder.join(', ') || 'none'})`);
    return byName;
  }

  evaluate(obj: SceneObject): EvalResult {
    const key = JSON.stringify([obj.params, obj.ops, obj.opOrder, obj.output, obj.position]);
    let r = this.evalCache.get(key);
    if (!r) {
      r = evaluateObject(obj);
      if (this.evalCache.size > 300) this.evalCache.delete(this.evalCache.keys().next().value!);
      this.evalCache.set(key, r);
    }
    return r;
  }

  checks(id: string, doc = this.doc()): CheckResult[] {
    const o = doc.objects[id];
    if (!o) throw new Error(`no object "${id}"`);
    return runChecks(o, this.evaluate(o));
  }

  call(name: string, rawArgs: unknown = {}, author = 'claude'): CallResult {
    const tool = toolByName(name);
    const branch = this.history.data.active;
    if (!tool) return { ok: false, tool: name, branch, error: `unknown tool "${name}"`, hint: 'run `studio help` for the list' };
    const parsed = tool.input.safeParse(rawArgs ?? {});
    const argStr = JSON.stringify(rawArgs ?? {});
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      this.addActivity({ author, tool: name, args: argStr, ok: false, error });
      return { ok: false, tool: name, branch, error, hint: tool.example ? `example: ${tool.example}` : undefined };
    }
    const args = parsed.data;
    const draft = this.doc();
    const changes: Change[] = [];
    let summary = '';
    const ctx: ToolCtx = {
      doc: draft, author, studio: this,
      set: (path, value) => {
        changes.push({ path, before: clone(getAt(draft, path)), after: clone(value) });
        setAt(draft, path, value);
      },
      obj: (ref) => this.findObject(draft, ref),
      summary: (s) => { summary = s; },
    };
    try {
      const result = tool.run(ctx, args);
      if (!tool.mutates) {
        this.addActivity({ author, tool: name, args: argStr, ok: true, summary: summary || undefined });
        if (tool.mode === 'propose' || tool.mode === 'review') this.emit();
        return { ok: true, tool: name, branch: this.history.data.active, result, ...(summary ? { summary } : {}) };
      }
      if (!changes.length) {
        this.addActivity({ author, tool: name, args: argStr, ok: true, summary: 'no change' });
        return { ok: true, tool: name, branch, result, summary: 'no change' };
      }
      const c = this.history.record(author, name, summary || name, changes, args);
      const touched = new Set(changes.filter((x) => x.path[0] === 'objects' && x.path[1]).map((x) => x.path[1]));
      const doc = this.doc();
      const checks: CallResult['checks'] = {};
      for (const id of touched) {
        if (!doc.objects[id]) continue;
        const cs = this.checks(id, doc);
        const fails = cs.filter((x) => !x.pass && !x.pending), pend = cs.filter((x) => !x.pass && x.pending);
        checks[id] = { passed: cs.filter((x) => x.pass).length, failed: fails.length, failures: fails };
        if (pend.length) checks[id].pending = pend.map((x) => x.detail);
      }
      this.addActivity({ author, tool: name, args: argStr, ok: true, summary: c.summary });
      this.emit();
      return { ok: true, tool: name, branch, commit: c.id, summary: c.summary, result, checks };
    } catch (e: any) {
      this.addActivity({ author, tool: name, args: argStr, ok: false, error: e.message });
      return { ok: false, tool: name, branch, error: e.message, hint: tool.example ? `example: ${tool.example}` : undefined };
    }
  }

  onActivity?: (a: Activity) => void;

  private addActivity(a: Omit<Activity, 'time'>) {
    const entry = { time: new Date().toISOString(), ...a };
    this.activity.push(entry);
    this.onActivity?.(entry);
    if (this.activity.length > 200) this.activity.shift();
  }

  // ── read models ─────────────────────────────────────────────────────
  sceneSummary() {
    const doc = this.doc();
    return {
      branch: this.history.data.active,
      objects: doc.objectOrder.map((id) => {
        const o = doc.objects[id];
        const r = this.evaluate(o);
        const cs = runChecks(o, r);
        return {
          id, name: o.name, type: o.semanticType, ops: o.opOrder.length,
          params: Object.fromEntries(Object.entries(o.params).map(([k, p]) => [k, p.value])),
          size: r.bbox ? r.bbox.max.map((v, i) => +(v - r.bbox!.min[i]).toFixed(4)) : null,
          checks: `${cs.filter((c) => c.pass).length}/${cs.length} pass`,
          failing: cs.filter((c) => !c.pass).map((c) => `${c.label}: ${c.detail}`),
        };
      }),
    };
  }

  inspect(id: string) {
    const doc = this.doc();
    const o = doc.objects[id];
    const r = this.evaluate(o);
    const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));
    return {
      id, name: o.name, type: o.semanticType, description: o.description, material: o.material, position: o.position,
      params: o.params, output: o.output, code: codeView(o),
      parts: r.parts.map((p) => ({ name: p.name, min: r4(p.bbox.min), max: r4(p.bbox.max), ops: p.ops })),
      bbox: r.bbox ? { min: r4(r.bbox.min), max: r4(r.bbox.max) } : null,
      stats: { triangles: r.triangles, components: r.components, volume_m3: +r.volume.toFixed(6), genus: r.genus },
      checks: runChecks(o, r),
      error: r.error,
    };
  }

  log_(c: Commit) { return { id: c.id, author: c.author, tool: c.tool, summary: c.summary, time: c.time }; }

  log(branch?: string, limit = 20) {
    const h = this.history;
    if (branch && branch !== 'main') {
      const p = h.proposal(branch);
      return h.steps(p).map((c, i) => ({ step: i + 1, ...this.log_(c), undone: p.undone.includes(c.id) }));
    }
    return h.chain(h.data.mainHead).slice(-limit).reverse().map((c) => this.log_(c));
  }

  /** Which parts (by name) a step affects — for viewport highlighting during review. */
  partsAffected(c: Commit, doc: SceneDoc): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const ch of c.changes) {
      const [root, oid, field, key] = ch.path;
      if (root !== 'objects' || !oid || !doc.objects[oid]) continue;
      const o = doc.objects[oid];
      const ops = new Set<string>();
      if (field === 'ops' && key) ops.add(key);
      else if (field === 'params' && key) {
        for (const id of o.opOrder) if (referencedParams(o.ops[id]?.args).has(key)) ops.add(id);
      } else if (!field || field === 'material' || field === 'position' || field === 'output' || field === 'opOrder') {
        out[oid] = ['*'];
        continue;
      }
      const r = this.evaluate(o);
      const names = r.parts.filter((p) => p.ops.some((x) => ops.has(x))).map((p) => p.name);
      out[oid] = [...new Set([...(out[oid] ?? []), ...names])];
    }
    return out;
  }

  proposalsInfo(all = false) {
    const h = this.history;
    return Object.values(h.data.proposals).filter((p) => all || p.status === 'open').map((p) => {
      const preview = h.proposalDoc(p);
      const steps = h.steps(p);
      const checks: Record<string, CheckResult[]> = {};
      for (const id of preview.objectOrder) checks[id] = this.checks(id, preview);
      return {
        id: p.id, title: p.title, status: p.status, author: p.author, base: p.base,
        active: h.data.active === p.id,
        steps: steps.map((c, i) => ({
          n: i + 1, id: c.id, summary: c.summary, author: c.author, tool: c.tool,
          undone: p.undone.includes(c.id),
          dependsOnUndone: p.undone.includes(c.id) ? [] : [],
          affects: this.partsAffected(c, preview),
        })),
        checks,
        allPass: Object.values(checks).every((cs) => cs.every((c) => c.pass)),
      };
    });
  }

  /** Everything the browser view needs (meshes base64-encoded). */
  snapshot() {
    const h = this.history;
    const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    const pack = (doc: SceneDoc) => doc.objectOrder.map((id) => {
      const o = doc.objects[id];
      const r = this.evaluate(o);
      return {
        id, name: o.name, type: o.semanticType, material: o.material,
        params: o.params, code: codeView(o), ok: r.ok, error: r.error,
        positions: b64(r.positions), indices: b64(r.indices),
        parts: r.parts.map((p) => ({ name: p.name, ranges: p.ranges, bbox: p.bbox, ops: p.ops })),
        bbox: r.bbox, checks: runChecks(o, r),
      };
    });
    const main = h.mainDoc();
    const open = Object.values(h.data.proposals).filter((p) => p.status === 'open');
    return {
      active: h.data.active,
      mainHead: h.data.mainHead,
      commitCount: Object.keys(h.data.commits).length,
      main: pack(main),
      proposals: this.proposalsInfo(false).map((info) => ({
        ...info,
        objects: pack(h.proposalDoc(open.find((p) => p.id === info.id)!)),
      })),
      history: this.log('main', 12),
      activity: this.activity.slice(-40),
    };
  }
}
