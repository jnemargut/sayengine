"""Scripted clips on the deform skeleton: a small FK + analytic leg IK poser, and quadruped clips built
from real cat motion (lateral-sequence walk with direct register, diagonal trot, sit, loaf, jump...).

Blender frame: +X the cat's left, -Y forward, +Z up. Every clip is in place; extras carry the speed.
"""
import math
import bpy
import numpy as np
import mathutils

V = mathutils.Vector
M = mathutils.Matrix
Q = mathutils.Quaternion
E = mathutils.Euler
FPS = 30
CLAW_OUT = 0.0075            # how far the front claws slide out of the toes (m)
WALK = (0.7, 0.3)            # stride period (s), speed (m/s)
TROT = (14 / FPS, 0.72)
# extras that are times in seconds: re-timed with the clip by the tempo
TIME_KEYS = ('contact', 'drag', 'rakeEnd', 'gather', 'launch', 'frontContact', 'hindContact', 'windupHold')


def toe_dir(deg):
    """A toe direction in the side plane: 0 = flat forward, 90 = straight down, 180 = flat back.
    Interpolate the angle (not the vector) so a toe swinging from forward to back never flips."""
    a = math.radians(deg)
    return V((0, -math.cos(a), -math.sin(a)))


def jig(t, t0, amp, freq=6.0, decay=8.0):
    """A damped wobble starting at t0 (the fat jiggling after an impact)."""
    if t < t0:
        return 0.0
    u = t - t0
    return amp * math.exp(-decay * u) * math.sin(2 * math.pi * freq * u)


def mix_specs(a, b, k):
    """Blend two pose specs (rotations, offsets, scales, leg targets, shape weights) by k."""
    out = {}
    for key in ('rot', 'loc', 'wloc', 'scale'):
        A, B = a.get(key, {}), b.get(key, {})
        dflt = (1, 1, 1) if key == 'scale' else (0, 0, 0)
        names = set(A) | set(B)
        out[key] = {n: tuple(x + (y - x) * k for x, y in zip(A.get(n, dflt), B.get(n, dflt))) for n in names}
    legs = {}
    for leg in set(a.get('legs', {})) | set(b.get('legs', {})):
        la, lb = a.get('legs', {}).get(leg), b.get('legs', {}).get(leg)
        if la and lb:
            legs[leg] = {'paw': la['paw'].lerp(lb['paw'], k), 'met': la['met'].lerp(lb['met'], k).normalized()}
            for opt in ('pole', 'toe'):
                if opt in la or opt in lb:
                    legs[leg][opt] = V(la.get(opt, lb.get(opt))).lerp(V(lb.get(opt, la.get(opt))), k)
        else:
            legs[leg] = la or lb
    out['legs'] = legs
    sa, sb = a.get('shapes', {}), b.get('shapes', {})
    if sa or sb:
        out['shapes'] = {n: sa.get(n, 0.0) + (sb.get(n, 0.0) - sa.get(n, 0.0)) * k for n in set(sa) | set(sb)}
    return out


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ease(a, b, t):
    return a + (b - a) * smooth(t)


