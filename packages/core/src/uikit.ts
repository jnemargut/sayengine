// The UI kit (Decision 58): tokens (palette, an OFL font, border/corner style, shadow), parts (panel,
// button, bar, item slot, tooltip, title/end card, a speech bubble that tracks a 3D character) and
// house-style SVG icons, compiled to a Godot Theme (.tres) and a web CSS overlay (studio/ui.ts reads it).
// Checks: text contrast, pseudolocalised overflow, tap size ≥ 44 px, safe area, icons lint to SVG Tiny.
import { z } from 'zod';
import type { CheckResult } from './checks.ts';
import type { ToolDef, ToolCtx } from './tools.ts';
import { textAdvance } from './glyphs.ts';

export interface UiTokens {
  palette: { bg: string; panel: string; edge: string; ink: string; muted: string; accent: string; accentInk: string; good: string; bad: string; bubble: string; bubbleInk: string };
  font: { family: string; file: string; licence: string; size: number; title: number };
  border: { width: number; radius: number; style: 'plain' | 'double' | 'notched' };
  shadow: { x: number; y: number; blur: number; colour: string };
  icon: { stroke: number; ink: string };
}
export type UiPart = 'panel' | 'button' | 'bar' | 'slot' | 'tooltip' | 'card' | 'bubble' | 'label';
export interface UiElement { id: string; part: UiPart; x: number; y: number; w: number; h: number; text?: string; icon?: string; value?: number; anchor?: 'tl' | 'tr' | 'bl' | 'br' | 'center' }
export interface UiIcon { svg: string; score?: IconScore }
export interface IconScore { coverage: number; centre: number; extent: number; maxOverlap: { with: string; iou: number }; pass: boolean; notes: string[] }
export interface UiKit {
  tokens: UiTokens;
  /** HUD layout at the reference size (1280×720 px). Bubbles are placed at runtime over their character. */
  layout: UiElement[];
  icons: Record<string, UiIcon>;
  profile?: 'desktop' | 'mobile';
}

export const REF = { w: 1280, h: 720 };
/** The smallest screens each profile is checked at (CSS px), and the unsafe edges there. */
export const UI_PROFILES = {
  desktop: { w: 1280, h: 720, inset: { l: 24, r: 24, t: 18, b: 18 } },          // 2.5% title-safe
  mobile: { w: 844, h: 390, inset: { l: 47, r: 47, t: 0, b: 21 } },             // landscape phone: notch + home bar
};

export const FORGE_TOKENS: UiTokens = {
  palette: { bg: '#1b1411', panel: '#2b211c', edge: '#8a5a2b', ink: '#f4e6cf', muted: '#bfa98b', accent: '#e0782a', accentInk: '#1d1410', good: '#8fbf5a', bad: '#d4553a', bubble: '#f7efe1', bubbleInk: '#2a1d16' },
  font: { family: 'Roboto', file: '@fontsource/roboto/files/roboto-latin-700-normal.woff', licence: 'OFL-1.1', size: 24, title: 52 },
  border: { width: 3, radius: 6, style: 'double' },
  shadow: { x: 0, y: 3, blur: 0, colour: '#00000080' },
  icon: { stroke: 3, ink: '#1d1410' },
};

export const FORGE_LAYOUT: UiElement[] = [
  { id: 'heat', part: 'bar', x: 96, y: 28, w: 300, h: 40, text: 'Fire', value: 0.7 },
  { id: 'score', part: 'label', x: 944, y: 28, w: 240, h: 40, text: 'Blades: 2', anchor: 'tr' },
  { id: 'slot-tongs', part: 'slot', x: 404, y: 588, w: 88, h: 88, icon: 'tongs', anchor: 'bl' },
  { id: 'slot-charcoal', part: 'slot', x: 500, y: 588, w: 88, h: 88, icon: 'charcoal', anchor: 'bl' },
  { id: 'slot-hammer', part: 'slot', x: 596, y: 588, w: 88, h: 88, icon: 'big-hammer', anchor: 'bl' },
  { id: 'slot-file', part: 'slot', x: 692, y: 588, w: 88, h: 88, icon: 'file', anchor: 'bl' },
  { id: 'slot-bucket', part: 'slot', x: 788, y: 588, w: 88, h: 88, icon: 'water-bucket', anchor: 'bl' },
  { id: 'tip', part: 'tooltip', x: 530, y: 532, w: 220, h: 40, text: 'Big hammer' },
  { id: 'pump', part: 'button', x: 1004, y: 588, w: 180, h: 88, text: 'Pump', anchor: 'br' },
];

