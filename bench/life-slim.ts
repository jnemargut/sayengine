// Slim the life cast GLBs for both games (packages/core/src/life/slim.ts): drop the face shapes, quantize
// the vertices, single-key the still channels; vehicles get their wheels as nodes (rigWheels); then check
// every file with the Khronos glTF validator.
//   node bench/life-slim.ts [files…]   (default: games/pocket-raleigh*/assets/studio/life/*.glb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';
import { slimGlb, rigWheels } from '../packages/core/src/life/slim.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['games/pocket-raleigh', 'games/pocket-raleigh-web'].flatMap((g) => { const d = path.join(ROOT, g, 'assets/studio/life'); return fs.readdirSync(d).filter((f) => f.endsWith('.glb')).map((f) => path.join(d, f)); });
let before = 0, after = 0;
for (const f of files) {
  let src = new Uint8Array(fs.readFileSync(f));
  // vehicles: their wheels become nodes the engines turn and steer
  const rw = rigWheels(src);
  src = rw.glb;
  // the web build reads quantized vertices; Godot's glTF import doesn't (it keeps floats there)
  const { glb, report } = slimGlb(src, { quantize: !f.includes(`${path.sep}pocket-raleigh${path.sep}`) && !process.env.NO_QUANTIZE });
  if (rw.wheels) console.log(`     ${path.basename(f)}: ${rw.wheels} wheels rigged`);
  const v = await validator.validateBytes(glb, { maxIssues: 50 });
  const errs = v.issues.numErrors;
  if (errs) { console.log(`FAIL ${path.basename(f)}: ${v.issues.messages.filter((m: any) => m.severity === 0).slice(0, 4).map((m: any) => `${m.code} ${m.pointer} ${m.message}`).join(' | ')}`); process.exitCode = 1; continue; }
  fs.writeFileSync(f, glb);
  before += report.before; after += report.after;
  console.log(`ok   ${path.relative(ROOT, f)}: ${(report.before / 1048576).toFixed(2)} → ${(report.after / 1048576).toFixed(2)} MB (dropped ${report.morphTargets} face shapes, ${report.constantChannels} still channels → 1 key)`);
}
console.log(`total ${(before / 1048576).toFixed(1)} → ${(after / 1048576).toFixed(1)} MB`);
