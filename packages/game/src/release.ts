// `studio game release`: make a web game ready to share. From one square image (or any still, centre-cropped)
// it writes favicon.ico (16/32/48), apple-touch-icon.png (180), icon-192.png, icon-512.png and site.webmanifest;
// from a 1200×630 card it writes og-image.*; and it puts the icon links and the Open Graph / Twitter tags (with
// absolute URLs on the given site) into index.html between managed markers, so running it again replaces them.
// Then the release check: the share tags are complete and absolute, every linked file ships, the card is
// 1200×630, nothing shipped mentions a private word (default: "mood board", "references/"), no file is too big
// for a static host, and the code holds no local paths or dev-server addresses.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, type Image } from '../../core/src/look/png.ts';

export const ICO_SIZES = [16, 32, 48];
export const ICON_FILES = { appleTouch: { file: 'apple-touch-icon.png', size: 180 }, small: { file: 'icon-192.png', size: 192 }, large: { file: 'icon-512.png', size: 512 } };
export const DEFAULT_PRIVATE_WORDS = ['mood board', 'references/'];
export const CARD = { width: 1200, height: 630, maxBytes: 5 * 1024 * 1024, softBytes: 1024 * 1024 };
const BEGIN = '<!-- studio:release (managed by studio game release) -->', END = '<!-- /studio:release -->';

// ── images ────────────────────────────────────────────────────────────────
/** The largest centred square of an image. */
export function cropSquare(img: Image): Image {
  const s = Math.min(img.width, img.height), x0 = Math.floor((img.width - s) / 2), y0 = Math.floor((img.height - s) / 2);
  const rgba = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) rgba.set(img.rgba.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + s) * 4), y * s * 4);
  return { width: s, height: s, rgba };
}

/** Area-average resize (each output pixel averages the source pixels it covers; alpha-weighted colour). */
export function resize(img: Image, w: number, h: number): Image {
  const out = new Uint8Array(w * h * 4), sx = img.width / w, sy = img.height / h;
  for (let oy = 0; oy < h; oy++) for (let ox = 0; ox < w; ox++) {
    const x0 = ox * sx, x1 = x0 + sx, y0 = oy * sy, y1 = y0 + sy;
    let r = 0, g = 0, b = 0, a = 0, wsum = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      if (wy <= 0) continue;
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const wx = Math.min(x + 1, x1) - Math.max(x, x0);
        if (wx <= 0) continue;
        const i = (Math.min(img.height - 1, y) * img.width + Math.min(img.width - 1, x)) * 4, wgt = wx * wy, al = img.rgba[i + 3] / 255;
        r += img.rgba[i] * al * wgt; g += img.rgba[i + 1] * al * wgt; b += img.rgba[i + 2] * al * wgt; a += al * wgt; wsum += wgt;
      }
    }
    const o = (oy * w + ox) * 4;
    out[o] = a > 0 ? Math.round(r / a) : 0; out[o + 1] = a > 0 ? Math.round(g / a) : 0; out[o + 2] = a > 0 ? Math.round(b / a) : 0; out[o + 3] = Math.round((a / wsum) * 255);
  }
  return { width: w, height: h, rgba: out };
}

/** An .ico holding PNG images (every current browser and OS reads PNG-in-ICO). */
export function encodeIco(pngs: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const head = 6 + 16 * pngs.length, total = head + pngs.reduce((n, p) => n + p.png.length, 0);
  const buf = new Uint8Array(total), dv = new DataView(buf.buffer);
  dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, pngs.length, true);
  let off = head;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i;
    buf[e] = p.size >= 256 ? 0 : p.size; buf[e + 1] = p.size >= 256 ? 0 : p.size; buf[e + 2] = 0; buf[e + 3] = 0;
    dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true); dv.setUint32(e + 8, p.png.length, true); dv.setUint32(e + 12, off, true);
    buf.set(p.png, off); off += p.png.length;
  });
  return buf;
}
/** The sizes inside an .ico (for checks). */
export function icoSizes(buf: Uint8Array): number[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== 0 || dv.getUint16(2, true) !== 1) return [];
  return Array.from({ length: dv.getUint16(4, true) }, (_, i) => buf[6 + 16 * i] || 256);
}

