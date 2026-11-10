"""Alive-at-rest clips for the cat: small layers (breath, weight shift, tail, ears, blinks, a head tilt,
a sniff) as partial clips a game can blend over any base, and idle actions (grooming, a yawn, the two
stretches, lying down to a loaf, a flop, an ear scratch, kneading, chattering at a bird, a startle hop,
an alert crouch). Uses the bat module's keyed bases."""
import math
import mathutils
from anim import env, smooth, LEGS

V = mathutils.Vector


def mix_specs(a, b, k):
    """Blend two pose specs (rotations, offsets, scales, leg targets) by k."""
    out = {}
    for key in ('rot', 'loc', 'wloc', 'scale'):
        A, B = a.get(key, {}), b.get(key, {})
        dflt = (1, 1, 1) if key == 'scale' else (0, 0, 0)
        names = set(A) | set(B)
        out[key] = {n: tuple(x + (y - x) * k for x, y in zip(A.get(n, dflt), B.get(n, dflt))) for n in names}
    legs = {}
    for leg in set(a.get('legs', {})) | set(b.get('legs', {})):
        la, lb = a['legs'].get(leg), b['legs'].get(leg)
        if la and lb:
            legs[leg] = {'paw': la['paw'].lerp(lb['paw'], k), 'met': la['met'].lerp(lb['met'], k).normalized()}
            if 'pole' in la or 'pole' in lb:
                legs[leg]['pole'] = la.get('pole', lb.get('pole')).lerp(lb.get('pole', la.get('pole')), k)
        else:
            legs[leg] = la or lb
    out['legs'] = legs
    return out


