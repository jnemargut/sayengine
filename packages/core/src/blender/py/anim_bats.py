"""Bats, reactions and scratches for the cat: keyed poses on top of a stand, sit or lie base, with
anticipation, a fast hit, follow-through and a settle. Each clip records its contact times (the moment a
paw or the nose hits) in extras.contact, so a game can time the physics push.

Key channels: dz dy dx (body offset, m: up, forward, left), pitch roll yaw (body, deg), neck neckYaw
head headYaw tilt (deg), ears (flatten, deg), tail tailSway (deg), blink (0..1), and per leg
LF/RF/LH/RH = (x left, f forward, z up, flex) offsets of the paw from its base position; flex > 0
curls the paw back, < 0 tips it forward.
"""
import math
import mathutils
from anim import env, smooth, LEGS

V = mathutils.Vector
CH_LEG = ('x', 'f', 'z', 'flex')


def expand(keys):
    out = []
    for t, d in keys:
        e = {}
        for k, v in d.items():
            if k in LEGS:
                for c, x in zip(CH_LEG, v):
                    e[f'{k}.{c}'] = x
            else:
                e[k] = v
        out.append((t, e))
    return out


def kv(t, keys, ch, d=0.0):
    pts = [(kt, kd[ch]) for kt, kd in keys if ch in kd]
    if not pts:
        return d
    if pts[0][0] > 0:
        pts = [(0.0, d)] + pts
    return env(t, pts)


