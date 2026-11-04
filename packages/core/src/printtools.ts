// Printing tools in the typed registry (Decisions 43–46): make an object printable, fix what the
// print checks find (each fix is one reviewable step), and make the fit-test coupon.
// `studio print` itself is a daemon tool (it needs Bambu Studio on the Mac).
import { z } from 'zod';
import { freeSpot, type ToolDef } from './tools.ts';
import type { OpNode, SceneObject } from './types.ts';
import { PRINTERS, FIT_PARAMS, currentFit, recordFit, bestOrientation, localPositions, minYAfter, FIT_TEST_GAPS_MM, minWall } from './print.ts';

const ObjRef = z.string().optional().describe('object id or name (defaults to the only/last object)');

function freeId(o: SceneObject, base: string): string {
  let id = base, i = 2;
  while (o.ops[id]) id = `${base}${i++}`;
  return id;
}

/** Add ops on top of the output and make the last one the output. */
function wrapOutput(ctx: any, o: SceneObject, nodes: OpNode[]) {
  const order = [...o.opOrder];
  for (const n of nodes) { ctx.set(['objects', o.id, 'ops', n.id], n); order.push(n.id); }
  ctx.set(['objects', o.id, 'opOrder'], order);
  ctx.set(['objects', o.id, 'output'], nodes[nodes.length - 1].id);
}

