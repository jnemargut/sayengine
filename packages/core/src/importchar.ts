// Outside characters, the side door (Decision 50 A): a rigged glTF / GLB / VRM comes in with its bones
// matched to the standard humanoid names, the studio's motions retargeted onto it (our own retargeter:
// a rest-pose fix per bone + hip-height scaling, since three.js's built-in one is unreliable), its face
// driven by what it brings (ARKit shapes → VRM vowels with made-up consonants → a jaw → eyes only), its
// VRM licence read and warned about, and a report of what carried over. A model with no skeleton stays a prop.
import { VISEMES, VISEME_MIX, characterSpec, charParams, buildRig, forward, qMul, qRot, type Q, type V3, type Rig } from './rig.ts';
import { bakeMotion, qInv, qArc, type MotionClip } from './motion.ts';
import type { MotionSpec } from './types.ts';
import { glbMotionChecks } from './blender/glbmotion.ts';

// ── GLB in and out ───────────────────────────────────────────────────────
export interface Gltf { json: any; bin: Uint8Array }
export function readGlb(bytes: Uint8Array): Gltf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) {
    // a .gltf (JSON) with embedded buffers is accepted too
    const json = JSON.parse(new TextDecoder().decode(bytes));
    const uri: string | undefined = json.buffers?.[0]?.uri;
    if (uri && !uri.startsWith('data:')) throw new Error('a .gltf with external buffers: export it as a single .glb first');
    const bin = uri ? Uint8Array.from(atob(uri.split(',')[1]), (c) => c.charCodeAt(0)) : new Uint8Array(0);
    if (json.buffers?.[0]) delete json.buffers[0].uri;
    return { json, bin };
  }
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  let bin = new Uint8Array(0);
  const p = 20 + jsonLen;
  if (p + 8 <= bytes.length) { const binLen = dv.getUint32(p, true); bin = bytes.slice(p + 8, p + 8 + binLen); }
  return { json, bin };
}
export function writeGlb({ json, bin }: Gltf): Uint8Array {
  const pad4 = (n: number) => (n + 3) & ~3;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jl = pad4(jsonBytes.length), bl = pad4(bin.length);
  const out = new Uint8Array(12 + 8 + jl + (bin.length ? 8 + bl : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jl);
  if (bin.length) { dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(bin, 28 + jl); }
  return out;
}
/** Append float data to the binary chunk as a new accessor; returns its index. */
function addAccessor(g: Gltf, data: Float32Array, type: 'SCALAR' | 'VEC3' | 'VEC4', minmax = false): number {
  const pad = (4 - (g.bin.length % 4)) % 4;
  const bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const nb = new Uint8Array(g.bin.length + pad + bytes.length);
  nb.set(g.bin); nb.set(bytes, g.bin.length + pad);
  const offset = g.bin.length + pad;
  g.bin = nb;
  (g.json.buffers ??= [{ byteLength: 0 }])[0].byteLength = g.bin.length;
  (g.json.bufferViews ??= []).push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const acc: any = { bufferView: g.json.bufferViews.length - 1, componentType: 5126, count: data.length / comps, type };
  if (minmax) { let mn = Infinity, mx = -Infinity; for (const v of data) { mn = Math.min(mn, v); mx = Math.max(mx, v); } acc.min = [mn]; acc.max = [mx]; }
  (g.json.accessors ??= []).push(acc);
  return g.json.accessors.length - 1;
}

// ── the node hierarchy at rest ───────────────────────────────────────────
interface RestNode { parent: number; localQ: Q; localT: V3; scale: V3; worldQ: Q; worldP: V3; worldS: number }
function restNodes(json: any): RestNode[] {
  const nodes: any[] = json.nodes ?? [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => { parent[c] = i; }));
  const out: RestNode[] = new Array(nodes.length);
  const visit = (i: number) => {
    if (out[i]) return out[i];
    const n = nodes[i];
    if (n.matrix) throw new Error(`node "${n.name ?? i}" uses a matrix transform; re-export with TRS (translation/rotation/scale)`);
    const localQ = (n.rotation ?? [0, 0, 0, 1]) as Q, localT = (n.translation ?? [0, 0, 0]) as V3, scale = (n.scale ?? [1, 1, 1]) as V3;
    const su = (scale[0] + scale[1] + scale[2]) / 3;
    if (parent[i] < 0) out[i] = { parent: -1, localQ, localT, scale, worldQ: localQ, worldP: localT, worldS: su };
    else {
      const p = visit(parent[i]);
      const wp = qRot(p.worldQ, localT);
      out[i] = { parent: parent[i], localQ, localT, scale, worldQ: qMul(p.worldQ, localQ), worldP: [p.worldP[0] + wp[0] * p.worldS, p.worldP[1] + wp[1] * p.worldS, p.worldP[2] + wp[2] * p.worldS], worldS: p.worldS * su };
    }
    return out[i];
  };
  nodes.forEach((_, i) => visit(i));
  return out;
}