def install(CatMotion, CLIPS):
    def apply_common(self, spec, t, K, base_rot=None):
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        r = spec['rot']
        n0 = r.get('spine.004', (0, 0, 0)); h0 = r.get('spine.006', (0, 0, 0))
        r['spine.004'] = (n0[0] + g('neck'), n0[1], n0[2] + g('neckYaw'))
        r['spine.006'] = (h0[0] + g('head'), h0[1] + g('tilt'), h0[2] + g('headYaw'))
        e = g('ears')
        r['ear.L'] = (0, 0, -e); r['ear.R'] = (0, 0, e)
        tp = g('tail', -8.0) if any('tail' in kd for _, kd in K) else None
        if tp is not None:
            amp = g('tailSway')
            sw = [amp * (0.4 + 0.3 * i) * math.sin(2 * math.pi * (t * 1.0 - 0.12 * i)) for i in range(4)]   # 1 s period: every loop closes
            self.tail(spec, base_pitch=tp, sway=sw, droop=-6)
        b = g('blink')
        if b:
            self.blink(spec, b)
        return spec

    def leg_offsets(self, spec, t, K, bases):
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        for leg, base in bases.items():
            x, f, z, flex = (g(f'{leg}.{c}') for c in CH_LEG)
            if not (x or f or z or flex) and leg not in spec['legs']:
                continue
            paw = base['paw'] + V((x, -f, z))
            met = (base['met'] + V((0, 0.8 * flex, 0.25 * flex))).normalized()
            spec['legs'][leg] = dict(base, paw=paw, met=met)

    def stand_based(self, t, keys):
        K = expand(keys)
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        spec = {'rot': {}, 'loc': {}}
        self.body(spec, dz=g('dz'), dy=g('dy'), dx=g('dx'), pitch=g('pitch'), roll=g('roll'), yaw=g('yaw'))
        spec['legs'] = {}
        base = self.stand_legs()
        leg_offsets(self, spec, t, K, base)
        for k in base:
            spec['legs'].setdefault(k, base[k])
        self.breathe(spec, t, 0.5, 0.6)
        if not any('tail' in kd for _, kd in K):
            self.tail(spec, base_pitch=-8, sway=[0, 2, 4, 8 * math.sin(4 * t)], droop=-8)
        return apply_common(self, spec, t, K)

    def sit_based(self, t, keys):
        K = expand(keys)
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        spec = self.sit(t)
        r = spec['rot']['spine']
        spec['rot']['spine'] = (r[0] + g('pitch'), r[1] + g('roll'), r[2] + g('yaw'))
        w = spec['wloc']['spine']
        spec['wloc']['spine'] = (w[0] + g('dx'), w[1] - g('dy'), w[2] + g('dz'))
        base = {k: dict(v) for k, v in spec['legs'].items()}
        leg_offsets(self, spec, t, K, base)
        return apply_common(self, spec, t, K)

    def lie_based(self, t, keys):
        K = expand(keys)
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        spec = self.loaf(t)
        r = spec['rot'].get('spine', (0, 0, 0))
        spec['rot']['spine'] = (r[0] + g('pitch'), r[1] + g('roll'), r[2] + g('yaw'))
        w = spec['wloc']['spine']
        spec['wloc']['spine'] = (w[0] + g('dx'), w[1] - g('dy'), w[2] + g('dz'))
        # front legs stretched forward along the floor (the base the offsets move from)
        base = {k: dict(v) for k, v in spec['legs'].items()}
        for k in ('LF', 'RF'):
            p = self.paw_rest[k]
            base[k] = {'paw': V((p.x * 0.9, p.y - 0.09, 0.012)), 'met': V((0, -0.5, -1)).normalized(), 'pole': V((0, 1, 0.4))}
            spec['legs'][k] = base[k]
        leg_offsets(self, spec, t, K, base)
        return apply_common(self, spec, t, K)

    def up_based(self, t, keys, pitch=62.0, reach_z=0.36, reach_f=0.1):
        """Stretched up on the hind legs with the front paws on a vertical surface in front."""
        K = expand(keys)
        g = lambda ch, d=0.0: kv(t, K, ch, d)
        spec = {'rot': {}, 'loc': {}}
        self.body(spec, dz=g('dz', 0.0), dy=g('dy', 0.0), pitch=pitch + g('pitch'), roll=g('roll'), yaw=g('yaw'))
        spec['rot']['spine.001'] = (-6, 0, 0); spec['rot']['spine.002'] = (-6, 0, 0)
        legs = self.stand_legs()
        base = {}
        for k in ('LF', 'RF'):
            p = self.paw_rest[k]
            base[k] = {'paw': V((p.x * 0.9, p.y - reach_f, reach_z)), 'met': V((0, -0.3, -1)).normalized(), 'pole': V((0, 1, -0.6))}
        for k in ('LH', 'RH'):
            base[k] = dict(legs[k], paw=legs[k]['paw'] + V((0, -0.03, 0)))
        spec['legs'] = dict(base)
        leg_offsets(self, spec, t, K, base)
        spec['rot']['spine.004'] = (-pitch * 0.5, 0, 0); spec['rot']['spine.006'] = (-pitch * 0.3, 0, 0)
        self.breathe(spec, t, 0.5, 0.5)
        if not any('tail' in kd for _, kd in K):
            self.tail(spec, base_pitch=-pitch * 0.6, sway=[0, 3, 5, 10 * math.sin(2 * math.pi * t)], droop=-4)
        return apply_common(self, spec, t, K)

    # ── the bats ────────────────────────────────────────────────────────────
    def bat_test_tap(self, t):
        # curious: a long look with a head tilt, a slow lift, one careful tap, a check
        return stand_based(self, t, [
            (0.0, {}),
            (0.35, {'tilt': 16, 'neck': -10, 'head': 6, 'dz': -0.008, 'ears': -4}),
            (0.75, {'RF': (0.004, 0.035, 0.055, 0.8), 'tilt': 20, 'dz': -0.012, 'pitch': -3}),
            (0.95, {'RF': (0.004, 0.085, 0.0, 0.0), 'tilt': 12, 'neck': -14}),
            (1.15, {'RF': (0.004, 0.09, 0.002, -0.1), 'tilt': 18}),
            (1.45, {'RF': (0.0, 0.03, 0.03, 0.6), 'tilt': 22, 'head': 10}),
            (1.8, {'RF': (0, 0, 0, 0), 'tilt': 0, 'neck': 0, 'head': 0, 'dz': 0, 'pitch': 0, 'ears': 0}),
        ])

    def bat_tap_loop(self, t):
        # hold-to-tap: light pats, two per loop, the body settled low and the head following
        u = (t / 0.8) % 1.0
        zz = 0.032 * abs(math.sin(2 * math.pi * u))          # two pats a loop: down at 0 and half way
        ff = 0.06 + 0.01 * math.sin(4 * math.pi * u)
        return stand_based(self, t, [
            (0.0, {'RF': (0.004, ff, zz, 0.5 * zz / 0.032), 'neck': -12, 'tilt': 6, 'dz': -0.01, 'pitch': -3, 'ears': -3}),
        ])

    def bat_push_final(self, t):
        # the shove off the edge: a wind-up, a long committed push, then watching it go
        return stand_based(self, t, [
            (0.0, {}),
            (0.3, {'RF': (0.0, 0.05, 0.05, 0.7), 'dy': -0.012, 'dz': -0.01, 'pitch': -4, 'neck': -10, 'ears': 6}),
            (0.45, {'RF': (0.0, 0.07, 0.035, 0.4), 'dy': -0.016}),
            (0.58, {'RF': (0.0, 0.15, 0.03, -0.3), 'dy': 0.03, 'pitch': -6, 'neck': -6}),
            (0.9, {'RF': (0.0, 0.16, 0.03, -0.3), 'dy': 0.032, 'neck': -20, 'head': -8}),
            (1.15, {'RF': (0.0, 0.07, 0.02, 0.2), 'dy': 0.01, 'neck': -24, 'head': -12, 'tilt': 8}),
            (1.6, {'RF': (0, 0, 0, 0), 'dy': 0.0, 'dz': 0, 'pitch': 0, 'neck': 0, 'head': 0, 'tilt': 0, 'ears': 0}),
        ])

    def bat_backhand_swipe(self, t):
        # paw cocked across the chest, then a fast sideways backhand out to the right
        return stand_based(self, t, [
            (0.0, {}),
            (0.3, {'RF': (0.045, 0.03, 0.07, 0.9), 'roll': 4, 'yaw': 6, 'dz': -0.008, 'neckYaw': 8, 'ears': 8}),
            (0.4, {'RF': (0.05, 0.035, 0.075, 1.0), 'roll': 5, 'yaw': 8}),
            (0.5, {'RF': (-0.07, 0.08, 0.035, -0.2), 'roll': -6, 'yaw': -10, 'neckYaw': -12}),
            (0.6, {'RF': (-0.1, 0.06, 0.05, 0.3), 'roll': -7, 'yaw': -12, 'neckYaw': -16}),
            (1.0, {'RF': (0, 0, 0, 0), 'roll': 0, 'yaw': 0, 'dz': 0, 'neckYaw': 0, 'ears': 0}),
        ])

    def bat_double_smack(self, t):
        # rears up a little, both paws high, then both come down together
        return stand_based(self, t, [
            (0.0, {}),
            (0.25, {'dz': -0.015, 'pitch': -4, 'ears': 6}),
            (0.5, {'dz': 0.022, 'pitch': 15, 'dy': -0.015, 'LF': (0, 0.05, 0.1, 0.8), 'RF': (0, 0.05, 0.1, 0.8), 'neck': 6}),
            (0.62, {'dz': -0.018, 'pitch': -6, 'dy': 0.02, 'LF': (0, 0.1, 0.0, -0.1), 'RF': (0, 0.1, 0.0, -0.1), 'neck': -12, 'ears': 14}),
            (0.75, {'dz': -0.024, 'pitch': -7, 'dy': 0.022}),
            (1.3, {'dz': 0, 'pitch': 0, 'dy': 0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'neck': 0, 'ears': 0}),
        ])

    def bat_hook(self, t):
        # a long reach, the paw curls round the thing, and drags it back in
        return stand_based(self, t, [
            (0.0, {}),
            (0.45, {'RF': (-0.01, 0.16, 0.02, 0.2), 'dy': 0.025, 'pitch': -6, 'neck': -14, 'dz': -0.015}),
            (0.55, {'RF': (-0.01, 0.17, 0.0, 1.0), 'neck': -16}),
            (1.05, {'RF': (0.0, 0.03, 0.0, 1.0), 'dy': -0.01, 'neck': -20, 'pitch': -4}),
            (1.25, {'RF': (0.0, 0.03, 0.02, 0.3), 'neck': -22, 'tilt': 10}),
            (1.6, {'RF': (0, 0, 0, 0), 'dy': 0, 'pitch': 0, 'neck': 0, 'dz': 0, 'tilt': 0}),
        ])

    def bat_flick(self, t):
        # paw low behind the thing, a quick wrist flick up and forward
        return stand_based(self, t, [
            (0.0, {}),
            (0.25, {'RF': (0.0, 0.06, 0.008, 0.9), 'neck': -12, 'dz': -0.008}),
            (0.36, {'RF': (0.0, 0.11, 0.05, -0.7), 'neck': -2, 'head': 6}),
            (0.5, {'RF': (0.0, 0.1, 0.07, -0.5), 'head': 14, 'neck': 6}),
            (0.85, {'RF': (0, 0, 0, 0), 'neck': 0, 'head': 0, 'dz': 0}),
        ])

    def bat_flurry(self, t):
        # sitting up, rapid alternating bats at something dangling above the nose
        u = (t / 1.2) % 1.0
        def paw(c, sx):
            ph = (u * 3 - c) % 1.0
            up = math.sin(math.pi * ph) if ph < 1.0 else 0.0
            return (0.008 * sx, 0.03 + 0.03 * up, 0.04 + 0.05 * up, 0.7 - 0.9 * up)
        return sit_based(self, t, [
            (0.0, {'LF': paw(0.0, 1), 'RF': paw(0.5, -1), 'pitch': 6, 'neck': 14, 'head': 18, 'ears': -6}),
        ])

    def bat_belly_push(self, t):
        # flops onto it, rolls, then shoves it away with both front paws
        return lie_based(self, t, [
            (0.0, {'dz': 0.04}),
            (0.45, {'dz': 0.0, 'roll': 8}),
            (0.9, {'roll': 18, 'LF': (0.0, -0.03, 0.01, 0.4), 'RF': (0.0, -0.03, 0.01, 0.4)}),
            (1.25, {'roll': 14, 'LF': (0.0, 0.07, 0.02, -0.3), 'RF': (0.0, 0.07, 0.02, -0.3), 'dy': 0.02}),
            (1.5, {'roll': 10, 'LF': (0.0, 0.06, 0.02, 0.0), 'RF': (0.0, 0.06, 0.02, 0.0)}),
            (2.0, {'roll': 0, 'dy': 0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'dz': 0.0}),
        ])

    def bat_nose_push(self, t):
        # head down, a sniff, then the nose shoves it forward
        return stand_based(self, t, [
            (0.0, {}),
            (0.45, {'neck': -34, 'head': -10, 'dy': 0.012, 'dz': -0.01}),
            (0.6, {'neck': -38, 'head': -12, 'dy': 0.008}),
            (0.8, {'neck': -34, 'head': -16, 'dy': 0.05, 'pitch': -4}),
            (1.0, {'neck': -24, 'head': -6, 'dy': 0.03}),
            (1.4, {'neck': 0, 'head': 0, 'dy': 0, 'dz': 0, 'pitch': 0}),
        ])

    # ── reactions ───────────────────────────────────────────────────────────
    def react_innocent_sit(self, t):
        # sitting very still, looking away, a slow blink: nothing happened here
        bl = max(0.0, 1 - abs(t - 1.5) / 0.35)
        return sit_based(self, t, [
            (0.0, {'headYaw': 18, 'tilt': 6, 'blink': 0.0}),
            (1.0, {'headYaw': 22, 'tilt': 8}),
            (1.5, {'headYaw': 22, 'tilt': 8, 'blink': 0.9 * smooth(bl)}),
            (2.0, {'headYaw': 20, 'tilt': 7, 'blink': 0.0}),
            (3.0, {'headYaw': 18, 'tilt': 6, 'blink': 0.0}),
        ])

    def react_paw_lick(self, t):
        # sit, lift a paw to the mouth, lick it in quick strokes
        lick = 6 * math.sin(2 * math.pi * 3.0 * t) * smooth(min(1, t / 0.4)) * smooth(min(1, (2.4 - t) / 0.3))
        return sit_based(self, t, [
            (0.0, {'RF': (0.01, 0.06, 0.12, 1.1), 'neck': -16 + lick * 0.4, 'head': -22 + lick, 'tilt': -10, 'blink': 0.5}),
        ])

    def react_stare_down(self, t):
        # at the edge, watching it fall: the head follows it down, ears forward, the tail tip twitches
        return stand_based(self, t, [
            (0.0, {'neck': -10, 'head': -6}),
            (0.6, {'neck': -28, 'head': -20, 'dy': 0.012, 'ears': -6}),
            (1.2, {'neck': -36, 'head': -26, 'dy': 0.016, 'tilt': 8}),
            (2.4, {'neck': -36, 'head': -26, 'dy': 0.016, 'tilt': 10, 'tail': -12, 'tailSway': 10}),
        ])

    # ── scratching ──────────────────────────────────────────────────────────
    def _scratch_paws(self, t, rate=1.6, reach=0.07):
        u = (t * rate) % 1.0
        out = {}
        for leg, ph in (('LF', 0.0), ('RF', 0.5)):
            v = (u - ph) % 1.0
            pull = smooth(v / 0.55) if v < 0.55 else 1 - smooth((v - 0.55) / 0.45)
            out[leg] = (0, 0, -reach * pull, 0.9 * pull)
        return out

    def scratch_vertical(self, t):
        p = self._scratch_paws(t, 1.0, 0.08)
        return up_based(self, t, [(0.0, {'LF': p['LF'], 'RF': p['RF'], 'ears': -4, 'tail': -30, 'tailSway': 6})], pitch=66, reach_z=0.4, reach_f=0.1)

    def scratch_horizontal(self, t):
        u = (t * 1.0) % 1.0
        out = {}
        for leg, ph in (('LF', 0.0), ('RF', 0.5)):
            v = (u - ph) % 1.0
            pull = smooth(v / 0.55) if v < 0.55 else 1 - smooth((v - 0.55) / 0.45)
            out[leg] = (0, 0.03 - 0.07 * pull, 0.01 * (1 - pull), 0.8 * pull)
        return lie_based(self, t, [(0.0, {'LF': out['LF'], 'RF': out['RF'], 'neck': -8, 'ears': -6, 'dz': 0.01})])

    def scratch_on_scratcher(self, t):
        p = self._scratch_paws(t, 1.0, 0.06)
        return up_based(self, t, [(0.0, {'LF': p['LF'], 'RF': p['RF'], 'neck': 4, 'tail': -20, 'tailSway': 8})], pitch=40, reach_z=0.24, reach_f=0.12)

    # ── extras ──────────────────────────────────────────────────────────────
    def butt_wiggle(self, t):
        # the pre-pounce: chest low, rump up, the hips shifting side to side, tail tip twitching
        w = math.sin(2 * math.pi * t / 0.5)
        spec = stand_based(self, t, [(0.0, {'dz': -0.035, 'pitch': -10, 'neck': 8, 'head': 6, 'ears': -8,
                                             'LF': (0, 0.02, 0, 0.3), 'RF': (0, 0.02, 0, 0.3), 'tail': -14, 'tailSway': 4})])
        spec['rot']['spine.001'] = (0, 0, 4 * w)
        spec['rot']['spine'] = tuple(a + b for a, b in zip(spec['rot']['spine'], (0, 5 * w, -2 * w)))
        spec['wloc']['spine'] = (spec['wloc']['spine'][0] + 0.008 * w, spec['wloc']['spine'][1], spec['wloc']['spine'][2])
        return spec

    def tail_flick(self, t):
        spec = self.idle(t)
        f = math.sin(2 * math.pi * t / 0.8)
        self.tail(spec, base_pitch=-6, sway=[4 * f, 10 * f, 18 * math.sin(2 * math.pi * (t / 0.8 - 0.08)), 30 * math.sin(2 * math.pi * (t / 0.8 - 0.16))], droop=-8)
        return spec

    CatMotion._stand_k = stand_based
    CatMotion._sit_k = sit_based
    CatMotion._lie_k = lie_based
    for fn in (bat_test_tap, bat_tap_loop, bat_push_final, bat_backhand_swipe, bat_double_smack, bat_hook, bat_flick, bat_flurry,
               bat_belly_push, bat_nose_push, react_innocent_sit, react_paw_lick, react_stare_down, _scratch_paws, scratch_vertical,
               scratch_horizontal, scratch_on_scratcher, butt_wiggle, tail_flick):
        setattr(CatMotion, fn.__name__, fn)

    CLIPS.update({
        'bat_test_tap': ('bat_test_tap', 1.8, False, {'speed': 0.0, 'contact': [0.95]}),
        'bat_tap_loop': ('bat_tap_loop', 0.8, True, {'speed': 0.0, 'contact': [0.0, 0.4]}),
        'bat_push_final': ('bat_push_final', 1.6, False, {'speed': 0.0, 'contact': [0.5]}),
        'bat_backhand_swipe': ('bat_backhand_swipe', 1.0, False, {'speed': 0.0, 'contact': [0.47]}),
        'bat_double_smack': ('bat_double_smack', 1.3, False, {'speed': 0.0, 'contact': [0.62]}),
        'bat_hook': ('bat_hook', 1.6, False, {'speed': 0.0, 'contact': [0.55], 'drag': [0.55, 1.05]}),
        'bat_flick': ('bat_flick', 0.85, False, {'speed': 0.0, 'contact': [0.33]}),
        'bat_flurry': ('bat_flurry', 1.2, True, {'speed': 0.0, 'contact': [0.2, 0.4, 0.6, 0.8, 1.0, 0.0]}),
        'bat_belly_push': ('bat_belly_push', 2.0, False, {'speed': 0.0, 'contact': [0.45, 1.2]}),
        'bat_nose_push': ('bat_nose_push', 1.4, False, {'speed': 0.0, 'contact': [0.75]}),
        'react_innocent_sit': ('react_innocent_sit', 3.0, True, {'speed': 0.0}),
        'react_paw_lick': ('react_paw_lick', 2.4, True, {'speed': 0.0}),
        'react_stare_down': ('react_stare_down', 2.4, False, {'speed': 0.0}),
        'scratch_vertical': ('scratch_vertical', 2.0, True, {'speed': 0.0, 'contact': [0.0, 0.5, 1.0, 1.5]}),
        'scratch_horizontal': ('scratch_horizontal', 2.0, True, {'speed': 0.0, 'contact': [0.0, 0.5, 1.0, 1.5]}),
        'scratch_on_scratcher': ('scratch_on_scratcher', 2.0, True, {'speed': 0.0, 'contact': [0.0, 0.5, 1.0, 1.5]}),
        'butt_wiggle': ('butt_wiggle', 2.0, True, {'speed': 0.0}),
        'tail_flick': ('tail_flick', 0.8, True, {'speed': 0.0, 'partial': 'tail'}),
    })
