// Effects, UI kit and line audio into a game (Decisions 56–58, Fire's Dying pain #9).
// Web: particle layers compile to three.quarks JSON (MIT, pinned at QUARKS_VERSION; studio/effects.ts
// loads it with QuarksLoader), shape layers travel as data plus the shared noise shader. Godot: one
// .tscn per effect (GPU particles with a CPU twin, shape cards with the same shader) from @studio/core.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { effectFrame, godotEffectScene, godotShapeShader, webShapeShader, godotTheme, uiCss, type ParticleLayer } from '../../core/src/index.ts';
import type { GameData, EffectBundle } from '../../core/src/gamedata.ts';
import { STUDIO_ROOT } from './project.ts';
import { writeLook } from './look.ts';

export const QUARKS_VERSION = '0.17.1';

// three.quarks prints a banner with console.log when it loads, which would corrupt the CLI's JSON on
// stdout: load it on first use, with console.log muted for that moment.
let Q: any = null;
export async function loadQuarks() {
  if (!Q) {
    const log = console.log;
    console.log = () => {};
    try { Q = await import('three.quarks'); } finally { console.log = log; }
  }
  return Q;
}

// quarks' particle shader ends without three's colour-space step, so it writes its colours straight to
// the screen: hand it the palette's sRGB values as they are (a linearised colour came out darker than
// Godot's — the sparks and embers by about 20%)
const v3 = (hex: string) => { const c = new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace); return new Q.Vector3(c.r, c.g, c.b); };

/** The exponent on a layer's alpha that makes the web's sRGB blend land where Godot's linear-light blend
 *  does, at half alpha:
 *  - additive: Godot adds a·lin(c), which reads as about c·a^(1/2.2) on screen (sparks and embers were
 *    15–25 % darker on the web with plain alpha);
 *  - alpha: over a light scene (sRGB 0.78, the review yard), the web alpha that gives Godot's colour.
 *    A dark puff comes out ≈ 1.35 (it reads denser on the web), a pale drop ≈ 1 (the old rule split dark
 *    and pale at a linear luminance of 0.5, so rain's pale blue, 0.41 linear, was thinned as if dark). */
export function alphaGamma(blend: 'add' | 'alpha', hex: string): number {
  if (blend === 'add') return 1 / 2.2;
  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const n = parseInt(hex.slice(1, 7), 16);
  const lum = 0.2126 * ((n >> 16) / 255) + 0.7152 * (((n >> 8) & 255) / 255) + 0.0722 * ((n & 255) / 255);
  const bg = 0.78;
  if (Math.abs(bg - lum) < 0.04) return 1;
  const godot = toSrgb(toLin(bg) * 0.5 + toLin(lum) * 0.5);
  const web = (bg - godot) / (bg - lum);
  return Math.min(2, Math.max(0.5, Math.log(Math.min(0.99, Math.max(0.01, web))) / Math.log(0.5)));
}

/** One quarks ParticleSystem per particle layer, under a group named after the effect. Emitters face
 *  their layer's direction (quarks emits along local +Z). */
