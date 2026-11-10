"""Self-intersection check on the skinned mesh, clip by clip: the lower legs, the paws and the tail
must not sink into the barrel, and the paws must not sink into the head (grooming, ear scratching).

Each vertex belongs to the bone that weighs it most. The torso volume is the surface of the barrel
(spine, belly) and the head volume the surface of the head; a probe vertex (a lower leg, a paw, the
outer tail) is inside a volume when it lies behind the nearest face of that surface. Depth is measured
against the same vertex in the rest pose, so places where a leg and the barrel already meet at rest
(the elbow against the chest) don't count, only what a pose adds."""
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

TORSO = ('spine', 'spine.001', 'spine.002', 'spine.003', 'belly.C')
HEAD = ('spine.006', 'jaw')
PROBES = {
    # probe group: (bones, volumes it must stay out of)
    'LF': (('hand.L', 'f_toe.L'), ('torso', 'head')),
    'RF': (('hand.R', 'f_toe.R'), ('torso', 'head')),
    'LH': (('foot.L', 'r_toe.L'), ('torso', 'head')),
    'RH': (('foot.R', 'r_toe.R'), ('torso', 'head')),
    'tail': (('tail.003', 'tail.004'), ('torso',)),
}
NAMES = {'LF': 'left front paw', 'RF': 'right front paw', 'LH': 'left hind leg', 'RH': 'right hind leg', 'tail': 'tail'}
LIMIT = 0.008          # metres into a volume, beyond what the rest pose already has


def _dominant(mesh):
    names = [g.name for g in mesh.vertex_groups]
    n = len(mesh.data.vertices)
    best = np.full(n, -1); bw = np.zeros(n)
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.weight > bw[v.index]:
                bw[v.index] = g.weight; best[v.index] = g.group
    part = np.zeros(n, np.int32)
    if 'eyepart' in mesh.data.attributes:
        mesh.data.attributes['eyepart'].data.foreach_get('value', part)
    dom = np.array([names[b] if b >= 0 else '' for b in best])
    dom[part > 0] = ''                                 # eyes, lids: not part of any volume
    dom[np.char.startswith(dom.astype(str), 'claw')] = ''
    return dom


def _co(mesh):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = mesh.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    mw = np.array(mesh.matrix_world)
    co = co.reshape(-1, 3)
    return co @ mw[:3, :3].T + mw[:3, 3]


def _depths(bvh, co, probe_idx):
    """How far each probe vertex is behind the surface. Only a projection onto a face's inside counts
    (the offset lies along the face normal): next to an open rim of the surface (where a leg or the
    head joins) the nearest point is on an edge and the sign means nothing."""
    out = np.zeros(len(probe_idx))
    for k, i in enumerate(probe_idx):
        hit = bvh.find_nearest(co[i], 0.05)
        if hit[0] is None:
            continue
        off = co[i] - np.array(hit[0])
        dist = float(np.linalg.norm(off))
        if dist < 1e-6:
            continue
        along = float(off @ np.array(hit[1]))
        if along < 0 and -along > 0.9 * dist:
            out[k] = -along
    return out


def _bvh(co, polys):
    return BVHTree.FromPolygons([tuple(p) for p in co], polys, all_triangles=False, epsilon=0.0)


def check_clips(arm, mesh, acts, max_frames=12):
    """{clip: {pass, worst, frames, detail}}. Samples up to max_frames frames per clip."""
    dom = _dominant(mesh)
    vol_polys = {}
    for vol, bones in (('torso', TORSO), ('head', HEAD)):
        ok = np.isin(dom, bones)
        vol_polys[vol] = [tuple(p.vertices) for p in mesh.data.polygons if all(ok[j] for j in p.vertices)]
    probes = {k: np.where(np.isin(dom, bones))[0][::2] for k, (bones, _) in PROBES.items()}
    saved = arm.animation_data.action if arm.animation_data else None
    arm.animation_data_create()
    sc = bpy.context.scene
    # the rest pose baseline
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()
    co0 = _co(mesh)
    trees = {vol: _bvh(co0, vol_polys[vol]) for vol in vol_polys}
    base = {(k, vol): _depths(trees[vol], co0, idx) for k, idx in probes.items() for vol in PROBES[k][1]}
    out = {}
    for name, act in acts.items():
        if act.get('partial'):
            continue
        arm.animation_data.action = act
        n = int(round(act.frame_range[1]))
        frames = sorted(set(int(round(x)) for x in np.linspace(0, n, min(max_frames, n + 1))))
        worst = (0.0, None, None, None)
        bad = []
        for f in frames:
            sc.frame_set(f)
            co = _co(mesh)
            trees = {vol: _bvh(co, vol_polys[vol]) for vol in vol_polys}
            hit = False
            for k, idx in probes.items():
                for vol in PROBES[k][1]:
                    d = _depths(trees[vol], co, idx) - base[(k, vol)]
                    m = float(d.max()) if len(d) else 0.0
                    if m > worst[0]:
                        worst = (m, k, vol, f)
                    if m > LIMIT:
                        hit = True
            if hit:
                bad.append(f)
        ok = not bad
        w, k, vol, f = worst
        detail = 'nothing passes into the body or head' if w < 0.001 else \
            f"deepest: the {NAMES[k]} {w * 1000:.0f} mm into the {'barrel' if vol == 'torso' else 'head'} at frame {f}"
        rng = []
        for f in bad:
            if rng and f - rng[-1][1] <= 3:
                rng[-1][1] = f
            else:
                rng.append([f, f])
        out[name] = {'pass': ok, 'worst': round(w, 4), 'limit': LIMIT, 'frames': rng, 'detail': detail}
    arm.animation_data.action = saved
    return out
