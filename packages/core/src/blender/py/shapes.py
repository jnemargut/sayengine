"""Face shape keys for a sculpted head, under the names the studio drives: the 15 speech shapes
(viseme_sil ... viseme_ou, as the side door reads them) and the ARKit-named expressions
(eyeBlinkLeft, mouthSmileLeft, jawOpen...). Each is a smooth displacement field over the head built
from a few mouth/brow/cheek primitives, so lip sync, set-expression and blinks keep working on a
Blender-made person.

Positions are in plan coordinates (x left, f forward, z up); the caller converts to Blender's.
"""
import math
import numpy as np

# the studio's speech shapes as mixes of mouth primitives (same table as rig.ts VISEME_MIX)
VISEME_MIX = {
    'sil': {'press': 0.8}, 'PP': {'press': 1, 'round': 0.12}, 'FF': {'jaw': 0.12, 'tuck': 1, 'upper': 1.1},
    'TH': {'jaw': 0.22, 'wide': 0.15, 'upper': 0.3, 'tongueOut': 1}, 'DD': {'jaw': 0.28, 'wide': 0.35, 'upper': 0.15, 'tongueUp': 0.8},
    'kk': {'jaw': 0.38, 'wide': 0.25, 'upper': 0.1}, 'CH': {'jaw': 0.2, 'round': 0.7, 'upper': 0.4}, 'SS': {'jaw': 0.08, 'wide': 0.6, 'upper': 0.4},
    'nn': {'jaw': 0.2, 'wide': 0.25, 'tongueUp': 1}, 'RR': {'jaw': 0.22, 'round': 0.6}, 'aa': {'jaw': 1, 'wide': 0.2, 'upper': 0.3},
    'E': {'jaw': 0.5, 'wide': 0.65, 'upper': 0.35}, 'ih': {'jaw': 0.28, 'wide': 0.6, 'upper': 0.3}, 'oh': {'jaw': 0.6, 'round': 0.95},
    'ou': {'jaw': 0.22, 'round': 1.3},
}
VISEMES = list(VISEME_MIX)
EXPRESSIONS = ['eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
               'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'cheekSquintLeft', 'cheekSquintRight',
               'noseSneerLeft', 'noseSneerRight', 'mouthPucker', 'mouthClose', 'jawOpen']


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def gauss(p, c, r):
    d = (p - np.asarray(c)) / np.asarray(r)
    return np.exp(-np.einsum('ij,ij->i', d, d))


