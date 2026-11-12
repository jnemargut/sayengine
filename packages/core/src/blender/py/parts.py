"""Separate clean parts: eyes (rigid spheres that only turn), lids (shells on lid bones), ears, nose,
whiskers. Each part is its own object; the builder skins it rigidly to one bone."""
import math
import bpy
import numpy as np
import mathutils
import sdf
import body


def look_rot(direction, up=(0, 0, 1)):
    """Rotation matrix taking local +Z to `direction` with local +Y as close to `up` as possible."""
    d = mathutils.Vector(direction).normalized()
    return d.to_track_quat('Z', 'Y').to_matrix().to_4x4()


def uv_sphere(name, r, segs=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=r)
    ob = bpy.context.object
    ob.name = name
    ob.data.name = name
    bpy.ops.object.shade_smooth()
    return ob


def eye(name, centre, direction, r):
    """Eyeball: pole (+Z local) looks along `direction`; UV v=1 at the pupil."""
    ob = uv_sphere(name, r, 24, 14)
    ob.matrix_world = mathutils.Matrix.Translation(mathutils.Vector(centre)) @ look_rot(direction)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return ob


def pupil(name, centre, direction, r, size=0.36):
    """A round pupil: a thin dark lens on the front of the eyeball (scaled by shape keys)."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=1.0)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (size * r, size * r, 0.07 * r)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.matrix_world = mathutils.Matrix.Translation(mathutils.Vector(centre) + mathutils.Vector(direction).normalized() * r * 0.975) @ look_rot(direction)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    bpy.ops.object.shade_smooth()
    return ob


def lids(name, centre, direction, r, opening_deg=64.0, thickness=0.0009, rf=1.025):
    """Upper and lower lid shells around an eyeball, split on the eye's horizontal plane. They close
    by turning about the eye's horizontal axis, so nothing ever slices the eyeball."""
    out = []
    ca = np.cos(np.radians(opening_deg))
    for which in ('upper', 'lower'):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=18, radius=r * rf)
        ob = bpy.context.object
        ob.name = f'{name}.{which}'
        me = ob.data
        import bmesh
        bm = bmesh.new(); bm.from_mesh(me)
        kill = []
        for f in bm.faces:
            c = f.calc_center_median()
            n = c.normalized()
            # local frame: +Z is the gaze; +Y up
            if n.z > ca:                     # the opening
                kill.append(f); continue
            if (which == 'upper' and c.y < -1e-6) or (which == 'lower' and c.y > 1e-6):
                kill.append(f); continue
            if n.z < -0.2:                   # the back half is inside the head
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bm.to_mesh(me); bm.free()
        sol = ob.modifiers.new('solid', 'SOLIDIFY'); sol.thickness = thickness; sol.offset = 1.0
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier='solid')
        ob.matrix_world = mathutils.Matrix.Translation(mathutils.Vector(centre)) @ look_rot(direction)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        bpy.ops.object.shade_smooth()
        out.append(ob)
    return out


def sdf_part(name, field, lo, hi, h, relax_iters=3, faces=None):
    V, F = body.surface_nets(field, np.asarray(lo), np.asarray(hi), h)
    ob = body.mesh_from_arrays(name, V, F)
    body.fix_normals(ob)
    body.set_co(ob, sdf.project(field, body.get_co(ob), iters=6, max_step=h))
    body.relax(ob, field, iters=relax_iters, lam=0.4)
    if faces and len(ob.data.polygons) > faces:
        d = ob.modifiers.new('dec', 'DECIMATE'); d.ratio = faces / len(ob.data.polygons)
        bpy.ops.object.modifier_apply(modifier='dec')
        body.set_co(ob, sdf.project(field, body.get_co(ob), iters=4, max_step=h))
    bpy.ops.object.shade_smooth()
    return ob


def tri2d(u, v, w, h, rr):
    """Rounded isosceles triangle in 2D: base (width w) on v=0, apex at v=h, corner rounding rr."""
    # distance to the triangle shrunk by rr, minus rr
    a = np.array([-w / 2, 0.0]); b = np.array([w / 2, 0.0]); c = np.array([0.0, h])
    cen = (a + b + c) / 3
    s = 1 - rr / max(h / 3, 1e-6)
    a2, b2, c2 = cen + (a - cen) * s, cen + (b - cen) * s, cen + (c - cen) * s
    P = np.stack([u, v], 1)
    def seg(p, x, y):
        pa = p - x; ba = y - x
        t = np.clip((pa @ ba) / (ba @ ba), 0, 1)
        return np.linalg.norm(pa - t[:, None] * ba, axis=1)
    d = np.minimum(np.minimum(seg(P, a2, b2), seg(P, b2, c2)), seg(P, c2, a2))
    # inside test
    def side(p, x, y):
        return (y[0] - x[0]) * (p[:, 1] - x[1]) - (y[1] - x[1]) * (p[:, 0] - x[0])
    inside = (side(P, a2, b2) >= 0) & (side(P, b2, c2) >= 0) & (side(P, c2, a2) >= 0)
    d = np.where(inside, -d, d)
    return d - rr