// ── icons: one house style (48×48, ink outline, rounded joins, palette fills) ───────────────────────
const ICON_SRC: Record<string, (t: UiTokens) => string> = {
  tongs: (t) => `<path d="M10 42 L26 23 L37 7" fill="none" stroke-width="${t.icon.stroke + 3}"/><path d="M10 42 L26 23 L37 7" fill="none" stroke="${t.palette.muted}" stroke-width="${t.icon.stroke}"/><path d="M17 44 L28 26 L43 13" fill="none" stroke-width="${t.icon.stroke + 3}"/><path d="M17 44 L28 26 L43 13" fill="none" stroke="${t.palette.muted}" stroke-width="${t.icon.stroke}"/><circle cx="27" cy="24.5" r="3.5" fill="${t.palette.edge}"/>`,
  charcoal: (t) => `<path d="M8 30 L14 20 L24 18 L30 24 L26 34 L12 35 Z" fill="${t.palette.panel}"/><path d="M24 18 L34 12 L42 18 L40 28 L30 24 Z" fill="${t.palette.bg}"/><path d="M15 26 L20 24 M33 18 L37 20" fill="none" stroke="${t.palette.accent}"/><path d="M14 40 L34 40" fill="none" stroke="${t.palette.muted}" stroke-width="2"/>`,
  'big-hammer': (t) => `<path d="M10 44 L28 20" fill="none" stroke-width="${t.icon.stroke + 3}"/><path d="M10 44 L28 20" fill="none" stroke="${t.palette.edge}" stroke-width="${t.icon.stroke}"/><path d="M23.8 6.6 L41.4 19.8 L34.2 29.4 L16.6 16.2 Z" fill="${t.palette.muted}"/>`,
  file: (t) => `<path d="M30 6 L38 14 L18 40 L10 38 L8 32 Z" fill="${t.palette.muted}"/><path d="M14 30 L32 12 M17 33 L35 15 M20 36 L36 19" fill="none" stroke-width="1.5"/><path d="M8 32 L4 44" fill="none" stroke="${t.palette.edge}" stroke-width="${t.icon.stroke + 1}"/>`,
  'water-bucket': (t) => `<path d="M10 16 L38 16 L34 42 L14 42 Z" fill="${t.palette.edge}"/><path d="M12 16 C12 4 36 4 36 16" fill="none"/><path d="M13 22 L35 22" fill="none" stroke="${t.palette.bubble}"/><path d="M14 19 C20 17 28 21 34 19" fill="none" stroke="#6fa3c7"/>`,
  blade: (t) => `<path d="M8 40 L34 10 L40 8 L38 14 L12 44 Z" fill="${t.palette.bubble}"/><path d="M6 36 L16 46" fill="none" stroke-width="${t.icon.stroke + 1}"/><path d="M4 44 L8 40" fill="none" stroke="${t.palette.edge}" stroke-width="${t.icon.stroke + 2}"/>`,
};
export const ICON_NAMES = Object.keys(ICON_SRC);

export function makeIcon(name: string, t: UiTokens = FORGE_TOKENS): string {
  const body = ICON_SRC[name];
  if (!body) throw new Error(`no house icon "${name}" (have: ${ICON_NAMES.join(', ')}); pass --svg for your own`);
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny" viewBox="0 0 48 48" width="48" height="48"><title>${name.replace(/-/g, ' ')}</title><g fill="none" stroke="${t.icon.ink}" stroke-width="${t.icon.stroke}" stroke-linecap="round" stroke-linejoin="round">${body(t)}</g></svg>`;
}

/** Lint an icon to SVG Tiny 1.2 (what Godot's and every browser's SVG importers handle the same) and the
 *  house style: a 48 viewBox, no CSS, filters, masks, scripts or external links, palette colours only. */
