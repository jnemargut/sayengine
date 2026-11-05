// Tools for working together (Phase 10): addresses, notes, taste, the "your call" card, opening a
// step's before/after, and "show me three". Same typed tools for the CLI, the view and MCP.
import { z } from 'zod';
import type { ToolDef } from '../tools.ts';
import { describeAddress, formatAddress, formatMoment } from './address.ts';
import { changedLeaves, distinctness, sectionsOf, MIN_DISTINCT, type TakeLeaves } from './three.ts';
import { PICK_THRESHOLD, rulesFromPicks, sourceText } from './taste.ts';
import { ASK_CAP } from './card.ts';
import { getAt } from '../history.ts';

const AtZ = z.union([z.string(), z.record(z.string(), z.any())]).optional()
  .describe('"selection" (default: what is selected in the view), or an address: "stool/leg#2", "octopus@clip:pours-tea 2.4s ~pour", or JSON {thing, clock, at, len, near, of}');

const stepRef = (h: any, p: any, step: unknown) => {
  const steps = h.steps(p);
  const s = typeof step === 'number' || /^\d+$/.test(String(step)) ? steps[Number(step) - 1] : steps.find((x: any) => x.id === step);
  if (!s) throw new Error(`no step ${step} in ${p.id} (has ${steps.length})`);
  return s;
};

