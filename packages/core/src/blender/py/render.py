"""Eevee look renders of a built creature: a soft studio (key, fill, rim, a warm floor), fixed shots."""
import math
import os
import bpy
import mathutils

V = mathutils.Vector

# name: (clip or None, time s, camera offset from the target (Blender: +X = the cat's left, -Y = ahead), target, lens)
CAT_SHOTS = {
    'side': (None, 0, (1.25, -0.05, 0.16), (0, 0.0, 0.17), 60),
    'three-quarter': (None, 0, (0.8, -0.95, 0.32), (0, -0.02, 0.17), 60),
    'front': (None, 0, (0.0, -1.2, 0.22), (0, 0, 0.18), 60),
    'face': (None, 0, (0.12, -0.55, 0.32), (0, -0.2, 0.28), 85),
    'back': (None, 0, (-0.7, 0.9, 0.45), (0, 0.0, 0.16), 60),
    'sit': ('sit', 0.5, (0.85, -0.85, 0.3), (0, -0.04, 0.2), 60),
    'loaf': ('loaf', 0.5, (0.8, -0.8, 0.28), (0, 0, 0.12), 60),
    'walk-1': ('walk', 0.0, (1.25, -0.05, 0.16), (0, 0, 0.17), 60),
    'walk-2': ('walk', 0.25, (1.25, -0.05, 0.16), (0, 0, 0.17), 60),
    'walk-3': ('walk', 0.5, (0.8, -0.95, 0.32), (0, 0, 0.17), 60),
    'trot-1': ('trot', 0.1, (1.25, -0.05, 0.16), (0, 0, 0.17), 60),
    'trot-2': ('trot', 0.35, (1.25, -0.05, 0.16), (0, 0, 0.17), 60),
    'jump-takeoff': ('jump_takeoff', 0.2, (1.3, -0.2, 0.25), (0, 0, 0.2), 55),
    'jump-air': ('jump_air', 0.0, (1.3, -0.2, 0.25), (0, 0, 0.2), 55),
    'jump-land': ('jump_land', 0.13, (1.1, -0.6, 0.22), (0, 0, 0.15), 60),
    'swat': ('swat', 0.1, (0.9, -0.9, 0.3), (0, -0.05, 0.18), 60),
    'carried': ('carried_dangle', 0.67, (0.9, -1.0, 0.45), (0, 0, 0.4), 45),
    'carried-cradle': ('carried_cradle', 0.67, (0.9, -1.0, 0.45), (0, 0, 0.36), 45),
    'blink': ('slow_blink', 1.0, (0.1, -0.6, 0.24), (0.0, -0.22, 0.235), 110),
    'squash': ('squash', 1.0, (0.85, -0.85, 0.25), (0, 0, 0.1), 60),
}
_Q = (0.95, -0.75, 0.32)
# the bats at their contact frame; the rest at a telling moment
for _n, _t, _tz in (('bat_test_tap', 0.1, 0.15), ('bat_tap_loop', 0.0, 0.15), ('bat_push_final', 0.1, 0.15), ('bat_backhand_swipe', 0.1, 0.15),
                    ('bat_double_smack', 0.12, 0.2), ('bat_hook', 0.1, 0.15), ('bat_flick', 0.067, 0.15), ('bat_flurry', 0.0, 0.2),
                    ('bat_belly_push', 0.12, 0.1), ('bat_nose_push', 0.12, 0.13), ('bat_double_smack_windup', 0.0, 0.2), ('bat_backhand_swipe_windup', 0.0, 0.15),
                    ('react_innocent_sit', 1.0, 0.2), ('react_paw_lick', 0.5, 0.2),
                    ('react_stare_down', 1.0, 0.15), ('scratch_vertical', 0.1, 0.25), ('scratch_horizontal', 0.1, 0.1), ('scratch_bed', 0.1, 0.1),
                    ('scratch_on_scratcher', 0.1, 0.2), ('jump_wiggle', 0.07, 0.12),
                    ('butt_wiggle', 0.07, 0.12), ('groom_paw_face', 0.33, 0.2), ('yawn', 0.7, 0.2), ('stretch_front', 1.0, 0.15), ('flop_side', 1.0, 0.1),
                    ('knead', 0.35, 0.1), ('chatter', 0.5, 0.18), ('crouch_alert', 0.5, 0.12), ('ear_scratch', 0.3, 0.2), ('lick_chest', 0.5, 0.2),
                    ('startle_hop', 0.18, 0.25), ('stretch_back', 1.0, 0.15), ('lie_to_loaf', 1.15, 0.1)):
    CAT_SHOTS[_n] = (_n, _t, _Q, (0, -0.04, _tz), 60)


def studio(sc, floor=True):
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 960
    sc.render.resolution_y = 720
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:  # noqa: BLE001
        pass
    try:
        sc.eevee.use_shadows = True
        sc.eevee.use_raytracing = True
    except Exception:  # noqa: BLE001
        pass
    w = bpy.data.worlds.new('studio'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.42, 0.42, 0.44, 1); bg.inputs[1].default_value = 0.55
    def light(name, kind, loc, energy, size, color=(1, 1, 1)):
        l = bpy.data.lights.new(name, kind); l.energy = energy; l.color = color
        if kind == 'AREA':
            l.size = size
        o = bpy.data.objects.new(name, l); sc.collection.objects.link(o)
        o.location = loc
        d = V((0, 0, 0.15)) - V(loc)
        o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        return o
    light('key', 'AREA', (1.2, -1.0, 1.4), 70, 1.2, (1.0, 0.96, 0.9))
    light('fill', 'AREA', (-1.3, -0.9, 0.7), 22, 1.5, (0.85, 0.9, 1.0))
    light('rim', 'AREA', (-0.4, 1.4, 1.0), 60, 0.8, (1.0, 1.0, 1.0))
    if floor:
        bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
        fl = bpy.context.object; fl.name = 'floor'
        m = bpy.data.materials.new('floor'); m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (0.2, 0.18, 0.16, 1); b.inputs['Roughness'].default_value = 0.8
        fl.data.materials.append(m)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    return cam


def aim(cam, pos, tgt, lens):
    cam.location = V(pos)
    cam.rotation_euler = (V(tgt) - V(pos)).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens


def shoot(spec, plan, arm, ob, acts, out, name, shots=None):
    sc = bpy.context.scene
    cam = studio(sc)
    want = spec.get('renders')
    table = shots or CAT_SHOTS
    names = list(table) if want is True else [s for s in want if s in table]
    d = os.path.join(out, 'renders'); os.makedirs(d, exist_ok=True)
    done = []
    for sh in names:
        clip, t, off, tgt, lens = table[sh]
        for pb in arm.pose.bones:          # partial clips key only some bones: start the rest from the rest pose
            pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
        arm.animation_data.action = acts.get(clip) if clip else None
        key = ob.data.shape_keys
        if key is not None:
            key.animation_data_create()
            key.animation_data.action = bpy.data.actions.get(f'{clip}__shapes') if clip else None
            if key.animation_data.action is None:
                for kb in key.key_blocks:
                    kb.value = 0.0
        sc.frame_set(int(round(t * 30)))
        aim(cam, off, tgt, lens)
        p = os.path.join(d, f'{sh}.png')
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        done.append(p)
    arm.animation_data.action = None
    if ob.data.shape_keys is not None and ob.data.shape_keys.animation_data:
        ob.data.shape_keys.animation_data.action = None
    return done
