"""The studio's kit head on a Blender person (the hybrid face).

The Node side (kitface.ts) cuts the head from a kit character: skin, ears, neck, eyes, lid shells,
brows, lips, mouth chamber, teeth rows, gums, tongue and the lock haircut, with the 33 face shapes, the
face paint texture and its UVs. Here it becomes one Blender mesh in the person's frame: placed on the
person's neck, its neck carried on down under the collar, shape keys under the studio's names, one skin
material shared with the hands, and the landmarks (eyes, ears, nose, mouth) the glasses, bones and
clips are fitted to.

Kit coordinates: Y up, faces +Z, the character's left is +X. Plan coordinates (plan_person): x left,
f forward, z up. Blender: x left, -Y forward, Z up.
"""
import json
import numpy as np
import bpy
import bmesh
import mathutils

import plan_person as pp

# the paint texture's plain skin (the body band of the atlas, which a person without body markings
# paints in the head's skin colour): hands and the neck extension sample it, so all skin is one material
PLAIN_SKIN_UV = (0.5, 1 - 0.7)


def load(path):
    with open(path) as f:
        return json.load(f)


class Fit:
    """Kit coordinates -> plan coordinates: a uniform scale and a shift (the kit neck base onto the person's)."""

    def __init__(self, face, neck_plan, k=1.0):
        self.k = k
        nb = np.array(face['landmarks']['bones']['Neck']['head'], float)
        self.t = np.asarray(neck_plan, float) - self.axes(nb) * k

    @staticmethod
    def axes(q):
        q = np.asarray(q, float)
        return q[..., [0, 2, 1]]

    def plan(self, q):
        return self.axes(q) * self.k + self.t

    def blender(self, q):
        return pp.to_blender(self.plan(np.asarray(q, float)))

    def vec(self, d):
        """A displacement (kit) -> Blender."""
        return pp.to_blender(self.axes(d) * self.k)


def build(face, fit, png_path, name, skin_props):
    """The head mesh with materials, UVs and shape keys. Returns (object, parts list, part index per vertex)."""
    P = np.asarray(face['positions'], float).reshape(-1, 3)
    co = fit.blender(P)
    tris = np.asarray(face['triangles'], np.int64).reshape(-1, 3)
    me = bpy.data.meshes.new(name)
    me.from_pydata(co.tolist(), [], tris.tolist())
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    # materials
    img = bpy.data.images.load(png_path)
    img.colorspace_settings.name = 'sRGB'
    mats = []
    for m in face['materials']:
        mats.append(_material(m, img, skin_props))
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set('material_index', np.asarray(face['triMaterial'], np.int32))
    # UVs: painted materials carry corner UVs (glTF convention, v down); the rest sample plain skin
    uv = me.uv_layers.new(name='UVMap')
    luv = np.tile(np.array(PLAIN_SKIN_UV), (len(me.loops), 1))
    tm = np.asarray(face['triMaterial'])
    for mi, arr in face['uvs'].items():
        a = np.asarray(arr, float).reshape(-1, 2)
        tri_ids = np.where(tm == int(mi))[0]
        loops = (tri_ids[:, None] * 3 + np.arange(3)[None, :]).reshape(-1)
        luv[loops, 0] = a[:, 0]
        luv[loops, 1] = 1 - a[:, 1]
    uv.data.foreach_set('uv', luv.reshape(-1))
    for p in me.polygons:
        p.use_smooth = True
    # parts per vertex
    parts = sorted(set(face['parts']))
    pidx = np.array([parts.index(p) for p in face['parts']], np.int32)
    a = me.attributes.new('part', 'INT', 'POINT')
    a.data.foreach_set('value', pidx)
    return ob, parts, pidx


