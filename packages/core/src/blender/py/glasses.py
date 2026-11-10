"""Reading glasses fitted to a face: rims in front of the eyes (clear of the lids and brows), a bridge
and two nose pads resting on the nose, temples that run back clear of the skin to the tops of the ears
and hook down behind them. Built from tubes (Blender curves), measured against the head mesh."""
import math
import numpy as np
import bpy
import mathutils
from mathutils.bvhtree import BVHTree

import plan_person as pp

V = mathutils.Vector


def _bvh(head):
    dg = bpy.context.evaluated_depsgraph_get()
    return BVHTree.FromObject(head, dg)


def _hit(bvh, origin_plan, dir_plan, far=0.5):
    """First skin hit along a ray (plan coords in and out), or None."""
    o = V(pp.to_blender(np.asarray(origin_plan, float)))
    d = V(pp.to_blender(np.asarray(dir_plan, float))).normalized()
    loc, nrm, idx, dist = bvh.ray_cast(o, d, far)
    return None if loc is None else pp.from_blender(np.array(loc))


def fit(head, L, tube=0.0017):
    """Points of the frame (plan coords): rims, bridge, pads, temples. L: kithead.landmarks."""
    bvh = _bvh(head)
    eL, r = L['eyes']['Left']
    # the lens plane: in front of the eye, its lids and the brow ridge over it
    front = eL[1] + 1.22 * r
    for dz in (0.0, 0.6 * r, 1.0 * r):
        h = _hit(bvh, [eL[0], 1.0, eL[2] + dz], [0, -1, 0], 2.0)
        if h is not None:
            front = max(front, h[1] + 0.004)
    # the nose bridge between the eyes, a little below their middle
    zb = eL[2] - 0.15 * r
    nb = _hit(bvh, [0, 1.0, zb], [0, -1, 0], 2.0)
    nose_f = nb[1] if nb is not None else front - 0.01
    a, b = 1.12 * r, 0.82 * r                       # rim half width / height
    out = {'rims': [], 'temples': [], 'bridge': None, 'pads': []}
    for sx in (1, -1):
        c = np.array([eL[0] * sx, front, eL[2] - 0.08 * r])
        pts = []
        for k in range(36):
            t = 2 * math.pi * k / 36
            ct, st = math.cos(t), math.sin(t)
            # a rounded rectangle (superellipse), a touch wider at the top
            x = a * np.sign(ct) * abs(ct) ** 0.45 * (1.0 + 0.05 * max(st, 0))
            z = b * np.sign(st) * abs(st) ** 0.55
            # the rim follows the face's curve round the side a little
            f = -0.18 * max(0.0, x * sx) ** 2 / a
            pts.append(c + np.array([x, f, z]))
        out['rims'].append(pts)
        # nose pad: from the rim's inner lower corner back onto the side of the nose
        inner = c + np.array([-sx * a * 0.92, 0, -0.25 * b])
        pad = _hit(bvh, [sx * 0.6 * abs(inner[0]), 1.0, inner[2]], [0, -1, 0], 2.0)
        if pad is not None:
            out['pads'].append([inner, np.array([pad[0], pad[1] + tube, pad[2]])])
        # temple: from the hinge back to the top of the ear, then down behind it
        hinge = c + np.array([sx * (a + 0.002), -0.18 * a - 0.002, 0.45 * b])
        top, centre = L['ears']['Left' if sx > 0 else 'Right']
        over = np.array([top[0], top[1] + 0.004, top[2] + 0.003])
        behind = np.array([top[0] - sx * 0.003, top[1] - 0.014, top[2] - 0.02])
        line = []
        for k in range(9):
            u = k / 8
            p = hinge * (1 - u) + over * u
            p[2] += 0.006 * math.sin(math.pi * u)            # a gentle arch over the temple
            line.append(p)
        line.append(over * 0.5 + behind * 0.5 + np.array([0, -0.004, 0.006]))
        line.append(behind)
        # keep every point outside the skin (push out sideways)
        safe = []
        for p in line:
            h = _hit(bvh, [p[0] + sx * 0.3, p[1], p[2]], [-sx, 0, 0], 0.6)
            q = p.copy()
            if h is not None and (q[0] - h[0]) * sx < tube + 0.0025:
                q[0] = h[0] + sx * (tube + 0.0025)
            safe.append(q)
        out['temples'].append(safe)
    # bridge: an arch between the rims' inner tops, its middle resting on the nose
    il = np.array([eL[0] - a * 0.95, front, eL[2] + 0.1 * r])
    ir = il * np.array([-1, 1, 1])
    mid = np.array([0, max(nose_f + tube, front - 0.012), zb + 0.25 * r])
    out['bridge'] = [ir, (ir + mid) / 2 + np.array([0, 0, 0.002]), mid, (il + mid) / 2 + np.array([0, 0, 0.002]), il]
    return out


def build(head, L, color, name='glasses', tube=0.0017):
    F = fit(head, L, tube)
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = tube
    cu.bevel_resolution = 1
    cu.resolution_u = 2
    cu.use_fill_caps = True

    def spline(pts, cyclic=False, r=1.0):
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for p, q in zip(sp.points, pts):
            bq = pp.to_blender(np.asarray(q, float))
            p.co = (bq[0], bq[1], bq[2], 1)
            p.radius = r
        sp.use_cyclic_u = cyclic
    for rim in F['rims']:
        spline(rim, True, 1.15)
    for t in F['temples']:
        spline(t, False, 0.85)
    spline(F['bridge'], False, 0.9)
    for p in F['pads']:
        spline(p, False, 0.7)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.convert(target='MESH')
    ob = bpy.context.object
    for poly in ob.data.polygons:
        poly.use_smooth = True
    m = bpy.data.materials.new('frames')
    m.use_nodes = True
    bs = m.node_tree.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = 0.3
    bs.inputs['Coat Weight'].default_value = 0.6
    ob.data.materials.append(m)
    return ob, F