def rot_x(p, centre, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    q = p - centre
    out = q.copy()
    out[:, 1] = q[:, 1] * c - q[:, 2] * s
    out[:, 2] = q[:, 1] * s + q[:, 2] * c
    return out + centre


class FaceShapes:
    """Displacement fields for one head. `kind` labels each vertex: 'skin', 'lidU.L', 'lidL.R', 'teethU',
    'teethL', 'tongue', 'brow', 'eye' (eyes never move with shapes)."""

    def __init__(self, person, P, kind):
        self.pp = person
        self.P = P
        self.kind = np.asarray(kind)
        hs = person.hs
        self.hs = hs
        M = person.mouth_line
        self.M = M
        rel = (P - person.c) / hs
        self.rel = rel
        x, f, z = P[:, 0], P[:, 1], P[:, 2]
        skin = (self.kind == 'skin') | (self.kind == 'brow')
        # the lower jaw: below a plane from the mouth line back to the hinge, fading down the neck
        tmj = person.tmj
        slope = (tmj[2] - M[2]) / (tmj[1] - M[1])
        zp = M[2] + (f - M[1]) * slope
        jaw = smooth((zp - z) / (0.008 * hs) + 0.5)
        jaw *= smooth((f - (tmj[1] - 0.01 * hs)) / (0.03 * hs))
        jaw *= smooth((z - (M[2] - 0.12 * hs)) / (0.04 * hs))
        jaw = np.where(self.kind == 'teethL', 1.0, np.where(self.kind == 'tongue', 1.0, np.where(skin, jaw, 0.0)))
        self.jaw = jaw
        # lip regions (skin near the mouth, front of the face)
        front = smooth((f - (M[1] - 0.035 * hs)) / (0.012 * hs))
        g = gauss(P, M, np.array([0.034, 0.05, 0.024]) * hs) * front * skin
        self.g_mouth = g
        self.up = g * smooth((z - M[2]) / (0.002 * hs) + 0.5)
        self.lo = g * (1 - smooth((z - M[2]) / (0.002 * hs) + 0.5))
        self.near_slot = np.exp(-((z - M[2]) / (0.0075 * hs)) ** 2) * smooth((np.abs(x) < 0.03 * hs).astype(float)) * front * skin
        self.corner = {sx: gauss(P, person.mouth_corner * np.array([sx, 1, 1]), np.array([0.016, 0.03, 0.014]) * hs) * skin for sx in (1, -1)}
        self.cheek = {sx: gauss(P, person.c + np.array([0.04 * sx, 0.06, -0.025]) * hs, np.array([0.026, 0.04, 0.022]) * hs) * skin for sx in (1, -1)}
        self.brow = {sx: gauss(P, person.c + np.array([0.032 * sx, 0.092, 0.04]) * hs, np.array([0.03, 0.06, 0.018]) * hs) * skin for sx in (1, -1)}
        self.brow_in = {sx: gauss(P, person.c + np.array([0.014 * sx, 0.096, 0.038]) * hs, np.array([0.016, 0.06, 0.02]) * hs) * skin for sx in (1, -1)}
        self.brow_out = {sx: gauss(P, person.c + np.array([0.05 * sx, 0.08, 0.037]) * hs, np.array([0.018, 0.06, 0.018]) * hs) * skin for sx in (1, -1)}
        self.nose_wing = {sx: gauss(P, person.c + np.array([0.012 * sx, 0.096, -0.024]) * hs, np.array([0.012, 0.03, 0.012]) * hs) * skin for sx in (1, -1)}
        self.under_eye = {sx: gauss(P, person.eye_l * np.array([sx, 1, 1]) + np.array([0, 0.008, -0.018]) * hs, np.array([0.02, 0.03, 0.01]) * hs) * skin for sx in (1, -1)}

    def zeros(self):
        return np.zeros_like(self.P)

    # mouth primitives -----------------------------------------------------------------
    def jaw_open(self, a):
        d = self.zeros()
        moved = rot_x(self.P, self.pp.tmj, -20.0 * a)
        return (moved - self.P) * self.jaw[:, None]

    def wide(self, a):
        hs = self.hs; d = self.zeros()
        for sx in (1, -1):
            c = self.corner[sx]
            d[:, 0] += 0.006 * hs * sx * c * a
            d[:, 1] -= 0.003 * hs * c * a
        d[:, 0] += self.rel[:, 0] * 0.1 * hs * self.g_mouth * a
        d[:, 2] -= (self.P[:, 2] - self.M[2]) * 0.25 * self.near_slot * a
        return d

    def round(self, a):
        hs = self.hs; d = self.zeros()
        g = self.g_mouth
        d[:, 0] -= (self.P[:, 0]) * 0.35 * g * a
        d[:, 1] += 0.008 * hs * g * smooth(1 - np.abs(self.rel[:, 0]) / 0.035) * a
        d[:, 2] -= (self.P[:, 2] - self.M[2]) * 0.12 * g * a
        return d

    def press(self, a):
        d = self.zeros()
        d[:, 2] -= (self.P[:, 2] - self.M[2]) * 0.9 * self.near_slot * a
        d[:, 1] -= 0.0015 * self.hs * self.near_slot * a
        return d

    def tuck(self, a):
        d = self.zeros()
        d[:, 1] -= 0.006 * self.hs * self.lo * a
        d[:, 2] += 0.004 * self.hs * self.lo * a
        return d

    def upper(self, a):
        d = self.zeros()
        d[:, 2] += 0.0035 * self.hs * self.up * a
        return d

    def tongue_up(self, a):
        d = self.zeros()
        t = (self.kind == 'tongue').astype(float) * smooth((self.P[:, 1] - (self.M[1] - 0.05 * self.hs)) / (0.03 * self.hs))
        d[:, 2] += 0.008 * self.hs * t * a
        return d

    def tongue_out(self, a):
        d = self.zeros()
        t = (self.kind == 'tongue').astype(float)
        d[:, 1] += 0.016 * self.hs * t * a
        d[:, 2] += 0.002 * self.hs * t * a
        return d

    def viseme(self, v):
        mix = VISEME_MIX[v]
        d = self.zeros()
        prim = {'jaw': lambda a: self.jaw_open(a * 0.55), 'wide': self.wide, 'round': self.round, 'press': self.press, 'tuck': self.tuck,
                'upper': self.upper, 'tongueUp': self.tongue_up, 'tongueOut': self.tongue_out}
        for k, a in mix.items():
            d += prim[k](a)
        return d

    # expressions ------------------------------------------------------------------------
    def blink(self, sx, a=1.0):
        side = 'L' if sx > 0 else 'R'
        d = self.zeros()
        e = self.pp.eye_l * np.array([sx, 1, 1])
        for k, deg in ((f'lidU.{side}', -52.0), (f'lidL.{side}', 14.0)):
            m = self.kind == k
            if m.any():
                d[m] = rot_x(self.P[m], e, deg * a) - self.P[m]
        d[:, 2] -= 0.0018 * self.hs * self.under_eye[sx] * 0 + 0.0015 * self.hs * self.brow[sx] * 0.4 * a
        return d

    def expression(self, name):
        hs = self.hs
        d = self.zeros()
        sx = 1 if name.endswith('Left') else -1
        if name.startswith('eyeBlink'):
            return self.blink(sx)
        if name == 'browInnerUp':
            for s in (1, -1):
                d[:, 2] += 0.0065 * hs * self.brow_in[s]
            return d
        if name.startswith('browDown'):
            d[:, 2] -= 0.0055 * hs * self.brow[sx]
            d[:, 0] -= 0.0025 * hs * sx * self.brow[sx]
            return d
        if name.startswith('browOuterUp'):
            d[:, 2] += 0.0065 * hs * self.brow_out[sx]
            return d
        if name.startswith('mouthSmile'):
            c = self.corner[sx]
            d[:, 0] += 0.0055 * hs * sx * c
            d[:, 1] -= 0.003 * hs * c
            d[:, 2] += 0.0065 * hs * c
            d[:, 2] += 0.003 * hs * self.cheek[sx]
            d[:, 1] += 0.0025 * hs * self.cheek[sx]
            d[:, 2] += 0.0012 * hs * self.under_eye[sx]
            return d
        if name.startswith('mouthFrown'):
            c = self.corner[sx]
            d[:, 2] -= 0.006 * hs * c
            d[:, 0] += 0.0015 * hs * sx * c
            return d
        if name.startswith('cheekSquint'):
            d[:, 2] += 0.0038 * hs * (self.cheek[sx] * 0.6 + self.under_eye[sx])
            return d
        if name.startswith('noseSneer'):
            d[:, 2] += 0.003 * hs * self.nose_wing[sx]
            d[:, 0] += 0.0012 * hs * sx * self.nose_wing[sx]
            d[:, 2] -= 0.0015 * hs * self.brow_in[sx]
            return d
        if name == 'mouthPucker':
            return self.round(1.0)
        if name == 'mouthClose':
            # lips meet while the jaw is open (used together with jawOpen)
            d[:, 2] -= 0.0045 * hs * self.up
            d[:, 2] += 0.0095 * hs * self.lo
            return d
        if name == 'jawOpen':
            return self.jaw_open(1.0)
        raise KeyError(name)

    def all(self):
        out = {}
        for v in VISEMES:
            out[f'viseme_{v}'] = self.viseme(v)
        for e in EXPRESSIONS:
            out[e] = self.expression(e)
        return out