def add_shapes(ob, face, fit):
    """Basis plus the 33 face shapes (sparse kit deltas, carried into Blender's frame)."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    ob.shape_key_add(name='Basis', from_mix=False)
    for k, sd in face['shapes'].items():
        d = np.zeros((n, 3))
        idx = np.asarray(sd['idx'], np.int64)
        if len(idx):
            d[idx] = fit.vec(np.asarray(sd['d'], float).reshape(-1, 3))
        key = ob.shape_key_add(name=f'viseme_{k}' if k in face['visemes'] else k, from_mix=False)
        key.data.foreach_set('co', (co + d).reshape(-1))
        key.value = 0.0
    return [kb.name for kb in me.shape_keys.key_blocks[1:]]


SOFT_PARTS = ('Head', 'hair', 'Neck', 'nose')   # (not the ears: thin flaps that smoothing would melt)


def soften(ob, fparts, L, fit, max_edge=0.011, iters=8):
    """The kit head is a low-poly hull with smoothed normals: in close-ups its skull, jaw, ears and hair
    locks still read as planes. Split its long edges once and relax the skin and hair (Taubin smoothing,
    which keeps the volume), away from the eyes, lids, brows and mouth, whose forms and checks the kit
    owns, and from the ears. Shape keys ride along as displacements, so every face shape keeps its motion."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    layers = [bm.verts.layers.shape[k] for k in bm.verts.layers.shape.keys()][1:]
    for v in bm.verts:
        for ly in layers:
            v[ly] = v[ly] - v.co                 # keys as displacements while the mesh changes
    pl = bm.verts.layers.int['part']
    soft = {fparts.index(p) for p in SOFT_PARTS if p in fparts}
    eyes = [pp.to_blender(c) for c, _ in L['eyes'].values()]
    er = next(iter(L['eyes'].values()))[1]
    mouth = pp.to_blender(L['mouth'])
    mw = L['mouthW']
    ears = [pp.to_blender(c) for _, c in L['ears'].values()]

    def keep_out(co):
        """1 where smoothing may act fully, 0 near the eyes and the mouth."""
        p = np.array(co)
        de = min(np.linalg.norm(p - e) for e in eyes) / er
        dm = np.linalg.norm((p - mouth) * np.array([1 / (1.5 * mw), 1, 1 / (1.6 * mw)]))
        da = min(np.linalg.norm(p - e) for e in ears)
        return float(np.clip((de - 1.9) / 0.6, 0, 1) * np.clip((dm - 1.0) / 0.5, 0, 1) * np.clip((da - 0.03) / 0.02, 0, 1))
    long_ = [e for e in bm.edges if e.calc_length() > max_edge and all(v[pl] in soft for v in e.verts)
             and min(keep_out(v.co) for v in e.verts) > 0]
    n_old = len(bm.verts)
    bmesh.ops.subdivide_edges(bm, edges=long_, cuts=1, use_grid_fill=True)
    # a new vertex (appended after the old ones) takes the part of a soft old neighbour: an interpolated
    # part number would name some other part
    bm.verts.index_update()
    bm.verts.ensure_lookup_table()
    head_i = fparts.index('Head')
    for v in bm.verts[n_old:]:
        v[pl] = next((o[pl] for o in (e.other_vert(v) for e in v.link_edges) if o.index < n_old and o[pl] in soft), head_i)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.verts.ensure_lookup_table()
    n = len(bm.verts)
    co = np.array([v.co for v in bm.verts])
    w = np.array([keep_out(v.co) if v[pl] in soft and not v.is_boundary else 0.0 for v in bm.verts])
    nb = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    # (only soft neighbours count: a skin vertex next to a lip is not pulled toward the lip)
    nb = [[j for j in js if bm.verts[j][pl] in soft] or [i] for i, js in enumerate(nb)]
    # where the haircut's scalp cap ends on the skin it leaves a step, which reads as a peeling flap at the
    # temples: flatten a band either side of that edge first (plain smoothing), then relax everything
    part = np.array([v[pl] for v in bm.verts])
    hair_i, head_i = (fparts.index('hair') if 'hair' in fparts else -1), fparts.index('Head')
    band = np.zeros(n, bool)
    for i, js in enumerate(nb):
        if part[i] in (hair_i, head_i) and any(part[j] != part[i] and part[j] in (hair_i, head_i) for j in js):
            band[i] = True
    for _ in range(3):
        band = band | np.array([band[js].any() for js in nb])
    wb = np.where(band, w, 0.0)
    for _ in range(12):
        avg = np.array([co[js].mean(0) for js in nb])
        co = co + (0.5 * wb)[:, None] * (avg - co)
    w = np.where(part == hair_i, 0.45 * w, w)        # (the locks keep some of their chunk)
    for _ in range(iters):
        for lam in (0.5, -0.53):
            avg = np.array([co[js].mean(0) for js in nb])
            co = co + (lam * w)[:, None] * (avg - co)
    for v, c in zip(bm.verts, co):
        v.co = c
    for v in bm.verts:
        for ly in layers:
            v[ly] = v[ly] + v.co
    basis = bm.verts.layers.shape[bm.verts.layers.shape.keys()[0]]
    for v in bm.verts:
        v[basis] = v.co
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me); bm.free()
    me.update()
    pidx = np.empty(len(me.vertices), np.int32); me.attributes['part'].data.foreach_get('value', pidx)
    return pidx, len(long_)


