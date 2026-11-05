// Working together in the view (Phase 10): the notes panel, the "your call" card on a proposal, step
// extras (word note, before/after, reviewed or not) and the review counters. Plain HTML strings; the
// click handlers in main.ts turn data-act attributes into the same typed tool calls Claude makes.

export interface Address { thing: string; clock: string; at?: number; len?: number; near?: string; of?: string }
export interface ViewNote { id: string; text: string; status: 'open' | 'on-it' | 'done' | 'stale'; author: string; from?: string; proposal?: string; address: Address; where: string; compact: string; why?: string }
export interface Ask { id: string; kind: 'pick' | 'yesno' | 'play60' | 'note'; question: string; topic?: string; options?: Array<{ label: string }>; status: 'open' | 'answered' | 'skipped' | 'guessed'; answer?: string; note?: string }
export interface Card {
  proposal: string; unattended: boolean;
  checked: { passed: number; failed: number; pending: number; lines: string[] };
  asks: Ask[]; byTaste: Array<{ question: string; rule: string; source: string; value?: string }>; leansOn: string[]; dropped: Array<{ question: string; why: string }>;
}
export interface ReviewStats { steps: { kept: number; keptWithoutOpening: number; share: number; tripwire: string | null }; notes: { stale: number; total: number; tripwire: string | null }; taste: { rules: number }; asks: { skipped: number; asked: number; tripwire: string | null } }

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const STATUS: Record<ViewNote['status'], string> = { open: 'Open', 'on-it': 'On it', done: 'Done', stale: 'Stale' };

