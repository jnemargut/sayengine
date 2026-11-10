"""Separate clean parts: eyes (rigid spheres that only turn), lids (shells on lid bones), ears, nose,
whiskers. Each part is its own object; the builder skins it rigidly to one bone."""
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
