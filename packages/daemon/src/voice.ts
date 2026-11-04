// Voices and alignment for spoken lines (Decision 21 A), all local and free:
//   • Kokoro-82M (Apache-2.0) via kokoro-js speaks a line when no recording is given
//   • Rhubarb Lip Sync (MIT) aligns audio + script into timed mouth shapes; downloaded on first use
//     into ~/.cache/ai3d-studio (its licence file is checked)
//   • a loudness envelope of the audio, to check the mouth is in sync
// Node-only. Licences: THIRD_PARTY.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const RHUBARB_VERSION = '1.14.0';
const CACHE = process.env.STUDIO_TOOLS_DIR ?? path.join(os.homedir(), '.cache', 'ai3d-studio');

function run(bin: string, args: string[], timeoutMs = 120000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/** Path to the Rhubarb binary, downloading the release for this platform on first use. */
export async function ensureRhubarb(): Promise<string> {
  if (process.env.RHUBARB_BIN && fs.existsSync(process.env.RHUBARB_BIN)) return process.env.RHUBARB_BIN;
  const plat = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const dir = path.join(CACHE, `Rhubarb-Lip-Sync-${RHUBARB_VERSION}-${plat}`);
  const bin = path.join(dir, process.platform === 'win32' ? 'rhubarb.exe' : 'rhubarb');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const url = `https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${RHUBARB_VERSION}/Rhubarb-Lip-Sync-${RHUBARB_VERSION}-${plat}.zip`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download Rhubarb Lip Sync (${res.status}) from ${url} — set RHUBARB_BIN to a local copy`);
    const zip = path.join(CACHE, `rhubarb-${RHUBARB_VERSION}.zip`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const u = await run('unzip', ['-q', '-o', zip, '-d', CACHE]);
    if (u.code !== 0) throw new Error(`could not unpack Rhubarb: ${u.stderr.trim()}`);
    if (process.platform === 'darwin') await run('xattr', ['-dr', 'com.apple.quarantine', dir]);
  }
  const lic = path.join(dir, 'LICENSE.md');
  if (!fs.existsSync(lic) || !/MIT/.test(fs.readFileSync(lic, 'utf8'))) throw new Error('Rhubarb licence file missing or not MIT — refusing to use it');
  return bin;
}

export interface Alignment { cues: Array<{ start: number; end: number; shape: string }>; duration: number }

/** Align audio with its script: Rhubarb's mouth shapes (A–H, X) over time. */
export async function align(wavPath: string, text: string): Promise<Alignment> {
  const bin = await ensureRhubarb();
  const dialog = path.join(os.tmpdir(), `studio-line-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(dialog, text);
  try {
    const r = await run(bin, ['-f', 'json', '-d', dialog, '--extendedShapes', 'GHX', '-q', wavPath], 300000);
    if (r.code !== 0) throw new Error(`Rhubarb failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
    const j = JSON.parse(r.stdout);
    return { duration: j.metadata.duration, cues: j.mouthCues.map((c: any) => ({ start: c.start, end: c.end, shape: c.value })) };
  } finally { fs.rmSync(dialog, { force: true }); }
}

/** Local free text-to-speech: Kokoro-82M (Apache-2.0). Returns a WAV. Voices: am_*, af_*, bm_*, bf_*. */
let kokoro: any = null;
export async function speak(text: string, voice = 'bm_george'): Promise<Uint8Array> {
  if (!kokoro) {
    let mod: any;
    try { mod = await import('kokoro-js'); } catch { throw new Error('the local voice (kokoro-js) is not installed — run npm install, or pass --audio with your own recording'); }
    kokoro = await mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  }
  const voices = Object.keys(kokoro.voices ?? {});
  if (voices.length && !voices.includes(voice)) throw new Error(`no voice "${voice}" — try ${voices.filter((v) => /^(am|bm|af|bf)_/.test(v)).slice(0, 12).join(', ')}`);
  const audio = await kokoro.generate(text, { voice });
  const tmp = path.join(os.tmpdir(), `studio-tts-${process.pid}-${Date.now()}.wav`);
  await audio.save(tmp);
  const bytes = new Uint8Array(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return bytes;
}

/** Decode a PCM16 or float32 WAV to mono samples. */
export function decodeWav(b: Uint8Array): { rate: number; samples: Float32Array } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file (use a .wav recording)');
  let o = 12, fmt = 1, ch = 1, rate = 24000, bits = 16, data: [number, number] | null = null;
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { fmt = dv.getUint16(o + 8, true); ch = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
    if (id === 'data') { data = [o + 8, Math.min(size, b.length - o - 8)]; break; }
    o += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV has no data chunk');
  const bytesPer = bits / 8, frames = Math.floor(data[1] / (bytesPer * ch));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const p = data[0] + (f * ch + c) * bytesPer;
      s += fmt === 3 ? dv.getFloat32(p, true) : bits === 16 ? dv.getInt16(p, true) / 32768 : bits === 32 ? dv.getInt32(p, true) / 2147483648 : (dv.getUint8(p) - 128) / 128;
    }
    out[f] = s / ch;
  }
  return { rate, samples: out };
}

/** RMS loudness at `fps` frames per second, normalised to 0..1. */
export function loudness(wav: Uint8Array, fps = 100): number[] {
  const { rate, samples } = decodeWav(wav);
  const hop = Math.round(rate / fps), n = Math.ceil(samples.length / hop);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = i * hop; j < Math.min(samples.length, (i + 1) * hop); j++) { s += samples[j] * samples[j]; c++; }
    out.push(Math.sqrt(s / Math.max(1, c)));
  }
  const max = Math.max(...out, 1e-9);
  return out.map((v) => v / max);
}
