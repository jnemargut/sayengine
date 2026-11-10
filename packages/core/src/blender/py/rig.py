"""Rigging: a Rigify metarig fitted to the plan's skeleton (the control rig, for people who animate in
Blender) and a clean game deform skeleton with the same bone names (without the DEF- prefix), bound
with automatic weights and then fixed: smoothed, the belly kept off the legs, four influences."""
import bpy
import numpy as np
import mathutils

V = mathutils.Vector


def bone_table(plan, to_b):
    """name -> (head, tail, parent, deform, roll_up) in Blender coords, from the cat plan."""
    j = plan.j
    T = {}
    def add(n, h, t, parent, deform=True, up=(0, 0, 1)):
        T[n] = (to_b(h), to_b(t), parent, deform, up)
    fwd = (0, -1, 0)
    add('root', np.array([0, 0, 0]), np.array([0, 0.08, 0]), None, False)
    sp = [j['pelvis'] + (j['spine_end'] - j['pelvis']) * t for t in np.linspace(0, 1, 5)]
    add('spine', sp[0], sp[1], 'root')
    add('spine.001', sp[1], sp[2], 'spine')
    add('spine.002', sp[2], sp[3], 'spine.001')
    add('spine.003', sp[3], sp[4], 'spine.002')
    add('spine.004', sp[4], j['neck1'], 'spine.003')
    add('spine.005', j['neck1'], j['head0'], 'spine.004')
    add('spine.006', j['head0'], j['head1'], 'spine.005', up=fwd)
    c = plan.head_c
    add('jaw', c + np.array([0, -0.01, -0.012]), plan.mouth + np.array([0, 0.0, -0.01]), 'spine.006')
    for s, sx in (('L', 1), ('R', -1)):
        m = np.array([sx, 1, 1])
        eb = plan.ear_base * m
        tip = eb + np.array([sx * np.sin(plan.ear_tilt), 0, np.cos(plan.ear_tilt)]) * plan.ear_size[1]
        add(f'ear.{s}', eb, tip, 'spine.006', up=fwd)
        ec = plan.eyes * m
        ed = plan.eye_dir * m
        add(f'eye.{s}', ec, ec + ed * 0.02, 'spine.006')
        add(f'lid.T.{s}', ec, ec + ed * 0.016, 'spine.006')
        add(f'lid.B.{s}', ec, ec + ed * 0.012, 'spine.006')
        add(f'shoulder.{s}', j['scap'] * m, j['shoulder'] * m, 'spine.003', up=fwd)
        add(f'upper_arm.{s}', j['shoulder'] * m, j['elbow'] * m, f'shoulder.{s}', up=fwd)
        add(f'forearm.{s}', j['elbow'] * m, j['wrist'] * m, f'upper_arm.{s}', up=fwd)
        add(f'hand.{s}', j['wrist'] * m, j['fpaw'] * m, f'forearm.{s}', up=fwd)
        add(f'f_toe.{s}', j['fpaw'] * m, j['ftoe'] * m, f'hand.{s}', up=(0, 0, 1))
        add(f'thigh.{s}', j['hip'] * m, j['knee'] * m, 'spine', up=fwd)
        add(f'shin.{s}', j['knee'] * m, j['hock'] * m, f'thigh.{s}', up=fwd)
        add(f'foot.{s}', j['hock'] * m, j['rpaw'] * m, f'shin.{s}', up=fwd)
        add(f'r_toe.{s}', j['rpaw'] * m, j['rtoe'] * m, f'foot.{s}', up=(0, 0, 1))
    add('belly.C', sp[2] + np.array([0, 0, -0.03]), np.array([0, sp[2][1], plan.belly + 0.02]), 'spine.002', up=fwd)
    tl = plan.tail
    for i in range(4):
        add(f'tail.00{i + 1}', tl[i], tl[i + 1], 'spine' if i == 0 else f'tail.00{i}')
    return T


def make_armature(name, table):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for n, (h, t, parent, deform, up) in table.items():
        b = arm.edit_bones.new(n)
        b.head = V(h); b.tail = V(t)
        b.align_roll(V(up))
        b.use_deform = deform
    for n, (h, t, parent, deform, up) in table.items():
        if parent:
            b = arm.edit_bones[n]
            b.parent = arm.edit_bones[parent]
            b.use_connect = (b.head - b.parent.tail).length < 1e-5
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


