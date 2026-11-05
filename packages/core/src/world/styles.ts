// Per-region style rules (Decision 27; the pre-mortem's "towns looked generic" tripwire): how a
// region's buildings are usually shaped and coloured. A style turns plain plan buildings into ones that
// read as a place — palettes by use, roof habits, floor heights, shopfronts, cornices, street trees.
import type { Building, BuildingUse, Palette, RoofType } from './plan.ts';
import { hash32 } from './geo.ts';

export interface Style {
  id: string;
  label: string;
  floorHeight: number;                 // m per upper floor
  groundFloor: number;                 // m for the ground floor
  defaultFloors(use: BuildingUse, area: number, r: number): number;
  roof(b: Building, r: number): RoofType;
  palettes: Partial<Record<BuildingUse | 'default', Palette[]>>;
  storefront(b: Building): boolean;
  cornice: boolean;                    // a ledge where the wall meets the roof
  glassTowerAbove: number;             // buildings taller than this get curtain-wall glass bands
  colors: { ground: string; road: string; marking: string; sidewalk: string; park: string; water: string; plaza: string; trunk: string; leaves: string[]; awning: string[] };
  streetTrees: number;                 // spacing (m) of trees along main streets; 0 = none
}

const pal = (wall: string, trim: string, roof: string, glass = '#2f3b45', accent?: string): Palette => ({ wall, trim, roof, glass, ...(accent ? { accent } : {}) });

