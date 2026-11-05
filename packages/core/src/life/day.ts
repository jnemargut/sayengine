// The sped-up headless day (Decision 30): run the baked day through the same runtime the web plays, and
// check what Terrarium got wrong before anyone looks: nobody inside anybody (or a car), nobody walking
// through a wall, no pops, nobody on a red light, the dog at leash length, one sitter per seat, and the
// player bumping into everything (folk step aside, cars brake).
import type { P2 } from '../world/geo.ts';
import type { LifeBake } from './bake.ts';
import { LifeRuntime, LEASH, LIFE_DT, RED } from './runtime.ts';

export interface DayCheck { name: string; pass: boolean; count: number; worst: number; limit: number; unit: string; detail: string; at?: number[] }
export interface DayReport { from: number; to: number; ticks: number; ms: number; checks: DayCheck[]; peak: { folk: number; cars: number }; byHour: number[]; brakesForPlayer: number }

/** A scripted player: a polyline walked at a speed, looping (scene space). */
export interface PlayerScript { pts: P2[]; speed: number; r?: number; from?: number; to?: number }

function playerAt(ps: PlayerScript, t: number): P2 {
  const L: number[] = [0];
  for (let i = 1; i < ps.pts.length; i++) L.push(L[i - 1] + Math.hypot(ps.pts[i][0] - ps.pts[i - 1][0], ps.pts[i][1] - ps.pts[i - 1][1]));
  const total = L[L.length - 1] || 1;
  // there and back
  let s = (t * ps.speed) % (2 * total);
  if (s > total) s = 2 * total - s;
  for (let i = 1; i < L.length; i++) if (s <= L[i]) { const u = (s - L[i - 1]) / (L[i] - L[i - 1] || 1); return [ps.pts[i - 1][0] + (ps.pts[i][0] - ps.pts[i - 1][0]) * u, ps.pts[i - 1][1] + (ps.pts[i][1] - ps.pts[i - 1][1]) * u]; }
  return ps.pts[ps.pts.length - 1];
}

function rectsOverlap(a: { x: number; z: number; yaw: number; l: number; w: number }, b: { x: number; z: number; yaw: number; l: number; w: number }): boolean {
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2].map((y) => [Math.sin(y), Math.cos(y)]);
  const corners = (r: typeof a) => {
    const f = [Math.sin(r.yaw), Math.cos(r.yaw)], s = [f[1], -f[0]];
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([u, v]) => [r.x + f[0] * u * r.l / 2 + s[0] * v * r.w / 2, r.z + f[1] * u * r.l / 2 + s[1] * v * r.w / 2]);
  };
  const A = corners(a), B = corners(b);
  for (const ax of axes) {
    const pa = A.map((p) => p[0] * ax[0] + p[1] * ax[1]), pb = B.map((p) => p[0] * ax[0] + p[1] * ax[1]);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}
function circleInRect(px: number, pz: number, r: number, v: { x: number; z: number; yaw: number; l: number; w: number }): boolean {
  const f = [Math.sin(v.yaw), Math.cos(v.yaw)], dx = px - v.x, dz = pz - v.z;
  const u = dx * f[0] + dz * f[1], w = dx * f[1] - dz * f[0];
  const cu = Math.max(-v.l / 2, Math.min(v.l / 2, u)), cw = Math.max(-v.w / 2, Math.min(v.w / 2, w));
  return (u - cu) * (u - cu) + (w - cw) * (w - cw) < r * r;
}