export function quarksGroup(b: EffectBundle): THREE.Group {
  if (!Q) throw new Error('call loadQuarks() first');
  const g = new THREE.Group();
  g.name = b.def.id;
  for (const l of b.def.layers) {
    if (l.kind !== 'particles') continue;
    const L = l as ParticleLayer;
    // Godot blends in linear light, three in the sRGB canvas: each layer's alpha carries an exponent that
    // makes the web blend land where Godot's does (alphaGamma), over its whole life (several keys, since
    // a two-key ramp from 1 to 0 has nothing for an exponent to bend) and across the particle's soft dot
    const gam = alphaGamma(L.blend, b.colours[L.colour[0]]);
    const a = (L.alpha ?? [1, 1]) as [number, number];
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: L.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending });
    const spread = THREE.MathUtils.degToRad(Math.min(89, L.spread ?? 0));
    const shape = L.shape.type === 'sphere' ? new Q.SphereEmitter({ radius: L.shape.radius ?? 0.1 })
      // a box fills its area: quarks' RectangleEmitter emits from the rectangle's edge, outwards (rain
      // came out as a ring of sideways streaks); a fine grid emits from all over it, along the direction
      : L.shape.type === 'box' ? new Q.GridEmitter({ width: L.shape.size?.[0] ?? 1, height: L.shape.size?.[2] ?? 1, column: 64, row: 64 })
      : new Q.ConeEmitter({ radius: L.shape.type === 'point' ? 0.001 : L.shape.radius ?? 0.05, angle: Math.max(0.001, spread), thickness: 1 });
    const behaviors: any[] = [
      new Q.ColorOverLife(new Q.Gradient(
        [[v3(b.colours[L.colour[0]]), 0], [v3(b.colours[L.colour[1]]), 1]],
        [0, 0.15, 0.35, 0.6, 0.8, 1].map((t) => [Math.pow(Math.max(0, a[0] + (a[1] - a[0]) * t), gam), t]))),
      new Q.SizeOverLife(new Q.PiecewiseBezier([[new Q.Bezier(1, 1 + ((L.sizeEnd ?? 1) - 1) / 3, 1 + (2 * ((L.sizeEnd ?? 1) - 1)) / 3, L.sizeEnd ?? 1), 0]])),
    ];
    if (L.gravity) behaviors.push(new Q.ApplyForce(new Q.Vector3(0, -1, 0), new Q.ConstantValue(L.gravity)));
    if (L.drag) behaviors.push(new Q.SpeedOverLife(new Q.PiecewiseBezier([[new Q.Bezier(1, 1 - L.drag / 3, 1 - (2 * L.drag) / 3, 1 - L.drag), 0]])));
    if (L.turbulence) behaviors.push(new Q.Noise(new Q.ConstantValue(1.2), new Q.ConstantValue(L.turbulence * 0.6)));
    const oneShot = L.rate === 0;
    const ps = new Q.ParticleSystem({
      duration: oneShot ? L.life[1] : 1, looping: !oneShot, autoDestroy: false, worldSpace: true,
      startLife: new Q.IntervalValue(L.life[0], L.life[1]), startSpeed: new Q.IntervalValue(L.speed[0], L.speed[1]), startSize: new Q.IntervalValue(L.size[0], L.size[1]),
      startColor: new Q.ConstantColor(new Q.Vector4(1, 1, 1, 1)),
      emissionOverTime: new Q.ConstantValue(L.rate),
      emissionBursts: (L.bursts ?? []).map((x) => ({ time: x.at, count: new Q.ConstantValue(x.count), cycle: 1, interval: 0.01, probability: 1 })),
      shape, material: mat,
      renderMode: L.stretch ? Q.RenderMode.StretchedBillBoard : Q.RenderMode.BillBoard,
      // a streak as long as Godot's (speed × stretch): quarks draws (1 + lengthFactor / |v·speedFactor|) ×
      // |v·speedFactor| × size along the velocity, and speedFactor 0 runs as 0.001, so length ≈ lengthFactor × size
      ...(L.stretch ? { rendererEmitterSettings: { speedFactor: 0, lengthFactor: Math.max(1, ((L.speed[0] + L.speed[1]) / 2) * L.stretch / ((L.size[0] + L.size[1]) / 2)) } } : {}),
      behaviors,
    } as any);
    const e = ps.emitter;
    e.name = L.id;
    // what each particle is drawn with (studio/effects.ts makes the texture; Godot's compiler the same shape):
    // a stretched layer is a streak (soft across, solid along its length, so a raindrop reads end to end);
    // an additive one Godot's dot (alpha falling linearly to the rim) raised to its exponent; a see-through
    // puff keeps the soft dot (it reads like Godot's under the exponent on its alpha)
    e.userData = { layer: L.id, rate: L.rate, oneShot, ...(L.stretch ? { streak: +gam.toFixed(3) } : L.blend === 'add' ? { dot: +gam.toFixed(3) } : {}) };
    const dir = new THREE.Vector3(...(L.direction ?? [0, 1, 0])).normalize();
    e.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    e.position.set(...(L.offset ?? [0, 0, 0]));
    g.add(e);
  }
  g.updateMatrixWorld(true);   // toJSON writes .matrix, which only updates here
  return g;
}