// ── bone names → the standard humanoid ───────────────────────────────────
const CORE: Array<[string, RegExp]> = [
  ['Hips', /^(hips?|pelvis|root_?pelvis|cog)$/], ['Spine', /^(spine|spine0|spine_?01|torso)$/], ['Chest', /^(chest|spine1|spine_?02)$/], ['UpperChest', /^(upperchest|spine2|spine_?03)$/],
  ['Neck', /^(neck|neck1|neck_?01)$/], ['Head', /^(head)$/], ['Jaw', /^(jaw|lowerjaw|jaw_?01)$/],
  ['Eye', /^(eye|eyeball)$/], ['Shoulder', /^(shoulder|clavicle|collar(bone)?)$/], ['UpperArm', /^(upperarm|arm|uparm)$/], ['LowerArm', /^(lowerarm|forearm|elbow)$/],
  ['Hand', /^(hand|wrist)$/], ['UpperLeg', /^(upperleg|upleg|thigh)$/], ['LowerLeg', /^(lowerleg|leg|calf|shin|knee)$/], ['Foot', /^(foot|ankle)$/], ['Toes', /^(toes?|toebase|ball)$/],
];
const FINGER_ALIAS: Record<string, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Little', little: 'Little' };
const SEG: Record<string, string[]> = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] };

/** The humanoid name a bone name stands for, or null. */
export function humanoidName(raw: string): string | null {
  let n = raw.replace(/^mixamorig\d*[:_]?/i, '').replace(/^(bip0?1|def|org|armature|j_bip)[\s_:.-]*/i, '');   // j_bip: VRoid exports (J_Bip_L_UpperArm)
  let side = '';
  const sideM = n.match(/^(left|right)[\s_.-]*/i) ?? n.match(/^([lr])[\s_.-]+/i);
  if (sideM) { side = sideM[1][0].toLowerCase() === 'l' ? 'Left' : 'Right'; n = n.slice(sideM[0].length); }
  else {
    const endM = n.match(/[\s_.-]+(left|right|[lr])$/i) ?? n.match(/(left|right)$/i);
    if (endM) { side = endM[1][0].toLowerCase() === 'l' ? 'Left' : 'Right'; n = n.slice(0, n.length - endM[0].length); }
  }
  const k = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  // fingers: Mixamo LeftHandIndex1, VRM leftIndexProximal, generic index_01_l
  const fm = k.match(/^(?:hand)?(thumb|index|middle|ring|pinky|little)(?:finger)?(proximal|intermediate|distal|metacarpal|\d)$/);
  if (fm && side) {
    const f = FINGER_ALIAS[fm[1]];
    const segs = SEG[f === 'Thumb' ? 'Thumb' : 'other'];
    let seg = fm[2];
    if (/^\d$/.test(seg)) seg = segs[Math.min(2, Math.max(0, Number(seg) - (k.includes('0') && !k.endsWith('0') ? 0 : 1)))] ?? segs[0];
    else seg = seg[0].toUpperCase() + seg.slice(1);
    if (f === 'Thumb' && seg === 'Intermediate') seg = 'Proximal';
    return `${side}${f}${seg}`;
  }
  for (const [name, re] of CORE) {
    if (!re.test(k)) continue;
    const sided = ['Eye', 'Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'].includes(name);
    if (sided) return side ? `${side}${name}` : null;
    return side ? null : name;
  }
  return null;
}

