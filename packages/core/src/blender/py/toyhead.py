"""A cartoon head for the person plan's toy style: a big soft head whose features are simple shapes that act.

Everything a face reads by at a distance is its own bold shape: oval ink eyes under skin lids, thick brows, a
round nose, a mouth that is a dark line until it opens, ears, a clean cap of hair, thin round glasses. The face
shapes carry the studio's usual names (eyeBlinkLeft, browDownLeft, mouthSmileLeft, jawOpen, viseme_aa...), so
anything that drives the kit face drives this one. Each feature is laid out in the face plane (x across, z up)
and dropped onto the head's surface along the forward axis; a shape key is the same layout with other
parameters, so brows slide over the forehead and the mouth opens on the face without leaving it.

Coordinates here are the person plan's (x left, f forward, z up); meshes are made in Blender's.
"""
import math
import bpy
import numpy as np
import sdf
import body
import parts
import plan_person as pp

VISEMES = {  # name: (open, wide, pucker)
    'viseme_sil': (0, 1, 0), 'viseme_PP': (0, 0.9, 0.1), 'viseme_FF': (0.12, 1.0, 0), 'viseme_TH': (0.18, 1.0, 0), 'viseme_DD': (0.22, 1.0, 0),
    'viseme_kk': (0.28, 1.0, 0), 'viseme_CH': (0.2, 0.9, 0.35), 'viseme_SS': (0.1, 1.12, 0), 'viseme_nn': (0.12, 1.0, 0), 'viseme_RR': (0.16, 0.9, 0.3),
    'viseme_aa': (0.75, 1.0, 0), 'viseme_E': (0.3, 1.15, 0), 'viseme_ih': (0.22, 1.1, 0), 'viseme_oh': (0.55, 0.85, 0.5), 'viseme_ou': (0.28, 0.8, 0.9),
}
SHAPES = list(VISEMES) + ['eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
                          'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight',
                          'mouthPucker', 'mouthClose', 'jawOpen']


