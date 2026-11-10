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
    def __init__(self, arm):
        self.arm = arm
        self.bones = arm.data.bones
        self.R = {b.name: b.matrix_local.copy() for b in self.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in self.bones}
        self.order = [b.name for b in sorted(self.bones, key=lambda b: len(b.parent_recursive))]
        self.len = {b.name: b.length for b in self.bones}
        self.leg_of = {}
        for k, v in LEGS.items():
            for n in v[:4]:
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
            if leg and leg in legs and n == LEGS[leg][0]:
                self._leg(leg, legs[leg], W, B, spec)
                done.update(LEGS[leg][:4])
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
            if n == 'spine' and 'body_q' not in spec:
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
        b1, b2, b3, b4, pole_sign = LEGS[leg]
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
        da = L * 0.92
        if dist > da:
            dist = da + (L - da) * (1 - math.exp(-(dist - da) / (L - da)))
        dist_c = min(max(dist, abs(l1 - l2) + 1e-4), L * 0.999)
        u = d.normalized()
        body_q = spec.get('body_q', Q())
        pole = body_q @ V((0, pole_sign, 0))
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
        toe = V(tgt.get('toe', body_q @ V((0, -1, -0.15))))
        self._aim(b4, W[b3] @ V((0, self.len[b3], 0)), toe, W, B, max_deg=120)
        for n in (b1, b2, b3, b4):
            pass

    def head_world(self, n, W):
        return W[n].translation.copy()


