// Title cards and captions as transparent PNGs, one set per shape, drawn in headless Chrome with a canvas
// (this ffmpeg has no drawtext; Chrome has the Mac's fonts). Captions sit inside the 9:16 safe zone
// (a centred 900×1400 box on 1080×1920) and the matching lower third elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from '../../game/src/chrome.ts';
import { OUTPUT, type Aspect } from './reel.ts';

export interface Card { id: string; kind: 'title' | 'caption' | 'end'; text: string; sub?: string; credit?: string }

const DRAW = (W: number, H: number, card: Card) => `(() => {
  const W = ${W}, H = ${H}, card = ${JSON.stringify(card)};
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (px, w = 700) => w + ' ' + Math.round(px) + 'px "Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif';
  const short = Math.min(W, H), safeW = W > H ? W * 0.8 : 900 * W / 1080;
  const fit = (text, px, w) => { g.font = font(px, w); while (g.measureText(text).width > safeW && px > 12) { px *= 0.94; g.font = font(px, w); } return px; };
  const shadowText = (text, x, y, px, w, alpha = 1) => {
    g.font = font(px, w); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = px * 0.35; g.shadowOffsetY = px * 0.05;
    g.fillStyle = 'rgba(255,255,255,' + alpha + ')'; g.fillText(text, x, y); g.shadowColor = 'transparent';
  };
  if (card.kind === 'caption') {
    const px = fit(card.text, short * 0.045, 600);
    const y = W > H ? H * 0.86 : H * 0.79;
    g.font = font(px, 600);
    const tw = g.measureText(card.text).width, padX = px * 0.7, padY = px * 0.45;
    g.fillStyle = 'rgba(12,14,24,0.42)';
    const r = px * 0.4, x0 = W / 2 - tw / 2 - padX, y0 = y - px / 2 - padY, w0 = tw + padX * 2, h0 = px + padY * 2;
    g.beginPath(); g.roundRect(x0, y0, w0, h0, r); g.fill();
    shadowText(card.text, W / 2, y + px * 0.04, px, 600);
  } else {
    const y = H * (card.kind === 'end' ? 0.44 : W >= H ? 0.42 : 0.3);
    if (card.kind === 'end') { g.fillStyle = 'rgba(6,8,20,0.35)'; g.fillRect(0, 0, W, H); }
    else {
      // a soft dark band behind the title so it reads over a busy street
      const band = g.createLinearGradient(0, y - short * 0.2, 0, y + short * 0.2);
      band.addColorStop(0, 'rgba(8,10,24,0)'); band.addColorStop(0.5, 'rgba(8,10,24,0.38)'); band.addColorStop(1, 'rgba(8,10,24,0)');
      g.fillStyle = band; g.fillRect(0, y - short * 0.2, W, short * 0.4);
    }
    const px = fit(card.text, short * (card.kind === 'end' ? 0.12 : 0.11), 800);
    shadowText(card.text, W / 2, y, px, 800);
    if (card.sub) { const sp = fit(card.sub, short * 0.04, 500); shadowText(card.sub, W / 2, y + px * 0.85, sp, 500, 0.92); }
    if (card.credit) { const cp = fit(card.credit, short * (W >= H ? 0.022 : 0.03), 500); shadowText(card.credit, W / 2, H * (W > H ? 0.9 : 0.8), cp, 500, 0.85); }
  }
  return c.toDataURL('image/png');
})()`;

/** Render every card for every shape: dir/<aspect>/<id>.png (aspect as 16x9, 1x1, 9x16). */
export async function renderCards(cards: Card[], dir: string, aspects: readonly Aspect[]): Promise<Record<Aspect, Record<string, string>>> {
  const out = {} as Record<Aspect, Record<string, string>>;
  const blank = path.join(dir, 'blank.html');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blank, '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">');
  await withPage('file://' + blank, { width: 400, height: 300 }, async (page) => {
    for (const a of aspects) {
      const [W, H] = OUTPUT[a], sub = path.join(dir, a.replace(':', 'x'));
      fs.mkdirSync(sub, { recursive: true });
      out[a] = {};
      for (const c of cards) {
        const url: string = await page.eval(DRAW(W, H, c), 30000);
        const f = path.join(sub, `${c.id}.png`);
        fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
        out[a][c.id] = f;
      }
    }
  });
  return out;
}
