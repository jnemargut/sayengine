// `studio sound <command>` — the sound module's hands (Decision 33). Runs in the CLI process (no daemon):
// it renders, fetches, analyses and writes files.
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from '../../cli/client.ts';

export const SOUND_COMMANDS: Record<string, { description: string; flags: Record<string, string>; example: string }> = {
  sfx: { description: 'One game sound from settings: --kind (pickup, laser, explosion, powerup, hit, jump, blip — jsfxr-style; clink, hiss, puff, chime, buzz, thud, riser, impact, whoosh — physical) + --seed, or --kind sfxr --params {...}. Same kind + seed = same samples everywhere. Writes a WAV with its licence sidecar.', flags: { '--kind': 'sound kind', '--seed': 'any string or number', '--params': 'kind options / sfxr params (JSON)', '--out': 'WAV path', '--owner': 'copyright holder (default "the game\'s authors")' }, example: 'studio sound sfx --kind clink --seed strike-1 --out clink.wav' },
  bed: { description: 'A seamless ambience loop: --kind forge-roar | crackle | room | city-hum | wind (procedural), or --library <id> (a CC0 recording, cut and crossfaded).', flags: { '--kind': 'bed kind', '--library': 'library id (studio sound library)', '--seconds': 'loop length (default 8)', '--seed': 'seed', '--out': 'WAV path' }, example: 'studio sound bed --kind forge-roar --seconds 8 --out roar.wav' },
  stems: { description: 'Seeded music stems (pad, arp, bass, hats, beat, lead) as loops exactly --bars bars long, plus a mix per intensity level and a listening report (loudness, band split, seam, a waveform+spectrogram picture to Read).', flags: { '--seed': 'seed', '--mood': 'warm | night | forge | bright', '--bpm': 'tempo', '--bars': 'loop bars (default 8)', '--out': 'folder' }, example: 'studio sound stems --seed my-game --mood warm --out music/' },
  library: { description: 'The CC0 catalogue (OpenGameArt works whose page says CC0), searchable: --search "fire crackle".', flags: { '--search': 'words' }, example: 'studio sound library --search anvil' },
  fetch: { description: 'Fetch a library sound once into ~/.studio-tools/sound-library (converted to 44.1 kHz WAV, licence recorded).', flags: { '--id': 'library id' }, example: 'studio sound fetch --id fire-crackling' },
  pack: { description: 'Build a game\'s sound pack from sound/sound-spec.json (layers that follow game values, events, seeded music with an intensity ladder, stings) into assets/studio/sound/ with a licence sidecar per file, sound.json and CREDITS.md, and add the runtime (studio/sound.ts or studio/sound.gd).', flags: { '--project': 'game', '--spec': 'a spec (JSON) to write and build' }, example: 'studio sound pack --project fires-dying' },
  listen: { description: 'Listen as far as an agent can: loudness (EBU R128: LUFS, LRA, true peak), clipping, band split, silences, loop seam, and a waveform + spectrogram PNG to Read.', flags: { '--file': 'WAV', '--loop': 'also check the loop seam' }, example: 'studio sound listen --file music/level3.wav --loop' },
  beats: { description: 'Beat grid of a track (librosa in ~/.studio-tools/venv): bpm, beats, downbeats, onsets.', flags: { '--file': 'audio file', '--bpm-hint': 'expected tempo' }, example: 'studio sound beats --file track.wav' },
  loop: { description: 'A loop cut on the beat from a recording with a beat: --bars bars from its first downbeat, the tail folded into the start.', flags: { '--file': 'WAV', '--bars': 'bars', '--out': 'WAV path' }, example: 'studio sound loop --file groove.wav --bars 4 --out groove-loop.wav' },
  credits: { description: 'Check every audio file under --dir has a licence (REUSE sidecar) and rewrite CREDITS.md from them.', flags: { '--dir': 'folder', '--title': 'title for the credits' }, example: 'studio sound credits --dir games/fires-dying/assets/studio/sound' },
  sao: { description: 'Stable Audio Open Small (local) for foley/textures: status (what blocks it here, the licence), or --prompt to generate when available.', flags: { '--prompt': 'text', '--seconds': '≤ 11', '--seed': 'seed', '--out': 'WAV path' }, example: 'studio sound sao' },
};