class ToyHead:
    def __init__(self, person, height=0.40):
        self.P = person
        k = height / 0.40
        self.k = k
        base = np.asarray(person.j['Head'], float)
        self.C = base + np.array([0, 0.022, 0.198]) * k
        C = self.C
        self.skull = (C, np.array([0.155, 0.150, 0.190]) * k)
        self.jaw = (C + np.array([0, 0.012, -0.078]) * k, np.array([0.166, 0.142, 0.112]) * k)
        self.ear = (C + np.array([0.160, -0.012, -0.022]) * k, np.array([0.026, 0.038, 0.05]) * k)
        self.neck = (np.asarray(person.j['Neck'], float) + np.array([0, 0.0, -0.03]), C + np.array([0, -0.02, -0.14]) * k, 0.062 * k)
        self.eye_x = 0.064 * k
        self.eye_z = C[2] + 0.004 * k
        self.brow_z = C[2] + 0.086 * k
        self.mouth_z = C[2] - 0.108 * k
        self.nose_z = C[2] - 0.036 * k

    # ── the skin field and the surface under a face-plane point ─────────────────────────────
    def skin(self, q):
        d = sdf.ellipsoid(q, *self.skull)
        d = sdf.smin(d, sdf.ellipsoid(q, *self.jaw), 0.05 * self.k)
        qa = q.copy(); qa[:, 0] = np.abs(qa[:, 0])
        d = sdf.smin(d, sdf.ellipsoid(qa, *self.ear), 0.012 * self.k)
        a, b, r = self.neck
        d = sdf.smin(d, sdf.round_cone(q, a, b, r, r), 0.02 * self.k)
        return d

    def face(self, q):
        """the skull and jaw only (features sit on this, not on the ears or neck)"""
        return sdf.smin(sdf.ellipsoid(q, *self.skull), sdf.ellipsoid(q, *self.jaw), 0.05 * self.k)

    def surf(self, x, z, lift=0.0):
        """Plan points on the face under (x, z): the surface along the forward axis, plus `lift` forward."""
        x = np.asarray(x, float); z = np.asarray(z, float)
        lo = np.full(x.shape, self.C[1]); hi = lo + 0.4 * self.k
        for _ in range(34):
            mid = 0.5 * (lo + hi)
            ins = self.face(np.stack([x, mid, z], -1).reshape(-1, 3)).reshape(x.shape) < 0
            lo = np.where(ins, mid, lo); hi = np.where(ins, hi, mid)
        return np.stack([x, lo + lift, z], -1)

    def hair(self, q):
        C, k = self.C, self.k
        d = sdf.ellipsoid(q, C + np.array([0, -0.012, 0.012]) * k, np.array([0.164, 0.161, 0.196]) * k)
        # a clean hairline: high over the forehead, down behind the ears to the nape
        line = (C[2] + 0.02 * k + 0.80 * (q[:, 1] - C[1])) - q[:, 2]
        d = sdf.smax(d, line, 0.012 * k)
        d = sdf.smin(d, sdf.ellipsoid(q, C + np.array([0.015, 0.098, 0.168]) * k, np.array([0.115, 0.062, 0.04]) * k), 0.03 * k)   # the quiff
        return d

    def nose(self, q):
        p = self.surf(np.array([0.0]), np.array([self.nose_z]))[0]
        return sdf.ellipsoid(q, p + np.array([0, 0.008, 0]) * self.k, np.array([0.03, 0.034, 0.028]) * self.k)

    # ── feature layouts (face-plane points per vertex, for a given expression) ─────────────────
    def eye_pts(self, sx, grid, blink=0.0, wide=0.0, squint=0.0):
        """the ink eye: an oval; a blink flattens it to a line, a squint lifts its lower edge"""
        k = self.k
        rw, rh = 0.0145 * k * (1 + 0.1 * wide), 0.023 * k * (1 + 0.18 * wide)
        u, v = grid[:, 0], grid[:, 1]
        vv = np.where(v < 0, v * (1 - 0.55 * squint), v) * (1 - 0.9 * blink)
        z = self.eye_z + vv * rh - 0.007 * k * blink
        return self.surf(sx * self.eye_x + u * rw, z, 0.0034 * k)

    def lid_pts(self, sx, grid, blink=0.0, wide=0.0):
        """the upper lid: a skin half-oval that hangs over the top of the eye (a tired, kind eye at rest)"""
        k = self.k
        rw, rh = 0.019 * k, 0.027 * k
        u, v = grid[:, 0], grid[:, 1]                    # v in 0..1: the lid's lower edge to its top
        low = 0.6 - 0.45 * wide - 1.3 * blink           # where the lid's edge sits, in eye radii above the centre
        edge = self.eye_z + low * 0.023 * k - 0.004 * k * (1 - u * u) * 0  # straight edge
        top = self.eye_z + rh * np.sqrt(np.clip(1 - u * u, 0, 1)) * 1.02
        top = np.maximum(top, edge + 0.0005)
        z = edge + (top - edge) * v
        return self.surf(sx * self.eye_x + u * rw, z, 0.0052 * k)

    def brow_pts(self, sx, grid, down=0.0, inner_up=0.0, outer_up=0.0):
        """a thick brow: `grid` is (t along -1 inner..1 outer, angle round the tube)"""
        k = self.k
        t, a = grid[:, 0], grid[:, 1]
        L, r = 0.036 * k, 0.0105 * k
        zc = self.brow_z - 0.013 * k * down + 0.006 * k * outer_up + 0.004 * k * inner_up
        tilt = -0.16 + 0.42 * down - 0.5 * inner_up + 0.34 * outer_up     # the outer end's slope (rest: a little down: kind)
        arch = 0.006 * k * (1 - t * t)
        z0 = zc + t * L * tilt + arch
        x0 = sx * (self.eye_x + t * L + 0.002 * k)
        rr = r * (1 - 0.35 * np.abs(t) ** 3)
        p = self.surf(x0, z0 + np.sin(a) * rr, 0.0)
        p[:, 1] += 0.009 * k + np.cos(a) * rr * 0.9
        return p

    def mouth_pts(self, grid, open_=0.0, wide=1.0, pucker=0.0, smile=(0.0, 0.0), frown=(0.0, 0.0)):
        """`grid` is (u -1 right..1 left, row): rows 0 the upper lip's outer edge, 1 its inner edge, 2 the
        teeth's lower edge, 3 the lower lip's inner edge, 4 its outer edge"""
        k = self.k
        u, row = grid[:, 0], grid[:, 1].astype(int)
        W = 0.046 * k * wide * (1 - 0.5 * pucker)
        side = np.where(u > 0, 1.0, 0.0)
        sm = smile[0] * side + smile[1] * (1 - side)
        fr = frown[0] * side + frown[1] * (1 - side)
        c2 = u * u
        mid = self.mouth_z + 0.005 * k * c2 + 0.02 * k * sm * c2 - 0.017 * k * fr * c2 + 0.004 * k * (sm - fr) * 0
        gap = (0.0008 * k + 0.036 * k * open_ + 0.012 * k * pucker) * np.clip(1 - c2, 0, 1) ** 0.8   # never quite shut: a face with no area is dropped on export
        up = mid + 0.004 * k * pucker * (1 - c2)
        lo = up - gap
        t = 0.0048 * k * np.sqrt(np.clip(1 - c2 * c2, 0, 1)) + 0.0008 * k
        teeth = up - np.minimum(gap * 0.34, 0.007 * k)
        z = np.select([row == 0, row == 1, row == 2, row == 3, row == 4], [up + t, up, teeth, lo, lo - t])
        x = u * (W + 0.006 * k * sm * np.abs(u))
        return self.surf(x, z, 0.0045 * k + 0.004 * k * pucker * (1 - c2))   # clear of the remeshed skin, which strays a few mm from the field

    def bag_pts(self, sx, grid):
        k = self.k
        t, a = grid[:, 0], grid[:, 1]
        r = 0.0022 * k
        x0 = sx * (self.eye_x + t * 0.02 * k)
        z0 = self.eye_z - 0.036 * k + 0.008 * k * t * t
        p = self.surf(x0, z0 + np.sin(a) * r, 0.0)
        p[:, 1] += 0.0025 * k + np.cos(a) * r * 0.6
        return p


