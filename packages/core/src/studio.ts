// Studio: the headless engine facade. One instance per project. DOM-free.
import { History, getAt, setAt, type Change, type Commit, type RepoData } from './history.ts';
import { evaluateObject, overlapVolume, setMeshLoader, supportOf, type EvalResult } from './kernel.ts';
import { runChecks, type CheckResult } from './checks.ts';
import { profileChecks } from './profiles.ts';
import { MemoryAssets, type AssetStore } from './assets.ts';
import { parseMesh, type MeshFormat, type RawMesh } from './importers.ts';
import { fillInstances, solvePlacements, describePlacement } from './scene.ts';
import { materialForPart, resolveMaterial } from './materials.ts';
import { codeView } from './codeview.ts';
import { referencedParams } from './expr.ts';
import { toolByName, type ToolCtx } from './tools.ts';
import type { SceneDoc, SceneObject } from './types.ts';
import { poseChecks, weightReport, mouthCheck, type PoseCheck } from './rig.ts';
import { compilePerformance, performanceReport } from './performance.ts';
import { apronReport, bakeMotion, motionReport, checkFrames } from './motion.ts';
import { fingerPenetration } from './grip.ts';
import { lineChecks } from './lipsync.ts';

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

/** Tools that change an object's geometry/params/materials — not allowed on a linked copy. */
const SOURCE_ONLY = new Set(['set-param', 'set-params', 'add-op', 'set-op', 'remove-op', 'set-output', 'add-rule', 'set-material', 'set-profile']);

export class Studio {
  history: History;
  activity: Activity[] = [];
  assets: AssetStore;
  private evalCache = new Map<string, EvalResult>();
  private overlapCache = new Map<string, number>();
  private meshCache = new Map<string, RawMesh>();
  private resolveErrors = new WeakMap<SceneDoc, Record<string, string>>();
  private listeners = new Set<() => void>();
  onPersist?: (data: RepoData) => void;

  constructor(data?: RepoData, opts: { assets?: AssetStore } = {}) {
    this.history = new History(data);
    this.assets = opts.assets ?? new MemoryAssets();
    setMeshLoader((a) => {
      const key = JSON.stringify(a);
      let m = this.meshCache.get(key);
      if (!m) {
        const asset = String(a.asset);
        m = parseMesh(this.assets.get(asset), (a.format as MeshFormat) ?? (asset.split('.').pop() as MeshFormat), { units: a.units as any, up: a.up as any, scale: a.scale as number | undefined, center: a.center as boolean | undefined });
        if (this.meshCache.size > 20) this.meshCache.delete(this.meshCache.keys().next().value!);
        this.meshCache.set(key, m);
      }
      return m;
    });
  }

