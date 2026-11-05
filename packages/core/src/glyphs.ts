// Text outlines for the print `text` op (Decision 46): a font's glyph outlines, flattened into
// polygons in metres, ready for an extrude. The font is loaded by whoever hosts the kernel
// (the daemon reads Roboto Bold, OFL-1.1, from @fontsource/roboto) via setFontLoader, so the
// core stays free of the filesystem.
import * as opentype from 'opentype.js';

type Font = any;
let fontBytes: (() => ArrayBuffer) | null = null;
let font: Font | null = null;

/** Give the kernel a way to read the font file (an ArrayBuffer of a .woff/.ttf/.otf). */
export function setFontLoader(fn: (() => ArrayBuffer) | null) { fontBytes = fn; font = null; }

/** In Node: Roboto Bold from @fontsource/roboto (OFL-1.1), read synchronously. */
function nodeFont(): ArrayBuffer | null {
  const proc: any = (globalThis as any).process;
  const fs = proc?.getBuiltinModule?.('node:fs');
  const url = proc?.getBuiltinModule?.('node:url');
  if (!fs || !url) return null;
  try {
    const file = url.fileURLToPath(import.meta.resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff'));
    const b: Uint8Array = fs.readFileSync(file);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  } catch { return null; }
}

function getFont(): Font {
  if (font) return font;
  if (!fontBytes) {
    const b = nodeFont();
    if (b) fontBytes = () => b;
  }
  if (!fontBytes) throw new Error('no font available for text (install @fontsource/roboto, or setFontLoader)');
  // Node loads the CommonJS build (parse on .default); bundlers take the ES module (named parse)
  const ot: any = (opentype as any).parse ? opentype : (opentype as any).default;
  font = ot.parse(fontBytes());
  return font;
}

/** Width of `text` set at `px` (em size) in the studio font, with kerning — the UI kit's overflow check. */
export function textAdvance(text: string, px: number): number {
  return getFont().getAdvanceWidth(text, px, { kerning: true });
}

/** Cap height of the font as a share of its em size (H's height), for sizing text by cap height. */
function capRatio(f: Font): number {
  const h = f.charToGlyph('H');
  const bb = h.getBoundingBox();
  return (bb.y2 - bb.y1) / f.unitsPerEm || 0.7;
}

export interface TextOutline {
  polygons: number[][][];   // closed rings [[u, v], …] in metres; even-odd fill gives holes
  width: number;            // m
  height: number;           // cap height, m
  stroke: number;           // estimated thinnest stroke, m (vertical stem of "l")
}

/**
 * Outline `text` at a cap height of `size` metres, centred on the origin. u runs left→right,
 * v runs bottom→top of the letters.
 */
export function textOutline(text: string, size: number, opts: { align?: 'center' | 'left'; spacing?: number } = {}): TextOutline {
  const f = getFont();
  const em = size / capRatio(f);
  // lay glyphs out ourselves (character by character + kerning pairs): opentype.js's shaper
  // throws on some contextual substitutions Roboto carries, and plain text needs none of them
  const scale = em / f.unitsPerEm;
  const commands: any[] = [];
  let x = 0, prev: any = null;
  for (const ch of [...text]) {
    const g = f.charToGlyph(ch);
    if (prev) x += (f.getKerningValue(prev, g) ?? 0) * scale;
    commands.push(...g.getPath(x, 0, em).commands);
    x += (g.advanceWidth ?? 0) * scale + (opts.spacing ?? 0);
    prev = g;
  }
  const path = { commands };
  const rings: number[][][] = [];
  let ring: number[][] = [];
  let px = 0, py = 0;
  const steps = 8;
  const push = (x: number, y: number) => ring.push([x, -y]); // font y points down in opentype paths
  for (const c of path.commands) {
    switch (c.type) {
      case 'M': if (ring.length > 2) rings.push(ring); ring = []; push(c.x, c.y); px = c.x; py = c.y; break;
      case 'L': push(c.x, c.y); px = c.x; py = c.y; break;
      case 'Q':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
          push(a * px + b * c.x1 + d * c.x, a * py + b * c.y1 + d * c.y);
        }
        px = c.x; py = c.y; break;
      case 'C':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, d = 3 * (1 - t) * t * t, e = t ** 3;
          push(a * px + b * c.x1 + d * c.x2 + e * c.x, a * py + b * c.y1 + d * c.y2 + e * c.y);
        }
        px = c.x; py = c.y; break;
      case 'Z': if (ring.length > 2) rings.push(ring); ring = []; break;
    }
  }
  if (ring.length > 2) rings.push(ring);
  if (!rings.length) throw new Error(`text "${text}" has no printable letters`);
  // drop the duplicate closing point, centre
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rings) {
    const a = r[0], b = r[r.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) r.pop();
    for (const [x, y] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  const cx = opts.align === 'left' ? minX : (minX + maxX) / 2, cy = 0;
  const polygons = rings.map((r) => r.map(([x, y]) => [x - cx, y - cy]));
  // thinnest stroke: Roboto Bold's "l" stem width relative to cap height
  const l = f.charToGlyph('l').getBoundingBox();
  const stroke = ((l.x2 - l.x1) / f.unitsPerEm) * em;
  return { polygons, width: maxX - minX, height: size, stroke };
}