def install(CatMotion, CLIPS):
    import anim_bats as ab

    def S(self, t, keys):
        return self._stand_k(t, keys)

    def idle_breathe(self, t):
        spec = self.idle(t)
        self.breathe(spec, t, rate=0.25, amt=1.8)       # slow and heavy: four seconds a breath
        return spec

    def idle_weight_shift(self, t):
        w = math.sin(2 * math.pi * t / 4.0)
        spec = S(self, t, [(0.0, {'dx': 0.012 * w, 'roll': 3.5 * w, 'neckYaw': -3 * w, 'tilt': -2 * w, 'LF': (0, 0, 0, 0)})])
        self.breathe(spec, t, 0.5, 1.0)
        return spec

    def idle_tail_sway(self, t):
        spec = self.idle(t)
        u = 2 * math.pi * t / 3.0
        self.tail(spec, base_pitch=-10, sway=[6 * math.sin(u), 10 * math.sin(u - 0.5), 14 * math.sin(u - 1.0), 20 * math.sin(u - 1.5)], droop=-8)
        return spec

    def ear_swivel(self, t, side):
        spec = self.idle(t)
        k = env(t, [(0, 0), (0.2, 1), (0.8, 1), (1.2, 0)])
        sx = 1 if side == 'L' else -1
        spec['rot'][f'ear.{side}'] = (0, 55 * sx * k, -10 * sx * k)    # turn the opening out and back
        return spec

    def slow_blink(self, t):
        spec = self.idle(t)
        self.blink(spec, env(t, [(0, 0), (0.5, 0.95), (1.2, 0.95), (1.8, 0), (2.0, 0)]))
        return spec

    def head_tilt(self, t):
        spec = self.idle(t)
        k = env(t, [(0, 0), (0.35, 1), (1.4, 1), (2.0, 0)])
        spec['rot']['spine.006'] = (4 * k, 24 * k, 0)
        return spec

    def sniff(self, t):
        spec = self.idle(t)
        bob = 1.5 * math.sin(2 * math.pi * 6 * t) * env(t, [(0, 0), (0.2, 1), (1.2, 1), (1.5, 0)])
        k = env(t, [(0, 0), (0.25, 1), (1.2, 1), (1.5, 0)])
        spec['rot']['spine.004'] = (-8 * k, 0, 0); spec['rot']['spine.006'] = (6 * k + bob, 0, 0)
        spec['wloc']['spine'] = (0, -0.008 * k, 0)
        return spec

    # idle actions ----------------------------------------------------------
    def groom_paw_face(self, t):
        u = (t / 1.0) % 1.0
        wipe = math.sin(2 * math.pi * u)
        return ab_sit(self, t, [(0.0, {'RF': (0.0 + 0.01 * wipe, 0.04, 0.085 + 0.01 * wipe, 1.0), 'neck': -12, 'head': -18, 'headYaw': -14 + 8 * wipe, 'tilt': -14, 'blink': 0.6})])

    def lick_chest(self, t):
        lick = 5 * math.sin(2 * math.pi * 3.5 * t)
        return ab_sit(self, t, [(0.0, {'neck': -34, 'head': -30 + lick, 'blink': 0.55, 'tilt': 4})])

    def yawn(self, t):
        spec = S(self, t, [(0.0, {}), (0.5, {'neck': 14, 'head': 16, 'ears': 25, 'blink': 0.8, 'LF': (0, 0.03, 0, 0), 'RF': (0, 0.03, 0, 0)}),
                           (1.5, {'neck': 18, 'head': 20, 'ears': 28, 'blink': 0.9, 'LF': (0, 0.03, 0, 0), 'RF': (0, 0.03, 0, 0)}),
                           (2.2, {'neck': 0, 'head': 0, 'ears': 0, 'blink': 0.0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0)})])
        spec['rot']['jaw'] = (env(t, [(0, 0), (0.5, 28), (1.5, 30), (2.0, 0)]), 0, 0)
        return spec

    def stretch_front(self, t):
        # the downward cat: front legs far forward, chest low, rump and tail up
        return S(self, t, [(0.0, {}), (0.6, {'LF': (0, 0.11, 0, -0.2), 'RF': (0, 0.11, 0, -0.2), 'pitch': -12, 'dz': -0.03, 'dy': 0.02, 'neck': 6, 'head': 10, 'tail': 40, 'blink': 0.6, 'ears': 10}),
                           (1.8, {'LF': (0, 0.115, 0, -0.2), 'RF': (0, 0.115, 0, -0.2), 'pitch': -13, 'dz': -0.035, 'dy': 0.025, 'neck': 8, 'head': 10, 'tail': 45, 'blink': 0.7, 'ears': 10}),
                           (2.6, {'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'pitch': 0, 'dz': 0, 'dy': 0, 'neck': 0, 'head': 0, 'tail': -8, 'blink': 0, 'ears': 0})])

    def stretch_back(self, t):
        return S(self, t, [(0.0, {}), (0.6, {'LH': (0, -0.1, 0.01, 0.5), 'RH': (0, -0.05, 0, 0.2), 'pitch': 6, 'dy': 0.02, 'neck': 4, 'blink': 0.5}),
                           (1.6, {'LH': (0, -0.11, 0.015, 0.6), 'RH': (0, -0.05, 0, 0.2), 'pitch': 7, 'dy': 0.025, 'neck': 6, 'blink': 0.6}),
                           (2.4, {'LH': (0, 0, 0, 0), 'RH': (0, 0, 0, 0), 'pitch': 0, 'dy': 0, 'neck': 0, 'blink': 0})])

    def lie_to_loaf(self, t):
        k = env(t, [(0, 0), (0.35, 0.15), (1.5, 1.0), (2.0, 1.0)])
        spec = mix_specs(self.idle(t), self.loaf(t), k)
        return spec

    def flop_side(self, t):
        k = env(t, [(0, 0), (0.6, 0.2), (1.1, 1.0), (2.4, 1.0)])
        spec = self.loaf(t)
        r = spec['rot']['spine']
        spec['rot']['spine'] = (r[0], r[1] + 78 * k, r[2])
        w = spec['wloc']['spine']
        drop = 0.06 * k
        spec['wloc']['spine'] = (w[0] - 0.08 * k, w[1], w[2] + 0.03 * k - drop * 0.2)
        spec['rot']['spine.006'] = (0, -40 * k, 0)
        return spec

    def ear_scratch(self, t):
        u = (t * 5.0) % 1.0
        sc = 0.012 * math.sin(2 * math.pi * u)
        return ab_sit(self, t, [(0.0, {'RH': (-0.02, 0.17, 0.13 + sc, 0.6), 'tilt': -24, 'headYaw': -10, 'neck': -6, 'blink': 0.7, 'roll': -6})])

    def knead(self, t):
        u = (t / 1.0) % 1.0
        out = {}
        for leg, ph in (('LF', 0.0), ('RF', 0.5)):
            v = math.sin(2 * math.pi * (u - ph))
            out[leg] = (0, 0.02 * v, 0.012 * max(0.0, v), 0.4 * max(0.0, -v))
        return ab_lie(self, t, [(0.0, {'LF': out['LF'], 'RF': out['RF'], 'blink': 0.65, 'dz': 0.02})])

    def chatter(self, t):
        spec = S(self, t, [(0.0, {'dz': -0.02, 'neck': 18, 'head': 18, 'ears': -10, 'tail': -12, 'tailSway': 12, 'pitch': -4})])
        spec['rot']['jaw'] = (8 + 7 * math.sin(2 * math.pi * 9 * t), 0, 0)
        return spec

    def startle_hop(self, t):
        spec = S(self, t, [(0.0, {}), (0.12, {'dz': -0.015, 'ears': 30}), (0.3, {'dz': 0.09, 'pitch': 6, 'ears': 35, 'tail': 50, 'LF': (0, 0, 0.05, 0.6), 'RF': (0, 0, 0.05, 0.6), 'LH': (0, 0, 0.03, 0.4), 'RH': (0, 0, 0.03, 0.4)}),
                           (0.55, {'dz': -0.02, 'pitch': 0, 'ears': 30, 'tail': 40, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'LH': (0, 0, 0, 0), 'RH': (0, 0, 0, 0)}),
                           (1.2, {'dz': 0, 'ears': 0, 'tail': -8})])
        spec['rot']['spine.002'] = (env(t, [(0, 0), (0.3, -14), (0.6, -6), (1.2, 0)]), 0, 0)   # an arched back
        return spec

    def crouch_alert(self, t):
        return S(self, t, [(0.0, {'dz': -0.03, 'pitch': -6, 'neck': 10, 'head': 4, 'ears': -12, 'tail': -16, 'tailSway': 6,
                                  'LF': (0, 0.02, 0, 0.3), 'RF': (0, 0.02, 0, 0.3)})])

    def ab_sit(self, t, keys):
        return self._sit_k(t, keys)

    def ab_lie(self, t, keys):
        return self._lie_k(t, keys)

    fns = dict(idle_breathe=idle_breathe, idle_weight_shift=idle_weight_shift, idle_tail_sway=idle_tail_sway,
               ear_swivel_L=lambda self, t: ear_swivel(self, t, 'L'), ear_swivel_R=lambda self, t: ear_swivel(self, t, 'R'),
               slow_blink=slow_blink, head_tilt=head_tilt, sniff=sniff, groom_paw_face=groom_paw_face, lick_chest=lick_chest, yawn=yawn,
               stretch_front=stretch_front, stretch_back=stretch_back, lie_to_loaf=lie_to_loaf, flop_side=flop_side, ear_scratch=ear_scratch,
               knead=knead, chatter=chatter, startle_hop=startle_hop, crouch_alert=crouch_alert)
    for n, f in fns.items():
        setattr(CatMotion, n, f)
    CLIPS.update({
        'idle_breathe': ('idle_breathe', 4.0, True, {'speed': 0.0, 'partial': 'spine.001,spine.002,spine.003,belly'}),
        'idle_weight_shift': ('idle_weight_shift', 4.0, True, {'speed': 0.0}),
        'idle_tail_sway': ('idle_tail_sway', 3.0, True, {'speed': 0.0, 'partial': 'tail'}),
        'ear_swivel_L': ('ear_swivel_L', 1.2, False, {'speed': 0.0, 'partial': 'ear.L'}),
        'ear_swivel_R': ('ear_swivel_R', 1.2, False, {'speed': 0.0, 'partial': 'ear.R'}),
        'slow_blink': ('slow_blink', 2.0, False, {'speed': 0.0, 'partial': 'lid'}),
        'head_tilt': ('head_tilt', 2.0, False, {'speed': 0.0, 'partial': 'spine.006'}),
        'sniff': ('sniff', 1.5, False, {'speed': 0.0, 'partial': 'spine.004,spine.005,spine.006'}),
        'groom_paw_face': ('groom_paw_face', 3.0, True, {'speed': 0.0}),
        'lick_chest': ('lick_chest', 2.4, True, {'speed': 0.0}),
        'yawn': ('yawn', 2.2, False, {'speed': 0.0}),
        'stretch_front': ('stretch_front', 2.6, False, {'speed': 0.0}),
        'stretch_back': ('stretch_back', 2.4, False, {'speed': 0.0}),
        'lie_to_loaf': ('lie_to_loaf', 2.0, False, {'speed': 0.0}),
        'flop_side': ('flop_side', 2.4, False, {'speed': 0.0}),
        'ear_scratch': ('ear_scratch', 2.0, True, {'speed': 0.0}),
        'knead': ('knead', 2.0, True, {'speed': 0.0, 'contact': [0.25, 0.75, 1.25, 1.75]}),
        'chatter': ('chatter', 2.0, True, {'speed': 0.0}),
        'startle_hop': ('startle_hop', 1.2, False, {'speed': 0.0}),
        'crouch_alert': ('crouch_alert', 2.0, True, {'speed': 0.0}),
    })