def env(t, keys):
    """Piecewise smooth envelope through (time, value) keys."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t <= t1:
            return ease(v0, v1, (t - t0) / max(t1 - t0, 1e-9))
    return keys[-1][1]


LEGS = {
    'LF': ('upper_arm.L', 'forearm.L', 'hand.L', 'f_toe.L', +1),   # +1: elbow points back
    'RF': ('upper_arm.R', 'forearm.R', 'hand.R', 'f_toe.R', +1),
    'LH': ('thigh.L', 'shin.L', 'foot.L', 'r_toe.L', -1),          # -1: knee points forward
    'RH': ('thigh.R', 'shin.R', 'foot.R', 'r_toe.R', -1),
}


class Poser:
    def __init__(self, arm, chains=None, soft=0.985):
        self.soft = soft            # the soft-IK zone starts here (fraction of the reach): a wider zone eases the last of the reach
        self.pole_down = 0.0
        self.arm = arm
        self.chains = chains or LEGS
        self.bones = arm.data.bones
        self.R = {b.name: b.matrix_local.copy() for b in self.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in self.bones}
        self.order = [b.name for b in sorted(self.bones, key=lambda b: len(b.parent_recursive))]
        self.len = {b.name: b.length for b in self.bones}
        self.leg_of = {}
        for k, v in self.chains.items():
            for n in v[:4]:
                if n:
                    self.leg_of[n] = k
        self.rest_head = {b.name: b.head_local.copy() for b in self.bones}
        self.rest_tail = {b.name: b.tail_local.copy() for b in self.bones}

    def base(self, n, W):
        p = self.parent[n]
        if p is None:
            return self.R[n].copy()
        return W[p] @ self.R[p].inverted() @ self.R[n]

    def solve(self, spec):
        """spec: rot {bone: (x, y, z) degrees, local}, loc {bone: (x, y, z) local offset},
        scale {bone: (x, y, z)}, legs {leg: {paw: V, met: V, toe: V}} in armature space.
        Returns {bone: basis Matrix}."""
        rot = spec.get('rot', {}); loc = dict(spec.get('loc', {})); scl = spec.get('scale', {})
        for n, w in spec.get('wloc', {}).items():
            # a world-space offset expressed in the bone's rest frame
            loc[n] = tuple(self.R[n].to_3x3().inverted() @ V(w))
        legs = spec.get('legs', {})
        W, B = {}, {}
        done = set()
        for n in self.order:
            if n in done:
                continue
            leg = self.leg_of.get(n)
            if leg and leg in legs and n == self.chains[leg][0]:
                self._leg(leg, legs[leg], W, B, spec)
                done.update(x for x in self.chains[leg][:4] if x)
                continue
            b = M.Identity(4)
            if n in rot:
                r = rot[n]
                b = E((math.radians(r[0]), math.radians(r[1]), math.radians(r[2])), 'XYZ').to_matrix().to_4x4()
            if n in loc:
                b = M.Translation(V(loc[n])) @ b
            if n in scl:
                s = scl[n]
                b = b @ M.Diagonal((s[0], s[1], s[2], 1.0))
            B[n] = b
            W[n] = self.base(n, W) @ b
            done.add(n)
            if n in ('spine', 'Hips') and 'body_q' not in spec:
                spec['body_q'] = (W[n].to_3x3().normalized() @ self.R[n].to_3x3().inverted()).to_quaternion()
        return B, W

    def _aim(self, n, head, direction, W, B, max_deg=None):
        base = self.base(n, W)
        y0 = base.col[1].xyz.normalized()
        q = y0.rotation_difference(direction.normalized())
        if max_deg is not None and math.degrees(q.angle) > max_deg:
            # a joint limit: bend at most max_deg from the parent's line (also keeps the solve stable)
            q = Q(q.axis, math.radians(max_deg))
        rot3 = q.to_matrix() @ base.to_3x3().normalized()
        # keep any scale the parent chain carries
        sc = base.to_scale()
        Wn = M.Translation(head) @ rot3.to_4x4() @ M.Diagonal((sc[0], sc[1], sc[2], 1.0))
        B[n] = base.inverted() @ Wn
        W[n] = Wn

    def _leg(self, leg, tgt, W, B, spec):
        b1, b2, b3, b4, pole_sign = self.chains[leg]
        base1 = self.base(b1, W)
        S = base1.translation.copy()
        sc = base1.to_scale()
        k = (sc[0] + sc[1] + sc[2]) / 3
        l1, l2, l3 = self.len[b1] * k, self.len[b2] * k, self.len[b3] * k
        paw = V(tgt['paw'])
        met = V(tgt.get('met', (0, 0, -1))).normalized()
        Wr = paw - met * l3
        d = Wr - S
        dist = d.length
        # soft IK: ease into full reach instead of snapping straight (no elbow pops near extension)
        L = l1 + l2
        da = L * self.soft
        if dist > da:
            dist = da + (L - da) * (1 - math.exp(-(dist - da) / (L - da)))
        dist_c = min(max(dist, abs(l1 - l2) + 1e-4), L * 0.999)
        u = d.normalized()
        body_q = spec.get('body_q', Q())
        # a quadruped's elbow points back and a little down, its knee forward and a little down: tipped
        # like this the pole never lines up with a leg reaching forward or trailing back (a leg lined up
        # with its pole is what flips an elbow over in one frame)
        pole = body_q @ (V(pole_sign) if isinstance(pole_sign, tuple) else V((0, pole_sign, -self.pole_down * (1.0 if pole_sign > 0 else 0.6))))
        if 'pole' in tgt:
            pole = V(tgt['pole'])
        v = (pole - u * pole.dot(u))
        if v.length < 1e-6:
            v = body_q @ V((0, 0, 1))
        v.normalize()
        ca = (l1 * l1 + dist_c * dist_c - l2 * l2) / (2 * l1 * dist_c)
        a = math.acos(min(1.0, max(-1.0, ca)))
        Eb = S + (u * math.cos(a) + v * math.sin(a)) * l1
        Wr = S + u * dist_c
        self._aim(b1, S, Eb - S, W, B)
        self._aim(b2, W[b1] @ V((0, self.len[b1], 0)), Wr - Eb, W, B)
        self._aim(b3, W[b2] @ V((0, self.len[b2], 0)), met, W, B, max_deg=110)
        if b4:
            toe = V(tgt.get('toe', body_q @ V((0, -1, -0.15))))
            self._aim(b4, W[b3] @ V((0, self.len[b3], 0)), toe, W, B, max_deg=120)
        for n in (b1, b2, b3, b4):
            pass

    def head_world(self, n, W):
        return W[n].translation.copy()


# ── keying ─────────────────────────────────────────────────────────────────────
def key_clip(arm, poser, name, frames, spec_fn, loop=True, extras=None, bones=None, secs=None, mesh=None, rate=None):
    """Key one clip. With `secs`, frame f samples the motion at f / frames * secs (so a clip re-timed by
    the tempo still covers its whole motion and a loop still closes). Shape-key weights a pose sets in
    spec['shapes'] (blinks, squints) go on a shape-key action in an NLA track of the same name, which
    the glTF export merges into the same animation."""
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    shapes = {}
    for f in range(frames + 1):
        if rate is not None:
            t = f / FPS * rate              # a one-shot: true time x tempo, so contact frames stay where they were keyed
        elif secs:
            t = f / frames * secs           # a loop: exactly one cycle over the frames, so it closes
        else:
            t = f / FPS
        spec = spec_fn(t)
        for k, v in spec.get('shapes', {}).items():
            shapes.setdefault(k, {})[f] = v
        B, _ = poser.solve(spec)
        for n, b in B.items():
            if bones is not None and n not in bones:
                continue                       # a partial clip keys only its own bones (layer it in the engine)
            pb = arm.pose.bones[n]
            l, r, s = b.decompose()
            pb.location = l; pb.rotation_quaternion = r; pb.scale = s
            pb.keyframe_insert('location', frame=f)
            pb.keyframe_insert('rotation_quaternion', frame=f)
            pb.keyframe_insert('scale', frame=f)
    act.use_fake_user = True
    if extras:
        for k, v in extras.items():
            act[k] = v
    arm.animation_data.action = None
    # a morph track sets every morph weight, so only clips that really move the lids get one (a layer clip
    # like tail_flick must not zero the blinks a game is driving)
    moving = any(abs(v) > 1e-4 for tr in shapes.values() for v in tr.values())
    layer_ok = bones is None or any(b.startswith('lid') for b in bones)
    if shapes and moving and layer_ok and mesh is not None and mesh.data.shape_keys is not None:
        key = mesh.data.shape_keys
        key.animation_data_create()
        sa = bpy.data.actions.new(f'{name}__shapes')
        key.animation_data.action = sa
        for kn, track in shapes.items():
            kb = key.key_blocks.get(kn)
            if kb is None:
                continue
            for f in range(frames + 1):
                kb.value = float(track.get(f, 0.0))
                kb.keyframe_insert('value', frame=f)
            kb.value = 0.0
        key.animation_data.action = None
        sa.use_fake_user = True
        tr = key.animation_data.nla_tracks.new(); tr.name = name
        tr.strips.new(name, 0, sa); tr.mute = True
        act['shapes'] = ','.join(sorted(shapes))
    return act


# ── the cat clips ──────────────────────────────────────────────────────────────
class CatMotion:
    def __init__(self, poser, plan):
        self.p = poser
        self.plan = plan
        h = poser.rest_head; t = poser.rest_tail
        self.paw_rest = {
            'LF': t['hand.L'].copy(), 'RF': t['hand.R'].copy(),
            'LH': t['foot.L'].copy(), 'RH': t['foot.R'].copy(),
        }
        self.met_rest = {k: (t[LEGS[k][2]] - h[LEGS[k][2]]).normalized() for k in LEGS}
        self.pelvis = h['spine'].copy()

    def stand_legs(self, body_q=Q(), narrow=1.0, lift=None):
        legs = {}
        for k, p in self.paw_rest.items():
            q = p.copy(); q.x *= narrow
            legs[k] = {'paw': q, 'met': self.met_rest[k]}
        return legs

    def body(self, spec, dz=0.0, dy=0.0, dx=0.0, pitch=0.0, roll=0.0, yaw=0.0):
        """Move and turn the whole body at the pelvis (the `spine` bone)."""
        # the spine bone points forward: local X pitches (nose up +), Y rolls, Z yaws (to the left +)
        spec.setdefault('rot', {})['spine'] = (pitch, roll, yaw)
        spec.setdefault('wloc', {})['spine'] = (dx, -dy, dz)
        return spec

    def tail(self, spec, base_pitch=0.0, sway=None, curl=0.0, droop=0.0):
        for i in range(4):
            yaw = sway[i] if sway else 0.0
            spec['rot'][f'tail.00{i + 1}'] = ((base_pitch if i == 0 else droop + curl * i), 0.0, yaw)
        return spec

    def breathe(self, spec, t, rate=0.33, amt=1.0):
        b = 0.5 + 0.5 * math.sin(2 * math.pi * rate * t)
        spec.setdefault('scale', {})['belly.C'] = (1 + 0.035 * amt * b, 1 + 0.02 * amt * b, 1 + 0.035 * amt * b)
        spec['scale']['spine.002'] = (1 + 0.012 * amt * b, 1, 1 + 0.012 * amt * b)
        return spec

    def blink(self, spec, closed, right=None):
        """Lids by shape key (blinkL / blinkR, see eyelids.py): 0 open, 1 shut."""
        sh = spec.setdefault('shapes', {})
        sh['blinkL'] = max(sh.get('blinkL', 0.0), float(closed))
        sh['blinkR'] = max(sh.get('blinkR', 0.0), float(closed if right is None else right))
        return spec

    def squint(self, spec, amt):
        sh = spec.setdefault('shapes', {})
        sh['eyeSquintL'] = sh['eyeSquintR'] = float(amt)
        return spec

    def claws(self, spec, left, right=None):
        """Front claws out (1) or sheathed (0): the claw bones slide the claws out of the toes."""
        right = left if right is None else right
        for s, k in (('L', left), ('R', right)):
            spec.setdefault('loc', {})[f'claw.{s}'] = (0, CLAW_OUT * k, 0)
        return spec

    def body_frame(self, spec, bone='spine'):
        """World matrices of the pose so far (legs at rest) and the body's rotation at `bone`."""
        _, W = self.p.solve(self._copy(spec))
        Rb = W[bone].to_3x3().normalized() @ self.p.R[bone].to_3x3().inverted()
        return W, Rb

    def limb(self, W, Rb, leg, x, f, z, met=(0, 0, -1), pole=None, toe=None):
        """A leg target in the body's own frame: the paw at (x out, f toward the head, z toward the back)
        from the limb's root (the top of the upper arm or the thigh)."""
        sx = 1 if leg[0] == 'L' else -1
        root = W[LEGS[leg][0]].translation
        d = {'paw': root + Rb @ V((x * sx, -f, z)), 'met': (Rb @ V((met[0] * sx, -met[1], met[2]))).normalized()}
        if pole is not None:
            d['pole'] = Rb @ V((pole[0] * sx, -pole[1], pole[2]))
        if toe is not None:
            d['toe'] = Rb @ V((toe[0] * sx, -toe[1], toe[2]))
        return d

    def anchor(self, spec, nodes, target):
        """Move the whole body (at the pelvis) so the midpoint of the `nodes` heads sits on `target`."""
        _, W = self.p.solve(self._copy(spec))
        mid = sum((W[n].translation for n in nodes), V()) / len(nodes)
        w = spec['wloc']['spine']
        d = V(target) - mid
        spec['wloc']['spine'] = (w[0] + d.x, w[1] + d.y, w[2] + d.z)
        return spec

    # loops ------------------------------------------------------------------
    def gait(self, t, period, phases, duty, speed, lift, bob, sway, tail_pitch, tail_amp, head_pitch=-6.0):
        spec = {'rot': {}, 'loc': {}}
        # a planted paw sweeps back at the ground speed for the stance part of the cycle
        stride = speed * duty * period
        ph = (t / period) % 1.0
        # body: a small bob twice per cycle, a side sway and roll lagging the steps
        dz = -bob * math.cos(4 * math.pi * ph)
        dx = sway * math.sin(2 * math.pi * (ph - 0.1))
        roll = 2.5 * math.sin(2 * math.pi * (ph - 0.12)) * (sway / 0.006 if sway else 0)
        yaw = 1.5 * math.sin(2 * math.pi * (ph - 0.05))
        self.body(spec, dz=dz, dx=dx, roll=roll, yaw=yaw)
        legs = {}
        for k, phase in phases.items():
            u = (ph - phase) % 1.0
            n = self.paw_rest[k].copy()
            n.x *= 0.82                                   # a narrow track: paws close under the body
            met = self.met_rest[k].copy()
            front = k.endswith('F')
            if u < duty:
                s = u / duty
                y = n.y - stride / 2 + stride * s
                z = n.z
                # the wrist/hock rolls over the paw through stance
                off = (-0.25 + 0.5 * s) * (1 if front else 0.6)
                met = (met + V((0, off, 0))).normalized()
            else:
                s = (u - duty) / (1 - duty)
                # Hermite swing: leaves and lands moving with the ground, so no slide at lift-off or touch-down
                m = speed * period * (1 - duty)
                h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
                y = h00 * (n.y + stride / 2) + h10 * m + h01 * (n.y - stride / 2) + h11 * m
                # the paw peels straight up off the floor (a fast first lift), so it never drags back
                # along the ground while the swing turns it round; it sets down a little more softly
                z = n.z + lift * (0.85 if front else 1.0) * math.sin(math.pi * s) ** ((0.55 if s < 0.5 else 0.8) if not front else 1.0)
                # the paw flips up behind as it lifts (wrist flexes), then reaches forward; continuous
                # with the stance roll at both ends
                k0 = (1 if front else 0.6)
                flex = math.sin(math.pi * s) * (0.9 if front else 0.6) * min(1.0, period / 0.8)   # a quick stride flips the paw less
                off = 0.25 * k0 * (1 - 2 * smooth(s)) + flex
                met = (met + V((0, off, 0.25 * flex))).normalized()
            legs[k] = {'paw': V((n.x, y, z)), 'met': met}
            # shoulder blades roll: the scapula top rises as the leg passes under the body in stance
            if front:
                side = 'L' if k[0] == 'L' else 'R'
                st = math.sin(2 * math.pi * (u / duty - 0.5) * 0.5) if u < duty else -0.6 * math.sin(math.pi * (u - duty) / (1 - duty))
                spec['rot'][f'shoulder.{side}'] = (6 * st, 0, 0)
        spec['legs'] = legs
        # the belly swings side to side, a beat behind the steps
        spec['rot']['belly.C'] = (0, 0, 7 * math.sin(2 * math.pi * (ph - 0.22)) * (sway / 0.006 if sway else 1))
        # head level and low: the neck dips, the head counters the body's turn
        spec['rot']['spine.004'] = (head_pitch, 0, -yaw * 0.5)
        spec['rot']['spine.005'] = (-head_pitch * 0.4, 0, -yaw * 0.5)
        spec['rot']['spine.006'] = (-head_pitch * 0.5 - dz * 200, -roll, 0)
        # the tail lags: a wave travelling down it
        sw = [tail_amp * (0.5 + 0.25 * i) * math.sin(2 * math.pi * (ph - 0.15 - 0.12 * i)) for i in range(4)]
        self.tail(spec, base_pitch=tail_pitch, sway=sw, droop=-8 if tail_pitch < 30 else 12)
        return spec

    def walk(self, t):
        # lateral sequence: LH, LF, RH, RF a quarter apart; direct register. A cat walks with purpose: about
        # 1.4 strides a second at 0.3 m/s for a short-legged fat cat (stance sweep 0.13 m, all the leg has)
        return self.gait(t, WALK[0], {'LH': 0.0, 'LF': 0.25, 'RH': 0.5, 'RF': 0.75}, 0.6, WALK[1], 0.028, 0.005, 0.007, 22, 6)

    def trot(self, t):
        # diagonal pairs, tail up: 2.1 strides a second at 0.72 m/s, the barrel bobbing with each beat
        return self.gait(t, TROT[0], {'LH': 0.0, 'RF': 0.0, 'RH': 0.5, 'LF': 0.5}, 0.4, TROT[1], 0.031, 0.009, 0.004, 70, 5, head_pitch=-2)

    def idle(self, t):
        spec = {'rot': {}, 'loc': {}}
        self.body(spec, dz=0.0)
        spec['legs'] = self.stand_legs()
        self.breathe(spec, t, rate=0.5)
        look = 10 * math.sin(2 * math.pi * t / 4.0) * smooth(min(1, t / 0.5))
        spec['rot']['spine.004'] = (-4, 0, look * 0.4)
        spec['rot']['spine.006'] = (2, 0, look * 0.6)
        flick = math.sin(2 * math.pi * t / 2.0)
        self.tail(spec, base_pitch=-10, sway=[0, 2 * flick, 4 * flick, 10 * math.sin(2 * math.pi * (t / 2.0 - 0.2))], droop=-10)
        bl = max(0.0, 1 - abs(t - 2.6) / 0.09)
        self.blink(spec, bl)
        ear = 12 * max(0.0, 1 - abs(t - 1.3) / 0.12)
        spec['rot']['ear.L'] = (0, -ear, 0)
        return spec

    # ── calibration on the real skinned mesh ────────────────────────────────────
    def _pose_min_z(self, arm, mesh, spec, torso_mask):
        B, _ = self.p.solve(self._copy(spec))
        for n, bm in B.items():
            pb = arm.pose.bones[n]
            l, r, sc = bm.decompose()
            pb.location = l; pb.rotation_quaternion = r; pb.scale = sc
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        ev.to_mesh_clear()
        mw = np.array(mesh.matrix_world)
        z = co @ mw[:3, :3].T + mw[:3, 3]
        return float(z[torso_mask, 2].min())

    def calibrate(self, arm, mesh):
        """Seat the sit and the loaf on the floor using the deformed mesh itself: the lowest point of the
        barrel (not the legs) is put on the floor, and the sit's pitch is the one that leaves the front
        legs standing straight."""
        names = [g.name for g in mesh.vertex_groups]
        legish = ('upper_arm', 'forearm', 'hand', 'f_toe', 'thigh', 'shin', 'foot', 'r_toe', 'tail', 'eye', 'lid', 'ear')
        n = len(mesh.data.vertices)
        best_bone = np.full(n, -1); best_w = np.zeros(n)
        for v in mesh.data.vertices:
            for g in v.groups:
                if g.weight > best_w[v.index]:
                    best_w[v.index] = g.weight; best_bone[v.index] = g.group
        torso = np.array([b >= 0 and not names[b].startswith(legish) for b in best_bone])
        saved = arm.animation_data.action if arm.animation_data else None
        if arm.animation_data:
            arm.animation_data.action = None
        self.sit_pose = None
        best = None
        for pitch in range(18, 64, 3):
            spec = self._sit_body(pitch, 0.0)
            low = self._pose_min_z(arm, mesh, spec, torso)
            drop = -low + 0.004
            spec = self._sit_body(pitch, drop)
            _, W = self.p.solve(self._copy(spec))
            sh = W[LEGS['LF'][0]].translation
            err = abs((sh.z - self.paw_rest['LF'].z) - 0.97 * self._reach('LF'))
            if best is None or err < best[0]:
                best = (err, pitch, drop)
        self.sit_pose = (best[1], best[2])
        spec = self._loaf_body(0.0)
        low = self._pose_min_z(arm, mesh, spec, torso)
        self.loaf_drop = low - 0.002
        for pb in arm.pose.bones:
            pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
        if arm.animation_data:
            arm.animation_data.action = saved
        bpy.context.view_layer.update()

    def _sit_body(self, pitch, drop):
        spec = {'rot': {}, 'loc': {}}
        self.body(spec, dz=drop, dy=0.02, pitch=pitch)
        spec['rot']['spine.003'] = (-pitch * 0.1, 0, 0)
        spec['rot']['belly.C'] = (30, 0, 0)
        # the head comes back to level
        spec['rot']['spine.004'] = (-pitch * 0.45, 0, 0); spec['rot']['spine.005'] = (-pitch * 0.25, 0, 0); spec['rot']['spine.006'] = (-pitch * 0.42, 0, 0)
        spec['rot']['tail.001'] = (-pitch, 0, 0)
        return spec

    def _loaf_body(self, drop):
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        self.body(spec, dz=-drop - 0.01, pitch=-4)
        spec['rot']['belly.C'] = (0, 0, 0)
        spec['scale']['belly.C'] = (1.12, 1.0, 0.85)       # the belly spreads on the floor
        spec['rot']['spine.004'] = (-8, 0, 0); spec['rot']['spine.006'] = (6, 0, 0)
        for s in ('L', 'R'):
            spec['scale'][f'shoulder.{s}'] = (0.74, 0.74, 0.74)
            spec['scale'][f'thigh.{s}'] = (0.74, 0.74, 0.74)
        return spec

    def _copy(self, spec):
        return {k: (dict(v) if isinstance(v, dict) else v) for k, v in spec.items()}

    def _reach(self, leg):
        b1, b2, b3 = LEGS[leg][:3]
        return self.p.len[b1] + self.p.len[b2] + self.p.len[b3]

    def sit(self, t):
        p = self.p
        # BSH pyramid: rump on the floor, chest up, front legs straight columns, haunches spread,
        # belly slumped forward between the thighs (pitch and seat calibrated on the mesh)
        pitch, drop = getattr(self, 'sit_pose', None) or (40, -0.12)
        spec = self._sit_body(pitch, drop)
        _, W = p.solve(self._copy(spec))
        legs = {}
        for k in ('LF', 'RF'):
            sh = W[LEGS[k][0]].translation
            legs[k] = {'paw': V((self.paw_rest[k].x * 0.85, sh.y - 0.006, self.paw_rest[k].z)), 'met': V((0, 0.05, -1)).normalized(), 'pole': V((0, 1, -0.3))}
        for k in ('LH', 'RH'):
            hp = W[LEGS[k][0]].translation
            sx = 1 if k[0] == 'L' else -1
            # the hock rests on the floor behind the paw, the metatarsal flat, the knee out to the side
            legs[k] = {'paw': V((self.paw_rest[k].x * 1.2 + 0.01 * sx, hp.y - 0.075, self.paw_rest[k].z)), 'met': V((0.12 * sx, -1, -0.12)).normalized(),
                       'pole': V((0.5 * sx, -1, 0.8))}
        spec['legs'] = legs
        self.tail(spec, base_pitch=-55, sway=[30, 38, 38, 30], droop=-12)
        self.breathe(spec, t, 0.4)
        bl = max(0.0, 1 - abs(t - 1.6) / 0.09)
        self.blink(spec, bl)
        return spec

    def loaf(self, t):
        p = self.p
        spec = self._loaf_body(getattr(self, 'loaf_drop', self.plan.belly))
        _, W = p.solve(self._copy(spec))
        legs = {}
        # legs folded and tucked under the barrel: the front paws curl under the chest, the hind legs
        # fold under the haunches with the paws forward. Shortened a little so nothing pokes through.
        for k in ('LF', 'RF'):
            sh = W[LEGS[k][0]].translation
            # the forearm lies forward along the floor and the paw folds back under it
            wr = V((self.paw_rest[k].x * 0.8, sh.y + 0.005, 0.022))
            met = V((0, 1, -0.25)).normalized()
            legs[k] = {'paw': wr + met * self.p.len[LEGS[k][2]] * 0.9, 'met': met, 'pole': V((0, 1, 0.1)), 'toe': V((0, 1, -0.4))}
        for k in ('LH', 'RH'):
            hp = W[LEGS[k][0]].translation
            sx = 1 if k[0] == 'L' else -1
            legs[k] = {'paw': V((self.paw_rest[k].x * 0.95, hp.y - 0.07, 0.012)), 'met': V((0.05 * sx, -1, -0.05)).normalized(),
                       'pole': V((0.3 * sx, -1, 0.5))}
        spec['legs'] = legs
        self.tail(spec, base_pitch=-30, sway=[30, 35, 35, 25], droop=-6)
        self.breathe(spec, t, 0.33)
        bl = max(0.0, 1 - abs(t - 2.2) / 0.3) ** 0.5
        self.blink(spec, 0.42 + 0.58 * bl)      # content, heavy-lidded
        return spec

    # ── carried ─────────────────────────────────────────────────────────────────
    # Both carried clips hold the anchor nodes still (hold.L/hold.R, or cradle.F/cradle.B), so a game
    # parents the cat to the carrier's hands by those nodes and the cat hangs from them.
    HOLD_AT = V((0.0, 0.0, 0.56))       # the armpit grip, root space (Blender), for the dangle
    CRADLE_AT = V((0.0, 0.0, 0.42))     # the chest support, for the cradle

    def _annoyed(self, spec, t, period, look=1.0):
        """Limp but annoyed: the tail lashes, the head turns to look back, ears go sideways."""
        u = 2 * math.pi * t / period
        lash = math.sin(2 * u)                                  # two lashes a loop
        sw = [6 * lash, 14 * math.sin(2 * u - 0.6), 24 * math.sin(2 * u - 1.2), 34 * math.sin(2 * u - 1.8)]
        # the head turns back over one shoulder, holds, comes round, and looks back over the other
        turn = look * (env(t % period, [(0, 0), (0.25 * period, 1), (0.45 * period, 1), (0.6 * period, -0.7), (0.85 * period, -0.7), (period, 0)]))
        r = spec['rot']
        n0 = r.get('spine.004', (0, 0, 0)); h0 = r.get('spine.006', (0, 0, 0))
        r['spine.004'] = (n0[0], n0[1], n0[2] + 22 * turn)
        r['spine.005'] = (0, 0, 14 * turn)
        r['spine.006'] = (h0[0], h0[1] + 34 * turn, h0[2] - 6 * turn)      # the head bone points up: its Y turns it
        r['ear.L'] = (0, -20, -30); r['ear.R'] = (0, 20, 30)      # airplane ears
        return sw

    def carried_dangle(self, t):
        """Scooped up under the front legs: the body hangs nearly vertical from the armpits, a fat cat's
        barrel stretching long, hind legs dangling, front legs stuck out over the hands."""
        P = 3.0
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        sway = math.sin(2 * math.pi * t / P)
        self.body(spec, pitch=74 + 2 * sway, roll=1.5 * math.sin(2 * math.pi * t / P - 0.8))
        # the barrel stretches under its own weight; the belly sags toward the floor (back along the body)
        for n in ('spine.001', 'spine.002', 'spine.003'):
            spec['loc'][n] = (0, 0.012, 0)
        spec['rot']['spine.001'] = (-4, 0, 0); spec['rot']['spine.002'] = (-3, 0, 0)
        spec['rot']['belly.C'] = (-22 + 3 * sway, 0, 2 * sway)
        spec['scale']['belly.C'] = (1.04, 1.12, 1.04)
        # the head comes level (the body is upright) and looks about
        spec['rot']['spine.004'] = (-44, 0, 0); spec['rot']['spine.005'] = (-14, 0, 0); spec['rot']['spine.006'] = (-20, 0, 0)
        self.anchor(spec, ('hold.L', 'hold.R'), self.HOLD_AT)
        W, Rb = self.body_frame(spec, 'spine.003')
        Wh, Rh = self.body_frame(spec, 'spine')
        legs = {}
        for k in ('LF', 'RF'):
            # pushed up by the hands: the arms stick out forward over them, paws drooping
            legs[k] = self.limb(W, Rb, k, 0.03, 0.01, -0.1, met=(0.1, 0.6, -1), pole=(0, -1, 0.3))
        kick = env(t, [(0, 0), (1.55, 0), (1.68, 1), (1.85, 0.2), (2.0, 0)])     # one annoyed kick a loop
        for k in ('LH', 'RH'):
            sx = 1 if k[0] == 'L' else -1
            hip = Wh[LEGS[k][0]].translation
            ph = 0 if k == 'LH' else 0.6
            sw = math.sin(2 * math.pi * t / P + ph)
            kk = kick if k == 'LH' else 0.0
            # hanging straight down under gravity, a slight bend, swinging a little
            paw = hip + V((0.012 * sx, -0.012 + 0.012 * sw - 0.05 * kk, -0.215 + 0.06 * kk))
            legs[k] = {'paw': paw, 'met': V((0, 0.15 - 0.6 * kk, -1)).normalized(), 'pole': V((0.2 * sx, -1, 0)), 'toe': V((0, -0.2, -1))}
        spec['legs'] = legs
        sw = self._annoyed(spec, t, P)
        # the tail hangs down behind the legs, lashing
        self.tail(spec, base_pitch=48, sway=sw, droop=6)
        self.breathe(spec, t, 2 / P, 1.2)
        self.squint(spec, 0.35)                                 # not amused
        bl = max(0.0, 1 - abs(t - 2.4) / 0.08)
        self.blink(spec, bl)
        return spec

    def carried_cradle(self, t):
        """Draped belly-down across the carrier's forearms (one under the chest, one under the rump): the
        middle sags, all four legs hang over the arms, the head up and turning to glare back."""
        P = 3.0
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        sway = math.sin(2 * math.pi * t / P)
        self.body(spec, pitch=10 + 1.5 * sway, roll=2 * math.sin(2 * math.pi * t / P - 0.5))
        # held at both ends, the middle sags and the belly hangs
        spec['rot']['spine.001'] = (-5, 0, 0); spec['rot']['spine.002'] = (-3, 0, 0); spec['rot']['spine.003'] = (8, 0, 0)
        spec['rot']['belly.C'] = (0, 0, 3 * sway)
        spec['scale']['belly.C'] = (1.06, 1.1, 1.06)
        spec['rot']['spine.004'] = (6, 0, 0); spec['rot']['spine.006'] = (-6, 0, 0)
        self.anchor(spec, ('cradle.F',), self.CRADLE_AT)
        _, Wd = self.p.solve(self._copy(spec))
        legs = {}
        for k in ('LF', 'RF', 'LH', 'RH'):
            sx = 1 if k[0] == 'L' else -1
            front = k.endswith('F')
            root = Wd[LEGS[k][0]].translation
            ph = (0.0 if k[0] == 'L' else 0.5) + (0.0 if front else 0.25)
            sw = math.sin(2 * math.pi * (t / P + ph))
            # front legs hang over the forearm just ahead of it; hind legs hang off the back arm
            # limp: splayed a little, the joints soft, the paws drooping off the wrists and hocks
            if front:
                paw = root + V((0.025 * sx, 0.03 + 0.006 * sw, -0.135))
                legs[k] = {'paw': paw, 'met': V((0, 0.9, -0.55)).normalized(), 'pole': V((0, 1, -0.2)), 'toe': V((0, 0.4, -1))}
            else:
                paw = root + V((0.03 * sx, -0.015 + 0.008 * sw, -0.19))
                legs[k] = {'paw': paw, 'met': V((0, 0.55, -1)).normalized(), 'pole': V((0.2 * sx, -1, 0)), 'toe': V((0, 0.3, -1))}
        spec['legs'] = legs
        sw = self._annoyed(spec, t, P, look=1.2)
        self.tail(spec, base_pitch=-50, sway=sw, droop=-2)
        self.breathe(spec, t, 2 / P, 1.2)
        self.squint(spec, 0.25)
        bl = max(0.0, 1 - abs(t - 1.1) / 0.08)
        self.blink(spec, bl)
        return spec

    def carried(self, t):
        return self.carried_dangle(t)

    def squash(self, t):
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        k = 1.0
        # about 30% flatter: the whole cat compresses and spreads, legs splay, head low, ears back
        spec['scale']['root'] = (1 + 0.1 * k, 1 + 0.06 * k, 1 - 0.3 * k)
        self.body(spec, dz=-0.012 * k)
        legs = {}
        for kk, p in self.paw_rest.items():
            sx = 1 if kk[0] == 'L' else -1
            q = p.copy(); q.x += 0.03 * sx * k
            legs[kk] = {'paw': q, 'met': (self.met_rest[kk] + V((0.4 * sx * k, 0, 0))).normalized(), 'pole': V((0.8 * sx, (1 if kk.endswith('F') else -1), 0))}
        spec['legs'] = legs
        spec['rot']['spine.004'] = (-14 * k, 0, 0); spec['rot']['spine.006'] = (6 * k, 0, 0)
        spec['rot']['ear.L'] = (0, 0, -35 * k); spec['rot']['ear.R'] = (0, 0, 35 * k)
        self.tail(spec, base_pitch=-5, sway=[0, 0, 0, 6 * math.sin(2 * math.pi * t)], droop=0)
        self.breathe(spec, t, 0.6, 0.6)
        return spec

    # ── the jump: takeoff, air, landing ─────────────────────────────────────────
    # Timing from real cats: a short gather (the haunches load, hind feet under the hips), an explosive
    # hind-leg extension of about 0.15 s with the front legs already lifting and reaching, the body
    # streaming long through the air with the tail out behind, then the front paws land first, the
    # elbows take the hit, and the hind feet come in under the body about 0.08 s later.
    GATHER, LAUNCH = 4 / FPS, 8 / FPS
    LAND_HIND = 3 / FPS

    def _fat(self):
        return 0.4 + 0.6 * getattr(self.plan, 'build', 0.9)

    def _takeoff(self, t, wiggle=0.0):
        G, L = self.GATHER, self.LAUNCH
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        dz = env(t, [(0, 0), (0.05, -0.016), (G, -0.036), (0.19, -0.012), (L, 0.05)])
        dy = env(t, [(0, 0), (G, -0.016), (L, 0.03)])
        pitch = env(t, [(0, 0), (G, -5), (0.19, 6), (L, 26)])
        self.body(spec, dz=dz, dy=dy, pitch=pitch, roll=3 * wiggle, dx=0.008 * wiggle, yaw=-2 * wiggle)
        spec['rot']['spine.001'] = (env(t, [(0, 0), (G, 5), (L, -4)]), 0, 0)
        spec['rot']['spine.002'] = (env(t, [(0, 0), (G, 4), (L, -3)]), 0, 2 * wiggle)
        # the barrel loads into the crouch and is flung up and back by the push
        sq = env(t, [(0, 0), (G, 0.05), (0.2, 0.0), (L, -0.05)])
        spec['scale']['belly.C'] = (1 + 0.6 * sq * self._fat(), 1 + sq * self._fat(), 1 + 0.6 * sq * self._fat())
        legs = self.stand_legs()
        lift = env(t, [(0.09, 0), (L, 1)])
        for k in ('LF', 'RF'):
            p = self.paw_rest[k]
            # front paws peel off first and reach up and forward
            legs[k] = {'paw': V((p.x, p.y - 0.055 * lift, p.z + 0.075 * lift)),
                       'met': (self.met_rest[k] + V((0, 0.9 * math.sin(math.pi * min(lift, 1) * 0.9), 0.2 * lift))).normalized()}
        for k in ('LH', 'RH'):
            p = self.paw_rest[k]
            ext = env(t, [(G, 0), (L, 1)])
            # planted; the heel lifts as the leg straightens, toes push down and back at the end
            legs[k] = {'paw': V((p.x, p.y, p.z + 0.004 * ext)), 'met': self.met_rest[k].lerp(V((0, 0.45, -1)).normalized(), ext).normalized(),
                       'toe': toe_dir(8.5 + (109 - 8.5) * ext)}
        spec['legs'] = legs
        # eyes on the target: the head comes up and level as the body tips up
        spec['rot']['spine.004'] = (env(t, [(0, 0), (G, -8), (L, -14)]), 0, 0)
        spec['rot']['spine.006'] = (env(t, [(0, 0), (G, 4), (L, -10)]), 0, 0)
        e = env(t, [(0, 0), (G, -10), (L, -14)])
        spec['rot']['ear.L'] = (0, 0, -e * 0.3); spec['rot']['ear.R'] = (0, 0, e * 0.3)
        self.tail(spec, base_pitch=env(t, [(0, -10), (G, -16), (L, 12)]), sway=[0, 0, 4 * wiggle, 10 * wiggle], droop=env(t, [(0, -8), (G, -4), (L, 2)]))
        self.squint(spec, env(t, [(0, 0), (G, 0.3), (L, 0.1)]))
        return spec

    def jump_takeoff(self, t):
        return self._takeoff(t)

    def jump_wiggle(self, t):
        """The pre-jump butt wiggle, held at the gather (loop it between the two halves of jump_takeoff)."""
        w = math.sin(2 * math.pi * t / 0.3)
        spec = self._takeoff(self.GATHER, wiggle=w)
        spec['rot']['spine'] = tuple(a + b for a, b in zip(spec['rot']['spine'], (0, 0, -3 * w)))
        for k in ('LH', 'RH'):
            sx = 1 if k[0] == 'L' else -1
            # the hind feet tread: each lifts a hair in turn
            spec['legs'][k]['paw'] = spec['legs'][k]['paw'] + V((0, 0, 0.006 * max(0.0, w * sx)))
        return spec

    def _air(self, t, dz=0.03, pitch=0.0, reach=1.0):
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        u = 2 * math.pi * t / 0.6
        self.body(spec, dz=dz, pitch=pitch)
        # stretched long: the back flattens, the belly trails a beat behind
        spec['rot']['spine.001'] = (-3, 0, 0); spec['rot']['spine.002'] = (-3, 0, 0); spec['rot']['spine.003'] = (-2, 0, 0)
        spec['rot']['belly.C'] = (4 * math.sin(u - 0.8), 0, 0)
        spec['scale']['belly.C'] = (1, 1 + 0.03 * math.sin(u) * self._fat(), 1)
        W, Rb = self.body_frame(spec, 'spine.003')
        Wh, Rh = self.body_frame(spec, 'spine')
        b = 0.006 * math.sin(u)
        legs = {}
        for k in ('LF', 'RF'):
            # front legs reach up and forward, paws turned down, ready to land
            legs[k] = self.limb(W, Rb, k, 0.006, 0.11 * reach + b, -0.105 + 0.03 * (1 - reach), met=(0, 0.75, -0.65))
        for k in ('LH', 'RH'):
            # hind legs trail back, long, toes pointed
            legs[k] = self.limb(Wh, Rh, k, 0.01, -0.13 - b, -0.165, met=(0, -0.85, -0.5), toe=(0, -0.8, -0.6))
        spec['legs'] = legs
        spec['rot']['spine.004'] = (-10, 0, 0); spec['rot']['spine.006'] = (-4 - 0.4 * pitch, 0, 0)
        spec['rot']['ear.L'] = (0, 0, -6); spec['rot']['ear.R'] = (0, 0, 6)
        # the tail streams out behind for balance
        self.tail(spec, base_pitch=20, sway=[0, 2 * math.sin(u), 4 * math.sin(u - 0.5), 6 * math.sin(u - 1.0)], droop=-2)
        return spec

    def jump_air(self, t):
        return self._air(t)

    def _land(self, t):
        H = self.LAND_HIND
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        fat = self._fat()
        # front paws touch at 0: the body comes in nose down and behind them, the elbows give, the hind
        # feet swing in and land at H, then the whole barrel squashes and jiggles
        dz = env(t, [(0, 0.03), (0.05, 0.004), (0.11, -0.04), (0.18, -0.03), (0.28, -0.008), (0.45, 0)]) + jig(t, 0.11, -0.01 * fat, 5.0, 9.0)
        pitch = env(t, [(0, -18), (H, -6), (0.16, -1), (0.45, 0)])
        dy = env(t, [(0, -0.035), (0.12, 0.004), (0.45, 0)])
        self.body(spec, dz=dz, dy=dy, pitch=pitch)
        sq = env(t, [(0, 0), (0.05, 0.03), (0.12, 0.11), (0.22, 0.02), (0.45, 0)]) * fat
        spec['scale']['root'] = (1 + sq * 0.5, 1 - sq * 0.15, 1 - sq)
        j = jig(t, 0.1, 0.09 * fat, 6.0, 8.0)
        spec['scale']['belly.C'] = (1 + 0.6 * j, 1 + j, 1 + 0.6 * j)
        spec['rot']['belly.C'] = (14 * j, 0, 0)
        spec['rot']['spine.002'] = (3 * jig(t, 0.1, 1.0, 6.0, 8.0), 0, 0)
        legs = self.stand_legs()
        k_h = env(t, [(0, 0), (H, 1)])
        for k in ('LH', 'RH'):
            p = self.paw_rest[k]
            # from trailing behind and up to planted under the hips
            legs[k] = {'paw': V((p.x, p.y + 0.06 * (1 - k_h), p.z + 0.07 * (1 - k_h) * (1 - k_h))),
                       'met': self.met_rest[k].lerp(V((0, 0.5, -1)).normalized(), 1 - k_h).normalized(),
                       'toe': toe_dir(env(t, [(0, 143), (H, 95), (0.24, 8.5)]))}      # lands on the toes, then the foot flattens
        for k in ('LF', 'RF'):
            legs[k]['met'] = (self.met_rest[k] + V((0, 0.35 * (1 - env(t, [(0, 0), (0.12, 1)])), 0))).normalized()
        spec['legs'] = legs
        spec['rot']['spine.004'] = (env(t, [(0, -6), (0.12, -18), (0.3, -4), (0.45, 0)]), 0, 0)
        spec['rot']['spine.006'] = (env(t, [(0, 4), (0.12, 10), (0.45, 0)]), 0, 0)
        self.tail(spec, base_pitch=env(t, [(0, 18), (0.14, -24), (0.3, -6), (0.45, -10)]), sway=[0, 0, 0, 6 * jig(t, 0.12, 1, 3, 5)], droop=-6)
        self.squint(spec, env(t, [(0, 0), (0.1, 0.5), (0.3, 0)]))
        return spec

    def jump_land(self, t):
        return self._land(t)

    def jump(self, t):
        """The whole jump in place, for games without jump physics: takeoff, a 0.32 m arc, landing."""
        L = self.LAUNCH
        A = 13 / FPS                              # time in the air
        if t <= L:
            return self._takeoff(t)
        if t >= L + A:
            return self._land(t - L - A)
        u = (t - L) / A
        dz = 0.05 + (0.03 - 0.05) * u + 4 * 0.29 * u * (1 - u)       # a parabola, apex about 0.33 m
        pitch = 26 + (-18 - 26) * smooth(u)
        air = self._air(t - L, dz=dz, pitch=pitch, reach=0.6 + 0.4 * u)
        k0 = smooth((t - L) / 0.1)
        if k0 < 1:
            air = mix_specs(self._takeoff(L), air, k0)
        k1 = smooth((t - (L + A - 0.08)) / 0.08)
        if k1 > 0:
            air = mix_specs(air, self._land(0), k1)
        return air

    def land(self, t):
        """Dropping down onto all four (off a sofa): touch, squash, jiggle, settle."""
        fat = self._fat()
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        dz = env(t, [(0, 0.0), (0.07, -0.042), (0.16, -0.026), (0.4, 0)]) + jig(t, 0.07, -0.008 * fat, 5.0, 9.0)
        sq = env(t, [(0, 0.0), (0.07, 0.11), (0.18, 0.03), (0.4, 0)]) * fat
        self.body(spec, dz=dz, pitch=env(t, [(0, -8), (0.08, -3), (0.4, 0)]))
        spec['scale']['root'] = (1 + sq * 0.5, 1 - sq * 0.15, 1 - sq)
        j = jig(t, 0.06, 0.09 * fat, 6.0, 8.0)
        spec['scale']['belly.C'] = (1 + 0.6 * j, 1 + j, 1 + 0.6 * j)
        spec['legs'] = self.stand_legs()
        self.tail(spec, base_pitch=env(t, [(0, 16), (0.12, -22), (0.4, -10)]), sway=[0, 0, 0, 0], droop=-6)
        self.squint(spec, env(t, [(0, 0), (0.07, 0.5), (0.25, 0)]))
        return spec

    def swat(self, t):
        """A quick swat: the paw is up and out on the second frame and hits at 0.1 s; a short recovery."""
        spec = {'rot': {}, 'loc': {}}
        sh = env(t, [(0, 0), (0.06, 1), (0.22, 1), (0.42, 0)])
        self.body(spec, dz=-0.008 * sh, pitch=-3 * sh, roll=-5 * sh, dx=0.01 * sh)
        legs = self.stand_legs()
        p = self.paw_rest['RF'].copy()
        y = env(t, [(0, 0), (0.067, -0.075), (0.1, -0.105), (0.15, -0.1), (0.3, -0.03), (0.43, 0)])
        z = env(t, [(0, 0), (0.067, 0.05), (0.1, 0.03), (0.16, 0.042), (0.32, 0.008), (0.43, 0)])
        x = env(t, [(0, 0), (0.067, 0.012), (0.1, 0.008), (0.43, 0)])
        flex = env(t, [(0, 0), (0.067, 0.45), (0.1, -0.1), (0.2, 0.25), (0.43, 0)])
        legs['RF'] = {'paw': V((p.x + x, p.y + y, p.z + z)), 'met': (self.met_rest['RF'] + V((0, 0.6 * flex, -0.2 * sh))).normalized()}
        spec['legs'] = legs
        self.claws(spec, 0, env(t, [(0, 0), (0.05, 1), (0.2, 1), (0.35, 0)]))
        spec['rot']['spine.004'] = (-10 * sh, 0, -6 * sh)
        spec['rot']['spine.006'] = (4 * sh, 0, -4 * sh)
        spec['rot']['ear.L'] = (0, 0, -20 * sh); spec['rot']['ear.R'] = (0, 0, 20 * sh)
        self.tail(spec, base_pitch=-5, sway=[0, 8 * sh, 12 * sh, 16 * sh], droop=-6)
        return spec


