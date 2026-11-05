// The "your call" card (Decision 64): every proposal says what I checked (from the checks) and asks
// you only what checks can't judge: at most about 3 skippable asks. An ask is one of
//   pick   — pick one of N           yesno — yes / not yet
//   play60 — play it for 60 seconds  note  — a short typed note
// Asks the taste file already answers are skipped (and the proposal says it leaned on the rule).
// Skipped asks wait in the notes inbox. Answers can become taste rules. Unattended (overnight) work
// never waits: it proceeds on its best guess and marks the guess as a guess.
import type { CheckResult } from '../checks.ts';
import { ruleFor, sourceText, type TasteRule } from './taste.ts';

export const ASK_CAP = 3;

export type AskKind = 'pick' | 'yesno' | 'play60' | 'note';
export interface AskInput {
  kind: AskKind;
  question: string;
  topic?: string;                                       // what it decides ("stool-legs"): the taste file may answer it
  options?: Array<{ label: string; traits?: string[] }>; // pick: 2..5 options
  playable?: string;                                    // play60: the playable change's recipe stamp (asked once per change)
  guess?: string;                                       // the answer unattended work goes ahead with
  thing?: string;                                       // what it is about (for the inbox note's address)
}
export interface Ask extends AskInput {
  id: string;
  status: 'open' | 'answered' | 'skipped' | 'guessed';
  answer?: string;
  note?: string;                                        // the inbox note it went to (skipped / guessed)
  answeredAt?: string;
}
export interface Card {
  proposal: string;
  made: string;
  unattended: boolean;
  checked: { passed: number; failed: number; pending: number; lines: string[] };
  asks: Ask[];
  byTaste: Array<{ question: string; topic: string; rule: string; source: string; value?: string }>;
  leansOn: string[];                                    // "heavier, per your taste file: <rule>"
  dropped: Array<{ question: string; why: string }>;    // over the cap (sent to the inbox) or already asked
}

/** "I checked": counts and the lines worth reading (failures first, then a few passes). */
export function checkedPart(checks: Record<string, CheckResult[]>): Card['checked'] {
  const all = Object.entries(checks).flatMap(([who, cs]) => cs.map((c) => ({ who, c })));
  const failed = all.filter((x) => !x.c.pass && !x.c.pending), pending = all.filter((x) => !x.c.pass && x.c.pending), passed = all.filter((x) => x.c.pass);
  const lines = [
    ...failed.map((x) => `✗ ${x.who}: ${x.c.label} — ${x.c.detail}`),
    ...pending.map((x) => `… ${x.who}: ${x.c.label} — ${x.c.detail}`),
    ...[...new Set(passed.map((x) => x.c.label))].slice(0, 6).map((l) => `✓ ${l}`),
  ];
  if (passed.length > 6) lines.push(`✓ …and ${passed.length - 6} more`);
  return { passed: passed.length, failed: failed.length, pending: pending.length, lines };
}

function validate(a: AskInput) {
  if (!['pick', 'yesno', 'play60', 'note'].includes(a.kind)) throw new Error(`ask kind "${a.kind}" must be pick, yesno, play60 or note`);
  if (!a.question?.trim()) throw new Error('an ask needs a question');
  if (a.kind === 'pick' && (!a.options || a.options.length < 2 || a.options.length > 5)) throw new Error(`"${a.question}": a pick needs 2–5 options`);
  if (a.kind === 'play60' && !a.playable) throw new Error(`"${a.question}": play60 needs --playable (the change's recipe stamp) so it's asked once per playable change`);
}

export interface CardInput {
  proposal: string;
  checks: Record<string, CheckResult[]>;
  asks: AskInput[];
  rules: TasteRule[];
  unattended?: boolean;
  played?: Set<string>;                 // playable stamps already asked about
  leans?: string[];                     // rules the proposal leaned on while making it (in words)
  now?: string;
}