export const STYLES: Record<string, Style> = {
  'raleigh-downtown': {
    id: 'raleigh-downtown',
    label: 'Raleigh downtown: brick and limestone mid-rises, flat roofs with parapets, green-glass towers, willow oaks',
    floorHeight: 3.7, groundFloor: 4.8,
    defaultFloors(use, area, r) {
      if (use === 'parking') return 4 + Math.floor(r * 3);
      if (area > 2500) return 6 + Math.floor(r * 6);
      if (area > 800) return 3 + Math.floor(r * 4);
      return 2 + Math.floor(r * 2);
    },
    roof: (b) => (b.use === 'church' ? 'gable' : 'flat'),
    palettes: {
      default: [pal('#9c4f3e', '#e3d6bd', '#55524d'), pal('#b98e66', '#efe6d3', '#5d5a54'), pal('#d6cbb5', '#a8a091', '#615e58'), pal('#8b3f33', '#d9cdb4', '#4c4945'), pal('#c7b08a', '#7d6a54', '#56534e'), pal('#a35d43', '#f0e8d8', '#4f4c47', '#2f3b45', '#2f5d50')],
      office: [pal('#cfc6b4', '#8e8778', '#5a5853', '#3c5566'), pal('#b5aea2', '#e8e2d6', '#4d4b47', '#3a4d5c'), pal('#9c4f3e', '#e3d6bd', '#55524d'), pal('#d8d2c4', '#6f6a60', '#55534e', '#41606e')],
      tower: [pal('#7f9aa3', '#d7dcdc', '#4a4c4e', '#3f6672'), pal('#8f9ea8', '#e4e6e4', '#46484a', '#40596f'), pal('#b8b2a6', '#e9e5dc', '#4b4a47', '#38505e')],
      civic: [pal('#d9d0bd', '#f3eee2', '#6a675f', '#33404a'), pal('#c9bea8', '#ece5d5', '#5f5c55')],
      parking: [pal('#bdb7ab', '#d8d3c8', '#6b6862', '#4a4a48'), pal('#aaa49a', '#cfc9bd', '#66635d', '#474745')],
      hotel: [pal('#c4a27f', '#f0e7d6', '#56534e', '#33424d'), pal('#a8b0b3', '#e7e9e7', '#4b4c4d', '#3a5566')],
      church: [pal('#8d8a83', '#c9c2b2', '#4f5a5f')],
      home: [pal('#a45a46', '#efe4cf', '#4f4b46'), pal('#d6c7a8', '#8a7a62', '#5b5852')],
    },
    storefront: (b) => b.use !== 'parking' && b.use !== 'church' && b.use !== 'home',
    cornice: true,
    glassTowerAbove: 45,
    colors: { ground: '#b9b1a3', road: '#4f4f52', marking: '#e8e2cf', sidewalk: '#cfc7b8', park: '#7d9a5a', water: '#5f8fa3', plaza: '#d9cfbd', trunk: '#5a4636', leaves: ['#5f7f3e', '#6e8c45', '#58773a', '#7a9550'], awning: ['#2f5d50', '#8a3b32', '#2d4a6b', '#b0813a', '#5a3d5c'] },
    streetTrees: 13,
  },
  'river-town-1920s': {
    id: 'river-town-1920s',
    label: 'River town, 1920s: clapboard houses and shops with gables, a brick mill, tin roofs, a green',
    floorHeight: 3.2, groundFloor: 3.8,
    defaultFloors(use, area, r) {
      if (use === 'industrial') return 3 + Math.floor(r * 2);
      if (use === 'church') return 1;
      if (use === 'shop' || use === 'civic' || use === 'hotel') return 2 + Math.floor(r * 2);
      return 1 + Math.floor(r * 2);
    },
    roof(b, r) {
      if (b.use === 'industrial') return r < 0.6 ? 'gable' : 'shed';
      if (b.use === 'shop') return r < 0.55 ? 'flat' : 'gable';
      if (b.use === 'civic' || b.use === 'hotel') return r < 0.5 ? 'hip' : 'flat';
      return r < 0.7 ? 'gable' : 'hip';
    },
    palettes: {
      default: [pal('#c9d6c3', '#f4f0e6', '#55606b'), pal('#e8d7a8', '#fbf7ee', '#8a4b32'), pal('#d9a58f', '#f6efe4', '#55606b'), pal('#a9c1cf', '#f7f4ec', '#5d7258'), pal('#f1ece0', '#6d7f73', '#8a4b32'), pal('#c7b7d6', '#f6f2ea', '#55606b')],
      shop: [pal('#a85b45', '#f1e6d0', '#4f5459', '#2f3b45', '#2f5d50'), pal('#e2cf9a', '#5d4a3a', '#55606b', '#2f3b45', '#8a3b32'), pal('#9fb7a8', '#f4efe4', '#5d4f45', '#2f3b45', '#2d4a6b')],
      industrial: [pal('#8f4a37', '#d8c7a8', '#4c5054'), pal('#9d5a42', '#e0d1b4', '#5b4b40')],
      civic: [pal('#f2eee4', '#7b8a80', '#55606b'), pal('#a65a46', '#efe4cf', '#4f5459')],
      church: [pal('#f4f1ea', '#7d6b5c', '#5a5f66')],
      hotel: [pal('#d8b98a', '#fbf6ea', '#4f5459')],
    },
    storefront: (b) => b.use === 'shop' || b.use === 'hotel',
    cornice: true,
    glassTowerAbove: 999,
    colors: { ground: '#9cab78', road: '#8a8273', marking: '#d8d0bb', sidewalk: '#c9bea6', park: '#88a862', water: '#5b8ea0', plaza: '#cdbf9f', trunk: '#5b4635', leaves: ['#6b8f43', '#7d9b4b', '#5d7e3d', '#8ea65a'], awning: ['#2f5d50', '#8a3b32', '#c9a24a', '#2d4a6b'] },
    streetTrees: 16,
  },
};
STYLES.generic = { ...STYLES['raleigh-downtown'], id: 'generic', label: 'Generic: plain colours, flat roofs, no regional habits', cornice: false, streetTrees: 0, storefront: () => false, palettes: { default: [pal('#bdb8ae', '#bdb8ae', '#6b6862')] } };

export function styleFor(id: string): Style {
  const s = STYLES[id];
  if (!s) throw new Error(`unknown style "${id}" (have: ${Object.keys(STYLES).join(', ')})`);
  return s;
}

/** A building's random-but-stable number in [0, 1) for one purpose (palette, floors, roof…). */
export function stable(id: string, what: string): number { return (hash32(`${id}|${what}`) % 100000) / 100000; }

export function paletteFor(style: Style, b: Building): Palette {
  const list = style.palettes[b.use] ?? style.palettes.default!;
  return list[Math.floor(stable(b.id, 'palette') * list.length)];
}
