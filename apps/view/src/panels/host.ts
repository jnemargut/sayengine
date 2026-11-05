// What the view's panels (look, town, UI kit) get from main.ts: a few hooks, nothing more, so the
// panels live in their own files next to the timeline dock and main.ts stays small.
import type * as THREE from 'three';

export interface ViewHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  vpEl: HTMLElement;
  /** a typed tool call as you (the human); `why` is the step's word note */
  call(tool: string, args: object, why?: string): void;
  toast(msg: string): void;
  /** tell the engine what is selected (it becomes `studio selection` and an address) */
  sendSelect(object: string | null, part: string | null): void;
  /** grade the viewport with this look while a slider is held (null: back to the engine's) */
  setLookPreview(look: any | null): void;
  /** re-draw the panels and inspector */
  rerender(): void;
  /** point the camera at a box */
  frameBox(box: THREE.Box3, dir?: [number, number, number]): void;
  /** a thing in words ("Walnut stool / seat", "Mini Raleigh / Office 2a17ab") */
  thingWords(thing: string): string;
}

export const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
