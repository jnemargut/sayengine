"""Scripted clips for a person on the humanoid deform skeleton: hands and feet by IK, the spine, neck
and head by FK. Blender frame: +X the person's left, -Y forward, +Z up. Clips are in place."""
import math
import mathutils
from anim import Poser, key_clip, env, smooth, FPS, EASE

V = mathutils.Vector
CHAINS = {
    'LL': ('LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', -1),      # knees forward
    'RL': ('RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes', -1),
    'LA': ('LeftUpperArm', 'LeftLowerArm', 'LeftHand', None, (0.35, 1.0, -0.2)),   # elbows back and out
    'RA': ('RightUpperArm', 'RightLowerArm', 'RightHand', None, (-0.35, 1.0, -0.2)),
}


def P(x, f, z):
    """Plan coords (x left, f forward, z up) to Blender."""
    return V((x, -f, z))


class PersonMotion:
    def __init__(self, poser, person):
        self.p = poser
        self.person = person
        t, h = poser.rest_tail, poser.rest_head
        self.ball = {'LL': t['LeftFoot'].copy(), 'RL': t['RightFoot'].copy()}
        self.foot_dir = {k: (t[c[2]] - h[c[2]]).normalized() for k, c in CHAINS.items() if k in ('LL', 'RL')}
        s = person.s
        self.s = s
        self.hip_z = h['Hips'].z
        self.toy = float(getattr(person, 'toy', 0.0))

    def body(self, spec, dz=0.0, dy=0.0, dx=0.0, pitch=0.0, roll=0.0, yaw=0.0):
        # the Hips bone points up: local X pitches (lean forward +), Y yaws (turn left +), Z rolls
        spec.setdefault('rot', {})['Hips'] = (pitch, yaw, roll)
        spec.setdefault('wloc', {})['Hips'] = (dx, -dy, dz)
        return spec

    def spine(self, spec, bend=0.0, twist=0.0, side=0.0):
        for n, w in (('Spine', 0.35), ('Chest', 0.35), ('UpperChest', 0.3)):
            spec['rot'][n] = (bend * w, twist * w, side * w)

    def head(self, spec, nod=0.0, turn=0.0, tilt=0.0):
        nod += 7.0                                   # carry the head a touch forward (the rest pose looks up)
        spec['rot']['Neck'] = (nod * 0.45, turn * 0.4, tilt * 0.4)
        spec['rot']['Head'] = (nod * 0.55, turn * 0.6, tilt * 0.6)

    def feet(self, spec, planted=True):
        legs = spec.setdefault('legs', {})
        for k in ('LL', 'RL'):
            legs[k] = {'paw': self.ball[k].copy(), 'met': self.foot_dir[k], 'toe': V((0, -1, -0.05))}

    def hands(self, spec, left, right, ldir=None, rdir=None):
        legs = spec.setdefault('legs', {})
        legs['LA'] = {'paw': left, 'met': (ldir or V((0.05, -0.15, -1))).normalized()}
        legs['RA'] = {'paw': right, 'met': (rdir or V((-0.05, -0.15, -1))).normalized()}

    def breathe(self, spec, t, rate=0.25, amt=1.0):
        b = 0.5 + 0.5 * math.sin(2 * math.pi * rate * t)
        spec.setdefault('scale', {})['Chest'] = (1 + 0.012 * amt * b, 1 + 0.008 * amt * b, 1 + 0.012 * amt * b)

    def side_hands(self, sway=0.0):
        s = self.s
        return P(0.205 * s, 0.02 * s + sway, 0.86 * s), P(-0.205 * s, 0.02 * s - sway, 0.86 * s)

    # ── clips ──────────────────────────────────────────────────────────────
    def idle(self, t):
        spec = {'rot': {}, 'loc': {}}
        w = math.sin(2 * math.pi * t / 4.0)
        k = self.toy
        self.body(spec, dx=0.012 * w * (1 + k), roll=1.2 * w * (1 + k), dz=-0.004 + 0.002 * w * w - 0.006 * k)
        self.spine(spec, bend=1.5 + 5 * k, side=-1.5 * w * (1 + k))          # a toy dad stands a little slumped
        self.head(spec, nod=2 + 2 * math.sin(2 * math.pi * t / 4.0 + 1) + 3 * k, turn=8 * math.sin(2 * math.pi * t / 4.0 - 0.6), tilt=1.5 * w * (1 + 2 * k))
        self.feet(spec)
        l, r = self.side_hands()
        self.hands(spec, l + V((0.006 * w, 0, 0)), r + V((0.006 * w, 0, 0)))
        self.breathe(spec, t, amt=1 + 1.5 * k)
        return spec

    def walk(self, t, period=1.1, speed=1.15, duty=0.62, lift=0.075):
        spec = {'rot': {}, 'loc': {}}
        s = self.s
        ph = (t / period) % 1.0
        stride = speed * duty * period
        ty = self.toy
        # a toy dad walks with a soft bounce: the hips dip on each step, the belly leads, the head bobs a beat late
        dz = -(0.018 + 0.014 * ty) * math.cos(4 * math.pi * ph) - 0.012 - 0.01 * ty
        dx = (0.016 + 0.012 * ty) * math.sin(2 * math.pi * ph)
        yaw = (5.0 + 3 * ty) * math.sin(2 * math.pi * ph)
        self.body(spec, dz=dz, dx=dx, yaw=yaw, roll=(2.5 + 2 * ty) * math.sin(2 * math.pi * ph), pitch=3 - 2 * ty)
        self.spine(spec, bend=1 + 5 * ty, twist=-yaw * 1.6, side=-2 * ty * math.sin(2 * math.pi * ph))
        self.head(spec, nod=-2 + 4 * ty * math.cos(4 * math.pi * (ph - 0.09)) + 2 * ty, turn=-yaw * 0.3, tilt=2.5 * ty * math.sin(2 * math.pi * (ph - 0.1)))
        legs = spec.setdefault('legs', {})
        for k, phase in (('LL', 0.0), ('RL', 0.5)):
            u = (ph - phase) % 1.0
            n = self.ball[k].copy()
            met = self.foot_dir[k].copy()
            if u < duty:
                sv = u / duty
                y = n.y - stride / 2 + stride * sv
                z = n.z
                # heel strike to toe-off: the foot rolls over the ball late in stance
                roll = max(0.0, (sv - 0.6) / 0.4)
                met = (met + V((0, 0, -0.9 * roll))).normalized()
                z += 0.0
            else:
                sv = (u - duty) / (1 - duty)
                m = speed * period * (1 - duty)
                h00, h10, h01, h11 = 2 * sv ** 3 - 3 * sv ** 2 + 1, sv ** 3 - 2 * sv ** 2 + sv, -2 * sv ** 3 + 3 * sv ** 2, sv ** 3 - sv ** 2
                y = h00 * (n.y + stride / 2) + h10 * m + h01 * (n.y - stride / 2) + h11 * m
                z = n.z + lift * math.sin(math.pi * sv) ** 1.3
                met = (met + V((0, 0, -0.9 * (1 - smooth(sv * 2)) + 0.25 * math.sin(math.pi * sv)))).normalized()
            legs[k] = {'paw': V((n.x, y, z)), 'met': met, 'toe': V((0, -1, -0.05))}
        # arms swing opposite the legs, a beat late
        sw = (0.17 + 0.07 * ty) * s * math.sin(2 * math.pi * (ph - 0.03 - 0.04 * ty))
        l, r = self.side_hands()
        self.hands(spec, l + V((0, sw, 0.02 * abs(sw) / 0.17)), r + V((0, -sw, 0.02 * abs(sw) / 0.17)))
        return spec

    def pick_up(self, t):
        # tidy: reach down for something by the right foot, then stand with it at the chest
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        k = env(t, [(0, 0), (0.5, 0.15), (1.15, 1.0), (1.45, 1.0), (2.2, 0.0), (2.8, 0.0)])
        self.body(spec, dz=-0.32 * s * k, dy=-0.1 * s * k, pitch=28 * k)
        self.spine(spec, bend=40 * k)
        self.head(spec, nod=-10 * k + 6 * (1 - k))
        self.feet(spec)
        grab = env(t, [(0, 0), (1.2, 0), (1.3, 1), (2.8, 1)])
        reach = P(-0.13 * s, 0.33 * s, 0.06 * s)
        chest = P(-0.1 * s, 0.24 * s, 1.08 * s)
        l, r = self.side_hands()
        rh = r.lerp(reach, smooth(min(1.0, t / 1.15))) if t < 1.3 else reach.lerp(chest, smooth((t - 1.3) / 1.0))
        lh = l.lerp(P(0.14 * s, 0.2 * s, 0.52 * s), k)            # the free hand braces on the knee
        self.hands(spec, lh, rh, None, V((-0.1, -0.6, -1)) if grab < 0.5 else V((0.3, -1, 0.2)))
        self.breathe(spec, t)
        return spec

    def look_around(self, t):
        # "huh?": a look left, a look right, a small shrug with the palms coming up
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        turn = env(t, [(0, 0), (0.35, 38), (0.8, 38), (1.15, -34), (1.6, -34), (2.1, 0), (2.6, 0)])
        shrug = env(t, [(0, 0), (1.6, 0), (1.85, 1), (2.25, 1), (2.6, 0)])
        self.body(spec, dz=-0.004)
        self.spine(spec, bend=-2 * shrug, twist=turn * 0.2)
        self.head(spec, turn=turn, tilt=8 * shrug, nod=-4 * shrug)
        spec['rot']['LeftShoulder'] = (0, 0, -9 * shrug); spec['rot']['RightShoulder'] = (0, 0, 9 * shrug)
        self.feet(spec)
        l, r = self.side_hands()
        lp, rp = P(0.3 * s, 0.22 * s, 1.0 * s), P(-0.3 * s, 0.22 * s, 1.0 * s)
        self.hands(spec, l.lerp(lp, shrug), r.lerp(rp, shrug), V((0.6, -1, 0.3 * shrug - 0.5 * (1 - shrug))), V((-0.6, -1, 0.3 * shrug - 0.5 * (1 - shrug))))
        self.breathe(spec, t)
        return spec

    def carry_cat(self, t):
        # cradling the cat across the chest: one forearm under the rump, the other across its chest
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        w = math.sin(2 * math.pi * t / 3.0)
        self.body(spec, pitch=-4, dx=0.006 * w)
        self.spine(spec, bend=-5)
        self.head(spec, nod=14, tilt=4 * w)
        self.feet(spec)
        self.hands(spec, P(-0.06 * s, 0.27 * s, 1.03 * s + 0.004 * w), P(0.1 * s, 0.25 * s, 1.17 * s), V((-1, -0.3, 0.1)), V((1, -0.4, -0.1)))
        self.breathe(spec, t, 1 / 3.0)
        return spec

    def reading(self, t):
        # a book held open at chest height, head down to it; a page turn
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        turn = env(t, [(0, 0), (2.3, 0), (2.6, 1), (2.9, 1), (3.3, 0), (4.0, 0)])
        self.body(spec, pitch=-2)
        self.spine(spec, bend=4)
        self.head(spec, nod=24, turn=-6 * turn)
        self.feet(spec)
        lb, rb = P(0.11 * s, 0.3 * s, 1.17 * s), P(-0.11 * s, 0.3 * s, 1.17 * s)
        rb = rb.lerp(P(0.05 * s, 0.32 * s, 1.22 * s), turn)
        self.hands(spec, lb, rb, V((-0.3, -1, 0.5)), V((0.3, -1, 0.5)))
        self.breathe(spec, t)
        return spec

    def phone_call(self, t):
        # the phone at the right ear, the left hand on the hip, a weight shift and a nod
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        w = math.sin(2 * math.pi * t / 4.0)
        nod = 4 * max(0.0, math.sin(2 * math.pi * t / 1.3)) * (t > 1.0)
        self.body(spec, dx=0.014 * w, roll=1.5 * w)
        self.spine(spec, side=-2)
        self.head(spec, tilt=-9, nod=nod, turn=6 * w)
        self.feet(spec)
        self.hands(spec, P(0.21 * s, 0.0, 1.0 * s), P(-0.085 * s, 0.075 * s, 1.63 * s), V((-0.6, 0.6, -0.5)), V((0.1, -0.2, 1)))
        self.breathe(spec, t)
        return spec

    def sit_desk(self, t):
        # sitting at a desk (seat 0.46 m, desk 0.74 m), typing
        s = self.s
        spec = {'rot': {}, 'loc': {}}
        seat = 0.52 * s
        self.body(spec, dz=seat - self.hip_z, dy=-0.04 * s, pitch=6)
        self.spine(spec, bend=4)
        self.head(spec, nod=10)
        legs = spec.setdefault('legs', {})
        for k, sx in (('LL', 1), ('RL', -1)):
            legs[k] = {'paw': P(0.12 * sx * s, 0.47 * s, 0.022), 'met': self.foot_dir[k], 'toe': V((0, -1, -0.05))}
        tap = lambda ph: 0.008 * s * max(0.0, math.sin(2 * math.pi * (t * 2.5 + ph)))
        self.hands(spec, P(0.15 * s, 0.4 * s, 0.77 * s + tap(0.0)), P(-0.15 * s, 0.4 * s, 0.77 * s + tap(0.5)), V((-0.1, -1, -0.35)), V((0.1, -1, -0.35)))
        self.breathe(spec, t)
        return spec