  /** Fill linked copies and solve placement relations (positions of placed objects are derived). */
  resolve(doc: SceneDoc): SceneDoc {
    const errors: Record<string, string> = {};
    fillInstances(doc, errors);
    solvePlacements(doc, (o) => this.evaluate(o), errors);
    this.resolveErrors.set(doc, errors);
    return doc;
  }
  mainDoc(): SceneDoc { return this.resolve(this.history.mainDoc()); }
  proposalDoc(p: any): SceneDoc { return this.resolve(this.history.proposalDoc(p)); }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.onPersist?.(this.history.data); for (const fn of this.listeners) fn(); }

  doc(): SceneDoc { return this.resolve(this.history.activeDoc()); }

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
    const key = this.evalKey(obj);
    let r = this.evalCache.get(key);
    if (!r) {
      r = evaluateObject(obj);
      if (this.evalCache.size > 300) this.evalCache.delete(this.evalCache.keys().next().value!);
      this.evalCache.set(key, r);
    }
    return r;
  }

  /** Evaluate a side-product op (collision / lod) with the object's placement. */
  evaluateOp(obj: SceneObject, opId: string): EvalResult {
    const key = this.evalKey(obj) + '#' + opId;
    let r = this.evalCache.get(key);
    if (!r) {
      r = evaluateObject(obj, opId);
      if (this.evalCache.size > 300) this.evalCache.delete(this.evalCache.keys().next().value!);
      this.evalCache.set(key, r);
    }
    return r;
  }

  evalKey(obj: SceneObject): string {
    const c = obj.character;
    return JSON.stringify([obj.params, obj.ops, obj.opOrder, obj.output, obj.position, obj.rotation ?? 0, obj.orientation ?? null, c ? [c.pose, c.expression, c.hands] : null]);
  }

  checks(id: string, doc = this.doc()): CheckResult[] {
    const o = doc.objects[id];
    if (!o) throw new Error(`no object "${id}"`);
    const r = this.evaluate(o);
    if (o.role === 'reference') {
      return [{ id: 'reference', label: 'Reference (not exported)', pass: true, detail: o.reference?.kind === 'image' ? `${o.reference.plane} image, ${o.reference.width} m wide` : r.manifold === false ? 'mesh is not watertight: shown and measurable, not usable in booleans' : 'watertight mesh: usable in booleans via a mesh op' }];
    }
    const base = [...runChecks(o, r), ...this.sceneChecks(o, doc), ...this.characterChecks(o, doc)];
    if (!o.profile) return base;
    const midBuild = base.some((c) => c.pending);
    return [...base, ...profileChecks(o, r, { evaluateOp: (x, id) => this.evaluateOp(x, id), overlap: (a, b) => overlapVolume(a, b) }, midBuild)];
  }

  private poseCache = new Map<string, PoseCheck[]>();
  /** The canonical pose set for a character (cached per geometry: pose/expression changes don't rerun it). */
  poseChecks(o: SceneObject): PoseCheck[] {
    const key = JSON.stringify([o.params, o.ops, o.opOrder, o.output]);
    let v = this.poseCache.get(key);
    if (!v) {
      const r = this.evaluate(o);
      if (!r.rig) return [];
      v = poseChecks(r.rig.rig, r.rig.rest, r.indices, r.rig.vertPart);
      if (this.poseCache.size > 20) this.poseCache.delete(this.poseCache.keys().next().value!);
      this.poseCache.set(key, v);
    }
    return v;
  }

  /** Characters: skin weights, the canonical pose set, fingers clear of held props, spoken lines. */
  characterChecks(o: SceneObject, doc: SceneDoc): CheckResult[] {
    const r = this.evaluate(o);
    if (!r.ok || !r.rig) return [];
    const out: CheckResult[] = [];
    const w = weightReport(r.rig.rig);
    out.push({ id: 'skin-weights', label: 'Skin weights', pass: !w.unbound && !w.badSum && w.maxInfluences <= 4, detail: w.unbound || w.badSum ? `${w.unbound} unbound vertices, ${w.badSum} whose weights don't sum to 1` : `every vertex bound, ≤ ${w.maxInfluences} bones each, weights sum to 1` });
    const mouth = mouthCheck(r.rig.rig, r.rig.rest, r.rig.vertPart);
    out.push({ id: 'mouth-inside', label: 'Teeth and tongue stay behind the lips', pass: mouth.pass, detail: mouth.detail });
    const poses = this.poseChecks(o);
    const bad = poses.filter((p) => !p.pass);
    out.push({
      id: 'pose-checks', label: `Bends cleanly in ${poses.length} test poses`, pass: !bad.length,
      detail: bad.length ? bad.map((p) => `${p.pose}: ${p.detail}`).join('; ') + ' (studio pose-check for all)' : `worst: ${[...poses].sort((a, b) => a.volume - b.volume)[0]?.detail ?? ''}`,
    });
    for (const hand of ['left', 'right'] as const) {
      const pid = o.character?.holds?.[hand];
      const p = pid ? doc.objects[pid] : undefined;
      if (!pid) continue;
      if (!p) { out.push({ id: `hold-${hand}`, label: `Holds something in the ${hand} hand`, pass: false, detail: `holds "${pid}", which no longer exists — studio release --character ${o.id} --hand ${hand}` }); continue; }
      const pr = this.evaluate(p);
      const n = pr.ok ? fingerPenetration(r.rig, r.positions, hand, { P: pr.positions, I: pr.indices }) : 0;
      out.push({ id: `hold-${hand}`, label: `Fingers clear of ${p.name}`, pass: n === 0, detail: n ? `${n} finger points pass through ${p.name} — loosen the grip (set-hand --curl) or adjust its grip (set-grip)` : `${hand} hand wraps ${p.name} without passing through it` });
    }
    for (const [id, line] of Object.entries(o.character?.lines ?? {})) {
      out.push(...lineChecks(id, line));
      if (line.performance) out.push(...this.performanceChecks(o, id));
    }
    for (const id of Object.keys(o.character?.motions ?? {})) out.push(...this.motionChecks(o, id));
    return out;
  }

  private perfCache = new Map<string, CheckResult[]>();
  /** A performed line's checks (Decision 23): gestures on their words, no pops, ends on the idle, hands clear, the face shows the emotion. */
  performanceChecks(o: SceneObject, id: string): CheckResult[] {
    const line = o.character?.lines?.[id];
    if (!line?.performance) return [];
    const key = JSON.stringify([o.params, o.ops, o.opOrder, o.output, id, line.performance, line.duration, line.text, o.character?.hands, o.character?.holds, o.character?.motions?.idle]);
    const hit = this.perfCache.get(key);
    if (hit) return hit;
    const r = this.evaluate(o);
    if (!r.ok || !r.rig) return [];
    let out: CheckResult[];
    try {
      const clip = compilePerformance(r.rig.rig, o.character, line, line.performance);
      const rep = performanceReport(r.rig.rig, line, line.performance, clip, o.character);
      out = [{ id: `line-${id}-performance`, label: `Line "${id}": the performance`, pass: rep.pass, detail: rep.detail }];
    } catch (e: any) { out = [{ id: `line-${id}-performance`, label: `Line "${id}": the performance`, pass: false, detail: e.message }]; }
    if (this.perfCache.size > 60) this.perfCache.delete(this.perfCache.keys().next().value!);
    this.perfCache.set(key, out);
    return out;
  }

  private motionCache = new Map<string, CheckResult[]>();
  /** A motion's checks: feet planted, nothing below the floor, legs reach, loop closes, and the skin at its extremes. */
  motionChecks(o: SceneObject, id: string): CheckResult[] {
    const spec = o.character?.motions?.[id];
    if (!spec) return [];
    const key = JSON.stringify([o.params, o.ops, o.opOrder, o.output, id, spec, o.character?.hands, o.character?.holds, spec.kind === 'start' || spec.kind === 'stop' ? o.character?.motions?.[spec.from ?? 'walk'] : null]);
    const hit = this.motionCache.get(key);
    if (hit) return hit;
    const r = this.evaluate(o);
    if (!r.ok || !r.rig) return [];
    const label = spec.kind === 'action' ? `${id} (${spec.action})` : id;
    let out: CheckResult[];
    try {
      const clip = bakeMotion(id, spec, r.rig.rig, o.character);
      const rep = motionReport(r.rig.rig, clip);
      const frames = checkFrames(clip);
      const skin = poseChecks(r.rig.rig, r.rig.rest, r.indices, r.rig.vertPart, Object.fromEntries(frames.map((f) => [`frame ${f}`, clip.local[f]])));
      const bad = skin.filter((p) => !p.pass);
      out = [
        { id: `motion-${id}`, label: `Motion "${label}": feet planted${clip.loop ? ', loops' : ''}`, pass: rep.pass, detail: rep.detail },
        { id: `motion-${id}-skin`, label: `Motion "${label}": bends cleanly`, pass: !bad.length, detail: bad.length ? bad.map((p) => `${p.pose}: ${p.detail}`).join('; ') : `${skin.length} key frame(s): ${skin.map((p) => p.detail).sort()[0] ?? ''}` },
      ];
      const ap = apronReport(r.rig.rig, clip);
      if (ap) out.push({ id: `motion-${id}-apron`, label: `Motion "${label}": the apron follows the legs`, pass: ap.pass, detail: ap.detail });
    } catch (e: any) {
      out = [{ id: `motion-${id}`, label: `Motion "${label}"`, pass: false, detail: e.message }];
    }
    if (this.motionCache.size > 60) this.motionCache.delete(this.motionCache.keys().next().value!);
    this.motionCache.set(key, out);
    return out;
  }

  /** Checks that involve other objects: placement solved, resting on its support, no overlaps. */
  sceneChecks(o: SceneObject, doc: SceneDoc): CheckResult[] {
    const out: CheckResult[] = [];
    const errors = this.resolveErrors.get(doc) ?? {};
    const name = (id: string) => doc.objects[id]?.name ?? id;
    if (errors[o.id]) out.push({ id: 'placement', label: 'Placement', pass: false, detail: errors[o.id] });
    const r = this.evaluate(o);
    if (!r.ok) return out;
    if (o.place?.kind === 'on' && !errors[o.id] && doc.objects[o.place.target]) {
      const base = this.evaluate(doc.objects[o.place.target]);
      const s = supportOf(r, base);
      const pct = Math.round(s.fraction * 100);
      out.push({
        id: 'restsOn', label: `Rests on ${name(o.place.target)}`, pass: s.fraction >= 0.5,
        detail: s.fraction >= 0.5 ? `${pct}% of its base sits on ${name(o.place.target)}'s top surface`
          : s.samples === 0 ? 'no base found' : `only ${pct}% of its base is over ${name(o.place.target)}'s top surface — it would tip or float (the top may be dished or narrower than the base; adjust the offset)`,
      });
    }
    const hits: string[] = [];
    for (const id of doc.objectOrder) {
      const other = doc.objects[id];
      if (id === o.id || !other || other.role === 'reference') continue;
      // a prop in a hand touches the hand by design (the finger check covers it)
      if ((o.place?.kind === 'held' && o.place.target === id) || (other.place?.kind === 'held' && other.place.target === o.id)) continue;
      const v = this.overlap(o, other);
      if (v > 1e-7) hits.push(`${other.name} by ${(v * 1e6).toFixed(1)} cm³`);
    }
    if (doc.objectOrder.filter((id) => doc.objects[id]?.role !== 'reference').length > 1) {
      out.push({
        id: 'noOverlap', label: 'Clear of other objects', pass: hits.length === 0,
        detail: hits.length ? `overlaps ${hits.join(', ')} — move it (place-object / move-object) so they only touch` : 'touches but does not pass through any other object',
      });
    }
    return out;
  }

  private overlap(a: SceneObject, b: SceneObject): number {
    const ka = this.evalKey(a), kb = this.evalKey(b);
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    let v = this.overlapCache.get(key);
    if (v === undefined) {
      v = overlapVolume(this.evaluate(a), this.evaluate(b));
      if (this.overlapCache.size > 400) this.overlapCache.delete(this.overlapCache.keys().next().value!);
      this.overlapCache.set(key, v);
    }
    return v;
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
    if (SOURCE_ONLY.has(name)) {
      try {
        const o = this.findObject(draft, (args as any).object);
        if (o.instanceOf) {
          const error = `${o.name} is a linked copy of ${draft.objects[o.instanceOf]?.name ?? o.instanceOf}: edit "${o.instanceOf}" (every copy follows), or run "studio unlink --object ${o.id}" first`;
          this.addActivity({ author, tool: name, args: argStr, ok: false, error });
          return { ok: false, tool: name, branch, error };
        }
      } catch { /* the tool reports a missing object itself */ }
    }
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
      // objects placed on / linked to a touched object move with it: report their checks too
      let grew = true;
      while (grew) {
        grew = false;
        for (const id of doc.objectOrder) {
          const o = doc.objects[id];
          if (touched.has(id) || !o) continue;
          if ((o.place && touched.has(o.place.target)) || (o.instanceOf && touched.has(o.instanceOf))) { touched.add(id); grew = true; }
        }
      }
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
        const cs = this.checks(id, doc);
        return {
          id, name: o.name, type: o.semanticType, ops: o.opOrder.length,
          ...(o.role === 'reference' ? { role: 'reference' } : {}),
          ...(o.instanceOf ? { linkedCopyOf: o.instanceOf } : {}),
          position: o.position.map((v) => +v.toFixed(4)), ...(o.rotation ? { rotation: +o.rotation.toFixed(2) } : {}),
          ...(o.place ? { placement: describePlacement(o.place, (t) => doc.objects[t]?.name ?? t) } : {}),
          material: o.material.name,
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
      id, name: o.name, type: o.semanticType, description: o.description,
      material: resolveMaterial(o.material), partMaterials: o.partMaterials, profile: o.profile ?? null,
      position: o.position, rotation: o.rotation ?? 0,
      placement: o.place ? { ...o.place, description: describePlacement(o.place, (t) => doc.objects[t]?.name ?? t) } : null,
      linkedCopyOf: o.instanceOf, role: o.role ?? 'model', reference: o.reference,
      params: o.params, output: o.output, code: codeView(o),
      parts: r.parts.map((p) => ({ name: p.name, min: r4(p.bbox.min), max: r4(p.bbox.max), ops: p.ops })),
      bbox: r.bbox ? { min: r4(r.bbox.min), max: r4(r.bbox.max) } : null,
      stats: { triangles: r.triangles, components: r.components, volume_m3: +r.volume.toFixed(6), genus: r.genus },
      checks: this.checks(id, doc),
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
      } else if (!field || ['material', 'partMaterials', 'position', 'rotation', 'place', 'output', 'opOrder', 'instanceOf'].includes(field)) {
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
      const preview = this.proposalDoc(p);
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

  /** One document's objects, packed for the view (meshes base64-encoded). */
  pack(doc: SceneDoc) {
    const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    return doc.objectOrder.map((id) => {
      const o = doc.objects[id];
      const r = this.evaluate(o);
      return {
        id, name: o.name, type: o.semanticType, material: resolveMaterial(o.material),
        params: o.params, code: codeView(o), ok: r.ok, error: r.error,
        positions: b64(r.positions), indices: b64(r.indices),
        parts: r.parts.map((p) => ({ name: p.name, ranges: p.ranges, bbox: p.bbox, ops: p.ops, material: materialForPart(o, p.name), drag: o.instanceOf ? 'object' : this.partDragTarget(o, p.name).kind })),
        bbox: r.bbox, checks: this.checks(id, doc),
        position: o.position, rotation: o.rotation ?? 0,
        placement: o.place ? describePlacement(o.place, (t) => doc.objects[t]?.name ?? t) : null,
        linkedCopyOf: o.instanceOf ?? null, role: o.role ?? 'model', reference: o.reference ?? null,
      };
    });
  }

  /**
   * What dragging a part in the view should edit: the `at` of the op that made it (when nothing
   * after it rotates, scales or copies it), otherwise the whole object.
   */
  partDragTarget(o: SceneObject, part: string): { kind: 'op'; op: string } | { kind: 'object'; reason: string } {
    if (/#/.test(part)) return { kind: 'object', reason: `${part} is one of several copies made by one op` };
    const r = this.evaluate(o);
    const p = r.parts.find((x) => x.name === part);
    if (!p) return { kind: 'object', reason: `no part "${part}"` };
    if (r.parts.filter((x) => !x.name.startsWith('~')).length === 1) return { kind: 'object', reason: `${part} is the whole object` };
    const creators = p.ops.filter((id) => o.ops[id] && !o.ops[id].inputs?.length);
    if (creators.length !== 1) return { kind: 'object', reason: `${part} is built from several ops` };
    const MOVES = new Set(['rotate', 'scale', 'mirror', 'placeAt', 'array', 'hull']);
    if (p.ops.some((id) => o.ops[id] && MOVES.has(o.ops[id].op))) return { kind: 'object', reason: `${part} is rotated, scaled or copied after it is made` };
    if (o.ops[creators[0]].op === 'mesh') return { kind: 'object', reason: 'imported mesh' };
    return { kind: 'op', op: creators[0] };
  }

  /** Everything the browser view needs (meshes base64-encoded). */
  snapshot() {
    const h = this.history;
    const main = this.mainDoc();
    const open = Object.values(h.data.proposals).filter((p) => p.status === 'open');
    return {
      active: h.data.active,
      mainHead: h.data.mainHead,
      commitCount: Object.keys(h.data.commits).length,
      main: this.pack(main),
      proposals: this.proposalsInfo(false).map((info) => ({
        ...info,
        objects: this.pack(this.proposalDoc(open.find((p) => p.id === info.id)!)),
      })),
      history: this.log('main', 12),
      activity: this.activity.slice(-40),
    };
  }
}
