// The forge yard (Decision 18's milestone, the set for "The Forge Lesson"): about ten game-ready props,
// the blacksmith (holding his hammer, idling, with a hammer strike) and the apprentice, who is the
// player and walks up to the anvil. One studio call per step, as /studio would make it; every prop has
// the godot-desktop profile and a collision shape. Used by bench/diorama.ts and to make the week-6
// artefacts; `node bench/forge.ts` builds it in a running studio daemon (STUDIO_PORT) instead.
export type Step = (tool: string, args: Record<string, unknown>) => unknown;

export function buildForge(step: Step) {
  const prop = (name: string, type: string, material: string, color: string | null, ops: Array<Record<string, unknown>>, at: [number, number, number], opts: { rotation?: number; collision?: string; on?: string } = {}) => {
    step('new-object', { name, type, material, ...(color ? { color } : {}), position: at });
    for (const o of ops) step('add-op', o);
    if (opts.rotation) step('move-object', { position: at, rotation: opts.rotation });
    if (opts.on) step('place-object', { relation: 'on', target: opts.on });
    step('set-profile', { profile: 'godot-desktop' });
    const out = (ops.find((o) => o.output === true) ?? ops[ops.length - 1]).id;
    step('add-op', { id: 'collision', op: 'collision', inputs: [out], args: { shape: opts.collision ?? 'hull' } });
  };

  // the yard: packed earth, a little wider than the scene
  prop('Yard', 'floor', 'concrete', '#8d7b66', [{ id: 'ground', op: 'box', part: 'ground', args: { size: [7.5, 0.04, 6.5], at: [0, -0.02, 0] } }], [0, 0, 0], { collision: 'box' });
  // the forge: a brick hearth with the fire bed cut into its top, a hood and a chimney above
  prop('Forge', 'furniture', 'terracotta', '#9a4a32', [
    { id: 'hearth', op: 'roundedBox', part: 'hearth', output: false, args: { size: [1.3, 0.85, 0.95], r: 0.02, at: [0, 0.425, 0] } },
    { id: 'bed', op: 'box', part: 'bed', output: false, args: { size: [0.7, 0.2, 0.5], at: [0, 0.85, 0.05] } },
    { id: 'firebox', op: 'difference', inputs: ['hearth', 'bed'], output: false },
    { id: 'flue', op: 'box', part: 'chimney', output: false, args: { size: [0.42, 1.95, 0.42], at: [0, 1.8, -0.24] } },
    { id: 'hood', op: 'extrude', part: 'hood', output: false, args: { profile: [[-0.6, -0.42], [0.6, -0.42], [0.6, 0.42], [-0.6, 0.42]], h: 0.45, scaleTop: 0.42, at: [0, 1.3, 0] } },
    { id: 'forge', op: 'union', inputs: ['firebox', 'flue', 'hood'], output: true },
  ], [-1.9, 0, -1.7], { collision: 'hull' });
  step('set-material', { object: 'forge', part: 'hood', preset: 'black-metal' });
  // the anvil on its stump, in the middle of the yard
  prop('Stump', 'furniture', 'oak', '#6d4c33', [{ id: 'stump', op: 'cylinder', part: 'stump', args: { r1: 0.24, r2: 0.21, h: 0.5 } }], [0, 0, -0.5], { collision: 'hull' });
  prop('Anvil', 'tool', 'black-metal', null, [
    { id: 'foot', op: 'box', part: 'anvil', output: false, args: { size: [0.3, 0.07, 0.2], at: [0, 0.035, 0] } },
    { id: 'waist', op: 'box', part: 'anvil', output: false, args: { size: [0.14, 0.12, 0.1], at: [0, 0.13, 0] } },
    { id: 'face', op: 'box', part: 'anvil', output: false, args: { size: [0.36, 0.08, 0.13], at: [-0.02, 0.23, 0] } },
    { id: 'hornCone', op: 'cylinder', part: 'anvil', output: false, args: { r1: 0.05, r2: 0.006, h: 0.16 } },
    { id: 'hornTurned', op: 'rotate', inputs: ['hornCone'], output: false, args: { deg: [0, 0, -90] } },
    { id: 'horn', op: 'translate', inputs: ['hornTurned'], output: false, args: { by: [0.16, 0.23, 0] } },
    { id: 'anvil', op: 'union', inputs: ['foot', 'waist', 'face', 'horn'], output: true },
  ], [0, 0, -0.5], { on: 'stump', collision: 'hull' });
  // the workbench along the right, the quench tub by the forge, a barrel, crates, a coal heap
  prop('Workbench', 'table', 'oak', null, [
    { id: 'top', op: 'roundedBox', part: 'top', output: false, args: { size: [1.5, 0.06, 0.62], r: 0.01, at: [0, 0.82, 0] } },
    { id: 'leg', op: 'box', part: 'leg', output: false, args: { size: [0.07, 0.79, 0.07] } },
    { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'top', anchor: 'corners:bottom', inset: 0.06 } },
    { id: 'bench', op: 'union', inputs: ['top', 'legs'], output: true },
  ], [2.1, 0, -1.6], { collision: 'box' });
  prop('Quench tub', 'furniture', 'oak', '#5b4030', [
    { id: 'tub', op: 'revolve', part: 'tub', args: { profile: [[0, 0], [0.3, 0], [0.34, 0.5], [0.3, 0.5], [0.27, 0.05], [0, 0.05]] } },
  ], [-0.55, 0, -2.1], { collision: 'hull' });
  prop('Barrel', 'furniture', 'oak', null, [
    { id: 'barrel', op: 'revolve', part: 'barrel', args: { curve: true, profile: [[0, 0], [0.24, 0], [0.29, 0.38], [0.24, 0.76], [0, 0.76]] } },
  ], [2.7, 0, 0.5], { collision: 'hull' });
  prop('Crate', 'furniture', 'ash', '#b08a5a', [{ id: 'crate', op: 'roundedBox', part: 'crate', args: { size: [0.55, 0.5, 0.55], r: 0.015, at: [0, 0.25, 0] } }], [2.6, 0, 1.4], { collision: 'box', rotation: 12 });
  prop('Coal heap', 'prop', 'matte-ceramic', '#26221f', [
    { id: 'lump', op: 'sphere', part: 'coal', output: false, args: { r: 0.45, segments: 10 } },
    { id: 'flat', op: 'scale', inputs: ['lump'], output: false, args: { by: [1.1, 0.42, 0.9] } },
    { id: 'heap', op: 'trim', inputs: ['flat'], output: true },
  ], [-2.85, 0, -0.5], { collision: 'hull' });
  prop('Fence', 'furniture', 'painted-wood', '#5e6b52', [
    { id: 'post', op: 'box', part: 'post', output: false, args: { size: [0.09, 1.1, 0.09], at: [-3.4, 0.55, 0] } },
    { id: 'posts', op: 'array', inputs: ['post'], output: false, args: { count: 8, step: [0.97, 0, 0] } },
    { id: 'rail', op: 'box', part: 'rail', output: false, args: { size: [6.9, 0.07, 0.04], at: [0, 0.85, 0.05] } },
    { id: 'rail2', op: 'box', part: 'rail', output: false, args: { size: [6.9, 0.07, 0.04], at: [0, 0.4, 0.05] } },
    { id: 'fence', op: 'union', inputs: ['posts', 'rail', 'rail2'], output: true },
  ], [0, 0, -3.05], { collision: 'box' });
  // the hammer, in the blacksmith's hand
  step('new-object', { name: 'Hammer', type: 'tool', material: 'oak', position: [-0.9, 0, -1.2] });
  step('add-op', { id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  step('add-op', { id: 'head', op: 'box', part: 'head', args: { size: [0.11, 0.045, 0.045], at: [0, 0.33, 0] } });
  step('add-op', { id: 'hammer', op: 'union', inputs: ['handle', 'head'], output: true });
  // the blacksmith by the anvil, and the apprentice (the player) at the yard's open side
  step('new-character', { name: 'Blacksmith', preset: 'blacksmith', position: [-0.75, 0, -1.25] });
  step('move-object', { object: 'blacksmith', position: [-0.75, 0, -1.25], rotation: 35 });
  step('hold', { character: 'blacksmith', hand: 'right', prop: 'hammer' });
  step('set-motion', { object: 'blacksmith', id: 'strike', kind: 'action', action: 'hammer-strike' });
  step('set-motion', { object: 'blacksmith', id: 'idle', energy: 0.4 });
  step('new-character', { name: 'Apprentice', preset: 'apprentice', position: [0.6, 0, 2.5] });
  step('move-object', { object: 'apprentice', position: [0.6, 0, 2.5], rotation: 180 });
  step('set-motion', { object: 'apprentice', id: 'walk', speed: 1.25, energy: 0.65 });
  step('set-motion', { object: 'apprentice', id: 'wave', kind: 'action', action: 'wave' });
}

// `node bench/forge.ts` — build the yard in the running studio (the CLI's daemon on STUDIO_PORT)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ensureDaemon, callTool } = await import('../packages/cli/client.ts');
  await ensureDaemon();
  let last = '';
  buildForge(() => undefined); // syntax check of the builder in-process (no calls)
  const calls: Array<[string, Record<string, unknown>]> = [];
  buildForge((t, a) => { calls.push([t, a]); });
  for (const [t, a] of calls) {
    const r: any = await callTool(t, a);
    if (!r.ok) { console.error(`${t} ${JSON.stringify(a)}: ${r.error}`); process.exit(1); }
    last = r.summary ?? '';
  }
  console.log(`forge yard built: ${calls.length} steps (${last})`);
}
