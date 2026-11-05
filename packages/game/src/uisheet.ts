// The UI kit's review sheet (Decision 58): every part in the kit's own CSS, the HUD at phone size with
// pseudolocalised text, and the icons at 48 and 24 px — rendered in headless Chrome. The same page draws
// each icon into a 24×24 canvas and hands back its alpha, which the studio scores (legible, distinct).
import fs from 'node:fs';
import path from 'node:path';
import { uiCss, pseudo, type UiKit } from '../../core/src/uikit.ts';
import { STUDIO_ROOT } from './project.ts';
import { withPage } from './chrome.ts';
import { serve } from './web.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function hudHtml(ui: UiKit, k: number, text: (s: string) => string) {
  return ui.layout.map((e) => {
    const st = `left:${e.x * k}px;top:${e.y * k}px;width:${e.w * k}px;height:${e.h * k}px;font-size:${(e.part === 'bar' || e.part === 'tooltip' ? 0.85 : 1) * ui.tokens.font.size * k}px;${e.part === 'bar' || e.part === 'label' || e.part === 'tooltip' ? `line-height:${e.h * k - 6}px;` : ''}`;
    if (e.part === 'bar') return `<div class="ui-bar" style="${st}"><div class="fill" style="width:${(e.value ?? 1) * 100}%"></div><div class="text">${esc(text(e.text ?? ''))}</div></div>`;
    if (e.part === 'slot') return `<div class="ui-slot" style="${st}">${e.icon ? `<img src="icons/${e.icon}.svg" alt="">` : ''}</div>`;
    if (e.part === 'button') return `<button class="ui-button" style="${st}">${esc(text(e.text ?? ''))}</button>`;
    return `<div class="ui-${e.part}" style="${st}">${esc(text(e.text ?? ''))}</div>`;
  }).join('');
}

export function sheetHtml(ui: UiKit): string {
  const icons = Object.keys(ui.icons);
  const phone = { w: 844, h: 390 }, k = phone.h / 720;
  return `<!doctype html><meta charset="utf-8"><title>UI kit sheet</title><link rel="stylesheet" href="ui.css">
<style>body{margin:0;background:${ui.tokens.palette.bg};color:${ui.tokens.palette.ink};font:700 14px/1.3 'StudioUI',sans-serif;padding:24px;width:1232px}
h2{font-size:15px;margin:22px 0 10px;color:${ui.tokens.palette.muted};letter-spacing:.04em;text-transform:uppercase}
.row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}.cell{position:relative}.ui-root.static{position:relative;inset:auto}
.phone{position:relative;width:${phone.w}px;height:${phone.h}px;background:linear-gradient(#3a2c24,#1f1814);border-radius:28px;overflow:hidden;outline:2px solid #000}
.phone .ui-root>*{position:absolute}.notch{position:absolute;left:0;top:120px;width:34px;height:150px;background:#000;border-radius:0 18px 18px 0}
.safe{position:absolute;left:47px;right:47px;top:0;bottom:21px;outline:1px dashed #6fa3c7aa;pointer-events:none}
.ico{display:grid;grid-template-columns:repeat(${icons.length},120px);gap:10px}.ico div{background:${ui.tokens.palette.panel};border-radius:8px;padding:10px;text-align:center;font-size:12px}
.ico .big{width:48px;height:48px}.ico .small{width:24px;height:24px;margin-left:10px}.light{background:#f2ece2!important;color:#2a1d16}
</style>
<h2>Parts</h2>
<div class="row ui-root static" style="position:relative;height:150px">
  <div class="ui-panel" style="left:0;top:0;width:220px;height:120px">Panel<br><span style="color:var(--ui-muted)">muted text</span></div>
  <button class="ui-button" style="left:240px;top:0;width:150px;height:56px">Pump</button>
  <button class="ui-button" style="left:240px;top:66px;width:150px;height:56px;background:${ui.tokens.palette.muted}">Disabled</button>
  <div class="ui-bar" style="left:410px;top:0;width:260px;height:30px;line-height:24px;font-size:20px"><div class="fill" style="width:62%"></div><div class="text">Fire 62%</div></div>
  <div class="ui-slot" style="left:410px;top:44px;width:76px;height:76px"><img src="icons/${icons[0] ?? ''}.svg" alt=""></div>
  <div class="ui-slot selected" style="left:494px;top:44px;width:76px;height:76px"><img src="icons/${icons[1] ?? ''}.svg" alt=""></div>
  <div class="ui-tooltip" style="left:690px;top:0;font-size:20px;line-height:34px">Big hammer</div>
  <div class="ui-bubble" style="left:720px;top:140px;transform:translate(-50%,-100%)">Good lad. Now hold it still.</div>
  <div class="ui-card" style="left:900px;top:0;width:300px;height:130px;padding:16px"><h1 style="font-size:30px">The Fire's Dying</h1><p>press any key</p></div>
</div>
<h2>HUD on a ${phone.w}×${phone.h} phone, translated (pseudolocalised +40%) — dashed line: the safe area</h2>
<div class="row"><div class="phone"><div class="notch"></div><div class="ui-root">${hudHtml(ui, k, pseudo)}</div><div class="safe"></div></div></div>
<h2>Icons at 48 and 24 px, on dark and light</h2>
<div class="ico">${icons.map((n) => `<div><img class="big" src="icons/${n}.svg"><img class="small" src="icons/${n}.svg"><br>${esc(n)}</div>`).join('')}</div>
<div class="ico" style="margin-top:10px">${icons.map((n) => `<div class="light"><img class="big" src="icons/${n}.svg"><img class="small" src="icons/${n}.svg"></div>`).join('')}</div>
<script>
window.__masks = (async () => {
  await document.fonts.ready;
  const out = {};
  for (const n of ${JSON.stringify(icons)}) {
    const img = new Image(); img.src = 'icons/' + n + '.svg'; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data; const m = [];
    for (let i = 3; i < d.length; i += 4) m.push(+(d[i] / 255).toFixed(3));
    out[n] = m;
  }
  return out;
})();
</script>`;
}

/** Write the sheet next to the kit's CSS, font and icons, render it, and return the PNG and icon masks. */
export async function renderSheet(ui: UiKit, outDir: string): Promise<{ sheet: string; png: string; masks: Record<string, number[]> }> {
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ui.css'), uiCss(ui.tokens));
  const font = path.join(STUDIO_ROOT, 'node_modules', ui.tokens.font.file);
  if (fs.existsSync(font)) fs.copyFileSync(font, path.join(outDir, 'font.woff'));
  for (const [n, i] of Object.entries(ui.icons)) fs.writeFileSync(path.join(outDir, 'icons', `${n}.svg`), i.svg);
  const sheet = path.join(outDir, 'sheet.html');
  fs.writeFileSync(sheet, sheetHtml(ui));
  const png = path.join(outDir, 'sheet.png');
  const masks = await serve(outDir, (url) => withPage(url + 'sheet.html', { width: 1280, height: 900 }, async (page) => {
    const m = await page.eval('window.__masks', 30000);
    fs.writeFileSync(png, await page.screenshot());
    return m;
  }));
  return { sheet, png, masks };
}