/** Width and height of a PNG or JPEG (from its header), or null. */
export function imageSize(buf: Uint8Array): { width: number; height: number; type: 'png' | 'jpeg' } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'png' };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7), type: 'jpeg' };
    i += 2 + dv.getUint16(i + 2);
  }
  return null;
}

/** How much an icon keeps at 16 px: the spread of luminance (0..1). A busy render that turns to mush scores low. */
export function smallSizeContrast(img: Image): number {
  const l: number[] = [];
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3] > 128) l.push((0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]) / 255);
  if (l.length < 4) return 0;
  l.sort((a, b) => a - b);
  return l[Math.floor(l.length * 0.95)] - l[Math.floor(l.length * 0.05)];
}

// ── tags ──────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export interface ShareInfo { site: string; title: string; description: string; card?: string; cardAlt?: string; siteName?: string; icons?: boolean }
/** The site URL as a base: https, ending in a slash. */
export function siteBase(site: string): string {
  const u = new URL(site);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`--site must be an http(s) URL: ${site}`);
  return u.href.endsWith('/') ? u.href : u.href + '/';
}
/** The managed block of icon links and share tags (absolute URLs on the site). */
export function shareTags(s: ShareInfo): string {
  const base = siteBase(s.site), abs = (f: string) => new URL(f, base).href;
  const rows: string[] = [];
  if (s.icons !== false) rows.push(
    '<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48">', `<link rel="icon" type="image/png" sizes="192x192" href="${ICON_FILES.small.file}">`,
    `<link rel="apple-touch-icon" href="${ICON_FILES.appleTouch.file}">`, '<link rel="manifest" href="site.webmanifest">');
  rows.push(`<meta name="description" content="${esc(s.description)}">`,
    '<meta property="og:type" content="website">', `<meta property="og:site_name" content="${esc(s.siteName ?? s.title)}">`,
    `<meta property="og:title" content="${esc(s.title)}">`, `<meta property="og:description" content="${esc(s.description)}">`, `<meta property="og:url" content="${base}">`);
  if (s.card) {
    const alt = esc(s.cardAlt ?? s.title);
    rows.push(`<meta property="og:image" content="${abs(s.card)}">`, `<meta property="og:image:width" content="${CARD.width}">`, `<meta property="og:image:height" content="${CARD.height}">`,
      `<meta property="og:image:alt" content="${alt}">`, '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:image" content="${abs(s.card)}">`, `<meta name="twitter:image:alt" content="${alt}">`);
  } else rows.push('<meta name="twitter:card" content="summary">');
  rows.push(`<meta name="twitter:title" content="${esc(s.title)}">`, `<meta name="twitter:description" content="${esc(s.description)}">`);
  return `${BEGIN}\n  ${rows.join('\n  ')}\n  ${END}`;
}
/** Put the block into the page's <head>, replacing an earlier one and the template's empty icon. */
export function injectTags(html: string, block: string): string {
  let h = html.replace(new RegExp(`\\s*${BEGIN.replace(/[()]/g, '\\$&')}[^]*?${END}`), '');
  h = h.replace(/\s*<link rel="icon" href="data:,">/, '');
  if (!/<\/head>/i.test(h)) throw new Error('index.html has no </head>');
  return h.replace(/\n?(\s*)<\/head>/i, (_, ind) => `\n  ${block}\n${ind}</head>`);
}

// ── release ───────────────────────────────────────────────────────────────
export interface ReleaseOptions extends Partial<ShareInfo> {
  /** a PNG: a square icon, or a still to centre-crop */
  icon?: string;
  /** the share card: a 1200×630 PNG or JPEG */
  card?: string;
  /** words nothing shipped may contain (case-insensitive) */
  privateWords?: string[];
  /** only check, write nothing */
  checkOnly?: boolean;
}

export function release(dir: string, o: ReleaseOptions): { written: string[]; notes: string[]; check: ReleaseCheck } {
  const written: string[] = [], notes: string[] = [];
  const put = (name: string, data: Uint8Array | string) => { fs.writeFileSync(path.join(dir, name), data); written.push(name); };
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) throw Object.assign(new Error(`no index.html in ${dir}`), { hint: 'pass --dir with the folder you ship' });
  let cardName: string | undefined;
  if (!o.checkOnly) {
    if (o.icon) {
      const src = new Uint8Array(fs.readFileSync(o.icon));
      let img: Image;
      try { img = decodePng(src); } catch (e: any) { throw Object.assign(new Error(`--icon must be a PNG (8-bit RGB or RGBA): ${e.message}`), { hint: 'export the still or icon as PNG' }); }
      if (img.width !== img.height) notes.push(`the icon image is ${img.width}×${img.height}; centre-cropped to a square`);
      const sq = cropSquare(img);
      if (sq.width < 512) notes.push(`the icon source is ${sq.width} px; 512 px or more keeps the large icons sharp`);
      const at = (n: number) => resize(sq, n, n);
      const small = ICO_SIZES.map((size) => ({ size, png: encodePng(at(size).rgba, size, size) }));
      put('favicon.ico', encodeIco(small));
      for (const f of Object.values(ICON_FILES)) put(f.file, encodePng(at(f.size).rgba, f.size, f.size));
      const c16 = smallSizeContrast(at(16));
      if (c16 < 0.25) notes.push(`at 16 px the icon keeps little contrast (${c16.toFixed(2)}): a render often turns to mush that small; draw a simpler mark for the small sizes`);
      const title = o.title ?? 'Game';
      put('site.webmanifest', JSON.stringify({
        name: title, short_name: title.length > 12 ? title.slice(0, 12).trim() : title, start_url: '.', display: 'fullscreen',
        background_color: '#000000', theme_color: '#000000',
        icons: [{ src: ICON_FILES.small.file, sizes: '192x192', type: 'image/png' }, { src: ICON_FILES.large.file, sizes: '512x512', type: 'image/png', purpose: 'any' }],
      }, null, 2) + '\n');
    }
    if (o.card) {
      const b = new Uint8Array(fs.readFileSync(o.card)), sz = imageSize(b);
      if (!sz) throw new Error(`--card must be a PNG or JPEG: ${o.card}`);
      cardName = `og-image.${sz.type === 'png' ? 'png' : 'jpg'}`;
      for (const old of ['og-image.png', 'og-image.jpg']) if (old !== cardName) fs.rmSync(path.join(dir, old), { force: true });
      put(cardName, b);
    } else cardName = ['og-image.jpg', 'og-image.png'].find((f) => fs.existsSync(path.join(dir, f)));
    if (o.site) {
      if (!o.title || !o.description) throw Object.assign(new Error('--title and --description are needed for the share tags'), { hint: 'studio game release --site https://… --title "…" --description "…"' });
      const html = fs.readFileSync(index, 'utf8');
      const icons = fs.existsSync(path.join(dir, 'favicon.ico'));
      fs.writeFileSync(index, injectTags(html, shareTags({ site: o.site, title: o.title, description: o.description, card: cardName, cardAlt: o.cardAlt, siteName: o.siteName, icons })));
      written.push('index.html');
    }
  }
  return { written, notes, check: releaseCheck(dir, { site: o.site, privateWords: o.privateWords }) };
}

