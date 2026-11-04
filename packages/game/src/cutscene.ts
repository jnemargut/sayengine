// Cutscenes into games (Decision 24): the studio's timeline (shots, camera keys, cues, voices) becomes
// files the engines play — for Godot a generated scene (AnimationPlayer with camera, voice and cue tracks
// driving studio/cutscene.gd), for the web the JSON the three.js player reads (studio/cutscene.ts).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type V3 = [number, number, number];
interface CamKey { position: V3; target: V3; fov: number }
export interface GameTimeline {
  id: string; title?: string; duration: number;
  shots: Array<{ id: string; start: number; end: number; from: CamKey; to: CamKey; framing: string }>;
  cues: Array<{ t: number; end: number; character: string; name: string; clip: string; kind: 'line' | 'motion'; audio?: string; text?: string; shot: string }>;
  characters: Array<{ id: string; name: string; idle: string | null }>;
  events?: Array<{ t: number; name: string; shot: string }>;
}
export interface CutsceneBundle { timeline: GameTimeline; audio: Record<string, string> }   // audio: asset name → base64 WAV

const n = (x: number) => +x.toFixed(5);
/** Godot Transform3D for a camera at `p` looking at `t` (text form lists the basis row by row, then the origin; cameras look down −Z). */
function camTransform(p: V3, t: V3) {
  const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  const z = [-f[0] / fl, -f[1] / fl, -f[2] / fl];
  let x = [z[2], 0, -z[0]];                                   // up × z
  const xl = Math.hypot(x[0], x[1], x[2]) || 1; x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return `Transform3D(${[x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], ...p].map(n).join(', ')})`;
}

/** The generated Godot scene for a cutscene (text .tscn). */
export function godotCutsceneScene(tl: GameTimeline, audioRes: (asset: string) => string, timelineRes: string): string {
  const ext: string[] = ['[ext_resource type="Script" path="res://studio/cutscene.gd" id="1_script"]'];
  const audioIds = new Map<string, string>();
  for (const c of tl.cues) if (c.audio && !audioIds.has(c.audio)) { const id = `a${audioIds.size + 1}`; audioIds.set(c.audio, id); ext.push(`[ext_resource type="AudioStream" path="${audioRes(c.audio)}" id="${id}"]`); }
  const tracks: string[] = [];
  const track = (type: string, p: string, keys: string, extra = '') => {
    const i = tracks.length;
    tracks.push(`tracks/${i}/type = "${type}"\ntracks/${i}/imported = false\ntracks/${i}/enabled = true\ntracks/${i}/path = NodePath("${p}")${extra.replace(/#/g, String(i))}\ntracks/${i}/keys = ${keys}`);
  };
  // camera: per shot a key at its start and one just before its end (so the next shot's first key is a cut)
  const times: number[] = [], xf: string[] = [], fovs: number[] = [], trans: number[] = [];
  for (const s of tl.shots) {
    times.push(s.start, Math.max(s.start + 0.001, s.end - 0.001));
    xf.push(camTransform(s.from.position, s.from.target), camTransform(s.to.position, s.to.target));
    fovs.push(s.from.fov, s.to.fov);
    trans.push(-2, 1);                                         // ease in-out along the shot; the cut itself is 1 ms
  }
  const pf = (a: number[]) => `PackedFloat32Array(${a.map(n).join(', ')})`;
  track('value', 'CutCam:transform', `{\n"times": ${pf(times)},\n"transitions": ${pf(trans)},\n"update": 0,\n"values": [${xf.join(', ')}]\n}`, '\ntracks/#/interp = 1\ntracks/#/loop_wrap = true');
  track('value', 'CutCam:fov', `{\n"times": ${pf(times)},\n"transitions": ${pf(trans)},\n"update": 0,\n"values": [${fovs.map(n).join(', ')}]\n}`, '\ntracks/#/interp = 1\ntracks/#/loop_wrap = true');
  // cues: play the clip (fade in), and go back to idle when it ends (fade out)
  const calls: Array<{ t: number; args: string; method: string }> = [];
  for (const c of tl.cues) {
    calls.push({ t: c.t, method: 'cue', args: `["${c.character}", "${c.clip}", 0.22]` });
    calls.push({ t: Math.min(tl.duration, c.end), method: 'cue', args: `["${c.character}", "idle", 0.3]` });
  }
  for (const e of tl.events ?? []) calls.push({ t: e.t, method: 'mark', args: `["${e.name}"]` });
  calls.sort((a, b) => a.t - b.t);
  // two calls at the same time would collide in one track: nudge later ones by a frame
  for (let i = 1; i < calls.length; i++) if (calls[i].t <= calls[i - 1].t) calls[i].t = calls[i - 1].t + 0.001;
  track('method', '.', `{\n"times": ${pf(calls.map((c) => c.t))},\n"transitions": ${pf(calls.map(() => 1))},\n"values": [${calls.map((c) => `{\n"args": ${c.args},\n"method": &"${c.method}"\n}`).join(', ')}]\n}`, '\ntracks/#/interp = 1\ntracks/#/loop_wrap = true');
  // voices: one audio track per speaking character
  const speakers = [...new Set(tl.cues.filter((c) => c.audio).map((c) => c.character))];
  for (const sp of speakers) {
    const cs = tl.cues.filter((c) => c.audio && c.character === sp);
    track('audio', `Voice_${sp}`, `{\n"clips": [${cs.map((c) => `{\n"end_offset": 0.0,\n"start_offset": 0.0,\n"stream": ExtResource("${audioIds.get(c.audio!)}")\n}`).join(', ')}],\n"times": ${pf(cs.map((c) => c.t))}\n}`, '\ntracks/#/use_blend = true');
  }
  const first = tl.shots[0];
  const nodes = [
    `[node name="Cutscene_${tl.id.replace(/-/g, '_')}" type="Node3D"]\nscript = ExtResource("1_script")\ntimeline = "${timelineRes}"`,
    `[node name="CutCam" type="Camera3D" parent="."]\ntransform = ${first ? camTransform(first.from.position, first.from.target) : 'Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.6, 3)'}\nfov = ${n(first?.from.fov ?? 35)}\nnear = 0.05`,
    ...speakers.map((sp) => `[node name="Voice_${sp}" type="AudioStreamPlayer" parent="."]`),
    `[node name="Player" type="AnimationPlayer" parent="."]\nlibraries = {\n&"": SubResource("AnimationLibrary_cutscene")\n}`,
  ];
  return [
    `[gd_scene load_steps=${ext.length + 3} format=3]`, '',
    ...ext, '',
    `[sub_resource type="Animation" id="Animation_cutscene"]\nresource_name = "cutscene"\nlength = ${n(tl.duration)}\n${tracks.join('\n')}`, '',
    `[sub_resource type="AnimationLibrary" id="AnimationLibrary_cutscene"]\n_data = {\n&"cutscene": SubResource("Animation_cutscene")\n}`, '',
    nodes.join('\n\n'), '',
  ].join('\n');
}

