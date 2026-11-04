// Voice helpers (Decision 21): WAV decoding and the loudness envelope used for the sync check; the
// line-preview timeline. The TTS model and Rhubarb are exercised by bench/talking-face.ts (downloads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, loudness } from '../src/voice.ts';
import { videoTimeline } from '../src/lineplayer/make.ts';

function wav16(samples: number[], rate = 24000, channels = 1) {
  const data = samples.length * 2;
  const b = new Uint8Array(44 + data), dv = new DataView(b.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  tag(0, 'RIFF'); dv.setUint32(4, 36 + data, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2 * channels, true); dv.setUint16(32, 2 * channels, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, data, true);
  samples.forEach((s, i) => dv.setInt16(44 + i * 2, Math.round(s * 32767), true));
  return b;
}

test('WAV decode (PCM16, stereo averaged) and loudness: silence, then a tone', () => {
  const rate = 8000;
  const s = Array.from({ length: rate }, (_, i) => (i < rate / 2 ? 0 : 0.5 * Math.sin(i * 0.3)));
  const d = decodeWav(wav16(s, rate));
  assert.equal(d.rate, rate);
  assert.equal(d.samples.length, rate);
  const st = decodeWav(wav16([0.5, -0.5, 0.25, 0.25], rate, 2));
  assert.deepEqual([...st.samples].map((x) => +x.toFixed(2)), [0, 0.25]);
  const e = loudness(wav16(s, rate), 100);
  assert.equal(e.length, 100);
  assert.ok(e[20] < 0.01 && e[80] > 0.9);
  assert.throws(() => decodeWav(new Uint8Array(64)), /not a WAV/);
});

test('line-preview video timeline: rest gaps around each line', () => {
  const { segs, total } = videoTimeline([{ id: 'a', duration: 2 }, { id: 'b', duration: 1 }], 0.5);
  assert.deepEqual(segs, [{ id: 'a', start: 0.5, end: 2.5 }, { id: 'b', start: 3, end: 4 }]);
  assert.equal(total, 4.5);
});