export const PRINT_TOOLS: ToolDef[] = [
  {
    name: 'set-print-profile', mode: 'modify', mutates: true,
    description: 'Make an object printable on your printer (Decision 44): --printer a1-mini (Bambu Lab A1 mini, 0.4 nozzle, one spool). Adds print checks that run after every step: fits the 180 mm bed, sealed, walls ≥ 0.84 mm (2 lines), overhangs needing support, flat base. Adds the fit-gap params fitPress / fitSlide / fitLoose (metres per side, your measured values once a fit-test is recorded) for lids, pegs and sockets: e.g. a lid "$lidW - 2*$fitSlide". --filament / --process pick other Bambu Studio presets. --printer none removes it. Then `studio print`.',
    input: z.object({
      object: ObjRef, printer: z.enum(['a1-mini', 'none']).default('a1-mini'),
      filament: z.string().optional().describe('Bambu Studio filament preset (default: your "Bambu PLA Basic @BBL A1M" copy, else the system one)'),
      process: z.string().optional().describe('Bambu Studio process preset (default "0.20mm Standard @BBL A1M")'),
    }),
    example: 'studio set-print-profile --object box --printer a1-mini',
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (a.printer === 'none') {
        if (!o.print) throw new Error(`${o.name} has no print profile`);
        ctx.set(['objects', o.id, 'print'], undefined);
        ctx.summary(`${o.name} is no longer set up for printing`);
        return { print: null };
      }
      const prof: any = { ...(o.print ?? {}), printer: a.printer };
      if (a.filament) prof.filament = a.filament;
      if (a.process) prof.process = a.process;
      ctx.set(['objects', o.id, 'print'], prof);
      const fit = currentFit();
      const added: string[] = [];
      for (const [k, name] of Object.entries(FIT_PARAMS) as Array<[keyof typeof FIT_PARAMS, string]>) {
        if (o.params[name]) continue;
        ctx.set(['objects', o.id, 'params', name], { value: fit[k], unit: 'm', description: `fit gap per side for a ${k} fit (from your fit-test, else the default)` });
        added.push(`${name} ${(fit[k] * 1000).toFixed(2)} mm`);
      }
      const p = PRINTERS[a.printer as 'a1-mini'];
      ctx.summary(`${o.name}: print profile ${p.label}${added.length ? ` (+ ${added.join(', ')})` : ''}`);
      return { print: prof, printer: { label: p.label, bed: p.bed, minWall: +minWall(p).toFixed(2), supportBelowDeg: p.supportBelow }, fit: { press: fit.press, slide: fit.slide, loose: fit.loose } };
    },
  },
  {
    name: 'print-fix', mode: 'modify', mutates: true,
    description: 'Apply a fix the print checks suggest, as one reviewable step (propose first if the human should compare): --fix lay-flat turns the object onto the side that needs the least support (most base on the bed); --fix chamfer bevels the bottom edge (--size, default 0.4 mm) so the first layer doesn\'t flare; --fix split cuts it in two with pin holes and adds the pins (--axis x|y|z, --at m) when it is too big for the bed. Each adds ops on top of the output; undo removes them.',
    input: z.object({
      object: ObjRef, fix: z.enum(['lay-flat', 'chamfer', 'split']),
      size: z.number().positive().optional().describe('chamfer size in metres (default 0.0004)'),
      axis: z.enum(['x', 'y', 'z']).optional(), at: z.number().optional().describe('split position along the axis (m)'),
    }),
    example: 'studio print-fix --object box --fix lay-flat',
    run(ctx, a) {
      const o = ctx.obj(a.object);
      if (!o.output) throw new Error(`${o.name} has no output yet`);
      const printer = PRINTERS[o.print?.printer ?? 'a1-mini'];
      if (a.fix === 'lay-flat') {
        const res = ctx.studio.evaluate(o);
        if (!res.ok) throw new Error(`${o.name} doesn't evaluate: ${res.error}`);
        const local = localPositions(o, res);
        const { best, tried } = bestOrientation(local, res.indices, printer);
        const now = tried[0];
        if (best === now || (Math.abs(best.supportArea - now.supportArea) < 1 && best.baseArea <= now.baseArea + 1)) {
          ctx.summary(`${o.name}: already on its best side (${(now.supportArea / 100).toFixed(1)} cm² needs support)`);
          return { changed: false, current: now, tried };
        }
        const floor = -minYAfter(local, best.deg);
        const rid = freeId(o, 'printOrient'), fid = freeId(o, 'printFloor');
        wrapOutput(ctx, o, [
          { id: rid, op: 'rotate', args: { deg: best.deg }, inputs: [o.output] },
          { id: fid, op: 'translate', args: { by: [0, +floor.toFixed(6), 0] }, inputs: [rid] },
        ]);
        ctx.summary(`${o.name}: laid ${best.label} — support ${(now.supportArea / 100).toFixed(1)} → ${(best.supportArea / 100).toFixed(1)} cm², base ${(now.baseArea / 100).toFixed(1)} → ${(best.baseArea / 100).toFixed(1)} cm²`);
        return { changed: true, from: now, to: best };
      }
      if (a.fix === 'chamfer') {
        const id = freeId(o, 'printChamfer');
        wrapOutput(ctx, o, [{ id, op: 'chamfer', args: { size: a.size ?? 0.0004 }, inputs: [o.output] }]);
        ctx.summary(`${o.name}: ${((a.size ?? 0.0004) * 1000).toFixed(1)} mm chamfer on the bottom edge`);
        return { op: id };
      }
      const id = freeId(o, 'printSplit');
      const args: Record<string, unknown> = {};
      if (a.axis) args.axis = a.axis;
      if (a.at !== undefined) args.at = a.at;
      if (o.params[FIT_PARAMS.press]) args.fit = `$${FIT_PARAMS.press}`;
      wrapOutput(ctx, o, [{ id, op: 'split', args, inputs: [o.output] }]);
      const after = ctx.studio.evaluate(ctx.obj(o.id));
      if (!after.ok) throw new Error(`split failed: ${after.error}`);
      const pins = after.parts.filter((p: any) => p.name.startsWith('pin')).length;
      ctx.summary(`${o.name}: split in two${a.axis ? ` along ${a.axis}` : ''}${pins ? ` with ${pins} pin${pins === 1 ? '' : 's'} and matching holes` : ' — the cut face is too thin for pins (needs about 8 mm): glue the halves'}`);
      return { op: id, pins };
    },
  },
  {
    name: 'fit-test', mode: 'create', mutates: true,
    description: 'Make the fit-test coupon (Decision 46): a 64 × 20 mm plate with five 6 mm holes, each a little looser (gaps 0.10, 0.15, 0.20, 0.30, 0.40 mm per side, numbered 1–5), and a 6 mm pin. Print it (studio print --object fit-test), push the pin into each hole, then record which hole fits how: `studio fit-result --press 2 --slide 3 --loose 5`. Those gaps become fitPress / fitSlide / fitLoose for every printable object.',
    input: z.object({}),
    example: 'studio fit-test',
    run(ctx) {
      let id = 'fit-test';
      while (ctx.doc.objects[id]) id = id + '-2';
      const r = 0.003, t = 0.004, w = 0.064, d = 0.02;
      const ops: Record<string, OpNode> = {};
      const order: string[] = [];
      const add = (n: OpNode) => { ops[n.id] = n; order.push(n.id); };
      add({ id: 'plate', op: 'box', args: { size: [w, t, d], at: [0, t / 2, 0] }, part: 'plate' });
      FIT_TEST_GAPS_MM.forEach((g, i) => {
        add({ id: `h${i + 1}`, op: 'cylinder', args: { r: r + g / 1000, h: t + 0.002, at: [-0.024 + i * 0.012, -0.001, 0.003], segments: 64 } });
        add({ id: `n${i + 1}`, op: 'text', args: { text: String(i + 1), size: 0.005, depth: 0.0006, at: [-0.024 + i * 0.012, t - 0.0006, -0.0058], axis: 'y' } });
      });
      add({ id: 'holes', op: 'union', args: {}, inputs: FIT_TEST_GAPS_MM.map((_, i) => `h${i + 1}`) });
      add({ id: 'labels', op: 'union', args: {}, inputs: FIT_TEST_GAPS_MM.map((_, i) => `n${i + 1}`) });
      add({ id: 'cut', op: 'union', args: {}, inputs: ['holes', 'labels'] });
      add({ id: 'coupon', op: 'difference', args: {}, inputs: ['plate', 'cut'] });
      add({ id: 'pin', op: 'cylinder', args: { r, h: 0.012, at: [0.04, 0, 0], segments: 64 }, part: 'pin' });
      add({ id: 'fitTest', op: 'union', args: {}, inputs: ['coupon', 'pin'] });
      const obj: SceneObject = {
        id, name: 'Fit test', semanticType: 'print-test', description: `Holes 1–5: ${FIT_TEST_GAPS_MM.map((g) => `${g.toFixed(2)} mm`).join(', ')} per side around a 6 mm pin`,
        params: {}, ops, opOrder: order, output: 'fitTest',
        material: { name: 'pla', color: '#e7e3da' }, position: freeSpot(ctx), rules: [{ kind: 'aboveFloor' }],
        print: { printer: 'a1-mini' },
      };
      ctx.set(['objects', id], obj);
      ctx.set(['objectOrder'], [...ctx.doc.objectOrder, id]);
      ctx.summary('Fit-test coupon: five numbered holes (0.10–0.40 mm per side) and a 6 mm pin');
      return { id, gapsMm: FIT_TEST_GAPS_MM, next: `studio print --object ${id}; then studio fit-result --press <n> --slide <n> --loose <n>` };
    },
  },
  {
    name: 'fit-result', mode: 'modify', mutates: true,
    description: 'Record what the printed fit-test coupon showed: which numbered hole (1–5) gave a press fit (pin pushes in firmly and stays), a sliding fit (moves smoothly, no wobble) and a loose fit (drops in). Updates fitPress / fitSlide / fitLoose on every printable object in the scene and remembers them for new ones.',
    input: z.object({
      press: z.number().int().min(1).max(5), slide: z.number().int().min(1).max(5), loose: z.number().int().min(1).max(5),
    }),
    example: 'studio fit-result --press 2 --slide 3 --loose 5',
    run(ctx, a) {
      if (!(a.press <= a.slide && a.slide <= a.loose)) throw new Error('expected press ≤ slide ≤ loose (hole numbers grow looser from 1 to 5)');
      const gap = (n: number) => FIT_TEST_GAPS_MM[n - 1] / 1000;
      const fit = { press: gap(a.press), slide: gap(a.slide), loose: gap(a.loose) };
      const updated: string[] = [];
      for (const id of ctx.doc.objectOrder) {
        const o = ctx.doc.objects[id];
        if (!o?.print) continue;
        for (const [k, name] of Object.entries(FIT_PARAMS) as Array<[keyof typeof FIT_PARAMS, string]>) {
          ctx.set(['objects', id, 'params', name], { ...(o.params[name] ?? { unit: 'm', description: `fit gap per side for a ${k} fit` }), value: fit[k] });
        }
        updated.push(o.name);
      }
      recordFit(fit);
      ctx.summary(`Fit gaps from your coupon: press ${(fit.press * 1000).toFixed(2)}, slide ${(fit.slide * 1000).toFixed(2)}, loose ${(fit.loose * 1000).toFixed(2)} mm per side${updated.length ? ` (updated ${updated.join(', ')})` : ''}`);
      return { fit, updated };
    },
  },
];