/** Recorded frames (PNG or JPEG) + the voices at their cue times → MP4, plus one still per shot. */
export function muxCutscene(frameDir: string, fps: number, tl: GameTimeline, audioDir: string, out: string): { video: string | null; frames: number; stills: string[]; note?: string } {
  const files = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /\.(png|jpg)$/.test(f)).sort() : [];
  if (!files.length) return { video: null, frames: 0, stills: [], note: 'no frames were recorded' };
  const ext = path.extname(files[0]);
  const stills = tl.shots.map((s) => {
    const q = tl.cues.find((c) => c.shot === s.id);
    const t = q ? Math.min(s.end - 0.05, q.t + (q.kind === 'motion' ? Math.min(1.6, (q.end - q.t) * 0.56) : Math.min(1.0, (q.end - q.t) * 0.45))) : s.start + (s.end - s.start) * 0.4;
    const f = files[Math.min(files.length - 1, Math.round(t * fps))];
    const dst = out.replace(/\.mp4$/, `-${s.id}${ext}`);
    fs.copyFileSync(path.join(frameDir, f), dst);
    return dst;
  });
  const cues = tl.cues.filter((c) => c.audio && fs.existsSync(path.join(audioDir, c.audio)));
  const total = Math.min(tl.duration, files.length / fps);
  const inputs = cues.flatMap((c) => ['-i', path.join(audioDir, c.audio!)]);
  const filt = cues.length
    ? cues.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(c.t * 1000)}:all=1[a${i}]`).join(';') + `;${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)}[aout]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[aout]`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-pattern_type', 'glob', '-i', path.join(frameDir, `*${ext}`), ...inputs, '-filter_complex', filt, '-map', '0:v', '-map', '[aout]', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-t', total.toFixed(3), out], { encoding: 'utf8' });
  if (r.status !== 0) return { video: null, frames: files.length, stills, note: `ffmpeg: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0]}` };
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { video: out, frames: files.length, stills };
}

/** Write a game's cutscene files: the timeline JSON, the voices, and (Godot) the generated scene. */
export function writeCutscenes(dir: string, engine: 'godot' | 'web', bundles: CutsceneBundle[]) {
  const out = path.join(dir, 'assets', 'studio', 'cutscenes');
  fs.rmSync(out, { recursive: true, force: true });
  if (!bundles.length) return [];
  fs.mkdirSync(path.join(out, 'audio'), { recursive: true });
  const files: string[] = [];
  for (const b of bundles) {
    for (const [name, b64] of Object.entries(b.audio)) { const f = path.join(out, 'audio', name); if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(b64, 'base64')); }
    const json = path.join(out, `${b.timeline.id}.json`);
    fs.writeFileSync(json, JSON.stringify(b.timeline, null, 2));
    files.push(json);
    if (engine === 'godot') {
      const tscn = path.join(out, `${b.timeline.id}.tscn`);
      fs.writeFileSync(tscn, godotCutsceneScene(b.timeline, (a) => `res://assets/studio/cutscenes/audio/${a}`, `res://assets/studio/cutscenes/${b.timeline.id}.json`));
      files.push(tscn);
    }
  }
  return files;
}
