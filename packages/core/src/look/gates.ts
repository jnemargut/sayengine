// The look's measured targets (Decision 29): numbers first, then the human (or Claude) picks A/B.
// - colourfulness: Hasler & Süsstrunk's M (2003), so "not too saturated" is a range;
// - palette match: how much of the picture sits near the look's palette (or near the references');
// - style score: a small local model (DINOv2-small) compares a render with the reference pictures
//   (style.py, run with ~/.studio-tools/venv; optional — the gates report "not measured" without it).
// Claude never scores a look out of 10; it only picks A or B (Decision 29).
import { deltaE, hexToRgb, srgbToLab, type RGB } from './color.ts';
import type { Image } from './png.ts';
import type { Board } from './look.ts';

/** Hasler–Süsstrunk colourfulness M (0 grey … ~110 extreme). ~15 slightly, ~33 moderately, ~45 averagely, ~59 quite, ~82 highly colourful. */
export function colourfulness(img: Image, step = 2): number {
  let n = 0, mrg = 0, myb = 0, srg = 0, syb = 0;
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const p = (y * img.width + x) * 4, R = img.rgba[p], G = img.rgba[p + 1], B = img.rgba[p + 2];
    const rg = R - G, yb = 0.5 * (R + G) - B;
    n++; mrg += rg; myb += yb; srg += rg * rg; syb += yb * yb;
  }
  mrg /= n; myb /= n;
  const vrg = srg / n - mrg * mrg, vyb = syb / n - myb * myb;
  return Math.sqrt(Math.max(0, vrg) + Math.max(0, vyb)) + 0.3 * Math.hypot(mrg, myb);
}

export interface PaletteEntry { lab: RGB; rgb: RGB; share: number }
/** The picture's dominant colours: k-means in CIELAB on a sparse grid (deterministic seeds). */
export function dominantColours(img: Image, k = 8, samples = 6000): PaletteEntry[] {
  const pts: RGB[] = [], rgbs: RGB[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / samples)));
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const p = (y * img.width + x) * 4;
    const c: RGB = [img.rgba[p] / 255, img.rgba[p + 1] / 255, img.rgba[p + 2] / 255];
    rgbs.push(c); pts.push(srgbToLab(c));
  }
  // seeds: k-means++ with a fixed walk (farthest point), so the same picture gives the same palette
  const cent: RGB[] = [pts[Math.floor(pts.length / 2)]];
  while (cent.length < k) {
    let best = 0, bd = -1;
    for (let i = 0; i < pts.length; i += 3) { const d = Math.min(...cent.map((c) => deltaE(c, pts[i]))); if (d > bd) { bd = d; best = i; } }
    cent.push(pts[best]);
  }
  const lab = new Array(pts.length).fill(0);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < pts.length; i++) { let b = 0, bd = Infinity; for (let j = 0; j < cent.length; j++) { const d = deltaE(cent[j], pts[i]); if (d < bd) { bd = d; b = j; } } lab[i] = b; }
    for (let j = 0; j < cent.length; j++) {
      const m: RGB = [0, 0, 0]; let c = 0;
      for (let i = 0; i < pts.length; i++) if (lab[i] === j) { m[0] += pts[i][0]; m[1] += pts[i][1]; m[2] += pts[i][2]; c++; }
      if (c) cent[j] = [m[0] / c, m[1] / c, m[2] / c];
    }
  }
  return cent.map((c, j) => {
    let n = 0; const r: RGB = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) if (lab[i] === j) { n++; r[0] += rgbs[i][0]; r[1] += rgbs[i][1]; r[2] += rgbs[i][2]; }
    return { lab: c, rgb: (n ? [r[0] / n, r[1] / n, r[2] / n] : [0, 0, 0]) as RGB, share: n / pts.length };
  }).filter((e) => e.share > 0).sort((a, b) => b.share - a.share);
}

/** Palette match 0..1: the share-weighted closeness (ΔE76, 0 at ≥ 40) of the picture's colours to a palette. */
export function paletteMatch(img: Image | PaletteEntry[], palette: string[]): number {
  if (!palette.length) return NaN;
  const doms = Array.isArray(img) ? img : dominantColours(img);
  const pal = palette.map((h) => srgbToLab(hexToRgb(h)));
  return doms.reduce((s, d) => s + d.share * Math.max(0, 1 - Math.min(...pal.map((p) => deltaE(p, d.lab))) / 40), 0);
}

/** Palette match against reference pictures: symmetric, share-weighted nearest distances between the two palettes. */
export function paletteMatchImages(a: PaletteEntry[], b: PaletteEntry[]): number {
  const one = (x: PaletteEntry[], y: PaletteEntry[]) => x.reduce((s, d) => s + d.share * Math.max(0, 1 - Math.min(...y.map((e) => deltaE(e.lab, d.lab))) / 40), 0);
  return (one(a, b) + one(b, a)) / 2;
}

export interface GateResult { name: string; value: number | null; target: string; pass: boolean | null; detail?: string }
/** Score one render against a look's board. `style` is the local model's score when it ran. */
export function boardGates(img: Image, board: Board | undefined, palette: Record<string, string>, refs: Image[] = [], style?: number | null): GateResult[] {
  const out: GateResult[] = [];
  const M = colourfulness(img);
  const range = board?.colourfulness;
  out.push({ name: 'colourfulness', value: +M.toFixed(1), target: range ? `${range[0]}–${range[1]}` : 'no range set', pass: range ? M >= range[0] && M <= range[1] : null, detail: M < 15 ? 'barely colourful' : M < 33 ? 'slightly colourful' : M < 45 ? 'moderately colourful' : M < 59 ? 'averagely colourful' : M < 82 ? 'quite colourful' : 'highly colourful' });
  const doms = dominantColours(img);
  const pm = refs.length ? refs.map((r) => paletteMatchImages(doms, dominantColours(r))).reduce((s, v) => s + v, 0) / refs.length : paletteMatch(doms, Object.values(palette));
  const min = board?.paletteMatch;
  out.push({ name: 'palette match', value: Number.isNaN(pm) ? null : +pm.toFixed(3), target: min !== undefined ? `≥ ${min}${refs.length ? ' (vs references)' : ' (vs the look palette)'}` : 'no minimum set', pass: Number.isNaN(pm) || min === undefined ? null : pm >= min });
  out.push({ name: 'style score', value: style ?? null, target: board?.styleMin !== undefined ? `≥ ${board.styleMin}` : 'no minimum set', pass: style == null || board?.styleMin === undefined ? null : style >= board.styleMin, ...(style == null ? { detail: refs.length ? 'not measured (style model not installed)' : 'no reference pictures' } : {}) });
  return out;
}