export function lintIcon(svg: string, t: UiTokens = FORGE_TOKENS): string[] {
  const out: string[] = [];
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'defs']);
  for (const m of svg.matchAll(/<([a-zA-Z][\w:-]*)/g)) if (!allowed.has(m[1])) out.push(`<${m[1]}> is not in SVG Tiny 1.2`);
  for (const bad of ['style=', 'class=', 'filter=', 'mask=', 'clip-path=', 'xlink:href=', 'href=', 'transform=', 'opacity=']) if (svg.includes(bad)) out.push(`${bad.slice(0, -1)} is not allowed (SVG Tiny + house style)`);
  if (!/viewBox="0 0 48 48"/.test(svg)) out.push('viewBox must be 0 0 48 48');
  if (svg.length > 3000) out.push(`${svg.length} bytes (keep icons under 3 KB)`);
  const pal = new Set([...Object.values(t.palette), t.icon.ink, '#6fa3c7', 'none'].map((c) => c.toLowerCase()));
  for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) if (!pal.has(m[1].toLowerCase())) out.push(`colour ${m[1]} is not a palette colour`);
  for (const m of svg.matchAll(/stroke-width="([\d.]+)"/g)) { const w = Number(m[1]); if (w < 1.5 || w > t.icon.stroke + 3) out.push(`stroke ${w} is outside the house range 1.5–${t.icon.stroke + 3}`); }
  return out;
}

/** Score icons from their rendered alpha masks (24×24, 0..1): ink coverage, centring, how much of the box
 *  they fill, and how alike each pair looks (IoU) — two icons that read the same at 24 px fail. */
export function scoreIcons(masks: Record<string, Float32Array>, size = 24): Record<string, IconScore> {
  const out: Record<string, IconScore> = {};
  const names = Object.keys(masks);
  for (const n of names) {
    const m = masks[n];
    let sum = 0, cx = 0, cy = 0, x0 = size, y0 = size, x1 = -1, y1 = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const a = m[y * size + x];
      sum += a; cx += a * (x + 0.5); cy += a * (y + 0.5);
      if (a > 0.25) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    const coverage = sum / (size * size);
    const centre = sum ? Math.hypot(cx / sum - size / 2, cy / sum - size / 2) / size : 1;
    const extent = x1 < 0 ? 0 : Math.max(x1 - x0 + 1, y1 - y0 + 1) / size;
    let worst = { with: '', iou: 0 };
    for (const o of names) {
      if (o === n) continue;
      let i = 0, u = 0;
      for (let k = 0; k < m.length; k++) { const a = m[k] > 0.4 ? 1 : 0, b = masks[o][k] > 0.4 ? 1 : 0; i += a & b; u += a | b; }
      const iou = u ? i / u : 0;
      if (iou > worst.iou) worst = { with: o, iou: +iou.toFixed(2) };
    }
    const notes: string[] = [];
    if (coverage < 0.12) notes.push('too thin to read at 24 px');
    if (coverage > 0.6) notes.push('a blob at 24 px');
    if (centre > 0.1) notes.push('off centre');
    if (extent < 0.7) notes.push('too small in its box');
    if (worst.iou > 0.6) notes.push(`reads like ${worst.with}`);
    out[n] = { coverage: +coverage.toFixed(3), centre: +centre.toFixed(3), extent: +extent.toFixed(2), maxOverlap: worst, pass: !notes.length, notes };
  }
  return out;
}

