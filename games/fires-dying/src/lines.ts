// What the blacksmith says. Shared by build-assets.ts (records each line in the studio: local voice,
// lip sync, a performance) and the game (plays the line's clip and its audio).
export type Item = 'tongs' | 'charcoal' | 'hammer' | 'bucket' | 'file';
export interface Line { id: string; text: string; emotion: string; gestures?: string }

export const ITEMS: Record<Item, { name: string; object: string; label: string }> = {
  tongs: { name: 'Tongs', object: 'Tongs', label: 'tongs' },
  charcoal: { name: 'Charcoal', object: 'Charcoal sack', label: 'charcoal' },
  hammer: { name: 'Big hammer', object: 'Big hammer', label: 'the big hammer' },
  bucket: { name: 'Water bucket', object: 'Water bucket', label: 'water' },
  file: { name: 'File', object: 'File', label: 'the file' },
};

export const CALLS: Record<Item, Line> = {
  tongs: { id: 'call-tongs', text: 'Tongs! Quick!', emotion: 'firm', gestures: 'point@tongs' },
  charcoal: { id: 'call-charcoal', text: 'More charcoal, the fire is dying!', emotion: 'scared', gestures: 'point@fire' },
  hammer: { id: 'call-hammer', text: 'Fetch me the big hammer.', emotion: 'firm', gestures: 'beckon@fetch' },
  bucket: { id: 'call-bucket', text: 'Water bucket, lad!', emotion: 'firm', gestures: 'point@water' },
  file: { id: 'call-file', text: 'Hand me the file.', emotion: 'gentle', gestures: 'open-palms@file' },
};

export const LINES = {
  intro: { id: 'intro', text: "The fire's dying, lad. Keep it fed, and fetch whatever I call for.", emotion: 'firm', gestures: 'point@dying, beckon@fetch' },
  good: { id: 'good', text: 'Good lad.', emotion: 'happy', gestures: 'nod@good' },
  wrong: { id: 'wrong', text: 'Not that one!', emotion: 'angry', gestures: 'head-shake@not' },
  win: { id: 'win', text: "Look at that. Finest blade I've made.", emotion: 'happy', gestures: 'open-palms@look' },
  lose: { id: 'lose', text: "The fire's out. We start again tomorrow.", emotion: 'sad', gestures: 'shrug@out' },
} satisfies Record<string, Line>;
