// Working together (Phase 10, decisions 61–64): moment addresses, steps for any asset, the notes inbox
// and taste file, and the "your call" card. One Collab per Studio. Notes, taste and picks are personal:
// they live under <project>/.studio (gitignored) and ~/.studio, never in the repo unless you opt in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Studio } from '../studio.ts';
import type { Proposal } from '../history.ts';
import { describeAddress, formatAddress, parseAddress, type MomentAddress, type Timeline } from './address.ts';
import { addressFor, timelineFor, partWords } from './timelines.ts';
import { Notes, emptyNotes, type Note, type NotesData, type NoteStatus } from './notes.ts';
import { SEED_TASTE, addRule, formatTaste, parseTaste, rulesFromPicks, type Pick, type TasteRule } from './taste.ts';
import { answerAsk, makeCard, skipAsk, skipRate, type Ask, type AskInput, type Card } from './card.ts';
import { beforeAfter, renderKey, type BeforeAfter } from './steps.ts';

export * from './address.ts';
export * from './timelines.ts';
export * from './notes.ts';
export * from './taste.ts';
export * from './card.ts';
export * from './steps.ts';
export * from './three.ts';
export * from './movetimeline.ts';

// ── where it's kept ───────────────────────────────────────────────────────────────────────────────

export interface CollabIO {
  load(name: 'notes' | 'picks'): any | null;
  save(name: 'notes' | 'picks', data: unknown): void;
  readTaste(scope: 'studio' | 'project'): string | null;
  writeTaste(scope: 'studio' | 'project', md: string): void;
  where?(): Record<string, string>;
}

export class MemoryIO implements CollabIO {
  files: Record<string, string> = {};
  load(name: string) { return this.files[name] ? JSON.parse(this.files[name]) : null; }
  save(name: string, data: unknown) { this.files[name] = JSON.stringify(data); }
  readTaste(scope: string) { return this.files[`taste-${scope}`] ?? null; }
  writeTaste(scope: string, md: string) { this.files[`taste-${scope}`] = md; }
}

