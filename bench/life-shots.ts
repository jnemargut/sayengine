// Pick the checkpoint shots for town life from the baked day itself (same runtime, same seed as the
// engines), so the camera always finds someone doing something: browsing a stall, sitting on a bench,
// fishing off a pier, walking the dog, the bus at its stop, a car at the lights.
//   node bench/life-shots.ts > shots.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LifeRuntime } from '../packages/core/src/life/runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'games/pocket-raleigh/assets/studio/life.json'), 'utf8'));
const t = Number(process.argv[2] ?? D.start);
const rt = new LifeRuntime(D);
rt.init(t, 60);
const shots: any[] = [];
const pick = (pred: (i: number, g: any) => boolean) => { for (let i = 0; i < rt.agents.length; i++) { const a = rt.agents[i]; if (!a.visible) continue; if (pred(i, D.agents[i].plan[a.seg])) return i; } return -1; };
const town = (i: number) => D.agents[i].town;
const add = (name: string, i: number, o: Record<string, unknown> = {}) => { if (i >= 0) shots.push({ name, t, cam: [0, 0, 0], look: [0, 0, 0], follow: i, dist: 5, height: 2.0, angle: 150, fov: 50, ...o }); };
add('raleigh-market', pick((i, g) => town(i) === 0 && g?.k === 'act' && g.pose === 'browse'), { dist: 7, height: 3.2, angle: 160 });
add('raleigh-bench', pick((i, g) => town(i) === 0 && g?.k === 'act' && g.pose === 'sit'), { dist: 4.5, height: 1.6, angle: 200, lookUp: 0.8 });
const dogs = D.agents.map((a: any, i: number) => (a.kind === 'dog' ? a.owner : -1)).filter((x: number) => x >= 0);
for (const o of dogs) add(`${D.agents[o].town === 0 ? 'raleigh' : 'twin'}-dog-walker`, rt.agents[o].visible ? o : -1, { dist: 6, height: 2.4, angle: 35 });
add('twin-market', pick((i, g) => town(i) === 1 && g?.k === 'act' && (g.pose === 'browse' || g.pose === 'tend')), { dist: 8, height: 3.5, angle: 170 });
add('twin-pier', pick((i, g) => g?.k === 'act' && g.pose === 'fish'), { dist: 6, height: 2.2, angle: 140 });
add('raleigh-walkers', pick((i, g) => town(i) === 0 && g?.k === 'move' && rt.agents[i].v > 0.5), { dist: 7, height: 2.2, angle: 0 });
const bus = D.vehicles.findIndex((v: any) => v.kind === 'bus');
if (bus >= 0 && rt.vehicles[bus].visible) shots.push({ name: 'raleigh-bus', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: bus, dist: 16, height: 6, angle: 140, lookUp: 1.5, fov: 50 });
const car = rt.vehicles.findIndex((v, i) => v.visible && D.vehicles[i].kind === 'car' && D.vehicles[i].town === 0);
if (car >= 0) shots.push({ name: 'raleigh-car', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: car, dist: 10, height: 3.5, angle: 25, fov: 50 });
// the walk mesh both engines share, from above
shots.push({ name: 'walk-mesh-raleigh', t, cam: [60, 95, 150], look: [0, 0, 60], fov: 50, walk: true });
shots.push({ name: 'walk-mesh-twin', t, cam: [440, 110, 120], look: [380, 0, 0], fov: 50, walk: true });
// the videos: a dog walker on the move (the first moment one is walking after the start), a street, the market
for (const o of dogs) {
  const r2 = new LifeRuntime(D);
  r2.init(t, 60);
  let tw = -1;
  for (let k = 0; k < 18000 && tw < 0; k++) { r2.step(); const a = r2.agents[o], g = D.agents[o].plan[a.seg]; if (a.visible && g?.k === 'move' && a.v > 0.8 && k % 10 === 0) tw = Math.round(r2.t - 60); }
  if (tw > 0) { shots.push({ name: `video-${D.agents[o].town === 0 ? 'raleigh' : 'twin'}-dog`, t: tw, cam: [0, 0, 0], look: [0, 0, 0], follow: o, dist: 6.5, height: 2.6, angle: 25, fov: 50, frames: 240 }); break; }
}
const walker = pick((i, g) => town(i) === 0 && g?.k === 'move' && rt.agents[i].v > 0.8);
if (walker >= 0) shots.push({ name: 'video-raleigh-street', t, cam: [0, 0, 0], look: [0, 0, 0], follow: walker, dist: 9, height: 3.2, angle: 20, fov: 50, frames: 240 });
const tm = pick((i, g) => town(i) === 1 && g?.k === 'act' && (g.pose === 'browse' || g.pose === 'tend'));
if (tm >= 0) shots.push({ name: 'video-twin-market', t, cam: [0, 0, 0], look: [0, 0, 0], follow: tm, dist: 22, height: 11, angle: 170, fov: 45, frames: 240 });
if (bus >= 0 && rt.vehicles[bus].visible) shots.push({ name: 'video-raleigh-bus', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: bus, dist: 18, height: 7, angle: 150, lookUp: 1.5, fov: 50, frames: 180 });
process.stdout.write(JSON.stringify(shots, null, 1) + '\n');
