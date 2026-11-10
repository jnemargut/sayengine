"""Blender creature builder (run headless): blender -b --factory-startup --python build_creature.py -- spec.json

spec.json: {"plan": "cat", "preset": "british-shorthair", "build": 0.9, "legLength": 1, "bodyLength": 1,
            "headSize": 1, "coat": {"color": "#7d8593", "pattern": "solid"}, "eyeColor": "#c9771f",
            "furLength": 0.006, "faces": 9000, "texture": 1024, "shells": 0, "rigify": true,
            "out": "/abs/dir", "name": "bsh-chonk", "renders": ["side", ...] | true | false}
Writes <out>/<name>.glb, <name>.blend and report.json (bones, clips, triangle count, timings).
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

import plan_cat  # noqa: E402
import body  # noqa: E402
import parts  # noqa: E402
import coat as coatlib  # noqa: E402
import rig  # noqa: E402
import anim  # noqa: E402

V = mathutils.Vector
T0 = time.time()
LOG = []


def log(msg):
    LOG.append(f'{time.time() - T0:6.1f}s {msg}')
    print('[creature]', LOG[-1], flush=True)


def load_spec():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        raise SystemExit('usage: blender -b --python build_creature.py -- spec.json')
    with open(argv[0]) as f:
        return json.load(f)


def principled(name, color=None, image=None, normal=None, rough=0.7, sheen=0.0, sheen_tint=None, sheen_rough=0.4,
               spec=0.4, coat=0.0, double=False, alpha=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    if color is not None:
        bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Specular IOR Level'].default_value = spec
    if sheen:
        bsdf.inputs['Sheen Weight'].default_value = sheen
        bsdf.inputs['Sheen Roughness'].default_value = sheen_rough
        if sheen_tint is not None:
            bsdf.inputs['Sheen Tint'].default_value = (*sheen_tint, 1)
    if coat:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.03
    if image is not None:
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = image
        nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha:
            nt.links.new(tx.outputs['Alpha'], bsdf.inputs['Alpha'])
            m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 1.0
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    m.use_backface_culling = not double
    return m


def eye_texture(name, color_hex, res=256, pupil_deg=19.0, iris_deg=56.0):
    """Iris on a UV sphere whose +Z pole is the gaze: v = 1 at the pupil."""
    c = coatlib.hex_rgb(color_hex)
    vv, uu = np.mgrid[0:res, 0:res] / (res - 1)
    theta = (1 - vv) * 180.0                       # degrees from the gaze axis
    rng = np.random.default_rng(2)
    streak = np.interp(uu[0], np.linspace(0, 1, 97), rng.random(97))
    fib = (0.75 + 0.5 * streak[None, :])
    r = np.clip(theta / iris_deg, 0, 1)
    gold = c * 1.35 + np.array([0.08, 0.05, 0.0])
    deep = c * 0.55
    iris = gold[None, None] * (1 - r[..., None]) + deep[None, None] * r[..., None]
    iris = iris * (0.85 + 0.25 * fib[..., None] * (0.6 + 0.4 * r[..., None]))
    col = iris
    limb = np.clip((theta - (iris_deg - 7)) / 7, 0, 1)
    col = col * (1 - 0.75 * limb[..., None])
    sclera = np.array([0.55, 0.5, 0.42])
    col = np.where((theta > iris_deg)[..., None], sclera[None, None] * 0.6, col)
    pup = np.clip((pupil_deg - theta) / 1.2, 0, 1)
    col = col * (1 - pup[..., None]) + np.array([0.004, 0.004, 0.006])[None, None] * pup[..., None]
    return coatlib.to_image(name, coatlib.lin_to_srgb(col), res, 'sRGB')


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = anim.FPS
    sc.frame_start = 0
    sc.unit_settings.system = 'METRIC'
    return sc


def tri_count(obs):
    n = 0
    for ob in obs:
        me = ob.data
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
    return n


def main():
    spec = load_spec()
    out = spec['out']
    name = spec.get('name', 'creature')
    os.makedirs(out, exist_ok=True)
    if spec.get('plan', 'cat') != 'cat':
        raise SystemExit(f"plan {spec.get('plan')!r} is not built yet (only 'cat')")
    sc = setup_scene()
    coatlib.TEXDIR = os.path.join(out, 'textures')
    os.makedirs(coatlib.TEXDIR, exist_ok=True)
    coat = dict(spec.get('coat') or {})
    preset = spec.get('preset', 'british-shorthair')
    pr = plan_cat.PRESETS.get(preset)
    if pr is None:
        raise SystemExit(f'unknown preset {preset!r}; known: {", ".join(plan_cat.PRESETS)}')
    coat.setdefault('color', pr['coat']); coat.setdefault('pattern', pr['pattern'])
    fur_len = float(spec.get('furLength', 0.006))
    coat.setdefault('pile', 0.12 + 15 * fur_len)
    eye_col = spec.get('eyeColor', pr['eye_color'])
    plan = plan_cat.Cat({'preset': preset, 'build': spec.get('build', 0.85), 'leg_length': spec.get('legLength', 1.0),
                         'body_length': spec.get('bodyLength', 1.0), 'head_size': spec.get('headSize', 1.0)})
    to_b = plan_cat.to_blender

    # ── body ──────────────────────────────────────────────────────────────────
    ob, qf = body.build_body(plan, int(spec.get('faces', 9000)), name='body')
    log(f'body: {len(ob.data.polygons)} quads (quadriflow {"ok" if qf else "fallback"})')
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    res = int(spec.get('texture', 1024))
    cimg, nimg, _ = coatlib.bake_coat(ob, plan, coat, res)
    log('coat textures')
    base_lin = coatlib.hex_rgb(coat['color'])
    sheen_tint = tuple(np.clip(base_lin * 1.35 + 0.05, 0, 1))
    fur = principled('fur', image=cimg, normal=nimg, rough=0.85, sheen=0.6, sheen_tint=sheen_tint, sheen_rough=0.35, spec=0.2)
    ob.data.materials.append(fur)

    # ── parts ─────────────────────────────────────────────────────────────────
    partobs = {}
    el = parts.eye('eye.L', to_b(plan.eyes), to_b(plan.eye_dir), plan.eye_r)
    er = parts.eye('eye.R', to_b(plan.eyes * np.array([-1, 1, 1])), to_b(plan.eye_dir * np.array([-1, 1, 1])), plan.eye_r)
    eimg = eye_texture('iris', eye_col)
    eyem = principled('eye', image=eimg, rough=0.12, spec=0.7, coat=1.0)
    for e in (el, er):
        e.data.materials.append(eyem)
    partobs['eye.L'] = [el]; partobs['eye.R'] = [er]
    lid_col = tuple(base_lin * 0.35)          # the dark lid margin round the eye
    lidm = principled('lid', color=lid_col, rough=0.85, sheen=0.3, sheen_tint=sheen_tint, sheen_rough=0.32, spec=0.2)
    for s, sx in (('L', 1), ('R', -1)):
        up, lo = parts.lids(f'lid.{s}', to_b(plan.eyes * np.array([sx, 1, 1])), to_b(plan.eye_dir * np.array([sx, 1, 1])), plan.eye_r)
        up.data.materials.append(lidm); lo.data.materials.append(lidm)
        partobs[f'lid.T.{s}'] = [up]; partobs[f'lid.B.{s}'] = [lo]
    earm = principled('ear', color=tuple(base_lin * 0.95), rough=0.85, sheen=0.6, sheen_tint=sheen_tint, sheen_rough=0.32, spec=0.2)
    innerm = principled('inner_ear', color=tuple(coatlib.hex_rgb(pr['inner_ear']) * 0.75), rough=0.7, sheen=0.5, sheen_tint=(0.6, 0.55, 0.58), spec=0.2)
    for s, sx in (('L', 1), ('R', -1)):
        o, i = parts.ear(f'ear.{s}', to_b(plan.ear_base * np.array([sx, 1, 1])), plan.ear_size, plan.ear_tilt, sx, plan.ear_round)
        o.data.materials.append(earm); i.data.materials.append(innerm)
        partobs[f'ear.{s}'] = [o, i]
    no = parts.nose('nose', to_b(plan.nose), 0.0135 * plan.hs, 0.0095 * plan.hs, 0.0032 * plan.hs)
    no.data.materials.append(principled('nose', color=tuple(coatlib.hex_rgb(pr['nose'])), rough=0.45, spec=0.5))
    wh = parts.whiskers('whiskers', to_b(plan.head_parts['pad'][0] + np.array([0.004, 0.009, 0.0])), n=8, length=0.056 * plan.hs, width=0.00045)
    wh.data.materials.append(principled('whisker', color=(0.86, 0.85, 0.82), rough=0.5, spec=0.3, double=True))
    partobs['spine.006'] = [no, wh]
    log('parts: eyes, lids, ears, nose, whiskers')

    # ── rig ───────────────────────────────────────────────────────────────────
    table = rig.bone_table(plan, to_b)
    arm = rig.make_armature(name, table)
    metarig = ctrl = None
    if spec.get('rigify', True):
        metarig, ctrl = rig.build_rigify(table)
        linked = rig.link_to_rigify(arm, ctrl)
        log(f'rigify: {"generated" if ctrl else "unavailable"}{f", {linked} game bones linked (muted)" if ctrl else ""}')
    rig.auto_weights(ob, arm, exclude=[n for n in table if n.startswith(('eye.', 'lid.', 'ear.'))])
    names = rig.fix_weights(ob, arm, table, plan)
    log(f'weights: {len(names)} deform bones, smoothed, belly kept off the legs')
    for bone, obs in partobs.items():
        for o in obs:
            rig.rigid_bind(o, arm, bone)
    # one skinned mesh: join the parts into the body (one primitive per material)
    bpy.ops.object.select_all(action='DESELECT')
    for obs in partobs.values():
        for o in obs:
            o.select_set(True)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    ob.name = name
    ob.data.name = name

    # ── clips ─────────────────────────────────────────────────────────────────
    acts, poser, cm = anim.make_clips(arm, plan, spec.get('clips'), mesh=ob)
    log(f'clips: {", ".join(acts)}')
    for a in acts.values():
        tr = arm.animation_data.nla_tracks.new()
        tr.name = a.name
        st = tr.strips.new(a.name, int(a.frame_range[0]), a)
        tr.mute = True
    arm.animation_data.action = None

    # ── export ────────────────────────────────────────────────────────────────
    tris = tri_count([ob])
    glb = os.path.join(out, f'{name}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True); ob.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_yup=True,
                              export_force_sampling=True, export_def_bones=False, export_extras=True,
                              export_image_format='AUTO', export_apply=False, export_all_influences=False)
    log(f'exported {glb} ({os.path.getsize(glb) // 1024} KB, {tris} triangles)')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, f'{name}.blend'), compress=True)
    report = {
        'ok': True, 'glb': glb, 'blend': os.path.join(out, f'{name}.blend'), 'name': name, 'plan': 'cat', 'preset': preset,
        'triangles': tris, 'bones': [b.name for b in arm.data.bones], 'deformBones': names,
        'clips': {k: dict(a.items()) for k, a in acts.items()}, 'rigify': bool(ctrl), 'quadriflow': qf,
        'blender': bpy.app.version_string, 'units': 'metres, Y up (glTF)', 'log': LOG,
    }
    for k in report['clips']:
        report['clips'][k] = {kk: (vv if isinstance(vv, (int, float, str, bool)) else str(vv)) for kk, vv in report['clips'][k].items()}
    if spec.get('renders'):
        import render
        shots = render.shoot(spec, plan, arm, ob, acts, out, name)
        report['renders'] = shots
        log(f'renders: {len(shots)}')
    report['log'] = LOG
    with open(os.path.join(out, 'report.json'), 'w') as f:
        json.dump(report, f, indent=2)
    print('[creature] REPORT ' + json.dumps({'ok': True, 'glb': glb, 'triangles': tris}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print('[creature] ERROR ' + str(e.code), flush=True)
            sys.exit(2)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print('[creature] ERROR ' + repr(e), flush=True)
        sys.exit(1)