// ── checks ─────────────────────────────────────────────────────────────────────────────────────────
const lum = (h: string) => { const n = parseInt(h.slice(1, 7), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** Pseudolocalise: accented letters and ~40% longer (German and Finnish run about that much longer). */
export function pseudo(s: string): string {
  const map: Record<string, string> = { a: 'á', e: 'é', i: 'î', o: 'ö', u: 'ü', c: 'ç', n: 'ñ', y: 'ý', A: 'Å', E: 'É', I: 'Î', O: 'Ö', U: 'Ü', C: 'Ç', N: 'Ñ' };
  const acc = [...s].map((c) => map[c] ?? c).join('');
  const pad = Math.ceil(s.length * 0.4);
  return `[${acc}${' ~·'.repeat(Math.ceil(pad / 3)).slice(0, pad)}]`;
}
const PAD: Record<UiPart, number> = { panel: 16, button: 18, bar: 10, slot: 6, tooltip: 12, card: 32, bubble: 16, label: 10 };
const fontPx = (e: UiElement, t: UiTokens) => (e.part === 'card' ? t.font.title : e.part === 'bar' || e.part === 'tooltip' ? t.font.size * 0.85 : t.font.size);

export function uiChecks(ui: UiKit): CheckResult[] {
  const t = ui.tokens, p = t.palette, out: CheckResult[] = [];
  const pairs: Array<[string, string, string]> = [['text on panels', p.ink, p.panel], ['muted text on panels', p.muted, p.panel], ['button text', p.accentInk, p.accent], ['speech bubble text', p.bubbleInk, p.bubble], ['tooltip text', p.ink, p.bg]];
  const low = pairs.map(([k, a, b]) => [k, contrast(a, b)] as const).filter(([, r]) => r < 4.5);
  out.push({ id: 'ui-contrast', label: 'Text contrast (WCAG AA 4.5:1)', pass: !low.length, detail: low.length ? low.map(([k, r]) => `${k} ${r.toFixed(1)}:1`).join('; ') : pairs.map(([k, a, b]) => `${k} ${contrast(a, b).toFixed(1)}:1`).join(', ') });
  const over: string[] = [];
  for (const e of ui.layout) {
    if (!e.text) continue;
    const px = fontPx(e, t), room = e.w - 2 * PAD[e.part];
    let w: number;
    try { w = textAdvance(pseudo(e.text), px); } catch { w = pseudo(e.text).length * px * 0.55; }
    if (w > room) over.push(`${e.id} "${e.text}" needs ${Math.ceil(w)} px of ${room} when translated`);
  }
  out.push({ id: 'ui-overflow', label: 'Text fits when translated (pseudolocalised +40%)', pass: !over.length, detail: over.length ? over.join('; ') : `${ui.layout.filter((e) => e.text).length} labels fit with accented, 40%-longer text` });
  const prof = UI_PROFILES[ui.profile ?? 'mobile'], k = prof.h / REF.h;
  const small = ui.layout.filter((e) => e.part === 'button' || e.part === 'slot').filter((e) => Math.min(e.w, e.h) * k < 44);
  out.push({ id: 'ui-tap', label: 'Tap targets ≥ 44 px', pass: !small.length, detail: small.length ? small.map((e) => `${e.id} is ${Math.round(Math.min(e.w, e.h) * k)} px on a ${prof.w}×${prof.h} screen`).join('; ') : `buttons and slots are ≥ 44 px on a ${prof.w}×${prof.h} screen (${ui.profile ?? 'mobile'})` });
  // text people can read on the smallest screen: 12 px for body text, 11 px for bar and tooltip text
  const tiny = ui.layout.filter((e) => e.text).filter((e) => fontPx(e, t) * k < (e.part === 'bar' || e.part === 'tooltip' ? 11 : 12));
  out.push({ id: 'ui-text-size', label: 'Text big enough to read', pass: !tiny.length, detail: tiny.length ? tiny.map((e) => `${e.id} is ${(fontPx(e, t) * k).toFixed(1)} px on a ${prof.w}×${prof.h} screen`).join('; ') : `body text ${(t.font.size * k).toFixed(1)} px on a ${prof.w}×${prof.h} screen (≥ 12)` });
  const ins = prof.inset, unsafe: string[] = [];
  for (const e of ui.layout) {
    // elements are anchored to their corner: on a wider/narrower screen they keep their distance to it
    const l = e.x * k, r = (REF.w - e.x - e.w) * k, tp = e.y * k, b = (REF.h - e.y - e.h) * k;
    const bad = [l < ins.l && 'left', r < ins.r && 'right', tp < ins.t && 'top', b < ins.b && 'bottom'].filter(Boolean);
    if (bad.length) unsafe.push(`${e.id} (${bad.join(', ')})`);
  }
  out.push({ id: 'ui-safe', label: 'Inside the safe area', pass: !unsafe.length, detail: unsafe.length ? `under the notch or home bar: ${unsafe.join('; ')}` : `clear of ${ins.l} px sides and ${ins.b} px bottom on a ${prof.w}×${prof.h} phone` });
  const slotBg = p.bubble, inkC = contrast(t.icon.ink, slotBg);
  out.push({ id: 'ui-icon-contrast', label: 'Icon outlines stand out in their slots (3:1)', pass: inkC >= 3, detail: `icon ink on the slot ${inkC.toFixed(1)}:1` });
  const lint = Object.entries(ui.icons).flatMap(([n, i]) => lintIcon(i.svg, t).map((x) => `${n}: ${x}`));
  out.push({ id: 'ui-icons-tiny', label: 'Icons are SVG Tiny in the house style', pass: !lint.length, detail: lint.length ? lint.join('; ') : `${Object.keys(ui.icons).length} icons lint clean` });
  const scored = Object.entries(ui.icons).filter(([, i]) => i.score);
  if (scored.length < Object.keys(ui.icons).length) out.push({ id: 'ui-icons-score', label: 'Icons read at 24 px', pass: false, pending: true, detail: 'not rendered yet: studio ui-review renders and scores them' });
  else { const bad = scored.filter(([, i]) => !i.score!.pass); out.push({ id: 'ui-icons-score', label: 'Icons read at 24 px', pass: !bad.length, detail: bad.length ? `${bad.map(([n, i]) => `${n}: ${i.score!.notes.join(', ')}`).join('; ')} — redraw, or use a CC0 set (Kenney's game icons are CC0)` : `${scored.length} icons are distinct and legible at 24 px` }); }
  const lic = /^(OFL|CC0|Apache|MIT)/i.test(t.font.licence);
  out.push({ id: 'ui-font', label: 'Font licence allows shipping', pass: lic, detail: `${t.font.family} (${t.font.licence})${lic ? '' : ' — use an OFL font'}` });
  return out;
}

// ── compile: Godot Theme ───────────────────────────────────────────────────────────────────────────
const gcol = (h: string) => { const n = parseInt(h.slice(1, 7), 16), a = h.length >= 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1; return `Color(${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => +(v / 255).toFixed(4)).join(', ')}, ${+a.toFixed(3)})`; };
const shade = (h: string, f: number) => { const n = parseInt(h.slice(1, 7), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))))); return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`; };

export function godotTheme(t: UiTokens, fontRes = 'res://assets/studio/ui/font.woff'): string {
  const subs: string[] = [];
  const box = (id: string, bg: string, edge: string, o: { w?: number; r?: number; pad?: number; shadow?: boolean } = {}) => {
    const w = o.w ?? t.border.width, r = o.r ?? t.border.radius, pad = o.pad ?? 10;
    subs.push(`[sub_resource type="StyleBoxFlat" id="${id}"]\nbg_color = ${gcol(bg)}\nborder_width_left = ${w}\nborder_width_top = ${w}\nborder_width_right = ${w}\nborder_width_bottom = ${w}\nborder_color = ${gcol(edge)}\ncorner_radius_top_left = ${r}\ncorner_radius_top_right = ${r}\ncorner_radius_bottom_right = ${r}\ncorner_radius_bottom_left = ${r}\ncontent_margin_left = ${pad}\ncontent_margin_top = ${pad * 0.6}\ncontent_margin_right = ${pad}\ncontent_margin_bottom = ${pad * 0.6}${o.shadow !== false ? `\nshadow_color = ${gcol(t.shadow.colour)}\nshadow_size = ${Math.max(1, t.shadow.blur)}\nshadow_offset = Vector2(${t.shadow.x}, ${t.shadow.y})` : ''}${t.border.style === 'notched' ? '\ncorner_detail = 1' : ''}`);
    return `SubResource("${id}")`;
  };
  const p = t.palette;
  const rows = [
    `default_font = ExtResource("font")`, `default_font_size = ${t.font.size}`,
    `Panel/styles/panel = ${box('panel', p.panel, p.edge, { pad: 16 })}`, `PanelContainer/styles/panel = SubResource("panel")`,
    `Label/colors/font_color = ${gcol(p.ink)}`, `Label/colors/font_shadow_color = ${gcol(t.shadow.colour)}`, `Label/constants/shadow_offset_y = ${t.shadow.y > 0 ? 1 : 0}`,
    `Button/styles/normal = ${box('btn', p.accent, shade(p.accent, -0.45), { pad: 18 })}`, `Button/styles/hover = ${box('btn_hover', shade(p.accent, 0.15), shade(p.accent, -0.45), { pad: 18 })}`,
    `Button/styles/pressed = ${box('btn_pressed', shade(p.accent, -0.2), shade(p.accent, -0.5), { pad: 18, shadow: false })}`, `Button/styles/disabled = ${box('btn_off', p.muted, shade(p.muted, -0.4), { pad: 18, shadow: false })}`,
    `Button/styles/focus = ${box('btn_focus', '#00000000', p.ink, { pad: 18, shadow: false })}`,
    `Button/colors/font_color = ${gcol(p.accentInk)}`, `Button/colors/font_hover_color = ${gcol(p.accentInk)}`, `Button/colors/font_pressed_color = ${gcol(p.accentInk)}`, `Button/colors/font_disabled_color = ${gcol(shade(p.muted, -0.6))}`,
    `ProgressBar/styles/background = ${box('bar_bg', p.bg, p.edge, { pad: 0 })}`, `ProgressBar/styles/fill = ${box('bar_fill', p.accent, p.accent, { w: 0, pad: 0, shadow: false })}`, `ProgressBar/colors/font_color = ${gcol(p.ink)}`,
    `TooltipPanel/styles/panel = ${box('tip', p.bg, p.edge, { w: Math.max(1, t.border.width - 1), pad: 12 })}`, `TooltipLabel/colors/font_color = ${gcol(p.ink)}`,
    `Slot/base_type = &"PanelContainer"`, `Slot/styles/panel = ${box('slot', p.bubble, p.edge, { pad: 6 })}`,
    `HudLabel/base_type = &"Label"`, `HudLabel/styles/normal = ${box('hudlabel', `${p.panel}c0`, `${p.panel}00`, { w: 0, pad: 10, shadow: false })}`,
    `Bubble/base_type = &"PanelContainer"`, `Bubble/styles/panel = ${box('bubble', p.bubble, p.bubbleInk, { r: 14, pad: 16 })}`,
    `BubbleLabel/base_type = &"Label"`, `BubbleLabel/colors/font_color = ${gcol(p.bubbleInk)}`, `BubbleLabel/colors/font_shadow_color = Color(0, 0, 0, 0)`,
    `Card/base_type = &"PanelContainer"`, `Card/styles/panel = ${box('card', p.panel, p.edge, { w: t.border.width + 1, r: t.border.radius + 4, pad: 40 })}`,
    `TitleLabel/base_type = &"Label"`, `TitleLabel/font_sizes/font_size = ${t.font.title}`, `TitleLabel/colors/font_color = ${gcol(p.accent)}`,
    `MutedLabel/base_type = &"Label"`, `MutedLabel/colors/font_color = ${gcol(p.muted)}`,
  ];
  return `[gd_resource type="Theme" load_steps=${subs.length + 2} format=3]\n\n[ext_resource type="FontFile" path="${fontRes}" id="font"]\n\n${subs.join('\n\n')}\n\n[resource]\n${rows.join('\n')}\n`;
}

// ── compile: web CSS (custom properties + one class per part) ──────────────────────────────────────
export function uiCss(t: UiTokens, fontUrl = 'font.woff'): string {
  const p = t.palette, b = t.border;
  const sh = `${t.shadow.x}px ${t.shadow.y}px ${t.shadow.blur}px ${t.shadow.colour}`;
  const edge = b.style === 'double' ? `${b.width}px double var(--ui-edge)` : `${b.width}px solid var(--ui-edge)`;
  return `/* generated by the studio (UI kit, Decision 58) — managed: edit the tokens in the studio, not this file */
