"""Body surface: a Skin-modifier mesh from the skeleton, sculpted onto the plan's shape field.

skin skeleton -> Skin modifier -> Subdivision -> project onto the field -> Quadriflow remesh (even,
all-quad) -> project again -> tangential relax + project. The field is a handful of large analytic
shapes, so no metaballs and no lumps.
"""
import bpy
import bmesh
import numpy as np
import sdf


def mesh_from_skeleton(name, verts, edges, radii, root):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], edges, [])
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    sk = ob.modifiers.new('skin', 'SKIN')
    sk.use_smooth_shade = True
    sk.branch_smoothing = 0.6
    for i, r in enumerate(radii):
        sv = me.skin_vertices[0].data[i]
        sv.radius = (float(r[0]), float(r[1]))
        sv.use_root = i == root
    sub = ob.modifiers.new('sub', 'SUBSURF')
    sub.levels = 2
    sub.render_levels = 2
    return ob


def apply_all(ob):
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def get_co(ob):
    n = len(ob.data.vertices)
    a = np.empty(n * 3)
    ob.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def set_co(ob, co):
    ob.data.vertices.foreach_set('co', co.reshape(-1).astype(np.float64))
    ob.data.update()


def neighbours(ob):
    n = len(ob.data.vertices)
    e = np.empty(len(ob.data.edges) * 2, dtype=np.int64)
    ob.data.edges.foreach_get('vertices', e)
    e = e.reshape(-1, 2)
    nb = [[] for _ in range(n)]
    for a, b in e:
        nb[a].append(b); nb[b].append(a)
    return nb, e


def relax(ob, field, iters=6, lam=0.5, protect=None):
    """Tangential Laplacian relax, re-projected each pass (shrink-free: the field holds the shape)."""
    nb, e = neighbours(ob)
    co = get_co(ob)
    n = len(co)
    deg = np.array([len(x) for x in nb], float)
    for _ in range(iters):
        acc = np.zeros_like(co)
        np.add.at(acc, e[:, 0], co[e[:, 1]])
        np.add.at(acc, e[:, 1], co[e[:, 0]])
        avg = acc / np.maximum(deg, 1)[:, None]
        g = sdf.gradient(field, co)
        g /= np.maximum(np.linalg.norm(g, axis=1), 1e-9)[:, None]
        dlt = avg - co
        dlt -= np.einsum('ij,ij->i', dlt, g)[:, None] * g     # tangential only
        w = lam if protect is None else lam * protect
        co = co + dlt * (w if np.isscalar(w) else w[:, None])
        co = sdf.project(field, co, iters=3)
    set_co(ob, co)


def quadriflow(ob, faces):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    before = len(ob.data.polygons)
    for seed in (3, 11):
        for sym in (False,):
            try:
                bpy.ops.object.quadriflow_remesh(target_faces=int(faces), use_mesh_symmetry=sym, use_preserve_sharp=False,
                                                 use_preserve_boundary=False, smooth_normals=True, mode='FACES', seed=seed)
            except Exception as ex:  # noqa: BLE001
                print('quadriflow failed:', ex)
            n = len(ob.data.polygons)
            if n != before and all(len(p.vertices) == 4 for p in ob.data.polygons):
                return True
    return False


def symmetrize(ob):
    """Mirror the left half onto the right so the body is exactly symmetric (Rigify mirrors weights)."""
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.symmetrize(direction='POSITIVE_X', threshold=0.0005)
    bpy.ops.object.mode_set(mode='OBJECT')


def surface_nets(field, lo, hi, h):
    """Mesh the zero level set as quads (naive surface nets): one vertex per sign-changing cell, one
    quad per sign-changing grid edge. Watertight and all-quad."""
    nx, ny, nz = (np.ceil((np.asarray(hi) - np.asarray(lo)) / h).astype(int) + 1)
    xs = lo[0] + np.arange(nx) * h; ys = lo[1] + np.arange(ny) * h; zs = lo[2] + np.arange(nz) * h
    G = np.stack(np.meshgrid(xs, ys, zs, indexing='ij'), -1).reshape(-1, 3)
    D = np.concatenate([field(G[i:i + 400000]) for i in range(0, len(G), 400000)]).reshape(nx, ny, nz)
    inside = D < 0
    # cells: corners (i..i+1, j..j+1, k..k+1)
    c = np.zeros((nx - 1, ny - 1, nz - 1), np.int8)
    cnt = np.zeros((nx - 1, ny - 1, nz - 1), np.int16)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                cnt += inside[dx:nx - 1 + dx, dy:ny - 1 + dy, dz:nz - 1 + dz]
    active = (cnt > 0) & (cnt < 8)
    idx = -np.ones(active.shape, np.int64)
    ai = np.argwhere(active)
    idx[active] = np.arange(len(ai))
    # vertex = mean of edge crossings in the cell
    acc = np.zeros((len(ai), 3)); num = np.zeros(len(ai))
    corners = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (0, 0, 1), (1, 0, 1), (0, 1, 1), (1, 1, 1)]
    cedges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    for a, b in cedges:
        ca, cb = np.array(corners[a]), np.array(corners[b])
        da = D[ai[:, 0] + ca[0], ai[:, 1] + ca[1], ai[:, 2] + ca[2]]
        db = D[ai[:, 0] + cb[0], ai[:, 1] + cb[1], ai[:, 2] + cb[2]]
        m = (da < 0) != (db < 0)
        t = da[m] / (da[m] - db[m])
        pa = ai[m] + ca; pb = ai[m] + cb
        acc[m] += (pa + (pb - pa) * t[:, None])
        num[m] += 1
    V = np.asarray(lo) + (acc / num[:, None]) * h
    faces = []
    # x-edges between grid points (i,j,k)-(i+1,j,k): the 4 cells sharing it are (i, j-1..j, k-1..k)
    for axis in range(3):
        sl = [slice(None)] * 3
        a0 = inside
        sl1 = [slice(0, None)] * 3; sl1[axis] = slice(0, -1)
        sl2 = [slice(0, None)] * 3; sl2[axis] = slice(1, None)
        s0 = a0[tuple(sl1)]; s1 = a0[tuple(sl2)]
        ch = s0 != s1
        e = np.argwhere(ch)
        o1, o2 = [ax for ax in range(3) if ax != axis]
        ok = (e[:, o1] > 0) & (e[:, o2] > 0) & (e[:, o1] < [nx, ny, nz][o1] - 1) & (e[:, o2] < [nx, ny, nz][o2] - 1)
        e = e[ok]
        flip = s0[tuple(e.T)]
        def cell(d1, d2):
            q = e.copy(); q[:, o1] -= d1; q[:, o2] -= d2
            return idx[q[:, 0], q[:, 1], q[:, 2]]
        c00, c10, c11, c01 = cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)
        quad = np.stack([c00, c10, c11, c01], 1)
        # orient outward (inside → outside along +axis means normal +axis)
        quad[flip == False] = quad[flip == False][:, ::-1]  # noqa: E712
        if axis == 1:
            quad = quad[:, ::-1]
        faces.append(quad)
    F = np.concatenate(faces)
    F = F[(F >= 0).all(1)]
    return V, F