CLIPS = {
    # name: (method, seconds, loop, extras)
    'idle': ('idle', 4.0, True, {'speed': 0.0}),
    'walk': ('walk', WALK[0], True, {'speed': WALK[1]}),
    'trot': ('trot', TROT[0], True, {'speed': TROT[1]}),
    'sit': ('sit', 3.2, True, {'speed': 0.0}),
    'loaf': ('loaf', 4.4, True, {'speed': 0.0}),
    'jump': ('jump', 35 / FPS, False, {'speed': 0.0, 'apex': 0.33, 'launch': 8 / FPS, 'frontContact': 21 / FPS, 'hindContact': 24 / FPS}),
    'jump_takeoff': ('jump_takeoff', 8 / FPS, False, {'speed': 0.0, 'gather': 4 / FPS, 'launch': 8 / FPS}),
    'jump_wiggle': ('jump_wiggle', 0.6, True, {'speed': 0.0}),
    'jump_air': ('jump_air', 0.6, True, {'speed': 0.0, 'airborne': True}),
    'jump_land': ('jump_land', 14 / FPS, False, {'speed': 0.0, 'frontContact': 0.0, 'hindContact': 3 / FPS}),
    'land': ('land', 0.4, False, {'speed': 0.0, 'contact': [0.0]}),
    'swat': ('swat', 13 / FPS, False, {'speed': 0.0, 'contact': [0.1]}),
    'carried': ('carried', 3.0, True, {'speed': 0.0, 'holdNodes': 'hold.L,hold.R', 'holdAt': [0.0, 0.56, 0.0], 'holdBone': 'hold.L', 'lift': 0.56}),
    'carried_dangle': ('carried_dangle', 3.0, True, {'speed': 0.0, 'holdNodes': 'hold.L,hold.R', 'holdAt': [0.0, 0.56, 0.0]}),
    'carried_cradle': ('carried_cradle', 3.0, True, {'speed': 0.0, 'holdNodes': 'cradle.F,cradle.B', 'holdAt': [0.0, 0.42, 0.0]}),
    'squash': ('squash', 2.0, True, {'speed': 0.0, 'flatten': 0.3}),
}


