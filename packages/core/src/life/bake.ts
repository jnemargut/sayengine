// The life bake (Decision 30): smart places, a seeded cast and its day, cars and a bus, all from the town
// plans, written once as life.json for both engines. "Dumb people, smart places": a bench says "sit ×2",
// a stall "browse ×2 + tend", a pier "fish ×2", a park "walk the dog", a bus stop "wait ×3", a door
// "come and go". The cast is drawn from the studio's characters; the schedule follows the hour, the
// season and the day's event, so the same seed always plays the same Saturday.
import type { TownPlan } from '../world/plan.ts';
import { pointInPoly, rng, hash32, type P2 } from '../world/geo.ts';
import { WalkSpace, findJunctions, carLanes, walkGraph, shortestWalk, edgeBetween, components, alongLine, lineLength, nearestOn, isCar, type Junction, type CarEdge, type WalkGraph, type Rect } from './nav.ts';
import { LIFE_DT, type LifeData, type LifeSeg, type LifeAgent, type LifeVehicle, type LifeSignal, type LifeEdge, type LifeCross } from './runtime.ts';

export interface CastModel { id: string; kind: 'person' | 'dog' | 'car' | 'bus'; height?: number; sits?: boolean; speed?: [number, number]; walkSpeed?: number; len?: number; wid?: number; label?: string }
export interface LifeOptions {
  seed: number;
  day?: 'saturday' | 'sunday' | 'weekday';
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
  event?: 'market' | null;          // a Saturday market on the plaza / the green, 8:00–13:00
  start?: number;                   // the hour the games open on (e.g. 10.6 = 10:36)
  folk?: number[];                  // cast size per town
  pairs?: number;                   // share of folk who go out with a friend (walk side by side, chat at benches)
  cars?: number[];                  // cars per town
  bus?: boolean;
  busTowns?: number[];              // which towns run a bus (default: the first)
  dogs?: number[];                  // dog walkers per town
  models: CastModel[];
}

export interface Slot { id: number; at: P2; y: number; face: number; pose: string; approach: number; busy: Array<[number, number]> }
export interface Place { id: string; town: number; kind: 'bench' | 'stall' | 'pier' | 'park' | 'busstop' | 'door'; at: P2; y: number; yaw: number; offers: Array<{ action: string; who: 'person' | 'dog' | 'pair'; slots: number }>; slots: Slot[]; node: number; nodes?: number[] }
export interface Prop { kind: 'stall' | 'pier' | 'busstop' | 'signal' | 'rod'; at: [number, number, number]; yaw: number; size?: [number, number]; colour?: string; sig?: number; group?: number; town: number }
export interface CastMember { id: string; town: number; model: string; scale: number; speed: number; home: string; role: string; outings: number }

export interface LifeBake {
  data: LifeData;
  places: Place[];
  props: Prop[];
  cast: CastMember[];
  walk: Array<{ kind: string; town: number; poly: number[] }>;       // flat x,y,z (scene space)
  stats: Record<string, number>;
  towns: Array<{ ws: WalkSpace; graph: WalkGraph; junctions: Junction[]; lanes: CarEdge[]; offset: [number, number, number] }>;
}

const HOURS: Record<string, number[]> = {
  //            0     1     2     3     4     5     6     7     8     9    10    11    12    13    14    15    16    17    18    19    20    21    22    23
  saturday: [0.02, 0.01, 0.0, 0.0, 0.0, 0.01, 0.04, 0.12, 0.4, 0.75, 1.0, 1.0, 0.95, 0.85, 0.75, 0.7, 0.65, 0.55, 0.42, 0.32, 0.22, 0.14, 0.07, 0.03],
  sunday: [0.03, 0.01, 0.0, 0.0, 0.0, 0.0, 0.02, 0.06, 0.2, 0.45, 0.75, 0.85, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5, 0.35, 0.25, 0.15, 0.08, 0.04, 0.02],
  weekday: [0.01, 0.0, 0.0, 0.0, 0.0, 0.02, 0.08, 0.55, 1.0, 0.6, 0.45, 0.55, 0.9, 0.7, 0.45, 0.45, 0.6, 0.95, 0.6, 0.35, 0.2, 0.1, 0.05, 0.02],
};
const SEASON: Record<string, { scale: number; dusk: number }> = { spring: { scale: 1, dusk: 19.5 }, summer: { scale: 1.1, dusk: 20.5 }, autumn: { scale: 0.9, dusk: 17.3 }, winter: { scale: 0.65, dusk: 17.2 } };
const MARKET: [number, number] = [8, 13];

