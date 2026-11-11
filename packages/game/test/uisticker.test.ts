// The sticker UI style: die-cut pastel stickers with white borders, a steady tilt fixed by each element's id,
// and a one-shot slap-on. The tilt and pastel picks in the web template match the studio's (the review sheet
// and the game draw the same stickers), and the font stays a token.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, STICKER_TOKENS, FORGE_TOKENS, FORGE_LAYOUT, uiCss, uiChecks, stickerTilt, stickerPastel } from '../../core/src/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the web template can't be imported in node (it is browser code), so its copies are compared as text
const TPL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../templates/web/studio/ui.ts'), 'utf8');
const CORE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../core/src/uikit.ts'), 'utf8');
const fn = (src: string, name: string) => src.match(new RegExp(`export function ${name}\\([^]*?\\n}\\n`))?.[0];

before(async () => { await initKernel(); });

test('sticker CSS: white die-cut edge, pastels, a steady tilt via rotate, one slap-on, reduced motion respected', () => {
  const css = uiCss(STICKER_TOKENS);
  assert.match(css, /--ui-edge: #ffffff/);
  for (let i = 0; i < STICKER_TOKENS.sticker!.pastels.length; i++) assert.ok(css.includes(`--ui-pastel-${i}: ${STICKER_TOKENS.sticker!.pastels[i]}`));
  assert.match(css, /rotate: var\(--ui-tilt, 0deg\)/, 'the tilt is the rotate property (composes with the bubble translate)');
  assert.match(css, /animation: ui-slap [^;]* both;/);
  assert.match(css, /@keyframes ui-slap \{[^}]*scale: 1\.35/);
  assert.ok(!/@keyframes ui-slap[^@]*rotate/.test(css), 'the slap never animates the tilt (no wobble)');
  assert.ok(!/infinite/.test(css), 'nothing loops: stickers stay steady');
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*animation: none/);
  assert.match(css, /background: var\(--ui-sticker, var\(--ui-panel\)\)/);
  assert.ok(!/ui-slap|--ui-tilt/.test(uiCss(FORGE_TOKENS)), 'other styles are untouched');
});

test('sticker tilt and pastel: fixed by id, within ±max and never level; the web template agrees with the studio', () => {
  const ids = ['score', 'heat', 'pump', 'slot-1', 'slot-2', 'tip', 'card-Hello', 'a much longer bubble line'];
  for (const id of ids) {
    const t = stickerTilt(id, 3);
    assert.equal(t, stickerTilt(id, 3), 'steady');
    assert.ok(Math.abs(t) <= 3 && Math.abs(t) >= 0.95, `${id}: ${t}`);
    assert.ok(stickerPastel(id, 5) >= 0 && stickerPastel(id, 5) < 5);
  }
  for (const name of ['stickerTilt', 'stickerPastel']) { assert.ok(fn(CORE, name)); assert.equal(fn(TPL, name), fn(CORE, name), `${name}: the template's copy = the studio's`); }
  const signs = new Set(ids.map((id) => Math.sign(stickerTilt(id, 3))));
  assert.equal(signs.size, 2, 'stickers lean both ways');
  assert.equal(new Set(ids.map((id) => stickerPastel(id, 5))).size > 1, true, 'more than one pastel');
});

test('ui-kit --preset sticker: passes contrast on every pastel, and the font is configurable', () => {
  const kit = { tokens: STICKER_TOKENS, layout: FORGE_LAYOUT, icons: {}, profile: 'desktop' as const };
  const c = uiChecks(kit).find((x) => x.id === 'ui-contrast')!;
  assert.ok(c.pass, c.detail);
  assert.match(c.detail, /sticker/);
  const s = new Studio();
  const r = s.call('ui-kit', { preset: 'sticker', tokens: { font: { family: 'Comic Neue', file: 'fonts/comic-neue-700.woff' } } });
  assert.ok(r.ok, r.error);
  const t = (s.doc() as any).ui.tokens;
  assert.equal(t.border.style, 'sticker');
  assert.equal(t.font.family, 'Comic Neue');
  assert.equal(t.font.size, STICKER_TOKENS.font.size, 'a partial font token merges');
  // a low-contrast pastel is caught
  const bad = { ...kit, tokens: { ...STICKER_TOKENS, sticker: { ...STICKER_TOKENS.sticker!, pastels: ['#3a3040'] } } };
  assert.equal(uiChecks(bad).find((x) => x.id === 'ui-contrast')!.pass, false);
});
