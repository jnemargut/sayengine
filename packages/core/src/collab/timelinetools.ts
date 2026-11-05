// Tools for the timeline (Phase 10 step 2): a word note on a clip at a moment becomes one step (D62)
// with a before and after you can play in the view; "show me three" for a scene sound, with a
// listen-and-pick "your call" ask (D64).
import { z } from 'zod';
import type { ToolDef } from '../tools.ts';
import { parseAddress } from './address.ts';
import { clipTimeline } from './timelines.ts';

const secs = (t: number) => +(t / 24000).toFixed(3);
const moments = (doc: any, obj: string, motion: string) => {
  const t = clipTimeline(doc, obj, motion);
  return t ? { seconds: secs(t.length), moments: Object.fromEntries(Object.entries(t.markers).map(([k, m]) => [k, secs(m.at)])) } : null;
};

export const TIMELINE_TOOLS: ToolDef[] = [
  {
    name: 'word-note', mode: 'propose', mutates: false,
    description: 'A word note on a clip at a moment ("slower", "more weight", "hold the pour longer", "snappier") becomes one step (Decision 62): on main it opens a proposal named after the note, then steers the action (action-note) with the note as the step\'s word note. The view\'s timeline plays the before and after (Before/after in the dock). --at is the moment address (default: the view\'s current moment — a bone or part selected while scrubbing a clip), or --object and --motion.',
    input: z.object({ note: z.string().min(1), at: z.union([z.string(), z.record(z.string(), z.any())]).optional(), object: z.string().optional(), motion: z.string().optional() }),
    example: 'studio word-note --note "slower, more weight" --at "blacksmith/RightHand@clip:strike 1.08s ~impact"',
    run(ctx, a) {
      const studio = ctx.studio, h = studio.history;
      let objectRef = a.object, motion = a.motion, where = '';
      if (!objectRef || !motion) {
        const addr = a.at ? parseAddress(a.at as any) : studio.collab.address('selection', ctx.doc);
        if (!addr.clock.startsWith('clip:')) throw new Error(`a word note on motion needs a moment on a clip (got clock "${addr.clock}"): scrub the timeline to the clip, or pass --object and --motion`);
        objectRef = addr.thing.split('/')[0];
        motion = addr.clock.slice(5);
        where = studio.collab.describe(addr, ctx.doc);
      }
      const o = ctx.obj(objectRef!);
      const before = moments(h.activeDoc(), o.id, motion!);
      let proposal: string | null = null;
      if (h.data.active === 'main') {
        const p = h.createProposal(`${o.name} ${motion}: ${a.note}`, ctx.author);
        proposal = p.id;
      } else proposal = h.data.active;
      const r = studio.call('action-note', { object: o.id, motion, note: a.note }, ctx.author, { why: a.note });
      if (!r.ok) {
        // the proposal we just opened has nothing in it: drop it
        if (h.data.active !== 'main' && proposal && !h.steps(h.proposal(proposal)).length) { h.discardProposal(h.proposal(proposal)); h.data.active = 'main'; }
        throw new Error(r.error ?? 'action-note failed');
      }
      const p = h.proposal(proposal!);
      const step = h.steps(p).at(-1)!;
      const after = moments(h.proposalDoc(p), o.id, motion!);
      ctx.summary(`${p.id}: "${a.note}" on ${o.name} ${motion}${where ? ` (${where})` : ''} → ${before?.seconds ?? '?'} s → ${after?.seconds ?? '?'} s; play Before/after in the view`);
      return { proposal: p.id, step: step.id, note: a.note, object: o.id, motion, before, after, checks: (r.result as any)?.checks?.filter?.((k: any) => !k.pass).map((k: any) => k.name) ?? [], next: `studio open-step --proposal ${p.id} --step ${step.id}` };
    },
  },
  {
    name: 'sound-three', mode: 'propose', mutates: false,
    description: '"Show me three" for a scene sound (Decision 62): three deliberately distinct takes (default for a clink: brighter, heavier, a dull thud; else three seeds and lengths), each a proposal with one set-sound step, plus a listen-and-pick "your call" ask (Decision 64). The view\'s timeline dock shows the three waveforms with Listen buttons and Pick; or `studio pick-take --group <g> --take <label>`. --takes \'[{"label":"…","set":{…set-sound flags}}]\' for your own.',
    input: z.object({ id: z.string(), takes: z.array(z.object({ label: z.string(), set: z.record(z.string(), z.any()) })).optional(), question: z.string().optional() }),
    example: 'studio sound-three --id clink',
    run(ctx, a) {
      const s: any = (ctx.doc as any).sounds?.[a.id];
      if (!s) throw new Error(`no sound "${a.id}" (studio add-sound)`);
      let takes = a.takes;
      if (!takes) {
        const seed = String(s.sfx?.seed ?? s.bed?.seed ?? s.music?.seed ?? 1);
        if (s.kind === 'event' && s.sfx?.kind === 'clink') takes = [
          { label: 'brighter ring', set: { params: { pitch: 1500 }, seed: `${seed}-bright` } },
          { label: 'heavier', set: { params: { pitch: 620 }, seed: `${seed}-heavy` } },
          { label: 'dull thud', set: { sound: 'thud', seed: `${seed}-thud` } },
        ];
        else if (s.kind === 'event') takes = [
          { label: 'take A', set: { seed: `${seed}-a`, gain: 0 } }, { label: 'take B', set: { seed: `${seed}-b`, gain: -4 } }, { label: 'take C', set: { seed: `${seed}-c`, gain: 3 } },
        ];
        else if (s.kind === 'bed') takes = [
          { label: 'calmer', set: { seed: `${seed}-calm`, seconds: Math.max(4, (s.bed?.seconds ?? 8) + 4) } }, { label: 'busier', set: { seed: `${seed}-busy`, seconds: Math.max(4, (s.bed?.seconds ?? 8) - 3) } }, { label: 'other bed', set: { sound: s.bed?.kind === 'crackle' ? 'forge-roar' : 'crackle', seed: `${seed}-other` } },
        ];
        else takes = [
          { label: 'slower', set: { bpm: Math.max(60, (s.music?.bpm ?? 96) - 18), seed: `${seed}-slow` } }, { label: 'faster', set: { bpm: Math.min(180, (s.music?.bpm ?? 96) + 22), seed: `${seed}-fast` } }, { label: 'other mood', set: { mood: s.music?.mood === 'night' ? 'warm' : 'night', seed: `${seed}-mood` } },
        ];
      }
      const r = ctx.studio.call('show-three', { title: `${s.name}`, topic: `sound-${a.id}`, takes: takes.map((t) => ({ label: t.label, traits: [t.label], calls: [{ tool: 'set-sound', args: { id: a.id, ...t.set } }] })) }, ctx.author);
      if (!r.ok) throw new Error(r.error ?? 'show-three failed');
      const res: any = r.result;
      const g: any = ctx.studio.history.data.takes![res.group];
      g.ask = { kind: 'pick', listen: true, question: a.question ?? `Which ${s.name.toLowerCase()} sounds right? Listen to each, then pick one`, topic: `sound-${a.id}`, sound: a.id, options: res.takes.map((t: any) => ({ label: t.label, proposal: t.proposal })) };
      ctx.summary(`${res.group}: three takes on ${s.name} (${res.takes.map((t: any) => t.label).join(' / ')}) — listen and pick in the view's timeline`);
      return { ...res, ask: g.ask };
    },
  },
];
