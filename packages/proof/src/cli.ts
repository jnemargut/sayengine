// `studio proof <command>` — the proof module's hands (Decision 31). Runs in the CLI process: it drives
// Godot, headless Chrome and Playwright's WebKit; it never needs the studio daemon.
import { DIR } from '../../cli/client.ts';

export const PROOF_COMMANDS: Record<string, { description: string; flags: Record<string, string>; example: string }> = {
  init: {
    description: 'Write the game\'s fixed proof views (proof/proof.json): --views [{name, position:[x,y,z], target:[x,y,z], fov?}], optional --phone {path:[[x,y,z]…], seconds, throttle} and --budgets {drawCalls, triangles, glbMB, phoneP50Ms, phoneP95Ms}.',
    flags: { '--project': 'game folder or name', '--views': 'JSON list of views', '--phone': 'JSON phone walk', '--budgets': 'JSON budgets', '--size': 'image width (default 960)' },
    example: 'studio proof init --project pocket-raleigh --views \'[{"name":"plaza","position":[17,1.7,40],"target":[17,4,0]}]\'',
  },
  views: {
    description: 'Render the fixed views with the clock and seed pinned in the game\'s engine (and --against <other game> for the other engine), FLIP-diff them against the approved pictures, check the budgets (draw calls, triangles, file size). Reports same / changed / new per view, the Godot-vs-web parity, and a contact sheet to Read. --approve-new true accepts views that have no reference yet.',
    flags: { '--project': 'game', '--against': 'the other engine\'s game', '--approve-new': 'accept views with no reference yet' },
    example: 'studio proof views --project pocket-raleigh --against pocket-raleigh-web',
  },
  approve: {
    description: 'Accept the latest run\'s pictures as the new reference (after you looked at them): all views, or --views a,b.',
    flags: { '--project': 'game', '--views': 'comma-separated view names' },
    example: 'studio proof approve --project pocket-raleigh',
  },
  phone: {
    description: 'The imitated phone (Decision 31, Mac only): the web build in Playwright\'s WebKit at 390×844 @3x and in Chrome with the CPU slowed (--throttle 4), walking the proof.json phone path for --seconds; reports frame times (p50, p95, long frames), draw calls, JS heap, console errors and a screenshot from each. Real-iPhone memory and GPU precision are NOT covered.',
    flags: { '--project': 'web game', '--seconds': 'walk length (default from proof.json, else 8)', '--throttle': 'Chrome CPU slow-down (default 4)' },
    example: 'studio proof phone --project pocket-raleigh-web',
  },
};

export async function proofCli(argv: string[], parseFlags: (a: string[]) => Record<string, unknown>): Promise<any> {
  const sub = argv.shift();
  if (!sub || sub === 'help' || sub === '--help') return { ok: true, usage: 'studio proof <command> [--flag value]…', commands: Object.fromEntries(Object.entries(PROOF_COMMANDS).map(([k, v]) => [k, v.description])), examples: Object.values(PROOF_COMMANDS).map((v) => v.example) };
  const def = PROOF_COMMANDS[sub];
  if (!def) return { ok: false, error: `unknown proof command "${sub}"`, commands: Object.keys(PROOF_COMMANDS) };
  if (argv.includes('--help')) return { command: `proof ${sub}`, ...def };
  const a = parseFlags(argv);
  const unknown = Object.keys(a).filter((k) => !Object.keys(def.flags).map((f) => f.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())).includes(k));
  if (unknown.length) return { ok: false, error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`, flags: Object.keys(def.flags), example: def.example };
  const P = await import('./proof.ts');
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  try {
    switch (sub) {
      case 'init': {
        const { resolveProject } = await import('../../game/src/project.ts');
        const { dir } = resolveProject(DIR, a.project);
        const views = P.validateViews(parse(a.views));
        const c: any = { seed: 1, steps: 30, size: Number(a.size ?? 960), views };
        if (a.phone) c.phone = parse(a.phone);
        if (a.budgets) c.budgets = parse(a.budgets);
        P.writeConfig(dir, c);
        return { ok: true, tool: 'proof-init', result: { file: P.configFile(dir), views: views.map((v) => v.name), next: `studio proof views --project ${a.project ?? ''} --approve-new true` } };
      }
      case 'views': return { tool: 'proof-views', ...(await P.proofViews(DIR, String(a.project ?? ''), { against: a.against as string | undefined, approveNew: a.approveNew === true || a.approveNew === 'true' })) };
      case 'approve': return { ok: true, tool: 'proof-approve', result: P.approve(DIR, String(a.project ?? ''), a.views ? String(a.views).split(',').map((s) => s.trim()) : undefined) };
      case 'phone': return { tool: 'proof-phone', ...(await P.phone(DIR, String(a.project ?? ''), { seconds: a.seconds as number | undefined, throttle: a.throttle as number | undefined })) };
    }
  } catch (e: any) {
    return { ok: false, tool: `proof-${sub}`, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  }
  return { ok: false, error: 'unreachable' };
}