# ── Rigify ─────────────────────────────────────────────────────────────────────
def rigify_available():
    import addon_utils
    try:
        addon_utils.enable('rigify', default_set=True)
        return hasattr(bpy.ops.object, 'armature_cat_metarig_add')
    except Exception:  # noqa: BLE001
        return False


METARIG_MAP = {
    # metarig bone -> game bone it is fitted to
    'spine': 'spine', 'spine.001': 'spine.001', 'spine.002': 'spine.002', 'spine.003': 'spine.003',
    'spine.004': 'spine.004', 'spine.005': 'spine.005', 'spine.006': 'spine.006',
    'tail.001': 'tail.001', 'tail.002': 'tail.002', 'tail.003': 'tail.003', 'tail.004': 'tail.004',
    'belly.C': 'belly.C',
}
for _s in ('L', 'R'):
    for _b in ('shoulder', 'upper_arm', 'forearm', 'hand', 'f_toe', 'thigh', 'shin', 'foot', 'r_toe'):
        METARIG_MAP[f'{_b}.{_s}'] = f'{_b}.{_s}'


def build_rigify(table):
    """Fit Rigify's cat metarig to the skeleton (face rig and toes removed; eyes, lids, ears and the jaw
    become simple copied bones) and generate the control rig. Returns (metarig, rig) or (None, None)."""
    if not rigify_available():
        return None, None
    bpy.ops.object.armature_cat_metarig_add()
    mr = bpy.context.object
    mr.name = 'metarig'
    bpy.ops.object.mode_set(mode='EDIT')
    eb = mr.data.edit_bones
    keep = set(METARIG_MAP)
    for b in list(eb):
        if b.name not in keep:
            eb.remove(b)
    for mb, gb in METARIG_MAP.items():
        h, t, parent, deform, up = table[gb]
        b = eb[mb]
        b.use_connect = False
        b.head = V(h); b.tail = V(t)
        b.align_roll(V(up))
    for mb, gb in METARIG_MAP.items():
        parent = table[gb][2]
        if parent and parent in eb:
            eb[mb].parent = eb[parent]
            # Rigify wants the neck (a new rig) unconnected, as in its own metarig
            eb[mb].use_connect = mb != 'spine.004' and (eb[mb].head - eb[parent].tail).length < 1e-5
        elif parent == 'root':
            eb[mb].parent = None
    # face bits as simple deforming copies
    extra = [n for n in table if n.startswith(('eye.', 'lid.', 'ear.')) or n == 'jaw']
    for n in extra:
        h, t, parent, deform, up = table[n]
        b = eb.new(n); b.head = V(h); b.tail = V(t); b.align_roll(V(up)); b.parent = eb[parent]
    bpy.ops.object.mode_set(mode='POSE')
    for n in extra:
        pb = mr.pose.bones[n]
        pb.rigify_type = 'basic.super_copy'
        pb.rigify_parameters.make_deform = True
    # the tail starts behind the pelvis, not at its head: don't ask Rigify to join the chains
    if hasattr(mr.pose.bones['tail.001'].rigify_parameters, 'connect_chain'):
        mr.pose.bones['tail.001'].rigify_parameters.connect_chain = False
    for s in ('L', 'R'):
        for n in (f'upper_arm.{s}', f'thigh.{s}'):
            if hasattr(mr.pose.bones[n].rigify_parameters, 'segments'):
                mr.pose.bones[n].rigify_parameters.segments = 1
    bpy.ops.object.mode_set(mode='OBJECT')
    try:
        bpy.ops.pose.rigify_generate()
    except Exception as ex:  # noqa: BLE001
        print('rigify generate failed:', ex)
        return mr, None
    rig = bpy.context.object
    rig.name = 'controls'
    return mr, rig


def link_to_rigify(game, rig):
    """Game bones copy the Rigify DEF bones (constraints muted: the scripted clips drive the game
    skeleton directly; unmute them to animate with the Rigify controls and re-bake)."""
    if rig is None:
        return 0
    n = 0
    for pb in game.pose.bones:
        src = 'DEF-' + pb.name
        if src in rig.pose.bones:
            c = pb.constraints.new('COPY_TRANSFORMS')
            c.target = rig; c.subtarget = src; c.mute = True; c.name = 'rigify'
            n += 1
    return n