def mesh_from_arrays(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
    me.validate()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    return ob


def fix_normals(ob):
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-6)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def build_surface(name, field, lo, hi, voxel, faces, relax_iters=5, quads=True):
    """Any shape field -> one all-quad mesh (surface nets, voxel remesh, Quadriflow, then sculpted back
    onto the field). Falls back to the voxel quads when Quadriflow refuses."""
    V, F = surface_nets(field, np.asarray(lo, float), np.asarray(hi, float), voxel)
    ok = False
    ob = None
    if quads:
        for vs in (voxel * 1.2, voxel * 1.6, voxel * 2.2):
            if ob is not None:
                bpy.data.objects.remove(ob)
            ob = mesh_from_arrays(name, V, F)
            ob.data.remesh_voxel_size = vs
            bpy.ops.object.voxel_remesh()
            sm = ob.modifiers.new('calm', 'SMOOTH'); sm.iterations = 4
            bpy.ops.object.modifier_apply(modifier='calm')
            if quadriflow(ob, faces):
                ok = True
                break
    if not ok:
        if ob is not None:
            bpy.data.objects.remove(ob)
        ob = mesh_from_arrays(name, V, F)
        fix_normals(ob)
        if len(ob.data.polygons) > faces * 1.3:
            d = ob.modifiers.new('dec', 'DECIMATE'); d.ratio = faces / len(ob.data.polygons)
            bpy.ops.object.modifier_apply(modifier='dec')
    set_co(ob, sdf.project(field, get_co(ob), iters=10, max_step=voxel * 2))
    if relax_iters:
        relax(ob, field, iters=relax_iters, lam=0.4)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.shade_smooth()
    return ob, ok


def build_body(plan, target_faces=9000, name='body', voxel=0.006):
    """The skin skeleton gives the rough form and the bounds; the shape field is meshed as quads, then
    remeshed by Quadriflow into even all-quad flow and sculpted back onto the field."""
    verts, edges, radii, root = plan.skin_skeleton()
    lo = verts.min(0) - 0.12; hi = verts.max(0) + 0.12
    lo[2] = max(lo[2], -0.02)
    V, F = surface_nets(getattr(plan, 'field_coarse', plan.field), lo, hi, voxel)
    field = plan.field
    # a voxel remesh gives Quadriflow a closed, consistently wound input; when a fine voxel leaves a
    # pinch Quadriflow rejects, a coarser one is tried (the field restores the detail afterwards)
    ok = False
    ob = None
    for vs in (voxel * 1.2, voxel * 1.6, voxel * 2.0, voxel * 2.6):
        if ob is not None:
            bpy.data.objects.remove(ob)
        ob = mesh_from_arrays(name, V, F)
        ob.data.remesh_voxel_size = vs
        bpy.ops.object.voxel_remesh()
        # a light smooth removes the sliver faces (zero normals) that make Quadriflow refuse the input
        sm = ob.modifiers.new('calm', 'SMOOTH'); sm.iterations = 5
        bpy.ops.object.modifier_apply(modifier='calm')
        if quadriflow(ob, target_faces):
            ok = True
            break
    if not ok:
        bpy.data.objects.remove(ob)
        ob = mesh_from_arrays(name, V, F)
        ob.data.remesh_voxel_size = voxel * 1.8
        bpy.ops.object.voxel_remesh()
    set_co(ob, sdf.project(field, get_co(ob), iters=10))
    relax(ob, field, iters=6, lam=0.4)
    bpy.ops.object.shade_smooth()
    return ob, ok