export async function soundCli(argv: string[], parseFlags: (a: string[]) => Record<string, unknown>): Promise<any> {
  const sub = argv.shift();
  if (!sub || sub === 'help' || sub === '--help') return { ok: true, usage: 'studio sound <command> [--flag value]…', commands: Object.fromEntries(Object.entries(SOUND_COMMANDS).map(([k, v]) => [k, v.description])), examples: Object.values(SOUND_COMMANDS).map((v) => v.example) };
  const def = SOUND_COMMANDS[sub];
  if (!def) return { ok: false, error: `unknown sound command "${sub}"`, commands: Object.keys(SOUND_COMMANDS) };
  if (argv.includes('--help')) return { command: `sound ${sub}`, ...def };
  const a = parseFlags(argv);
  const known = Object.keys(def.flags).map((f) => f.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const unknown = Object.keys(a).filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, error: `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `--${u}`).join(', ')}`, flags: Object.keys(def.flags), example: def.example };
  const res = (p: unknown, d: string) => path.resolve(DIR, String(p ?? d));
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  const owner = String(a.owner ?? "the game's authors");
  try {
    const D = await import('./dsp.ts');
    const { writeSidecar, audit, creditsMarkdown } = await import('./ledger.ts');
    switch (sub) {
      case 'sfx': {
        const { sfx } = await import('./sfx.ts');
        const out = res(a.out, `${a.kind}-${a.seed ?? 1}.wav`);
        D.writeWav(out, sfx(String(a.kind), (a.seed as any) ?? 1, a.params ? parse(a.params) : {}));
        writeSidecar(out, { spdx: 'CC0-1.0', copyright: `${new Date().getFullYear()} ${owner} (generated by the studio)`, source: 'synth', how: `sfx ${a.kind} seed ${a.seed ?? 1}` });
        return { ok: true, tool: 'sound-sfx', result: { file: out, licence: out + '.license' } };
      }
      case 'bed': {
        const { bed, loopFromRecording } = await import('./ambience.ts');
        const out = res(a.out, `${a.kind ?? a.library}.wav`), secs = Number(a.seconds ?? 8);
        if (a.library) { const L = await import('./library.ts'); const { wav, entry } = await L.fetchEntry(String(a.library)); D.writeWav(out, loopFromRecording(wav, secs)); writeSidecar(out, L.licenceOf(entry)); }
        else { D.writeWav(out, bed(a.kind as any, (a.seed as any) ?? 1, secs)); writeSidecar(out, { spdx: 'CC0-1.0', copyright: `${new Date().getFullYear()} ${owner} (generated by the studio)`, source: 'ambience', how: `bed ${a.kind} seed ${a.seed ?? 1}` }); }
        return { ok: true, tool: 'sound-bed', result: { file: out, seamJump: +D.seamJump(D.readWav(out).ch).toFixed(2) } };
      }
      case 'stems': {
        const M = await import('./music.ts');
        const { listen } = await import('./listen.ts');
        const out = res(a.out, `stems-${a.seed ?? 1}`);
        fs.mkdirSync(out, { recursive: true });
        const p = M.plan({ seed: (a.seed as any) ?? 1, mood: a.mood as any, bpm: a.bpm as any, bars: a.bars as any });
        const st = M.renderStems(p);
        const lic = (how: string) => ({ spdx: 'CC0-1.0', copyright: `${new Date().getFullYear()} ${owner} (generated by the studio)`, source: 'stems' as const, how });
        for (const s of M.STEMS) { const f = path.join(out, `${s}.wav`); D.writeWav(f, D.scale(st[s], M.FADER[s] * 0.5)); writeSidecar(f, lic(`stem ${s} seed ${a.seed ?? 1}`)); }
        const levels = M.LEVELS.map((mix, i) => { const f = path.join(out, `level${i}.wav`); D.writeWav(f, D.softClip(M.toLoudness(M.mixStems(st, mix), -16))); writeSidecar(f, lic(`mix level ${i} seed ${a.seed ?? 1}`)); return listen(f, { loop: true }); });
        return { ok: true, tool: 'sound-stems', result: { folder: out, key: p.keyName, bpm: p.bpm, progression: p.progression, loopSeconds: p.loopSeconds, levels } };
      }
      case 'library': { const L = await import('./library.ts'); return { ok: true, tool: 'sound-library', result: { cache: L.libraryDir(), sounds: (a.search ? L.search(String(a.search)) : L.CATALOGUE).map((e) => ({ id: e.id, title: e.title, author: e.author, licence: e.spdx, page: e.page, tags: e.tags })) } }; }
      case 'fetch': { const L = await import('./library.ts'); const r = await L.fetchEntry(String(a.id)); return { ok: true, tool: 'sound-fetch', result: { file: r.wav, cached: r.cached, licence: L.licenceOf(r.entry) } }; }
      case 'pack': {
        const { resolveProject } = await import('../../game/src/project.ts');
        const { dir, config } = resolveProject(DIR, a.project);
        const P = await import('./pack.ts');
        const r = await P.buildGamePack(dir, config.engine, a.spec ? parse(a.spec) : undefined);
        return { ok: true, tool: 'sound-pack', result: { folder: path.join(dir, 'assets', 'studio', 'sound'), runtimes: r.runtimes, files: Object.keys(r.manifest.files).length, report: r.report, use: config.engine === 'godot' ? 'var snd = preload("res://studio/sound.gd").start(self); snd.set_value("fire", 0.5); snd.event("strike")' : "const snd = await startSound(game); snd?.setValue('fire', 0.5); snd?.event('strike')" } };
      }
      case 'listen': { const { listen } = await import('./listen.ts'); return { ok: true, tool: 'sound-listen', result: listen(res(a.file, ''), { loop: !!a.loop }) }; }
      case 'beats': { const B = await import('./beats.ts'); const g = B.detectBeats(res(a.file, ''), a.bpmHint as number | undefined); return { ok: true, tool: 'sound-beats', result: { ...g, onsets: g.onsets.length } }; }
      case 'loop': { const B = await import('./beats.ts'); const r = B.beatCutLoop(res(a.file, ''), Number(a.bars ?? 4)); const out = res(a.out, 'loop.wav'); D.writeWav(out, r.audio); return { ok: true, tool: 'sound-loop', result: { file: out, startS: r.startS, seconds: r.seconds, bpm: r.bpm, seamJump: +D.seamJump(r.audio).toFixed(2), note: 'give it the source\'s licence: copy its .license next to the loop' } }; }
      case 'credits': {
        const dir = res(a.dir, '.'), au = audit(dir);
        const entries = au.rows.filter((r) => r.ok).map((r) => { const t = fs.readFileSync(path.join(dir, r.file) + '.license', 'utf8'); const g = (k: string) => t.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]; return { file: r.file, licence: { spdx: r.spdx!, copyright: r.copyright!, source: (g('Source')?.split(' — ')[0] ?? 'mix') as any, how: g('Source')?.split(' — ')[1] ?? r.file, url: g('URL'), author: g('Author'), attribution: g('Attribution') } }; });
        fs.writeFileSync(path.join(dir, 'CREDITS.md'), creditsMarkdown(String(a.title ?? path.basename(dir)), entries));
        return { ok: au.missing.length === 0, tool: 'sound-credits', result: { files: au.files, missing: au.missing, credits: path.join(dir, 'CREDITS.md') }, ...(au.missing.length ? { error: `${au.missing.length} file(s) have no licence` } : {}) };
      }
      case 'sao': {
        const S = await import('./sao.ts');
        if (!a.prompt) return { ok: true, tool: 'sound-sao', result: S.saoStatus() };
        const out = res(a.out, 'sao.wav'), r = S.saoGenerate(String(a.prompt), out, { seconds: a.seconds as number, seed: a.seed as number });
        if (r.ok && r.licence) writeSidecar(out, r.licence);
        return { ...r, tool: 'sound-sao' };
      }
    }
  } catch (e: any) {
    return { ok: false, tool: `sound-${sub}`, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  }
  return { ok: false, error: 'unreachable' };
}