def _disc(rings=4, segs=18):
    pts = [(0.0, 0.0)]
    for r in range(1, rings + 1):
        for s in range(segs):
            an = 2 * math.pi * s / segs
            pts.append((math.cos(an) * r / rings, math.sin(an) * r / rings))
    faces = [(0, 1 + s, 1 + (s + 1) % segs) for s in range(segs)]
    for r in range(1, rings):
        for s in range(segs):
            a = 1 + (r - 1) * segs + s; b = 1 + (r - 1) * segs + (s + 1) % segs
            faces.append((a, a + segs, b + segs, b))
    return np.array(pts), faces


def _half(cols=13, rows=4):
    pts, faces = [], []
    for j in range(rows + 1):
        for i in range(cols):
            pts.append((-1 + 2 * i / (cols - 1), j / rows))
    for j in range(rows):
        for i in range(cols - 1):
            a = j * cols + i
            faces.append((a, a + 1, a + cols + 1, a + cols))
    return np.array(pts), faces


def _tube_grid(n=11, sides=8):
    pts, faces = [], []
    for i in range(n):
        for s in range(sides):
            pts.append((-1 + 2 * i / (n - 1), 2 * math.pi * s / sides))
    for i in range(n - 1):
        for s in range(sides):
            s2 = (s + 1) % sides
            faces.append((i * sides + s, (i + 1) * sides + s, (i + 1) * sides + s2, i * sides + s2))
    faces.append(tuple(range(sides)))
    faces.append(tuple(range((n - 1) * sides + sides - 1, (n - 1) * sides - 1, -1)))
    return np.array(pts), faces


def _mouth_grid(cols=19):
    pts, faces = [], []
    for row in range(5):
        for i in range(cols):
            pts.append((-1 + 2 * i / (cols - 1), row))
    band = []
    for row in range(4):
        for i in range(cols - 1):
            a = row * cols + i
            faces.append((a, a + cols, a + cols + 1, a + 1))
            band.append(row)
    return np.array(pts), faces, band


def _mesh(name, plan_pts, faces, flip=False):
    me = bpy.data.meshes.new(name)
    V = pp.to_blender(np.asarray(plan_pts))
    if flip:
        faces = [tuple(reversed(f)) for f in faces]
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in faces])
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    for poly in me.polygons:
        poly.use_smooth = True
    return ob


def _key(ob, name, plan_pts):
    """store a shape as a delta attribute (it becomes a shape key after the parts are joined)"""
    me = ob.data
    base = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', base)
    a = me.attributes.new('sk_' + name, 'FLOAT_VECTOR', 'POINT')
    a.data.foreach_set('vector', (pp.to_blender(np.asarray(plan_pts)).reshape(-1) - base))


def _outward(ob, centre_b):
    """make every face point away from the head's centre"""
    me = ob.data
    flip = [p.index for p in me.polygons if (np.array(p.center) - centre_b) @ np.array(p.normal) < 0]
    if len(flip) > len(me.polygons) / 2:
        me.flip_normals()