export const quarksJSON = (b: EffectBundle) => quarksGroup(b).toJSON();
/** Load quarks JSON back (what the game does): the round-trip test reads the emitters out of it. */
export function parseQuarks(json: any): THREE.Object3D {
  if (!Q) throw new Error('call loadQuarks() first');
  return new Q.QuarksLoader().parse(json, () => {}) as THREE.Object3D;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
const resetDir = (d: string) => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); };

/** Write effects, the UI kit and every line's audio under assets/studio/. Returns the files written. */
export async function writeGameData(dir: string, engine: 'godot' | 'web', data: GameData | null): Promise<string[]> {
  if (engine === 'web' && data?.effects.length) await loadQuarks();
  const files: string[] = [];
  const put = (rel: string, body: string | Buffer) => { const f = path.join(dir, 'assets', 'studio', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); files.push(f); };
  const fxDir = path.join(dir, 'assets', 'studio', 'effects'), uiDir = path.join(dir, 'assets', 'studio', 'ui'), lnDir = path.join(dir, 'assets', 'studio', 'lines');
  for (const d of [fxDir, uiDir, lnDir]) resetDir(d);
  // the manifests always exist (empty when the studio has none), so the runtimes never fetch a 404
  const empties = () => {
    fs.writeFileSync(path.join(fxDir, 'effects.json'), '[]\n');
    fs.writeFileSync(path.join(uiDir, 'ui.json'), 'null\n');
    fs.writeFileSync(path.join(lnDir, 'lines.json'), '{}\n');
  };
  empties();
  // the look (Decision 29): look.json, the LUT strip and .cube, or the grade baked into the colours
  files.push(...writeLook(dir, engine, data?.look ?? null).files);
  if (!data) return files;
  // effects
  const manifest = data.effects.map((b) => ({ id: b.def.id, name: b.def.name, at: b.at, loop: b.def.loop, value: b.def.value ?? null, triggers: b.def.triggers ?? [], warmup: b.def.warmup !== false, frame: effectFrame(b.def, b.at), file: engine === 'godot' ? `${b.def.id}.tscn` : `${b.def.id}.json` }));
  if (data.effects.length) {
    if (engine === 'godot') {
      put('effects/shape.gdshader', godotShapeShader());
      for (const b of data.effects) put(`effects/${b.def.id}.tscn`, godotEffectScene(b.def, b.colours));
    } else {
      const shader = webShapeShader();
      for (const b of data.effects) put(`effects/${b.def.id}.json`, JSON.stringify({ def: b.def, at: b.at, colours: b.colours, quarks: quarksJSON(b), quarksVersion: QUARKS_VERSION, shader }));
    }
  }
  put('effects/effects.json', JSON.stringify(manifest, null, 2) + '\n');
  // UI kit
  if (data.ui) {
    const ui = data.ui;
    const font = path.join(STUDIO_ROOT, 'node_modules', ui.tokens.font.file);
    if (fs.existsSync(font)) put('ui/font.woff', fs.readFileSync(font));
    for (const [n, i] of Object.entries(ui.icons)) put(`ui/icons/${n}.svg`, i.svg);
    put('ui/ui.json', JSON.stringify({ tokens: ui.tokens, layout: ui.layout, icons: Object.keys(ui.icons), profile: ui.profile ?? 'mobile' }, null, 2) + '\n');
    if (engine === 'godot') put('ui/theme.tres', godotTheme(ui.tokens));
    else put('ui/ui.css', uiCss(ui.tokens));
  }
  // every recorded line, playable on its own (say(character, line))
  const lines: Record<string, Record<string, any>> = {};
  for (const l of data.lines) {
    const file = `${slug(l.character)}/${slug(l.line)}.wav`;
    if (l.audio) put(`lines/${file}`, Buffer.from(l.audio, 'base64'));
    (lines[l.character] ??= {})[l.line] = { text: l.text, clip: l.clip, duration: l.duration, sync: l.sync, file: l.audio ? file : null };
  }
  put('lines/lines.json', JSON.stringify(lines, null, 2) + '\n');
  return files;
}