export interface BoneMap { map: Map<string, number>; source: 'vrm1' | 'vrm0' | 'names'; unmatched: string[] }
export function humanoidMap(json: any, skinJoints: number[]): BoneMap {
  const nodes = json.nodes ?? [];
  const map = new Map<string, number>();
  const pascal = (s: string) => s[0].toUpperCase() + s.slice(1);
  const vrm1 = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  const vrm0 = json.extensions?.VRM?.humanoid?.humanBones;
  let source: BoneMap['source'] = 'names';
  if (vrm1) { source = 'vrm1'; for (const [k, v] of Object.entries<any>(vrm1)) map.set(pascal(k).replace('ThumbMetacarpal', 'ThumbMetacarpal'), v.node); }
  else if (vrm0) {
    source = 'vrm0';
    // VRM 0.x thumbs are Proximal/Intermediate/Distal; VRM 1.0 (and the studio) say Metacarpal/Proximal/Distal
    for (const b of vrm0) { let k = pascal(b.bone); k = k.replace(/Thumb(Proximal|Intermediate|Distal)/, (_, s) => `Thumb${({ Proximal: 'Metacarpal', Intermediate: 'Proximal', Distal: 'Distal' } as any)[s]}`); map.set(k, b.node); }
  } else {
    for (const j of skinJoints) { const h = humanoidName(nodes[j]?.name ?? ''); if (h && !map.has(h)) map.set(h, j); }
    // a rig with only Spine and Chest: the top spine bone is the upper chest's job
    if (!map.has('Chest') && map.has('UpperChest')) { map.set('Chest', map.get('UpperChest')!); map.delete('UpperChest'); }
  }
  const mapped = new Set(map.values());
  const unmatched = skinJoints.filter((j) => !mapped.has(j)).map((j) => nodes[j]?.name ?? `#${j}`);
  return { map, source, unmatched };
}