def build(person, name, mats, height=0.40, faces=2600):
    """mats: {skin, nose, hair, ink, white, mouth, line, frames} (Blender materials).
    Returns (face object with the shape keys, glasses object, landmarks, shape names)."""
    H = ToyHead(person, height)
    k = H.k; C = H.C
    F = lambda fn: (lambda p: fn(pp.from_blender(p)))
    tb = pp.to_blender
    lo = tb(C + np.array([-0.26, -0.26, -0.32]) * k); hi = tb(C + np.array([0.26, 0.26, 0.3]) * k)
    lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
    skin, _ = body.build_surface(f'{name}-skin', F(H.skin), lo, hi, 0.006 * k, faces)
    skin.data.materials.append(mats['skin'])
    hair, _ = body.build_surface(f'{name}-hair', F(H.hair), lo, hi, 0.006 * k, 1400)
    hair.data.materials.append(mats['hair'])
    np_ = H.surf(np.array([0.0]), np.array([H.nose_z]))[0]
    nlo = tb(np_ + np.array([-0.06, -0.06, -0.06]) * k); nhi = tb(np_ + np.array([0.06, 0.07, 0.06]) * k)
    nose, _ = body.build_surface(f'{name}-nose', F(H.nose), np.minimum(nlo, nhi), np.maximum(nlo, nhi), 0.003 * k, 260)
    nose.data.materials.append(mats['nose'])
    _key(nose, 'noseSneerLeft', pp.from_blender(body.get_co(nose)) + np.array([0, 0, 0.003 * k]))
    _key(nose, 'noseSneerRight', pp.from_blender(body.get_co(nose)) + np.array([0, 0, 0.003 * k]))
    obs = [skin, hair, nose]
    Cb = tb(C)
    for sx, side in ((1, 'Left'), (-1, 'Right')):
        g, f = _disc()
        eye = _mesh(f'{name}-eye{side}', H.eye_pts(sx, g), f)
        eye.data.materials.append(mats['ink'])
        _key(eye, f'eyeBlink{side}', H.eye_pts(sx, g, blink=1))
        _key(eye, f'eyeWide{side}', H.eye_pts(sx, g, wide=1))
        _key(eye, f'cheekSquint{side}', H.eye_pts(sx, g, squint=1))
        _outward(eye, Cb)
        # a small glint, up and to one side
        gg, gf = _disc(2, 10)
        gp = H.surf(sx * H.eye_x + (gg[:, 0] * 0.0042 - 0.004) * k, H.eye_z + (gg[:, 1] * 0.0042 + 0.008) * k, 0.0046 * k)
        gl = _mesh(f'{name}-glint{side}', gp, gf)
        gl.data.materials.append(mats['white'])
        _key(gl, f'eyeBlink{side}', H.surf(np.full(len(gg), sx * H.eye_x), np.full(len(gg), H.eye_z - 0.007 * k), -0.004 * k))
        _outward(gl, Cb)
        hg, hf = _half()
        lid = _mesh(f'{name}-lid{side}', H.lid_pts(sx, hg), hf)
        lid.data.materials.append(mats['skin'])
        _key(lid, f'eyeBlink{side}', H.lid_pts(sx, hg, blink=1))
        _key(lid, f'eyeWide{side}', H.lid_pts(sx, hg, wide=1))
        _outward(lid, Cb)
        tg, tf = _tube_grid()
        brow = _mesh(f'{name}-brow{side}', H.brow_pts(sx, tg), tf)
        brow.data.materials.append(mats['hair'])
        _key(brow, f'browDown{side}', H.brow_pts(sx, tg, down=1))
        _key(brow, 'browInnerUp', H.brow_pts(sx, tg, inner_up=1))
        _key(brow, f'browOuterUp{side}', H.brow_pts(sx, tg, outer_up=1))
        _outward(brow, Cb)
        bg, bf = _tube_grid(9, 6)
        bag = _mesh(f'{name}-bag{side}', H.bag_pts(sx, bg), bf)
        bag.data.materials.append(mats['nose'])
        _outward(bag, Cb)
        obs += [eye, gl, lid, brow, bag]
    mg, mf, band = _mouth_grid()
    mouth = _mesh(f'{name}-mouth', H.mouth_pts(mg), mf)
    for m in (mats['line'], mats['white'], mats['mouth']):
        mouth.data.materials.append(m)
    for poly, b in zip(mouth.data.polygons, band):
        poly.material_index = (0, 1, 2, 0)[b]
    _outward(mouth, Cb)
    for vn, (o, w, pk) in VISEMES.items():
        _key(mouth, vn, H.mouth_pts(mg, open_=o, wide=w, pucker=pk))
    _key(mouth, 'jawOpen', H.mouth_pts(mg, open_=1.0, wide=0.94))
    _key(mouth, 'mouthPucker', H.mouth_pts(mg, pucker=1.0))
    _key(mouth, 'mouthClose', H.mouth_pts(mg, wide=0.96))
    _key(mouth, 'mouthSmileLeft', H.mouth_pts(mg, smile=(1, 0)))
    _key(mouth, 'mouthSmileRight', H.mouth_pts(mg, smile=(0, 1)))
    _key(mouth, 'mouthFrownLeft', H.mouth_pts(mg, frown=(1, 0)))
    _key(mouth, 'mouthFrownRight', H.mouth_pts(mg, frown=(0, 1)))
    obs.append(mouth)
    # one mesh, then the shape keys from the stored deltas
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = skin
    bpy.ops.object.join()
    head = skin; head.name = name; head.data.name = name
    n = len(head.data.vertices)
    head.shape_key_add(name='Basis', from_mix=False)
    base = np.empty(n * 3); head.data.vertices.foreach_get('co', base)
    for s in SHAPES:
        kb = head.shape_key_add(name=s, from_mix=False)
        a = head.data.attributes.get('sk_' + s)
        if a is not None:
            d = np.empty(n * 3); a.data.foreach_get('vector', d)
            kb.data.foreach_set('co', base + d)
        kb.value = 0.0
    for a in [a for a in head.data.attributes if a.name.startswith('sk_')]:
        head.data.attributes.remove(a)
    # ── glasses: thin round rims, a bridge and temples ────────────────────────────────────
    R, tube = 0.05 * k, 0.0042 * k
    gv, gfaces = [], []

    def add(pts, r):
        v, f = parts._tube(tb(np.asarray(pts)), r, sides=6)
        b = len(gv)
        gv.extend(v); gfaces.extend([tuple(i + b for i in ff) for ff in f])
    for sx in (1, -1):
        an = np.linspace(0, 2 * math.pi, 29)
        ring = H.surf(sx * H.eye_x + np.cos(an) * R, H.eye_z - 0.004 * k + np.sin(an) * R, 0.0)
        ring[:, 1] = ring[:, 1].max() + 0.012 * k            # a flat lens plane in front of the face
        add(ring, tube)
        hinge = np.array([sx * (H.eye_x + R), ring[0, 1], H.eye_z])
        earp = H.ear[0] * np.array([sx, 1, 1]) + np.array([sx * 0.012, 0.01, 0.03]) * k
        add([hinge, hinge + (earp - hinge) * 0.5 + np.array([sx * 0.012 * k, 0, 0]), earp, earp + np.array([0, -0.03, -0.03]) * k], tube * 0.85)
    yb = H.surf(np.array([H.eye_x]), np.array([H.eye_z]))[0, 1]
    br = np.array([[x, 0, H.eye_z + 0.012 * k + 0.006 * k * (1 - (x / (H.eye_x - R)) ** 2)] for x in np.linspace(-(H.eye_x - R), H.eye_x - R, 7)])
    br[:, 1] = max(H.surf(np.array([H.eye_x + R * 0.0]), np.array([H.eye_z - 0.004 * k]))[0, 1], yb) + 0.012 * k
    add(br, tube)
    gme = bpy.data.meshes.new('glasses'); gme.from_pydata([tuple(v) for v in gv], [], gfaces)
    gl = bpy.data.objects.new('glasses', gme); bpy.context.collection.objects.link(gl)
    for poly in gme.polygons:
        poly.use_smooth = True
    gl.data.materials.append(mats['frames'])
    eye = np.array([H.eye_x, H.surf(np.array([H.eye_x]), np.array([H.eye_z]))[0, 1], H.eye_z])
    mouth_p = H.surf(np.array([0.0]), np.array([H.mouth_z]))[0]
    L = dict(
        eyes={'Left': (eye, 0.02 * k), 'Right': (eye * np.array([-1, 1, 1]), 0.02 * k)},
        ears={s: (H.ear[0] * np.array([sx, 1, 1]) + np.array([0, 0, 0.05 * k]), H.ear[0] * np.array([sx, 1, 1])) for sx, s in ((1, 'Left'), (-1, 'Right'))},
        nose=np_ + np.array([0, 0.04 * k, 0]), mouth=mouth_p, mouthW=0.092 * k,
        headBase=np.array([0, C[1], C[2] - 0.19 * k]), headH=0.38 * k, hw=0.16 * k, hd=0.15 * k,
        bones={'Head': (np.asarray(person.j['Head'], float), np.asarray(person.j['Head'], float) + np.array([0, 0, 0.19 * k])),
               'Neck': (np.asarray(person.j['Neck'], float), np.asarray(person.j['Head'], float)),
               'Jaw': (C + np.array([0, 0.0, -0.06]) * k, mouth_p + np.array([0, 0, -0.03 * k]))},
        centre=C, k=k,
    )
    return head, gl, L, SHAPES