/** Hourly density of people out, with the season's dusk (fewer after dark) and the day. */
export function density(o: LifeOptions, hour: number): number {
  const h = HOURS[o.day ?? 'saturday'], s = SEASON[o.season ?? 'autumn'];
  const i = Math.floor(((hour % 24) + 24) % 24), f = hour - Math.floor(hour);
  let d = h[i] * (1 - f) + h[(i + 1) % 24] * f;
  if (hour > s.dusk + 1) d *= 0.7;
  return d * s.scale;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function bakeLife(towns: Array<{ plan: TownPlan; offset?: [number, number, number] }>, o: LifeOptions): LifeBake {
  const R = rng(o.seed * 7919 + 17);
  const pick = <T>(a: T[]) => a[Math.floor(R() * a.length)];
  const between = (a: number, b: number) => a + (b - a) * R();
  const places: Place[] = [], props: Prop[] = [], cast: CastMember[] = [];
  const slots: Slot[] = [];
  const signals: LifeSignal[] = [];
  const edges: LifeEdge[] = [];
  const paths: number[][] = [];
  const agents: LifeAgent[] = [];
  const vehicles: LifeVehicle[] = [];
  const walk: LifeBake['walk'] = [];
  const outTowns: LifeBake['towns'] = [];
  const stats: Record<string, number> = { places: 0, benches: 0, stalls: 0, piers: 0, busStops: 0, doors: 0, walkNodes: 0, walkEdges: 0, crossings: 0, carEdges: 0, signals: 0, folk: 0, dogs: 0, cars: 0, buses: 0, trips: 0, outings: 0 };
  const folkModels = o.models.filter((m) => m.kind === 'person');
  const dogModels = o.models.filter((m) => m.kind === 'dog');
  const carModels = o.models.filter((m) => m.kind === 'car');
  const busModels = o.models.filter((m) => m.kind === 'bus');
  const market = o.event === 'market' && (o.day ?? 'saturday') !== 'weekday';

  towns.forEach((T, ti) => {
    const plan = T.plan, off = T.offset ?? [0, 0, 0];
    const X = (p: P2): P2 => [p[0] + off[0], p[1] + off[2]];
    const ws = new WalkSpace(plan);
    const junctions = findJunctions(ws.cars);
    // signals at every real crossroads (both groups present)
    for (const J of junctions) {
      if (!(J.groups.includes(0) && J.groups.includes(1))) continue;
      J.sig = signals.length;
      const g0 = 22 + Math.floor(R() * 6), g1 = 18 + Math.floor(R() * 6);
      signals.push({ id: `${ti}:${J.id}`, at: X(J.at), cycle: g0 + g1 + 10, offset: Math.floor(R() * 40), green: [g0, g1], amber: 3, allRed: 2 });
    }
    stats.signals += junctions.filter((J) => J.sig >= 0).length;
    const lanes = carLanes(ws, junctions, { speed: plan.source === 'real' ? 11 : 8.5 });

    // ── smart places that change the walk space first: benches (as the world draws them), stalls, piers ──
    const extra: Array<{ p: P2; chain: number }> = [];
    const pending: Array<{ place: Omit<Place, 'node' | 'slots'> & { slots: Array<Omit<Slot, 'approach' | 'id' | 'busy'> & { appr: P2 }> }; appr: P2 }> = [];
    // benches: the same spots the world's street furniture uses (mesh.ts streetLights)
    for (const s of plan.streets) {
      if (!(['primary', 'secondary', 'tertiary'].includes(s.kind) || (s.kind === 'residential' && s.sidewalk >= 4.5)) || !s.sidewalk) continue;
      if (s.sidewalk < 4.5) continue;
      const spacing = 26;
      let d = spacing / 2 + 4, acc = 0;
      const pts = s.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (d < acc + l) {
          const t = (d - acc) / l, p: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const side = Math.round(d / spacing) % 2 ? 1 : -1;
          const nn: P2 = [-(b[1] - a[1]) / l * side, (b[0] - a[0]) / l * side];
          const q: P2 = [p[0] + nn[0] * (s.width / 2 + 0.6), p[1] + nn[1] * (s.width / 2 + 0.6)];
          const along2: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
          const pq: P2 = [q[0] + along2[0] * 6 + nn[0] * 0.6, q[1] + along2[1] * 6 + nn[1] * 0.6];
          // not at a corner: a bench there sits in the crosswalk's path (folk crossing would walk into the sitter)
          const okP = junctions.every((J) => Math.hypot(J.at[0] - pq[0], J.at[1] - pq[1]) > 15) && plan.buildings.every((bb) => !pointInPoly(pq, bb.footprint) && nearestOn([...bb.footprint, bb.footprint[0]], pq).d > 1.5) && plan.streets.every((oo) => oo === s || oo.kind === 'footway' || nearestOn(oo.points, pq).d > oo.width / 2 + 1);
          if (okP) {
            const bq: P2 = [pq[0] + along2[0] * 3, pq[1] + along2[1] * 3];
            ws.blocked.push({ c: pq, dir: along2, len: 2.2, wid: 1.0 }, { c: [bq[0] - nn[0] * 0.1, bq[1] - nn[1] * 0.1], dir: along2, len: 1.8, wid: 0.6 });
            ws.blocked.push({ c: q, dir: along2, len: 0.3, wid: 0.3 });
            const face = Math.atan2(nn[0], nn[1]);
            const appr: P2 = [bq[0] + nn[0] * 1.15, bq[1] + nn[1] * 1.15];
            pending.push({
              appr,
              place: { id: `bench:${ti}:${pending.length}`, town: ti, kind: 'bench', at: bq, y: 0, yaw: face, offers: [{ action: 'sit', who: 'person', slots: 2 }],
                slots: [-1, 1].map((k) => ({ at: [bq[0] + along2[0] * 0.45 * k + nn[0] * 0.18, bq[1] + along2[1] * 0.45 * k + nn[1] * 0.18] as P2, y: 0, face, pose: 'sit', appr: [appr[0] + along2[0] * 0.45 * k, appr[1] + along2[1] * 0.45 * k] as P2 })) },
            });
            stats.benches++;
          }
          d += spacing;
        }
        acc += l;
      }
    }
    // market stalls on the plaza / the green, facing its middle
    if (market) {
      const parks = plan.areas.filter((a) => a.kind === 'park' || a.kind === 'plaza').sort((a, b) => polyArea(b.polygon) - polyArea(a.polygon));
      const want = plan.source === 'real' ? 6 : 4;
      const chosen: P2[] = [];
      for (const pk of parks.slice(0, 1)) {
        const c = centroidOf(pk.polygon);
        const cand: P2[] = [];
        const mn = [Math.min(...pk.polygon.map((p) => p[0])), Math.min(...pk.polygon.map((p) => p[1]))], mx = [Math.max(...pk.polygon.map((p) => p[0])), Math.max(...pk.polygon.map((p) => p[1]))];
        for (let x = mn[0]; x <= mx[0]; x += 2) for (let z = mn[1]; z <= mx[1]; z += 2) {
          const p: P2 = [x, z];
          if (!pointInPoly(p, pk.polygon)) continue;
          const f = norm([c[0] - x, c[1] - z]);
          if (!ws.walkable(p) || ws.freeHalf(p, f, 3.2) < 3 || ws.freeHalf(p, [-f[1], f[0]], 3.2) < 3) continue;
          cand.push(p);
        }
        // a market square: a ring of stalls about 8 m out from the middle, facing in (a lively cluster, not
        // strung along the plaza's edge by the buildings)
        cand.sort((a, b) => Math.abs(Math.hypot(a[0] - c[0], a[1] - c[1]) - 8) - Math.abs(Math.hypot(b[0] - c[0], b[1] - c[1]) - 8) + (R() - 0.5) * 3);
        for (const p of cand) {
          if (chosen.length >= want) break;
          if (chosen.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 6.5)) continue;
          chosen.push(p);
        }
        const colours = ['#c8463a', '#2f6f9f', '#d9a03a', '#3f7a4a', '#8a4a7a', '#e07a2a'];
        chosen.forEach((p, k) => {
          const f = norm([c[0] - p[0], c[1] - p[1]]), sd: P2 = [-f[1], f[0]];
          const face = Math.atan2(f[0], f[1]);
          ws.blocked.push({ c: p, dir: sd, len: 2.6, wid: 1.4 });
          const vend: P2 = [p[0] - f[0] * 1.35, p[1] - f[1] * 1.35];
          const appr: P2 = [p[0] + f[0] * 2.6, p[1] + f[1] * 2.6];
          pending.push({
            appr,
            place: { id: `stall:${ti}:${k}`, town: ti, kind: 'stall', at: p, y: 0, yaw: face, offers: [{ action: 'browse', who: 'person', slots: 2 }, { action: 'tend', who: 'person', slots: 1 }],
              slots: [
                { at: [p[0] + f[0] * 1.5 + sd[0] * 0.6, p[1] + f[1] * 1.5 + sd[1] * 0.6], y: 0, face: face + Math.PI, pose: 'browse', appr: [appr[0] + sd[0] * 0.6, appr[1] + sd[1] * 0.6] },
                { at: [p[0] + f[0] * 1.5 - sd[0] * 0.6, p[1] + f[1] * 1.5 - sd[1] * 0.6], y: 0, face: face + Math.PI, pose: 'browse', appr: [appr[0] - sd[0] * 0.6, appr[1] - sd[1] * 0.6] },
                { at: vend, y: 0, face, pose: 'tend', appr: [vend[0] + sd[0] * 1.8, vend[1] + sd[1] * 1.8] },
              ] },
          });
          props.push({ kind: 'stall', at: [p[0] + off[0], 0, p[1] + off[2]], yaw: face, size: [2.6, 1.4], colour: colours[k % colours.length], town: ti });
          stats.stalls++;
        });
      }
    }
    // piers off a riverside walk, out over the water
    const river = plan.areas.find((a) => a.kind === 'river' || a.kind === 'water');
    if (river) {
      const walkS = plan.streets.find((s) => s.kind === 'pedestrian' && s.points.some((p) => nearestOn([...river.polygon, river.polygon[0]], p).d < 25));
      if (walkS) {
        const L = lineLength(walkS.points);
        for (const f of [0.3, 0.68]) {
          const { p, dir } = alongLine(walkS.points, L * f);
          let n: P2 = [-dir[1], dir[0]];
          if (!pointInPoly([p[0] + n[0] * 14, p[1] + n[1] * 14], river.polygon)) n = [-n[0], -n[1]];
          let len = 10;
          while (len < 18 && !pointInPoly([p[0] + n[0] * (walkS.width / 2 + len - 1.5), p[1] + n[1] * (walkS.width / 2 + len - 1.5)], river.polygon)) len += 1;
          const c: P2 = [p[0] + n[0] * (walkS.width / 2 + len / 2 - 0.3), p[1] + n[1] * (walkS.width / 2 + len / 2 - 0.3)];
          const rect: Rect = { c, dir: n, len: len + 0.6, wid: 2.4 };
          ws.piers.push(rect);
          for (const dd of [walkS.width / 2 - 1.5, walkS.width / 2 + 2.5, walkS.width / 2 + 5.5]) extra.push({ p: [p[0] + n[0] * dd, p[1] + n[1] * dd], chain: -1 });
          const end: P2 = [c[0] + n[0] * (len / 2 - 0.8), c[1] + n[1] * (len / 2 - 0.8)];
          const face = Math.atan2(n[0], n[1]);
          const appr: P2 = [c[0] + n[0] * (len / 2 - 2.6), c[1] + n[1] * (len / 2 - 2.6)];
          pending.push({
            appr,
            place: { id: `pier:${ti}:${ws.piers.length - 1}`, town: ti, kind: 'pier', at: end, y: 0, yaw: face, offers: [{ action: 'fish', who: 'person', slots: 2 }],
              slots: [-1, 1].map((k) => ({ at: [end[0] - n[1] * 0.55 * k, end[1] + n[0] * 0.55 * k] as P2, y: 0, face, pose: 'fish', appr: [appr[0] - n[1] * 0.55 * k, appr[1] + n[0] * 0.55 * k] as P2 })) },
          });
          props.push({ kind: 'pier', at: [c[0] + off[0], 0, c[1] + off[2]], yaw: face, size: [len + 0.6, 2.4], town: ti });
          // (the anglers bring their own rods: the cast holds one in the right hand, shown while fishing)
          stats.piers++;
        }
        const ny = nearestOn(walkS.points, ws.piers[0].c);
        const hs = walkS.heights ?? walkS.points.map(() => 0);
        ws.pierY = hs[ny.i] + 0.33;
        for (const pr of props) if ((pr.kind === 'pier' || pr.kind === 'rod') && pr.town === ti) pr.at[1] = ws.pierY;
      }
    }

    // ── bus loop and its stops (they need the lanes) ──
    const laneById = new Map(lanes.map((e) => [e.id, e]));
    let busLoop: number[] | null = null;
    if (o.bus !== false && busModels.length && (o.busTowns ?? [0]).includes(ti)) {
      const prefer = (e: CarEdge) => (/fayetteville|main/i.test(ws.cars[e.street].name ?? '') ? 0 : 1);
      const starts = lanes.filter((e) => e.kind === 'lane' && e.from >= 0 && e.to >= 0 && lenOf(e) > 30).sort((a, b) => prefer(a) - prefer(b) || lenOf(b) - lenOf(a));
      for (const s0 of starts.slice(0, 30)) {
        const loop = findLoop(s0, laneById);
        if (loop && loop.length >= 6) { busLoop = loop; break; }
      }
    }
    const busStopsOnEdge = new Map<number, number[]>();
    if (busLoop) {
      const used = new Set<number>();
      for (const id of busLoop) {
        const e = laneById.get(id)!;
        if (e.kind !== 'lane' || lenOf(e) < 34 || used.has(e.street) || busStopsOnEdge.size >= 3) continue;
        const s = ws.cars[e.street];
        const sAt = lenOf(e) * 0.55;
        const P = ptAlong(e.pts, sAt), D = dirAlong(e.pts, sAt);
        const rgt: P2 = [-D[1], D[0]];
        const side = s.width / 4 + 0.35 + Math.min(1.1, s.sidewalk / 2);
        const at: P2 = [P[0] + rgt[0] * side, P[2] + rgt[1] * side];
        if (!ws.walkable(at)) continue;
        used.add(e.street);
        busStopsOnEdge.set(id, [sAt]);
        const face = Math.atan2(-rgt[0], -rgt[1]);
        const back: P2 = [at[0] + rgt[0] * 0.5, at[1] + rgt[1] * 0.5];
        pending.push({
          appr: [at[0] + rgt[0] * 1.2, at[1] + rgt[1] * 1.2],
          place: { id: `busstop:${ti}:${busStopsOnEdge.size - 1}`, town: ti, kind: 'busstop', at, y: 0, yaw: face, offers: [{ action: 'wait-bus', who: 'person', slots: 3 }],
            slots: [-1, 0, 1].map((k) => ({ at: [back[0] + D[0] * 1.0 * k, back[1] + D[1] * 1.0 * k] as P2, y: 0, face, pose: 'wait', appr: [at[0] + rgt[0] * 1.6 + D[0] * 1.0 * k, at[1] + rgt[1] * 1.6 + D[1] * 1.0 * k] as P2 })) },
        });
        props.push({ kind: 'busstop', at: [at[0] + rgt[0] * 0.9 + D[0] * 2.2 + off[0], 0, at[1] + rgt[1] * 0.9 + D[1] * 2.2 + off[2]], yaw: face, town: ti });
        stats.busStops++;
      }
    }

    // doors: where folk come out of the buildings
    const doors: Array<{ at: P2; face: number; id: string }> = [];
    for (const b of plan.buildings) {
      if (b.hidden || b.use === 'parking') continue;
      let best: { at: P2; face: number; d: number } | null = null;
      for (let i = 0; i < b.footprint.length; i++) {
        const a = b.footprint[i], c = b.footprint[(i + 1) % b.footprint.length], l = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (l < 5) continue;
        const m: P2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        let n: P2 = [-(c[1] - a[1]) / l, (c[0] - a[0]) / l];
        if (pointInPoly([m[0] + n[0] * 0.5, m[1] + n[1] * 0.5], b.footprint)) n = [-n[0], -n[1]];
        const at: P2 = [m[0] + n[0] * 1.0, m[1] + n[1] * 1.0];
        if (!ws.walkable(at) || ws.inPoly(at, ws.parks)) continue;
        const sd = Math.min(...ws.walkers.map((s) => nearestOn(s.points, at).d));
        if (!best || sd < best.d) best = { at, face: Math.atan2(n[0], n[1]), d: sd };
      }
      if (best) doors.push({ at: best.at, face: best.face, id: `door:${ti}:${doors.length}` });
    }

    const skipExtra = extra.length;     // pier walkway nodes come first
    for (const pd of pending) for (const sl of pd.place.slots) extra.push({ p: sl.appr, chain: -1 });
    for (const d of doors) extra.push({ p: d.at, chain: -1 });
    const graph = walkGraph(ws, junctions, extra);
    ws.freeze();
    // the extra nodes are the last ones, in order
    let xi = graph.nodes.length - extra.length + skipExtra;
    const ws2 = ws;
    // only the main walkable network counts (islands are dropped, so nobody is stranded)
    const comp = components(graph.nodes.length, graph.edges);
    const csize = new Map<number, number>();
    for (const c of comp) csize.set(c, (csize.get(c) ?? 0) + 1);
    const mainC = [...csize.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const reach = (n: number) => graph.adj[n].length > 0 && comp[n] === mainC;
    for (const pd of pending) {
      const ss: Slot[] = [];
      for (const sl of pd.place.slots) {
        const nid = xi++;
        if (!reach(nid)) continue;
        const slot: Slot = { id: slots.length, at: X(sl.at), y: ws2.heightAt(sl.at) + (pd.place.kind === 'pier' ? 0 : 0), face: sl.face, pose: sl.pose, approach: nid, busy: [] };
        if (pd.place.kind === 'pier') slot.y = ws2.pierY;
        slots.push(slot); ss.push(slot);
      }
      if (!ss.length) continue;
      places.push({ ...pd.place, at: X(pd.place.at), y: ws2.heightAt(pd.place.at), slots: ss, node: ss[0].approach });
    }
    const doorPlaces: Place[] = [];
    for (const d of doors) {
      const nid = xi++;
      if (!reach(nid)) continue;
      const pl: Place = { id: d.id, town: ti, kind: 'door', at: X(d.at), y: graph.nodes[nid].y, yaw: d.face, offers: [{ action: 'come-and-go', who: 'person', slots: 0 }], slots: [], node: nid };
      places.push(pl); doorPlaces.push(pl);
    }
    // parks: dog walks (a loop of park nodes)
    const parkNodes = graph.nodes.filter((n) => n.park && reach(n.id));
    if (parkNodes.length >= 4) {
      const c = parkNodes.reduce((s, n) => [s[0] + n.p[0] / parkNodes.length, s[1] + n.p[1] / parkNodes.length], [0, 0]);
      places.push({ id: `park:${ti}`, town: ti, kind: 'park', at: X(c as P2), y: graph.nodes[parkNodes[0].id].y, yaw: 0, offers: [{ action: 'walk-dog', who: 'pair', slots: 0 }, { action: 'stroll', who: 'person', slots: 0 }], slots: [], node: parkNodes[0].id, nodes: parkNodes.map((n) => n.id) });
    }
    stats.doors += doorPlaces.length;
    stats.walkNodes += graph.nodes.length; stats.walkEdges += graph.edges.length; stats.crossings += graph.edges.filter((e) => e.cross).length;

    // ── car edges into the runtime table (scene space), with stop lines and bus stops ──
    const edgeBase = edges.length;
    for (const e of lanes) {
      const le: LifeEdge = { id: `${ti}:${e.id}`, pts: e.pts.flatMap((p) => [r2(p[0] + off[0]), r2(p[1] + off[1]), r2(p[2] + off[2])]), speed: e.speed };
      if (e.kind === 'lane' && e.to >= 0) {
        const J = junctions[e.to];
        if (J.sig >= 0) {
          let gi = -1, best = -2;
          J.arms.forEach((a, ai) => { if (a.street === e.street) { const d = -(a.dir[0] * e.endDir[0] + a.dir[1] * e.endDir[1]); if (d > best) { best = d; gi = ai; } } });
          if (gi >= 0) le.stop = { sig: J.sig, group: J.groups[gi] };
        }
      }
      const bs = busStopsOnEdge.get(e.id);
      if (bs) le.bus = bs.map(r2);
      edges.push(le);
    }
    stats.carEdges += lanes.length;
    // turns through the same junction that cross or merge: only one at a time (the junction box)
    const turns = lanes.filter((e) => e.kind === 'turn');
    for (const a of turns) {
      const conf: number[] = [];
      for (const b of turns) {
        if (a === b || a.from !== b.from || a.from < 0) continue;
        let near = a.turnOf![1] === b.turnOf![1];
        for (let i = 0; !near && i < a.pts.length; i++) for (let j = 0; j < b.pts.length; j++) if (Math.hypot(a.pts[i][0] - b.pts[j][0], a.pts[i][2] - b.pts[j][2]) < 3.3) { near = true; break; }
        if (near) conf.push(edgeBase + b.id);
      }
      if (conf.length) edges[edgeBase + a.id].conf = conf;
      edges[edgeBase + a.id].turn = true;
      if (a.from >= 0) edges[edgeBase + a.id].jn = ti * 1000 + a.from;
    }
    // signal heads at each stop line, on the right-hand curb
    for (const e of lanes) {
      const le = edges[edgeBase + e.id];
      if (!le.stop) continue;
      const P = e.pts[e.pts.length - 1], D = e.endDir, s = ws.cars[e.street];
      const side = s.width / 4 + 0.6;
      props.push({ kind: 'signal', at: [r2(P[0] - D[1] * side + off[0]), r2(P[1] + 0.12 + off[1]), r2(P[2] + D[0] * side + off[2])], yaw: Math.atan2(-D[0], -D[1]), sig: le.stop.sig, group: le.stop.group, town: ti });
    }

    // walk polygons for both engines
    for (const wp of ws.polygons()) {
      walk.push({ kind: wp.kind, town: ti, poly: wp.poly.flatMap((p) => [r2(p[0] + off[0]), r2((wp.kind === 'pier' ? ws.pierY : ws.heightAt(p)) + 0.03 + off[1]), r2(p[1] + off[2])]) });
    }

    outTowns.push({ ws, graph, junctions, lanes, offset: off });

    // ── the cast and their day ──
    const townPlaces = places.filter((p) => p.town === ti);
    const benches = townPlaces.filter((p) => p.kind === 'bench'), stalls = townPlaces.filter((p) => p.kind === 'stall'), piers = townPlaces.filter((p) => p.kind === 'pier'), stops = townPlaces.filter((p) => p.kind === 'busstop');
    const park = townPlaces.find((p) => p.kind === 'park');
    const nFolk = o.folk?.[ti] ?? (plan.source === 'real' ? 160 : 70);
    const nDogs = o.dogs?.[ti] ?? 1;
    const order = shuffle(folkModels.map((m) => m.id), R);
    const strollPool = graph.nodes.filter((n) => reach(n.id)).map((n) => n.id);
    const pathCache = new Map<string, number[] | null>();
    const route = (a: number, b: number) => { const k = `${a}>${b}`; if (!pathCache.has(k)) pathCache.set(k, shortestWalk(graph, a, b)); return pathCache.get(k)!; };
    /** A move along the walk graph as a runtime path (scene space) with its crossings; returns [seg, duration]. */
    /** Pull a node path tight (skip corners where the straight line stays walkable and off the road), so
     *  nobody zig-zags or doubles back; crossings stay exactly where they are. */
    const pull = (seq: number[]): Array<{ p: P2; y: number; hw: number; cross?: { sig: number; group: number } }> => {
      const out: Array<{ p: P2; y: number; hw: number; cross?: { sig: number; group: number } }> = [];
      let i = 0;
      while (i < seq.length) {
        const n = graph.nodes[seq[i]];
        if (i === seq.length - 1) { out.push({ p: n.p, y: n.y, hw: 9 }); break; }
        const e1 = edgeBetween(graph, seq[i], seq[i + 1])!;
        if (e1.cross) { out.push({ p: n.p, y: n.y, hw: e1.hw, cross: e1.cross }); i++; continue; }
        // furthest node reachable in a straight, walkable, road-free line (up to 6 hops ahead)
        let j = i + 1, hw = e1.hw;
        for (let k = i + 2; k < Math.min(seq.length, i + 6); k++) {
          const ek = edgeBetween(graph, seq[k - 1], seq[k])!;
          if (ek.cross) break;
          const a = n.p, b = graph.nodes[seq[k]].p, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L > 24 || !ws.segWalkable(a, b, 0.3)) break;
          const dir: P2 = [(b[0] - a[0]) / (L || 1), (b[1] - a[1]) / (L || 1)];
          // the free half-width all along the shortcut (every 0.4 m: a corner between samples is where folk graze)
          let h = 9;
          const nS = Math.max(4, Math.ceil(L / 0.4));
          for (let q = 0; q <= nS && h >= 0.6; q++) h = Math.min(h, ws.freeHalf([a[0] + (b[0] - a[0]) * q / nS, a[1] + (b[1] - a[1]) * q / nS], dir, 1.6));
          if (h < 0.6) break;
          j = k; hw = h;
        }
        out.push({ p: n.p, y: n.y, hw });
        i = j;
      }
      return out;
    };
    const pulled = new Map<string, ReturnType<typeof pull>>();
    const makeMove = (nodesSeq: number[], t: number, speed: number): [LifeSeg, number] => {
      const pts: number[] = [];
      const cross: LifeCross[] = [];
      const key = `${nodesSeq[0]}>${nodesSeq[nodesSeq.length - 1]}:${nodesSeq.length}`;
      if (!pulled.has(key)) pulled.set(key, pull(nodesSeq));
      const P = pulled.get(key)!;
      let s = 0;
      for (let k = 0; k < P.length; k++) {
        const n = P[k];
        if (k) {
          const pr = P[k - 1];
          const l = Math.hypot(n.p[0] - pr.p[0], n.p[1] - pr.p[1]);
          if (pr.cross) cross.push({ s0: r2(s), s1: r2(s + l), sig: pr.cross.sig, group: pr.cross.group });
          s += l;
        }
        const hw = Math.min(k ? P[k - 1].hw : 9, n.hw, 2.4);
        pts.push(r2(n.p[0] + off[0]), r2(n.y + off[1]), r2(n.p[1] + off[2]), r2(hw));
      }
      paths.push(pts);
      const seg: LifeSeg = { k: 'move', t: r2(t), p: paths.length - 1, ...(cross.length ? { cross } : {}) };
      // planned time: the walk plus a little for each crossing (waiting for the signal)
      return [seg, s / speed + cross.length * 18];
    };
    /** Where a friend stands while someone uses a slot (scene space): at the end of the bench, beside a
     *  browser away from the other browser, behind an angler or someone waiting. Always on the walk, off the slots. */
    const friendSpot = (pl: Place, sl: Slot): [number, number, number] | null => {
      if (pl.kind === 'door' || sl.pose === 'tend') return null;
      const f: P2 = [Math.sin(sl.face), Math.cos(sl.face)];
      const others = pl.slots.filter((o) => o !== sl);
      const away: P2 = others.length ? norm([sl.at[0] - others.reduce((a, o) => a + o.at[0], 0) / others.length, sl.at[1] - others.reduce((a, o) => a + o.at[1], 0) / others.length]) : [-f[1], f[0]];
      const cands: P2[] = pl.kind === 'bench' ? [[sl.at[0] + away[0] * 0.95 + f[0] * 0.3, sl.at[1] + away[1] * 0.95 + f[1] * 0.3], [sl.at[0] + f[0] * 1.1 + away[0] * 0.3, sl.at[1] + f[1] * 1.1 + away[1] * 0.3]]
        : pl.kind === 'stall' ? [[sl.at[0] + away[0] * 0.75 + f[0] * 0.15, sl.at[1] + away[1] * 0.75 + f[1] * 0.15], [sl.at[0] - f[0] * 0.8, sl.at[1] - f[1] * 0.8]]
        : [[sl.at[0] - f[0] * 0.8, sl.at[1] - f[1] * 0.8], [sl.at[0] + away[0] * 0.75, sl.at[1] + away[1] * 0.75]];
      for (const c of cands) {
        const lc: P2 = [c[0] - off[0], c[1] - off[2]];
        if (!ws.walkable(lc) || places.some((q) => q.town === ti && q.slots.some((o) => o !== sl && Math.hypot(o.at[0] - c[0], o.at[1] - c[1]) < 0.62))) continue;
        return [r2(c[0]), r2((pl.kind === 'pier' ? ws.pierY : ws.heightAt(lc)) + off[1]), r2(c[1])];
      }
      return null;
    };
    const slotFree = (sl: Slot, t0: number, t1: number) => sl.busy.every(([a, b]) => t1 + 25 < a || t0 > b + 25);
    const book = (sl: Slot, t0: number, t1: number) => sl.busy.push([t0, t1]);

    const addAgent = (A: LifeAgent) => { agents.push(A); return agents.length - 1; };

    /** One outing: from a door through activities and back in through a door. Returns the segments and the time it ends. */
    const outing = (m: { speed: number; sits: boolean; role: string }, home: Place, t: number, acts: string[]): { segs: LifeSeg[]; t: number; dog?: boolean } | null => {
      const segs: LifeSeg[] = [];
      let at = home.node;
      let now = t;
      for (const act0 of acts) {
        const act = act0 === 'sit' && !m.sits ? 'stroll' : act0;       // no sit clip: a stroll instead
        let target: { place: Place; slot: Slot | null; node: number; dur: number; pose: string } | null = null;
        const tries = act === 'sit' ? benches : act === 'browse' || act === 'tend' ? stalls : act === 'fish' ? piers : act === 'wait-bus' ? stops : [];
        if (act === 'stroll' || act === 'walk-dog') {
          const pool = act === 'walk-dog' && park ? park.nodes! : strollPool;
          const legs = act === 'walk-dog' ? 3 : 2;
          for (let k = 0; k < legs; k++) {
            // somewhere a fair walk away (but not across the whole map)
            let goal = pick(pool);
            for (let tries = 0; tries < 8; tries++) {
              const d = Math.hypot(graph.nodes[goal].p[0] - graph.nodes[at].p[0], graph.nodes[goal].p[1] - graph.nodes[at].p[1]);
              if (d > (act === 'walk-dog' ? 12 : 40) && d < 180) break;
              goal = pick(pool);
            }
            const r = route(at, goal);
            if (!r || r.length < 2) continue;
            const [seg, dur] = makeMove(r, now, m.speed);
            segs.push(seg); now += dur + 1; at = goal;
            // now and then a stop: a glance in a window, a look around, before walking on
            if (act === 'stroll' && R() < 0.45) {
              const pp = paths[(seg as any).p], n4 = pp.length / 4;
              const hx = pp[(n4 - 1) * 4] - pp[(n4 - 2) * 4], hz = pp[(n4 - 1) * 4 + 2] - pp[(n4 - 2) * 4 + 2], hl = Math.hypot(hx, hz) || 1;
              const nd = graph.nodes[goal];
              const side: P2 = [nd.p[0] - hz / hl * 0.35, nd.p[1] + hx / hl * 0.35];
              const spot = ws.walkable(side) && ws.freeHalf(side, [hx / hl, hz / hl], 0.6) >= 0.4 ? side : nd.p;
              const dwell = between(3, 9);
              const ps: P2 = [nd.p[0] + hz / hl * 0.4, nd.p[1] - hx / hl * 0.4];
              const palOk = spot !== nd.p && ws.walkable(ps);
              segs.push({ k: 'act', t: r2(now), t1: r2(now + dwell), at: [r2(spot[0] + off[0]), r2(ws.heightAt(spot) + off[1]), r2(spot[1] + off[2])], face: r2(Math.atan2(hx, hz) + (R() < 0.5 ? 1 : -1) * between(0.9, 1.6)), pose: 'look', slot: -1, ...(palOk ? { pal: [r2(ps[0] + off[0]), r2(ws.heightAt(ps) + off[1]), r2(ps[1] + off[2])] as [number, number, number] } : {}) });
              now += dwell + 1;
            }
          }
          continue;
        }
        const dur = act === 'sit' ? between(300, 1200) : act === 'browse' ? between(120, 420) : act === 'fish' ? between(1200, 3000) : act === 'tend' ? MARKET[1] * 3600 - now : between(180, 480);
        for (const pl of shuffle(tries.slice(), R)) {
          const r = route(at, pl.node);
          if (!r) continue;
          let len = 0;
          for (let k = 1; k < r.length; k++) len += Math.hypot(graph.nodes[r[k]].p[0] - graph.nodes[r[k - 1]].p[0], graph.nodes[r[k]].p[1] - graph.nodes[r[k - 1]].p[1]);
          if (len > (act === 'tend' ? 2000 : 380)) continue;
          const arrive = now + len / m.speed + 30;
          const want = act === 'tend' ? 'tend' : null;
          const sl = pl.slots.find((s) => (want ? s.pose === 'tend' : s.pose !== 'tend') && slotFree(s, arrive - 40, arrive + dur + 60));
          if (!sl) continue;
          target = { place: pl, slot: sl, node: sl.approach, dur, pose: sl.pose };
          break;
        }
        if (!target) continue;
        const r = route(at, target.node);
        if (!r) continue;
        if (r.length >= 2) { const [seg, d] = makeMove(r, now, m.speed); segs.push(seg); now += d; }
        const sl = target.slot!;
        const t1 = target.pose === 'tend' ? Math.max(now + 600, MARKET[1] * 3600) : now + target.dur;
        book(sl, now - 20, t1 + 20);
        const palAt = friendSpot(target.place, sl);
        segs.push({ k: 'act', t: r2(now), t1: r2(t1), at: [r2(sl.at[0]), r2(sl.y + off[1]), r2(sl.at[1])], face: r2(sl.face), pose: target.pose, slot: sl.id, place: target.place.id, ...(palAt ? { pal: palAt } : {}) });
        now = t1 + 1;
        at = target.node;
      }
      if (!segs.length) return null;
      // home again (or into a shop)
      const back = R() < 0.7 ? home : pick(doorPlaces);
      const r = route(at, back.node);
      if (!r) return null;
      if (r.length >= 2) { const [seg, d] = makeMove(r, now, m.speed); segs.push(seg); now += d; }
      return { segs, t: now };
    };

    const plans: Array<{ idx: number; segs: LifeSeg[]; home: Place }> = [];
    const doorBusy = new Map<string, number[]>();
    const leaveAt = (door: Place, t: number) => { const l = doorBusy.get(door.id) ?? []; let tt = t; while (l.some((x) => Math.abs(x - tt) < 6)) tt += 6; l.push(tt); doorBusy.set(door.id, l); return tt; };
    if (!doorPlaces.length) return;
    const sample = () => { // an hour drawn from the day's density
      const tot = Array.from({ length: 96 }, (_, k) => density(o, k / 4)).reduce((a, b) => a + b, 0);
      let u = R() * tot;
      for (let k = 0; k < 96; k++) { u -= density(o, k / 4); if (u <= 0) return k / 4 + R() / 4; }
      return 12;
    };
    const makeFolk = (role: string) => {
      const modelId = role === 'kid' ? (folkModels.find((m) => /kid/.test(m.id))?.id ?? order[0]) : order[cast.length % order.length];
      const M = folkModels.find((mm) => mm.id === modelId) ?? folkModels[0];
      const sp = M.speed ?? [1.15, 1.45];
      const member: CastMember = { id: `${plan.source === 'real' ? 'raleigh' : 'twin'}-${cast.length}`, town: ti, model: M.id, scale: r2(between(0.94, 1.06)), speed: r2(between(sp[0], sp[1])), home: pick(doorPlaces).id, role, outings: 0 };
      cast.push(member);
      return { member, M };
    };
    // the fixed roles first: stall keepers, a fisher or two, the dog walkers, then everyone else
    const roles: string[] = [];
    if (market) for (let k = 0; k < stalls.length; k++) roles.push('vendor');
    for (let k = 0; k < Math.min(piers.length * 2, 3); k++) roles.push('fisher');
    for (let k = 0; k < nDogs; k++) roles.push('dogwalker');
    while (roles.length < nFolk) roles.push('folk');
    let vendorK = 0;
    for (const role of roles) {
      const { member, M } = makeFolk(role);
      if (role === 'vendor' && stalls[vendorK]) {
        const st = stalls[vendorK];
        member.home = doorPlaces.slice().sort((a, b) => Math.hypot(a.at[0] - st.at[0], a.at[1] - st.at[1]) - Math.hypot(b.at[0] - st.at[0], b.at[1] - st.at[1]))[Math.floor(R() * 3)].id;
      }
      const home = doorPlaces.find((d) => d.id === member.home)!;
      const mm = { speed: member.speed, sits: M.sits !== false, role };
      const segs: LifeSeg[] = [];
      let free = 0;
      const starts: Array<{ t: number; acts: string[] }> = [];
      if (role === 'vendor') {
        const st = stalls[vendorK++];
        starts.push({ t: MARKET[0] * 3600 - between(600, 1200), acts: ['tend'] });
        void st;
        starts.push({ t: between(15, 17) * 3600, acts: [R() < 0.5 ? 'sit' : 'stroll'] });
      } else if (role === 'fisher') {
        starts.push({ t: between(8.6, 10.2) * 3600, acts: ['fish', 'fish'] });
        starts.push({ t: between(15.5, 16.5) * 3600, acts: ['fish'] });
      } else if (role === 'dogwalker') {
        starts.push({ t: between(7.2, 7.8) * 3600, acts: ['walk-dog'] });
        starts.push({ t: between(10.2, 10.45) * 3600, acts: ['walk-dog', 'sit', 'walk-dog'] });
        starts.push({ t: between(16.8, 17.5) * 3600, acts: ['walk-dog'] });
      } else {
        const n = 2 + Math.floor(R() * 3);
        const hs = Array.from({ length: n }, sample).sort((a, b) => a - b);
        for (const h of hs) {
          const inMarket = market && h >= MARKET[0] && h < MARKET[1] - 0.2;
          const menu = [...(inMarket ? ['browse', 'browse', 'browse'] : []), ...(mm.sits ? ['sit', 'sit'] : []), 'stroll', 'stroll', ...(stops.length ? ['wait-bus'] : []), ...(piers.length && h > 8 && h < 18 ? ['fish'] : [])];
          const k = 4 + Math.floor(R() * 4);
          starts.push({ t: h * 3600, acts: Array.from({ length: k }, () => pick(menu)) });
        }
      }
      for (const s of starts) {
        if (s.t < free + 60) continue;
        const t0 = leaveAt(home, s.t);
        const out = outing(mm, home, t0, s.acts);
        if (!out) continue;
        if (segs.length) {
          // indoors between outings (invisible), then out of the same door
          const prev = segs[segs.length - 1] as any;
          void prev;
          segs.push({ k: 'act', t: r2(free), t1: r2(t0), at: [r2(home.at[0]), r2(home.y + off[1]), r2(home.at[1])], face: r2(home.yaw), pose: 'inside', slot: -1 });
        }
        segs.push(...out.segs);
        free = out.t;
        member.outings++;
        stats.outings++;
      }
      if (!segs.length) { cast.pop(); continue; }
      const idx = addAgent({ id: member.id, town: ti, kind: 'person', r: 0.26, speed: member.speed, lane: r2(between(0.25, 0.85)), model: member.model, scale: member.scale, plan: segs });
      plans.push({ idx, segs, home });
      stats.folk++;
      // some go out with a friend: side by side on the walk, standing by them for a chat when they stop
      if (role === 'folk' && R() < (o.pairs ?? 0.18)) {
        const fm = folkModels.filter((x) => x.id !== member.model && !/kid/.test(x.id));
        const pm = fm.length ? pick(fm) : M;
        agents[idx].lane = r2(between(0.75, 0.9));         // keep well right, so the two fit side by side
        agents[idx].pal = addAgent({ id: `${member.id}-pal`, town: ti, kind: 'person', r: 0.26, speed: member.speed, owner: idx, model: pm.id, scale: r2(between(0.94, 1.06)), plan: [] });
        stats.folk++; stats.pairs = (stats.pairs ?? 0) + 1;
      }
      if (role === 'dogwalker' && dogModels.length) {
        const dm = dogModels[stats.dogs % dogModels.length];
        addAgent({ id: `${member.id}-dog`, town: ti, kind: 'dog', r: 0.22, speed: 2.4, owner: idx, model: dm.id, scale: r2(between(0.9, 1.1)), plan: [] });
        stats.dogs++;
      }
    }

    // ── vehicles: cars on portal-to-portal trips through the day, and a bus on its loop ──
    const portals = lanes.filter((e) => e.kind === 'lane' && e.from === -1 && lenOf(e) > 10);
    const nCars = o.cars?.[ti] ?? (plan.source === 'real' ? 12 : 5);
    for (let c = 0; c < nCars && portals.length && carModels.length; c++) {
      const cm = carModels[c % carModels.length];
      const trips: LifeVehicle['trips'] = [];
      let t = between(5.5, 7) * 3600;
      while (t < 23.6 * 3600) {
        const tr = randomTrip(pick(portals), laneById, R);
        if (tr) {
          trips.push({ t: r2(t), edges: tr.map((id) => edgeBase + id) });
          const len = tr.reduce((s, id) => s + lenOf(laneById.get(id)!), 0);
          t += len / 7 + 30;
        }
        const d = Math.max(0.08, density(o, t / 3600));
        t += between(20, 220) / d;
      }
      vehicles.push({ id: `${ti}:car${c}`, town: ti, kind: 'car', len: cm.len ?? 4.3, wid: cm.wid ?? 1.8, model: cm.id, trips });
      stats.cars++; stats.trips += trips.length;
    }
    if (busLoop && busModels.length) {
      const bm = busModels[0];
      vehicles.push({ id: `${ti}:bus`, town: ti, kind: 'bus', len: bm.len ?? 10.5, wid: bm.wid ?? 2.5, model: bm.id, loop: true, trips: [{ t: 0, edges: busLoop.map((id) => edgeBase + id) }] });
      stats.buses++;
    }
  });
  stats.places = places.length;

  const data: LifeData = { version: 1, dt: LIFE_DT, start: Math.round((o.start ?? 10.6) * 3600), slots: slots.length, signals, edges, paths, agents, vehicles };
  return { data, places, props, cast, walk, stats, towns: outTowns };
}

