// A small PNG reader (8-bit RGB / RGBA / grey, not interlaced) for the look gates, which read the
// engines' screenshots in plain TypeScript. Writing uses facepaint's encoder.
import { unzlibSync } from 'fflate';
export { encodePng } from '../facepaint.ts';

export interface Image { width: number; height: number; rgba: Uint8Array }

export function decodePng(buf: Uint8Array): Image {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((v, i) => buf[i] !== v)) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = dv.getUint32(o), t = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { width = dv.getUint32(o + 8); height = dv.getUint32(o + 12); depth = buf[o + 16]; type = buf[o + 17]; interlace = buf[o + 20]; }
    else if (t === 'IDAT') idat.push(data);
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace || ![0, 2, 4, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const ch = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1;
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let p = 0; for (const d of idat) { all.set(d, p); p += d.length; }
  const raw = unzlibSync(all);
  const stride = width * ch, out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const q = (y * width + x) * 4, s = x * ch;
      if (ch >= 3) { out[q] = cur[s]; out[q + 1] = cur[s + 1]; out[q + 2] = cur[s + 2]; out[q + 3] = ch === 4 ? cur[s + 3] : 255; }
      else { out[q] = out[q + 1] = out[q + 2] = cur[s]; out[q + 3] = ch === 2 ? cur[s + 1] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba: out };
}
