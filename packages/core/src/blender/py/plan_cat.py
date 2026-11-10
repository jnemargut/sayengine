"""The cat body plan: skeleton, masses and face parts from a few proportions.

Coordinates here are (x, f, z) in metres: x to the cat's left, f forward, z up, ground at z = 0.
`to_blender` turns them into Blender's frame (the cat faces -Y, as Rigify's metarigs do).

Proportions (all 0..1 or scale factors around 1):
  build       0 lean .. 1 very fat (barrel width, belly hang, haunches, jowls)
  leg_length  scale on the visible leg (0.8 short .. 1.2 long)
  body_length scale on the barrel length
  head_size   scale on the head
"""
import numpy as np
import sdf


def lerp(a, b, t):
    return a + (b - a) * t


def to_blender(p):
    p = np.asarray(p, float)
    if p.ndim == 1:
        return np.array([p[0], -p[1], p[2]])
    return np.stack([p[:, 0], -p[:, 1], p[:, 2]], axis=1)


def from_blender(p):
    return to_blender(p)  # the flip is its own inverse


PRESETS = {
    # breed shapes; build/leg/body scale on top of these
    'british-shorthair': dict(head_width=1.0, jowls=1.0, muzzle=0.6, ear=0.95, ear_round=0.45, eye=1.0, tail=0.92, head=1.1, length=0.92, cobby=1.0,
                              coat='#787d86', pattern='solid', eye_color='#c9771f', nose='#5d6370', inner_ear='#8a7d86'),
    'domestic-shorthair': dict(head_width=0.85, jowls=0.5, muzzle=1.0, ear=1.0, ear_round=0.4, eye=0.9, tail=1.15, cobby=0.6, head=0.95, length=1.05,
                               coat='#8a7a66', pattern='tabby', eye_color='#9fae3b', nose='#b8797a', inner_ear='#c79a98'),
}


