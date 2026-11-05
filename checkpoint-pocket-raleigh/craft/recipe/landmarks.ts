// Raleigh landmarks, craft pass (Phase 4): shapes from references, not memory.
//  - NC State Capitol (Union Square): cruciform Greek Revival block of grey-tan gneiss, ~42.7 m E–W
//    (with porticoes) × ~48.8 m N–S; tetrastyle Doric porticoes east and west only; five pilastered bays
//    on the south front that faces Fayetteville St; three storeys over a rusticated ground floor; a Doric
//    entablature and solid parapet; a copper dome on an octagonal and two round plinths, crown ~30 m.
//    The copper was replaced in 2023–24, so it reads penny-bronze, not green.
//    Sources: NRHP nomination (npgallery.nps.gov/NRHP/GetAsset/NHLS/70000476_text),
//    northcarolinahistory.org/encyclopedia/north-carolina-state-capitol, en.wikipedia.org/wiki/North_Carolina_State_Capitol,
//    dncr.nc.gov 2024-06-28 reopening release, Overture footprint ov:a50fcb09 (44 × 48 m).
//  - Duke Energy Center for the Performing Arts (now Martin Marietta Center): Memorial Auditorium's
//    Doric portico on the Fayetteville St axis (six columns, replica columns in front of a glass outer
//    lobby), Meymandi Concert Hall and Fletcher Opera Theater wings either side, fly tower behind.
//    Sources: en.wikipedia.org/wiki/Raleigh_Memorial_Auditorium, martinmariettacenter.com/history,
//    ncarchitects.lib.ncsu.edu/people/P000413, Overture footprint ov:d7a935a6 (135 × 114 m). Massing estimated.
//  - PNC Plaza: "three glass boxes stacked with a metal pyramid on top", blue glass; roof 130 m, pyramid
//    137–151 m, spire to 164 m lit with white LEDs. Sources: skyscraperpage.com/b44421,
//    en.wikipedia.org/wiki/PNC_Plaza_(Raleigh), community.dtraleigh.com/t/pnc-plaza-looking-back/483,
//    waltermagazine.com/art-and-culture/spotlight-canes-city/.
//  - Wells Fargo Capitol Center: postmodern, dark rose-brown granite grid over glass, roof 119 m, antenna
//    122 m, a triangular gable at the very top (no copper hip). Sources: skyscraperpage.com/b847,
//    community.dtraleigh.com/t/wells-fargo-building/374, LocalWiki (quoted).
// Material names ending in lamp / lit / flood / neon / sign join a look's light classes.
import { spawnSync } from 'node:child_process';
const PORT = process.env.STUDIO_PORT ?? '4660';
const run = (cmd: string, args: Record<string, unknown>, okToFail = false) => {
  const argv = [cmd];
  for (const [k, v] of Object.entries(args)) argv.push(`--${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  const r = spawnSync('./studio', argv, { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: PORT } });
  let j: any; try { j = JSON.parse(r.stdout); } catch { j = { ok: false, error: r.stdout + r.stderr }; }
  if (!j.ok && !okToFail) { console.error(cmd, JSON.stringify(args).slice(0, 300), '→', j.error, j.hint ?? ''); process.exit(1); }
  return j;
};
type V = [number, number, number];
let cur = '';
const op = (id: string, o: string, args: any, part: string, extra: Record<string, unknown> = {}) => run('add-op', { object: cur, id, op: o, args, part, output: false, ...extra });
const box = (id: string, size: V, at: V, part: string) => op(id, 'box', { size, at }, part);
const arr = (id: string, input: string, count: number, step: V, part: string) => op(id, 'array', { count, step }, part, { inputs: [input] });
const fresh = (name: string, type: string, description: string, at: V) => {
  run('delete-object', { object: name }, true);
  run('new-object', { name, type, description, position: at });
  cur = name;
};
const finish = (inputs: string[]) => run('add-op', { object: cur, id: 'all', op: 'union', args: {}, inputs, output: true });
const mat = (part: string, name: string, color: string, roughness = 0.8, metalness = 0) => run('set-material', { object: cur, part, name, color, roughness, metalness });

// ── NC State Capitol ─────────────────────────────────────────────────────────
// model space: x east, z south, y up, origin at the footprint centre on the floor
fresh('NC State Capitol', 'building', 'North Carolina State Capitol (1833–40, Town & Davis / David Paton): Greek Revival, gneiss, copper dome; closes the north vista of Fayetteville St at Union Square', [-600, 0, -600]);
const cornice = 15.4;
box('nsBlock', [26, cornice, 48.8], [0, cornice / 2, 0], 'stone');
box('ewBlock', [34.5, cornice, 30], [0, cornice / 2, 0], 'stone');
box('nsRust', [26.5, 4.2, 49.3], [0, 2.1, 0], 'rustication');
box('ewRust', [35, 4.2, 30.5], [0, 2.1, 0], 'rustication');
box('nsEnt', [26.8, 1.8, 49.6], [0, cornice - 0.6, 0], 'entablature');
box('ewEnt', [35.3, 1.8, 30.8], [0, cornice - 0.6, 0], 'entablature');
box('nsPar', [25.6, 1.6, 48.4], [0, cornice + 1.1, 0], 'stone');
box('ewPar', [34.1, 1.6, 29.6], [0, cornice + 1.1, 0], 'stone');
// antae (pilasters) on the south and north fronts: five bays between coupled corner antae
box('anta', [0.95, 9.4, 0.5], [-13.0, 4.2 + 4.7, -24.55], 'entablature');
arr('antaeN', 'anta', 6, [5.2, 0, 0], 'entablature');
box('antaS', [0.95, 9.4, 0.5], [-13.0, 4.2 + 4.7, 24.55], 'entablature');
arr('antaeS', 'antaS', 6, [5.2, 0, 0], 'entablature');
// windows: ground (rusticated), piano nobile (tall, with an entablature over), third storey (short)
const rows: Array<[number, number]> = [[2.3, 2.0], [7.2, 3.2], [11.6, 1.9]];
const winIds: string[] = [];
rows.forEach(([y, h], ri) => {
  for (const [face, zf] of [['N', -24.5], ['S', 24.5]] as const) {
    const id = `w${face}${ri}`;
    box(id + 'a', [1.9, h, 0.3], [-10.4, y, zf], 'windows');
    arr(id, id + 'a', 5, [5.2, 0, 0], 'windows'); winIds.push(id);
  }
  for (const [face, xf] of [['E', 13.1], ['W', -13.1]] as const) for (const [k, z0] of [[0, -21], [1, 16.2]] as const) {
    const id = `w${face}${ri}${k}`;
    box(id + 'a', [0.3, h, 1.9], [xf, y, z0], 'windows');
    arr(id, id + 'a', 2, [0, 0, 4.8], 'windows'); winIds.push(id);
  }
  for (const [face, xf] of [['E', 17.35], ['W', -17.35]] as const) for (const z0 of [-12.6, 9.4]) {
    const id = `p${face}${ri}${z0 < 0 ? 'n' : 's'}`;
    box(id + 'a', [0.3, h, 1.9], [xf, y, z0], 'windows');
    arr(id, id + 'a', 2, [0, 0, 3.2], 'windows'); winIds.push(id);
  }
});
box('nobileHoodN', [1.0, 0.35, 0.2], [0, 9.1, -24.6], 'entablature');
// porticoes east and west: rusticated piers carry four Doric columns, entablature and pediment
const porticoIds: string[] = [];
for (const [s, k] of [[1, 'E'], [-1, 'W']] as const) {
  box(`pier${k}`, [4.6, 4.2, 15], [s * 19.6, 2.1, 0], 'rustication');
  op(`col${k}a`, 'cylinder', { r1: 0.78, r2: 0.62, h: 9.2, at: [s * 20.6, 4.2, -5.4], segments: 16 }, 'columns');
  arr(`col${k}`, `col${k}a`, 4, [0, 0, 3.6], 'columns');
  box(`pent${k}`, [5.0, 1.8, 15.4], [s * 19.5, cornice - 0.6, 0], 'entablature');
  op(`ped${k}`, 'extrude', { profile: [[-7.9, cornice + 0.3], [7.9, cornice + 0.3], [0, cornice + 3.2]], h: 5.0, axis: 'x', at: [s > 0 ? 17.1 : -22.1, 0, 0] }, 'stone');
  box(`door${k}`, [0.3, 3.4, 1.8], [s * 17.35, 4.2 + 1.7, 0], 'windows');
  porticoIds.push(`pier${k}`, `col${k}`, `pent${k}`, `ped${k}`, `door${k}`);
}
// the dome: an octagonal plinth, two round plinths, a shallow copper dome and the oculus crown
const d0 = cornice + 1.9;
op('octo', 'cylinder', { r: 11.2, h: 2.1, at: [0, d0, 0], segments: 8 }, 'stone');
op('drum1', 'cylinder', { r: 9.7, h: 1.5, at: [0, d0 + 2.1, 0], segments: 40 }, 'entablature');
op('drum2', 'cylinder', { r: 8.8, h: 1.3, at: [0, d0 + 3.6, 0], segments: 40 }, 'stone');
const domeProfile: Array<[number, number]> = [[0, 0]];
for (let i = 0; i <= 10; i++) { const a = (i / 10) * (Math.PI / 2); domeProfile.push([+(8.4 * Math.cos(a)).toFixed(3), +(7.0 * Math.sin(a)).toFixed(3)]); }
domeProfile[domeProfile.length - 1] = [0, 7.0];
op('dome', 'revolve', { profile: domeProfile, at: [0, d0 + 4.9, 0], segments: 40 }, 'copper');
op('oculus', 'cylinder', { r1: 1.9, r2: 1.6, h: 1.0, at: [0, d0 + 11.6, 0], segments: 16 }, 'entablature');
op('crown', 'cylinder', { r1: 0.9, r2: 0.2, h: 1.2, at: [0, d0 + 12.6, 0], segments: 8 }, 'crown');
// George Washington statue on the south lawn, facing Fayetteville St
box('gwPlinth', [2.2, 2.6, 2.2], [0, 1.3, 33], 'rustication');
op('gw', 'cylinder', { r1: 0.45, r2: 0.3, h: 2.3, at: [0, 2.6, 33], segments: 8 }, 'bronze');
finish(['nsBlock', 'ewBlock', 'nsRust', 'ewRust', 'nsEnt', 'ewEnt', 'nsPar', 'ewPar', 'antaeN', 'antaeS', ...winIds, 'nobileHoodN', ...porticoIds, 'octo', 'drum1', 'drum2', 'dome', 'oculus', 'crown', 'gwPlinth', 'gw']);
mat('stone', 'gneiss flood', '#b7ad9b', 0.85);
mat('rustication', 'rusticated gneiss flood', '#a29886', 0.9);
mat('entablature', 'gneiss trim flood', '#cbc2b1', 0.8);
mat('columns', 'doric columns flood', '#c6bdab', 0.8);
mat('windows', 'capitol sash', '#2b2e30', 0.4);
mat('copper', 'copper dome flood', '#9a6744', 0.5);
mat('crown', 'iron crown', '#3a3631', 0.6, 0.5);
mat('bronze', 'bronze statue', '#4b3d2c', 0.5, 0.6);

// ── Duke Energy Center for the Performing Arts ───────────────────────────────
// front (Memorial Auditorium portico) faces north up Fayetteville St (−z); the street axis is 3.5 m east of the footprint centre
fresh('Duke Energy Center for the Performing Arts', 'building', 'Duke Energy Center for the Performing Arts (Memorial Auditorium 1932 with replica Doric portico, Meymandi and Fletcher wings 2001): closes the south end of Fayetteville St', [-700, 0, -600]);
const ax = 3.5;
box('aud', [42, 18, 72], [ax, 9, -14], 'stucco');
box('fly', [28, 29, 22], [ax, 14.5, 12], 'stucco');
box('rear', [60, 12, 30], [0, 6, 40], 'masonry');
box('meymandi', [44, 21, 88], [-40, 10.5, -6], 'masonry');
box('fletcher', [38, 19, 88], [44, 9.5, -6], 'masonry');
box('mLobby', [36, 14, 3], [-40, 7, -51], 'lobby');
box('fLobby', [30, 12, 3], [44, 6, -51], 'lobby');
box('mCanopy', [38, 0.45, 6], [-40, 6.2, -54.5], 'metal');
box('fCanopy', [32, 0.45, 6], [44, 6.2, -54.5], 'metal');
box('mCap', [44.6, 1.2, 88.6], [-40, 21.6, -6], 'trim');
box('fCap', [38.6, 1.2, 88.6], [44, 19.6, -6], 'trim');
box('stylobate', [31, 1.2, 9], [ax, 0.6, -54.5], 'trim');
op('pcolA', 'cylinder', { r1: 0.9, r2: 0.72, h: 11, at: [ax - 12.5, 1.2, -57], segments: 16 }, 'columns');
arr('pcols', 'pcolA', 6, [5, 0, 0], 'columns');
box('pEnt', [31, 2.3, 8], [ax, 13.35, -54], 'columns');
box('pAttic', [29, 2.8, 6.5], [ax, 15.9, -53.3], 'stucco');
box('outerLobby', [27, 11, 3], [ax, 6.7, -51.5], 'lobby');
// the wing fronts are glass curtain walls: dark mullions every 3 m and two spandrel bands
box('mMul', [0.35, 14, 0.5], [-57.5, 7, -52.6], 'metal'); arr('mMuls', 'mMul', 12, [3, 0, 0], 'metal');
box('fMul', [0.35, 12, 0.5], [29.5, 6, -52.6], 'metal'); arr('fMuls', 'fMul', 10, [3, 0, 0], 'metal');
box('mSpan', [36.2, 0.9, 0.5], [-40, 9.8, -52.6], 'metal'); arr('mSpans', 'mSpan', 2, [0, 3.2, 0], 'metal');
box('fSpan', [30.2, 0.9, 0.5], [44, 8.8, -52.6], 'metal');
finish(['aud', 'fly', 'rear', 'meymandi', 'fletcher', 'mLobby', 'fLobby', 'mCanopy', 'fCanopy', 'mCap', 'fCap', 'stylobate', 'pcols', 'pEnt', 'pAttic', 'outerLobby', 'mMuls', 'fMuls', 'mSpans', 'fSpan']);
mat('stucco', 'limestone flood', '#ddd3bf', 0.85);
mat('masonry', 'buff masonry', '#c4ab86', 0.85);
mat('trim', 'precast trim', '#e4ddcf', 0.8);
mat('columns', 'portico columns flood', '#f0eadc', 0.75);
mat('lobby', 'lobby glass lit', '#3a4a52', 0.25);
mat('metal', 'canopy metal', '#6c737a', 0.45, 0.6);

// ── PNC Plaza (revised: three stacked blue-glass boxes, a metal pyramid, a lit spire) ──
fresh('PNC Plaza', 'building', 'PNC Plaza, 301 Fayetteville St (2008): 164 m; three stacked blue-glass boxes, precast band, metal pyramid and a white-lit spire (landmark)', [-400, 0, -400]);
box('podium', [60, 16, 47], [0, 8, 0], 'podium');
box('storefront', [60.4, 5, 47.4], [0, 2.8, 0], 'storefront');
box('deckBand', [60.4, 0.9, 47.4], [0, 9.5, 0], 'precast');
box('g1', [42, 46, 31], [0, 16 + 23, 0], 'glass');
box('g2', [40, 40, 29.5], [0, 62 + 20, 0], 'glass');
box('g3', [37.5, 28, 27.5], [0, 102 + 14, 0], 'glass');
box('ledge1', [43, 1.2, 32], [0, 62, 0], 'precast');
box('ledge2', [41, 1.2, 30.5], [0, 102, 0], 'precast');
box('b1', [42.6, 0.7, 31.6], [0, 19, 0], 'spandrel'); arr('bands1', 'b1', 11, [0, 4.0, 0], 'spandrel');
box('b2', [40.6, 0.7, 30.1], [0, 65, 0], 'spandrel'); arr('bands2', 'b2', 9, [0, 4.0, 0], 'spandrel');
box('b3', [38.1, 0.7, 28.1], [0, 105, 0], 'spandrel'); arr('bands3', 'b3', 6, [0, 4.0, 0], 'spandrel');
box('f1', [0.6, 46, 31.8], [-18, 39, 0], 'mullions'); arr('fins1', 'f1', 4, [12, 0, 0], 'mullions');
box('top', [38.5, 7, 28.5], [0, 133.5, 0], 'precast');
box('topGlass', [38.9, 2.2, 28.9], [0, 134, 0], 'crownglass');
box('pyrBase', [36, 0.4, 26], [0, 137.2, 0], 'pyramid');
box('pyrTop', [3, 0.4, 3], [0, 150.8, 0], 'pyramid');
op('pyr', 'hull', {}, 'pyramid', { inputs: ['pyrBase', 'pyrTop'] });
op('spire', 'cylinder', { r1: 1.0, r2: 0.15, h: 13.2, at: [0, 151, 0], segments: 8 }, 'spire');
finish(['podium', 'storefront', 'deckBand', 'g1', 'g2', 'g3', 'ledge1', 'ledge2', 'bands1', 'bands2', 'bands3', 'fins1', 'top', 'topGlass', 'pyr', 'spire']);
mat('podium', 'precast', '#cfc6b4', 0.85);
mat('storefront', 'storefront glass shop', '#2c3d48', 0.3);
mat('precast', 'precast band', '#dcd5c6', 0.8);
mat('glass', 'blue tower glass', '#3d6f9c', 0.28);
mat('spandrel', 'spandrel', '#557e9e', 0.5);
mat('mullions', 'mullions', '#d9dedf', 0.6);
mat('crownglass', 'crown glass lit', '#6fa3b8', 0.3);
mat('pyramid', 'pyramid metal', '#9aa3a8', 0.45, 0.6);
mat('spire', 'spire lamp', '#f2f5f6', 0.4);

// ── Wells Fargo Capitol Center (revised: dark rose-brown granite grid, mid setback, triangular gable) ──
fresh('Wells Fargo Capitol Center', 'building', 'Wells Fargo Capitol Center, 150 Fayetteville St (1990–91): 119 m postmodern tower, dark rose-brown granite grid over glass, setback crown with a triangular gable (landmark)', [-460, 0, -400]);
box('base', [52, 22, 39], [0, 11, 0], 'granite');
box('baseGlass', [52.4, 6, 39.4], [0, 3.6, 0], 'storefront');
box('shaftGlass', [40, 84, 30], [0, 22 + 42, 0], 'glass');
box('pier', [1.5, 84, 30.8], [-19.4, 64, 0], 'granite'); arr('piersX', 'pier', 9, [4.85, 0, 0], 'granite');
box('pierZ', [40.8, 84, 1.5], [0, 64, -14.6], 'granite'); arr('piersZ', 'pierZ', 2, [0, 0, 29.2], 'granite');
box('pierZm', [40.8, 84, 1.4], [0, 64, -4.9], 'granite');
box('pierZn', [40.8, 84, 1.4], [0, 64, 4.9], 'granite');
box('spandrel', [40.7, 1.3, 30.7], [0, 24.5, 0], 'granite'); arr('spandrels', 'spandrel', 22, [0, 3.85, 0], 'granite');
box('setback', [34, 10, 25], [0, 106 + 5, 0], 'granite');
box('setGlass', [34.3, 5, 25.3], [0, 111, 0], 'glass');
box('eave', [35.5, 0.9, 26.5], [0, 116.2, 0], 'trim');
op('gable', 'extrude', { profile: [[-13, 116.6], [13, 116.6], [0, 122.5]], h: 35, axis: 'x', at: [-17.5, 0, 0] }, 'gable');
op('gableGlass', 'extrude', { profile: [[-9, 117.2], [9, 117.2], [0, 121.2]], h: 35.6, axis: 'x', at: [-17.8, 0, 0] }, 'gableglass');
op('antenna', 'cylinder', { r1: 0.3, r2: 0.12, h: 5, at: [0, 122.4, 0], segments: 6 }, 'antenna');
finish(['base', 'baseGlass', 'shaftGlass', 'piersX', 'piersZ', 'pierZm', 'pierZn', 'spandrels', 'setback', 'setGlass', 'eave', 'gable', 'gableGlass', 'antenna']);
mat('granite', 'rose granite', '#8e6253', 0.8);
mat('storefront', 'storefront glass shop', '#2b3a44', 0.3);
mat('glass', 'tower glass', '#2c3a44', 0.3);
mat('trim', 'granite trim', '#c9ad9c', 0.7);
mat('gable', 'gable granite', '#7d5547', 0.8);
mat('gableglass', 'gable glass lit', '#3c4c56', 0.3);
mat('antenna', 'antenna', '#5c6166', 0.5, 0.6);
console.log('landmarks modelled');