def thicken_neck(ob, fparts, L, k=1.22):
    """A dad's neck: thicker than the kit's, most at the base, blending into the jaw (before the shape keys)."""
    me = ob.data
    pidx = np.empty(len(me.vertices), np.int32); me.attributes['part'].data.foreach_get('value', pidx)
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    hb = pp.to_blender(L['headBase']); nk = pp.to_blender(L['bones']['Neck'][0])
    soft = np.isin(pidx, [fparts.index(p) for p in ('Head', 'Neck') if p in fparts])
    t = np.clip((hb[2] - co[:, 2]) / (hb[2] - nk[2]), 0, 1)
    f = 1 + (k - 1) * (t * t * (3 - 2 * t))
    f = np.where(soft, f, 1.0)
    co[:, 0] = nk[0] + (co[:, 0] - nk[0]) * f
    co[:, 1] = nk[1] + (co[:, 1] - nk[1]) * f
    me.vertices.foreach_set('co', co.reshape(-1))
    me.update()


def sculpt_ears(ob, fparts, L, skin_m, scale=1.0):
    """The kit's ears are small low-poly flaps (33 triangles): tuck them in and give the head sculpted
    ears instead, a rim round a hollow bowl with a lobe, leaning back a little, grown out of the side of
    the head (fields meshed in Blender, joined to the head mesh, in the skin material)."""
    import body
    import sdf
    from mathutils.bvhtree import BVHTree
    me = ob.data
    pidx = np.empty(len(me.vertices), np.int32); me.attributes['part'].data.foreach_get('value', pidx)
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
    made = []
    for side, sx, pname in (('Left', 1, 'ear.L'), ('Right', -1, 'ear.R')):
        if pname not in fparts:
            continue
        m = pidx == fparts.index(pname)
        root = np.abs(co[m, 0]).min()
        co[m, 0] = sx * (root + (np.abs(co[m, 0]) - root) * 0.25)
        _, centre = L['ears'][side]
        cb = pp.to_blender(centre)
        loc, *_ = bvh.ray_cast(mathutils.Vector((cb[0] + sx * 0.2, cb[1], cb[2])), mathutils.Vector((-sx, 0, 0)), 0.4)
        sx_surf = loc.x if loc is not None else cb[0]
        base = np.array([sx_surf, centre[1] - 0.004, centre[2] + 0.002])   # plan coords (x is the same)
        k = scale
        tilt = np.radians(14)
        ct, st = np.cos(tilt), np.sin(tilt)

        def field(q):
            rel = q - base
            u = rel[:, 0] * sx
            f = rel[:, 1] * ct + rel[:, 2] * st          # lean the top back
            z = -rel[:, 1] * st + rel[:, 2] * ct
            p = np.stack([u, f, z], 1)
            outer = sdf.ellipsoid(p, np.array([0.0075, -0.002, 0.0]) * k, np.array([0.0085, 0.019, 0.03]) * k)
            rootd = sdf.ellipsoid(p, np.array([-0.002, 0.004, -0.003]) * k, np.array([0.007, 0.012, 0.02]) * k)
            d = sdf.smin(outer, rootd, 0.004 * k)
            bowl = sdf.ellipsoid(p, np.array([0.0135, 0.0, 0.002]) * k, np.array([0.0062, 0.0125, 0.021]) * k)
            d = sdf.smax(d, -bowl, 0.0025 * k)
            # the concha: a deeper hollow in front of the bowl's middle, by the ear canal
            concha = sdf.ellipsoid(p, np.array([0.011, 0.005, -0.006]) * k, np.array([0.005, 0.006, 0.008]) * k)
            return sdf.smax(d, -concha, 0.002 * k)
        bl = pp.to_blender(base)
        lo = bl - np.array([0.03, 0.04, 0.045]); hi = bl + np.array([0.03, 0.04, 0.045])
        ear, _ = body.build_surface(f'{pname}', lambda P: field(pp.from_blender(P)), lo, hi, 0.0007, 450, relax_iters=2, quads=False)
        ear.data.materials.append(skin_m)
        uv = ear.data.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', np.tile(np.array(PLAIN_SKIN_UV), len(ear.data.loops)))
        a = ear.data.attributes.new('part', 'INT', 'POINT')
        a.data.foreach_set('value', np.full(len(ear.data.vertices), fparts.index(pname), np.int32))
        for poly in ear.data.polygons:
            poly.use_smooth = True
        made.append(ear)
    me.vertices.foreach_set('co', co.reshape(-1))
    me.update()
    tris = sum(len(e.data.polygons) for e in made)
    if made:
        bpy.ops.object.select_all(action='DESELECT')
        for e in made:
            e.select_set(True)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.join()
    return tris


