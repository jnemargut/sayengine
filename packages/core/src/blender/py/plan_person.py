"""The person body plan (bipeds): a humanoid skeleton, a body field the garments are shaped over, hands
with fingers and garments as separate shells (tee, cardigan, trousers, slippers). The head is the
studio's kit face (kithead.py), and the head, eye and jaw bones are fitted to it (use_kit_face).

Coordinates (x, f, z) in metres: x to the person's left, f forward, z up, feet on z = 0.
Bone names are the standard humanoid ones the studio uses (Hips, Spine, Chest, LeftUpperArm...).
"""
import math
import numpy as np
import sdf

to_blender = lambda p: (np.array([p[0], -p[1], p[2]]) if np.ndim(p) == 1 else np.stack([p[:, 0], -p[:, 1], p[:, 2]], 1))
from_blender = to_blender

PRESETS = {
    # an appealing, stylised-realistic dad about 40: a bit of a belly, a knit cardigan, reading glasses
    # (his face, skin and hair are the kit face's: creature.ts PERSON_FACES)
    'dad': dict(height=1.78, belly=0.7, shoulders=1.07, cardigan='#8d9c7e', tee='#e8e2d6', trousers='#4a4846', slippers='#6e4a36', glasses='#3a2c24'),
}


def norm(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


class Person:
    def __init__(self, params):
        pr = dict(PRESETS.get(params.get('preset', 'dad'), PRESETS['dad']))
        pr.update({k: v for k, v in params.items() if k in pr and v is not None})
        self.pr = pr
        s = pr['height'] / 1.78
        self.s = s
        bel = float(pr['belly'])
        self.belly = bel
        j = self.j = {}
        P = lambda x, f, z: np.array([x, f, z]) * s
        j['Hips'] = P(0, -0.012, 0.975)
        j['Spine'] = P(0, -0.02, 1.075)
        j['Chest'] = P(0, -0.028, 1.215)
        j['UpperChest'] = P(0, -0.032, 1.335)
        j['Neck'] = P(0, -0.03, 1.465)
        j['Head'] = P(0, -0.004, 1.575)
        j['HeadTop'] = P(0, 0.0, 1.765)
        sh = pr['shoulders']
        for side, sx in (('Left', 1), ('Right', -1)):
            j[f'{side}Shoulder'] = P(0.028 * sx, 0.0, 1.43)
            j[f'{side}UpperArm'] = P(0.172 * sh * sx, -0.022, 1.43)
            a = math.radians(47)
            d = np.array([math.cos(a) * sx, 0.0, -math.sin(a)])
            j[f'{side}LowerArm'] = j[f'{side}UpperArm'] + (d * 0.285 + np.array([0, -0.012, 0])) * s
            j[f'{side}Hand'] = j[f'{side}LowerArm'] + (d * 0.255 + np.array([0, 0.03, 0])) * s
            j[f'{side}HandEnd'] = j[f'{side}Hand'] + (d * 0.095 + np.array([0, 0.008, 0])) * s
            j[f'{side}UpperLeg'] = P(0.093 * sx, 0.0, 0.925)
            j[f'{side}LowerLeg'] = P(0.096 * sx, 0.012, 0.505)
            j[f'{side}Foot'] = P(0.098 * sx, -0.012, 0.088)
            j[f'{side}Toes'] = P(0.108 * sx, 0.135, 0.022)
            j[f'{side}ToesEnd'] = P(0.112 * sx, 0.205, 0.02)
        self.arm_dir = {sx: norm(j['LeftHand' if sx > 0 else 'RightHand'] - j['LeftLowerArm' if sx > 0 else 'RightLowerArm']) for sx in (1, -1)}
        # the head is the studio's kit face (kithead.py), fitted after it is built: use_kit_face()
        self.eye_dir = {1: np.array([0.0, 1.0, 0.0]), -1: np.array([0.0, 1.0, 0.0])}
        # ── the body (for the garments) ──────────────────────────────────────────
        b = bel
        Z = lambda z: z * s
        self.torso_st = [   # (z, front f, back f, half width)
            (Z(0.84), 0.060, -0.085, 0.150),
            (Z(0.93), 0.085 + 0.02 * b, -0.112, 0.172),
            (Z(1.02), 0.115 + 0.055 * b, -0.098, 0.168 + 0.008 * b),
            (Z(1.10), 0.122 + 0.06 * b, -0.09, 0.166 + 0.01 * b),
            (Z(1.19), 0.112 + 0.035 * b, -0.092, 0.168),
            (Z(1.29), 0.112, -0.1, 0.176),
            (Z(1.38), 0.095, -0.098, 0.182),
            (Z(1.45), 0.05, -0.07, 0.15),
        ]
        self.torso_st = [(z, f * s, bk * s, w * s) for z, f, bk, w in self.torso_st]
        self.belly_front = max(st[1] for st in self.torso_st)

    # ── fields ─────────────────────────────────────────────────────────────────
    def limb(self, q, sx, arm_r=(0.058, 0.048, 0.044, 0.033), leg_r=(0.09, 0.064, 0.056, 0.04)):
        j = self.j; s = self.s
        side = 'Left' if sx > 0 else 'Right'
        arm = sdf.chain(q, [j[f'{side}UpperArm'], j[f'{side}LowerArm'], j[f'{side}Hand']], [arm_r[0] * s, arm_r[2] * s, arm_r[3] * s], 0.0)
        dl = sdf.sphere(q, j[f'{side}UpperArm'] + np.array([0.01 * sx, 0, -0.005]) * s, 0.058 * s)
        arm = sdf.smin(arm, dl, 0.02 * s)
        calf = j[f'{side}LowerLeg'] + (j[f'{side}Foot'] - j[f'{side}LowerLeg']) * 0.3 + np.array([0, -0.012, 0]) * s
        leg = sdf.chain(q, [j[f'{side}UpperLeg'], j[f'{side}LowerLeg'], calf, j[f'{side}Foot']], [leg_r[0] * s, leg_r[1] * s, leg_r[2] * s, leg_r[3] * s], 0.0)
        return arm, leg

    def torso(self, q):
        return sdf.loft(q, self.torso_st, axis_x=0, axis_f=2, axis_z=1, fsign=1.0)

    def body(self, q):
        """The body under the clothes (plan coords)."""
        d = self.torso(q)
        for sx in (1, -1):
            arm, leg = self.limb(q, sx)
            d = sdf.smin(d, arm, 0.035 * self.s)
            d = sdf.smin(d, leg, 0.04 * self.s)
        return d

    def hand(self, q, sx, curl=0.35):
        """A relaxed hand: palm, four fingers in a gentle curl, a thumb. Built along the forearm line."""
        j = self.j; s = self.s * 1.22          # stylised: bigger hands
        side = 'Left' if sx > 0 else 'Right'
        w = j[f'{side}Hand']
        d = self.arm_dir[sx]
        # hand frame: y along the hand, z out of the back of the hand (the fingers curl to -z, the
        # palm faces the thigh), x towards the thumb side reversed (the thumb sits at -x, in front).
        # The right hand's frame is the mirror image (fine for distances).
        zv = norm(np.cross(d, [0, 1, 0])) * sx
        xv = norm(np.cross(d, zv)) * sx
        palm_c = w + d * 0.045 * s
        R = np.stack([xv, d, zv])
        ql = (q - palm_c) @ R.T
        palm = sdf.ellipsoid(ql, [0, 0, 0], np.array([0.042, 0.05, 0.016]) * s)
        wrist = sdf.ellipsoid(ql, [0, -0.045 * s, 0], np.array([0.03, 0.03, 0.02]) * s)
        dd = sdf.smin(palm, wrist, 0.02 * s)
        fingers = []
        for k, (off, ln) in enumerate(((-0.027, 0.075), (-0.009, 0.085), (0.009, 0.08), (0.025, 0.066))):
            base = np.array([off * s, 0.045 * s, 0.0])
            pts = [base]
            a = 0.0
            seg = ln * s / 3
            for i in range(3):
                a += curl * (0.5 + 0.35 * i)
                pts.append(pts[-1] + np.array([0, math.cos(a), -math.sin(a)]) * seg)
            r = np.array([0.0095, 0.0088, 0.0078, 0.0068]) * s * (0.93 if k == 3 else 1.0)
            fingers.append(sdf.chain(ql, pts, r, 0.0))
        thumb_pts = [np.array([-0.03 * s, -0.02 * s, -0.008 * s]), np.array([-0.05 * s, 0.01 * s, -0.02 * s]), np.array([-0.058 * s, 0.035 * s, -0.03 * s]), np.array([-0.058 * s, 0.055 * s, -0.036 * s])]
        fingers.append(sdf.chain(ql, thumb_pts, np.array([0.013, 0.0115, 0.0098, 0.0085]) * s, 0.0))
        for f in fingers:
            dd = sdf.smin(dd, f, 0.008 * s)
        self.hand_frame = getattr(self, 'hand_frame', {})
        self.hand_frame[sx] = (palm_c, R)
        return dd

    def garment_fields(self):
        s = self.s
        def body_off(q, o):
            return self.body(q) - o * s

        def tee(q):
            d = self.torso(q) - 0.004 * s
            for sx in (1, -1):
                arm, _ = self.limb(q, sx)
                side = 'Left' if sx > 0 else 'Right'
                # short sleeves
                ua, la = self.j[f'{side}UpperArm'], self.j[f'{side}LowerArm']
                t = ((q - ua) @ (la - ua)) / ((la - ua) @ (la - ua))
                sleeve = sdf.smax(arm - 0.008 * s, (t - 0.35) * 0.2, 0.003)
                d = sdf.smin(d, sleeve, 0.02 * s)
            neck = sdf.sphere(q, self.j['Neck'] + np.array([0, 0.03, 0.03]) * s, 0.075 * s)
            d = sdf.smax(d, -neck, 0.004)
            d = sdf.smax(d, -(q[:, 2] - 0.86 * s), 0.004)          # hem (tucked under the cardigan)
            return d

        def cardigan(q):
            outer = self.torso(q) - 0.02 * s
            inner = self.torso(q) - 0.011 * s
            for sx in (1, -1):
                arm, _ = self.limb(q, sx)
                side = 'Left' if sx > 0 else 'Right'
                h = self.j[f'{side}Hand']; la = self.j[f'{side}LowerArm']
                t = ((q - la) @ (h - la)) / ((h - la) @ (h - la))
                cuff = (t - 0.93) * 0.25
                outer = sdf.smin(outer, sdf.smax(arm - 0.018 * s, cuff, 0.003), 0.03 * s)
                inner = sdf.smin(inner, sdf.smax(arm - 0.007 * s, cuff + 0.002, 0.003), 0.03 * s)
            d = sdf.smax(outer, -inner, 0.0015)
            # hem below the belt line, a V opening from the collar to mid-chest, a back neckline
            d = sdf.smax(d, -(q[:, 2] - 0.835 * s), 0.004)
            zt = 1.47 * s; zb = 1.16 * s
            wv = np.clip((q[:, 2] - zb) / (zt - zb), 0, 1) * 0.075 * s + 0.004 * s
            vcut = np.maximum(np.abs(q[:, 0]) - wv, -(q[:, 1] - 0.0)) * 1.0
            vcut = np.where(q[:, 2] > zb - 0.01 * s, vcut, 1.0)
            d = sdf.smax(d, -vcut, 0.004)
            neck = sdf.sphere(q, self.j['Neck'] + np.array([0, -0.005, 0.02]) * s, 0.07 * s)
            d = sdf.smax(d, -neck, 0.004)
            return d

        def trousers(q):
            d = self.torso(q) - 0.012 * s
            for sx in (1, -1):
                _, leg = self.limb(q, sx, leg_r=(0.092, 0.07, 0.062, 0.05))
                d = sdf.smin(d, leg - 0.006 * s, 0.03 * s)
            d = sdf.smax(d, q[:, 2] - 1.0 * s, 0.004)                # waist (under the cardigan)
            d = sdf.smax(d, -(q[:, 2] - 0.045 * s), 0.004)            # hem over the slipper
            return d

        def slippers(q):
            d = None
            for sx in (1, -1):
                side = 'Left' if sx > 0 else 'Right'
                a, t = self.j[f'{side}Foot'], self.j[f'{side}ToesEnd']
                mid = 0.5 * (a + t) + np.array([0, -0.005, -0.03]) * s
                dirv = norm(t - a)
                yaw = math.atan2(dirv[0], dirv[1])
                R = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
                ql = (q - mid) @ R
                body_ = sdf.ellipsoid(ql, [0, 0, 0.012 * s], np.array([0.052, 0.138, 0.05]) * s)
                sole = sdf.ellipsoid(ql, [0, 0, -0.005 * s], np.array([0.055, 0.142, 0.022]) * s)
                dd = sdf.smin(body_, sole, 0.01 * s)
                dd = sdf.smax(dd, -(q[:, 2] - 0.0), 0.003)          # flat on the floor
                d = dd if d is None else np.minimum(d, dd)
            return d
        return dict(tee=tee, cardigan=cardigan, trousers=trousers, slippers=slippers)

    def use_kit_face(self, L):
        """Fit the skeleton's head, eye and jaw bones and the clips' face targets to the kit head (plan
        coords; L from kithead.landmarks)."""
        B = L['bones']
        self.j['Head'] = B['Head'][0]
        self.j['HeadTop'] = B['Head'][1]
        self.eye_l, self.eye_r = L['eyes']['Left']
        self.tmj, self.jaw_tail = B['Jaw']
        # (wrist targets for the hand-to-face clips: a few centimetres in front of the face, as the clips expect)
        e = self.eye_l; m = L['mouth']; nose = L['nose'][1]
        top, centre = L['ears']['Right']
        self.face_pts = dict(
            bridge=(0.0, nose + 0.031, e[2]), mouth=(0.0, nose + 0.031, m[2]), chin=(0.0, nose + 0.005, L['headBase'][2] + 0.017),
            nape=tuple(self.j['Neck'] + np.array([0, -0.06, 0.06])), eyeL=(0.8 * e[0], nose + 0.045, e[2]), eyeR=(-0.8 * e[0], nose + 0.045, e[2]),
            ear=tuple(centre + np.array([-0.007, 0.022, 0.004])),
        )

    def bone_table(self):
        """name -> (head, tail, parent, deform, roll_up) in Blender coords."""
        j = self.j; tb = to_blender
        T = {}
        fwd = (0, -1, 0)
        def add(n, h, t, parent, deform=True, up=fwd):
            T[n] = (tb(h), tb(t), parent, deform, up)
        add('Root', np.array([0, 0, 0]), np.array([0, -0.1, 0]), None, False, (0, 0, 1))
        add('Hips', j['Hips'], j['Spine'], 'Root')
        add('Spine', j['Spine'], j['Chest'], 'Hips')
        add('Chest', j['Chest'], j['UpperChest'], 'Spine')
        add('UpperChest', j['UpperChest'], j['Neck'], 'Chest')
        add('Neck', j['Neck'], j['Head'], 'UpperChest')
        add('Head', j['Head'], j['HeadTop'], 'Neck')
        add('Jaw', self.tmj, self.jaw_tail, 'Head', False)
        for sx, side in ((1, 'Left'), (-1, 'Right')):
            m = np.array([sx, 1, 1])
            e = self.eye_l * m
            add(f'{side}Eye', e, e + self.eye_dir[sx] * 0.02, 'Head', True, (0, 0, 1))
            add(f'{side}Shoulder', j[f'{side}Shoulder'], j[f'{side}UpperArm'], 'UpperChest')
            add(f'{side}UpperArm', j[f'{side}UpperArm'], j[f'{side}LowerArm'], f'{side}Shoulder')
            add(f'{side}LowerArm', j[f'{side}LowerArm'], j[f'{side}Hand'], f'{side}UpperArm')
            add(f'{side}Hand', j[f'{side}Hand'], j[f'{side}Hand'] + self.arm_dir[sx] * 0.05 * self.s, f'{side}LowerArm')
            add(f'{side}UpperLeg', j[f'{side}UpperLeg'], j[f'{side}LowerLeg'], 'Hips')
            add(f'{side}LowerLeg', j[f'{side}LowerLeg'], j[f'{side}Foot'], f'{side}UpperLeg')
            add(f'{side}Foot', j[f'{side}Foot'], j[f'{side}Toes'], f'{side}LowerLeg', True, (0, 0, 1))
            add(f'{side}Toes', j[f'{side}Toes'], j[f'{side}ToesEnd'], f'{side}Foot', True, (0, 0, 1))
        return T

    def finger_bones(self, T):
        """Finger chains in the hand frame (filled after hand() has set the frames)."""
        s = self.s * 1.22
        for sx, side in ((1, 'Left'), (-1, 'Right')):
            palm_c, R = self.hand_frame[sx]
            def W(p):
                return to_blender(palm_c + np.asarray(p) @ R)
            curl = 0.35
            names = (('Index', -0.027, 0.075), ('Middle', -0.009, 0.085), ('Ring', 0.009, 0.08), ('Little', 0.025, 0.066))
            for name, off, ln in names:
                pts = [np.array([off * s, 0.045 * s, 0.0])]
                a = 0.0
                for i in range(3):
                    a += curl * (0.5 + 0.35 * i)
                    pts.append(pts[-1] + np.array([0, math.cos(a), -math.sin(a)]) * ln * s / 3)
                parent = f'{side}Hand'
                for seg, (p0, p1) in zip(('Proximal', 'Intermediate', 'Distal'), zip(pts[:-1], pts[1:])):
                    T[f'{side}{name}{seg}'] = (W(p0), W(p1), parent, True, (0, 0, 1))
                    parent = f'{side}{name}{seg}'
            tp = [np.array([-0.03 * s, -0.02 * s, -0.008 * s]), np.array([-0.05 * s, 0.01 * s, -0.02 * s]), np.array([-0.058 * s, 0.035 * s, -0.03 * s]), np.array([-0.058 * s, 0.055 * s, -0.036 * s])]
            parent = f'{side}Hand'
            for seg, (p0, p1) in zip(('Metacarpal', 'Proximal', 'Distal'), zip(tp[:-1], tp[1:])):
                T[f'{side}Thumb{seg}'] = (W(p0), W(p1), parent, True, (0, 0, 1))
                parent = f'{side}Thumb{seg}'
        return T