def ear(name, base, size, tilt, side, roundness=1.0, toward=(0, -1, 0)):
    """A cat ear: a rounded triangle plate, cupped, thick at the base. Returns (outer, inner) objects.
    `base` is the base centre (Blender coords), `side` +1 left / -1 right."""
    w, h, t = size
    rr = w * (0.12 + 0.2 * roundness)
    # ear frame: up tilted outward, facing forward (slightly out)
    up = mathutils.Vector((np.sin(tilt) * side, 0, np.cos(tilt))).normalized()
    fwd = mathutils.Vector(toward).normalized()
    fwd = (fwd + mathutils.Vector((0.35 * side, 0, 0))).normalized()
    right = up.cross(fwd).normalized()
    fwd = right.cross(up).normalized()
    B = np.array(base)
    R = np.array([right, up, fwd])                   # rows: local axes in world
    def local(p):
        q = (p - B) @ R.T
        return q[:, 0], q[:, 1], q[:, 2]
    def plate(p, shrink=0.0, cup=0.0):
        u, v, n = local(p)
        d2 = tri2d(u, v + 0.012, w - 2 * shrink, h + 0.012 - 1.5 * shrink, rr)
        # cupped: the front (+n) is hollow; thickness tapers toward the tip
        curve = 0.35 * (u / (w / 2)) ** 2 * w * 0.18
        th = t * (1.0 - 0.55 * np.clip(v / h, 0, 1))
        dn = np.abs(n - curve + cup) - th / 2
        return sdf.smax(d2, dn, min(rr * 0.5, t * 0.4))
    def outer(p):
        return plate(p)
    span = max(w, h) * 0.9
    lo = B - span; hi = B + span
    ob = sdf_part(name, outer, lo, hi, 0.0011, faces=520)
    # the inner ear: a thin pad set into the front of the cup
    def inner(p):
        u, v, n = local(p)
        d2 = tri2d(u, v + 0.004, w * 0.62, h * 0.8, rr * 0.7)
        curve = 0.35 * (u / (w / 2)) ** 2 * w * 0.18
        dn = np.abs(n - curve - t * 0.28) - t * 0.18
        return sdf.smax(d2, dn, t * 0.1)
    ib = sdf_part(name + '.inner', inner, lo, hi, 0.0008, faces=220)
    return ob, ib


def nose(name, centre, w, h, depth, toward=(0, -1, 0)):
    """A small flat nose leather: an inverted rounded triangle, domed."""
    fwd = mathutils.Vector(toward).normalized()
    fwd = (fwd + mathutils.Vector((0, 0, -0.25))).normalized()
    right = mathutils.Vector((1, 0, 0))
    up = fwd.cross(right).normalized()
    R = np.array([right, up, fwd]); C = np.array(centre)
    def f(p):
        q = (p - C) @ R.T
        d2 = tri2d(q[:, 0], -q[:, 1] + h * 0.5, w, h, w * 0.18)
        dome = (q[:, 0] / w) ** 2 * depth * 0.8
        dn = np.abs(q[:, 2] + dome) - depth / 2
        return sdf.smax(d2, dn, depth * 0.45)
    span = max(w, h) * 1.2
    return sdf_part(name, f, C - span, C + span, 0.0006, faces=160)


