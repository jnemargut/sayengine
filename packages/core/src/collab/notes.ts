// The notes inbox (Decision 63): one per project (notes.json). Each note points at something with a
// moment address and moves open → on it → done; a note whose moment is gone becomes stale, shown to
// you, never silently moved. Skipped "your call" asks wait here too.
import { resolveAddress, type MomentAddress, type Timeline } from './address.ts';

export type NoteStatus = 'open' | 'on-it' | 'done' | 'stale';
/** Where on the picture a note points ("too dark here"): the look it was seen under, the 3D point under
 *  the pointer and its spot on screen (0..1), so the view can pin it there again. The address still
 *  names the thing under it. */
export interface NoteRegion { look?: string; point?: [number, number, number]; screen?: [number, number]; radius?: number }
export interface Note {
  id: string;
  text: string;
  address: MomentAddress;
  status: NoteStatus;
  author: string;                 // "human" (you) or "claude"
  from?: 'view' | 'cli' | 'card' | 'guess';
  proposal?: string;              // the proposal it came from (card asks)
  ask?: string;                   // the card ask it came from
  region?: NoteRegion;            // a spot on the picture (looks: "too dark here")
  basis?: Pick<Timeline, 'length' | 'version' | 'markers'>;   // the clock as it was: re-timing keeps the offset from the named moment
  created: string;
  updated: string;
  log: Array<{ time: string; status: NoteStatus; why?: string }>;
}
export interface NotesData { notes: Note[]; seq: number }

export const emptyNotes = (): NotesData => ({ notes: [], seq: 0 });

/** Allowed moves. "stale" comes only from re-resolving (or by hand); re-pinning a stale note opens it again. */
const FLOW: Record<NoteStatus, NoteStatus[]> = {
  open: ['on-it', 'done', 'stale'],
  'on-it': ['done', 'open', 'stale'],
  done: ['open'],
  stale: ['open', 'done'],
};

export class Notes {
  data: NotesData; private now: () => string;
  constructor(data: NotesData = emptyNotes(), now = () => new Date().toISOString()) { this.data = data; this.now = now; }

  list(filter: { status?: NoteStatus | 'all' | 'active'; thing?: string } = {}): Note[] {
    const st = filter.status ?? 'active';
    return this.data.notes.filter((n) => (st === 'all' ? true : st === 'active' ? n.status !== 'done' : n.status === st) && (!filter.thing || n.address.thing === filter.thing || n.address.thing.startsWith(filter.thing + '/')));
  }

  get(id: string): Note {
    const n = this.data.notes.find((x) => x.id === id);
    if (!n) throw new Error(`no note "${id}" (have: ${this.data.notes.map((x) => x.id).join(', ') || 'none'})`);
    return n;
  }

  add(text: string, address: MomentAddress, opts: { author?: string; from?: Note['from']; proposal?: string; ask?: string; basis?: Timeline | null; region?: NoteRegion } = {}): Note {
    if (!text.trim()) throw new Error('a note needs words');
    const t = this.now();
    const n: Note = {
      id: `n${++this.data.seq}`, text: text.trim(), address, status: 'open', author: opts.author ?? 'human',
      ...(opts.from ? { from: opts.from } : {}), ...(opts.proposal ? { proposal: opts.proposal } : {}), ...(opts.ask ? { ask: opts.ask } : {}),
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.basis ? { basis: { length: opts.basis.length, version: opts.basis.version, markers: opts.basis.markers } } : {}),
      created: t, updated: t, log: [{ time: t, status: 'open' }],
    };
    this.data.notes.push(n);
    return n;
  }

  set(id: string, status: NoteStatus, why?: string): Note {
    const n = this.get(id);
    if (n.status === status) return n;
    if (!FLOW[n.status].includes(status)) throw new Error(`note ${id} is ${n.status}: it can go to ${FLOW[n.status].join(' or ')}, not ${status}`);
    n.status = status;
    n.updated = this.now();
    n.log.push({ time: n.updated, status, ...(why ? { why } : {}) });
    return n;
  }

  /** Point a (stale) note somewhere new: it opens again, and the old address stays in its log. */
  repin(id: string, address: MomentAddress, basis?: Timeline | null): Note {
    const n = this.get(id);
    const was = n.address;
    n.address = address;
    if (basis) n.basis = { length: basis.length, version: basis.version, markers: basis.markers };
    n.updated = this.now();
    n.status = 'open';
    n.log.push({ time: n.updated, status: 'open', why: `re-pinned (was ${was.thing}${was.near ? ` "${was.near}"` : ''})` });
    return n;
  }

  /**
   * Re-resolve every live note against the clocks as they are now. Notes follow their named moment
   * (logged), or go stale (logged, with the reason). Done notes are left alone.
   */
  refresh(timelineOf: (a: MomentAddress) => Timeline | null): { moved: string[]; stale: string[] } {
    const moved: string[] = [], stale: string[] = [];
    for (const n of this.data.notes) {
      if (n.status === 'done' || n.status === 'stale') continue;
      const now = timelineOf(n.address);
      const before = n.basis ? ({ ...n.basis, clock: n.address.clock, thing: n.address.thing } as Timeline) : null;
      const r = resolveAddress(n.address, now, before);
      if (r.status === 'stale') { this.set(n.id, 'stale', r.reason); stale.push(n.id); continue; }
      if (r.status === 'moved') { n.log.push({ time: this.now(), status: n.status, why: r.reason }); moved.push(n.id); }
      n.address = r.address;
      if (now && now.exists !== false && n.address.clock !== 'none') n.basis = { length: now.length, version: now.version, markers: now.markers };
    }
    return { moved, stale };
  }

  /** The decision-61 tripwire: how many notes went stale (more than about 1 in 10 → anchor to named moments more). */
  staleRate(): { stale: number; total: number; rate: number } {
    const total = this.data.notes.length;
    const stale = this.data.notes.filter((n) => n.log.some((l) => l.status === 'stale')).length;
    return { stale, total, rate: total ? stale / total : 0 };
  }
}