def extend_neck(ob, down, flare=1.12, rings=3):
    """Carry the open neck edge on down under the collar: a few rings, flaring a little toward the shoulders."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    edges = [e for e in bm.edges if len(e.link_faces) == 1]
    if not edges:
        bm.free()
        return 0
    # the lowest open loop is the neck's
    zmin = min(min(v.co.z for v in e.verts) for e in edges)
    loop = [e for e in edges if min(v.co.z for v in e.verts) < zmin + 0.04]
    verts = list({v for e in loop for v in e.verts})
    cx = sum(v.co.x for v in verts) / len(verts); cy = sum(v.co.y for v in verts) / len(verts)
    zb = min(v.co.z for v in verts)
    geom = loop
    made = 0
    for r in range(1, rings + 1):
        res = bmesh.ops.extrude_edge_only(bm, edges=geom)
        nv = [g for g in res['geom'] if isinstance(g, bmesh.types.BMVert)]
        t = r / rings
        for v in nv:
            dx, dy = v.co.x - cx, v.co.y - cy
            f = 1 + (flare - 1) * t * t
            v.co.x = cx + dx * f / (1 + (flare - 1) * ((r - 1) / rings) ** 2)
            v.co.y = cy + dy * f / (1 + (flare - 1) * ((r - 1) / rings) ** 2)
            v.co.z = zb - down * t
        geom = [g for g in res['geom'] if isinstance(g, bmesh.types.BMEdge) and all(v in nv for v in g.verts)]
        made += len(nv)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me); bm.free()
    me.update()
    return made


def landmarks(face, fit):
    """Plan-coordinate landmarks (eyes, ears, nose, mouth, bones) for glasses, bones and clips."""
    L = face['landmarks']
    k = fit.k
    out = dict(
        eyes={e['side']: (fit.plan(e['c']), e['r'] * k) for e in L['eyes']},
        ears={e['side']: (fit.plan(e['top']), fit.plan(e['centre'])) for e in L['ears']},
        nose=fit.plan(L['nose']), mouth=fit.plan(L['mouth']), mouthW=L['mouthW'] * k,
        headBase=fit.plan(L['headBase']), headH=L['headH'] * k, hw=L['hw'] * k, hd=L['hd'] * k,
        bones={n: (fit.plan(b['head']), fit.plan(b['tail'])) for n, b in L['bones'].items()},
        lids=L['lids'], kitEyes=L['eyes'],
    )
    return out


def face_checks(ob, fparts, L):
    """The kit's face checks (faceforms.test.ts), run on the finished Blender head: no face shape moves an
    eyeball; at every blink, squint and brow mix the lids stay outside the eyeball and the lower lid stays
    outside the upper one; a full blink shuts the eye; skin round the eye never comes in to the lids; the
    lips stay joined to the skin in speech shapes; both rows of teeth are there."""
    me = ob.data
    kb = me.shape_keys.key_blocks
    n = len(me.vertices)
    base = np.empty(n * 3); kb[0].data.foreach_get('co', base); base = base.reshape(-1, 3)
    D = {}
    for k in kb[1:]:
        a = np.empty(n * 3); k.data.foreach_get('co', a)
        D[k.name] = a.reshape(-1, 3) - base
    pidx = np.empty(n, np.int32); me.attributes['part'].data.foreach_get('value', pidx)
    part = np.array(fparts)[pidx]
    out = []

    def check(name, ok, detail):
        out.append({'name': name, 'pass': bool(ok), 'detail': detail})
    eye = np.char.startswith(part.astype(str), 'LeftEye') | np.char.startswith(part.astype(str), 'RightEye')
    moved = max(float(np.abs(d[eye]).max()) for d in D.values()) if eye.any() else float('inf')
    check('no face shape moves an eyeball', moved < 1e-6, f'largest eyeball move {moved * 1000:.3f} mm')
    lid0 = L['lids'][0]
    kr = L['eyes']['Left'][1] / next(e for e in L['kitEyes'] if e['side'] == 'Left')['r']
    worst_up, worst_order, worst_skin, shut = 9.0, 9.0, 9.0, True
    looks = []
    for b in (0, 0.25, 0.5, 0.75, 1):
        for sq, bd, up in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0.5, 0.5, 0), (1, 1, 0), (0, 0, 1)):
            looks.append(dict(eyeBlinkLeft=b, eyeBlinkRight=b, cheekSquintLeft=sq, cheekSquintRight=sq, browDownLeft=bd, browDownRight=bd,
                              browOuterUpLeft=up, browOuterUpRight=up, browInnerUp=up))
    for side, sd in (('Left', 'L'), ('Right', 'R')):
        c, r = L['eyes'][side]
        c = pp.to_blender(c)
        up_m, lo_m = part == f'lid.{sd}', part == f'lidLow.{sd}'
        near = np.isin(part, ['Head', 'eyeSocket']) & (np.linalg.norm(base - c, axis=1) < 1.6 * r)
        low_out = lid0['lowOut'] * kr / r
        for ex in looks:
            P = base + sum(D[k] * w for k, w in ex.items() if w)
            rel = P - c
            dist = np.linalg.norm(rel, axis=1) / r
            yz = np.hypot(rel[:, 1], rel[:, 2]) / r
            elev = np.arctan2(rel[:, 2], -rel[:, 1])
            worst_up = min(worst_up, float(dist[up_m].min()))
            lo_top = elev[lo_m & (yz > 0.5)].max() + 0.05
            band = up_m & (yz > 0.5) & (elev < lo_top) & (elev > -0.75 * np.pi)
            if band.any():
                worst_order = min(worst_order, float(dist[lo_m].min() - dist[band].max()))
            if near.any():
                worst_skin = min(worst_skin, float(dist[near].min() - low_out))
            if ex['eyeBlinkLeft'] == 1:
                mid = np.abs(rel[:, 0]) < 0.5 * r
                shut = shut and elev[up_m & mid].min() < elev[lo_m & mid].max() - 0.05
    check('lids stay outside the eyeball at every blink, squint and brow mix', worst_up > 1.03, f'closest upper lid {worst_up:.3f} r (eyeball within 1.03 r)')
    check('the lower lid stays outside the upper one where they overlap', worst_order > 0, f'margin {worst_order:.3f} r')
    check('a full blink shuts the eye (no sliver)', shut, 'upper lid edge below the lower lid edge' if shut else 'a sliver stays open')
    check('skin round the eye never comes in to the lids', worst_skin > 0, f'margin {worst_skin:.3f} r')
    # lips joined to the skin
    hH = L['headH']
    lip = np.isin(part, ['lipUpper', 'lipLower'])
    mouth = pp.to_blender(L['mouth'])
    skin = (part == 'Head') & (np.linalg.norm(base - mouth, axis=1) < 0.2 * hH)
    worst = 0.0
    if lip.any() and skin.any():
        S = base[skin]
        for k in ('viseme_aa', 'viseme_oh', 'viseme_ou', 'viseme_E', 'viseme_FF', 'jawOpen', 'mouthSmileLeft'):
            for v in np.where(lip)[0]:
                dd = np.linalg.norm(S - base[v], axis=1)
                j = int(dd.argmin())
                if dd[j] > 0.004 * hH:
                    continue
                worst = max(worst, float(np.linalg.norm(D[k][v] - D[k][np.where(skin)[0][j]])))
    check('lips stay joined to the skin in speech shapes', lip.any() and worst < 0.004 * hH, f'largest seam gap {worst / hH * 100:.2f}% of the head')
    teeth = [int((part == p).sum()) for p in ('teethUpper', 'teethLower', 'gumUpper', 'tongue')]
    check('teeth rows, gums and a tongue', all(t > 0 for t in teeth), f'vertices {teeth}')
    return out


def _hex(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _material(m, img, skin_props):
    name = m['name']
    col = tuple(_hex(m['color']))
    mat = bpy.data.materials.get(f'kit-{name}-{m.get("paint", "")}-{m["color"]}')
    if mat:
        return mat
    mat = bpy.data.materials.new(f'kit-{name}-{m.get("paint", "")}-{m["color"]}')
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Roughness'].default_value = float(m.get('roughness', 0.6))
    b.inputs['Metallic'].default_value = float(m.get('metalness', 0))
    b.inputs['Specular IOR Level'].default_value = 0.35
    if name in ('skin', 'lips') or (name == 'hair' and m.get('paint')):
        for k_, v in skin_props.items():
            if k_ in b.inputs:
                b.inputs[k_].default_value = v
        if name == 'hair':
            b.inputs['Roughness'].default_value = 0.6
            b.inputs['Sheen Weight'].default_value = 0.4
    if name in ('eye white', 'iris', 'pupil'):
        b.inputs['Coat Weight'].default_value = 1.0
        b.inputs['Coat Roughness'].default_value = 0.03
        b.inputs['Roughness'].default_value = 0.25
    if name == 'catch-light':
        b.inputs['Emission Color'].default_value = (1, 1, 1, 1)
        b.inputs['Emission Strength'].default_value = 1.5
    if name in ('teeth',):
        b.inputs['Roughness'].default_value = 0.3
    if m.get('paint'):
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = img
        tx.interpolation = 'Linear'; tx.extension = 'EXTEND'
        nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
    mat.use_backface_culling = True
    return mat
