// Branching change log (Decision 2): every tool call = one commit with before/after changes.
// Proposals are branches off main; review keeps/undoes individual steps (Decision 9).
import { emptyDoc, type SceneDoc } from './types.ts';

export interface Change { path: string[]; before: unknown; after: unknown }

export interface Commit {
  id: string;
  parent: string | null;
  branch: string;      // "main" or a proposal id
  author: string;      // "claude", "human", "script"
  tool: string;
  summary: string;
  changes: Change[];
  time: string;
  args?: unknown;
}

export interface Proposal {
  id: string;          // "p1"
  title: string;
  base: string | null; // main commit it branched from
  head: string | null; // last commit on the proposal
  status: 'open' | 'committed' | 'discarded';
  author: string;
  undone: string[];    // commit ids the reviewer undid
  created: string;
  resolved?: string;
  note?: string;
}

export interface RepoData {
  commits: Record<string, Commit>;
  mainHead: string | null;
  proposals: Record<string, Proposal>;
  active: string;      // "main" | proposal id
  seq: { commit: number; proposal: number };
}

export function emptyRepo(): RepoData {
  return { commits: {}, mainHead: null, proposals: {}, active: 'main', seq: { commit: 0, proposal: 0 } };
}

const clone = <T>(x: T): T => (x === undefined ? x : structuredClone(x));

export function getAt(root: any, path: string[]): unknown {
  let cur = root;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setAt(root: any, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  } else cur[last] = clone(value);
}

export function applyChanges(doc: SceneDoc, changes: Change[], dir: 'forward' | 'back' = 'forward'): void {
  const list = dir === 'forward' ? changes : [...changes].reverse();
  for (const c of list) setAt(doc, c.path, dir === 'forward' ? c.after : c.before);
}

export class History {
  data: RepoData;
  private docCache = new Map<string, SceneDoc>();

  constructor(data?: RepoData) { this.data = data ?? emptyRepo(); }

  commit(id: string): Commit {
    const c = this.data.commits[id];
    if (!c) throw new Error(`no commit "${id}"`);
    return c;
  }

  /** Document as of a commit on its own chain (ignores proposal undo marks). */
  docAt(id: string | null): SceneDoc {
    if (id === null) return emptyDoc();
    const hit = this.docCache.get(id);
    if (hit) return clone(hit);
    const c = this.commit(id);
    const d = this.docAt(c.parent);
    applyChanges(d, c.changes);
    this.docCache.set(id, clone(d));
    return d;
  }

  mainDoc(): SceneDoc { return this.docAt(this.data.mainHead); }

  /** Commits on a branch, oldest first. */
  chain(head: string | null, stopAt: string | null = null): Commit[] {
    const out: Commit[] = [];
    let cur = head;
    while (cur && cur !== stopAt) {
      const c = this.commit(cur);
      out.push(c);
      cur = c.parent;
    }
    return out.reverse();
  }

  proposal(id?: string): Proposal {
    const pid = id ?? (this.data.active !== 'main' ? this.data.active : undefined);
    if (!pid) throw new Error('no proposal given and the active branch is main');
    const p = this.data.proposals[pid];
    if (!p) throw new Error(`no proposal "${pid}"`);
    return p;
  }

  steps(p: Proposal): Commit[] { return this.chain(p.head, p.base); }

  /**
   * Steps that depend on `step`, transitively: they edit something `step` created, or they
   * reference (as an input/target) an op that `step` created.
   */
  dependents(p: Proposal, stepId: string): string[] {
    const steps = this.steps(p);
    const out: string[] = [];
    const queue = [stepId];
    while (queue.length) {
      const id = queue.shift()!;
      const idx = steps.findIndex((s) => s.id === id);
      const createdChanges = steps[idx].changes.filter((c) => c.before === undefined);
      const created = createdChanges.map((c) => c.path.join('/'));
      const createdOps = createdChanges.filter((c) => c.path[2] === 'ops' && c.path.length === 4).map((c) => c.path[3]);
      if (!created.length) continue;
      for (const s of steps.slice(idx + 1)) {
        if (out.includes(s.id) || s.id === stepId) continue;
        const touches = s.changes.some((c) => created.some((pre) => c.path.join('/') === pre || c.path.join('/').startsWith(pre + '/')));
        const refs = createdOps.length > 0 && s.changes.some((c) => {
          const after = JSON.stringify(c.after ?? null);
          return createdOps.some((op) => after.includes(`"${op}"`)) && !(c.path[2] === 'opOrder');
        });
        if (touches || refs) { out.push(s.id); queue.push(s.id); }
      }
    }
    return out;
  }

