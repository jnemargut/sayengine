"""Eevee renders of a built person: full body views, expression close-ups (face shape keys), clip stills."""
import os
import bpy
import render

EXPRESSIONS = {
    'reading-content': ('reading', 1.0, {'mouthSmileLeft': 0.35, 'mouthSmileRight': 0.35, 'cheekSquintLeft': 0.25, 'cheekSquintRight': 0.25, 'eyeBlinkLeft': 0.2, 'eyeBlinkRight': 0.2}),
    'huh': ('look_around', 0.6, {'browInnerUp': 0.8, 'browOuterUpLeft': 0.9, 'browOuterUpRight': 0.5, 'jawOpen': 0.2, 'viseme_oh': 0.4}),
    'weary-sigh': ('idle', 0.5, {'browInnerUp': 0.75, 'eyeBlinkLeft': 0.45, 'eyeBlinkRight': 0.45, 'mouthFrownLeft': 0.5, 'mouthFrownRight': 0.5, 'viseme_ou': 0.25}),
    'suspicious': ('idle', 0.5, {'browDownLeft': 0.8, 'browDownRight': 0.8, 'cheekSquintLeft': 0.6, 'cheekSquintRight': 0.6, 'eyeBlinkLeft': 0.3, 'eyeBlinkRight': 0.3, 'mouthFrownLeft': 0.3, 'mouthSmileRight': 0.3}),
    'busted': ('look_around', 2.0, {'jawOpen': 0.9, 'viseme_aa': 0.3, 'browInnerUp': 0.9, 'browOuterUpLeft': 1.0, 'browOuterUpRight': 1.0}),
    'puzzled': ('idle', 1.4, {'browOuterUpLeft': 0.9, 'browDownRight': 0.6, 'mouthFrownLeft': 0.45, 'mouthSmileRight': 0.2, 'noseSneerRight': 0.2}),
}
# the face at rest from the front and three-quarter, the open mouth from three-quarter, speech shapes, a blink
# (name: clip, time, shape values, camera yaw in degrees round the head; front shots are 9 deg off-axis)
FACE_SHOTS = {
    'neutral': (None, 0, {}, 9), 'neutral-3q': (None, 0, {}, 40), 'busted-3q': ('look_around', 2.0, EXPRESSIONS['busted'][2], 38),
    'viseme-AA': (None, 0, {'viseme_aa': 1.0}, 9), 'viseme-O': (None, 0, {'viseme_oh': 1.0}, 9), 'viseme-E': (None, 0, {'viseme_E': 1.0}, 9),
    'viseme-M': (None, 0, {'viseme_PP': 1.0}, 9), 'blink-half': (None, 0, {'eyeBlinkLeft': 0.5, 'eyeBlinkRight': 0.5}, 9),
    'blink': (None, 0, {'eyeBlinkLeft': 1.0, 'eyeBlinkRight': 1.0}, 9),
}
BODY = {
    'front': (None, 0, (0, -3.6, 1.0), (0, 0, 0.92), 50),
    'three-quarter': (None, 0, (2.3, -2.8, 1.25), (0, 0, 0.92), 50),
    'side': (None, 0, (3.6, 0, 1.0), (0, 0, 0.92), 50),
    'idle': ('idle', 1.0, (1.6, -3.2, 1.2), (0, 0, 0.92), 50),
    'walk-1': ('walk', 0.0, (3.4, -1.2, 1.1), (0, 0, 0.9), 50),
    'walk-2': ('walk', 0.3, (3.4, -1.2, 1.1), (0, 0, 0.9), 50),
    'pick_up': ('pick_up', 1.25, (2.2, -2.4, 1.1), (0, 0, 0.6), 50),
    'look_around': ('look_around', 2.0, (1.4, -3.0, 1.3), (0, 0, 1.0), 50),
    'carry_cat': ('carry_cat', 1.0, (1.4, -3.0, 1.3), (0, 0, 1.0), 50),
    'reading': ('reading', 1.0, (1.4, -3.0, 1.3), (0, 0, 1.0), 50),
    'phone_call': ('phone_call', 1.0, (1.4, -3.0, 1.3), (0, 0, 1.0), 50),
    'sit_desk': ('sit_desk', 1.0, (2.4, -2.4, 1.2), (0, 0, 0.7), 50),
}
for _n, _t, _z in (('adjust_glasses', 0.8, 1.0), ('rub_neck', 1.2, 1.0), ('sip_tea', 1.1, 1.0), ('cross_legs', 1.0, 0.7), ('eat_fork', 0.9, 0.7),
                   ('think_pause', 1.0, 0.7), ('rub_eyes', 1.2, 1.0), ('stretch_arms_up', 1.4, 0.8), ('phone_pace_gesture', 0.3, 0.95),
                   ('hands_on_hips_sigh', 0.9, 1.0), ('pet_cat_down', 0.5, 0.6), ('read_chuckle', 0.6, 1.0)):
    BODY[_n] = (_n, _t, (1.6, -3.0, 1.25), (0, 0, _z), 50)


def shoot(spec, P, arm, face, acts, out):
    sc = bpy.context.scene
    cam = render.studio(sc)
    sc.render.resolution_x = 720; sc.render.resolution_y = 960
    d = os.path.join(out, 'renders'); os.makedirs(d, exist_ok=True)
    keys = face.data.shape_keys.key_blocks
    done = []
    def pose(clip, t):
        arm.animation_data.action = acts.get(clip) if clip else None
        if not clip:
            for pb in arm.pose.bones:
                pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
        sc.frame_set(int(round(t * 30)))
    want = spec.get('renders')
    for n, (clip, t, pos, tgt, lens) in BODY.items():
        if want is not True and n not in want:
            continue
        pose(clip, t)
        render.aim(cam, pos, tgt, lens)
        sc.render.filepath = os.path.join(d, f'{n}.png'); bpy.ops.render.render(write_still=True); done.append(sc.render.filepath)
    sc.render.resolution_x = 640; sc.render.resolution_y = 640
    import math
    import mathutils
    shots = {n: (*v, 9) for n, v in EXPRESSIONS.items()}
    shots.update(FACE_SHOTS)
    for n, (clip, t, vals, yaw) in shots.items():
        if want is not True and n not in want and 'faces' not in want:
            continue
        pose(clip, t)
        for k in keys[1:]:
            k.value = vals.get(k.name, 0.0)
        bpy.context.view_layer.update()
        # aim at the posed head, between the eyes and the mouth (the head bone's local Z points forward)
        hm = arm.matrix_world @ arm.pose.bones['Head'].matrix
        c = hm.translation + hm.to_3x3().col[1].normalized() * 0.11
        fwd = hm.to_3x3().col[2].normalized()
        view = mathutils.Matrix.Rotation(math.radians(yaw), 3, hm.to_3x3().col[1].normalized()) @ fwd
        render.aim(cam, c + view * 0.95 + mathutils.Vector((0, 0, 0.05)), c + fwd * 0.02, 85)
        sc.render.filepath = os.path.join(d, f'face-{n}.png'); bpy.ops.render.render(write_still=True); done.append(sc.render.filepath)
    for k in keys[1:]:
        k.value = 0.0
    arm.animation_data.action = None
    return done
