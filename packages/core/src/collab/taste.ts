// The taste file (Decision 63): plain-words rules, each with where it came from, read before every
// proposal. Studio-wide (~/.studio/taste.md) plus one per project (<project>/.studio/taste.md); both
// private by default. A rule appears only when you say it outright, or when a pattern repeats in 3 or
// more of your picks. A proposal that leans on a rule says so, so a wrong rule gets caught.

export interface TasteRule {
  text: string;
  source: { kind: 'said'; date: string } | { kind: 'picks'; n: number } | { kind: 'other'; text: string };
  topics: string[];               // what asks it answers: "sound-source", "kid-smile=keep"
  scope: 'studio' | 'project';
}

export const PICK_THRESHOLD = 3;
export const RULE_LIMIT = 30;

const HEADER = (scope: 'studio' | 'project') => `# Taste (${scope === 'studio' ? 'studio-wide' : 'this project'})

Plain-words rules the studio reads before every proposal. Edit freely: change a line, or delete it to drop the rule.
Each rule says where it came from: "you said, <date>" or "from N picks". Rules are added only when you say
one outright, or when the same choice shows up in ${PICK_THRESHOLD}+ of your picks. Topics in \`backticks\` are the
asks a rule answers (the card skips them). Private: this file is gitignored.
`;

export function sourceText(s: TasteRule['source']): string {
  return s.kind === 'said' ? `you said, ${s.date}` : s.kind === 'picks' ? `from ${s.n} picks` : s.text;
}

export function formatTaste(rules: TasteRule[], scope: 'studio' | 'project'): string {
  return HEADER(scope) + '\n' + rules.map((r) => `- ${r.text} — ${sourceText(r.source)}${r.topics.length ? ' ' + r.topics.map((t) => `\`${t}\``).join(' ') : ''}`).join('\n') + '\n';
}

export function parseTaste(md: string, scope: 'studio' | 'project'): TasteRule[] {
  const out: TasteRule[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    let body = line.slice(2).trim();
    const topics: string[] = [];
    body = body.replace(/`([^`]+)`/g, (_, t) => { topics.push(t.trim()); return ''; }).trim();
    const dash = body.lastIndexOf(' — ');
    let text = body, src = '';
    if (dash > 0) { text = body.slice(0, dash).trim(); src = body.slice(dash + 3).trim(); }
    let source: TasteRule['source'];
    const said = src.match(/^you said,?\s*(.+)$/i), picks = src.match(/^from (\d+) picks?$/i);
    if (said) source = { kind: 'said', date: said[1] };
    else if (picks) source = { kind: 'picks', n: Number(picks[1]) };
    else source = { kind: 'other', text: src || 'no source given' };
    out.push({ text, source, topics, scope });
  }
  return out;
}

/** The rule that answers an ask's topic, if any (project rules win over studio-wide ones). */
export function ruleFor(rules: TasteRule[], topic: string | undefined): { rule: TasteRule; value?: string } | null {
  if (!topic) return null;
  const sorted = [...rules].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1));
  for (const r of sorted) for (const t of r.topics) {
    const [k, v] = t.split('=');
    if (k === topic) return { rule: r, ...(v ? { value: v } : {}) };
  }
  return null;
}

/**
 * Add a rule — only with evidence. "said": you stated it outright. "picks": the pattern must
 * repeat PICK_THRESHOLD (3) or more times. Anything else is refused.
 */
export function addRule(rules: TasteRule[], rule: TasteRule): { rules: TasteRule[]; replaced?: TasteRule; warning?: string } {
  if (rule.source.kind === 'picks' && rule.source.n < PICK_THRESHOLD) throw new Error(`a rule from picks needs the same choice ${PICK_THRESHOLD}+ times (have ${rule.source.n}); until then it's just a pick`);
  if (rule.source.kind === 'other') throw new Error('a taste rule needs a source: you said it outright (said), or it comes from 3+ picks');
  if (!rule.text.trim()) throw new Error('a taste rule needs words');
  const same = rules.findIndex((r) => r.scope === rule.scope && (r.text.toLowerCase() === rule.text.toLowerCase() || (rule.topics.length && r.topics.some((t) => rule.topics.some((u) => u.split('=')[0] === t.split('=')[0])))));
  const next = [...rules];
  let replaced: TasteRule | undefined;
  if (same >= 0) { replaced = next[same]; next[same] = rule; } else next.push(rule);
  const n = next.filter((r) => r.scope === rule.scope).length;
  return { rules: next, ...(replaced ? { replaced } : {}), ...(n > RULE_LIMIT ? { warning: `${n} rules in the ${rule.scope} taste file: past about ${RULE_LIMIT}, long lists stop being read. Prune or merge.` } : {}) };
}

// ── picks → rules ────────────────────────────────────────────────────────────────────────────────

export interface Pick {
  time: string;
  topic: string;                  // what was being chosen: "stool-legs", "forge-sound"
  chosen: { label: string; traits: string[] };
  rejected: Array<{ label: string; traits: string[] }>;
  from: 'three' | 'card';
  group?: string;
}

/**
 * Patterns in your picks: a trait you chose PICK_THRESHOLD+ times and never passed over. Returns
 * candidate rules (with their evidence); nothing below the threshold.
 */
export function rulesFromPicks(picks: Pick[], existing: TasteRule[] = []): TasteRule[] {
  const wins = new Map<string, number>(), losses = new Map<string, number>();
  for (const p of picks) {
    const lost = new Set(p.rejected.flatMap((r) => r.traits));
    for (const t of new Set(p.chosen.traits)) if (!lost.has(t)) wins.set(t, (wins.get(t) ?? 0) + 1);
    for (const t of lost) if (!p.chosen.traits.includes(t)) losses.set(t, (losses.get(t) ?? 0) + 1);
  }
  const out: TasteRule[] = [];
  for (const [t, n] of wins) {
    if (n < PICK_THRESHOLD || (losses.get(t) ?? 0) > 0) continue;
    const topic = `lean:${t}`;
    if (existing.some((r) => r.topics.includes(topic))) continue;
    out.push({ text: `Lean ${t}: you picked it ${n} times and never passed it over.`, source: { kind: 'picks', n }, topics: [topic], scope: 'project' });
  }
  return out;
}

/** The studio-wide verdicts the user has already given (seeded into a new ~/.studio/taste.md). */
export const SEED_TASTE: TasteRule[] = [
  { text: 'Sounds: CC0 library sounds first; Stable Audio Open Small only to fill the gaps.', source: { kind: 'said', date: '5 Nov 2026' }, topics: ['sound-source=cc0-first'], scope: 'studio' },
  { text: "The kid's smile is good enough. Don't revisit it.", source: { kind: 'said', date: '5 Nov 2026' }, topics: ['kid-smile=keep'], scope: 'studio' },
  { text: 'The PAC is good enough. Don\'t revisit it.', source: { kind: 'said', date: '5 Nov 2026' }, topics: ['pac=keep'], scope: 'studio' },
];
