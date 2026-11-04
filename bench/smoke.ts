// Quick headless smoke run of the engine (no daemon, no browser).
import { initKernel, Studio } from '../packages/core/src/index.ts';

await initKernel();
const s = new Studio();
const c = (t: string, a: object = {}) => {
  const r = s.call(t, a);
  const fails = r.checks ? Object.values(r.checks).flatMap((x) => x.failures.map((f) => f.detail)) : [];
  console.log(`${r.ok ? 'ok ' : 'ERR'} ${t.padEnd(16)} ${r.summary ?? ''}${r.error ? ' ' + r.error : ''}${fails.length ? '  ✗ ' + fails.join(' | ') : ''}`);
  return r;
};

c('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33', material: 'walnut' });
c('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: 0 } });
c('add-op', { id: 'seat', op: 'box', args: { size: ['$seatW', '$seatT', '$seatW'], at: [0, '$seatH - $seatT/2', 0] } });
c('add-op', { id: 'leg', op: 'cylinder', part: 'leg', args: { r: '$legR', h: '($seatH - $seatT) / cos($legSplay)' }, output: false });
c('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' }, output: false });
c('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'], output: true });
console.log(JSON.stringify(s.call('scene').result, null, 1));

c('propose', { title: 'Mid-century splay' });
c('set-param', { name: 'legSplay', value: 8, unit: 'deg' });
c('set-op', { id: 'leg', args: { h: '$seatH - $seatT' }, label: 'Simplify leg height (deliberate bug)' });
for (const st of (s.call('proposals').result as any[])[0].steps) console.log(`  step ${st.n} ${st.summary} affects=${JSON.stringify(st.affects)}`);
c('undo-step', { step: 2 });
console.log('checks after undoing step 2:', (s.call('check').result as any)['walnut-stool'].map((x: any) => `${x.label}=${x.pass}`).join(', '));
console.log(JSON.stringify(s.call('commit-proposal').result));
console.log((s.call('log').result as any[]).map((x) => `${x.id} ${x.summary}`).join('\n'));