// ── small helpers ─────────────────────────────────────────────────────────────
function norm(v: P2): P2 { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function polyArea(p: P2[]) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); }
function centroidOf(p: P2[]): P2 { return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]; }
export function shuffle<T>(a: T[], R: () => number): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const lenOf = (e: CarEdge) => { let s = 0; for (let i = 1; i < e.pts.length; i++) s += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][2] - e.pts[i - 1][2]); return s; };
function ptAlong(pts: Array<[number, number, number]>, d: number): [number, number, number] {
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]); if (d <= l || i === pts.length - 1) { const t = l ? Math.min(1, d / l) : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t]; } d -= l; }
  return pts[0];
}
function dirAlong(pts: Array<[number, number, number]>, d: number): P2 { const a = ptAlong(pts, d - 1), b = ptAlong(pts, d + 1); return norm([b[0] - a[0], b[2] - a[2]]); }

/** A loop back to the start lane, turning right where it can (around a block). */
function findLoop(start: CarEdge, byId: Map<number, CarEdge>): number[] | null {
  const best: { path: number[] | null } = { path: null };
  const dfs = (e: CarEdge, path: number[], depth: number) => {
    if (best.path || depth > 16) return;
    // order: right turns first, then straight on
    const turns = e.next.map((id) => byId.get(id)!).sort((a, b) => turnScore(b) - turnScore(a));
    for (const t of turns) {
      const nxt = byId.get(t.next[0])!;
      if (nxt.id === start.id) { best.path = [...path, t.id]; return; }
      if (path.includes(nxt.id)) continue;
      dfs(nxt, [...path, t.id, nxt.id], depth + 1);
      if (best.path) return;
    }
  };
  dfs(start, [start.id], 0);
  return best.path;
}
function turnScore(t: CarEdge) { return t.startDir[0] * t.endDir[1] - t.startDir[1] * t.endDir[0]; }
function randomTrip(start: CarEdge, byId: Map<number, CarEdge>, R: () => number): number[] | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = [start.id];
    let e = start;
    for (let k = 0; k < 24; k++) {
      if (e.to === -1) return out;
      if (!e.next.length) break;
      const straight = e.next.map((id) => byId.get(id)!).filter((t) => turnScore(t) < 0.5);
      const right = e.next.map((id) => byId.get(id)!).filter((t) => turnScore(t) >= 0.5);
      const t = straight.length && (R() < 0.68 || !right.length) ? straight[Math.floor(R() * straight.length)] : right.length ? right[Math.floor(R() * right.length)] : null;
      if (!t) break;
      out.push(t.id);
      e = byId.get(t.next[0])!;
      out.push(e.id);
    }
  }
  return null;
}
export { isCar };
