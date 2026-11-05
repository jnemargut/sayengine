// Validates every project skill the way decision-kit's scripts/validate-skills.py does (ported so
// it needs no PyYAML), plus the game family's own rules, its trigger fixtures, and install-skills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installSkills, GAME_SKILLS, SKILLS_SRC } from '../install-skills.ts';

/** Agent Skills spec fields, plus the one Claude Code field the game family relies on. */
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const CLAUDE_CODE_FIELDS = new Set(['disable-model-invocation']);

interface Parsed { meta: Record<string, unknown>; body: string; error?: string }

/** Minimal YAML-frontmatter reader for the subset skills use: `key: value`, quoted strings, one nested mapping level. */
function parseSkill(text: string): Parsed {
  if (!text.startsWith('---')) return { meta: {}, body: text, error: 'no YAML frontmatter' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text, error: 'frontmatter block is not closed' };
  const lines = text.slice(3, end).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const meta: Record<string, unknown> = {};
  let parent: string | null = null;
  for (const line of lines) {
    const nested = /^\s+/.test(line);
    const m = /^\s*([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!m) return { meta, body: '', error: `frontmatter line does not parse: ${line.trim()}` };
    const [, key, raw = ''] = m;
    let val: unknown = raw.trim();
    const v = val as string;
    if (v.startsWith('"')) { try { val = JSON.parse(v); } catch { return { meta, body: '', error: `bad quoted string for ${key}` }; } }
    else if (v.startsWith("'")) val = v.slice(1, -1).replace(/''/g, "'");
    else if (v === 'true' || v === 'false') val = v === 'true';
    else if (/:\s/.test(v)) return { meta, body: '', error: `value of ${key} contains ": " and must be quoted` };
    if (nested) {
      if (!parent) return { meta, body: '', error: `indented line with no parent: ${line.trim()}` };
      (meta[parent] as Record<string, unknown>)[key] = val;
    } else if (v === '') { meta[key] = {}; parent = key; }
    else { meta[key] = val; parent = null; }
  }
  return { meta, body: text.slice(end + 4) };
}

const skillDirs = fs.readdirSync(SKILLS_SRC).filter((d) => fs.existsSync(path.join(SKILLS_SRC, d, 'SKILL.md')));

test('every project skill passes the decision-kit validator rules', () => {
  const problems: string[] = [];
  for (const dir of skillDirs) {
    const file = path.join(SKILLS_SRC, dir, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const { meta, body, error } = parseSkill(text);
    if (error) { problems.push(`${dir}: ${error}`); continue; }
    for (const f of ['name', 'description']) if (!meta[f]) problems.push(`${dir}: missing \`${f}\``);
    if (meta.name && meta.name !== dir) problems.push(`${dir}: name \`${meta.name}\` does not match directory`);
    if (typeof meta.name === 'string' && meta.name.length > 64) problems.push(`${dir}: name over 64 characters`);
    if (typeof meta.description === 'string' && meta.description.length > 1024) problems.push(`${dir}: description is ${meta.description.length} characters (max 1024)`);
    const extra = Object.keys(meta).filter((k) => !SPEC_FIELDS.has(k) && !CLAUDE_CODE_FIELDS.has(k));
    if (extra.length) problems.push(`${dir}: non-spec top-level field(s) ${extra.join(', ')} — move under \`metadata\``);
    for (const m of text.matchAll(/`(references\/[A-Za-z0-9._/-]+\.md)`/g)) {
      if (!fs.existsSync(path.join(SKILLS_SRC, dir, m[1]))) problems.push(`${dir}: points at ${m[1]}, which does not exist`);
    }
    for (const m of text.matchAll(/`\.\.\/([a-z0-9-]+)\/((?:references|scripts)\/[A-Za-z0-9._/-]+|SKILL\.md)`/g)) {
      if (!fs.existsSync(path.join(SKILLS_SRC, m[1], m[2]))) problems.push(`${dir}: points at ../${m[1]}/${m[2]}, which does not exist`);
    }
    if (text.split('\n').length > 500) problems.push(`${dir}: SKILL.md is over 500 lines`);
    void body;
  }
  for (const dir of skillDirs) {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(SKILLS_SRC, dir))) {
      if (/\.(sh|py)$/.test(f)) { try { fs.accessSync(f, fs.constants.X_OK); } catch { problems.push(`${path.relative(SKILLS_SRC, f)}: shipped script is not executable`); } }
      if (/\/references\/[^/]+\.md$/.test(f)) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        if (lines.length > 100 && !lines.slice(0, 8).some((l) => /contents/i.test(l))) problems.push(`${path.relative(SKILLS_SRC, f)}: over 100 lines with no table of contents near the top`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('only the router can be auto-invoked in the game family', () => {
  for (const name of GAME_SKILLS) {
    const { meta } = parseSkill(fs.readFileSync(path.join(SKILLS_SRC, name, 'SKILL.md'), 'utf8'));
    if (name === 'x-decide-gaming') assert.notEqual(meta['disable-model-invocation'], true, 'the router must be auto-invocable');
    else assert.equal(meta['disable-model-invocation'], true, `${name} must be manual-only so its description never competes with the router`);
  }
  const router = fs.readFileSync(path.join(SKILLS_SRC, 'x-decide-gaming', 'SKILL.md'), 'utf8');
  for (const child of GAME_SKILLS.slice(1)) assert.ok(router.includes(`../${child}/SKILL.md`), `router hands over to ${child}`);
});

test('trigger fixtures cover every game skill with should and should-not prompts', () => {
  const file = path.resolve(SKILLS_SRC, '../../bench/skills/triggers.json');
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of GAME_SKILLS) {
    const s = fx.skills[name];
    assert.ok(s, `fixtures for ${name}`);
    assert.ok(s.shouldTrigger.length >= 3 && s.shouldNotTrigger.length >= 3, `${name}: at least 3 of each`);
    const all = [...s.shouldTrigger, ...s.shouldNotTrigger];
    assert.equal(new Set(all).size, all.length, `${name}: no duplicate prompts`);
  }
});

test('find-studio.sh resolves the repo launcher, including through an installed link', () => {
  const script = path.join(SKILLS_SRC, 'x-decide-gaming', 'scripts', 'find-studio.sh');
  const env = { ...process.env, STUDIO_HOME: '', PATH: '/usr/bin:/bin' };
  const direct = execFileSync('sh', [script], { env }).toString().trim();
  assert.equal(direct, path.resolve(SKILLS_SRC, '../../studio'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skills-'));
  installSkills({ home });
  const viaLink = execFileSync('sh', [path.join(home, '.claude', 'skills', 'x-decide-gaming', 'scripts', 'find-studio.sh')], { env }).toString().trim();
  assert.equal(viaLink, direct);
  fs.rmSync(home, { recursive: true, force: true });
});

test('install-skills links the family, is idempotent, and never clobbers foreign folders', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skills-'));
  const dest = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(dest, 'x-playtest'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'x-playtest', 'SKILL.md'), 'someone else\'s skill');
  const first = installSkills({ home });
  assert.deepEqual(first.linked.sort(), GAME_SKILLS.filter((n) => n !== 'x-playtest').sort());
  assert.equal(first.skipped[0]?.name, 'x-playtest');
  assert.equal(first.ok, false);
  assert.equal(fs.readFileSync(path.join(dest, 'x-playtest', 'SKILL.md'), 'utf8'), 'someone else\'s skill');
  const second = installSkills({ home, force: true });
  assert.deepEqual(second.unchanged.length, GAME_SKILLS.length - 1);
  assert.deepEqual(second.replaced, ['x-playtest']);
  assert.ok(fs.lstatSync(path.join(dest, 'x-decide-gaming')).isSymbolicLink());
  const copyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skills-'));
  const copied = installSkills({ home: copyHome, copy: true, bin: path.join(copyHome, 'bin') });
  assert.equal(copied.copied.length, GAME_SKILLS.length);
  assert.ok(!fs.lstatSync(path.join(copyHome, '.claude', 'skills', 'x-game-build')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(copyHome, 'bin', 'studio')).isSymbolicLink());
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(copyHome, { recursive: true, force: true });
});