export function runDay(bake: LifeBake, o: { from?: number; to?: number; player?: PlayerScript | null; sampleEvery?: number } = {}): DayReport {
  const D = bake.data;
  const from = o.from ?? 5 * 3600, to = o.to ?? from + 24 * 3600 - 1;
  const rt = new LifeRuntime(D);
  const t0 = Date.now();
  rt.init(from, 0);
  const every = o.sampleEvery ?? 10;
  const cnt = { slip: 0, overlap: 0, carHit: 0, carCar: 0, wall: 0, offWalk: 0, pop: 0, red: 0, leash: 0, seat: 0, player: 0, playerCar: 0, stuck: 0 };
  const worst = { overlap: 0, pop: 0, leash: 0, player: 0 };
  const at: Record<string, number[]> = {};
  const note = (k: string, t: number) => { (at[k] ??= []).length < 5 && at[k].push(Math.round(t)); };
  const cache = bake.towns.map(() => new Map<number, number>());
  /** 0 walkable, 1 off the walk (road, verge), 2 inside a building. Cached on a 0.2 m grid. */
  const where = (town: number, x: number, z: number) => {
    const T = bake.towns[town], lx = x - T.offset[0], lz = z - T.offset[2];
    const key = Math.round(lx * 5) * 100003 + Math.round(lz * 5);
    let v = cache[town].get(key);
    if (v === undefined) { const p: P2 = [lx, lz]; v = T.ws.walkable(p) ? 0 : T.ws.inBuilding(p, 0) ? 2 : 1; cache[town].set(key, v); }
    return v;
  };
  const prev = rt.agents.map((a) => ({ v: a.visible, x: a.x, z: a.z }));
  const prevV = rt.vehicles.map((v) => ({ v: v.visible, x: v.x, z: v.z, leg: v.leg, s: v.s }));
  const still = rt.vehicles.map(() => 0);
  const byHour = new Array(24).fill(0), seen = new Array(24).fill(0);
  let peakF = 0, peakC = 0, brakes = 0, ticks = 0;
  const pr = o.player?.r ?? 0.4;
  let ps = 0, walkSamples = 0;
  for (let t = from; t < to; t += LIFE_DT) {
    if (o.player && t >= (o.player.from ?? 0) && t < (o.player.to ?? 1e9)) {
      // the scripted player is solid like the game's: a car or a person in the way holds it up
      const p = playerAt(o.player, ps + LIFE_DT);
      let free = true;
      for (let i = 0; i < rt.vehicles.length && free; i++) if (rt.vehicles[i].visible && circleInRect(p[0], p[1], pr, { x: rt.vehicles[i].x, z: rt.vehicles[i].z, yaw: rt.vehicles[i].yaw, l: D.vehicles[i].len, w: D.vehicles[i].wid })) free = false;
      if (free) ps += LIFE_DT;
      const q = playerAt(o.player, ps);
      rt.setPlayer(q[0], q[1], pr, true);
    } else rt.setPlayer(0, 0, pr, false);
    rt.step();
    ticks++;
    const A = rt.agents, V = rt.vehicles;
    if (process.env.LIFE_TRACE) { const [ti, tj, ta, tb] = process.env.LIFE_TRACE.split(',').map(Number); if (t >= ta * 3600 && t < tb * 3600) console.log('T', (t / 3600).toFixed(4), [ti, tj].map((k) => `${k}:${A[k].visible ? 'v' : 'h'} seg${A[k].seg} s${A[k].s.toFixed(2)} lat${A[k].lat.toFixed(2)} v${A[k].v.toFixed(2)} (${A[k].x.toFixed(2)},${A[k].z.toFixed(2)}) ${A[k].wait ? 'W' : ''}`).join(' | ')); }
    // pops: no jump beyond what the body can move in a tick (+0.3 m)
    for (let i = 0; i < A.length; i++) {
      const a = A[i], p = prev[i];
      if (a.visible && p.v) {
        const d = Math.hypot(a.x - p.x, a.z - p.z), lim = (D.agents[i].kind === 'dog' ? 3 : 2) * LIFE_DT + 0.3;
        if (d > lim) { cnt.pop++; worst.pop = Math.max(worst.pop, d); note('pop', t); if (process.env.LIFE_DEBUG && cnt.pop < 8) console.log('POP', (t / 3600).toFixed(4), i, D.agents[i].kind, 'seg', a.seg, (D.agents[i].plan[a.seg] as any)?.k, 's', a.s.toFixed(2), 'lat', a.lat.toFixed(2), d.toFixed(2), 'from', p.x.toFixed(2), p.z.toFixed(2), 'to', a.x.toFixed(2), a.z.toFixed(2)); }
      }
      p.v = a.visible; p.x = a.x; p.z = a.z;
    }
    for (let i = 0; i < V.length; i++) {
      const v = V[i], p = prevV[i];
      if (v.visible && p.v) {
        const d = Math.hypot(v.x - p.x, v.z - p.z);
        if (d > 16 * LIFE_DT + 0.3) { cnt.pop++; worst.pop = Math.max(worst.pop, d); note('pop', t); if (process.env.LIFE_DEBUG) { const tr = rt.tripOf(i)!; console.log('VPOP', (t / 3600).toFixed(4), i, D.vehicles[i].kind, 'leg', p.leg, '->', v.leg, D.edges[tr.edges[p.leg]]?.id, D.edges[tr.edges[v.leg]]?.id, d.toFixed(1), 'trip', v.trip); } }
        // red light: crossing the end of an edge with a stop line while red
        const trip = rt.tripOf(i);
        if (trip && p.leg !== v.leg) {
          const e = D.edges[trip.edges[p.leg]];
          if (e?.stop && rt.signal(e.stop.sig, e.stop.group, t) === RED && rt.signal(e.stop.sig, e.stop.group, t - 3) === RED) { cnt.red++; note('red', t); }
        }
        if (v.v < 0.1) { still[i] += LIFE_DT; if (still[i] > (process.env.LIFE_STUCK ? +process.env.LIFE_STUCK : 150) && still[i] - LIFE_DT <= (process.env.LIFE_STUCK ? +process.env.LIFE_STUCK : 150)) { cnt.stuck++; note('stuck', t); if (process.env.LIFE_DEBUG && cnt.stuck < 30) { const tr = rt.tripOf(i)!; const e = D.edges[tr.edges[v.leg]]; const near = V.map((o, k) => ({ k, d: Math.hypot(o.x - v.x, o.z - v.z), o })).filter((q) => q.k !== i && q.o.visible && q.d < 15).map((q) => q.k + '@' + D.edges[rt.tripOf(q.k)!.edges[q.o.leg]].id + ':' + q.o.s.toFixed(1) + ':v' + q.o.v.toFixed(1)); const pe = A.map((o, k) => ({ k, d: Math.hypot(o.x - v.x, o.z - v.z), o })).filter((q) => q.o.visible && q.d < 8).map((q) => q.k + (q.o.wait ? 'W' : '') + ':v' + q.o.v.toFixed(1)); console.log('STUCK', (t / 3600).toFixed(4), i, D.vehicles[i].kind, e.id, 's', v.s.toFixed(1), 'len', rt.edges[tr.edges[v.leg]].len.toFixed(1), 'stop', e.stop ? rt.signal(e.stop.sig, e.stop.group, t) : '-', 'next', D.edges[tr.edges[v.leg + 1]]?.id, 'cars', near.join(' '), 'folk', pe.join(' '), v.brake); } } } else still[i] = 0;
      } else still[i] = 0;
      p.v = v.visible; p.x = v.x; p.z = v.z; p.leg = v.leg; p.s = v.s;
    }
    if (ticks % every) continue;
    // overlaps between people (a dog may brush its walker)
    let nf = 0;
    for (let i = 0; i < A.length; i++) {
      if (!A[i].visible) continue;
      if (D.agents[i].kind === 'person') nf++;
      for (let j = i + 1; j < A.length; j++) {
        if (!A[j].visible || D.agents[j].owner === i || D.agents[i].owner === j) continue;
        if (A[i].slip > rt.t && A[j].slip > rt.t) { if (Math.hypot(A[i].x - A[j].x, A[i].z - A[j].z) < D.agents[i].r + D.agents[j].r - 0.08) cnt.slip++; continue; }
        const d = Math.hypot(A[i].x - A[j].x, A[i].z - A[j].z), lim = D.agents[i].r + D.agents[j].r - 0.08;
        if (d < lim) {
          cnt.overlap++; worst.overlap = Math.max(worst.overlap, lim - d); note('overlap', t);
          if (process.env.LIFE_DEBUG && cnt.overlap < 6) { const gi = D.agents[i].plan[A[i].seg] as any, gj = D.agents[j].plan[A[j].seg] as any; console.log('OVERLAP', (t / 3600).toFixed(3), i, j, d.toFixed(2), gi?.k, gi?.pose ?? '', A[i].pose, A[i].slot, gj?.k, gj?.pose ?? '', A[j].pose, A[j].slot, A[i].x.toFixed(1), A[i].z.toFixed(1), A[i].v.toFixed(2), A[j].v.toFixed(2), A[i].blocked.toFixed(1), A[j].blocked.toFixed(1)); }
        }
      }
      // walls: never inside a building; off the walk only on a crossing
      if (D.agents[i].kind === 'person') {
        const g = D.agents[i].plan[A[i].seg];
        if (g && g.k === 'move' && rt.t - A[i].moveStart > 0.8) {
          const w = where(D.agents[i].town ?? 0, A[i].x, A[i].z);
          walkSamples++;
          if (w === 2) { cnt.wall++; note('wall', t); } else if (w === 1) { cnt.offWalk++; note('offWalk', t); }
          if (process.env.LIFE_DEBUG && w > 0 && cnt.offWalk + cnt.wall < 12) console.log('OFF', w, (t / 3600).toFixed(4), i, 'seg', A[i].seg, 's', A[i].s.toFixed(2), 'lat', A[i].lat.toFixed(2), 'v', A[i].v.toFixed(2), A[i].x.toFixed(2), A[i].z.toFixed(2), 'blk', A[i].blocked.toFixed(1), 'k', ((t - A[i].moveStart) / 0.8).toFixed(2));
        }
      } else {
        const ow = D.agents[i].owner!;
        const d = Math.hypot(A[i].x - A[ow].x, A[i].z - A[ow].z);
        if (d > LEASH.max + 0.05 || d < LEASH.min - 0.05) { cnt.leash++; worst.leash = Math.max(worst.leash, d); note('leash', t); }
        const w = where(D.agents[i].town ?? 0, A[i].x, A[i].z);
        if (w === 2) { cnt.wall++; note('wall', t); }
      }
      if (rt.player.on) {
        const d = Math.hypot(A[i].x - rt.player.x, A[i].z - rt.player.z), lim = D.agents[i].r + pr - 0.08;
        if (d < lim) { cnt.player++; worst.player = Math.max(worst.player, lim - d); note('player', t); }
      }
    }
    // one sitter per seat
    const seat = new Map<number, number>();
    for (let i = 0; i < A.length; i++) { const g = D.agents[i].plan[A[i].seg]; if (A[i].visible && g && g.k === 'act' && A[i].slot >= 0) { if (seat.has(A[i].slot)) { cnt.seat++; note('seat', t); } seat.set(A[i].slot, i); } }
    // vehicles against vehicles, folk and the player
    let nc = 0;
    const box = (i: number) => ({ x: V[i].x, z: V[i].z, yaw: V[i].yaw, l: D.vehicles[i].len, w: D.vehicles[i].wid });
    for (let i = 0; i < V.length; i++) {
      if (!V[i].visible) continue;
      nc++;
      if (V[i].brake && rt.player.on && Math.hypot(V[i].x - rt.player.x, V[i].z - rt.player.z) < 25) brakes++;
      const bi = box(i);
      for (let j = i + 1; j < V.length; j++) if (V[j].visible && Math.hypot(V[i].x - V[j].x, V[i].z - V[j].z) < 14 && rectsOverlap(bi, box(j))) { cnt.carCar++; note('carCar', t); if (process.env.LIFE_DEBUG && cnt.carCar < 6) { const ti = rt.tripOf(i)!, tj = rt.tripOf(j)!; console.log('CARCAR', (t / 3600).toFixed(4), i, j, V[j].x.toFixed(1), V[j].z.toFixed(1), (V[i].yaw * 57.3).toFixed(0), (V[j].yaw * 57.3).toFixed(0), 'edges', D.edges[ti.edges[V[i].leg]].id, D.edges[tj.edges[V[j].leg]].id, 's', V[i].s.toFixed(1), V[j].s.toFixed(1), 'v', V[i].v.toFixed(1), V[j].v.toFixed(1), V[i].x.toFixed(1), V[i].z.toFixed(1)); } }
      for (let j = 0; j < A.length; j++) if (A[j].visible && Math.hypot(V[i].x - A[j].x, V[i].z - A[j].z) < 8 && circleInRect(A[j].x, A[j].z, D.agents[j].r - 0.05, bi)) { cnt.carHit++; note('carHit', t); if (process.env.LIFE_DEBUG && cnt.carHit < 6) { const g = D.agents[j].plan[A[j].seg] as any; console.log('CARHIT', (t / 3600).toFixed(4), 'veh', i, 'v', V[i].v.toFixed(1), 'brake', V[i].brake, 'agent', j, D.agents[j].kind, g?.k, g?.pose, A[j].pose, 'wait', A[j].wait, A[j].x.toFixed(1), A[j].z.toFixed(1), 'edge', D.edges[rt.tripOf(i)!.edges[V[i].leg]].id); } }
      if (rt.player.on && circleInRect(rt.player.x, rt.player.z, pr - 0.05, bi)) { cnt.playerCar++; note('playerCar', t); if (process.env.LIFE_DEBUG && cnt.playerCar < 4) console.log('PLAYERCAR', (t / 3600).toFixed(4), i, V[i].v.toFixed(1), V[i].brake, rt.player.x.toFixed(1), rt.player.z.toFixed(1)); }
    }
    const h = Math.floor((t / 3600) % 24);
    byHour[h] += nf; seen[h]++;
    peakF = Math.max(peakF, nf); peakC = Math.max(peakC, nc);
  }
  const mk = (name: string, k: keyof typeof cnt, limit: number, unit: string, detail: string, w?: number): DayCheck => ({ name, pass: cnt[k] <= limit, count: cnt[k], worst: +(w ?? 0).toFixed(3), limit, unit, detail, ...(at[k] ? { at: at[k] } : {}) });
  const checks: DayCheck[] = [
    mk('no two folk in one spot', 'overlap', 0, 'samples', 'people closer than their two radii', worst.overlap),
    mk('few squeeze-pasts', 'slip', Math.ceil(ticks / every / 60), 'samples', 'two folk face to face in a pinch slipping past each other (shoulders through shoulders for a moment; at most one sample a minute)'),
    mk('nobody inside a building', 'wall', 0, 'samples', 'a walking person (or a dog) inside a footprint'),
    mk('folk stay on the walk', 'offWalk', Math.ceil(walkSamples * 0.0003), 'samples', 'a walking person off the sidewalks, plazas and crossings (a few grazes at corners allowed)'),
    mk('no pops', 'pop', 0, 'ticks', 'no jump beyond the body\'s speed + 0.3 m in a 0.1 s tick', worst.pop),
    mk('no car hits anyone', 'carHit', 0, 'samples', 'a person inside a car\'s footprint'),
    mk('no two cars in one spot', 'carCar', 0, 'samples', 'two vehicle footprints overlapping'),
    mk('nobody runs a red', 'red', 0, 'crossings', 'a vehicle crossing its stop line after 3 s of red'),
    mk('no gridlock', 'stuck', 0, 'vehicles', 'a vehicle stopped for more than 150 s'),
    mk('dog at leash length', 'leash', 0, 'samples', `the dog stays ${LEASH.min}–${LEASH.max} m from its walker`, worst.leash),
    mk('one sitter per seat', 'seat', 0, 'samples', 'two people in one slot'),
    mk('folk make room for the player', 'player', 0, 'samples', 'a person inside the player', worst.player),
    mk('cars brake for the player', 'playerCar', 0, 'samples', 'the player inside a car\'s footprint'),
  ];
  return { from, to, ticks, ms: Date.now() - t0, checks, peak: { folk: peakF, cars: peakC }, byHour: byHour.map((v, i) => +(v / Math.max(1, seen[i])).toFixed(1)), brakesForPlayer: brakes };
}