def whiskers(name, pad_l, n=8, length=0.07, width=0.0007, seed=4, toward=(0, -1, 0)):
    """Fine pale whiskers as crossed tapered ribbons fanning from both whisker pads."""
    rng = np.random.default_rng(seed)
    verts, faces = [], []
    segs = 6
    for side in (1, -1):
        root0 = np.array(pad_l) * np.array([side, 1, 1])
        for i in range(n):
            t = i / (n - 1)
            # rows on the pad, fanning from slightly up to down and outward-back
            root = root0 + np.array([side * 0.004 * (0.5 - t) + side * 0.003, -0.002, 0.006 - 0.012 * t])
            ang_down = np.radians(-14 + 40 * t + rng.normal(0, 3))
            ang_out = np.radians(62 + 18 * t + rng.normal(0, 4))
            L = length * (0.85 + 0.25 * (1 - abs(t - 0.4)) + rng.normal(0, 0.05))
            d0 = np.array([side * np.sin(ang_out), -np.cos(ang_out), -np.sin(ang_down) * 0.9])
            d0 /= np.linalg.norm(d0)
            pts = []
            p = root.copy(); d = d0.copy()
            for s in range(segs + 1):
                pts.append(p.copy())
                d = d + np.array([0, 0.03, -0.09]) / segs     # droop and sweep back
                d /= np.linalg.norm(d)
                p = p + d * L / segs
            pts = np.array(pts)
            for k, nrm in enumerate((np.array([0, 0, 1.0]), None)):
                base_i = len(verts)
                for s, q in enumerate(pts):
                    tang = pts[min(s + 1, segs)] - pts[max(s - 1, 0)]
                    tang /= np.linalg.norm(tang)
                    if nrm is None:
                        side_v = np.cross(tang, np.array([0, 0, 1.0]))
                        side_v = np.cross(side_v, tang)
                    else:
                        side_v = np.cross(tang, nrm)
                    side_v /= max(np.linalg.norm(side_v), 1e-9)
                    wv = width * (1 - 0.85 * s / segs)
                    verts.append(q + side_v * wv); verts.append(q - side_v * wv)
                for s in range(segs):
                    a = base_i + 2 * s
                    faces.append((a, a + 2, a + 3, a + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def claws(name, roots, direction, length=0.0065, radius=0.0009, curl=0.9, sides=6, segs=6):
    """Front claws: small hooked cones, one per toe, from `roots` along `direction` (curving down).
    They are built retracted (inside the toe) and slide out on the claw bone."""
    verts, faces = [], []
    d0 = np.array(direction, float); d0 /= np.linalg.norm(d0)
    down = np.array([0, 0, -1.0])
    down = down - d0 * (down @ d0); down /= max(np.linalg.norm(down), 1e-9)
    side = np.cross(d0, down); side /= np.linalg.norm(side)
    for root in roots:
        tans = []
        for s in range(segs + 1):
            a = curl * (s / segs) ** 2              # the hook bends down toward the tip
            tans.append(d0 * np.cos(a) + down * np.sin(a))
        pts = []
        p = np.array(root, float)
        for s in range(segs + 1):
            pts.append(p.copy())
            if s < segs:
                p = p + tans[s] * length / segs
        base = len(verts)
        for s, (p, t) in enumerate(zip(pts, tans)):
            r = radius * (1 - 0.9 * s / segs)
            n1 = np.cross(t, side); n1 /= max(np.linalg.norm(n1), 1e-9)
            n2 = np.cross(t, n1)
            for k in range(sides):
                th = 2 * np.pi * k / sides
                # flattened sideways, like a real claw
                verts.append(p + (n1 * np.cos(th) * 1.0 + n2 * np.sin(th) * 0.55) * r)
        for s in range(segs):
            for k in range(sides):
                a = base + s * sides + k; b = base + s * sides + (k + 1) % sides
                faces.append((a, b, b + sides, a + sides))
        tip = len(verts); verts.append(pts[-1] + tans[-1] * radius * 0.4)
        for k in range(sides):
            a = base + segs * sides + k; b = base + segs * sides + (k + 1) % sides
            faces.append((a, b, tip))
        cap = list(range(base, base + sides))[::-1]
        faces.append(tuple(cap))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for poly in me.polygons:
        poly.use_smooth = True
    return ob


def _tube(pts, radius, sides=6):
    """A capped tube along a polyline: (verts, quads/tri fans)."""
    pts = np.asarray(pts, float)
    verts, faces = [], []
    n = len(pts)
    for i in range(n):
        t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        t /= max(np.linalg.norm(t), 1e-9)
        a = np.cross(t, [0, 1.0, 0])
        if np.linalg.norm(a) < 1e-6:
            a = np.cross(t, [1.0, 0, 0])
        a /= np.linalg.norm(a); b = np.cross(t, a)
        k = 0.55 if i in (0, n - 1) else 1.0             # tapered ends
        for j in range(sides):
            an = 2 * math.pi * j / sides
            verts.append(pts[i] + (a * math.cos(an) + b * math.sin(an)) * radius * k)
    for i in range(n - 1):
        for j in range(sides):
            j2 = (j + 1) % sides
            faces.append((i * sides + j, i * sides + j2, (i + 1) * sides + j2, (i + 1) * sides + j))
    faces.append(tuple(range(sides - 1, -1, -1)))
    faces.append(tuple(range((n - 1) * sides, n * sides)))
    return verts, faces


def toy_mouth(name, surface, mouth, nose, hs, line=0.0017):
    """A cartoon cat mouth on the muzzle: the dark "w" under the nose with its short philtrum, and an
    open mouth behind it (a dark oval with a tongue) that the `mouthOpen` shape key grows from nothing.
    `surface(points) -> points` drops points onto the face (Blender coords); mouth and nose are points
    on it; hs is the head scale. Returns (line object, cavity object, tongue object); the cavity and
    the tongue carry a `mouth_open` vector attribute: where each vertex goes when the mouth is open."""
    mouth = np.asarray(mouth, float); nose = np.asarray(nose, float)
    wx, amp = 0.021 * hs, 0.0075 * hs
    xs = np.linspace(-wx, wx, 25)
    top = mouth[2] + 0.004 * hs
    w = np.stack([xs, np.full_like(xs, mouth[1]), top - amp * np.abs(np.sin(np.pi * xs / wx)) + 0.5 * amp * (np.abs(xs) / wx) ** 2], 1)
    w = surface(w); w[:, 1] -= line * 0.6
    ph = np.stack([np.zeros(5), np.full(5, mouth[1]), np.linspace(nose[2] - 0.004 * hs, top, 5)], 1)
    ph = surface(ph); ph[:, 1] -= line * 0.6
    v1, f1 = _tube(w, line * hs)
    v2, f2 = _tube(ph, line * hs * 0.8)
    f2 = [tuple(i + len(v1) for i in f) for f in f2]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in v1 + v2], [], f1 + f2)
    line_ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(line_ob)
    for poly in me.polygons:
        poly.use_smooth = True

    def oval(nm, cx_z, rw, rh, lift, hide_z):
        ring, segs = 4, 20
        vs = [(0.0, 0.0)]
        for r in range(1, ring + 1):
            for k in range(segs):
                an = 2 * math.pi * k / segs
                vs.append((math.cos(an) * r / ring, math.sin(an) * r / ring))
        fs = [(0, 1 + k, 1 + (k + 1) % segs) for k in range(segs)]
        for r in range(1, ring):
            for k in range(segs):
                a = 1 + (r - 1) * segs + k; b = 1 + (r - 1) * segs + (k + 1) % segs
                fs.append((a, a + segs, b + segs, b))
        vs = np.array(vs)
        opened = surface(np.stack([vs[:, 0] * rw, np.full(len(vs), mouth[1]), cx_z + vs[:, 1] * rh], 1))
        opened[:, 1] -= lift
        closed = np.stack([opened[:, 0] * 0.05, opened[:, 1] + lift + 0.008 * hs, np.full(len(vs), hide_z)], 1)   # a speck inside the muzzle
        m2 = bpy.data.meshes.new(nm)
        m2.from_pydata([tuple(v) for v in closed], [], fs)
        ob = bpy.data.objects.new(nm, m2); bpy.context.collection.objects.link(ob)
        a = m2.attributes.new('mouth_open', 'FLOAT_VECTOR', 'POINT')
        a.data.foreach_set('vector', opened.reshape(-1))
        return ob
    rw, rh = 0.0165 * hs, 0.019 * hs
    cz = top - amp * 0.6 - rh
    # (lifted clear of the remeshed muzzle, which strays a few millimetres from the field)
    cav = oval(name + '_cavity', cz, rw, rh, 0.0045 * hs, top - amp)
    ton = oval(name + '_tongue', cz - rh * 0.42, rw * 0.62, rh * 0.5, 0.006 * hs, top - amp)
    return line_ob, cav, ton


