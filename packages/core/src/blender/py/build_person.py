"""Blender person builder (bipeds), headless: blender -b --factory-startup --python build_person.py -- spec.json

The same road as the creature builder: shapes from fields meshed into clean all-quad surfaces, then
a sculpted head with a real mouth and 33 face shape keys under the studio's names, separate eyes
that only turn and lid shells, chunky hair, brows, glasses, garments as separate shells with knit,
jersey and twill normal maps, a humanoid deform skeleton with fingers, weights, scripted clips, GLB.
spec: {"plan": "person", "preset": "dad", "name": "dad", "out": "/abs/dir", "renders": true|[...], "faces": 7000, "texture": 1024}
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
import mathutils  # noqa: E402

import plan_person as pp  # noqa: E402
import body  # noqa: E402
import parts  # noqa: E402
import coat  # noqa: E402
import fabric  # noqa: E402
import rig  # noqa: E402
import shapes  # noqa: E402
import anim_person  # noqa: E402
from build_creature import principled, tri_count  # noqa: E402

V = mathutils.Vector
T0 = time.time()
LOG = []
KINDS = ['skin', 'lidU.L', 'lidL.L', 'lidU.R', 'lidL.R', 'teethU', 'teethL', 'tongue', 'brow', 'eye.L', 'eye.R']


def log(msg):
    LOG.append(f'{time.time() - T0:6.1f}s {msg}')
    print('[creature]', LOG[-1], flush=True)


def F(fn):
    return lambda p: fn(pp.from_blender(p))


def box(c, half):
    a = pp.to_blender(np.asarray(c) - half); b = pp.to_blender(np.asarray(c) + half)
    return np.minimum(a, b), np.maximum(a, b)


def tag(ob, kind):
    a = ob.data.attributes.new('kind', 'INT', 'POINT')
    a.data.foreach_set('value', [KINDS.index(kind)] * len(ob.data.vertices))


def eye_texture_person(name, color_hex, res=256, pupil_deg=15.0, iris_deg=46.0):
    c = coat.hex_rgb(color_hex)
    vv, uu = np.mgrid[0:res, 0:res] / (res - 1)
    theta = (1 - vv) * 180.0
    rng = np.random.default_rng(5)
    streak = np.interp(uu[0], np.linspace(0, 1, 121), rng.random(121))
    r = np.clip(theta / iris_deg, 0, 1)
    iris = (c * 1.5)[None, None] * (1 - r[..., None]) + (c * 0.6)[None, None] * r[..., None]
    iris *= (0.8 + 0.4 * streak[None, :, None])
    col = iris * (1 - 0.8 * np.clip((theta - (iris_deg - 5)) / 5, 0, 1)[..., None])
    sclera = np.array([0.82, 0.79, 0.75])
    col = np.where((theta > iris_deg)[..., None], sclera[None, None] * (1 - 0.15 * np.clip((theta - 60) / 40, 0, 1))[..., None], col)
    pup = np.clip((pupil_deg - theta) / 1.0, 0, 1)
    col = col * (1 - pup[..., None]) + 0.005 * pup[..., None]
    return coat.to_image(name, coat.lin_to_srgb(col), res, 'sRGB')


def glasses_field(P):
    hs = P.hs
    rims = None
    def rim(q, centre):
        rel = q - centre
        a, b = 0.0205 * hs, 0.0135 * hs
        dx = np.abs(rel[:, 0]) - (a - 0.006 * hs); dz = np.abs(rel[:, 2]) - (b - 0.006 * hs)
        d2 = np.sqrt(np.maximum(dx, 0) ** 2 + np.maximum(dz, 0) ** 2) + np.minimum(np.maximum(dx, dz), 0) - 0.006 * hs
        return np.sqrt(d2 ** 2 + rel[:, 1] ** 2) - 0.0014 * hs
    def f(q):
        d = None
        for sx in (1, -1):
            c = P.eye_l * np.array([sx, 1, 1]) + np.array([0.0015 * sx, 0.03, -0.008]) * hs
            r = rim(q, c)
            temple = sdfmod.chain(q, [c + np.array([0.02 * sx, 0, 0.004]) * hs, P.H(0.08 * sx, 0.02, 0.0), P.H(0.083 * sx, -0.03, -0.004)], np.array([0.0013, 0.0013, 0.0013]) * hs, 0.0)
            d = np.minimum(r, temple) if d is None else np.minimum(d, np.minimum(r, temple))
        bridge = sdfmod.chain(q, [P.eye_l * np.array([1, 1, 1]) + np.array([-0.0205, 0.03, -0.002]) * hs, P.H(0, 0.1, -0.0), P.eye_l * np.array([-1, 1, 1]) + np.array([0.0205, 0.03, -0.002]) * hs], np.array([0.0013, 0.0013, 0.0013]) * hs, 0.0)
        return np.minimum(d, bridge)
    return f


import sdf as sdfmod  # noqa: E402


def weight_rigid_head(ob, arm, person):
    """Face mesh: Head, grading into Neck and UpperChest down the neck; eyeballs on the eye bones."""
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    names = ['Head', 'Neck', 'UpperChest', 'LeftEye', 'RightEye']
    G = {n: ob.vertex_groups.new(name=n) for n in names}
    kind = np.empty(len(ob.data.vertices), np.int32); ob.data.attributes['kind'].data.foreach_get('value', kind)
    hz = arm.data.bones['Head'].head_local.z; nz = arm.data.bones['Neck'].head_local.z
    for v in ob.data.vertices:
        k = KINDS[kind[v.index]]
        if k == 'eye.L':
            G['LeftEye'].add([v.index], 1.0, 'REPLACE'); continue
        if k == 'eye.R':
            G['RightEye'].add([v.index], 1.0, 'REPLACE'); continue
        z = v.co.z
        wh = float(np.clip((z - (hz - 0.035)) / 0.05, 0, 1))
        wn = float(np.clip((z - (nz - 0.02)) / 0.04, 0, 1)) * (1 - wh)
        wu = max(0.0, 1 - wh - wn)
        for n, w in (('Head', wh), ('Neck', wn), ('UpperChest', wu)):
            if w > 1e-3:
                G[n].add([v.index], w, 'REPLACE')
    ob.parent = arm
    m = ob.modifiers.new('armature', 'ARMATURE'); m.object = arm


def auto_bind(ob, arm, allow, reach=None):
    """Automatic weights limited to the bones in `allow`, then filled, smoothed and cut to four."""
    saved = {}
    for b in arm.data.bones:
        saved[b.name] = b.use_deform
        b.use_deform = b.name in allow
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for n, v in saved.items():
        arm.data.bones[n].use_deform = v
    names = [n for n in allow if n in arm.data.bones]
    W = rig.weight_matrix(ob, names)
    co = np.empty(len(ob.data.vertices) * 3); ob.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    empty = W.sum(1) <= 0
    if empty.any():
        D = np.stack([rig.seg_dist(co[empty], np.array(arm.data.bones[n].head_local), np.array(arm.data.bones[n].tail_local))[0] for n in names], 1)
        W[np.where(empty)[0], np.argmin(D, 1)] = 1
    if reach:
        # a limb bone only holds vertices near its own segment (sleeves don't drag the back along)
        for i, n in enumerate(names):
            if n in reach:
                dd, _ = rig.seg_dist(co, np.array(arm.data.bones[n].head_local), np.array(arm.data.bones[n].tail_local))
                W[:, i] *= np.clip(1 - (dd - reach[n]) / 0.03, 0, 1)
        e2 = W.sum(1) <= 1e-6
        if e2.any():
            tor = [k for k, n in enumerate(names) if n in ('Spine', 'Chest', 'UpperChest', 'Hips')]
            D = np.stack([rig.seg_dist(co[e2], np.array(arm.data.bones[names[k]].head_local), np.array(arm.data.bones[names[k]].tail_local))[0] for k in tor], 1)
            W[np.where(e2)[0], np.array(tor)[np.argmin(D, 1)]] = 1
    W = rig.smooth_weights(ob, W, passes=3, factor=0.4)
    rig.write_weights(ob, names, W, 4)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    spec = json.load(open(argv[0]))
    out = spec['out']; name = spec.get('name', 'person')
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = anim_person.FPS; sc.frame_start = 0
    coat.TEXDIR = os.path.join(out, 'textures'); os.makedirs(coat.TEXDIR, exist_ok=True)
    P = pp.Person({'preset': spec.get('preset', 'dad'), **{k: spec[k] for k in ('height', 'belly') if k in spec}})
    pr = P.pr
    res = int(spec.get('texture', 1024))
    hs = P.hs
    tb = pp.to_blender

    # ── the head, with its mouth ──────────────────────────────────────────────
    lo, hi = box(P.c + np.array([0, 0, -0.06]) * hs, np.array([0.12, 0.15, 0.2]) * hs)
    head, qf = body.build_surface('face', F(P.head), lo, hi, 0.0016, int(spec.get('faces', 7500)))
    tag(head, 'skin')
    bpy.context.view_layer.objects.active = head
    log(f'head: {len(head.data.polygons)} quads (quadriflow {"ok" if qf else "fallback"})')
    parts_ = []
    for sx, side in ((1, 'L'), (-1, 'R')):
        e = parts.eye(f'eye.{side}', tb(P.eye_l * np.array([sx, 1, 1])), tb(P.eye_dir[sx]), P.eye_r)
        tag(e, f'eye.{side}'); parts_.append(e)
        up, lw = parts.lids(f'lid.{side}', tb(P.eye_l * np.array([sx, 1, 1])), tb(P.eye_dir[sx]), P.eye_r, opening_deg=50, thickness=0.0011, rf=1.12)
        tag(up, f'lidU.{side}'); tag(lw, f'lidL.{side}'); parts_ += [up, lw]
    mlo, mhi = box(P.mouth_line + np.array([0, -0.03, 0]) * hs, np.array([0.045, 0.05, 0.03]) * hs)
    tu, _ = body.build_surface('teethU', F(lambda q: P.teeth(q, True)), mlo, mhi, 0.0008, 500, relax_iters=2, quads=False)
    tl, _ = body.build_surface('teethL', F(lambda q: P.teeth(q, False)), mlo, mhi, 0.0008, 500, relax_iters=2, quads=False)
    tg, _ = body.build_surface('tongue', F(P.tongue), mlo, mhi, 0.0012, 300, relax_iters=2, quads=False)
    tag(tu, 'teethU'); tag(tl, 'teethL'); tag(tg, 'tongue'); parts_ += [tu, tl, tg]
    blo, bhi = box(P.c + np.array([0, 0.09, 0.04]) * hs, np.array([0.08, 0.04, 0.03]) * hs)
    br, _ = body.build_surface('brows', F(P.brows), blo, bhi, 0.001, 500, relax_iters=2, quads=False)
    tag(br, 'brow'); parts_.append(br)
    # materials
    skin_m = principled('skin', color=tuple(coat.hex_rgb(pr['skin'])), rough=0.55, sheen=0.25, sheen_tint=(1.0, 0.8, 0.75), spec=0.35)
    eye_m = principled('eye', image=eye_texture_person('iris', pr['eye_color']), rough=0.08, spec=0.7, coat=1.0)
    lid_m = principled('lid', color=tuple(coat.hex_rgb(pr['skin']) * 0.92), rough=0.6, spec=0.3)
    teeth_m = principled('teeth', color=(0.82, 0.78, 0.68), rough=0.3, spec=0.5)
    tongue_m = principled('tongue', color=(0.55, 0.22, 0.22), rough=0.45, spec=0.4)
    brow_m = principled('brow', color=tuple(coat.hex_rgb(pr['brows'])), rough=0.85, spec=0.2)
    for o, m in ((head, skin_m),):
        o.data.materials.append(m)
    for o in parts_:
        k = o.name.split('.')[0]
        o.data.materials.append({'eye': eye_m, 'lid': lid_m, 'teethU': teeth_m, 'teethL': teeth_m, 'tongue': tongue_m, 'brows': brow_m}[k])
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts_:
        o.select_set(True)
    head.select_set(True); bpy.context.view_layer.objects.active = head
    bpy.ops.object.join()
    head.name = f'{name}-face'
    # UVs and the skin texture
    unwrap(head)
    # keep the eye's own sphere UVs: re-unwrap would break the iris, so restore them from a fresh sphere map
    kind = np.empty(len(head.data.vertices), np.int32); head.data.attributes['kind'].data.foreach_get('value', kind)
    _restore_eye_uvs(head, kind, P)
    # the inside of the mouth gets its own dark material (faces behind the lips, in the cavity)
    mouth_m = principled('mouth', color=(0.16, 0.05, 0.05), rough=0.6, spec=0.3)
    head.data.materials.append(mouth_m)
    mi = len(head.data.materials) - 1
    cav_c, cav_r = P.cavity
    for poly in head.data.polygons:
        if poly.material_index != 0:
            continue
        q = pp.from_blender(np.array(poly.center))
        d = (q - cav_c) / (cav_r * 1.35)
        if d @ d < 1.0 and q[1] < P.mouth_line[1] - 0.007 * hs:
            poly.material_index = mi
    cimg, nimg = fabric.skin_maps(head, P, res)
    _set_image(skin_m, cimg, nimg)
    log('face: eyes, lids, teeth, tongue, brows joined; skin texture')

    # ── shape keys under the studio's names ────────────────────────────────────
    co = np.empty(len(head.data.vertices) * 3); head.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    Pq = pp.from_blender(co)
    fs = shapes.FaceShapes(P, Pq, [KINDS[k] for k in kind])
    head.shape_key_add(name='Basis', from_mix=False)
    for kname, disp in fs.all().items():
        key = head.shape_key_add(name=kname, from_mix=False)
        key.data.foreach_set('co', (co + pp.to_blender(disp)).reshape(-1))
    log(f'face shapes: {len(head.data.shape_keys.key_blocks) - 1}')

    # ── hair, glasses, hands ─────────────────────────────────────────────────────
    hlo, hhi = box(P.c + np.array([0, -0.01, 0.03]) * hs, np.array([0.12, 0.14, 0.11]) * hs)
    hair, _ = body.build_surface('hair', F(P.hair), hlo, hhi, 0.0018, 1900)
    unwrap(hair)
    hm = principled('hair', rough=0.55, sheen=0.4, sheen_tint=(0.8, 0.78, 0.75), spec=0.35)
    _set_image(hm, *fabric.hair_maps(hair, P, 512))
    hair.data.materials.append(hm)
    glo, ghi = box(P.c + np.array([0, 0.05, 0.0]) * hs, np.array([0.1, 0.1, 0.05]) * hs)
    gl, _ = body.build_surface('glasses', F(glasses_field(P)), glo, ghi, 0.0007, 600, relax_iters=1, quads=False)
    gl.data.materials.append(principled('frames', color=tuple(coat.hex_rgb(pr['glasses'])), rough=0.3, spec=0.5))
    hands = []
    for sx, side in ((1, 'Left'), (-1, 'Right')):
        w = P.j[f'{side}Hand']
        lo, hi = np.minimum(tb(w - 0.15 * P.s), tb(w + 0.15 * P.s)), np.maximum(tb(w - 0.15 * P.s), tb(w + 0.15 * P.s))
        hd, _ = body.build_surface(f'hand.{side}', F(lambda q, sx=sx: P.hand(q, sx)), lo, hi, 0.0019, 1000)
        hd.data.materials.append(principled('hands', color=tuple(coat.hex_rgb(pr['skin']) * 0.97), rough=0.55, sheen=0.25, sheen_tint=(1.0, 0.8, 0.75), spec=0.35))
        hands.append(hd)
    log('hair, glasses, hands')

    # ── garments ─────────────────────────────────────────────────────────────────
    G = P.garment_fields()
    garments = {}
    gspec = {'tee': ('jersey', pr['tee'], 900, 0.006), 'cardigan': ('knit', pr['cardigan'], 3600, 0.005), 'trousers': ('twill', pr['trousers'], 2400, 0.006), 'slippers': ('felt', pr['slippers'], 900, 0.004)}
    s = P.s
    def hem_band(p):
        q = pp.from_blender(p)
        band = np.clip((0.89 * s - q[:, 2]) / 0.004, 0, 1)
        cuff = 0.0
        for side in ('Left', 'Right'):
            h = P.j[f'{side}Hand']; la = P.j[f'{side}LowerArm']
            t = ((q - la) @ (h - la)) / ((h - la) @ (h - la))
            cuff = np.maximum(cuff, np.clip((t - 0.8) / 0.02, 0, 1) * (np.linalg.norm(q - h, axis=1) < 0.12 * s))
        placket = np.clip((0.012 * s - np.abs(np.abs(q[:, 0]) - 0.02 * s)) / 0.004, 0, 1) * (q[:, 1] > 0.05 * s) * (q[:, 2] < 1.2 * s)
        return np.maximum(np.maximum(band, cuff), placket)
    for g, (kind_, col, faces, vox) in gspec.items():
        gob, ok = body.build_surface(g, F(G[g]), np.array([-0.8, -0.35, -0.01]) * max(1, s), np.array([0.8, 0.35, 1.56]) * s, vox, faces)
        unwrap(gob)
        m = principled(g, rough=0.9, sheen=0.6 if kind_ in ('knit', 'felt') else 0.2, sheen_tint=tuple(np.clip(coat.hex_rgb(col) * 1.6 + 0.1, 0, 1)), spec=0.15)
        _set_image(m, *fabric.fabric_maps(gob, kind_, col, res if g == 'cardigan' else res // 2, hem=hem_band if g == 'cardigan' else None))
        gob.data.materials.append(m)
        garments[g] = gob
    log('garments: ' + ', '.join(f'{k} {len(v.data.polygons)}' for k, v in garments.items()))

    # ── skeleton, weights ─────────────────────────────────────────────────────────
    table = P.finger_bones(P.bone_table())
    arm = rig.make_armature(f'{name}-rig', table)
    weight_rigid_head(head, arm, P)
    for o in (hair, gl):
        rig.rigid_bind(o, arm, 'Head')
    body_bones = [n for n in table if not any(k in n for k in ('Eye', 'Jaw', 'Root', 'Thumb', 'Index', 'Middle', 'Ring', 'Little'))]
    for g, gob in garments.items():
        allow = [n for n in body_bones if not (g == 'slippers' and not ('Foot' in n or 'Toes' in n or 'LowerLeg' in n))]
        reach = {f'{sd}{b}': r for sd in ('Left', 'Right') for b, r in (('UpperArm', 0.085), ('Shoulder', 0.07), ('UpperLeg', 0.11))} if g in ('tee', 'cardigan', 'trousers') else None
        auto_bind(gob, arm, allow, reach)
    for hd, side in zip(hands, ('Left', 'Right')):
        allow = [n for n in table if n.startswith(side) and any(k in n for k in ('Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little', 'LowerArm'))]
        auto_bind(hd, arm, allow)
    log(f'skeleton: {len(table)} bones; weights')

    # ── clips ─────────────────────────────────────────────────────────────────────
    acts, poser, pm = anim_person.make_clips(arm, P, spec.get('clips'))
    for a in acts.values():
        tr = arm.animation_data.nla_tracks.new(); tr.name = a.name
        tr.strips.new(a.name, int(a.frame_range[0]), a); tr.mute = True
    arm.animation_data.action = None
    log('clips: ' + ', '.join(acts))

    meshes = [head, hair, gl, *hands, *garments.values()]
    tris = tri_count(meshes)
    glb = os.path.join(out, f'{name}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_skins=True, export_morph=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_yup=True, export_force_sampling=True,
                              export_def_bones=False, export_extras=True, export_image_format='AUTO', export_apply=False)
    log(f'exported {glb} ({os.path.getsize(glb) // 1024} KB, {tris} triangles)')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, f'{name}.blend'), compress=True)
    report = {'ok': True, 'glb': glb, 'blend': os.path.join(out, f'{name}.blend'), 'name': name, 'plan': 'person', 'preset': spec.get('preset', 'dad'),
              'triangles': tris, 'bones': [b.name for b in arm.data.bones], 'deformBones': [b.name for b in arm.data.bones if b.use_deform],
              'shapes': [k.name for k in head.data.shape_keys.key_blocks[1:]],
              'clips': {k: {kk: (vv if isinstance(vv, (int, float, str, bool)) else list(vv) if hasattr(vv, '__len__') else str(vv)) for kk, vv in a.items()} for k, a in acts.items()},
              'rigify': False, 'quadriflow': qf, 'blender': bpy.app.version_string, 'units': 'metres, Y up (glTF)'}
    if spec.get('renders'):
        import render_person
        report['renders'] = render_person.shoot(spec, P, arm, head, acts, out)
        log(f"renders: {len(report['renders'])}")
    report['log'] = LOG
    json.dump(report, open(os.path.join(out, 'report.json'), 'w'), indent=2)
    print('[creature] REPORT ' + json.dumps({'ok': True, 'glb': glb, 'triangles': tris}), flush=True)


def unwrap(ob):
    """Smart UV project of this object alone (other selected objects would share its UV square)."""
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def _set_image(m, cimg, nimg):
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = cimg
    nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = nimg
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])


def _restore_eye_uvs(ob, kind, P):
    """Eyeballs get spherical UVs about their gaze (v = 1 at the pupil), so the iris map lands right."""
    me = ob.data
    uv = me.uv_layers.active.data
    lv = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', lv)
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    luv = np.empty(len(me.loops) * 2); uv.foreach_get('uv', luv); luv = luv.reshape(-1, 2)
    for side, sx in (('L', 1), ('R', -1)):
        k = KINDS.index(f'eye.{side}')
        m = kind[lv] == k
        if not m.any():
            continue
        c = pp.to_blender(P.eye_l * np.array([sx, 1, 1])); d = pp.to_blender(P.eye_dir[sx])
        rel = co[lv[m]] - c
        rel /= np.linalg.norm(rel, axis=1, keepdims=True)
        cosang = np.clip(rel @ d, -1, 1)
        theta = np.degrees(np.arccos(cosang))
        luv[m, 1] = 1 - theta / 180.0
        luv[m, 0] = 0.5
    uv.foreach_set('uv', luv.reshape(-1))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print('[creature] ERROR ' + repr(e), flush=True)
        sys.exit(1)