/** <project>/.studio/{notes.json,picks.json,taste.md} and <studio home>/taste.md (STUDIO_HOME, default ~/.studio). */
export class FsIO implements CollabIO {
  projectDir: string; home: string;
  constructor(projectDir: string, home = process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio')) { this.projectDir = projectDir; this.home = home; }
  private file(name: string) { return path.join(this.projectDir, '.studio', name); }
  private taste(scope: 'studio' | 'project') { return scope === 'studio' ? path.join(this.home, 'taste.md') : this.file('taste.md'); }
  load(name: string) { const f = this.file(`${name}.json`); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
  save(name: string, data: unknown) {
    const f = this.file(`${name}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 1));
    fs.renameSync(f + '.tmp', f);
  }
  readTaste(scope: 'studio' | 'project') { try { return fs.readFileSync(this.taste(scope), 'utf8'); } catch { return null; } }
  writeTaste(scope: 'studio' | 'project', md: string) { const f = this.taste(scope); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, md); }
  where() { return { notes: this.file('notes.json'), picks: this.file('picks.json'), projectTaste: this.taste('project'), studioTaste: this.taste('studio') }; }
}

/** A thing's name in words: objects by name, "town:Pocket Raleigh" → "Pocket Raleigh", "ui" → "UI kit", "look:dusk" → "look dusk". */
export function thingName(doc: any, id: string): string {
  if (doc.objects?.[id]) return doc.objects[id].name;
  if (id === 'ui') return 'UI kit';
  if (id.startsWith('town:')) return id.slice(5);
  if (id.startsWith('look:')) return `look ${id.slice(5)}`;
  return id;
}

// ── the facade ────────────────────────────────────────────────────────────────────────────────────

export class Collab {
  private notesBook: Notes | null = null;
  private studio: Studio; io: CollabIO;
  constructor(studio: Studio, io: CollabIO = new MemoryIO()) { this.studio = studio; this.io = io; }

  setIO(io: CollabIO) { this.io = io; this.notesBook = null; }

  // notes
  get notes(): Notes {
    if (!this.notesBook) this.notesBook = new Notes((this.io.load('notes') as NotesData) ?? emptyNotes());
    return this.notesBook;
  }
  saveNotes() { this.io.save('notes', this.notes.data); }

  timelineOf(a: MomentAddress, doc = this.studio.mainDoc()): Timeline | null {
    return timelineFor(doc, a.thing, a.clock, { studio: this.studio });
  }

  /** "selection" (what's selected in the view), an address string or object, or object/part/clock flags. */
  address(at: unknown, doc = this.studio.doc()): MomentAddress {
    if (at === 'selection' || at === undefined || at === null) {
      const s = this.studio.selection;
      if (!s) throw new Error('nothing is selected in the view: click a part, or give --at "<thing>[@clock] [time] [~moment]"');
      return addressFor(doc, s, { studio: this.studio });
    }
    if (typeof at === 'object' && !(at as any).thing && (at as any).object) return addressFor(doc, at as any, { studio: this.studio });
    return parseAddress(at as any);
  }

  describe(a: MomentAddress, doc = this.studio.doc()): string {
    const head = a.thing.split('/')[0], part = a.thing.slice(head.length + 1);
    const words = part && head.startsWith('town:') ? partWords.town?.(doc, head.slice(5), part) : null;
    return describeAddress(words ? { ...a, thing: `${head}/${words}` } : a, this.timelineOf(a, doc), (id) => thingName(doc, id));
  }

  addNote(text: string, at: unknown, opts: { author?: string; from?: Note['from']; proposal?: string; ask?: string; region?: Note['region'] } = {}): Note {
    const a = this.address(at);
    const n = this.notes.add(text, a, { ...opts, basis: a.clock === 'none' ? null : this.timelineOf(a, this.studio.doc()) });
    this.saveNotes();
    return n;
  }

  setNote(id: string, status: NoteStatus, why?: string): Note { const n = this.notes.set(id, status, why); this.saveNotes(); return n; }

  repin(id: string, at: unknown): Note {
    const a = this.address(at);
    const n = this.notes.repin(id, a, a.clock === 'none' ? null : this.timelineOf(a));
    this.saveNotes();
    return n;
  }

  /** Re-resolve notes against main as it is now (after every change on main). */
  refreshNotes(): { moved: string[]; stale: string[] } {
    if (!this.notes.data.notes.some((n) => n.status !== 'done' && n.status !== 'stale')) return { moved: [], stale: [] };
    const doc = this.studio.mainDoc();
    const r = this.notes.refresh((a) => this.timelineOf(a, doc));
    if (r.moved.length || r.stale.length) this.saveNotes();
    return r;
  }

  notesForView() {
    const doc = this.studio.doc();
    return this.notes.list({ status: 'all' }).slice(-60).map((n) => ({
      id: n.id, text: n.text, status: n.status, author: n.author, from: n.from, proposal: n.proposal,
      address: n.address, where: this.describe(n.address, doc), compact: formatAddress(n.address), ...(n.region ? { region: n.region } : {}),
      why: [...n.log].reverse().find((l) => l.why)?.why,
    }));
  }

  // taste
  /** Both taste files. A missing studio-wide file reads as the seeded verdicts; `seed` writes it out (the taste tool does). */
  tasteRules(opts: { seed?: boolean } = {}): TasteRule[] {
    let studioMd = this.io.readTaste('studio');
    if (studioMd === null) { studioMd = formatTaste(SEED_TASTE, 'studio'); if (opts.seed) this.io.writeTaste('studio', studioMd); }
    return [...parseTaste(studioMd, 'studio'), ...parseTaste(this.io.readTaste('project') ?? '', 'project')];
  }

  addTaste(rule: TasteRule): { rule: TasteRule; replaced?: TasteRule; warning?: string } {
    const all = this.tasteRules();
    const r = addRule(all.filter((x) => x.scope === rule.scope), rule);
    this.io.writeTaste(rule.scope, formatTaste(r.rules, rule.scope));
    return { rule, ...(r.replaced ? { replaced: r.replaced } : {}), ...(r.warning ? { warning: r.warning } : {}) };
  }

  // picks
  picks(): Pick[] { return (this.io.load('picks') as Pick[]) ?? []; }

  /** Log a pick; when a pattern now repeats 3+ times, it becomes a taste rule (and says so). */
  logPick(p: Pick): { learned: TasteRule[] } {
    const all = [...this.picks(), p];
    this.io.save('picks', all);
    const learned = rulesFromPicks(all, this.tasteRules());
    for (const r of learned) this.addTaste(r);
    return { learned };
  }

  // the card
  makeCard(p: Proposal, asks: AskInput[], opts: { unattended?: boolean; leans?: string[] } = {}): Card {
    const info = this.studio.proposalsInfo(true).find((x) => x.id === p.id)!;
    const rv = (this.studio.history.data.review ??= { kept: 0, keptUnopened: 0, played: [] });
    const { card, toInbox } = makeCard({ proposal: p.id, checks: info.checks, asks, rules: this.tasteRules(), unattended: opts.unattended, played: new Set(rv.played), leans: opts.leans });
    for (const a of card.asks) if (a.kind === 'play60' && a.playable && !rv.played.includes(a.playable)) rv.played.push(a.playable);
    for (const a of toInbox) a.note = this.askToInbox(p, a, a.status === 'guessed' ? `My guess, check it: ${a.question} → ${a.answer || '(no guess)'}` : `Your call (waiting): ${a.question}`, a.status === 'guessed' ? 'guess' : 'card').id;
    p.card = card;
    return card;
  }

  private askToInbox(p: Proposal, a: Ask, text: string, from: Note['from']): Note {
    const doc = this.studio.proposalDoc(p);
    const thing = a.thing ?? Object.keys(this.studio.partsAffectedBy(p)).at(0) ?? doc.objectOrder.at(-1) ?? 'scene';
    const n = this.notes.add(text, { thing, clock: 'none' }, { author: 'claude', from, proposal: p.id, ask: a.id });
    this.saveNotes();
    return n;
  }

  answer(p: Proposal, askId: string, answer: string, opts: { remember?: boolean } = {}) {
    if (!p.card) throw new Error(`${p.id} has no card yet (studio card --proposal ${p.id} --asks '[…]')`);
    const a = answerAsk(p.card, askId, answer);
    const out: { ask: Ask; learned: TasteRule[]; rule?: TasteRule } = { ask: a, learned: [] };
    if (a.note) { try { this.setNote(a.note, 'done', `answered: ${a.answer}`); } catch { /* already moved on */ } }
    if (a.kind === 'pick' && a.topic) {
      const chosen = a.options!.find((o) => o.label === a.answer)!;
      out.learned = this.logPick({ time: new Date().toISOString(), topic: a.topic, chosen: { label: chosen.label, traits: chosen.traits ?? [chosen.label] }, rejected: a.options!.filter((o) => o !== chosen).map((o) => ({ label: o.label, traits: o.traits ?? [o.label] })), from: 'card' }).learned;
    }
    if (opts.remember) {
      if (!a.topic) throw new Error('only an ask with a topic can become a taste rule');
      out.rule = this.addTaste({ text: `${a.question.replace(/\?$/, '')}: ${a.answer}.`, source: { kind: 'said', date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }, topics: [`${a.topic}=${a.answer!.replace(/\s+/g, '-')}`], scope: 'project' }).rule;
    }
    return out;
  }

  skip(p: Proposal, askId: string): { ask: Ask; note: Note } {
    if (!p.card) throw new Error(`${p.id} has no card`);
    const a = skipAsk(p.card, askId);
    const n = this.askToInbox(p, a, `Your call (skipped): ${a.question}${a.options ? ` — ${a.options.map((o) => o.label).join(' / ')}` : ''}`, 'card');
    a.note = n.id;
    return { ask: a, note: n };
  }

  // steps
  openStep(p: Proposal, stepRef: string | number): BeforeAfter & { reviewed: true; renderKeys: { before: string; after: string } } {
    const h = this.studio.history;
    const steps = h.steps(p);
    const s = typeof stepRef === 'number' || /^\d+$/.test(String(stepRef)) ? steps[Number(stepRef) - 1] : steps.find((x) => x.id === stepRef);
    if (!s) throw new Error(`no step ${stepRef} in ${p.id} (has ${steps.length})`);
    p.seen = [...new Set([...(p.seen ?? []), s.id])];
    const ba = beforeAfter(s, h.docAt(s.parent), h.docAt(s.id));
    return { ...ba, reviewed: true, renderKeys: { before: renderKey(ba.before), after: renderKey(ba.after) } };
  }

  /** Tripwires for decisions 61–64 in one place. */
  stats() {
    const rv = this.studio.history.data.review ?? { kept: 0, keptUnopened: 0, played: [] };
    const cards = Object.values(this.studio.history.data.proposals).map((p) => p.card).filter(Boolean) as Card[];
    const stale = this.notes.staleRate();
    const rules = this.tasteRules();
    const skip = skipRate(cards);
    const unopened = rv.kept ? rv.keptUnopened / rv.kept : 0;
    return {
      steps: { kept: rv.kept, keptWithoutOpening: rv.keptUnopened, share: +unopened.toFixed(2), tripwire: rv.kept >= 10 && unopened > 0.9 ? 'more than 9 in 10 steps kept without opening: group them into bigger steps (D62)' : null },
      notes: { ...stale, rate: +stale.rate.toFixed(2), tripwire: stale.total >= 10 && stale.rate > 0.1 ? 'more than 1 in 10 notes went stale: anchor to named moments more often (D61)' : null },
      taste: { rules: rules.length, studio: rules.filter((r) => r.scope === 'studio').length, project: rules.filter((r) => r.scope === 'project').length, tripwire: rules.length > 30 ? 'over about 30 rules: prune or merge (D63)' : null },
      asks: { ...skip, rate: +skip.rate.toFixed(2), tripwire: skip.asked >= 10 && skip.rate > 0.5 ? 'more than half the asks skipped: switch to milestone review sessions (D64)' : null },
      ...(this.io.where ? { files: this.io.where() } : {}),
    };
  }
}