def make_clips(arm, plan, only=None, mesh=None, tempo=1.0, clip_tempo=None):
    """Key every clip. `tempo` speeds up (> 1) or slows down every clip; `clip_tempo` {name: factor}
    on top of it per clip. Time extras (contact, launch...) and speeds follow the tempo."""
    poser = Poser(arm, soft=0.93)          # cat legs: ease well before the full reach (no elbow snaps)
    poser.pole_down = 0.5
    cm = CatMotion(poser, plan)
    if mesh is not None:
        cm.calibrate(arm, mesh)
    acts = {}
    clip_tempo = clip_tempo or {}
    for name, (meth, secs, loop, extras) in CLIPS.items():
        if only and name not in only:
            continue
        k = float(tempo) * float(clip_tempo.get(name, 1.0))
        if loop:
            frames = max(2, int(round(secs / k * FPS)))
            k_eff = secs / (frames / FPS)             # a loop keeps whole cycles: the tempo the frame count gives
        else:
            frames = max(2, int(math.ceil(secs / k * FPS - 1e-6)))
            k_eff = k                                 # a one-shot keeps its timing exactly (it may end a hair later)
        ex = dict(extras, loop=loop, duration=round(frames / FPS, 4))
        if abs(k_eff - 1.0) > 1e-3:
            ex['tempo'] = round(k_eff, 4)
        if ex.get('speed'):
            ex['speed'] = round(ex['speed'] * k_eff, 4)
        for tk in TIME_KEYS:
            if tk in ex:
                v = ex[tk]
                ex[tk] = [round(float(x) / k_eff, 4) for x in v] if isinstance(v, (list, tuple)) else round(float(v) / k_eff, 4)
        bones = None
        if ex.get('partial'):
            bones = [b.name for b in arm.data.bones if b.name.startswith(tuple(ex['partial'].split(',')))]
        acts[name] = key_clip(arm, poser, name, frames, getattr(cm, meth), loop, ex, bones, secs=secs, mesh=mesh, rate=None if loop else k_eff)
    return acts, poser, cm


# the bats, reactions and scratches live in their own module
import anim_bats  # noqa: E402
anim_bats.install(CatMotion, CLIPS)
import anim_idles  # noqa: E402
anim_idles.install(CatMotion, CLIPS)
