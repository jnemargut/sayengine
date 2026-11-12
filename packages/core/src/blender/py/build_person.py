"""Blender person builder (bipeds), headless: blender -b --factory-startup --python build_person.py -- spec.json

The same road as the creature builder: a body, hands and garments from fields meshed into clean
all-quad surfaces, with knit, jersey, twill and felt maps; the head is the studio's kit face (kitface.ts
cuts it from a kit character: eyes that only turn, lid shells, teeth rows, gums, tongue, lips joined to
the skin, a lock haircut, the 33 face shapes under the studio's names and the face paint), joined at
the neck under the collar; glasses fitted to its nose and ears; a humanoid deform skeleton with
fingers, weights, scripted clips, GLB.
spec: {"plan": "person", "preset": "dad", "name": "dad", "out": "/abs/dir", "kitFace": "kitface.json",
"kitFacePng": "kitface.png", "renders": true|[...], "texture": 1024}
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
import coat  # noqa: E402
import fabric  # noqa: E402
import rig  # noqa: E402
import kithead  # noqa: E402
import glasses  # noqa: E402
import anim_person  # noqa: E402
from build_creature import principled, tri_count  # noqa: E402

V = mathutils.Vector
T0 = time.time()
LOG = []


def log(msg):
    LOG.append(f'{time.time() - T0:6.1f}s {msg}')
    print('[creature]', LOG[-1], flush=True)


def F(fn):
    return lambda p: fn(pp.from_blender(p))




def weight_rigid_head(ob, arm, person, fparts, pidx):
    """Face mesh: Head, grading into Neck and UpperChest down the neck; eyeballs on the eye bones."""
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    names = ['Head', 'Neck', 'UpperChest', 'LeftEye', 'RightEye']
    G = {n: ob.vertex_groups.new(name=n) for n in names}
    hz = arm.data.bones['Head'].head_local.z; nz = arm.data.bones['Neck'].head_local.z
    for v in ob.data.vertices:
        part = fparts[pidx[v.index]]
        if part.startswith('LeftEye'):
            G['LeftEye'].add([v.index], 1.0, 'REPLACE'); continue
        if part.startswith('RightEye'):
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
    toy = float(spec.get('toy', 0.0))
    P = pp.Person({'preset': spec.get('preset', 'dad'), 'toy': toy, **{k: spec[k] for k in ('height', 'belly', 'cardigan', 'tee', 'trousers', 'slippers', 'glasses') if k in spec}})
    pr = P.pr
    res = int(spec.get('texture', 1024))
    tb = pp.to_blender

    if toy:
        # ── the head: a cartoon head whose features are simple shapes that act (toyhead.py) ─────────
        import toyhead
        hexc = coat.hex_rgb
        skin_m = principled('skin', color=tuple(hexc(spec.get('skin', '#eebd98'))), rough=0.75, spec=0.2)
        mats = dict(skin=skin_m, nose=principled('skin_warm', color=tuple(hexc(spec.get('noseColor', '#e59f84'))), rough=0.75, spec=0.2),
                    hair=principled('hair', color=tuple(hexc(spec.get('hairColor', '#6a4b36'))), rough=0.85, spec=0.15),
                    ink=principled('eye_ink', color=(0.012, 0.01, 0.014), rough=0.9, spec=0.0, double=True),
                    white=principled('eye_white', color=(1, 1, 1), rough=0.8, spec=0.0, double=True),
                    mouth=principled('mouth', color=(0.16, 0.035, 0.04), rough=0.7, spec=0.1, double=True),
                    line=principled('mouth_line', color=tuple(hexc('#5a2c26')), rough=0.8, spec=0.1, double=True),
                    frames=principled('frames', color=tuple(hexc(pr['glasses'])), rough=0.4, spec=0.4))
        head, gl, L, shape_names = toyhead.build(P, f'{name}-face', mats, height=float(spec.get('headHeight', 0.42)))
        P.use_kit_face(L)
        parts = pidx = None
        face_checks = []
        log(f'face: the toy head ({len(head.data.polygons)} faces, {len(shape_names)} face shapes)')
    else:
        # ── the head: the studio's kit face (kitface.ts), placed on this person's neck ─────────
        face = kithead.load(spec['kitFace'])
        fit = kithead.Fit(face, P.j['Neck'])
        L = kithead.landmarks(face, fit)
        P.use_kit_face(L)
        skin_props = {'Roughness': 0.55, 'Sheen Weight': 0.25, 'Sheen Tint': (1.0, 0.8, 0.75, 1.0), 'Specular IOR Level': 0.35}
        head, parts, pidx = kithead.build(face, fit, spec['kitFacePng'], f'{name}-face', skin_props)
        neck_down = max(0.03, float(L['bones']['Neck'][0][2] - (P.j['UpperChest'][2] + 0.035)) + 0.03)
        kithead.thicken_neck(head, parts, L)
        n0 = len(head.data.vertices)
        kithead.extend_neck(head, neck_down)
        pa = head.data.attributes['part'].data
        for i in range(n0, len(head.data.vertices)):
            pa[i].value = parts.index('Neck')
        skin_m = next(m for m in head.data.materials if m.name.startswith('kit-skin-head'))
        kithead.sculpt_ears(head, parts, L, skin_m)
        shape_names = kithead.add_shapes(head, face, fit)
        pidx, split = kithead.soften(head, parts, L, fit)
        face_checks = kithead.face_checks(head, parts, L)
        log('face checks: ' + ', '.join(f"{c['name']}: {'pass' if c['pass'] else 'FAIL ' + c['detail']}" for c in face_checks))
        log(f'face: the kit head ({face["triangleCount"]} triangles, {split} long edges split, {len(shape_names)} face shapes)')

    # ── glasses, hands ─────────────────────────────────────────────────────────────
    if not toy:
        gl, _ = glasses.build(head, L, tuple(coat.hex_rgb(pr['glasses'])))
    hands = []
    for sx, side in ((1, 'Left'), (-1, 'Right')):
        w = P.j[f'{side}Hand']
        lo, hi = np.minimum(tb(w - 0.15 * P.s), tb(w + 0.15 * P.s)), np.maximum(tb(w - 0.15 * P.s), tb(w + 0.15 * P.s))
        hd, _ = body.build_surface(f'hand.{side}', F(lambda q, sx=sx: P.hand(q, sx)), lo, hi, 0.0019, 1000)
        hd.data.materials.append(skin_m)
        if not toy:
            uvl = hd.data.uv_layers.new(name='UVMap')
            uvl.data.foreach_set('uv', np.tile(np.array(kithead.PLAIN_SKIN_UV), len(hd.data.loops)))
        for poly in hd.data.polygons:
            poly.use_smooth = True
        hands.append(hd)
    log('glasses, hands')

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
    if toy:
        # the toy head is rigid on the Head bone; its neck stub grades into the Neck and the chest
        for g in list(head.vertex_groups):
            head.vertex_groups.remove(g)
        G = {n: head.vertex_groups.new(name=n) for n in ('Head', 'Neck', 'UpperChest')}
        hz = arm.data.bones['Head'].head_local.z; nz = arm.data.bones['Neck'].head_local.z
        for v in head.data.vertices:
            wh = float(np.clip((v.co.z - (hz - 0.03)) / 0.04, 0, 1))
            wn = float(np.clip((v.co.z - (nz - 0.02)) / 0.04, 0, 1)) * (1 - wh)
            for n, w in (('Head', wh), ('Neck', wn), ('UpperChest', max(0.0, 1 - wh - wn))):
                if w > 1e-3:
                    G[n].add([v.index], w, 'REPLACE')
        head.parent = arm
        m = head.modifiers.new('armature', 'ARMATURE'); m.object = arm
    else:
        weight_rigid_head(head, arm, P, parts, pidx)
    rig.rigid_bind(gl, arm, 'Head')
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

    meshes = [head, gl, *hands, *garments.values()]
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
              'shapes': [k.name for k in head.data.shape_keys.key_blocks[1:]], 'face': 'toy' if toy else 'kit', 'faceChecks': face_checks,
              'clips': {k: {kk: (vv if isinstance(vv, (int, float, str, bool)) else list(vv) if hasattr(vv, '__len__') else str(vv)) for kk, vv in a.items()} for k, a in acts.items()},
              'rigify': False, 'blender': bpy.app.version_string, 'units': 'metres, Y up (glTF)'}
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


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print('[creature] ERROR ' + repr(e), flush=True)
        sys.exit(1)
