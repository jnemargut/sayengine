// Pick the checkpoint shots for town life from the baked day itself (same runtime, same seed as the
// engines), so the camera always finds someone doing something: browsing a stall, sitting on a bench,
// fishing off a pier, walking the dog, the bus at its stop, a car at the lights.
// Follow cameras are flown here first, frame by frame, the way both engines fly them (the same runtime,
// 30 fps, the same easing), and each takes the first framing (angle, distance, height) whose line of sight
// never passes through a tree crown or trunk or ends up inside a building. The Raleigh market gets a fixed
// camera that frames the whole ring of stalls from the open side.
//   node bench/life-shots.ts [t] > shots.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LifeRuntime, LIFE_DT } from '../packages/core/src/life/runtime.ts';
import { setWorldCacheDir, buildTown } from '../packages/core/src/world/index.ts';
import { pointInPoly } from '../packages/core/src/world/geo.ts';
import { groundAt } from '../packages/core/src/world/plan.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'games/pocket-raleigh/assets/studio/life.json'), 'utf8'));
const t = Number(process.argv[2] ?? D.start);

// what blocks a camera: tree crowns and trunks, buildings (the same towns the bake used)
setWorldCacheDir(path.join(ROOT, '.studio/cache/world'));
const towns = [
  { plan: buildTown({ name: 'Pocket Raleigh', source: 'real', area: 'raleigh-city-plaza', style: 'raleigh-downtown', fixes: [] }).plan, off: [0, 0] },
  { plan: buildTown({ name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', style: 'river-town-1920s', fixes: [] } as any).plan, off: [380, 0] },
];
const trees = towns.flatMap((T) => T.plan.trees.map((tr) => { const y = groundAt(T.plan.ground, tr.at[0], tr.at[1]); return { x: tr.at[0] + T.off[0], z: tr.at[1] + T.off[1], y0: y + 1.0 * tr.size, y1: y + 5.6 * tr.size, r: 2.4 * tr.size + 0.35, ty: y }; }));
const blocked = (p: number[]): boolean => {
  for (const tr of trees) {
    const d = Math.hypot(p[0] - tr.x, p[2] - tr.z);
    if ((d < tr.r && p[1] > tr.y0 && p[1] < tr.y1) || (d < 0.4 && p[1] < tr.y1 && p[1] > tr.ty)) return true;
  }
  for (const T of towns) for (const b of T.plan.buildings) {
    if (b.hidden) continue;
    const q: [number, number] = [p[0] - T.off[0], p[2] - T.off[1]];
    if (p[1] < (b.height ?? 10) + groundAt(T.plan.ground, q[0], q[1]) + 0.5 && pointInPoly(q, b.footprint)) return true;
  }
  return false;
};
/** Is the straight line from the camera to what it looks at clear (and the camera itself in the open)? */
const clear = (cam: number[], look: number[]): boolean => {
  const L = Math.hypot(look[0] - cam[0], look[1] - cam[1], look[2] - cam[2]), n = Math.max(2, Math.ceil(L / 0.25));
  for (let k = 0; k <= n - 2; k++) { const u = k / n; if (blocked([cam[0] + (look[0] - cam[0]) * u, cam[1] + (look[1] - cam[1]) * u, cam[2] + (look[2] - cam[2]) * u])) return false; }
  return true;
};

/** Fly a follow camera as the engines do; the number of frames whose view is blocked. */
const fly = (s: any): number => {
  const rt = new LifeRuntime(D);
  rt.init(s.t, s.warm ?? 60);
  for (let k = 0; k < (s.ff ?? 0); k++) rt.step();
  let acc = 0, cam: number[] | null = null, bad = 0;
  for (let f = -6; f < (s.frames ?? 1); f++) {
    acc += 1 / 30;
    while (acc >= LIFE_DT) { rt.step(); acc -= LIFE_DT; }
    const who = s.follow !== undefined ? rt.agents[s.follow] : rt.vehicles[s.followVehicle];
    if (!who.visible) continue;
    const yaw = who.yaw + (s.angle ?? 0) * Math.PI / 180;
    let pos = [who.x - Math.sin(yaw) * (s.dist ?? 6), who.y + (s.height ?? 2.6), who.z - Math.cos(yaw) * (s.dist ?? 6)];
    const look = [who.x, who.y + (s.lookUp ?? 1), who.z];
    if (cam && f > -6) pos = pos.map((v, k) => cam![k] + (v - cam![k]) * 0.08);
    cam = pos;
    if (f >= 0 && !clear(pos, look)) bad++;
  }
  return bad;
};
/** The first framing near the asked one that stays clear all through the shot. */
const frame = (s: any) => {
  const tries: any[] = [];
  for (const dh of [0, 1.2, -0.6, 2.4]) for (const dd of [1, 0.75, 1.3]) for (const da of [0, 25, -25, 50, -50, 90, -90, 140, -140, 180]) tries.push({ angle: (s.angle ?? 0) + da, dist: +((s.dist ?? 6) * dd).toFixed(2), height: +Math.max(1.2, (s.height ?? 2.6) + dh).toFixed(2) });
  let best: any = null, bestBad = Infinity;
  for (const tr of tries.slice(0, s.frames > 1 ? 40 : 120)) {
    const bad = fly({ ...s, ...tr });
    if (bad < bestBad) { bestBad = bad; best = tr; }
    if (bad === 0) break;
  }
  if (bestBad > 0) process.stderr.write(`shot ${s.name}: ${bestBad} frame(s) still behind a tree\n`);
  return { ...s, ...best };
};

const rt = new LifeRuntime(D);
rt.init(t, 60);
const shots: any[] = [];
const pick = (pred: (i: number, g: any) => boolean) => { for (let i = 0; i < rt.agents.length; i++) { const a = rt.agents[i]; if (!a.visible) continue; if (pred(i, D.agents[i].plan[a.seg])) return i; } return -1; };
const town = (i: number) => D.agents[i].town;
const add = (name: string, i: number, o: Record<string, unknown> = {}) => { if (i >= 0) shots.push(frame({ name, t, cam: [0, 0, 0], look: [0, 0, 0], follow: i, dist: 5, height: 2.0, angle: 150, fov: 50, ...o })); };

// the Raleigh market: a fixed camera from the open side of the ring of stalls, the whole market in frame
const stalls = (D.places ?? []).filter((p: any) => p.kind === 'stall' && p.town === 0);
const marketShot = (name: string, frames: number) => {
  if (!stalls.length) return;
  const c = [stalls.reduce((a: number, p: any) => a + p.at[0], 0) / stalls.length, 0, stalls.reduce((a: number, p: any) => a + p.at[1], 0) / stalls.length];
  c[1] = stalls[0].y;
  const R = Math.max(...stalls.map((p: any) => Math.hypot(p.at[0] - c[0], p.at[1] - c[2])));
  let best: any = null;
  for (let k = 0; k < 16 && !best; k++) for (const [back, up] of [[R + 9, 7], [R + 13, 9], [R + 6, 5.5]]) {
    const a = (k * Math.PI) / 8, cam = [c[0] + Math.sin(a) * back, c[1] + up, c[2] + Math.cos(a) * back], look = [c[0], c[1] + 0.8, c[2]];
    // clear to the middle and to every stall
    if (clear(cam, look) && stalls.every((p: any) => clear(cam, [p.at[0], p.y + 1.2, p.at[1]]))) { best = { cam, look }; break; }
  }
  if (!best) { process.stderr.write('market: no clear view, taking the top-down one\n'); best = { cam: [c[0] + 4, c[1] + R + 22, c[2] + 6], look: [c[0], c[1], c[2]] }; }
  shots.push({ name, t, ...best, fov: 52, frames });
};
marketShot('raleigh-market', 1);
add('raleigh-market-browser', pick((i, g) => town(i) === 0 && g?.k === 'act' && g.pose === 'browse'), { dist: 6, height: 2.6, angle: 160 });
add('raleigh-bench', pick((i, g) => town(i) === 0 && g?.k === 'act' && g.pose === 'sit'), { dist: 4.5, height: 1.6, angle: 200, lookUp: 0.8 });
add('raleigh-friends', pick((i, g) => town(i) === 0 && D.agents[i].pal !== undefined && g?.k === 'move' && rt.agents[i].v > 0.5), { dist: 5.5, height: 2.0, angle: 160 });
const dogs = D.agents.map((a: any, i: number) => (a.kind === 'dog' ? a.owner : -1)).filter((x: number) => x >= 0);
for (const o of dogs) add(`${D.agents[o].town === 0 ? 'raleigh' : 'twin'}-dog-walker`, rt.agents[o].visible ? o : -1, { dist: 6, height: 2.4, angle: 35 });
add('twin-market', pick((i, g) => town(i) === 1 && g?.k === 'act' && (g.pose === 'browse' || g.pose === 'tend')), { dist: 8, height: 3.5, angle: 170 });
add('twin-pier', pick((i, g) => g?.k === 'act' && g.pose === 'fish'), { dist: 5, height: 2.0, angle: 140 });
add('raleigh-walkers', pick((i, g) => town(i) === 0 && g?.k === 'move' && rt.agents[i].v > 0.5), { dist: 7, height: 2.2, angle: 0 });
const bus = D.vehicles.findIndex((v: any) => v.kind === 'bus');
if (bus >= 0 && rt.vehicles[bus].visible) shots.push(frame({ name: 'raleigh-bus', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: bus, dist: 16, height: 6, angle: 140, lookUp: 1.5, fov: 50 }));
const car = rt.vehicles.findIndex((v, i) => v.visible && D.vehicles[i].kind === 'car' && D.vehicles[i].town === 0 && v.v > 2);
if (car >= 0) shots.push(frame({ name: 'raleigh-car', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: car, dist: 7, height: 2.2, angle: 70, lookUp: 0.5, fov: 50 }));
// the walk mesh both engines share, from above
shots.push({ name: 'walk-mesh-raleigh', t, cam: [20, 130, 290], look: [0, 0, 170], fov: 50, walk: true });
shots.push({ name: 'walk-mesh-twin', t, cam: [440, 110, 120], look: [380, 0, 0], fov: 50, walk: true });
// the videos: the market (fixed), a dog walker on the move, friends on the street, the twin, the bus, a car
marketShot('video-a-raleigh-market', 240);
for (const o of dogs) {
  const r2 = new LifeRuntime(D);
  r2.init(t, 60);
  let tw = -1;
  for (let k = 0; k < 18000 && tw < 0; k++) { r2.step(); const a = r2.agents[o], g = D.agents[o].plan[a.seg]; if (a.visible && g?.k === 'move' && a.v > 0.8) tw = k + 1; }
  // ff: the engines fast-forward this many ticks after the seek (the same history as this run)
  if (tw > 0) { shots.push(frame({ name: `video-b-${D.agents[o].town === 0 ? 'raleigh' : 'twin'}-dog`, t, ff: tw, cam: [0, 0, 0], look: [0, 0, 0], follow: o, dist: 6.5, height: 2.6, angle: 25, fov: 50, frames: 210 })); break; }
}
const pals = pick((i, g) => town(i) === 0 && D.agents[i].pal !== undefined && g?.k === 'move' && rt.agents[i].v > 0.8);
const walker = pals >= 0 ? pals : pick((i, g) => town(i) === 0 && g?.k === 'move' && rt.agents[i].v > 0.8);
if (walker >= 0) shots.push(frame({ name: 'video-c-raleigh-street', t, cam: [0, 0, 0], look: [0, 0, 0], follow: walker, dist: 8, height: 3.0, angle: 20, fov: 50, frames: 210 }));
const tw2 = pick((i, g) => town(i) === 1 && g?.k === 'move' && rt.agents[i].v > 0.8);
if (tw2 >= 0) shots.push(frame({ name: 'video-d-twin-street', t, cam: [0, 0, 0], look: [0, 0, 0], follow: tw2, dist: 8, height: 3.5, angle: 30, fov: 50, frames: 180 }));
if (car >= 0) shots.push(frame({ name: 'video-e-raleigh-car', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: car, dist: 7, height: 2.4, angle: 60, lookUp: 0.5, fov: 50, frames: 150 }));
if (bus >= 0 && rt.vehicles[bus].visible) shots.push(frame({ name: 'video-f-raleigh-bus', t, cam: [0, 0, 0], look: [0, 0, 0], followVehicle: bus, dist: 18, height: 7, angle: 150, lookUp: 1.5, fov: 50, frames: 150 }));
process.stdout.write(JSON.stringify(shots, null, 1) + '\n');
