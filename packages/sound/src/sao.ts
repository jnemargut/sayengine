// Stable Audio Open Small (Decision 33's model layer): free, local, for foley and textures up to ~11 s.
// Licence (checked 2026-11-05, recorded in THIRD_PARTY.md): the Stability AI Community License — free for
// research, non-commercial and commercial use while you (and affiliates) make under US$1M a year;
// commercial users must register with Stability; you own the outputs; anything you distribute that
// includes the model needs a Notice file and "Powered by Stability AI". The weights are gated on Hugging
// Face: the user must accept that licence with their own account — the studio never does it for them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { venvPython } from './beats.ts';
import type { Licence } from './ledger.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAO_DIR = process.env.STUDIO_SAO_DIR ?? path.join(os.homedir(), '.studio-tools', 'models', 'stable-audio-open-small');
export const SAO_LICENCE = {
  name: 'Stability AI Community License',
  spdx: 'LicenseRef-Stability-AI-Community',
  url: 'https://stability.ai/community-license-agreement',
  summary: 'Free (incl. commercial) under US$1M annual revenue; commercial use requires registering with Stability; outputs are yours; distributing the model or products built on it needs the licence copy, a Notice file and "Powered by Stability AI".',
  gated: 'https://huggingface.co/stabilityai/stable-audio-open-small (accept the licence with your Hugging Face account)',
};

function freeGb(dir: string): number | null {
  const r = spawnSync('df', ['-k', dir], { encoding: 'utf8' });
  const kb = Number((r.stdout ?? '').trim().split('\n').pop()?.split(/\s+/)[3]);
  return Number.isFinite(kb) ? +(kb / 1048576).toFixed(1) : null;
}

/** Can the model run here? Lists every blocker (weights, the Python package, disk, memory). */
export function saoStatus() {
  const py = venvPython();
  const weights = (fs.existsSync(path.join(SAO_DIR, 'model.safetensors')) || fs.existsSync(path.join(SAO_DIR, 'model.ckpt'))) && fs.existsSync(path.join(SAO_DIR, 'model_config.json'));
  const pkg = py ? spawnSync(py, ['-I', '-c', 'import stable_audio_tools'], { encoding: 'utf8' }).status === 0 : false;
  const disk = freeGb(os.homedir());
  const memGb = +(os.totalmem() / 1073741824).toFixed(1);
  const blockers: string[] = [];
  if (!weights) blockers.push(`no weights in ${SAO_DIR}: they are gated — accept the ${SAO_LICENCE.name} at ${SAO_LICENCE.gated}, then \`hf auth login\` and \`hf download stabilityai/stable-audio-open-small --local-dir ${SAO_DIR}\``);
  if (!pkg) blockers.push('stable-audio-tools is not installed in ~/.studio-tools/venv (pip install stable-audio-tools; it pins older torch builds, so it may want its own venv)');
  // once the weights are here, only the T5 text encoder (~1 GB, fetched on first run) and outputs remain
  const needGb = weights ? 2 : 6;
  if (disk !== null && disk < needGb) blockers.push(`only ${disk} GB free on the home disk (need about ${needGb} GB${weights ? ' for the T5 text encoder and outputs' : ' for weights + T5 encoder + packages'})`);
  return {
    available: blockers.length === 0, blockers, weights, package: pkg, diskFreeGb: disk, memoryGb: memGb,
    // ~341M-parameter DiT + autoencoder + T5-base text encoder: ≈ 2 GB in fp32 — fits in 8 GB; Arm's
    // published figure is ~7–8 s per 10 s of audio on a phone-class CPU
    fitsInMemory: memGb >= 8, licence: SAO_LICENCE,
    fallback: 'CC0 library recordings (studio sound fetch) and the procedural beds (studio sound bed)',
  };
}

export function saoGenerate(prompt: string, out: string, opts: { seconds?: number; seed?: number; steps?: number } = {}): { ok: boolean; file?: string; error?: string; licence?: Licence } {
  const st = saoStatus();
  if (!st.available) return { ok: false, error: `Stable Audio Open Small can't run here: ${st.blockers.join('; ')}` };
  const r = spawnSync(venvPython()!, ['-I', path.join(HERE, 'sao.py'), '--prompt', prompt, '--seconds', String(opts.seconds ?? 6), '--seed', String(opts.seed ?? 1), '--steps', String(opts.steps ?? 8), '--out', out], { encoding: 'utf8', timeout: 600000 });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try { const j = JSON.parse(last); if (!j.ok) return { ok: false, error: j.error }; } catch { return { ok: false, error: (r.stderr ?? '').trim().split('\n').slice(-1)[0] || 'no output' }; }
  return { ok: true, file: out, licence: { spdx: SAO_LICENCE.spdx, copyright: `${new Date().getFullYear()} the game's author (output of Stable Audio Open Small)`, source: 'stable-audio-open-small', how: `prompt "${prompt}" seed ${opts.seed ?? 1}`, url: SAO_LICENCE.url, attribution: 'Powered by Stability AI' } };
}