def toy_whiskers(name, pad_l, n=3, length=0.05, radius=0.0011, toward=(0, -1, 0)):
    """Tidy cartoon whiskers: n fat tapered tubes a side, fanned evenly, a little droop."""
    verts, faces = [], []
    for side in (1, -1):
        root0 = np.array(pad_l) * np.array([side, 1, 1])
        for i in range(n):
            t = i / max(n - 1, 1)
            root = root0 + np.array([side * 0.004, 0.0, 0.007 - 0.014 * t])
            up = math.radians(16 - 32 * t)
            d = np.array([side * math.cos(up) * 0.94, 0.34 * 0 - 0.22, math.sin(up)]); d /= np.linalg.norm(d)
            pts = [root + d * length * s / 5 + np.array([0, 0.012 * (s / 5) ** 2, -0.006 * (s / 5) ** 2]) * (length / 0.05) for s in range(6)]
            v, f = _tube(pts, radius, sides=5)
            # taper to the tip
            for s in range(6):
                c = pts[s]
                for k in range(5):
                    q = v[s * 5 + k]
                    v[s * 5 + k] = c + (q - c) * (1 - 0.7 * s / 5)
            base = len(verts)
            verts += v; faces += [tuple(i + base for i in ff) for ff in f]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    for poly in me.polygons:
        poly.use_smooth = True
    return ob