class Cat:
    def __init__(self, params):
        pr = dict(PRESETS.get(params.get('preset', 'british-shorthair'), PRESETS['british-shorthair']))
        self.breed = pr
        b = float(params.get('build', 0.85))
        self.build = b
        L = float(params.get('leg_length', 1.0))
        B = float(params.get('body_length', 1.0)) * pr.get('length', 1.0)
        H = float(params.get('head_size', 1.0)) * pr.get('head', 1.0)
        cob = pr['cobby']
        self.leg = L
        # ── the barrel: a station table (t rump→chest, top, bottom, half width) ──────────
        # measured off side photos of a fat BSH: the barrel is barely longer than it is tall, the
        # belly hangs to a fifth of the back height (lowest just behind the middle), the chest is deep
        # and the back is short and level. Lean cats lift the belly and narrow the barrel.
        fat = np.array([
            (0.00, 0.232, 0.165, 0.060),
            (0.10, 0.262, 0.105, 0.095),
            (0.25, 0.279, 0.068, 0.120),
            (0.45, 0.283, 0.056, 0.128),
            (0.62, 0.283, 0.068, 0.124),
            (0.78, 0.281, 0.094, 0.112),
            (0.90, 0.271, 0.116, 0.096),
            (1.00, 0.246, 0.146, 0.070)])
        lean = fat.copy()
        lean[:, 2] = np.maximum(fat[:, 2], 0.12) + 0.01
        lean[:, 3] = fat[:, 3] * 0.62
        fat[:, 3] *= 1.07
        lean[:, 1] = fat[:, 1] - 0.012
        tab = lean + (fat - lean) * b
        lift = 0.09 * (L - 1)                       # longer legs lift the whole barrel
        fr, fl = -0.20 * B, 0.18 * B
        self.stations = [(lerp(fr, fl, t), tz + lift, bz + lift, ww) for t, tz, bz, ww in tab]
        top = float(tab[3, 1]) + lift
        w = float(tab[3, 3])
        self.top = top
        self.belly = float(tab[3, 2]) + lift
        # ── skeleton joints (x, f, z), left side; mirrored for right ──────────────────
        hip_f = -0.125 * B
        sh_f = 0.125 * B
        self.j = j = {}
        j['pelvis'] = np.array([0, fr + 0.045, top - 0.045])
        j['spine_end'] = np.array([0, sh_f, top - 0.045])
        hd = 1.0 * H
        self.hs = hd
        neck_base = j['spine_end']
        head_c = np.array([0, fl + 0.02 * hd, top - 0.02 + 0.02 * (1 - b)])
        self.head_c = head_c
        j['neck1'] = neck_base + np.array([0, 0.02, 0.02])
        j['head0'] = head_c + np.array([0, -0.015, -0.012]) * hd
        j['head1'] = head_c + np.array([0, 0.03, 0.035]) * hd
        # front leg: a column under the chest (narrow track)
        lx = 0.052 + 0.012 * b
        j['scap'] = np.array([0.03, sh_f - 0.035, top - 0.02])
        j['shoulder'] = np.array([lx, sh_f + 0.012, top - 0.12])
        j['elbow'] = np.array([lx, sh_f - 0.012, 0.035 + 0.085 * L + lift * 0.5])
        j['wrist'] = np.array([lx * 0.98, sh_f + 0.004, 0.036])
        j['fpaw'] = np.array([lx * 0.98, sh_f + 0.022, 0.012])
        j['ftoe'] = np.array([lx * 0.98, sh_f + 0.045, 0.006])
        # hind leg: the thigh is the haunch mass; hock and metatarsal show below it
        hx = 0.056 + 0.014 * b
        j['hip'] = np.array([hx * 0.85, hip_f, top - 0.085])
        j['knee'] = np.array([hx, hip_f + 0.045, 0.04 + 0.085 * L + lift * 0.5])
        j['hock'] = np.array([hx * 0.97, hip_f - 0.05, 0.03 + 0.028 * L])
        j['rpaw'] = np.array([hx * 0.97, hip_f - 0.034, 0.012])
        j['rtoe'] = np.array([hx * 0.97, hip_f - 0.01, 0.006])
        # tail: thick, rounded tip, hanging back and down at rest
        tl = 0.23 * pr['tail']
        base = np.array([0, fr + 0.02, top - 0.065])
        self.tail = [base,
                     base + np.array([0, -0.28, -0.12]) * tl,
                     base + np.array([0, -0.55, -0.30]) * tl,
                     base + np.array([0, -0.76, -0.50]) * tl,
                     base + np.array([0, -0.90, -0.68]) * tl]
        self.tail_r = [0.034 + 0.006 * b, 0.031 + 0.004 * b, 0.029 + 0.003 * b, 0.027 + 0.002 * b, 0.025]
        # ── the head (BSH: very round, wider than tall, full jowls, puffy whisker pads) ──
        hw = pr['head_width'] * hd
        jw = pr['jowls'] * (0.6 + 0.4 * b)
        c = head_c
        self.head_parts = dict(
            cranium=(c + np.array([0, -0.008, 0.008]) * hd, np.array([0.058 * hw, 0.05, 0.046]) * hd),
            temple=(c + np.array([0.03 * hw, -0.012, 0.02]) * hd, np.array([0.036 * hw, 0.04, 0.032]) * hd),
            jowl=(c + np.array([0.038 * hw, 0.004, -0.021]) * hd, np.array([0.04 * hw, 0.038, 0.034]) * hd * (0.85 + 0.2 * jw)),
            pad=(c + np.array([0.0128, 0.0465, -0.022]) * hd, 0.0168 * hd * (0.95 + 0.1 * jw)),
            chin=(c + np.array([0, 0.038, -0.036]) * hd, np.array([0.013, 0.011, 0.009]) * hd),
            bridge=(c + np.array([0, 0.040, -0.002]) * hd, np.array([0.016, 0.011, 0.013]) * hd * (0.9 + 0.3 * pr['muzzle'])),
        )
        er = 0.0135 * pr['eye'] * hd
        self.eye_r = er
        self.eyes = c + np.array([0.0245 * hw, 0.0385, 0.008]) * hd       # left eye centre
        self.eye_dir = np.array([0.2, 1.0, 0.02]); self.eye_dir /= np.linalg.norm(self.eye_dir)
        self.nose = c + np.array([0, 0.0545, -0.004]) * hd
        self.mouth = c + np.array([0, 0.052, -0.028]) * hd
        # ears: small, wide-set, round-tipped, on the top corners, tilted out
        es = pr['ear'] * hd
        self.ear_base = c + np.array([0.041 * hw, -0.005, 0.037]) * hd
        self.ear_size = (0.044 * es, 0.046 * es, 0.008 * es)         # base width, height, thickness
        self.ear_tilt = np.radians(33)                                # outward
        self.ear_round = pr['ear_round']
        # the neck ruff sinks the head into the chest
        self.ruff = (np.array([0, fl - 0.04, top - 0.055]), np.array([0.07 + 0.015 * b, 0.05, 0.06]))
        # haunch masses
        self.haunch = (np.array([hx * 0.9, hip_f - 0.005, top - 0.125]), np.array([0.05 + 0.012 * b, 0.07, 0.085]))
        self.paw_r = (0.026 + 0.003 * b, 0.031, 0.016)
        self.place_eyes()

    def place_eyes(self, depth=0.55):
        """Seat each eyeball so the face meets it about 65 degrees off the gaze: a big, round, open
        eye that sits in the face rather than bulging out of it."""
        d = self.eye_dir; e0 = self.eyes.copy()
        f = lambda t: float(self.head_sdf(np.array([e0 + d * t]), sockets=False)[0])
        lo, hi = -0.04, 0.06
        for _ in range(40):
            mid = 0.5 * (lo + hi)
            if f(mid) < 0:
                lo = mid
            else:
                hi = mid
        self.eyes = e0 + d * lo - d * depth * self.eye_r
        # the nose leather sits on the face, just below the bridge
        nd = np.array([0, 1.0, -0.3]); nd /= np.linalg.norm(nd)
        n0 = self.head_c + np.array([0, 0.0, -0.002]) * self.hs
        g = lambda t: float(self.head_sdf(np.array([n0 + nd * t]), sockets=False)[0])
        lo, hi = 0.0, 0.12
        for _ in range(40):
            mid = 0.5 * (lo + hi)
            if g(mid) < 0:
                lo = mid
            else:
                hi = mid
        self.nose = n0 + nd * (lo - 0.0012)

    # ── the shape ────────────────────────────────────────────────────────────────
    def legs_sdf(self, q, side):
        j = self.j
        m = np.array([side, 1, 1])
        fr = sdf.chain(q, [j['shoulder'] * m, j['elbow'] * m, j['wrist'] * m], [0.044, 0.032, 0.027], 0.0)
        fpaw = sdf.ellipsoid(q, (j['fpaw'] + np.array([0, 0.004, 0.004])) * m, self.paw_r)
        front = sdf.smin(fr, fpaw, 0.012)
        hi = sdf.chain(q, [j['hip'] * m, j['knee'] * m], [0.05, 0.036], 0.0)
        lo = sdf.chain(q, [j['knee'] * m, j['hock'] * m, j['rpaw'] * m], [0.04, 0.029, 0.026], 0.0)
        hind = sdf.smin(hi, lo, 0.02)
        rpaw = sdf.ellipsoid(q, (j['rpaw'] + np.array([0, 0.008, 0.003])) * m, (self.paw_r[0] * 0.95, self.paw_r[1] * 1.0, self.paw_r[2]))
        hind = sdf.smin(hind, rpaw, 0.012)
        return front, hind

    def head_sdf(self, q, sockets=True):
        hp = self.head_parts
        d = sdf.ellipsoid(q, *hp['cranium'])
        for s in (1, -1):
            m = np.array([s, 1, 1])
            d = sdf.smin(d, sdf.ellipsoid(q, hp['jowl'][0] * m, hp['jowl'][1]), 0.022 * self.hs)
            d = sdf.smin(d, sdf.ellipsoid(q, hp['temple'][0] * m, hp['temple'][1]), 0.02 * self.hs)
        pads = None
        for s in (1, -1):
            m = np.array([s, 1, 1])
            ps = sdf.sphere(q, hp['pad'][0] * m, hp['pad'][1])
            pads = ps if pads is None else sdf.smin(pads, ps, 0.004)
        pads = sdf.smin(pads, sdf.ellipsoid(q, *hp['chin']), 0.006)
        pads = sdf.smin(pads, sdf.ellipsoid(q, *hp['bridge']), 0.008)
        d = sdf.smin(d, pads, 0.012 * self.hs)
        # eye sockets: the lids and brow wrap the eyeballs
        for s in ((1, -1) if sockets else ()):
            m = np.array([s, 1, 1])
            sock = sdf.sphere(q, self.eyes * m, self.eye_r * 1.02)
            d = sdf.smax(d, -sock, 0.004)
        # a soft crease under the pads (the mouth line) and a shallow stop between the eyes
        return d

    def field_coarse(self, p):
        """The same form without the eye sockets: a calmer surface to lay the topology on."""
        return self.field(p, sockets=False)

    def field(self, p, sockets=True):
        """Signed distance in Blender coordinates."""
        q = from_blender(p)
        q_abs = q.copy(); q_abs[:, 0] = np.abs(q[:, 0])
        body = sdf.loft(q, self.stations, fsign=1.0)
        body = sdf.smin(body, sdf.ellipsoid(q_abs, *self.haunch), 0.05)
        body = sdf.smin(body, sdf.ellipsoid(q, *self.ruff), 0.04)
        front, hind = self.legs_sdf(q_abs, 1)
        body = sdf.smin(body, front, 0.035)
        body = sdf.smin(body, hind, 0.04)
        tail = sdf.chain(q, self.tail, self.tail_r, 0.0)
        body = sdf.smin(body, tail, 0.03)
        head = self.head_sdf(q_abs, sockets)
        return sdf.smin(body, head, 0.016)

    # ── the skin-modifier skeleton (rough form; the field sculpts it) ─────────────────
    def skin_skeleton(self):
        j = self.j
        verts, edges, radii = [], [], []
        def add(p, r, parent=None):
            verts.append(to_blender(p)); radii.append(r)
            i = len(verts) - 1
            if parent is not None:
                edges.append((parent, i))
            return i
        st = self.stations
        # spine through the barrel (densely, so the torso gets many rings)
        n = 9
        fs = np.linspace(st[0][0] + 0.01, st[-1][0] - 0.005, n)
        prev = None
        idx = []
        for f in fs:
            top = np.interp(f, [s[0] for s in st], [s[1] for s in st])
            bot = np.interp(f, [s[0] for s in st], [s[2] for s in st])
            ww = np.interp(f, [s[0] for s in st], [s[3] for s in st])
            r = (ww * 0.9, 0.5 * (top - bot) * 0.9)
            prev = add(np.array([0, f, 0.5 * (top + bot)]), r, prev)
            idx.append(prev)
        chest = idx[-1]
        # neck and head (a few rings so the face gets loops)
        c = self.head_c
        nb = add(np.array([0, st[-1][0] + 0.01, self.top - 0.03]), (0.07, 0.065), chest)
        h0 = add(c + np.array([0, -0.025, 0]), (0.06, 0.05), nb)
        h1 = add(c + np.array([0, 0.012, -0.005]), (0.06, 0.048), h0)
        h2 = add(c + np.array([0, 0.045, -0.015]), (0.035, 0.03), h1)
        h3 = add(c + np.array([0, 0.062, -0.018]), (0.018, 0.016), h2)
        # legs from the nearest spine ring
        def nearest(f):
            return idx[int(np.argmin([abs(x - f) for x in fs]))]
        for s in (1, -1):
            m = np.array([s, 1, 1])
            a = add(j['shoulder'] * m + np.array([0, 0, 0.02]), (0.04, 0.04), nearest(j['shoulder'][1]))
            e = add(j['elbow'] * m, (0.028, 0.028), a)
            wr = add(j['wrist'] * m, (0.022, 0.022), e)
            add(j['fpaw'] * m + np.array([0, 0.008, 0.002]), (0.022, 0.016), wr)
            h = add(j['hip'] * m, (0.05, 0.05), nearest(j['hip'][1]))
            k = add(j['knee'] * m, (0.035, 0.035), h)
            ho = add(j['hock'] * m, (0.021, 0.021), k)
            add(j['rpaw'] * m + np.array([0, 0.01, 0.002]), (0.02, 0.015), ho)
        # tail
        t = add(self.tail[0], (self.tail_r[0], self.tail_r[0]), idx[0])
        for p, r in zip(self.tail[1:], self.tail_r[1:]):
            t = add(p, (r * 0.9, r * 0.9), t)
        return np.array(verts), edges, radii, idx[0]
