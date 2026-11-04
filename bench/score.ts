// Score an AI benchmark run from the project's .studio state. Usage: node bench/score.ts [projectDir]
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, Studio } from '../packages/core/src/index.ts';

const dir = path.resolve(process.argv[2] ?? process.cwd());
const repoFile = path.join(dir, '.studio', 'repo.json');
const actFile = path.join(dir, '.studio', 'activity.jsonl');
if (!fs.existsSync(repoFile)) { console.error(`no ${repoFile} — run a task first`); process.exit(1); }
await initKernel();
const studio = new Studio(JSON.parse(fs.readFileSync(repoFile, 'utf8')));
const acts = fs.existsSync(actFile) ? fs.readFileSync(actFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const ai = acts.filter((a) => a.author !== 'human');
const renders = fs.existsSync(path.join(dir, '.studio', 'renders')) ? fs.readdirSync(path.join(dir, '.studio', 'renders')).length : 0;
const h = studio.history.data;
studio.history.data.active = 'main';
const doc = studio.doc();
const checks = doc.objectOrder.map((id) => {
  const cs = studio.checks(id, doc);
  const fails = cs.filter((c) => !c.pass);
  return `${id}: ${cs.length - fails.length}/${cs.length}${fails.length ? ` (failing: ${fails.map((f) => f.label).join(', ')})` : ''}`;
});
console.log(JSON.stringify({
  toolCalls: ai.length,
  failedCalls: ai.filter((a) => !a.ok).length,
  commits: Object.keys(h.commits).length,
  proposals: Object.values(h.proposals).map((p) => `${p.id} ${p.status}`),
  renderImages: renders,
  checks,
  failedCallSamples: ai.filter((a) => !a.ok).slice(0, 5).map((a) => `${a.tool}: ${a.error}`),
}, null, 2));