/** The notes panel: pin a note on what's selected; the inbox below (open, on it, stale; done folded). */
export function notesPanelHtml(notes: ViewNote[], pointingAt: string | null, draft: string): string {
  const live = notes.filter((n) => n.status !== 'done');
  const done = notes.filter((n) => n.status === 'done');
  const order = { stale: 0, open: 1, 'on-it': 2, done: 3 } as const;
  live.sort((a, b) => order[a.status] - order[b.status] || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const pin = pointingAt
    ? `<div class="nt-compose"><input id="noteDraft" type="text" placeholder="A note on ${esc(pointingAt)}…" value="${esc(draft)}"><button data-act="note-add" title="Pin it on ${esc(pointingAt)}">Pin</button></div><div class="nt-on">on <b>${esc(pointingAt)}</b></div>`
    : '<div class="nt-on">Select a part to pin a note on it.</div>';
  const row = (n: ViewNote) => {
    const acts = n.status === 'open' ? `<button data-act="note-status" data-note="${n.id}" data-to="on-it">On it</button><button data-act="note-status" data-note="${n.id}" data-to="done">Done</button>`
      : n.status === 'on-it' ? `<button data-act="note-status" data-note="${n.id}" data-to="done">Done</button>`
      : n.status === 'stale' ? `<button data-act="note-repin" data-note="${n.id}" title="Point it at the selection">Re-pin</button><button data-act="note-status" data-note="${n.id}" data-to="done">Drop</button>`
      : `<button data-act="note-status" data-note="${n.id}" data-to="open">Reopen</button>`;
    return `<div class="nt ${n.status}" data-note-row="${n.id}"><div class="nt-top"><span class="nt-pin">${esc(n.id.slice(1))}</span><span class="nt-st">${STATUS[n.status]}</span><span class="nt-who">${n.author === 'human' ? 'you' : esc(n.author)}${n.from === 'card' ? ' · your call' : n.from === 'guess' ? ' · my guess' : ''}</span></div>
      <div class="nt-text">${esc(n.text)}</div><div class="nt-where" title="${esc(n.compact)}">${esc(n.where)}${n.status === 'stale' && n.why ? ` — ${esc(n.why)}` : ''}</div><div class="nt-acts">${acts}</div></div>`;
  };
  return `<div class="label nt-label">Notes${live.length ? ` · ${live.length} open` : ''}</div>${pin}
    <div class="nt-list">${live.map(row).join('') || '<div class="muted">No open notes.</div>'}</div>
    ${done.length ? `<details class="nt-done"><summary>${done.length} done</summary>${done.slice(-12).map(row).join('')}</details>` : ''}`;
}

/** One proposal's "your call" card: what I checked, and at most ~3 asks only you can answer. */
export function cardHtml(c: Card): string {
  const shown = c.checked.lines.slice(0, 5);
  const more = c.checked.lines.length - shown.length;
  const checked = `<div class="cd-sec"><div class="cd-h">I checked <span>${c.checked.passed} pass${c.checked.failed ? ` · <em>${c.checked.failed} fail</em>` : ''}${c.checked.pending ? ` · ${c.checked.pending} in progress` : ''}</span></div>
    <ul class="cd-checks">${shown.map((l) => `<li class="${l.startsWith('✗') ? 'bad' : l.startsWith('…') ? 'pend' : ''}">${esc(l.replace(/^[✓✗…]\s*/, ''))}</li>`).join('')}${more > 0 ? `<li class="more">+${more} more</li>` : ''}</ul></div>`;
  const ask = (a: Ask) => {
    const head = `<div class="ask-q">${esc(a.question)}${a.status === 'guessed' ? ' <span class="guess">my guess</span>' : ''}</div>`;
    if (a.status === 'answered') return `<div class="ask done">${head}<div class="ask-a">You: ${esc(a.answer ?? '')}</div></div>`;
    if (a.status === 'skipped') return `<div class="ask skipped">${head}<div class="ask-a">Skipped · waits in notes (${esc(a.note ?? '')})</div></div>`;
    const btn = (label: string, answer: string, cls = '') => `<button class="${cls}" data-act="card-answer" data-ask="${a.id}" data-answer="${esc(answer)}">${esc(label)}</button>`;
    const controls = a.kind === 'pick' ? (a.options ?? []).map((o) => btn(o.label, o.label, a.status === 'guessed' && a.answer === o.label ? 'on' : '')).join('')
      : a.kind === 'yesno' ? btn('Yes', 'yes', a.status === 'guessed' && a.answer === 'yes' ? 'on' : '') + btn('Not yet', 'not yet')
      : a.kind === 'play60' ? btn('▶ Played 60 s', 'played')
      : `<input class="ask-note" data-ask-note="${a.id}" type="text" placeholder="A few words…"><button data-act="card-note" data-ask="${a.id}">Send</button>`;
    return `<div class="ask${a.status === 'guessed' ? ' guessed' : ''}">${head}<div class="ask-c">${controls}<button class="skip" data-act="card-skip" data-ask="${a.id}" title="It waits in the notes inbox">Skip</button></div>${a.status === 'guessed' ? `<div class="ask-a">Went ahead with “${esc(a.answer ?? '')}” overnight — tap to confirm or change</div>` : ''}</div>`;
  };
  const yours = `<div class="cd-sec"><div class="cd-h">Your call <span>${c.asks.filter((a) => a.status === 'open' || a.status === 'guessed').length} of ${c.asks.length} waiting</span></div>
    ${c.asks.map(ask).join('') || '<div class="muted">Nothing for you to judge on this one.</div>'}
    ${c.byTaste.map((b) => `<div class="cd-taste">Skipped “${esc(b.question)}”: your taste file says “${esc(b.rule)}” <span>(${esc(b.source)})</span></div>`).join('')}
    ${c.dropped.map((d) => `<div class="cd-taste">“${esc(d.question)}” — ${esc(d.why)}</div>`).join('')}</div>`;
  return `<div class="card${c.unattended ? ' overnight' : ''}">${c.unattended ? '<div class="cd-night">Made overnight: guesses are marked</div>' : ''}${checked}${yours}</div>`;
}

/** The counters that guard review quality (D62 tripwire: > 9 in 10 kept unopened → bigger steps). */
export function statsHtml(s: ReviewStats | undefined): string {
  if (!s) return '';
  const trip = [s.steps.tripwire, s.notes.tripwire, s.asks.tripwire].filter(Boolean);
  return `<div class="rv-stats" title="Steps kept without opening their before/after count against review quality">Kept without opening: <b>${s.steps.keptWithoutOpening}</b> of ${s.steps.kept} · taste rules: ${s.taste.rules}${s.notes.stale ? ` · stale notes: ${s.notes.stale}` : ''}${trip.length ? `<div class="trip">${trip.map((t) => esc(t!)).join('<br>')}</div>` : ''}</div>`;
}

/** Words for a selection, the way addresses read in the view: "Walnut stool / seat". */
export function pointingWords(objName: string | null, part: string | null): string | null {
  if (!objName) return null;
  return part ? `${objName} / ${part}` : objName;
}