/** Build a card. Returns it plus the asks that go to the inbox (over the cap, or guessed while unattended). */
export function makeCard(inp: CardInput): { card: Card; toInbox: Ask[] } {
  inp.asks.forEach(validate);
  const now = inp.now ?? new Date().toISOString();
  const byTaste: Card['byTaste'] = [], dropped: Card['dropped'] = [], kept: AskInput[] = [];
  const leansOn = [...(inp.leans ?? [])];
  for (const a of inp.asks) {
    const hit = ruleFor(inp.rules, a.topic);
    if (hit) {
      byTaste.push({ question: a.question, topic: a.topic!, rule: hit.rule.text, source: sourceText(hit.rule.source), ...(hit.value ? { value: hit.value } : {}) });
      leansOn.push(`${a.topic}${hit.value ? ` → ${hit.value}` : ''}, per your taste file: "${hit.rule.text}" (${sourceText(hit.rule.source)})`);
      continue;
    }
    if (a.kind === 'play60' && inp.played?.has(a.playable!)) { dropped.push({ question: a.question, why: 'already asked to play this change' }); continue; }
    kept.push(a);
  }
  const asks: Ask[] = kept.map((a, i) => ({ ...a, id: `a${i + 1}`, status: 'open' }));
  const toInbox: Ask[] = [];
  for (const a of asks.slice(ASK_CAP)) { dropped.push({ question: a.question, why: `over the ${ASK_CAP}-ask cap: waits in the inbox` }); toInbox.push(a); }
  const shown = asks.slice(0, ASK_CAP);
  if (inp.unattended) for (const a of shown) {
    a.status = 'guessed';
    a.answer = a.guess ?? (a.kind === 'pick' ? a.options![0].label : a.kind === 'yesno' ? 'yes' : '');
    toInbox.push(a);
  }
  return {
    card: { proposal: inp.proposal, made: now, unattended: !!inp.unattended, checked: checkedPart(inp.checks), asks: shown, byTaste, leansOn, dropped },
    toInbox,
  };
}

/** Answer an ask. A pick's answer must be one of its options; yes/no is "yes" or "not yet". */
export function answerAsk(card: Card, askId: string, answer: string, now = new Date().toISOString()): Ask {
  const a = card.asks.find((x) => x.id === askId);
  if (!a) throw new Error(`no ask "${askId}" on ${card.proposal}'s card (asks: ${card.asks.map((x) => x.id).join(', ') || 'none'})`);
  let v = String(answer).trim();
  if (a.kind === 'pick') {
    const o = a.options!.find((x) => x.label.toLowerCase() === v.toLowerCase()) ?? (/^\d+$/.test(v) ? a.options![Number(v) - 1] : undefined);
    if (!o) throw new Error(`"${v}" isn't one of: ${a.options!.map((x) => x.label).join(', ')}`);
    v = o.label;
  } else if (a.kind === 'yesno') {
    if (/^(y|yes|ok|keep)$/i.test(v)) v = 'yes'; else if (/^(n|no|not yet|later)$/i.test(v)) v = 'not yet';
    else throw new Error('answer yes or not yet');
  } else if (a.kind === 'play60') {
    if (!v) v = 'played';
  } else if (!v) throw new Error('a note answer needs words');
  a.status = 'answered';
  a.answer = v;
  a.answeredAt = now;
  return a;
}

export function skipAsk(card: Card, askId: string): Ask {
  const a = card.asks.find((x) => x.id === askId);
  if (!a) throw new Error(`no ask "${askId}"`);
  if (a.status === 'answered') throw new Error(`${askId} is already answered (${a.answer})`);
  a.status = 'skipped';
  return a;
}

/** The decision-64 tripwire: the share of asks skipped (over about half for a week → milestone sessions). */
export function skipRate(cards: Card[]): { skipped: number; asked: number; rate: number } {
  const asks = cards.flatMap((c) => c.asks).filter((a) => a.status !== 'guessed');
  const skipped = asks.filter((a) => a.status === 'skipped').length;
  return { skipped, asked: asks.length, rate: asks.length ? skipped / asks.length : 0 };
}
