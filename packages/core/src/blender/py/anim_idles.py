"""Alive-at-rest clips for the cat: small layers (breath, weight shift, tail, ears, a head tilt, a sniff)
as partial clips a game can blend over any base; blinks by shape key (a quick blink, a half blink, the
slow "I love you" blink, sleepy eyes, the content squint, a third-eyelid flick); and idle actions
(grooming, a yawn, the two stretches, lying down to a loaf, a flop, an ear scratch, kneading, chattering
at a bird, a startle hop, an alert crouch). Cats are brisk: the actions are timed off real cats, only
the slow blink and the stretches' holds take their time. Uses the bat module's keyed bases."""
import math
import mathutils
from anim import env, smooth, mix_specs, LEGS  # noqa: F401

V = mathutils.Vector


def install(CatMotion, CLIPS):

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
        k = env(t, [(0, 0), (0.08, 1), (0.45, 1), (0.7, 0)])            # snaps round, holds, eases back
        sx = 1 if side == 'L' else -1
        spec['rot'][f'ear.{side}'] = (0, 55 * sx * k, -10 * sx * k)
        return spec

    # blinks (shape keys; the lid bones stay still) ------------------------
    # Cats blink rarely when alert (a quick blink every 8-15 s, staring in between) and more, and more
    # slowly, when relaxed. The game's blink scheduler picks these.
    def blink_quick(self, t):
        spec = self.idle(t)
        self.blink(spec, env(t, [(0, 0), (0.05, 1), (0.08, 1), (0.18, 0)]))     # shuts fast, opens a touch slower
        return spec

    def blink_half(self, t):
        spec = self.idle(t)
        self.blink(spec, env(t, [(0, 0), (0.05, 0.55), (0.07, 0.55), (0.16, 0)]))
        return spec

    def slow_blink(self, t):
        # the "I love you" blink: a soft squint, the lids slide shut over 0.7 s, held 0.4 s, open slowly;
        # the head dips a little as they close
        spec = self.idle(t)
        c = env(t, [(0, 0), (0.15, 0.1), (0.85, 1), (1.25, 1), (1.95, 0.1), (2.2, 0)])
        self.blink(spec, c)
        self.squint(spec, env(t, [(0, 0), (0.25, 0.4), (1.9, 0.4), (2.2, 0)]))
        dip = env(t, [(0, 0), (0.85, 1), (1.25, 1), (2.0, 0)])
        n0 = spec['rot']['spine.004']; h0 = spec['rot']['spine.006']
        spec['rot']['spine.004'] = (n0[0] - 4 * dip, n0[1], n0[2])
        spec['rot']['spine.006'] = (h0[0] - 7 * dip, h0[1], h0[2])
        return spec

    def sleepy_eyes(self, t):
        # half-lidded in a sunbeam: the lids drift heavy and lift, now and then a long droop
        spec = self.idle(t)
        d = 0.36 + 0.05 * math.sin(2 * math.pi * t / 4.0) + 0.32 * env(t, [(0, 0), (2.2, 0), (2.8, 1), (3.3, 1), (3.8, 0), (4.0, 0)])
        self.blink(spec, d)
        self.squint(spec, 0.2)
        return spec

    def squint_content(self, t):
        spec = self.idle(t)
        self.squint(spec, 0.7 + 0.06 * math.sin(2 * math.pi * t / 3.0))
        self.blink(spec, 0.05 + 0.03 * math.sin(2 * math.pi * t / 1.5))
        return spec

    def nictitate_flick(self, t):
        # the third eyelid flicks across from the inner corner and back
        spec = self.idle(t)
        spec.setdefault('shapes', {})
        spec['shapes']['nictitateL'] = spec['shapes']['nictitateR'] = env(t, [(0, 0), (0.08, 1), (0.12, 1), (0.32, 0)])
        return spec

    def head_tilt(self, t):
        spec = self.idle(t)
        k = env(t, [(0, 0), (0.18, 1), (0.95, 1), (1.3, 0)])
        spec['rot']['spine.006'] = (4 * k, 24 * k, 0)
        return spec

    def sniff(self, t):
        spec = self.idle(t)
        bob = 1.5 * math.sin(2 * math.pi * 7 * t) * env(t, [(0, 0), (0.12, 1), (0.8, 1), (1.0, 0)])
        k = env(t, [(0, 0), (0.15, 1), (0.8, 1), (1.0, 0)])
        spec['rot']['spine.004'] = (-8 * k, 0, 0); spec['rot']['spine.006'] = (6 * k + bob, 0, 0)
        spec['wloc']['spine'] = (0, -0.008 * k, 0)
        return spec

    # idle actions ----------------------------------------------------------
    def groom_paw_face(self, t):
        # paw licked and wiped over the face, three wipes in two seconds; the paw kept clear of the face
        u = (t / 0.6667) % 1.0
        wipe = math.sin(2 * math.pi * u)
        return ab_sit(self, t, [(0.0, {'RF': (0.0 + 0.01 * wipe, 0.05, 0.085 + 0.012 * wipe, 1.0), 'neck': -12, 'head': -16, 'headYaw': -14 + 9 * wipe, 'tilt': -14, 'blink': 0.6})])

    def lick_chest(self, t):
        lick = 5 * math.sin(2 * math.pi * 4.5 * t)
        return ab_sit(self, t, [(0.0, {'neck': -34, 'head': -30 + lick, 'blink': 0.55, 'tilt': 4})])

    def yawn(self, t):
        spec = S(self, t, [(0.0, {}), (0.35, {'neck': 14, 'head': 16, 'ears': 25, 'blink': 0.8, 'LF': (0, 0.03, 0, 0), 'RF': (0, 0.03, 0, 0)}),
                           (1.05, {'neck': 18, 'head': 20, 'ears': 28, 'blink': 0.9, 'LF': (0, 0.03, 0, 0), 'RF': (0, 0.03, 0, 0)}),
                           (1.6, {'neck': 0, 'head': 0, 'ears': 0, 'blink': 0.0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0)})])
        spec['rot']['jaw'] = (env(t, [(0, 0), (0.35, 28), (1.05, 30), (1.4, 0)]), 0, 0)
        return spec

    def stretch_front(self, t):
        # the downward cat: front legs far forward, chest low, rump and tail up
        return S(self, t, [(0.0, {}), (0.45, {'LF': (0, 0.11, 0, -0.2), 'RF': (0, 0.11, 0, -0.2), 'pitch': -12, 'dz': -0.03, 'dy': 0.02, 'neck': 6, 'head': 10, 'tail': 40, 'blink': 0.6, 'ears': 10}),
                           (1.35, {'LF': (0, 0.115, 0, -0.2), 'RF': (0, 0.115, 0, -0.2), 'pitch': -13, 'dz': -0.035, 'dy': 0.025, 'neck': 8, 'head': 10, 'tail': 45, 'blink': 0.7, 'ears': 10}),
                           (1.9, {'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'pitch': 0, 'dz': 0, 'dy': 0, 'neck': 0, 'head': 0, 'tail': -8, 'blink': 0, 'ears': 0})])

    def stretch_back(self, t):
        return S(self, t, [(0.0, {}), (0.4, {'LH': (0, -0.1, 0.01, 0.5), 'RH': (0, -0.05, 0, 0.2), 'pitch': 6, 'dy': 0.02, 'neck': 4, 'blink': 0.5}),
                           (1.15, {'LH': (0, -0.11, 0.015, 0.6), 'RH': (0, -0.05, 0, 0.2), 'pitch': 7, 'dy': 0.025, 'neck': 6, 'blink': 0.6}),
                           (1.7, {'LH': (0, 0, 0, 0), 'RH': (0, 0, 0, 0), 'pitch': 0, 'dy': 0, 'neck': 0, 'blink': 0})])

    def lie_to_loaf(self, t):
        k = env(t, [(0, 0), (0.2, 0.15), (0.9, 1.0), (1.2, 1.0)])
        return mix_specs(self.idle(t), self.loaf(t), k)

    def flop_side(self, t):
        # a fat cat's flop: a short lean, then down all at once with a little bounce
        k = env(t, [(0, 0), (0.3, 0.2), (0.6, 1.0), (1.3, 1.0)]) + 0.04 * math.exp(-8 * max(0.0, t - 0.6)) * math.sin(2 * math.pi * 5 * max(0.0, t - 0.6))
        spec = self.loaf(t)
        r = spec['rot']['spine']
        spec['rot']['spine'] = (r[0], r[1] + 78 * k, r[2])
        w = spec['wloc']['spine']
        drop = 0.06 * k
        spec['wloc']['spine'] = (w[0] - 0.08 * k, w[1], w[2] + 0.03 * k - drop * 0.2)
        spec['rot']['spine.006'] = (0, -40 * k, 0)
        return spec

    def ear_scratch(self, t):
        # a hind foot scratching behind the ear, fast (seven strokes a second)
        u = (t * 7.0) % 1.0
        sc = 0.012 * math.sin(2 * math.pi * u)
        return ab_sit(self, t, [(0.0, {'RH': (-0.075, 0.12, 0.09 + sc, 0.6), 'tilt': -30, 'headYaw': -22, 'neck': -14, 'neckYaw': -12, 'blink': 0.7, 'roll': -6, 'claws': 0, 'tail': -55, 'tailSway': 5})])

    def knead(self, t):
        u = (t / 0.7) % 1.0
        out = {}
        for leg, ph in (('LF', 0.0), ('RF', 0.5)):
            v = math.sin(2 * math.pi * (u - ph))
            out[leg] = (0, 0.02 * v, 0.012 * max(0.0, v), 0.4 * max(0.0, -v))
        spec = ab_lie(self, t, [(0.0, {'LF': out['LF'], 'RF': out['RF'], 'blink': 0.65, 'dz': 0.02})])
        # the claws flex out as each paw presses
        self.claws(spec, max(0.0, -math.sin(2 * math.pi * u)), max(0.0, -math.sin(2 * math.pi * (u - 0.5))))
        return spec

    def chatter(self, t):
        spec = S(self, t, [(0.0, {'dz': -0.02, 'neck': 18, 'head': 18, 'ears': -10, 'tail': -12, 'tailSway': 12, 'pitch': -4})])
        spec['rot']['jaw'] = (8 + 7 * math.sin(2 * math.pi * 9 * t), 0, 0)
        return spec

    def startle_hop(self, t):
        spec = S(self, t, [(0.0, {}), (0.06, {'dz': -0.015, 'ears': 30}), (0.18, {'dz': 0.09, 'pitch': 6, 'ears': 35, 'tail': 50, 'LF': (0, 0, 0.05, 0.6), 'RF': (0, 0, 0.05, 0.6), 'LH': (0, 0, 0.03, 0.4), 'RH': (0, 0, 0.03, 0.4)}),
                           (0.34, {'dz': -0.02, 'pitch': 0, 'ears': 30, 'tail': 40, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'LH': (0, 0, 0, 0), 'RH': (0, 0, 0, 0)}),
                           (0.75, {'dz': 0, 'ears': 0, 'tail': -8})])
        spec['rot']['spine.002'] = (env(t, [(0, 0), (0.18, -14), (0.38, -6), (0.75, 0)]), 0, 0)   # an arched back
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
               blink_quick=blink_quick, blink_half=blink_half, slow_blink=slow_blink, sleepy_eyes=sleepy_eyes, squint_content=squint_content,
               nictitate_flick=nictitate_flick, head_tilt=head_tilt, sniff=sniff, groom_paw_face=groom_paw_face, lick_chest=lick_chest, yawn=yawn,
               stretch_front=stretch_front, stretch_back=stretch_back, lie_to_loaf=lie_to_loaf, flop_side=flop_side, ear_scratch=ear_scratch,
               knead=knead, chatter=chatter, startle_hop=startle_hop, crouch_alert=crouch_alert)
    for n, f in fns.items():
        setattr(CatMotion, n, f)
    EYES = 'lid'         # blink clips key the (still) lid bones only; the lids move by their morph track
    CLIPS.update({
        'idle_breathe': ('idle_breathe', 4.0, True, {'speed': 0.0, 'partial': 'spine.001,spine.002,spine.003,belly'}),
        'idle_weight_shift': ('idle_weight_shift', 4.0, True, {'speed': 0.0}),
        'idle_tail_sway': ('idle_tail_sway', 3.0, True, {'speed': 0.0, 'partial': 'tail'}),
        'ear_swivel_L': ('ear_swivel_L', 0.7, False, {'speed': 0.0, 'partial': 'ear.L'}),
        'ear_swivel_R': ('ear_swivel_R', 0.7, False, {'speed': 0.0, 'partial': 'ear.R'}),
        'blink_quick': ('blink_quick', 0.18, False, {'speed': 0.0, 'partial': EYES}),
        'blink_half': ('blink_half', 0.16, False, {'speed': 0.0, 'partial': EYES}),
        'slow_blink': ('slow_blink', 2.2, False, {'speed': 0.0, 'partial': 'lid,spine.004,spine.006'}),
        'sleepy_eyes': ('sleepy_eyes', 4.0, True, {'speed': 0.0, 'partial': EYES}),
        'squint_content': ('squint_content', 3.0, True, {'speed': 0.0, 'partial': EYES}),
        'nictitate_flick': ('nictitate_flick', 0.32, False, {'speed': 0.0, 'partial': EYES}),
        'head_tilt': ('head_tilt', 1.3, False, {'speed': 0.0, 'partial': 'spine.006'}),
        'sniff': ('sniff', 1.0, False, {'speed': 0.0, 'partial': 'spine.004,spine.005,spine.006'}),
        'groom_paw_face': ('groom_paw_face', 2.0, True, {'speed': 0.0}),
        'lick_chest': ('lick_chest', 2.0, True, {'speed': 0.0}),
        'yawn': ('yawn', 1.6, False, {'speed': 0.0}),
        'stretch_front': ('stretch_front', 1.9, False, {'speed': 0.0}),
        'stretch_back': ('stretch_back', 1.7, False, {'speed': 0.0}),
        'lie_to_loaf': ('lie_to_loaf', 1.2, False, {'speed': 0.0}),
        'flop_side': ('flop_side', 1.3, False, {'speed': 0.0}),
        'ear_scratch': ('ear_scratch', 1.0, True, {'speed': 0.0}),
        'knead': ('knead', 1.4, True, {'speed': 0.0, 'contact': [0.175, 0.525, 0.875, 1.225]}),
        'chatter': ('chatter', 2.0, True, {'speed': 0.0}),
        'startle_hop': ('startle_hop', 0.75, False, {'speed': 0.0}),
        'crouch_alert': ('crouch_alert', 2.0, True, {'speed': 0.0}),
    })