// ── faces ────────────────────────────────────────────────────────────────
export interface MorphRef { node: number; mesh: number; index: number; weight: number }
export interface FaceMap { mode: 'oculus' | 'arkit' | 'vrm' | 'jaw' | 'eyes' | 'none'; visemes: Record<string, MorphRef[]>; jaw?: Record<string, number>; blink: MorphRef[]; note: string }
const ARKIT_VISEMES: Record<string, Record<string, number>> = {
  sil: {}, PP: { mouthClose: 0.6, mouthPressLeft: 0.5, mouthPressRight: 0.5 }, FF: { mouthRollLower: 0.7, mouthUpperUpLeft: 0.25, mouthUpperUpRight: 0.25, jawOpen: 0.08 },
  TH: { jawOpen: 0.2, tongueOut: 0.6 }, DD: { jawOpen: 0.25, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 }, kk: { jawOpen: 0.35, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  CH: { jawOpen: 0.2, mouthFunnel: 0.65 }, SS: { jawOpen: 0.08, mouthStretchLeft: 0.45, mouthStretchRight: 0.45 }, nn: { jawOpen: 0.2, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  RR: { jawOpen: 0.15, mouthFunnel: 0.45, mouthPucker: 0.3 }, aa: { jawOpen: 0.8 }, E: { jawOpen: 0.45, mouthStretchLeft: 0.4, mouthStretchRight: 0.4 },
  ih: { jawOpen: 0.3, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 }, oh: { jawOpen: 0.5, mouthFunnel: 0.7 }, ou: { jawOpen: 0.15, mouthPucker: 0.9 },
};
/** VRM's five vowels, and the consonants made from them (a rounded RR from ou, a near-closed SS from ih + ee…). */
const VRM_VISEMES: Record<string, Record<string, number>> = {
  sil: {}, PP: {}, FF: { ih: 0.25 }, TH: { ih: 0.35, aa: 0.1 }, DD: { ih: 0.4 }, kk: { ih: 0.4, aa: 0.2 }, CH: { ou: 0.45, ih: 0.25 }, SS: { ih: 0.3, ee: 0.3 },
  nn: { ih: 0.35 }, RR: { ou: 0.5 }, aa: { aa: 1 }, E: { ee: 1 }, ih: { ih: 1 }, oh: { oh: 1 }, ou: { ou: 1 },
};

export function faceMap(json: any, bones: BoneMap): FaceMap {
  const nodes: any[] = json.nodes ?? [], meshes: any[] = json.meshes ?? [];
  // every named morph target on a skinned mesh node
  const named = new Map<string, MorphRef>();
  nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    const m = meshes[n.mesh];
    const names: string[] = m?.extras?.targetNames ?? m?.primitives?.[0]?.extras?.targetNames ?? [];
    names.forEach((nm, index) => { const k = nm.toLowerCase().replace(/^.*[.:]/, ''); if (!named.has(k)) named.set(k, { node: ni, mesh: n.mesh, index, weight: 1 }); });
  });
  const ref = (k: string, w: number) => { const r = named.get(k.toLowerCase()); return r ? { ...r, weight: w } : null; };
  const blink = [ref('eyeBlinkLeft', 1), ref('eyeBlinkRight', 1), ref('blink', 1)].filter(Boolean) as MorphRef[];
  // 1) the 15 visemes by name (viseme_aa, viseme_PP…, as Ready Player Me and Oculus rigs ship them)
  const ocu = VISEMES.map((v) => ref(`viseme_${v}`, 1) ?? ref(`v_${v}`, 1));
  if (ocu.filter(Boolean).length >= 10) {
    return { mode: 'oculus', visemes: Object.fromEntries(VISEMES.map((v, i) => [v, ocu[i] ? [ocu[i]!] : []])), blink, note: `the model's own 15 speech shapes (${ocu.filter(Boolean).length} found by name)` };
  }
  // 2) ARKit-named shapes
  const arkitKeys = ['jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthRollLower'];
  if (arkitKeys.filter((k) => named.has(k.toLowerCase())).length >= 4) {
    const visemes: Record<string, MorphRef[]> = {};
    for (const v of VISEMES) visemes[v] = Object.entries(ARKIT_VISEMES[v]).map(([k, w]) => ref(k, w)).filter(Boolean) as MorphRef[];
    return { mode: 'arkit', visemes, blink, note: 'speech shapes built from its ARKit face shapes (jawOpen, mouthFunnel, mouthPucker…)' };
  }
  // 3) VRM expressions (1.0 presets, or 0.x blend-shape groups), or plain vowel shapes
  const vrmExpr = new Map<string, MorphRef[]>();
  const p1 = json.extensions?.VRMC_vrm?.expressions?.preset;
  if (p1) for (const [k, e] of Object.entries<any>(p1)) vrmExpr.set(k, (e.morphTargetBinds ?? []).map((b: any) => ({ node: b.node, mesh: nodes[b.node]?.mesh, index: b.index, weight: b.weight ?? 1 })));
  const g0 = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
  if (g0) for (const g of g0) {
    const k = ({ a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink' } as any)[(g.presetName ?? '').toLowerCase()];
    if (!k) continue;
    vrmExpr.set(k, (g.binds ?? []).map((b: any) => ({ node: nodes.findIndex((n) => n.mesh === b.mesh), mesh: b.mesh, index: b.index, weight: (b.weight ?? 100) / 100 })));
  }
  for (const [k, alts] of Object.entries({ aa: ['aa', 'a'], ih: ['ih', 'i'], ou: ['ou', 'u'], ee: ['ee', 'e'], oh: ['oh', 'o'] })) {
    if (vrmExpr.has(k)) continue;
    for (const a of alts) { const r = ref(a, 1); if (r) { vrmExpr.set(k, [r]); break; } }
  }
  if (['aa', 'ih', 'ou', 'ee', 'oh'].filter((k) => vrmExpr.get(k)?.length).length >= 3) {
    const visemes: Record<string, MorphRef[]> = {};
    for (const v of VISEMES) visemes[v] = Object.entries(VRM_VISEMES[v]).flatMap(([k, w]) => (vrmExpr.get(k) ?? []).map((r) => ({ ...r, weight: r.weight * w })));
    const bl = vrmExpr.get('blink') ?? [];
    return { mode: 'vrm', visemes, blink: bl.length ? bl : blink, note: 'speech shapes from its five VRM vowels; the consonants are made from them (M/B/P is the mouth at rest)' };
  }
  // 4) a jaw bone: speech as jaw rotation only
  if (bones.map.has('Jaw')) {
    return { mode: 'jaw', visemes: {}, jaw: Object.fromEntries(VISEMES.map((v) => [v, +(20 * (VISEME_MIX[v].jaw ?? 0)).toFixed(1)])), blink, note: 'no face shapes: speech is the jaw opening and closing (reads as talking, not as lip sync)' };
  }
  if (blink.length || bones.map.has('LeftEye')) return { mode: 'eyes', visemes: {}, blink, note: 'no mouth shapes or jaw: only the eyes act (blinks, glances)' };
  return { mode: 'none', visemes: {}, blink, note: 'no face shapes, jaw or eyes: the face stays still' };
}

// ── licences ─────────────────────────────────────────────────────────────
export interface Licence { kind: 'vrm1' | 'vrm0'; commercial: boolean; detail: string; url?: string }
export function vrmLicence(json: any): Licence | null {
  const m1 = json.extensions?.VRMC_vrm?.meta;
  if (m1) {
    const cu = m1.commercialUsage ?? 'personalNonProfit';
    return { kind: 'vrm1', commercial: cu !== 'personalNonProfit', url: m1.licenseUrl, detail: `VRM licence: commercial use "${cu}", avatar use "${m1.avatarPermission ?? 'onlyAuthor'}", redistribution ${m1.allowRedistribution ? 'allowed' : 'not allowed'}${m1.name ? ` (“${m1.name}”${m1.authors?.length ? ` by ${m1.authors.join(', ')}` : ''})` : ''}` };
  }
  const m0 = json.extensions?.VRM?.meta;
  if (m0) {
    const allow = (m0.commercialUssageName ?? m0.commercialUsageName ?? 'Disallow') === 'Allow';
    return { kind: 'vrm0', commercial: allow, url: m0.otherLicenseUrl, detail: `VRM 0.x licence: ${m0.licenseName ?? 'unspecified'}, commercial use ${allow ? 'allowed' : 'not allowed'}${m0.title ? ` (“${m0.title}” by ${m0.author ?? 'unknown'})` : ''}` };
  }
  return null;
}

// ── retargeting ──────────────────────────────────────────────────────────
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vlen = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a: V3): V3 => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The direction each humanoid bone points in its own rest pose (to its first humanoid child, or its tail). */
function boneDirs(rig: Rig): Map<string, V3> {
  const out = new Map<string, V3>();
  rig.bones.forEach((b) => out.set(b.name, vnorm(vsub(b.tail, b.head))));
  return out;
}
const CHILD_OF: Record<string, string> = {
  Hips: 'Spine', Spine: 'Chest', Chest: 'UpperChest', UpperChest: 'Neck', Neck: 'Head',
  LeftShoulder: 'LeftUpperArm', LeftUpperArm: 'LeftLowerArm', LeftLowerArm: 'LeftHand', LeftUpperLeg: 'LeftLowerLeg', LeftLowerLeg: 'LeftFoot', LeftFoot: 'LeftToes',
  RightShoulder: 'RightUpperArm', RightUpperArm: 'RightLowerArm', RightLowerArm: 'RightHand', RightUpperLeg: 'RightLowerLeg', RightLowerLeg: 'RightFoot', RightFoot: 'RightToes',
};

export interface RetargetResult { clips: string[]; hipScale: number; restFixes: Array<{ bone: string; degrees: number }> }

/** Retarget studio motion clips onto a glTF skeleton and append them as animations. */
export function retarget(g: Gltf, bones: BoneMap, src: Rig, clips: MotionClip[]): RetargetResult {
  const R = restNodes(g.json);
  const srcIdx = new Map(src.bones.map((b, i) => [b.name, i]));
  const dirs = boneDirs(src);
  // the rest-pose fix: per mapped bone, the rotation that turns the model's rest direction onto the
  // studio's (an A-posed arm gets lifted into the studio's T-pose before any motion is applied)
  const fix = new Map<number, Q>();
  const restFixes: RetargetResult['restFixes'] = [];
  for (const [name, node] of bones.map) {
    const child = CHILD_OF[name] ?? (/(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate)$/.test(name) ? name.replace(/(Metacarpal|Proximal|Intermediate)$/, (s) => ({ Metacarpal: 'Proximal', Proximal: name.includes('Thumb') ? 'Distal' : 'Intermediate', Intermediate: 'Distal' } as any)[s]) : undefined);
    const cn = child ? bones.map.get(child) : undefined;
    const want = dirs.get(name);
    if (cn === undefined || !want || !srcIdx.has(name)) { fix.set(node, [0, 0, 0, 1]); continue; }
    const have = vnorm(vsub(R[cn].worldP, R[node].worldP));
    const q = qArc(have, want);
    fix.set(node, q);
    const deg = (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;
    if (deg > 8) restFixes.push({ bone: name, degrees: +deg.toFixed(0) });
  }
  const hipsNode = bones.map.get('Hips');
  const srcHipY = src.bones[srcIdx.get('Hips')!].head[1];
  const tgtHipY = hipsNode !== undefined ? R[hipsNode].worldP[1] - Math.min(...(['LeftFoot', 'RightFoot'].map((n) => bones.map.get(n)).filter((x) => x !== undefined) as number[]).map((n) => R[n].worldP[1]).concat([R[hipsNode].worldP[1]])) + src.bones[srcIdx.get('LeftFoot')!].head[1] : srcHipY;
  const hipScale = +(tgtHipY / srcHipY).toFixed(3);
  const nodeOf = new Map<number, string>(); for (const [k, v] of bones.map) nodeOf.set(v, k);
  const order = (g.json.nodes as any[]).map((_, i) => i).sort((a, b) => depth(R, a) - depth(R, b));
  const names: string[] = [];
  for (const clip of clips) {
    const n = clip.frames + 1;
    const times = new Float32Array(n).map((_, f) => f / clip.fps);
    const rot = new Map<number, Float32Array>();
    for (const node of bones.map.values()) rot.set(node, new Float32Array(n * 4));
    const hipT = new Float32Array(n * 3);
    for (let f = 0; f < n; f++) {
      const posed = forward(src.bones, src.parents, clip.local[f]);
      const worldPosed = new Map<number, Q>();
      for (const i of order) {
        const r = R[i];
        const pw = r.parent >= 0 ? worldPosed.get(r.parent)! : [0, 0, 0, 1] as Q;
        const name = nodeOf.get(i);
        let w: Q;
        if (name && srcIdx.has(name)) {
          // studio rest frames are the world axes, so its posed world rotation is the change from rest
          const G = posed.worldQ[srcIdx.get(name)!];
          w = qMul(qMul(G, fix.get(i)!), r.worldQ);
        } else w = qMul(pw, r.localQ);
        worldPosed.set(i, w);
        if (name) { const local = qMul(qInv(pw), w); rot.get(i)!.set(local, f * 4); }
      }
      if (hipsNode !== undefined) {
        const off = clip.hips[f];
        const pr = R[hipsNode].parent >= 0 ? R[R[hipsNode].parent] : null;
        const o: V3 = [off[0] * hipScale, off[1] * hipScale, off[2] * hipScale];
        const ol = pr ? qRot(qInv(pr.worldQ), o).map((x) => x / pr.worldS) as V3 : o;
        const t = R[hipsNode].localT;
        hipT.set([t[0] + ol[0], t[1] + ol[1], t[2] + ol[2]], f * 3);
      }
    }
    const input = addAccessor(g, times, 'SCALAR', true);
    const samplers: any[] = [], channels: any[] = [];
    for (const [node, data] of rot) {
      samplers.push({ input, output: addAccessor(g, data, 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });
    }
    if (hipsNode !== undefined) {
      samplers.push({ input, output: addAccessor(g, hipT, 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: hipsNode, path: 'translation' } });
    }
    (g.json.animations ??= []).push({ name: clip.id, samplers, channels, extras: { motion: clip.kind, loop: clip.loop, speed: +(clip.speed * hipScale).toFixed(4), duration: clip.duration, retargeted: true } });
    names.push(clip.id);
  }
  return { clips: names, hipScale, restFixes };
}
function depth(R: RestNode[], i: number) { let d = 0; for (let p = R[i].parent; p >= 0; p = R[p].parent) d++; return d; }

// ── quadrupeds (the side door for animals with their own clips) ──────────
/** Rigify-style animal bone names: spine chain, four leg chains, tail. */
export function quadrupedMap(json: any, joints: number[]): { legs: number; paws: number; spine: number; tail: number; names: string[] } {
  const names = joints.map((j) => String(json.nodes?.[j]?.name ?? '').replace(/^DEF[-_]/, ''));
  const has = (re: RegExp) => names.filter((n) => re.test(n)).length;
  const legs = ['upper_arm.L', 'upper_arm.R', 'thigh.L', 'thigh.R'].filter((n) => names.includes(n)).length;
  // front and hind paws (Rigify's animal metarigs: f_toe, r_toe) or a tail tell an animal from a Rigify human
  return { legs, paws: has(/^[fr]_toe\.[LR]$/), spine: has(/^spine(\.\d+)?$/), tail: has(/^tail(\.\d+)?$/), names };
}

function importQuadruped(g: Gltf, name: string, height: number, quad: ReturnType<typeof quadrupedMap>, licence: Licence | null, warnings: string[]): { glb: Uint8Array; report: ImportReport } {
  const json = g.json;
  const clips: string[] = (json.animations ?? []).map((a: any) => a.name).filter(Boolean);
  const motionChecks = glbMotionChecks(g);
  const failing = Object.entries(motionChecks).flatMap(([c, ks]) => ks.filter((k) => !k.pass).map((k) => `${c}: ${k.name}`));
  let tris = 0;
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
    const idx = p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count;
    tris += Math.floor(idx / 3);
  }
  const carried = [`its own clips: ${clips.join(', ') || 'none'}`, `skeleton: ${quad.names.length} bones (quadruped: spine ×${quad.spine}, 4 legs, tail ×${quad.tail})`, `${tris} triangles`];
  const notCarried = ['studio humanoid motions (it is not a humanoid; it keeps its own clips)', 'lip sync (no speech shapes)'];
  if (failing.length) warnings.push(`motion checks failing: ${failing.join('; ')}`);
  json.extras = { ...(json.extras ?? {}), studioImport: { kind: 'quadruped', clips } };
  const report: ImportReport = {
    rigged: true, kind: 'quadruped', name, height, bones: { source: 'names', matched: quad.names.length, of: quad.names.length, missing: [], unmatched: [] },
    motions: clips, face: { mode: 'eyes', note: 'eyes and lids on bones; no speech shapes', speech: 0 }, licence, carried, notCarried, warnings,
    triangles: tris,
    motionChecks: Object.fromEntries(Object.entries(motionChecks).map(([c, ks]) => [c, ks.map((k) => ({ name: k.name, pass: k.pass, detail: k.detail, frames: k.frames }))])),
  };
  return { glb: writeGlb(g), report };
}

// ── the whole import ─────────────────────────────────────────────────────
export interface ImportReport {
  rigged: boolean; kind?: 'humanoid' | 'quadruped'; name: string; height: number; bones: { source: string; matched: number; of: number; missing: string[]; unmatched: string[] };
  motions: string[]; hipScale?: number; restFixes?: Array<{ bone: string; degrees: number }>; face: { mode: string; note: string; speech: number }; licence: Licence | null;
  carried: string[]; notCarried: string[]; warnings: string[];
  ownClips?: string[]; triangles?: number; motionChecks?: Record<string, Array<{ name: string; pass: boolean; detail: string; frames: Array<[number, number]> }>>;
}
const ESSENTIAL = ['Hips', 'Spine', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
export const IMPORT_MOTIONS: Record<string, MotionSpec> = { idle: { kind: 'idle' }, walk: { kind: 'walk' }, run: { kind: 'run' }, start: { kind: 'start' }, stop: { kind: 'stop' }, 'turn-left': { kind: 'turn', turn: 90 }, wave: { kind: 'action', action: 'wave' } };

/** Import a rigged character: returns the retargeted GLB (motions + face map in extras) and a report. */
export function importCharacter(bytes: Uint8Array, opts: { name?: string; motions?: string[] } = {}): { glb: Uint8Array; report: ImportReport } {
  const g = readGlb(bytes);
  const json = g.json;
  const skins: any[] = json.skins ?? [];
  const name = opts.name ?? json.extensions?.VRMC_vrm?.meta?.name ?? json.extensions?.VRM?.meta?.title ?? json.nodes?.find((n: any) => n.mesh !== undefined)?.name ?? 'Imported character';
  // height from the meshes' position bounds (glTF requires min/max on POSITION)
  let top = 0, bottom = Infinity;
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) { const a = json.accessors?.[p.attributes?.POSITION]; if (a?.max) { top = Math.max(top, a.max[1]); bottom = Math.min(bottom, a.min[1]); } }
  const height = +(top - (Number.isFinite(bottom) ? bottom : 0)).toFixed(3);
  const licence = vrmLicence(json);
  const warnings: string[] = [];
  if (licence && !licence.commercial) warnings.push(`${licence.detail} — fine for personal projects, check before shipping a game that earns money`);
  if (!skins.length) {
    return { glb: bytes, report: { rigged: false, name, height, bones: { source: 'none', matched: 0, of: 0, missing: ESSENTIAL, unmatched: [] }, motions: [], face: { mode: 'none', note: 'no skeleton', speech: 0 }, licence, carried: ['the shape (as a prop)'], notCarried: ['motion', 'face', 'hands'], warnings: [...warnings, 'no skeleton: it comes in as a prop — rig it (Blender Rigify, Mixamo) and import again to make it move'] } };
  }
  const joints: number[] = skins[0].joints ?? [];
  // a quadruped with its own clips (the Blender creature builder, or any Rigify-named animal rig):
  // keep its clips, check them, and mark it to ship with game exports
  const quad = quadrupedMap(json, joints);
  if (quad.legs >= 4 && (quad.paws >= 2 || quad.tail >= 1)) return importQuadruped(g, name, height, quad, licence, warnings);
  const bones = humanoidMap(json, joints);
  const ownClips: string[] = (json.animations ?? []).map((a: any) => a.name).filter(Boolean);
  const missing = ESSENTIAL.filter((b) => !bones.map.has(b));
  const carried: string[] = [], notCarried: string[] = [];
  let motions: string[] = [], hipScale: number | undefined, restFixes: RetargetResult['restFixes'] | undefined;
  if (missing.length > 3 || missing.includes('Hips')) {
    notCarried.push(`motion (only ${bones.map.size} bones matched; missing ${missing.join(', ')})`);
    warnings.push('too few humanoid bones matched to move it — rename its bones (Mixamo or VRM names work) or export it as VRM');
  } else {
    // the studio's human, scaled to the model's height, is the motion source
    const spec = characterSpec(charParams({ height: Math.min(3, Math.max(0.5, height || 1.75)) }));
    const src = buildRig(spec, new Float32Array(0), []);
    const want = opts.motions ?? Object.keys(IMPORT_MOTIONS);
    const clips: MotionClip[] = [];
    for (const id of want) { const ms = IMPORT_MOTIONS[id]; if (ms) clips.push(bakeMotion(id, ms, src, undefined)); }
    const rt = retarget(g, bones, src, clips);
    motions = rt.clips; hipScale = rt.hipScale; restFixes = rt.restFixes;
    carried.push(`motion: ${motions.join(', ')} (retargeted, hips scaled ×${hipScale})`);
    if (rt.restFixes.length) carried.push(`rest pose fixed for ${rt.restFixes.map((r) => `${r.bone} ${r.degrees}°`).join(', ')}`);
    if (missing.length) notCarried.push(`these bones were not found, so they stay at rest: ${missing.join(', ')}`);
  }
  if (ownClips.length) carried.push(`its own clips: ${ownClips.join(', ')}`);
  const fingers = [...bones.map.keys()].filter((k) => /(Thumb|Index|Middle|Ring|Little)/.test(k)).length;
  if (fingers >= 10) carried.push(`hands: ${fingers} finger bones, so hand poses and grips work`); else notCarried.push('hand poses and grips (no finger bones found)');
  const face = faceMap(json, bones);
  const speech = face.mode === 'jaw' ? Object.values(face.jaw ?? {}).filter((x) => x > 0).length : Object.values(face.visemes).filter((r) => r.length).length;
  if (face.mode === 'oculus' || face.mode === 'arkit' || face.mode === 'vrm') carried.push(`face: ${face.note}`); else notCarried.push(`lip sync: ${face.note}`);
  if (face.blink.length) carried.push('blinks'); else if (face.mode !== 'none') notCarried.push('blinks (no blink shapes)');
  json.extras = { ...(json.extras ?? {}), studioImport: { humanoid: Object.fromEntries(bones.map), face, ...(licence ? { licence } : {}) } };
  const report: ImportReport = {
    rigged: true, name, height, bones: { source: bones.source, matched: bones.map.size, of: joints.length, missing, unmatched: bones.unmatched.slice(0, 40) },
    motions, ...(ownClips.length ? { kind: 'humanoid' as const, ownClips } : {}), ...(hipScale !== undefined ? { hipScale } : {}), ...(restFixes ? { restFixes } : {}), face: { mode: face.mode, note: face.note, speech }, licence, carried, notCarried, warnings,
  };
  return { glb: writeGlb(g), report };
}