# ── weights ────────────────────────────────────────────────────────────────────
def auto_weights(mesh, arm, exclude=()):
    saved = {}
    for b in arm.data.bones:
        if b.name in exclude:
            saved[b.name] = b.use_deform
            b.use_deform = False
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for n, v in saved.items():
        arm.data.bones[n].use_deform = v


def weight_matrix(mesh, names):
    n = len(mesh.data.vertices)
    W = np.zeros((n, len(names)))
    gi = {g.index: names.index(g.name) for g in mesh.vertex_groups if g.name in names}
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.group in gi:
                W[v.index, gi[g.group]] = g.weight
    return W


def write_weights(mesh, names, W, limit=4):
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    groups = [mesh.vertex_groups.new(name=n) for n in names]
    # keep the top `limit`, renormalise
    idx = np.argsort(-W, axis=1)[:, :limit]
    for v in range(W.shape[0]):
        ws = W[v, idx[v]]
        s = ws.sum()
        if s <= 0:
            continue
        for k, w in zip(idx[v], ws / s):
            if w > 1e-4:
                groups[k].add([v], float(w), 'REPLACE')


def smooth_weights(mesh, W, passes=6, factor=0.5, keep=None):
    e = np.empty(len(mesh.data.edges) * 2, np.int64)
    mesh.data.edges.foreach_get('vertices', e)
    e = e.reshape(-1, 2)
    n = W.shape[0]
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    for _ in range(passes):
        acc = np.zeros_like(W)
        np.add.at(acc, e[:, 0], W[e[:, 1]])
        np.add.at(acc, e[:, 1], W[e[:, 0]])
        avg = acc / np.maximum(deg, 1)[:, None]
        W = W * (1 - factor) + avg * factor
        if keep is not None:
            W[keep] = W[keep]
    s = W.sum(1, keepdims=True)
    return np.where(s > 0, W / np.maximum(s, 1e-9), W)


def seg_dist(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1), t


def fix_weights(mesh, arm, table, plan):
    """Smooth the automatic weights and keep the barrel off the legs: a leg bone may only hold
    vertices near its own column and away from the belly midline (stops the belly following a leg)."""
    names = [b.name for b in arm.data.bones if b.use_deform]
    W = weight_matrix(mesh, names)
    co = np.empty(len(mesh.data.vertices) * 3); mesh.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    mw = np.array(mesh.matrix_world)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    # vertices with no weight: nearest deform bone
    empty = W.sum(1) <= 0
    if empty.any():
        D = np.stack([seg_dist(co[empty], np.array(table[n][0]), np.array(table[n][1]))[0] for n in names], 1)
        W[np.where(empty)[0], np.argmin(D, 1)] = 1
    W = smooth_weights(mesh, W, passes=4, factor=0.5)
    reach = {'upper_arm': 0.05, 'thigh': 0.065, 'shoulder': 0.06}
    for i, n in enumerate(names):
        base = n.split('.')[0]
        if base not in reach:
            continue
        h, t = np.array(table[n][0]), np.array(table[n][1])
        d, _ = seg_dist(co, h, t)
        near = np.clip(1 - (d - reach[base]) / 0.03, 0, 1)
        mid = np.clip((np.abs(co[:, 0]) - 0.02) / 0.03, 0, 1)
        W[:, i] *= near * mid
    s = W.sum(1)
    empty = s <= 1e-6
    if empty.any():
        sp = [names.index(n) for n in ('spine', 'spine.001', 'spine.002', 'spine.003') if n in names]
        D = np.stack([seg_dist(co[empty], np.array(table[names[k]][0]), np.array(table[names[k]][1]))[0] for k in sp], 1)
        W[np.where(empty)[0], np.array(sp)[np.argmin(D, 1)]] = 1
    W = smooth_weights(mesh, W, passes=3, factor=0.4)
    write_weights(mesh, names, W, 4)
    return names


def rigid_bind(ob, arm, bone):
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    g = ob.vertex_groups.new(name=bone)
    g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    ob.parent = arm
    m = ob.modifiers.new('armature', 'ARMATURE'); m.object = arm
