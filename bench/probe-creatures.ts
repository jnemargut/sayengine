// Quick probe (dev aid): bake every preset motion and print the failing checks.
//   node bench/probe-creatures.ts [preset …]
import { creatureWithClips, CREATURE_PRESETS } from '../packages/core/src/creatures.ts';

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CREATURE_PRESETS);
for (const name of names) {
  try {
    const { c, clips, checks } = creatureWithClips(name);
    for (const cl of clips) {
      const bad = checks[cl.id].filter((k) => !k.pass);
      console.log(`${name} ${cl.id} (${cl.duration.toFixed(2)} s, ${cl.speed.toFixed(2)} m/s, ${c.bones.length} bones): ${bad.length ? 'FAIL ' + bad.map((k) => `${k.name} ${k.worst}${k.unit}>${k.limit} [${k.frames.slice(0, 3).map((r) => r.join('-')).join(',')}] ${k.detail}`).join(' | ') : `all ${checks[cl.id].length} pass`}`);
    }
  } catch (e: any) { console.log(`${name}: ERROR ${e.stack?.split('\n').slice(0, 4).join(' ')}`); }
}
