"""Alive-at-rest clips for a person: small layers (breath, weight shift, glances, a head shake) and idle
actions for reading, eating, study, phone calls, tidying and the cat, keyed on a stand or sit base.
Hand targets are world positions in plan coordinates (x left, f forward, z up), metres."""
import math
import mathutils
from anim import env, smooth
import anim_person as ap

V = mathutils.Vector
CH = ('dz', 'dy', 'dx', 'pitch', 'roll', 'yaw', 'bend', 'twist', 'side', 'nod', 'turn', 'tilt', 'shrug')


def kv(t, keys, ch, d=0.0):
    pts = [(kt, kd[ch]) for kt, kd in keys if ch in kd]
    if not pts:
        return d
    if pts[0][0] > 0:
        pts = [(0.0, pts[0][1] if isinstance(pts[0][1], tuple) else d)] + pts
    if isinstance(pts[0][1], tuple):
        return tuple(env(t, [(tt, v[i]) for tt, v in pts]) for i in range(len(pts[0][1])))
    return env(t, pts)


def install(PM, CLIPS):
    def keyed(self, t, keys, base='stand', breathe=True):
        g = lambda ch, d=0.0: kv(t, keys, ch, d)
        spec = {'rot': {}, 'loc': {}}
        P = ap.P
        if base == 'sit':
            seat = 0.52 * self.s
            self.body(spec, dz=seat - self.hip_z + g('dz'), dy=-0.04 * self.s + g('dy'), dx=g('dx'), pitch=6 + g('pitch'), roll=g('roll'), yaw=g('yaw'))
            legs = spec.setdefault('legs', {})
            for k, sx in (('LL', 1), ('RL', -1)):
                legs[k] = {'paw': P(0.12 * sx * self.s, 0.47 * self.s, 0.022), 'met': self.foot_dir[k], 'toe': V((0, -1, -0.05))}
            dl, dr = P(0.14 * self.s, 0.3 * self.s, 0.58 * self.s), P(-0.14 * self.s, 0.3 * self.s, 0.58 * self.s)   # hands in the lap
        else:
            self.body(spec, dz=g('dz'), dy=g('dy'), dx=g('dx'), pitch=g('pitch'), roll=g('roll'), yaw=g('yaw'))
            self.feet(spec)
            dl, dr = self.side_hands()
        self.spine(spec, bend=g('bend'), twist=g('twist'), side=g('side'))
        self.head(spec, nod=g('nod'), turn=g('turn'), tilt=g('tilt'))
        sh = g('shrug')
        if sh:
            spec['rot']['LeftShoulder'] = (0, 0, -10 * sh); spec['rot']['RightShoulder'] = (0, 0, 10 * sh)
        lh = V(P(*g('LH'))) if any('LH' in kd for _, kd in keys) else dl
        rh = V(P(*g('RH'))) if any('RH' in kd for _, kd in keys) else dr
        ld = V(P(*g('Ldir'))) if any('Ldir' in kd for _, kd in keys) else None
        rd = V(P(*g('Rdir'))) if any('Rdir' in kd for _, kd in keys) else None
        self.hands(spec, lh, rh, ld, rd)
        if breathe:
            self.breathe(spec, t)
        return spec

    def pts(self):
        """Handy places on this person's face and body (plan coords), from the fitted kit head."""
        return self.person.face_pts

    s_ = lambda self: self.s

    def idle_breathe(self, t):
        spec = self.idle(t)
        self.breathe(spec, t, rate=0.22, amt=1.8)
        return spec

    def idle_weight_shift(self, t):
        w = math.sin(2 * math.pi * t / 5.0)
        return keyed(self, t, [(0.0, {'dx': 0.025 * w, 'roll': 2.5 * w, 'side': -2.5 * w, 'tilt': 2 * w, 'nod': 2})])

    def glance_around(self, t):
        return keyed(self, t, [(0.0, {}), (0.4, {'turn': 35, 'nod': -3}), (1.2, {'turn': 35}), (1.6, {'turn': -30, 'tilt': 4}), (2.4, {'turn': -30}), (3.0, {'turn': 0, 'tilt': 0, 'nod': 0})])

    def adjust_glasses(self, t):
        q = pts(self)
        rest = (-0.205 * self.s, 0.02 * self.s, 0.86 * self.s)
        tgt = (q['bridge'][0], q['bridge'][1] + 0.02, q['bridge'][2] - 0.02)
        return keyed(self, t, [(0.0, {'RH': rest, 'Rdir': (0, -0.2, -1)}), (0.55, {'RH': tgt, 'Rdir': (0.3, 0.4, 1), 'nod': -6}), (1.1, {'RH': (tgt[0], tgt[1], tgt[2] + 0.01), 'nod': -4}),
                                (1.7, {'RH': rest, 'Rdir': (0, -0.2, -1), 'nod': 0})])

    def rub_neck(self, t):
        q = pts(self)
        rest = (-0.205 * self.s, 0.02 * self.s, 0.86 * self.s)
        rub = 0.015 * math.sin(2 * math.pi * 2.5 * t) * env(t, [(0, 0), (0.7, 1), (1.9, 1), (2.3, 0)])
        return keyed(self, t, [(0.0, {'RH': rest, 'Rdir': (0, -0.2, -1)}), (0.7, {'RH': q['nape'], 'Rdir': (0.8, -0.3, 0.4), 'nod': 12, 'tilt': 8}),
                                (1.9, {'RH': q['nape'], 'nod': 14, 'tilt': 10, 'dx': rub}), (2.6, {'RH': rest, 'Rdir': (0, -0.2, -1), 'nod': 0, 'tilt': 0, 'dx': 0})])

    def read_page_turn(self, t):
        return self.reading(2.3 + t * (1.0 / 1.0) if t < 1.0 else 3.3 + (t - 1.0))

    def read_chuckle(self, t):
        spec = self.reading(1.0)
        b = 3 * math.sin(2 * math.pi * 5 * t) * env(t, [(0, 0), (0.2, 1), (1.2, 1), (1.6, 0)])
        spec['rot']['Chest'] = (b, 0, 0); spec['rot']['Head'] = (spec['rot']['Head'][0] - 6 * env(t, [(0, 0), (0.3, 1), (1.3, 1), (1.6, 0)]), 0, 0)
        return spec

    def sip_tea(self, t):
        q = pts(self)
        cup = (-0.1 * self.s, 0.24 * self.s, 1.08 * self.s)
        lip = (q['mouth'][0] - 0.02, q['mouth'][1] + 0.05, q['mouth'][2] - 0.02)
        return keyed(self, t, [(0.0, {'RH': cup, 'Rdir': (0.6, -1, 0.3), 'LH': (0.0, 0.24 * self.s, 1.0 * self.s), 'Ldir': (-0.6, -1, 0.2)}),
                                (0.8, {'RH': lip, 'Rdir': (0.5, -0.4, 1), 'nod': -10}), (1.5, {'RH': lip, 'nod': -12}), (2.4, {'RH': cup, 'Rdir': (0.6, -1, 0.3), 'nod': 0})])

    def sit_idle(self, t):
        w = math.sin(2 * math.pi * t / 4.0)
        return keyed(self, t, [(0.0, {'nod': 4 + 2 * w, 'turn': 6 * w, 'bend': 2})], base='sit')

    def cross_legs(self, t):
        spec = sit_idle(self, t)
        knee = spec['legs']['RL']['paw'] + V((0, 0, 0.42 * self.s))
        spec['legs']['LL'] = {'paw': knee + V((-0.02, -0.06, 0.05)), 'met': V((-0.3, -1, -0.2)).normalized(), 'pole': V((0.3, -1, 0.6)), 'toe': V((-0.3, -1, 0.2))}
        return spec

    def eat_fork(self, t):
        q = pts(self)
        plate = (-0.12 * self.s, 0.42 * self.s, 0.78 * self.s)
        mouth = (q['mouth'][0] - 0.01, q['mouth'][1] + 0.06, q['mouth'][2] - 0.03 - (0.52 * self.s - self.hip_z) * 0)
        return keyed(self, t, [(0.0, {'RH': plate, 'Rdir': (0.2, -1, -0.5), 'LH': (0.14 * self.s, 0.4 * self.s, 0.78 * self.s), 'Ldir': (-0.2, -1, -0.4), 'nod': 14}),
                                (0.7, {'RH': mouth, 'Rdir': (0.4, -0.6, 0.8), 'nod': 2}), (1.0, {'RH': mouth, 'nod': 0}), (1.7, {'RH': plate, 'Rdir': (0.2, -1, -0.5), 'nod': 14}),
                                (2.0, {'RH': plate, 'nod': 14})], base='sit')

    def chew(self, t):
        spec = self.idle(t)
        c = math.sin(2 * math.pi * 2.2 * t)
        spec['rot']['Jaw'] = (6 + 6 * c, 0, 0)               # drive jawOpen from this bone in the game
        spec['rot']['Head'] = (spec['rot'].get('Head', (0, 0, 0))[0] + 1.5 * c, 0, 0)
        return spec

    def type_burst(self, t):
        spec = self.sit_desk(t * 2.6)
        if getattr(self, 'toy', 0.0):
            # typing with character: hunched at the keys, the head pecking along, then a look up at the screen
            k = self.toy
            look = env(t, [(0.0, 0), (1.25, 0), (1.4, 1), (1.8, 1), (2.0, 0)])
            r = spec['rot'].get('Head', (0, 0, 0)); n = spec['rot'].get('Neck', (0, 0, 0))
            spec['rot']['Head'] = (r[0] + k * (7 * (1 - look) + 2.5 * math.sin(2 * math.pi * t * 5.2) * (1 - look) - 9 * look), r[1] + 5 * k * math.sin(2 * math.pi * t / 2.0) * (1 - look), r[2])
            spec['rot']['Neck'] = (n[0] + 5 * k * (1 - look), n[1], n[2])
            spec['rot']['LeftShoulder'] = (0, 0, -6 * k * (1 - look)); spec['rot']['RightShoulder'] = (0, 0, 6 * k * (1 - look))
        return spec

    def knee_groan(self, t):
        # getting up, at 40: hands on the knees, a lean, a push that stalls half way, then a hand to the small of the back
        s = self.s
        kl, kr = (0.13 * s, 0.40 * s, 0.57 * s), (-0.13 * s, 0.40 * s, 0.57 * s)
        back = (-0.10 * s, -0.13 * s, 0.70 * s)
        return keyed(self, t, [(0.0, {}),
                               (0.5, {'pitch': 24, 'bend': 16, 'nod': 14, 'LH': kl, 'RH': kr, 'Ldir': (0, 0.2, -1), 'Rdir': (0, 0.2, -1), 'shrug': 0.6}),
                               (1.15, {'pitch': 30, 'dz': 0.09 * s, 'dy': 0.07 * s, 'bend': 8, 'nod': -4, 'LH': kl, 'RH': kr, 'shrug': 1}),
                               (1.5, {'pitch': 31, 'dz': 0.07 * s, 'dy': 0.07 * s, 'bend': 10, 'nod': 6, 'LH': kl, 'RH': kr, 'shrug': 1}),
                               (2.1, {'pitch': 6, 'dz': 0.15 * s, 'dy': 0.13 * s, 'bend': -9, 'nod': -12, 'LH': kl, 'RH': back, 'Rdir': (0.3, 1, 0.2), 'shrug': 0.2}),
                               (2.6, {'pitch': 4, 'dz': 0.15 * s, 'dy': 0.13 * s, 'bend': -6, 'nod': -6, 'LH': kl, 'RH': back, 'Rdir': (0.3, 1, 0.2)})], base='sit')

    def think_pause(self, t):
        q = pts(self)
        w = math.sin(2 * math.pi * t / 3.0)
        drop = 0.52 * self.s - self.hip_z
        chin = (q['chin'][0] - 0.01, q['chin'][1] + 0.03, q['chin'][2] - 0.02 + drop + 0.02)
        return keyed(self, t, [(0.0, {'RH': chin, 'Rdir': (0.2, 0.2, 1), 'LH': (0.15 * self.s, 0.4 * self.s, 0.77 * self.s), 'Ldir': (-0.1, -1, -0.35), 'tilt': 8 + 3 * w, 'turn': 10, 'nod': -6})], base='sit')

    def rub_eyes(self, t):
        q = pts(self)
        rest_l, rest_r = (0.205 * self.s, 0.02 * self.s, 0.86 * self.s), (-0.205 * self.s, 0.02 * self.s, 0.86 * self.s)
        rub = 0.01 * math.sin(2 * math.pi * 3 * t)
        el = (q['eyeL'][0] + rub, q['eyeL'][1] + 0.01, q['eyeL'][2] - 0.02)
        er = (q['eyeR'][0] - rub, q['eyeR'][1] + 0.01, q['eyeR'][2] - 0.02)
        return keyed(self, t, [(0.0, {'LH': rest_l, 'RH': rest_r}), (0.6, {'LH': el, 'RH': er, 'Ldir': (-0.3, 0.3, 1), 'Rdir': (0.3, 0.3, 1), 'nod': 14}),
                                (1.8, {'LH': el, 'RH': er, 'nod': 16}), (2.4, {'LH': rest_l, 'RH': rest_r, 'Ldir': (0, -0.2, -1), 'Rdir': (0, -0.2, -1), 'nod': 0})])

    def stretch_arms_up(self, t):
        drop = 0.52 * self.s - self.hip_z
        up_l, up_r = (0.12 * self.s, 0.02, 2.02 * self.s + drop), (-0.12 * self.s, 0.02, 2.02 * self.s + drop)
        lap_l, lap_r = (0.14 * self.s, 0.3 * self.s, 0.58 * self.s), (-0.14 * self.s, 0.3 * self.s, 0.58 * self.s)
        return keyed(self, t, [(0.0, {'LH': lap_l, 'RH': lap_r}), (0.9, {'LH': up_l, 'RH': up_r, 'Ldir': (0, 0, 1), 'Rdir': (0, 0, 1), 'bend': -10, 'nod': -12}),
                                (2.0, {'LH': up_l, 'RH': up_r, 'bend': -12, 'nod': -14}), (3.0, {'LH': lap_l, 'RH': lap_r, 'Ldir': (0, -1, -0.4), 'Rdir': (0, -1, -0.4), 'bend': 0, 'nod': 0})], base='sit')

    def phone_pace_gesture(self, t):
        spec = self.walk(t, period=1.1, speed=0.45, lift=0.05)
        q = pts(self)
        g = math.sin(2 * math.pi * t / 1.1)
        self.hands(spec, V(ap.P(0.24 * self.s, 0.2 * self.s + 0.05 * g, 1.05 * self.s + 0.04 * g)), V(ap.P(*q['ear'])), V((-0.5, -1, 0.3 * g)), V((0.1, -0.2, 1)))
        spec['rot']['Head'] = (spec['rot']['Head'][0], spec['rot']['Head'][1], -8)
        return spec

    def phone_laugh(self, t):
        spec = self.phone_call(t)
        b = 3.5 * math.sin(2 * math.pi * 5 * t) * env(t, [(0, 0), (0.2, 1), (1.6, 1), (2.0, 0)])
        spec['rot']['Chest'] = (b, 0, 0)
        spec['rot']['Head'] = (spec['rot']['Head'][0] - 10 * env(t, [(0, 0), (0.3, 1), (1.7, 1), (2.0, 0)]), spec['rot']['Head'][1], spec['rot']['Head'][2])
        return spec

    def hands_on_hips_sigh(self, t):
        hip_l, hip_r = (0.22 * self.s, 0.0, 1.0 * self.s), (-0.22 * self.s, 0.0, 1.0 * self.s)
        return keyed(self, t, [(0.0, {'LH': hip_l, 'RH': hip_r, 'Ldir': (-0.6, 0.4, -0.5), 'Rdir': (0.6, 0.4, -0.5)}),
                                (0.9, {'shrug': 1.0, 'bend': -3, 'nod': -6}), (1.6, {'shrug': -0.4, 'bend': 4, 'nod': 14}), (3.0, {'shrug': 0, 'bend': 0, 'nod': 4})])

    def head_shake(self, t):
        spec = self.idle(t)
        k = env(t, [(0, 0), (0.15, 1), (1.3, 1), (1.6, 0)])
        tn = 18 * math.sin(2 * math.pi * 2.4 * t) * k
        spec['rot']['Neck'] = (spec['rot']['Neck'][0], tn * 0.4, 0); spec['rot']['Head'] = (spec['rot']['Head'][0], tn * 0.6, 0)
        return spec

    def pet_cat_down(self, t):
        stroke = (t / 1.5) % 1.0
        f = 0.38 - 0.22 * smooth(min(1.0, stroke / 0.7)) if stroke < 0.7 else 0.16 + 0.22 * smooth((stroke - 0.7) / 0.3)
        z = 0.3 + 0.02 * math.sin(math.pi * min(1.0, stroke / 0.7))
        return keyed(self, t, [(0.0, {'dz': -0.32 * self.s, 'dy': -0.1 * self.s, 'pitch': 26, 'bend': 34, 'nod': -6, 'RH': (-0.08 * self.s, f * self.s, z * self.s), 'Rdir': (0, -1, -0.6),
                                      'LH': (0.14 * self.s, 0.2 * self.s, 0.52 * self.s)})])

    fns = dict(idle_breathe=idle_breathe, idle_weight_shift=idle_weight_shift, glance_around=glance_around, adjust_glasses=adjust_glasses, rub_neck=rub_neck,
               read_page_turn=read_page_turn, read_chuckle=read_chuckle, sip_tea=sip_tea, cross_legs=cross_legs, sit=sit_idle, eat_fork=eat_fork, chew=chew,
               type_burst=type_burst, think_pause=think_pause, rub_eyes=rub_eyes, stretch_arms_up=stretch_arms_up, phone_pace_gesture=phone_pace_gesture,
               phone_laugh=phone_laugh, hands_on_hips_sigh=hands_on_hips_sigh, head_shake=head_shake, pet_cat_down=pet_cat_down, knee_groan=knee_groan)
    for n, f in fns.items():
        setattr(PM, n, f)
    CLIPS.update({
        'idle_breathe': ('idle_breathe', 4.5, True, {'speed': 0.0, 'partial': 'Spine,Chest,UpperChest'}),
        'idle_weight_shift': ('idle_weight_shift', 5.0, True, {'speed': 0.0}),
        'glance_around': ('glance_around', 3.0, False, {'speed': 0.0, 'partial': 'Neck,Head'}),
        'adjust_glasses': ('adjust_glasses', 1.7, False, {'speed': 0.0, 'contact': [0.55]}),
        'rub_neck': ('rub_neck', 2.6, False, {'speed': 0.0}),
        'read_page_turn': ('read_page_turn', 1.6, False, {'speed': 0.0}),
        'read_chuckle': ('read_chuckle', 1.6, False, {'speed': 0.0}),
        'sip_tea': ('sip_tea', 2.4, False, {'speed': 0.0, 'contact': [0.8]}),
        'sit': ('sit', 4.0, True, {'speed': 0.0, 'seat': 0.46}),
        'cross_legs': ('cross_legs', 4.0, True, {'speed': 0.0, 'seat': 0.46}),
        'eat_fork': ('eat_fork', 2.0, True, {'speed': 0.0, 'contact': [0.0, 0.85], 'seat': 0.46, 'table': 0.74}),
        'chew': ('chew', 2.0, True, {'speed': 0.0, 'partial': 'Head,Jaw', 'note': 'Jaw is a control bone: map its X rotation to the jawOpen shape'}),
        'type_burst': ('type_burst', 2.0, True, {'speed': 0.0, 'seat': 0.46, 'desk': 0.74}),
        'think_pause': ('think_pause', 3.0, True, {'speed': 0.0, 'seat': 0.46}),
        'rub_eyes': ('rub_eyes', 2.4, False, {'speed': 0.0}),
        'stretch_arms_up': ('stretch_arms_up', 3.0, False, {'speed': 0.0, 'seat': 0.46}),
        'knee_groan': ('knee_groan', 2.6, False, {'speed': 0.0, 'seat': 0.46}),
        'phone_pace_gesture': ('phone_pace_gesture', 2.2, True, {'speed': 0.45}),
        'phone_laugh': ('phone_laugh', 2.0, False, {'speed': 0.0}),
        'hands_on_hips_sigh': ('hands_on_hips_sigh', 3.0, False, {'speed': 0.0}),
        'head_shake': ('head_shake', 1.6, False, {'speed': 0.0, 'partial': 'Neck,Head'}),
        'pet_cat_down': ('pet_cat_down', 3.0, True, {'speed': 0.0, 'contact': [0.0, 1.5]}),
    })