export const COLLAB_TOOLS: ToolDef[] = [
  {
    name: 'address', mode: 'inspect', mutates: false,
    description: 'A moment address (Decision 61) for something: the selection in the view (default), an object/part, or a moment on a clock (--clock clip:<motion> --seconds 1.4 snaps to the nearest named key; --near "<key label>"). Returns the address (ticks at 24,000/s), its words for the view ("Octopus · pours-tea · \\"pour\\" · 2.4 s") and its compact form for --at flags.',
    input: z.object({ at: AtZ, object: z.string().optional(), part: z.string().optional(), clock: z.string().optional(), seconds: z.number().optional(), near: z.string().optional() }),
    example: 'studio address --object octopus --clock clip:pours-tea --near pour',
    run(ctx, a) {
      const c = ctx.studio.collab;
      const addr = a.object ? c.address({ object: ctx.obj(a.object).id, part: a.part, clock: a.clock, seconds: a.seconds, near: a.near }, ctx.doc) : c.address(a.at ?? 'selection', ctx.doc);
      const t = c.timelineOf(addr, ctx.doc);
      return { address: addr, words: describeAddress(addr, t, (id) => ctx.doc.objects[id]?.name ?? id), compact: formatAddress(addr), ...(t && addr.clock !== 'none' ? { clock: { length: formatMoment({ ...addr, at: t.length, len: undefined, near: undefined }, t), moments: Object.fromEntries(Object.entries(t.markers).map(([k, m]) => [k, m.at])) } } : {}) };
    },
  },
  {
    name: 'notes', mode: 'review', mutates: false,
    description: 'The notes inbox (Decision 63): notes pinned on things and moments, each open / on-it / done / stale. --action list (default; --status all|open|on-it|done|stale), add (--text, --at; default the selection in the view), on-it|done|reopen (--id), stale (--id, --why), repin (--id, --at: re-point a stale note), refresh (re-resolve every note now). Stale = its moment is gone; notes are never moved silently.',
    input: z.object({ action: z.enum(['list', 'add', 'on-it', 'done', 'reopen', 'stale', 'repin', 'refresh']).optional(), text: z.string().optional(), at: AtZ, id: z.string().optional(), status: z.string().optional(), why: z.string().optional() }),
    example: 'studio notes add --text "the legs look too thin" --at selection',
    run(ctx, a) {
      const c = ctx.studio.collab;
      const act = a.action ?? (a.text ? 'add' : 'list');
      const need = () => { if (!a.id) throw new Error(`notes ${act} needs --id`); return a.id; };
      let out: any;
      switch (act) {
        case 'list': {
          const list = c.notesForView().filter((n: any) => !a.status || a.status === 'all' || n.status === a.status || (a.status === 'active' && n.status !== 'done'));
          ctx.summary(`${list.length} note(s)`);
          return { notes: list };
        }
        case 'add': {
          if (!a.text) throw new Error('notes add needs --text');
          const n = c.addNote(a.text, a.at ?? 'selection', { author: ctx.author, from: ctx.author === 'human' ? 'view' : 'cli' });
          ctx.summary(`${n.id}: "${n.text}" on ${c.describe(n.address)}`);
          out = { note: n, where: c.describe(n.address) };
          break;
        }
        case 'on-it': out = { note: c.setNote(need(), 'on-it', a.why) }; ctx.summary(`${a.id}: on it`); break;
        case 'done': out = { note: c.setNote(need(), 'done', a.why) }; ctx.summary(`${a.id}: done`); break;
        case 'reopen': out = { note: c.setNote(need(), 'open', a.why) }; ctx.summary(`${a.id}: open again`); break;
        case 'stale': out = { note: c.setNote(need(), 'stale', a.why ?? 'marked stale by hand') }; ctx.summary(`${a.id}: stale`); break;
        case 'repin': out = { note: c.repin(need(), a.at ?? 'selection') }; ctx.summary(`${a.id}: re-pinned`); break;
        case 'refresh': out = c.refreshNotes(); ctx.summary(`notes: ${out.moved.length} followed their moment, ${out.stale.length} went stale`); break;
      }
      ctx.studio.touch();
      return out;
    },
  },
  {
    name: 'taste', mode: 'review', mutates: false,
    description: `The taste file (Decision 63): plain-words rules with their source, studio-wide (~/.studio/taste.md) and per project (.studio/taste.md); both editable by hand and private. --action list (default), add (--text, --said true: you stated it outright; --topics "sound-source=cc0-first" names the asks it answers; --scope studio|project), learn (rules from patterns in ${PICK_THRESHOLD}+ of your picks). A rule is refused without a source.`,
    input: z.object({ action: z.enum(['list', 'add', 'learn']).optional(), text: z.string().optional(), said: z.boolean().optional(), topics: z.union([z.string(), z.array(z.string())]).optional(), scope: z.enum(['studio', 'project']).optional() }),
    example: 'studio taste add --text "Heavier bases on lamps" --said true --topics lamp-base=heavy',
    run(ctx, a) {
      const c = ctx.studio.collab;
      const act = a.action ?? (a.text ? 'add' : 'list');
      if (act === 'list') {
        const rules = c.tasteRules();
        ctx.summary(`${rules.length} taste rule(s)`);
        return { rules: rules.map((r: any) => ({ text: r.text, source: sourceText(r.source), topics: r.topics, scope: r.scope })), files: c.io.where?.() };
      }
      if (act === 'learn') {
        const picks = c.picks();
        const learned: any[] = [];
        for (const rule of rulesFromPicks(picks, c.tasteRules())) { c.addTaste(rule); learned.push(rule); }
        ctx.summary(learned.length ? `learned ${learned.length} rule(s) from ${picks.length} picks` : `no pattern yet in ${picks.length} picks (a rule needs the same choice ${PICK_THRESHOLD}+ times)`);
        return { picks: picks.length, learned };
      }
      if (!a.text) throw new Error('taste add needs --text');
      if (!a.said) throw new Error('add a rule only when the user said it outright (--said true); patterns in picks become rules by themselves after 3+');
      const topics = Array.isArray(a.topics) ? a.topics : a.topics ? String(a.topics).split(',').map((x) => x.trim()).filter(Boolean) : [];
      const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const r = c.addTaste({ text: a.text, source: { kind: 'said', date }, topics, scope: a.scope ?? 'project' });
      ctx.summary(`taste (${r.rule.scope}): "${a.text}"${r.replaced ? ' (replaced an older rule)' : ''}`);
      ctx.studio.touch();
      return r;
    },
  },
  {
    name: 'open-step', mode: 'review', mutates: false,
    description: 'Open a proposal step\'s before and after (Decision 62): what changed in plain words, the assets it touches, and the recipe stamps (render-cache keys) before and after. Only after this does Keep count as reviewed; the studio counts steps kept without opening. The view calls it when you press "Before/after" on a step.',
    input: z.object({ proposal: z.string().optional(), step: z.union([z.string(), z.number()]) }),
    example: 'studio open-step --proposal p1 --step 2',
    run(ctx, a) {
      const p = ctx.studio.history.proposal(a.proposal);
      const r = ctx.studio.collab.openStep(p, a.step);
      ctx.summary(`${p.id}: opened "${r.summary}"`);
      return r;
    },
  },
  {
    name: 'card', mode: 'review', mutates: false,
    description: `The "your call" card on a proposal (Decision 64): "I checked" comes from the checks; "your call" holds at most ${ASK_CAP} asks — pick (one of 2–5 options), yesno (yes / not yet), play60 (play it for 60 s; asked once per playable change), note (a short typed note). Asks the taste file answers (by --topic) are skipped and the card says it leaned on that rule. Over the cap → the inbox. --unattended true (overnight work): nothing waits; each ask proceeds on its --guess, marked as a guess, with an inbox note to check it. --asks '[{"kind":"pick","question":"Which legs?","topic":"stool-legs","options":[{"label":"splayed","traits":["splayed"]},{"label":"straight"}]}]'. --leans: rules you leaned on while making it, in words.`,
    input: z.object({ proposal: z.string().optional(), asks: z.array(z.record(z.string(), z.any())).optional(), unattended: z.boolean().optional(), leans: z.array(z.string()).optional() }),
    example: `studio card --proposal p1 --asks '[{"kind":"yesno","question":"Is the lower back still comfortable-looking?","topic":"chair-back"}]'`,
    run(ctx, a) {
      const p = ctx.studio.history.proposal(a.proposal);
      if (!a.asks) { if (!p.card) throw new Error(`${p.id} has no card yet: pass --asks`); return p.card; }
      const card = ctx.studio.collab.makeCard(p, a.asks as any, { unattended: a.unattended, leans: a.leans });
      ctx.summary(`${p.id} card: ${card.checked.passed} checks pass${card.checked.failed ? `, ${card.checked.failed} fail` : ''}; ${card.asks.length} ask(s)${card.byTaste.length ? `, ${card.byTaste.length} answered by taste` : ''}${card.unattended ? ' (guessed: unattended)' : ''}`);
      return card;
    },
  },
  {
    name: 'answer', mode: 'review', mutates: false,
    description: 'Answer an ask on a proposal\'s card: --ask a1 --answer "splayed" (pick: an option label or its number; yesno: yes / not yet; play60: played; note: words). --remember true turns the answer into a taste rule ("you said"); picks feed the pattern count (3+ the same → a rule).',
    input: z.object({ proposal: z.string().optional(), ask: z.string(), answer: z.string(), remember: z.boolean().optional() }),
    run(ctx, a) {
      const p = ctx.studio.history.proposal(a.proposal);
      const r = ctx.studio.collab.answer(p, a.ask, a.answer, { remember: a.remember });
      ctx.summary(`${p.id} ${a.ask}: ${r.ask.answer}${r.rule ? ' (now a taste rule)' : ''}${r.learned.length ? ` — learned: ${r.learned.map((x: any) => x.text).join('; ')}` : ''}`);
      return r;
    },
  },
  {
    name: 'skip-ask', mode: 'review', mutates: false,
    description: 'Skip an ask on a card: it goes to the notes inbox and waits there.',
    input: z.object({ proposal: z.string().optional(), ask: z.string() }),
    run(ctx, a) {
      const p = ctx.studio.history.proposal(a.proposal);
      const r = ctx.studio.collab.skip(p, a.ask);
      ctx.summary(`${p.id} ${a.ask}: skipped → ${r.note.id}`);
      return r;
    },
  },
  {
    name: 'show-three', mode: 'propose', mutates: false,
    description: `"Show me three" (Decision 62): three deliberately distinct takes on one ask, each a proposal built from its own tool calls, compared per section. Takes closer than --min (default ${MIN_DISTINCT}, i.e. ${Math.round(MIN_DISTINCT * 100)}% apart on what they change) are refused: push them apart. Then pick-take keeps one whole take; the other two are discarded, never merged. --takes '[{"label":"low","traits":["low","heavy"],"calls":[{"tool":"set-param","args":{"name":"backH","value":0.3}}]}, …]' (exactly 3). Works on any asset (models, looks, actions…).`,
    input: z.object({ title: z.string(), topic: z.string().optional(), takes: z.array(z.object({ label: z.string(), traits: z.array(z.string()).optional(), calls: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })) })), min: z.number().optional() }),
    example: `studio show-three --title "Stool legs" --topic stool-legs --takes '[{"label":"splayed","calls":[{"tool":"set-param","args":{"name":"legSplay","value":10}}]},{"label":"thick","calls":[{"tool":"set-param","args":{"name":"legR","value":0.03}}]},{"label":"tall","calls":[{"tool":"set-param","args":{"name":"seatH","value":0.65}}]}]'`,
    run(ctx, a) {
      const studio = ctx.studio, h = studio.history;
      if (h.data.active !== 'main') throw new Error(`show-three starts from main (now on ${h.data.active}): commit or discard it first, or studio switch --branch main`);
      if (a.takes.length !== 3) throw new Error(`show me three: exactly 3 takes (got ${a.takes.length})`);
      const labels = a.takes.map((t: any) => t.label);
      if (new Set(labels).size !== 3) throw new Error('the three takes need different labels');
      const gid = `t${(h.data.seq.take = (h.data.seq.take ?? 0) + 1)}`;
      const made: any[] = [];
      const fail = (msg: string) => { for (const m of made) if (m.p.status === 'open') h.discardProposal(m.p); h.data.active = 'main'; throw new Error(msg); };
      for (const t of a.takes) {
        h.data.active = 'main';
        const p = h.createProposal(`${a.title} — ${t.label}`, ctx.author);
        p.takeGroup = gid;
        made.push({ p, t });
        for (const call of t.calls) {
          const r = studio.call(call.tool, call.args ?? {}, ctx.author);
          if (!r.ok) fail(`take "${t.label}": ${call.tool} failed: ${r.error}`);
        }
      }
      h.data.active = 'main';
      const base = h.mainDoc();
      const takes: TakeLeaves[] = made.map((m) => ({ label: m.t.label, leaves: changedLeaves(base, h.proposalDoc(m.p)) }));
      const baseOf = (path: string) => getAt(base, path.split('.'));
      const d = distinctness(takes, baseOf, a.min ?? MIN_DISTINCT);
      if (!d.ok) fail(`the takes are too alike: ${d.tooAlike.join('; ')}. Make them deliberately different (a bolder change, or a different section).`);
      const doc0 = base;
      const sectionOf = (path: string) => {
        const k = path.split('.');
        if (k[0] === 'objects') { const o = doc0.objects[k[1]] ?? h.proposalDoc(made[0].p).objects[k[1]]; const sec = k[2] === 'params' ? `param ${k[3]}` : k[2] === 'ops' ? `op ${k[3]}` : k[2] === 'character' || k[2] === 'creature' ? `${k[2]} ${k[3] ?? ''} ${k[4] ?? ''}`.trim() : k[2]; return `${o?.name ?? k[1]} · ${sec}`; }
        if (k[0] === 'look') return `look ${k[2] ?? ''} · ${k[3] ?? ''}`.trim();
        return k.slice(0, 3).join(' · ');
      };
      const sections = sectionsOf(takes, sectionOf, baseOf);
      (h.data.takes ??= {})[gid] = {
        id: gid, title: a.title, topic: a.topic ?? a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), author: ctx.author, created: new Date().toISOString(),
        takes: made.map((m) => ({ label: m.t.label, proposal: m.p.id, traits: m.t.traits ?? [m.t.label] })),
        distinct: { pairs: d.pairs, min: d.min }, sections, status: 'open',
      };
      ctx.summary(`${gid} "${a.title}": ${labels.join(' / ')} (${made.map((m) => m.p.id).join(', ')}), ${Math.round(Math.min(...d.pairs.map((x) => x.distance)) * 100)}%+ apart`);
      return { group: gid, takes: made.map((m) => ({ label: m.t.label, proposal: m.p.id })), distinct: d.pairs, sections, next: `studio pick-take --group ${gid} --take <label>` };
    },
  },
  {
    name: 'pick-take', mode: 'review', mutates: false,
    description: 'Pick one of the three takes: its proposal is committed whole; the other two are discarded, never merged. The pick is logged (topic, traits chosen and passed over); the same choice 3+ times becomes a taste rule. --drop true discards all three.',
    input: z.object({ group: z.string().optional(), take: z.string().optional(), why: z.string().optional(), drop: z.boolean().optional(), opened: z.boolean().optional() }),
    example: 'studio pick-take --group t1 --take splayed --why "reads lighter"',
    run(ctx, a) {
      const h = ctx.studio.history;
      const groups = Object.values(h.data.takes ?? {}).filter((g: any) => g.status === 'open') as any[];
      const g = a.group ? h.data.takes?.[a.group] : groups.length === 1 ? groups[0] : null;
      if (!g) throw new Error(a.group ? `no take group "${a.group}"` : `which group? open: ${groups.map((x) => x.id).join(', ') || 'none'}`);
      if (a.opened) { g.opened = true; ctx.summary(`${g.id}: compare opened`); return { group: g.id, opened: true }; }
      if (g.status !== 'open') throw new Error(`${g.id} is already ${g.status}`);
      const prop = (id: string) => h.data.proposals[id];
      if (a.drop) {
        for (const t of g.takes) if (prop(t.proposal).status === 'open') h.discardProposal(prop(t.proposal));
        g.status = 'dropped'; g.resolved = new Date().toISOString(); h.data.active = 'main';
        ctx.summary(`${g.id}: all three takes dropped`);
        return { group: g.id, status: g.status };
      }
      const chosen = g.takes.find((t: any) => t.label.toLowerCase() === String(a.take ?? '').toLowerCase());
      if (!chosen) throw new Error(`which take? ${g.takes.map((t: any) => t.label).join(', ')}`);
      for (const t of g.takes) if (t !== chosen && prop(t.proposal).status === 'open') h.discardProposal(prop(t.proposal));
      const p = prop(chosen.proposal);
      // the takes were compared side by side: their steps count as seen once the compare was opened
      if (g.opened) p.seen = [...new Set([...(p.seen ?? []), ...h.steps(p).map((s: any) => s.id)])];
      h.data.active = 'main';
      const r = h.commitProposal(p);
      g.status = 'picked'; g.picked = chosen.label; g.why = a.why; g.resolved = new Date().toISOString();
      const { learned } = ctx.studio.collab.logPick({ time: g.resolved, topic: g.topic, chosen: { label: chosen.label, traits: chosen.traits }, rejected: g.takes.filter((t: any) => t !== chosen).map((t: any) => ({ label: t.label, traits: t.traits })), from: 'three', group: g.id });
      ctx.summary(`${g.id}: picked "${chosen.label}" (${r.merged.length} change(s) to main); the other two discarded${learned.length ? `; taste learned: ${learned.map((x: any) => x.text).join('; ')}` : ''}`);
      return { group: g.id, picked: chosen.label, merged: r.merged.map((c: any) => c.id), discarded: g.takes.filter((t: any) => t !== chosen).map((t: any) => t.proposal), learned };
    },
  },
  {
    name: 'review-stats', mode: 'inspect', mutates: false,
    description: 'The working-together tripwires (decisions 61–64): steps kept without opening, notes gone stale, taste rule count, asks skipped; plus where notes and taste live.',
    input: z.object({}),
    run(ctx) { return ctx.studio.collab.stats(); },
  },
];
