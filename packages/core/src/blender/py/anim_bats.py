"""Bats, reactions and scratches for the cat: keyed poses on top of a stand, sit or lie base. A bat hits
within 0.07-0.12 s and settles; its anticipation is a separate `<bat>_windup` loop. Each clip records its
contact times (the moment a paw or the nose hits, or each rake of a scratch) in extras.contact, so a game
can time the physics push or tear the surface.

Key channels: dz dy dx (body offset, m: up, forward, left), pitch roll yaw (body, deg), neck neckYaw
head headYaw tilt (deg), ears (flatten, deg), tail tailSway tailPeriod (deg, s), blink squint claws
(0..1), and per leg
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
            per = g('tailPeriod', 1.0)       # loops set it to their own length (or a fraction of it) so they close
            sw = [amp * (0.4 + 0.3 * i) * math.sin(2 * math.pi * (t / per - 0.12 * i)) for i in range(4)]
            self.tail(spec, base_pitch=tp, sway=sw, droop=-6)
        b = g('blink')
        if b:
            self.blink(spec, b)
        sq = g('squint')
        if sq:
            self.squint(spec, sq)
        c = g('claws')
        if c:
            self.claws(spec, c)
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
            per = kv(t, K, 'tailPeriod', 1.0)
            self.tail(spec, base_pitch=-8, sway=[0, 2, 4, 8 * math.sin(2 * math.pi * t / per)], droop=-8)
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
        # standing up: the hind feet planted right under the hips, hocks near upright, knees forward
        _, W = self.p.solve(self._copy(spec))
        for k in ('LH', 'RH'):
            hip = W[LEGS[k][0]].translation
            p = self.paw_rest[k]
            base[k] = {'paw': V((p.x, hip.y + 0.01, p.z)), 'met': V((0, 0.25, -1)).normalized(), 'pole': V((0, -1, 0)), 'toe': V((0, -1, -0.15))}
        spec['legs'] = dict(base)
        leg_offsets(self, spec, t, K, base)
        spec['rot']['spine.004'] = (-pitch * 0.5, 0, 0); spec['rot']['spine.006'] = (-pitch * 0.3, 0, 0)
        self.breathe(spec, t, 0.5, 0.5)
        if not any('tail' in kd for _, kd in K):
            self.tail(spec, base_pitch=-pitch * 0.6, sway=[0, 3, 5, 10 * math.sin(2 * math.pi * t)], droop=-4)
        return apply_common(self, spec, t, K)

    # ── the bats ────────────────────────────────────────────────────────────
    # A key press must feel instant: every bat makes contact by 0.07-0.12 s (2-4 frames) from a plain
    # stand, then a short recovery. The anticipation (the long look, the cocked paw, the rear-up) lives
    # in a separate `<bat>_windup` loop the game plays only while the key is held; it crossfades from the
    # windup into the bat on release.
    def bat_test_tap(self, t):
        return stand_based(self, t, [
            (0.0, {}),
            (0.067, {'RF': (0.004, 0.06, 0.035, 0.35), 'tilt': 8, 'neck': -6, 'dz': -0.006}),
            (0.1, {'RF': (0.004, 0.085, 0.0, 0.0), 'tilt': 14, 'neck': -12, 'dz': -0.01, 'pitch': -2}),
            (0.22, {'RF': (0.004, 0.088, 0.002, -0.1), 'tilt': 16, 'neck': -13}),
            (0.36, {'RF': (0.0, 0.03, 0.03, 0.6), 'tilt': 18, 'head': 8, 'neck': -8}),
            (0.6, {'RF': (0, 0, 0, 0), 'tilt': 0, 'neck': 0, 'head': 0, 'dz': 0, 'pitch': 0}),
        ])

    def bat_test_tap_windup(self, t):
        # curious: a head tilt, the paw hovering, tiny hesitant dips
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'RF': (0.004, 0.04, 0.05 + 0.006 * h, 0.75), 'tilt': 18 + 3 * h, 'neck': -10, 'head': 6, 'dz': -0.01, 'pitch': -3, 'ears': -4})])

    def bat_tap_loop(self, t):
        # hold-to-tap: quick light pats, about three a second, the body settled low and the head following
        u = (t / 0.6) % 1.0
        zz = 0.03 * abs(math.sin(2 * math.pi * u))          # two pats a loop: down at 0 and half way
        ff = 0.06 + 0.01 * math.sin(4 * math.pi * u)
        return stand_based(self, t, [
            (0.0, {'RF': (0.004, ff, zz, 0.5 * zz / 0.03), 'neck': -12 + 2 * zz / 0.03, 'tilt': 6, 'dz': -0.01, 'pitch': -3, 'ears': -3, 'tailPeriod': 0.6}),
        ])

    def bat_push_final(self, t):
        # the shove off the edge: the paw is on it at 0.1 s and keeps pushing through, then a look down
        return stand_based(self, t, [
            (0.0, {}),
            (0.067, {'RF': (0.0, 0.08, 0.035, 0.25), 'dy': 0.006, 'dz': -0.006}),
            (0.1, {'RF': (0.0, 0.11, 0.03, -0.1), 'dy': 0.014, 'pitch': -4, 'neck': -8}),
            (0.28, {'RF': (0.0, 0.16, 0.03, -0.3), 'dy': 0.032, 'pitch': -6, 'neck': -14}),
            (0.45, {'RF': (0.0, 0.12, 0.025, 0.1), 'dy': 0.02, 'neck': -22, 'head': -10, 'tilt': 6}),
            (0.8, {'RF': (0, 0, 0, 0), 'dy': 0.0, 'dz': 0, 'pitch': 0, 'neck': 0, 'head': 0, 'tilt': 0}),
        ])

    def bat_push_final_windup(self, t):
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'RF': (0.0, 0.05, 0.05 + 0.004 * h, 0.7), 'dy': -0.012, 'dz': -0.01, 'pitch': -4, 'neck': -10, 'ears': 6, 'tail': -12, 'tailSway': 8})])

    def bat_backhand_swipe(self, t):
        # the paw flips out across the chest and sweeps out sideways: contact at 0.1 s, claws out
        return stand_based(self, t, [
            (0.0, {}),
            (0.05, {'RF': (0.01, 0.05, 0.045, 0.3), 'roll': 2, 'yaw': 2, 'dz': -0.006, 'neckYaw': 2, 'claws': 1}),
            (0.1, {'RF': (-0.055, 0.075, 0.04, -0.1), 'roll': -6, 'yaw': -10, 'neckYaw': -12, 'claws': 1}),
            (0.17, {'RF': (-0.1, 0.06, 0.05, 0.3), 'roll': -7, 'yaw': -12, 'neckYaw': -16}),
            (0.3, {'claws': 0}),
            (0.5, {'RF': (0, 0, 0, 0), 'roll': 0, 'yaw': 0, 'dz': 0, 'neckYaw': 0}),
        ])

    def bat_backhand_swipe_windup(self, t):
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'RF': (0.045 + 0.003 * h, 0.03, 0.07, 0.9), 'roll': 4, 'yaw': 6, 'dz': -0.008, 'neckYaw': 8, 'ears': 8, 'claws': 1})])

    def bat_double_smack(self, t):
        # both paws hop up and come down together on it at 0.12 s
        return stand_based(self, t, [
            (0.0, {}),
            (0.06, {'dz': 0.01, 'pitch': 8, 'dy': -0.006, 'LF': (0, 0.04, 0.06, 0.8), 'RF': (0, 0.04, 0.06, 0.8), 'neck': 4, 'ears': 6}),
            (0.12, {'dz': -0.018, 'pitch': -6, 'dy': 0.02, 'LF': (0, 0.1, 0.0, -0.1), 'RF': (0, 0.1, 0.0, -0.1), 'neck': -12, 'ears': 14}),
            (0.2, {'dz': -0.024, 'pitch': -7, 'dy': 0.022}),
            (0.55, {'dz': 0, 'pitch': 0, 'dy': 0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0), 'neck': 0, 'ears': 0}),
        ])

    def bat_double_smack_windup(self, t):
        # reared up, both paws high, swaying a little before the smack
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'dz': 0.02, 'pitch': 14 + 1.5 * h, 'dy': -0.014, 'LF': (0, 0.05, 0.1, 0.8), 'RF': (0, 0.05, 0.1, 0.8), 'neck': 6, 'ears': 6})])

    def bat_hook(self, t):
        # a long reach that is on it at 0.1 s, the claws hook round it and drag it back in
        return stand_based(self, t, [
            (0.0, {}),
            (0.067, {'RF': (-0.01, 0.1, 0.04, 0.25), 'dy': 0.012, 'pitch': -4, 'neck': -10, 'claws': 1}),
            (0.1, {'RF': (-0.01, 0.13, 0.02, 0.2), 'dy': 0.025, 'pitch': -6, 'neck': -14, 'dz': -0.015, 'claws': 1}),
            (0.15, {'RF': (-0.01, 0.15, 0.0, 1.0), 'neck': -16}),
            (0.45, {'RF': (0.0, 0.03, 0.0, 1.0), 'dy': -0.01, 'neck': -20, 'pitch': -4, 'claws': 1}),
            (0.55, {'RF': (0.0, 0.03, 0.02, 0.3), 'neck': -22, 'tilt': 10, 'claws': 0}),
            (0.8, {'RF': (0, 0, 0, 0), 'dy': 0, 'pitch': 0, 'neck': 0, 'dz': 0, 'tilt': 0}),
        ])

    def bat_hook_windup(self, t):
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'RF': (-0.005, 0.07 + 0.006 * h, 0.04, 0.5), 'dy': 0.012, 'pitch': -4, 'neck': -12, 'dz': -0.01, 'ears': -4})])

    def bat_flick(self, t):
        # paw scoops under it (contact at 0.07 s) and flicks it up and forward
        return stand_based(self, t, [
            (0.0, {}),
            (0.067, {'RF': (0.0, 0.07, 0.012, 0.5), 'neck': -10, 'dz': -0.006}),
            (0.13, {'RF': (0.0, 0.11, 0.055, -0.7), 'neck': -2, 'head': 6}),
            (0.22, {'RF': (0.0, 0.1, 0.07, -0.5), 'head': 12, 'neck': 6}),
            (0.45, {'RF': (0, 0, 0, 0), 'neck': 0, 'head': 0, 'dz': 0}),
        ])

    def bat_flick_windup(self, t):
        h = math.sin(2 * math.pi * t / 0.5)
        return stand_based(self, t, [(0.0, {'RF': (0.0, 0.055, 0.01 + 0.004 * h, 0.9), 'neck': -12, 'dz': -0.008, 'tilt': 6})])

    def bat_flurry(self, t):
        # sitting up, rapid alternating bats at something dangling above the nose: four a second
        u = (t / 0.5) % 1.0
        def paw(c, sx):
            ph = (u - c) % 1.0
            up = math.sin(math.pi * ph) ** 2
            return (0.008 * sx, 0.03 + 0.03 * up, 0.04 + 0.05 * up, 0.7 - 0.9 * up)
        return sit_based(self, t, [
            (0.0, {'LF': paw(0.5, 1), 'RF': paw(0.0, -1), 'pitch': 6, 'neck': 14, 'head': 18, 'ears': -6, 'claws': 0.6}),
        ])

    def bat_belly_push(self, t):
        # lying on it already (the flop is the windup): both paws shove it away at 0.12 s
        return lie_based(self, t, [
            (0.0, {'roll': 10}),
            (0.06, {'roll': 14, 'LF': (0.0, -0.03, 0.012, 0.4), 'RF': (0.0, -0.03, 0.012, 0.4)}),
            (0.12, {'roll': 14, 'LF': (0.0, 0.07, 0.02, -0.3), 'RF': (0.0, 0.07, 0.02, -0.3), 'dy': 0.02}),
            (0.25, {'roll': 10, 'LF': (0.0, 0.06, 0.02, 0.0), 'RF': (0.0, 0.06, 0.02, 0.0)}),
            (0.55, {'roll': 0, 'dy': 0, 'LF': (0, 0, 0, 0), 'RF': (0, 0, 0, 0)}),
        ])

    def bat_belly_push_windup(self, t):
        h = math.sin(2 * math.pi * t / 0.5)
        return lie_based(self, t, [(0.0, {'roll': 6 + 2 * h, 'LF': (0.0, -0.03, 0.012, 0.4), 'RF': (0.0, -0.03, 0.012, 0.4), 'ears': -6})])

    def bat_nose_push(self, t):
        # a quick boop: the nose is on it at 0.12 s and shoves it on
        return stand_based(self, t, [
            (0.0, {}),
            (0.12, {'neck': -34, 'head': -14, 'dy': 0.03, 'dz': -0.01, 'pitch': -3}),
            (0.26, {'neck': -30, 'head': -16, 'dy': 0.05, 'pitch': -4}),
            (0.55, {'neck': 0, 'head': 0, 'dy': 0, 'dz': 0, 'pitch': 0}),
        ])

    def bat_nose_push_windup(self, t):
        # head down, sniffing it over
        s = 2 * math.sin(2 * math.pi * 6 * t)
        return stand_based(self, t, [(0.0, {'neck': -34, 'head': -10 + s, 'dy': 0.012, 'dz': -0.01})])

    # ── reactions ───────────────────────────────────────────────────────────
    def react_innocent_sit(self, t):
        # sitting very still, looking away, a slow blink: nothing happened here
        bl = max(0.0, 1 - abs(t - 1.5) / 0.35)
        return sit_based(self, t, [
            (0.0, {'headYaw': 18, 'tilt': 6, 'blink': 0.0, 'squint': 0.2}),
            (1.0, {'headYaw': 22, 'tilt': 8}),
            (1.5, {'headYaw': 22, 'tilt': 8, 'blink': 0.95 * smooth(bl)}),
            (2.0, {'headYaw': 20, 'tilt': 7, 'blink': 0.0}),
            (3.0, {'headYaw': 18, 'tilt': 6, 'blink': 0.0}),
        ])

    def react_paw_lick(self, t):
        # sit, the paw at the mouth, quick licks (four a second)
        lick = 6 * math.sin(2 * math.pi * 4.0 * t)
        return sit_based(self, t, [
            (0.0, {'RF': (0.01, 0.06, 0.12, 1.1), 'neck': -16 + lick * 0.4, 'head': -22 + lick, 'tilt': -10, 'blink': 0.5}),
        ])

    def react_stare_down(self, t):
        # at the edge, watching it fall: the head follows it down, ears forward, the tail tip twitches
        return stand_based(self, t, [
            (0.0, {'neck': -10, 'head': -6}),
            (0.3, {'neck': -28, 'head': -20, 'dy': 0.012, 'ears': -6}),
            (0.7, {'neck': -36, 'head': -26, 'dy': 0.016, 'tilt': 8}),
            (1.6, {'neck': -36, 'head': -26, 'dy': 0.016, 'tilt': 10, 'tail': -12, 'tailSway': 10}),
        ])

    # ── scratching ──────────────────────────────────────────────────────────
    # Vigorous: alternating rakes, four a second (two per paw), claws out the whole time. A rake is a
    # fast pull (the contact, 40% of a paw's cycle) and a quicker reach back. The shoulders pump with
    # each pull, the body leans into the surface and rocks with the paws, the hind feet knead.
    RAKE = 2.0                 # rakes per second per paw
    RAKE_PULL = 0.4            # the part of a paw's cycle that is in contact

    def _rake(self, t, ph):
        u = (t * RAKE + ph) % 1.0
        if u < RAKE_PULL:
            s = u / RAKE_PULL
            return s * s * (3 - 2 * s), True
        s = (u - RAKE_PULL) / (1 - RAKE_PULL)
        return 1 - s * s * (3 - 2 * s), False

    def _rakes(self, t):
        return {'LF': _rake(self, t, 0.0), 'RF': _rake(self, t, 0.5)}

    def _scratch_body(self, spec, t, lean=1.0):
        """Shoulders pump with each pull, the body rocks toward the pulling paw, the hind feet knead."""
        r = _rakes(self, t)
        for leg, s in (('LF', 'L'), ('RF', 'R')):
            p, _ = r[leg]
            spec['rot'][f'shoulder.{s}'] = (-10 * p * lean, 0, 0)
        diff = r['LF'][0] - r['RF'][0]
        sp = spec['rot'].get('spine', (0, 0, 0))
        spec['rot']['spine'] = (sp[0], sp[1] + 3.5 * diff * lean, sp[2] + 2.0 * diff * lean)
        s3 = spec['rot'].get('spine.003', (0, 0, 0))
        spec['rot']['spine.003'] = (s3[0], s3[1] - 3 * diff * lean, s3[2])
        w = spec['wloc']['spine']
        spec['wloc']['spine'] = (w[0] + 0.004 * diff * lean, w[1], w[2] - 0.004 * abs(diff) * lean)
        # hind feet tread in turn, out of step with the front
        for leg, ph in (('LH', 0.25), ('RH', 0.75)):
            lg = spec['legs'].get(leg)
            if lg:
                k = max(0.0, math.sin(2 * math.pi * (t * RAKE + ph)))
                spec['legs'][leg] = dict(lg, paw=lg['paw'] + V((0, 0, 0.008 * k)))
        self.claws(spec, 1.0)
        return spec

    def scratch_vertical(self, t):
        r = _rakes(self, t)
        keys = {leg: (0, 0.0 if c else -0.02 * math.sin(math.pi * p), -0.11 * p, 0.2 + 0.9 * p) for leg, (p, c) in r.items()}
        spec = up_based(self, t, [(0.0, {'LF': keys['LF'], 'RF': keys['RF'], 'ears': -6, 'tail': 35, 'tailSway': 8, 'neck': -4, 'squint': 0.5})],
                        pitch=66, reach_z=0.4, reach_f=0.11)
        return _scratch_body(self, spec, t)

    def scratch_on_scratcher(self, t):
        r = _rakes(self, t)
        keys = {leg: (0, 0.06 * (1 - p) - 0.02 - (0.0 if c else 0.015 * math.sin(math.pi * p)), -0.06 * p, 0.2 + 0.8 * p) for leg, (p, c) in r.items()}
        spec = up_based(self, t, [(0.0, {'LF': keys['LF'], 'RF': keys['RF'], 'neck': 2, 'tail': 12, 'tailSway': 8, 'squint': 0.4})],
                        pitch=40, reach_z=0.24, reach_f=0.12)
        return _scratch_body(self, spec, t)

    def _floor_scratch(self, t, reach, sink, lean):
        """Scratching a flat surface: front legs stretched far forward, rump up, pulling back alternately."""
        r = _rakes(self, t)
        legs = {}
        for leg, (p, c) in r.items():
            # paws reach far forward and pull back along (or into) the surface; lift on the way back
            f = 0.13 - reach * p
            z = -sink * math.sin(math.pi * p) if c else 0.022 * math.sin(math.pi * p)
            legs[leg] = (0, f, z, 0.1 + 0.4 * p)
        spec = stand_based(self, t, [(0.0, {'LF': legs['LF'], 'RF': legs['RF'], 'pitch': -10 * lean, 'dz': -0.03 * lean, 'dy': 0.03 * lean,
                                            'neck': 6, 'head': 6, 'ears': -8, 'tail': 30, 'tailSway': 6, 'squint': 0.5})])
        return _scratch_body(self, spec, t, lean)

    def scratch_horizontal(self, t):
        return _floor_scratch(self, t, reach=0.09, sink=0.0, lean=1.0)

    def scratch_bed(self, t):
        # on a soft bed or blanket: the paws sink in as they pull, bigger rakes, the whole body digs in
        return _floor_scratch(self, t, reach=0.105, sink=0.008, lean=1.0)

    # ── extras ──────────────────────────────────────────────────────────────
    def butt_wiggle(self, t):
        # the pre-pounce: chest low, rump up, the hips shifting side to side fast, tail tip twitching
        w = math.sin(2 * math.pi * t / 0.3)
        spec = stand_based(self, t, [(0.0, {'dz': -0.035, 'pitch': -10, 'neck': 8, 'head': 6, 'ears': -8,
                                             'LF': (0, 0.02, 0, 0.3), 'RF': (0, 0.02, 0, 0.3), 'tail': -14, 'tailSway': 4, 'tailPeriod': 0.6})])
        spec['rot']['spine.001'] = (0, 0, 4 * w)
        spec['rot']['spine'] = tuple(a + b for a, b in zip(spec['rot']['spine'], (0, 5 * w, -2 * w)))
        spec['wloc']['spine'] = (spec['wloc']['spine'][0] + 0.008 * w, spec['wloc']['spine'][1], spec['wloc']['spine'][2])
        return spec

    def tail_flick(self, t):
        spec = self.idle(t)
        f = math.sin(2 * math.pi * t / 0.8)
        self.tail(spec, base_pitch=-6, sway=[4 * f, 10 * f, 18 * math.sin(2 * math.pi * (t / 0.8 - 0.08)), 30 * math.sin(2 * math.pi * (t / 0.8 - 0.16))], droop=-8)
        return spec

    RAKE_TIMES = sorted([(k / RAKE + (0.0 if leg == 'LF' else 0.5 / RAKE), leg) for leg in ('LF', 'RF') for k in range(int(RAKE))])

    def rake_extras():
        return {'contact': [round(a, 4) for a, _ in RAKE_TIMES], 'rakeEnd': [round(a + RAKE_PULL / RAKE, 4) for a, _ in RAKE_TIMES],
                'rakePaws': ','.join(l for _, l in RAKE_TIMES)}

    CatMotion._stand_k = stand_based
    CatMotion._sit_k = sit_based
    CatMotion._lie_k = lie_based
    fns = [bat_test_tap, bat_tap_loop, bat_push_final, bat_backhand_swipe, bat_double_smack, bat_hook, bat_flick, bat_flurry,
           bat_belly_push, bat_nose_push, react_innocent_sit, react_paw_lick, react_stare_down, scratch_vertical,
           scratch_horizontal, scratch_on_scratcher, scratch_bed, butt_wiggle, tail_flick,
           bat_test_tap_windup, bat_push_final_windup, bat_backhand_swipe_windup, bat_double_smack_windup, bat_hook_windup,
           bat_flick_windup, bat_belly_push_windup, bat_nose_push_windup]
    for fn in fns:
        setattr(CatMotion, fn.__name__, fn)

    W = {'speed': 0.0, 'hold': True}
    CLIPS.update({
        'bat_test_tap': ('bat_test_tap', 0.6, False, {'speed': 0.0, 'contact': [0.1]}),
        'bat_test_tap_windup': ('bat_test_tap_windup', 1.0, True, dict(W, windupFor='bat_test_tap')),
        'bat_tap_loop': ('bat_tap_loop', 0.6, True, {'speed': 0.0, 'contact': [0.0, 0.3]}),
        'bat_push_final': ('bat_push_final', 0.8, False, {'speed': 0.0, 'contact': [0.1], 'drag': [0.1, 0.28]}),
        'bat_push_final_windup': ('bat_push_final_windup', 1.0, True, dict(W, windupFor='bat_push_final')),
        'bat_backhand_swipe': ('bat_backhand_swipe', 0.5, False, {'speed': 0.0, 'contact': [0.1]}),
        'bat_backhand_swipe_windup': ('bat_backhand_swipe_windup', 1.0, True, dict(W, windupFor='bat_backhand_swipe')),
        'bat_double_smack': ('bat_double_smack', 0.55, False, {'speed': 0.0, 'contact': [0.12]}),
        'bat_double_smack_windup': ('bat_double_smack_windup', 1.0, True, dict(W, windupFor='bat_double_smack')),
        'bat_hook': ('bat_hook', 0.8, False, {'speed': 0.0, 'contact': [0.1], 'drag': [0.15, 0.45]}),
        'bat_hook_windup': ('bat_hook_windup', 1.0, True, dict(W, windupFor='bat_hook')),
        'bat_flick': ('bat_flick', 0.45, False, {'speed': 0.0, 'contact': [0.067]}),
        'bat_flick_windup': ('bat_flick_windup', 1.0, True, dict(W, windupFor='bat_flick')),
        'bat_flurry': ('bat_flurry', 0.5, True, {'speed': 0.0, 'contact': [0.0, 0.25]}),
        'bat_belly_push': ('bat_belly_push', 0.55, False, {'speed': 0.0, 'contact': [0.12]}),
        'bat_belly_push_windup': ('bat_belly_push_windup', 1.0, True, dict(W, windupFor='bat_belly_push')),
        'bat_nose_push': ('bat_nose_push', 0.55, False, {'speed': 0.0, 'contact': [0.12]}),
        'bat_nose_push_windup': ('bat_nose_push_windup', 1.0, True, dict(W, windupFor='bat_nose_push')),
        'react_innocent_sit': ('react_innocent_sit', 3.0, True, {'speed': 0.0}),
        'react_paw_lick': ('react_paw_lick', 1.5, True, {'speed': 0.0}),
        'react_stare_down': ('react_stare_down', 1.6, False, {'speed': 0.0}),
        'scratch_vertical': ('scratch_vertical', 1.0, True, dict(speed=0.0, **rake_extras())),
        'scratch_horizontal': ('scratch_horizontal', 1.0, True, dict(speed=0.0, **rake_extras())),
        'scratch_bed': ('scratch_bed', 1.0, True, dict(speed=0.0, soft=True, **rake_extras())),
        'scratch_on_scratcher': ('scratch_on_scratcher', 1.0, True, dict(speed=0.0, **rake_extras())),
        'butt_wiggle': ('butt_wiggle', 1.2, True, {'speed': 0.0}),
        'tail_flick': ('tail_flick', 0.8, True, {'speed': 0.0, 'partial': 'tail'}),
    })