@font-face { font-family: 'StudioUI'; src: url('${fontUrl}') format('woff'); font-weight: 700; font-display: block; }
:root { ${Object.entries(p).map(([k, v]) => `--ui-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`).join(' ')}
  --ui-font: 'StudioUI', system-ui, sans-serif; --ui-size: ${t.font.size}px; --ui-title: ${t.font.title}px; --ui-border: ${b.width}px; --ui-radius: ${b.radius}px; --ui-shadow: ${sh};
  --ui-safe-l: env(safe-area-inset-left, 0px); --ui-safe-r: env(safe-area-inset-right, 0px); --ui-safe-b: env(safe-area-inset-bottom, 0px); }
.ui-root { position: absolute; inset: 0; pointer-events: none; font: 700 var(--ui-size)/1.2 var(--ui-font); color: var(--ui-ink); }
.ui-root > * { position: absolute; pointer-events: auto; box-sizing: border-box; }
.ui-panel { background: var(--ui-panel); border: ${edge}; border-radius: var(--ui-radius); box-shadow: var(--ui-shadow); padding: 10px 16px; }
.ui-label { color: var(--ui-ink); background: ${p.panel}c0; border-radius: var(--ui-radius); text-shadow: 0 1px 0 ${t.shadow.colour}; padding: 0 10px; white-space: nowrap; text-align: right; }
.ui-button { background: var(--ui-accent); color: var(--ui-accent-ink); border: var(--ui-border) solid ${shade(p.accent, -0.45)}; border-radius: var(--ui-radius); box-shadow: var(--ui-shadow); padding: 0 18px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; font: inherit; cursor: pointer; }
.ui-button:hover { background: ${shade(p.accent, 0.15)}; } .ui-button:active { background: ${shade(p.accent, -0.2)}; box-shadow: none; transform: translateY(${t.shadow.y}px); }
.ui-button:focus-visible { outline: 2px solid var(--ui-ink); outline-offset: 2px; }
.ui-bar { background: var(--ui-bg); border: var(--ui-border) solid var(--ui-edge); border-radius: var(--ui-radius); box-shadow: var(--ui-shadow); overflow: hidden; }
.ui-bar > .fill { position: absolute; inset: 0 auto 0 0; background: var(--ui-accent); transition: width .2s; }
.ui-bar > .text { position: relative; padding: 0 10px; font-size: inherit; line-height: inherit; white-space: nowrap; color: var(--ui-ink); text-shadow: 0 1px 0 #000a; }
.ui-slot { background: var(--ui-bubble); border: ${edge}; border-radius: var(--ui-radius); box-shadow: var(--ui-shadow); padding: 6px; display: grid; place-items: center; }
.ui-slot > img { width: 100%; height: 100%; } .ui-slot.selected { border-color: var(--ui-accent); }
.ui-tooltip { background: var(--ui-bg); border: ${Math.max(1, b.width - 1)}px solid var(--ui-edge); border-radius: var(--ui-radius); padding: 0 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-card { background: var(--ui-panel); border: ${b.width + 1}px ${b.style === 'double' ? 'double' : 'solid'} var(--ui-edge); border-radius: ${b.radius + 4}px; box-shadow: var(--ui-shadow); padding: 32px 40px; text-align: center; }
.ui-card > h1 { margin: 0 0 8px; font-size: var(--ui-title); color: var(--ui-accent); } .ui-card > p { margin: 0; color: var(--ui-muted); }
.ui-bubble { background: var(--ui-bubble); color: var(--ui-bubble-ink); border: 2px solid var(--ui-bubble-ink); border-radius: 14px; padding: 8px 16px; max-width: 320px; transform: translate(-50%, -100%); white-space: normal; }
.ui-bubble::after { content: ''; position: absolute; left: 50%; bottom: -12px; margin-left: -8px; border: 8px solid transparent; border-top: 12px solid var(--ui-bubble-ink); border-bottom: 0; }
`;
}

// ── tools ──────────────────────────────────────────────────────────────────────────────────────────
const getUi = (ctx: ToolCtx): UiKit => {
  const ui = (ctx.doc as any).ui;
  if (!ui) throw new Error('no UI kit yet (studio ui-kit --preset forge)');
  return ui;
};
const El = z.object({ id: z.string(), part: z.enum(['panel', 'button', 'bar', 'slot', 'tooltip', 'card', 'bubble', 'label']), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), text: z.string().optional(), icon: z.string().optional(), value: z.number().optional(), anchor: z.enum(['tl', 'tr', 'bl', 'br', 'center']).optional() });

export const UI_TOOLS: ToolDef[] = [
  {
    name: 'ui-kit', mode: 'create', mutates: true,
    description: 'Make or change the game\'s UI kit (Decision 58): tokens (palette, an OFL font, border/corner style, shadow) and a HUD layout at 1280×720. Parts: panel, button, bar, slot (item slot with an icon), tooltip, card (title/end card), bubble (a speech bubble that follows a 3D character; placed at runtime by say()), label. --preset forge starts from the forge style. --tokens merges {palette:{…}, border:{…}, …}; --layout replaces the HUD; --profile mobile|desktop sets which screen the tap-size and safe-area checks use. `game import` compiles it to a Godot Theme and a web CSS overlay.',
    input: z.object({ preset: z.enum(['forge']).optional(), tokens: z.record(z.string(), z.any()).optional(), layout: z.array(El).optional(), profile: z.enum(['desktop', 'mobile']).optional() }),
    example: `studio ui-kit --preset forge --tokens '{"palette":{"accent":"#e0782a"}}'`,
    run(ctx, a) {
      const prev: UiKit | undefined = (ctx.doc as any).ui;
      if (!prev && !a.preset && !a.tokens) throw new Error('pass --preset forge (or --tokens) to start the kit');
      const base: UiKit = a.preset || !prev ? { tokens: structuredClone(FORGE_TOKENS), layout: structuredClone(FORGE_LAYOUT), icons: {} } : structuredClone(prev);
      if (a.tokens) for (const [k, v] of Object.entries(a.tokens)) (base.tokens as any)[k] = typeof v === 'object' && v ? { ...(base.tokens as any)[k], ...v } : v;
      if (a.layout) base.layout = a.layout as UiElement[];
      if (a.profile) base.profile = a.profile;
      // icons are drawn from the tokens, so a palette change redraws the house icons
      for (const n of Object.keys(base.icons)) if (ICON_SRC[n] && !(base.icons[n] as any).custom) base.icons[n] = { svg: makeIcon(n, base.tokens) };
      ctx.set(['ui'], base);
      const checks = uiChecks(base);
      ctx.summary(`UI kit: ${base.tokens.font.family}, ${base.tokens.border.style} ${base.tokens.border.width} px borders, ${base.layout.length} HUD parts — ${checks.filter((c) => !c.pass && !c.pending).length} failing checks`);
      return { tokens: base.tokens, layout: base.layout.length, checks };
    },
  },
  {
    name: 'ui-icon', mode: 'create', mutates: true,
    description: `Add icons to the UI kit in the house style (48×48, ink outline, rounded joins, palette fills; SVG Tiny). House icons: ${ICON_NAMES.join(', ')}. --svg <markup> adds your own (linted the same way). Icons are scored when rendered (studio ui-review): legible and distinct at 24 px. If one won't come right, a CC0 set is the fallback (Kenney's game icons are CC0; game-icons.net is CC BY 3.0 and needs a credit).`,
    input: z.object({ names: z.array(z.string()).optional(), name: z.string().optional(), svg: z.string().optional() }),
    example: `studio ui-icon --names '["tongs","charcoal","big-hammer","file","water-bucket","blade"]'`,
    run(ctx, a) {
      const ui = structuredClone(getUi(ctx));
      const added: string[] = [], problems: Record<string, string[]> = {};
      if (a.svg) {
        if (!a.name) throw new Error('--svg needs --name');
        ui.icons[a.name] = { svg: a.svg, ...({ custom: true } as any) };
        added.push(a.name);
      }
      for (const n of a.names ?? []) { ui.icons[n] = { svg: makeIcon(n, ui.tokens) }; added.push(n); }
      for (const n of added) { const l = lintIcon(ui.icons[n].svg, ui.tokens); if (l.length) problems[n] = l; }
      ctx.set(['ui'], ui);
      ctx.summary(`UI icons: ${added.join(', ')}${Object.keys(problems).length ? ` (${Object.keys(problems).length} need fixing)` : ''}`);
      return { added, lint: problems };
    },
  },
  {
    name: 'ui-info', mode: 'inspect', mutates: false,
    description: 'The UI kit: tokens, HUD layout, icons (with scores once reviewed) and checks — contrast, pseudolocalised overflow, tap size, safe area, SVG Tiny lint.',
    input: z.object({}),
    run(ctx) {
      const ui = getUi(ctx);
      return { tokens: ui.tokens, layout: ui.layout, icons: Object.fromEntries(Object.entries(ui.icons).map(([k, v]) => [k, { bytes: v.svg.length, score: v.score ?? null }])), checks: uiChecks(ui) };
    },
  },
  {
    name: 'ui-score-icons', mode: 'review', mutates: true,
    description: 'Store icon scores from a render (studio ui-review calls this with 24 px alpha masks).',
    input: z.object({ masks: z.record(z.string(), z.array(z.number())) }),
    run(ctx, a) {
      const ui = structuredClone(getUi(ctx));
      const scores = scoreIcons(Object.fromEntries(Object.entries(a.masks).map(([k, v]) => [k, Float32Array.from(v as number[])])));
      for (const [k, s] of Object.entries(scores)) if (ui.icons[k]) ui.icons[k].score = s;
      ctx.set(['ui'], ui);
      const bad = Object.entries(scores).filter(([, s]) => !s.pass);
      ctx.summary(`Icon scores: ${bad.length ? bad.map(([k, s]) => `${k} ${s.notes.join(', ')}`).join('; ') : `all ${Object.keys(scores).length} read at 24 px`}`);
      return { scores };
    },
  },
];
