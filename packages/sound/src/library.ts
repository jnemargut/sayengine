// CC0 recordings (Decision 33's library layer), fetched once and cached in ~/.studio-tools/sound-library
// with their licence. The catalogue lists only works whose page says CC0; each entry keeps the page URL,
// the author and the exact file, so credits can name them even though CC0 doesn't require it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Licence } from './ledger.ts';

export interface LibraryEntry { id: string; title: string; author: string; page: string; file: string; spdx: 'CC0-1.0'; tags: string[]; note?: string }
export const CATALOGUE: LibraryEntry[] = [
  { id: 'fire-crackling', title: 'Fire Crackling', author: 'AntumDeluge', page: 'https://opengameart.org/content/fire-crackling', file: 'https://opengameart.org/sites/default/files/fire-1.wav', spdx: 'CC0-1.0', tags: ['fire', 'crackle', 'forge', 'campfire'] },
  { id: 'fireplace-loop', title: 'Fireplace Sound loop', author: 'PagDev', page: 'https://opengameart.org/content/fireplace-sound-loop', file: 'https://opengameart.org/sites/default/files/fire.wav', spdx: 'CC0-1.0', tags: ['fire', 'fireplace', 'loop'] },
  { id: 'hammer-on-anvil', title: 'Hammer on Anvil', author: 'themightyglider', page: 'https://opengameart.org/content/hammer-on-anvil', file: 'https://opengameart.org/sites/default/files/forger.ogg', spdx: 'CC0-1.0', tags: ['anvil', 'hammer', 'metal', 'forge', 'smith'] },
  { id: 'blacksmith-hammer', title: "Blacksmith's Hammer", author: 'VishwaJai', page: 'https://opengameart.org/content/blacksmiths-hammer', file: 'https://opengameart.org/sites/default/files/blacksmithhammer.wav', spdx: 'CC0-1.0', tags: ['anvil', 'hammer', 'metal', 'smith'] },
  { id: 'park-wind', title: 'Park ambiences (wind)', author: 'Thimras', page: 'https://opengameart.org/content/park-ambiences', file: 'https://opengameart.org/sites/default/files/park_ambience_wind.wav', spdx: 'CC0-1.0', tags: ['wind', 'outdoor', 'ambience', 'park'] },
  { id: 'park-birds', title: 'Park ambiences (birds)', author: 'Thimras', page: 'https://opengameart.org/content/park-ambiences', file: 'https://opengameart.org/sites/default/files/park_ambience_birds.wav', spdx: 'CC0-1.0', tags: ['birds', 'outdoor', 'ambience', 'park', 'day'] },
  { id: 'city-traffic', title: 'High traffic road sounds', author: 'IgnasD', page: 'https://opengameart.org/content/high-traffic-road-sounds', file: 'https://opengameart.org/sites/default/files/gatve%20Varniu_3.ogg', spdx: 'CC0-1.0', tags: ['traffic', 'city', 'street', 'cars', 'ambience'] },
  { id: 'mild-wind', title: 'Mild Wind Background Noise', author: 'Bashar3A', page: 'https://opengameart.org/content/mild-wind-background-noise', file: 'https://opengameart.org/sites/default/files/wind%20background%20noise%202.wav', spdx: 'CC0-1.0', tags: ['wind', 'ambience', 'bed'] },
];

export const libraryDir = () => process.env.STUDIO_SOUND_LIBRARY ?? path.join(os.homedir(), '.studio-tools', 'sound-library');

export function search(words: string): LibraryEntry[] {
  const w = words.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return CATALOGUE.map((e) => ({ e, s: w.filter((x) => e.tags.includes(x) || e.title.toLowerCase().includes(x) || e.id.includes(x)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e);
}

export function licenceOf(e: LibraryEntry): Licence {
  return { spdx: e.spdx, copyright: `${e.author} (dedicated to the public domain)`, source: 'library', how: `OpenGameArt: ${e.title}`, url: e.page, author: e.author };
}

/** The cached copy (44.1 kHz WAV), fetching and converting it once. */
export async function fetchEntry(id: string): Promise<{ wav: string; entry: LibraryEntry; cached: boolean }> {
  const e = CATALOGUE.find((x) => x.id === id);
  if (!e) throw new Error(`no library sound "${id}" (have: ${CATALOGUE.map((x) => x.id).join(', ')})`);
  const dir = path.join(libraryDir(), e.id), wav = path.join(dir, `${e.id}.wav`);
  if (fs.existsSync(wav)) return { wav, entry: e, cached: true };
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(e.file);
  if (!res.ok) throw Object.assign(new Error(`${e.id}: download failed (${res.status})`), { hint: `the page is ${e.page}` });
  const orig = path.join(dir, decodeURIComponent(path.basename(e.file)));
  fs.writeFileSync(orig, Buffer.from(await res.arrayBuffer()));
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', orig, '-ar', '44100', '-c:a', 'pcm_s16le', wav], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${e.id}: ffmpeg could not convert ${path.basename(orig)}: ${r.stderr}`);
  fs.writeFileSync(path.join(dir, 'licence.json'), JSON.stringify({ ...e, fetched: new Date().toISOString(), original: path.basename(orig) }, null, 2));
  return { wav, entry: e, cached: false };
}