CLIPS = {
    'idle': ('idle', 4.0, True, {'speed': 0.0}),
    'walk': ('walk', 1.1, True, {'speed': 1.15}),
    'pick_up': ('pick_up', 2.8, False, {'speed': 0.0, 'contact': [1.25]}),
    'look_around': ('look_around', 2.6, False, {'speed': 0.0}),
    'carry_cat': ('carry_cat', 3.0, True, {'speed': 0.0, 'holdBone': 'Chest'}),
    'reading': ('reading', 4.0, True, {'speed': 0.0}),
    'phone_call': ('phone_call', 4.0, True, {'speed': 0.0}),
    'sit_desk': ('sit_desk', 4.0, True, {'speed': 0.0, 'seat': 0.46, 'desk': 0.74}),
}


def make_clips(arm, person, only=None):
    poser = Poser(arm, CHAINS)
    pm = PersonMotion(poser, person)
    toy = float(getattr(person, 'toy', 0.0))
    EASE['over'], EASE['antic'] = 0.1 * toy, 0.05 * toy       # a toy's moves overshoot and settle (anim.ease)
    acts = {}
    for name, (meth, secs, loop, extras) in CLIPS.items():
        if only and name not in only:
            continue
        frames = int(round(secs * FPS))
        ex = dict(extras, loop=loop, duration=secs)
        bones = [b.name for b in arm.data.bones if b.name.startswith(tuple(ex['partial'].split(',')))] if ex.get('partial') else None
        acts[name] = key_clip(arm, poser, name, frames, getattr(pm, meth), loop, ex, bones)
    EASE['over'] = EASE['antic'] = 0.0
    return acts, poser, pm


import anim_person_idles  # noqa: E402
anim_person_idles.install(PersonMotion, CLIPS)
