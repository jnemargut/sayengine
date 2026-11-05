// Word notes on a building (Phase 10 step 3): "flat roof", "two storeys taller", "brick", "a shop",
// "hide it" become a fix-layer entry for the building you clicked. Relative words ("taller") read the
// building as it is now; anything not understood is said back, never guessed.
import { ROOF_TYPES, BUILDING_USES, type Building, type BuildingUse, type RoofType } from './plan.ts';
import type { FixSet } from './fixes.ts';

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, couple: 2, few: 3 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s.toLowerCase()]);
const N = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|couple|few)';
const FLOOR = '(?:storeys?|stories|story|floors?|levels?)';

/** Wall colours people name (matched to the Raleigh / river-town palettes). */
export const WALL_WORDS: Record<string, string> = {
  'red brick': '#a8503c', 'brown brick': '#7a4a36', 'dark brick': '#6a3d30', 'pale brick': '#c9a088', 'yellow brick': '#c9a96a', brick: '#9c4f3e',
  limestone: '#d6cbb5', sandstone: '#c8ad84', stone: '#cbc2b0', granite: '#9a978f', marble: '#e6e1d6',
  concrete: '#b8b4ac', stucco: '#e2d6bf', white: '#e8e4dc', cream: '#ece2c8', grey: '#9d9a94', gray: '#9d9a94', black: '#34332f',
  'green glass': '#4f7a72', 'blue glass': '#4a6f8f', glass: '#5f8398', clapboard: '#e5dcc6', wood: '#9a7a58',
};
const ROOF_WORDS: Record<string, RoofType> = { flat: 'flat', gable: 'gable', gabled: 'gable', pitched: 'gable', peaked: 'gable', hip: 'hip', hipped: 'hip', shed: 'shed', 'lean-to': 'shed', pyramid: 'pyramid', pyramidal: 'pyramid', dome: 'dome', domed: 'dome' };
const USE_WORDS: Record<string, BuildingUse> = {
  shop: 'shop', store: 'shop', shops: 'shop', retail: 'shop', office: 'office', offices: 'office', home: 'home', house: 'home', houses: 'home', homes: 'home', flats: 'home', apartments: 'home', apartment: 'home', residential: 'home',
  civic: 'civic', 'city hall': 'civic', courthouse: 'civic', library: 'civic', church: 'church', chapel: 'church', parking: 'parking', garage: 'parking', 'car park': 'parking', hotel: 'hotel', industrial: 'industrial', mill: 'industrial', factory: 'industrial', warehouse: 'industrial', tower: 'tower', skyscraper: 'tower',
};

export interface WordsFix { set: FixSet; hide?: boolean; understood: string[]; unknown: string[] }

/** Read a word note about one building into a fix. Throws when nothing in it is understood. */
export function fixFromWords(text: string, b: Pick<Building, 'floors' | 'height' | 'roof' | 'use'>): WordsFix {
  const set: FixSet = {};
  const understood: string[] = [];
  let hide = false;
  let rest = ` ${text.toLowerCase().replace(/[.!?]/g, ' ').replace(/\s+/g, ' ')} `;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => string | null) => {
    const m = rest.match(re);
    if (!m) return;
    const said = f(m);
    if (said) { understood.push(said); rest = rest.replace(m[0], ' '); }
  };
  const floorsNow = b.floors > 0 ? b.floors : Math.max(1, Math.round(b.height / 3.5));

  // hide it
  take(/\b(hide( it)?|remove( it)?|get rid of it|(it )?(shouldn'?t|doesn'?t) (be|exist)( there)?|not there)\b/, () => { hide = true; return 'hide it'; });
  // roofs
  take(/\b(flat|gabled?|pitched|peaked|hipped|hip|shed|lean-to|pyramidal|pyramid|domed?)\s+roof(ed)?\b/, (m) => { set.roof = ROOF_WORDS[m[1]]; return `${set.roof} roof`; });
  take(/\broof\s+(flat|gabled?|pitched|hipped|hip|shed|pyramid|domed?)\b/, (m) => { set.roof = ROOF_WORDS[m[1]]; return `${set.roof} roof`; });
  take(/\b(a )?dome\b/, () => { set.roof = 'dome'; return 'dome roof'; });
  // floors: relative, then absolute
  take(new RegExp(`\\b${N}\\s+(?:more\\s+)?${FLOOR}\\s+(taller|higher|more|up|extra)\\b`), (m) => { set.floors = floorsNow + num(m[1]); return `${num(m[1])} floor(s) taller → ${set.floors} floors`; });
  take(new RegExp(`\\b${N}\\s+more\\s+${FLOOR}\\b`), (m) => { set.floors = floorsNow + num(m[1]); return `${num(m[1])} more floor(s) → ${set.floors} floors`; });
  take(new RegExp(`\\b${N}\\s+(?:fewer\\s+|less\\s+)?${FLOOR}\\s+(shorter|lower|less|fewer|down)\\b`), (m) => { set.floors = Math.max(1, floorsNow - num(m[1])); return `${num(m[1])} floor(s) shorter → ${set.floors} floors`; });
  take(new RegExp(`\\b${N}\\s+(?:fewer|less)\\s+${FLOOR}\\b`), (m) => { set.floors = Math.max(1, floorsNow - num(m[1])); return `${num(m[1])} fewer floor(s) → ${set.floors} floors`; });
  take(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(?:m|metres|meters)\\s*(tall|high)?\\b`), (m) => { set.height = Number(m[1]); return `${set.height} m tall`; });
  take(new RegExp(`\\b${N}[- ]${FLOOR}(?:\\s+(?:tall|high))?\\b`), (m) => { set.floors = num(m[1]); return `${set.floors} floors`; });
  take(/\b(much )?(taller|higher)\b/, (m) => { set.floors = floorsNow + (m[1] ? 3 : 1); return `taller → ${set.floors} floors`; });
  take(/\b(much )?(shorter|lower)\b/, (m) => { set.floors = Math.max(1, floorsNow - (m[1] ? 3 : 1)); return `shorter → ${set.floors} floors`; });
  // storefronts
  take(/\b(no|without)\s+(store|shop)\s?fronts?\b/, () => { set.storefront = false; return 'no shopfronts'; });
  take(/\b(store|shop)\s?fronts?\b/, () => { set.storefront = true; return 'shopfronts'; });
  // walls (longest names first: "red brick" before "brick")
  for (const w of Object.keys(WALL_WORDS).sort((x, y) => y.length - x.length)) {
    if (set.wall) break;
    take(new RegExp(`\\b${w}( walls?| facade| front)?\\b`), () => { set.wall = WALL_WORDS[w]; if (w.includes('glass')) set.glass = WALL_WORDS[w]; return `${w} walls`; });
  }
  // uses
  for (const w of Object.keys(USE_WORDS).sort((x, y) => y.length - x.length)) {
    if (set.use) break;
    take(new RegExp(`\\b(it'?s |make it |a |an |the )?${w}\\b`), () => { set.use = USE_WORDS[w]; return `a ${set.use}`; });
  }
  const unknown = rest.replace(/\b(it|its|it's|is|the|a|an|make|should|be|and|with|more|please|too|bit|little|roof|walls?|this|one|building)\b/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!understood.length) throw new Error(`I didn't catch "${text}" as a change to this building: try "flat roof", "two storeys taller", "brick", "a shop", "no shopfronts" or "hide it"`);
  if (set.roof && !ROOF_TYPES.includes(set.roof)) delete set.roof;
  if (set.use && !BUILDING_USES.includes(set.use)) delete set.use;
  return { set, ...(hide ? { hide } : {}), understood, unknown };
}