# ── keying ─────────────────────────────────────────────────────────────────────
def key_clip(arm, poser, name, frames, spec_fn, loop=True, extras=None):
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in range(frames + (1 if loop else 1)):
        t = f / FPS
        spec = spec_fn(t)
        B, _ = poser.solve(spec)
        for n, b in B.items():
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

    def blink(self, spec, closed):
        for s in ('L', 'R'):
            spec['rot'][f'lid.T.{s}'] = (-50 * closed, 0, 0)
            spec['rot'][f'lid.B.{s}'] = (16 * closed, 0, 0)
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
                z = n.z + lift * math.sin(math.pi * s) ** 1.2
                # the paw flips up behind as it lifts (wrist flexes), then reaches forward; continuous
                # with the stance roll at both ends
                k0 = (1 if front else 0.6)
                flex = math.sin(math.pi * s) * (0.9 if front else 0.6)
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
        # lateral sequence: LH, LF, RH, RF a quarter apart; one step per leg per second; direct register
        return self.gait(t, 1.0, {'LH': 0.0, 'LF': 0.25, 'RH': 0.5, 'RF': 0.75}, 0.64, 0.22, 0.026, 0.004, 0.006, 22, 5)

    def trot(self, t):
        # diagonal pairs, tail up
        return self.gait(t, 0.5, {'LH': 0.0, 'RF': 0.0, 'RH': 0.5, 'LF': 0.5}, 0.46, 0.55, 0.04, 0.007, 0.004, 70, 4, head_pitch=-2)

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
        self.body(spec, dz=-drop)
        spec['rot']['belly.C'] = (0, 0, 0)
        spec['scale']['belly.C'] = (1.08, 1.0, 0.92)
        spec['rot']['spine.004'] = (-8, 0, 0); spec['rot']['spine.006'] = (6, 0, 0)
        for s in ('L', 'R'):
            spec['scale'][f'shoulder.{s}'] = (0.82, 0.82, 0.82)
            spec['scale'][f'thigh.{s}'] = (0.8, 0.8, 0.8)
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
        self.blink(spec, 0.55 + 0.45 * bl)      # content, heavy-lidded
        return spec

    def carried(self, t):
        spec = {'rot': {}, 'loc': {}}
        lift = 0.3
        self.body(spec, dz=lift, pitch=-6)
        spec['rot']['spine.001'] = (5, 0, 0); spec['rot']['spine.002'] = (6, 0, 0)
        sway = math.sin(2 * math.pi * t / 2.0)
        for s, sx in (('L', 1), ('R', -1)):
            # limp: the legs hang from the shoulders and hips, paws down and a touch inward
            spec['rot'][f'shoulder.{s}'] = (-4, 0, 0)
            spec['rot'][f'upper_arm.{s}'] = (8 + 3 * sway, 0, -4 * sx)
            spec['rot'][f'forearm.{s}'] = (-6, 0, 0)
            spec['rot'][f'hand.{s}'] = (-20, 0, 0)
            spec['rot'][f'thigh.{s}'] = (-32 + 3 * sway, 0, 6 * sx)
            spec['rot'][f'shin.{s}'] = (38, 0, 0)
            spec['rot'][f'foot.{s}'] = (-12, 0, 0)
        spec['rot']['spine.004'] = (10, 0, 0)
        spec['rot']['spine.006'] = (8, 0, 14 * math.sin(2 * math.pi * t / 4.0))
        self.tail(spec, base_pitch=-62, sway=[0, 3 * sway, 4 * sway, 5 * sway], droop=-4)
        self.breathe(spec, t, 0.5)
        return spec

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

    # one-shots --------------------------------------------------------------
    def jump(self, t):
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        # crouch (0-.35) → push (.35-.47) → air (.47-.92) → land squash (.92-1.08) → recover (1.08-1.4)
        dz = env(t, [(0, 0), (0.33, -0.032), (0.45, 0.01), (0.55, 0.09), (0.72, 0.32), (0.92, 0.04), (1.0, -0.04), (1.12, -0.025), (1.4, 0)])
        pitch = env(t, [(0, 0), (0.33, -6), (0.45, 18), (0.65, 4), (0.88, -14), (1.0, -4), (1.4, 0)])
        self.body(spec, dz=dz, pitch=pitch)
        sq = env(t, [(0, 0), (0.33, 0.06), (0.43, -0.06), (0.6, 0), (0.95, 0), (1.0, 0.11), (1.14, 0.03), (1.4, 0)])
        spec['scale']['root'] = (1 + sq * 0.6, 1 - sq * 0.2, 1 - sq)
        legs = self.stand_legs()
        # in the air the front legs reach for the landing and the hind legs trail; blended smoothly
        air = env(t, [(0.38, 0.0), (0.52, 1.0), (0.84, 1.0), (0.97, 0.0)])
        for k in legs:
            s = 1 if k.endswith('F') else -1
            q = self.paw_rest[k].copy()
            up = V((q.x, q.y - 0.05 * s, q.z + max(dz, 0) + 0.04))
            ground = legs[k]['paw']
            legs[k]['paw'] = ground.lerp(up, air) if dz > 0 or air > 0 else ground
            legs[k]['met'] = (self.met_rest[k] + V((0, (0.5 if s > 0 else -0.6) * air, 0))).normalized()
            lifted = max(0.0, min(1.0, (legs[k]['paw'].z - q.z) / 0.03))
            if lifted > 0:
                # never below the floor while the body is low
                legs[k]['paw'].z = max(legs[k]['paw'].z, q.z)
        spec['legs'] = legs
        spec['rot']['spine.004'] = (env(t, [(0, 0), (0.33, -10), (0.5, 8), (0.9, -6), (1.4, 0)]), 0, 0)
        self.tail(spec, base_pitch=env(t, [(0, -10), (0.45, 40), (0.9, 20), (1.4, -10)]), sway=[0, 0, 0, 0], droop=env(t, [(0, -8), (0.5, 6), (1.4, -8)]))
        return spec

    def land(self, t):
        spec = {'rot': {}, 'loc': {}, 'scale': {}}
        dz = env(t, [(0, 0.0), (0.08, -0.045), (0.22, -0.03), (0.5, 0)])
        sq = env(t, [(0, 0.0), (0.08, 0.11), (0.22, 0.03), (0.5, 0)])
        self.body(spec, dz=dz, pitch=env(t, [(0, -10), (0.1, -4), (0.5, 0)]))
        spec['scale']['root'] = (1 + sq * 0.6, 1 - sq * 0.2, 1 - sq)
        spec['legs'] = self.stand_legs()
        self.tail(spec, base_pitch=env(t, [(0, 20), (0.5, -10)]), sway=[0, 0, 0, 0], droop=-6)
        return spec

    def swat(self, t):
        spec = {'rot': {}, 'loc': {}}
        sh = env(t, [(0, 0), (0.25, 1), (0.75, 1), (1.0, 0)])
        self.body(spec, dz=-0.01 * sh, dy=-0.0, pitch=-4 * sh, roll=-5 * sh, dx=0.01 * sh)
        legs = self.stand_legs()
        p = self.paw_rest['RF'].copy()
        y = env(t, [(0, 0), (0.28, -0.05), (0.42, -0.13), (0.5, -0.135), (0.8, -0.02), (1.0, 0)])
        z = env(t, [(0, 0), (0.28, 0.07), (0.42, 0.035), (0.5, 0.03), (0.65, 0.055), (0.85, 0.0), (1.0, 0)])
        x = env(t, [(0, 0), (0.3, 0.02), (0.45, 0.01), (1.0, 0)])
        flex = env(t, [(0, 0), (0.28, 1.0), (0.42, -0.2), (0.6, 0.3), (1.0, 0)])
        legs['RF'] = {'paw': V((p.x + x, p.y + y, p.z + z)), 'met': (self.met_rest['RF'] + V((0, 0.6 * flex, -0.2 * sh))).normalized()}
        spec['legs'] = legs
        spec['rot']['spine.004'] = (-10 * sh, 0, -6 * sh)
        spec['rot']['spine.006'] = (4 * sh, 0, -4 * sh)
        spec['rot']['ear.L'] = (0, 0, -20 * sh); spec['rot']['ear.R'] = (0, 0, 20 * sh)
        self.tail(spec, base_pitch=-5, sway=[0, 8 * sh, 12 * sh, 18 * math.sin(6 * t) * sh], droop=-6)
        return spec


CLIPS = {
    # name: (method, seconds, loop, extras)
    'idle': ('idle', 4.0, True, {'speed': 0.0}),
    'walk': ('walk', 1.0, True, {'speed': 0.22}),
    'trot': ('trot', 1.0, True, {'speed': 0.55}),
    'sit': ('sit', 3.2, True, {'speed': 0.0}),
    'loaf': ('loaf', 4.4, True, {'speed': 0.0}),
    'jump': ('jump', 1.4, False, {'speed': 0.0, 'apex': 0.32}),
    'land': ('land', 0.5, False, {'speed': 0.0}),
    'swat': ('swat', 1.0, False, {'speed': 0.0}),
    'carried': ('carried', 4.0, True, {'speed': 0.0, 'holdBone': 'spine.002', 'lift': 0.3}),
    'squash': ('squash', 2.0, True, {'speed': 0.0, 'flatten': 0.3}),
}


def make_clips(arm, plan, only=None, mesh=None):
    poser = Poser(arm)
    cm = CatMotion(poser, plan)
    if mesh is not None:
        cm.calibrate(arm, mesh)
    acts = {}
    for name, (meth, secs, loop, extras) in CLIPS.items():
        if only and name not in only:
            continue
        frames = int(round(secs * FPS))
        acts[name] = key_clip(arm, poser, name, frames, getattr(cm, meth), loop, dict(extras, loop=loop, duration=secs))
    return acts, poser, cm