// ── the release check ─────────────────────────────────────────────────────
export interface ReleaseCheck { pass: boolean; fails: string[]; share: { pass: boolean; fails: string[]; tags: number }; files: number; bytes: number }
const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.webmanifest', '.svg', '.xml', '.csv', '']);
const SKIP = new Set(['node_modules', '.git', '.godot', '.import']);
function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => SKIP.has(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
}
export const SHARE_TAGS = ['og:title', 'og:description', 'og:type', 'og:url', 'og:site_name', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt',
  'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];

/** The share-tag check: complete Open Graph + Twitter tags, absolute URLs on the site, a 1200×630 card that ships, icons that ship. */
export function shareCheck(dir: string, site?: string): ReleaseCheck['share'] {
  const fails: string[] = [];
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) meta[m[1]] = m[2];
  for (const k of SHARE_TAGS) if (!meta[k]) fails.push(`missing ${k}`);
  const base = site ? siteBase(site) : meta['og:url'];
  for (const k of ['og:url', 'og:image', 'twitter:image']) {
    const v = meta[k];
    if (!v) continue;
    if (!/^https?:\/\//.test(v)) fails.push(`${k} is not an absolute URL: ${v}`);
    else if (base && !v.startsWith(base)) fails.push(`${k} is not on ${base}: ${v}`);
  }
  if (meta['twitter:card'] && meta['twitter:card'] !== 'summary_large_image') fails.push('twitter:card is not summary_large_image');
  if (meta['og:image:width'] && (meta['og:image:width'] !== String(CARD.width) || meta['og:image:height'] !== String(CARD.height))) fails.push(`og:image size tags are not ${CARD.width}×${CARD.height}`);
  if (meta['og:image'] && base && meta['og:image'].startsWith(base)) {
    const f = path.join(dir, decodeURIComponent(meta['og:image'].slice(base.length)));
    if (!fs.existsSync(f)) fails.push(`the card the tags point at does not ship: ${path.relative(dir, f)}`);
    else {
      const b = new Uint8Array(fs.readFileSync(f)), sz = imageSize(b);
      if (!sz) fails.push('the card is not a PNG or JPEG');
      else if (sz.width !== CARD.width || sz.height !== CARD.height) fails.push(`the card is ${sz.width}×${sz.height}, not ${CARD.width}×${CARD.height}`);
      if (b.length > CARD.maxBytes) fails.push(`the card is ${(b.length / 1048576).toFixed(1)} MB (share previews drop cards over 5 MB)`);
    }
  }
  const links = [...html.matchAll(/<link\s+[^>]*>/g)].map((m) => ({ rel: m[0].match(/rel="([^"]+)"/)?.[1] ?? '', href: m[0].match(/href="([^"]+)"/)?.[1] ?? '' }));
  for (const r of ['icon', 'apple-touch-icon', 'manifest']) if (!links.some((l) => l.rel === r)) fails.push(`no <link rel="${r}">`);
  for (const l of links) if (l.href && !/^(https?:|data:|\/\/)/.test(l.href) && !fs.existsSync(path.join(dir, l.href.replace(/^\//, '').split(/[?#]/)[0]))) fails.push(`the page links a file that does not ship: ${l.href}`);
  const man = links.find((l) => l.rel === 'manifest')?.href;
  if (man && !/^https?:/.test(man) && fs.existsSync(path.join(dir, man))) {
    try { for (const ic of JSON.parse(fs.readFileSync(path.join(dir, man), 'utf8')).icons ?? []) if (!fs.existsSync(path.join(dir, path.dirname(man), ic.src.replace(/^\//, '')))) fails.push(`a manifest icon does not ship: ${ic.src}`); }
    catch (e: any) { fails.push(`the manifest does not parse: ${e.message}`); }
  }
  if (fs.existsSync(path.join(dir, 'favicon.ico'))) { const s = icoSizes(new Uint8Array(fs.readFileSync(path.join(dir, 'favicon.ico')))); for (const n of ICO_SIZES) if (!s.includes(n)) fails.push(`favicon.ico has no ${n}×${n}`); }
  return { pass: !fails.length, fails, tags: SHARE_TAGS.filter((k) => meta[k]).length };
}

/** Everything that must hold before a web game goes to a static host. */
export function releaseCheck(dir: string, o: { site?: string; privateWords?: string[] } = {}): ReleaseCheck {
  const fails: string[] = [];
  const files = walk(dir);
  let bytes = 0;
  const words = (o.privateWords ?? DEFAULT_PRIVATE_WORDS).map((w) => w.toLowerCase()).filter(Boolean);
  for (const f of files) {
    const rel = path.relative(dir, f).split(path.sep).join('/'), size = fs.statSync(f).size;
    bytes += size;
    if (size > 25 * 1024 * 1024) fails.push(`over 25 MiB (too big for most static hosts): ${rel}`);
    if (!TEXT.has(path.extname(f).toLowerCase()) && path.basename(f) !== '_headers') continue;
    if (size > 32 * 1024 * 1024) continue;
    const t = fs.readFileSync(f, 'utf8'), low = t.toLowerCase();
    for (const w of words) if (low.includes(w)) fails.push(`a shipped file mentions "${w}": ${rel}`);
    if (/\.(m?js|html?)$/.test(rel)) for (const bad of [/\/Users\/[A-Za-z]/, /\/home\/[a-z][\w-]*\//, /[A-Z]:\\\\Users\\\\/, /(?:localhost|127\.0\.0\.1):\d{2,5}/]) { const m = t.match(bad); if (m) fails.push(`${rel} has a local reference: ${m[0]}`); }
  }
  if (files.length >= 20000) fails.push(`too many files for most static hosts: ${files.length}`);
  const share = shareCheck(dir, o.site);
  for (const f of share.fails) fails.push(`share: ${f}`);
  return { pass: !fails.length, fails, share, files: files.length, bytes };
}
