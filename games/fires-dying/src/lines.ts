// What the blacksmith says. Shared by build-assets.ts (records each line in the studio: local voice,
// lip sync, a performance) and the game (say() plays the line's clip, its audio and a bubble).
/** things the apprentice carries */
export type Item = 'tongs' | 'charcoal' | 'hammer' | 'bucket' | 'file' | 'chisel' | 'whetstone';
/** what the smith can call for: a tool, the bellows, or a quench (the bucket into the tub) */
export type Job = 'tongs' | 'hammer' | 'file' | 'chisel' | 'whetstone' | 'bellows' | 'quench';
export interface Line { id: string; text: string; emotion: string; gestures?: string }

/** each carried thing: its studio object (where it lives), what the HUD calls it, its UI kit icon */
export const ITEMS: Record<Item, { object: string; label: string; icon: string }> = {
  tongs: { object: 'Tongs', label: 'the tongs', icon: 'tongs' },
  charcoal: { object: 'Charcoal sack', label: 'charcoal', icon: 'charcoal' },
  hammer: { object: 'Big hammer', label: 'the big hammer', icon: 'big-hammer' },
  bucket: { object: 'Water bucket', label: 'the water bucket', icon: 'water-bucket' },
  file: { object: 'File', label: 'the file', icon: 'file' },
  chisel: { object: 'Chisel', label: 'the chisel', icon: 'chisel' },
  whetstone: { object: 'Whetstone', label: 'the whetstone', icon: 'whetstone' },
};

/** each job: the icon in his bubble and the short "he wants" words */
export const JOBS: Record<Job, { icon: string; want: string }> = {
  tongs: { icon: 'tongs', want: 'Tongs' },
  hammer: { icon: 'big-hammer', want: 'Big hammer' },
  file: { icon: 'file', want: 'File' },
  chisel: { icon: 'chisel', want: 'Chisel' },
  whetstone: { icon: 'whetstone', want: 'Whetstone' },
  bellows: { icon: 'bellows', want: 'The bellows' },
  quench: { icon: 'water-bucket', want: 'Fill the tub' },
};

export const CALLS: Record<Job | 'charcoal', Line> = {
  tongs: { id: 'call-tongs', text: 'Tongs! Quick!', emotion: 'firm', gestures: 'point@tongs' },
  hammer: { id: 'call-hammer', text: 'Fetch me the big hammer.', emotion: 'firm', gestures: 'beckon@fetch' },
  file: { id: 'call-file', text: 'Hand me the file.', emotion: 'gentle', gestures: 'open-palms@file' },
  chisel: { id: 'call-chisel', text: 'Chisel, lad. The cold one.', emotion: 'firm', gestures: 'point@chisel' },
  whetstone: { id: 'call-whetstone', text: 'Bring the whetstone.', emotion: 'gentle', gestures: 'beckon@bring' },
  bellows: { id: 'call-bellows', text: 'Work the bellows! I need heat!', emotion: 'firm', gestures: 'point@bellows' },
  quench: { id: 'call-quench', text: 'Water in the tub, lad. Time to quench.', emotion: 'firm', gestures: 'point@water' },
  charcoal: { id: 'call-charcoal', text: 'More charcoal, the fire is dying!', emotion: 'scared', gestures: 'point@fire' },
};

export const LINES = {
  intro: { id: 'intro', text: "The fire's dying, lad. Keep it fed, and fetch whatever I call for.", emotion: 'firm', gestures: 'point@dying, beckon@fetch' },
  good: { id: 'good', text: 'Good lad.', emotion: 'happy', gestures: 'nod@good' },
  hiss: { id: 'hiss', text: 'Hear it hiss. Good.', emotion: 'happy', gestures: 'nod@hiss' },
  wrong: { id: 'wrong', text: 'Not that one!', emotion: 'angry', gestures: 'head-shake@not' },
  late: { id: 'late', text: "Come on! The iron's going cold!", emotion: 'angry', gestures: 'beckon@come' },
  win: { id: 'win', text: "Look at that. Finest blade I've made.", emotion: 'happy', gestures: 'open-palms@look' },
  lose: { id: 'lose', text: "The fire's out. We start again tomorrow.", emotion: 'sad', gestures: 'shrug@out' },
} satisfies Record<string, Line>;
