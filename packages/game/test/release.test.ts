// `studio game release`: icons and a share card from generated images, the OG/Twitter tags with absolute URLs,
// and the release check (share tags, private words, local references), on a fresh web game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGame, type GameContext } from '../src/index.ts';
import { encodePng, decodePng } from '../../core/src/look/png.ts';
import { icoSizes, imageSize, resize, cropSquare, injectTags, shareTags, releaseCheck, smallSizeContrast } from '../src/release.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-'));
/** a still: a warm gradient with a dark disc off-centre (not square, so it gets cropped) */
function still(w: number, h: number, busy = false): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, d = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.3;
    const n = busy ? ((x * 7 + y * 13) % 5) * 4 : 0;
    px[i] = d ? 40 + n : 240 - n; px[i + 1] = d ? 30 + n : 180 - (y / h) * 60; px[i + 2] = d ? 60 : 90 + n; px[i + 3] = 255;
  }
  return encodePng(px, w, h);
}

test('image helpers: crop to a square, area resize, PNG and JPEG sizes from headers', () => {
  const img = decodePng(still(64, 40));
  const sq = cropSquare(img);
  assert.deepEqual([sq.width, sq.height], [40, 40]);
  const r = resize(sq, 16, 16);
  assert.equal(r.rgba.length, 16 * 16 * 4);
  assert.ok(r.rgba[(8 * 16 + 8) * 4] < 80, 'the dark disc survives at 16 px');
  assert.ok(smallSizeContrast(r) > 0.3);
  assert.deepEqual(imageSize(still(1200, 630)), { width: 1200, height: 630, type: 'png' });
  // a minimal JPEG header: SOI, APP0, SOF0 (630 × 1200)
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x76, 0x04, 0xb0, 3, 1, 0x22, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1200, height: 630, type: 'jpeg' });
});

test('tags: absolute URLs on the site, replaced (not duplicated) when run again', () => {
  const html = '<html><head>\n  <title>t</title>\n  <link rel="icon" href="data:,">\n</head><body></body></html>';
  const block = shareTags({ site: 'https://example.dev/my-game', title: 'My "Game"', description: 'Play it.', card: 'og-image.png' });
  assert.match(block, /og:image" content="https:\/\/example\.dev\/my-game\/og-image\.png"/);
  assert.match(block, /og:url" content="https:\/\/example\.dev\/my-game\/"/);
  assert.match(block, /My &quot;Game&quot;/);
  const once = injectTags(html, block), twice = injectTags(once, block);
  assert.equal(twice, once);
  assert.equal((twice.match(/og:title/g) ?? []).length, 1);
  assert.ok(!twice.includes('href="data:,"'), 'the template\'s empty icon goes');
  assert.throws(() => shareTags({ site: 'ftp://x', title: 'a', description: 'b' }), /http/);
});

test('game release: icons, manifest, card and tags from generated images; the release check passes, then catches problems', async () => {
  const studioDir = tmp();
  const ctx: GameContext = { studioDir } as any;
  const init = await runGame('game-init', { name: 'rel', engine: 'web' }, ctx);
  assert.ok(init.ok, init.error);
  const art = path.join(studioDir, 'art');
  fs.mkdirSync(art);
  fs.writeFileSync(path.join(art, 'still.png'), still(720, 540));
  fs.writeFileSync(path.join(art, 'card.png'), still(1200, 630));
  fs.writeFileSync(path.join(art, 'wrong.png'), still(1000, 630));
  const dir = path.join(studioDir, 'games', 'rel');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'game.js'), 'console.log("hi");\n');

  const r = await runGame('game-release', { project: 'rel', icon: 'art/still.png', card: 'art/card.png', site: 'https://rel.example.dev/', title: 'Rel', description: 'A small game.', cardAlt: 'the title card' }, ctx);
  assert.ok(r.ok, JSON.stringify(r.failures ?? r.error));
  assert.equal(r.result.check.share.tags, 14);
  assert.ok(r.result.notes.some((n: string) => /centre-cropped/.test(n)));
  assert.deepEqual(icoSizes(new Uint8Array(fs.readFileSync(path.join(dir, 'favicon.ico')))), [16, 32, 48]);
  for (const [f, n] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]] as const) assert.deepEqual(imageSize(new Uint8Array(fs.readFileSync(path.join(dir, f)))), { width: n, height: n, type: 'png' });
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'site.webmanifest'), 'utf8'));
  assert.deepEqual(man.icons.map((i: any) => i.sizes), ['192x192', '512x512']);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<meta property="og:image" content="https:\/\/rel\.example\.dev\/og-image\.png">/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon.png">/);

  // run again: one block, still passing
  const again = await runGame('game-release', { project: 'rel', site: 'https://rel.example.dev/', title: 'Rel', description: 'A small game.' }, ctx);
  assert.ok(again.ok, JSON.stringify(again.failures));
  assert.equal((fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/og:title/g) ?? []).length, 1);

  // private words, a local path, a wrong-size card and a relative og:image are caught
  fs.writeFileSync(path.join(dir, 'credits.txt'), 'Thanks to the Mood Board crew.\n');
  fs.writeFileSync(path.join(dir, 'dist', 'game.js'), 'fetch("references/look-01.jpg"); const dev = "http://localhost:5173/";\n');
  const bad = await runGame('game-release', { project: 'rel', check: true, site: 'https://rel.example.dev/' }, ctx);
  assert.equal(bad.ok, false);
  const f = bad.failures.join('\n');
  assert.match(f, /mentions "mood board": credits\.txt/);
  assert.match(f, /mentions "references\/": dist\/game\.js/);
  assert.match(f, /local reference: localhost:5173/);
  const custom = releaseCheck(dir, { privateWords: ['crew'] });
  assert.ok(custom.fails.some((x) => /"crew"/.test(x)) && !custom.fails.some((x) => /mood board/.test(x)), 'the word list is configurable');
  fs.rmSync(path.join(dir, 'credits.txt')); fs.writeFileSync(path.join(dir, 'dist', 'game.js'), 'console.log(1);\n');
  const wrong = await runGame('game-release', { project: 'rel', card: 'art/wrong.png', site: 'https://rel.example.dev/', title: 'Rel', description: 'A small game.' }, ctx);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.failures.some((x: string) => /1000×630, not 1200×630/.test(x)), wrong.failures.join('\n'));
  fs.writeFileSync(path.join(art, 'card.png'), still(1200, 630));
  await runGame('game-release', { project: 'rel', card: 'art/card.png', site: 'https://rel.example.dev/', title: 'Rel', description: 'A small game.' }, ctx);
  fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('content="https://rel.example.dev/og-image.png"', 'content="og-image.png"'));
  const rel = releaseCheck(dir, { site: 'https://rel.example.dev/' });
  assert.ok(rel.fails.some((x) => /og:image is not an absolute URL/.test(x)), rel.fails.join('\n'));
  fs.rmSync(studioDir, { recursive: true, force: true });
});