  /** Base doc + kept steps (what a proposal looks like after review edits). */
  proposalDoc(p: Proposal): SceneDoc {
    const d = this.docAt(p.base);
    for (const s of this.steps(p)) if (!p.undone.includes(s.id)) applyChanges(d, s.changes);
    return d;
  }

  activeDoc(): SceneDoc {
    return this.data.active === 'main' ? this.mainDoc() : this.proposalDoc(this.proposal(this.data.active));
  }

  /** Record a commit on the active branch. `changes` must be relative to activeDoc(). */
  record(author: string, tool: string, summary: string, changes: Change[], args?: unknown): Commit {
    const branch = this.data.active;
    let parent: string | null;
    let p: Proposal | null = null;
    if (branch === 'main') parent = this.data.mainHead;
    else {
      p = this.proposal(branch);
      if (p.status !== 'open') throw new Error(`proposal ${p.id} is ${p.status}`);
      // Changes hold absolute after-values, so a new step applies cleanly on top of the
      // reviewed preview even when earlier steps are marked undone.
      parent = p.head ?? p.base;
    }
    const id = `c${++this.data.seq.commit}`;
    const c: Commit = { id, parent, branch, author, tool, summary, changes, time: new Date().toISOString(), args };
    this.data.commits[id] = c;
    if (p) p.head = id;
    else this.data.mainHead = id;
    return c;
  }

  createProposal(title: string, author: string): Proposal {
    const id = `p${++this.data.seq.proposal}`;
    const p: Proposal = { id, title, base: this.data.mainHead, head: null, status: 'open', author, undone: [], created: new Date().toISOString() };
    this.data.proposals[id] = p;
    this.data.active = id;
    return p;
  }

  /** Merge kept steps onto main, one main commit per kept step. */
  commitProposal(p: Proposal): { merged: Commit[]; skipped: string[]; mainMoved: boolean } {
    if (p.status !== 'open') throw new Error(`proposal ${p.id} is already ${p.status}`);
    const mainMoved = this.data.mainHead !== p.base;
    const saveActive = this.data.active;
    this.data.active = 'main';
    const merged: Commit[] = [];
    const skipped: string[] = [];
    try {
      for (const s of this.steps(p)) {
        if (p.undone.includes(s.id)) { skipped.push(s.id); continue; }
        const cur = this.mainDoc();
        const changes = s.changes.map((c) => ({ path: c.path, before: clone(getAt(cur, c.path)), after: clone(c.after) }));
        merged.push(this.record(s.author, 'merge', `${p.id}: ${s.summary}`, changes, { from: s.id }));
      }
    } catch (e) {
      this.data.active = saveActive;
      throw e;
    }
    p.status = 'committed';
    p.resolved = new Date().toISOString();
    return { merged, skipped, mainMoved };
  }

  discardProposal(p: Proposal): void {
    if (p.status !== 'open') throw new Error(`proposal ${p.id} is already ${p.status}`);
    p.status = 'discarded';
    p.resolved = new Date().toISOString();
    if (this.data.active === p.id) this.data.active = 'main';
  }
}

/** Minimal structural diff between two docs (object-level granularity below objects/<id>/<field>). */
export function diffDocs(a: SceneDoc, b: SceneDoc): Change[] {
  const out: Change[] = [];
  const walk = (x: any, y: any, path: string[], depth: number) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (depth >= 4 || x === undefined || y === undefined || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) || Array.isArray(y)) {
      out.push({ path, before: clone(x), after: clone(y) });
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], [...path, k], depth + 1);
  };
  walk(a, b, [], 0);
  return out;
}
