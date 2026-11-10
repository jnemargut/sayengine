"""Cat eyelids that close by shape keys (a GLB player blends morph weights, so the blink plays anywhere).

Each eye has an upper and a lower lid shell and a third eyelid (the nictitating membrane), all thin
spherical shells round the eyeball, tucked under the head's fur at rest. The keys:
  blinkL / blinkR          both lids close; the cat's lower lid rises a good way (it meets below centre)
  eyeSquintL / eyeSquintR  the content squint: both lids part way in, the lower lid more than usual
  nictitateL / nictitateR  the third eyelid sweeps across from the inner corner
A morph is a straight-line blend, so a lid point travelling over the eye would cut through the eyeball
half way. Two things stop that: the lid stretches (its edge rows travel far, its back rows hardly move),
and the eyeball retracts as the lids close (cats do pull the globe back when they blink; that is also
what drives the third eyelid across). Every key is checked along its whole blend (eye_checks).
"""
import bpy
import bmesh
import numpy as np

TAG = {'eye': (1, 2), 'pupil': (3, 4), 'lidT': (5, 6), 'lidB': (7, 8), 'nict': (9, 10)}

OPEN = 62.0          # lid edge at rest: degrees from the gaze (under the fur round the eye)
BACK = 120.0         # the shells run back to here, out of sight inside the head
R_UP, R_LO, R_NICT = 1.035, 1.02, 1.012
# key: (upper lid deg, lower lid deg, third eyelid deg, eyeball retraction (scale lost), pivot behind centre in r)
KEYS = {
    'blink': (76.0, 55.0, 0.0, 0.30, 1.3),
    'eyeSquint': (30.0, 30.0, 0.0, 0.10, 1.3),
    'nictitate': (0.0, 0.0, 65.0, 0.45, 1.5),       # the globe pulls back hard: that is what drives the third eyelid
}
NICT_HOME = 92.0     # the third eyelid's centre at rest, degrees off the gaze (hidden in the inner corner)
NICT_R = 24.0        # its angular radius
CLEAR = 1.008        # lids stay at least this far out (x eyeball radius) at every point of every blend


def frame(direction):
    g = np.array(direction, float); g /= np.linalg.norm(g)
    up = np.array([0, 0, 1.0]); up = up - g * (up @ g); up /= np.linalg.norm(up)
    right = np.cross(up, g)
    return g, up, right


def _shell(name, centre, direction, r, R, th0, th1, ph0, ph1, around=None, nth=10, nph=22, rim_rows=1, thickness=0.0008, tag=0):
    """A shell on the sphere of radius R*r: rows from th0 (the free edge) to th1 degrees off `around`
    (default the gaze), columns ph0..ph1 degrees round it (0 = the eye's right, 90 = up)."""
    g, up, right = frame(direction)
    a = g if around is None else np.array(around, float) / np.linalg.norm(around)
    # a basis round `a`
    ref = up - a * (up @ a)
    if np.linalg.norm(ref) < 1e-6:
        ref = right - a * (right @ a)
    ref /= np.linalg.norm(ref)
    side = np.cross(ref, a)
    u = np.linspace(0, 1, nth) ** 1.5                 # dense at the free edge
    th = np.radians(th0 + (th1 - th0) * u)
    ph = np.radians(np.linspace(ph0, ph1, nph))
    verts = []
    for t in th:
        for p in ph:
            d = a * np.cos(t) + np.sin(t) * (side * np.cos(p) + ref * np.sin(p))
            verts.append(np.array(centre) + d * R * r)
    faces = []
    for i in range(nth - 1):
        for j in range(nph - 1):
            q = (i * nph + j, i * nph + j + 1, (i + 1) * nph + j + 1, (i + 1) * nph + j)
            faces.append(q[::-1])
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    for k, poly in enumerate(me.polygons):
        poly.material_index = 1 if (k // (nph - 1)) < rim_rows else 0
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    # outward normals
    bm = bmesh.new(); bm.from_mesh(me)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    c = np.array(centre)
    if bm.faces and np.dot(np.array(bm.faces[0].normal), np.array(bm.faces[0].calc_center_median()) - c) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(me); bm.free()
    sol = ob.modifiers.new('solid', 'SOLIDIFY'); sol.thickness = thickness; sol.offset = 1.0; sol.use_rim = True
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier='solid')
    at = me.attributes.new('eyepart', 'INT', 'POINT')
    at.data.foreach_set('value', [tag] * len(me.vertices))
    return ob


def lids(side, centre, direction, r):
    """(upper, lower, third eyelid) for one eye; side 'L' or 'R'."""
    k = 0 if side == 'L' else 1
    sx = 1 if side == 'L' else -1
    up = _shell(f'lid.T.{side}', centre, direction, r, R_UP, OPEN, BACK, 0, 180, tag=TAG['lidT'][k])
    lo = _shell(f'lid.B.{side}', centre, direction, r, R_LO, OPEN, BACK, 180, 360, tag=TAG['lidB'][k])
    g, upv, right = frame(direction)
    nasal = np.array([-sx, 0, 0.0]); nasal = nasal - g * (nasal @ g); nasal /= np.linalg.norm(nasal)
    # the third eyelid waits in the inner corner, a little low; it sweeps out across the eye
    home = nasal * 0.94 - upv * 0.34; home /= np.linalg.norm(home)
    nict = _shell(f'nict.{side}', centre, direction, r, R_NICT, 1.0, NICT_R, 0, 360, around=g * np.cos(np.radians(NICT_HOME)) + home * np.sin(np.radians(NICT_HOME)),
                  nth=7, nph=20, rim_rows=0, thickness=0.0004, tag=TAG['nict'][k])
    return up, lo, nict


def tag(ob, value):
    at = ob.data.attributes.get('eyepart') or ob.data.attributes.new('eyepart', 'INT', 'POINT')
    at.data.foreach_set('value', [value] * len(ob.data.vertices))


def _rot(v, axis, ang):
    axis = axis / np.linalg.norm(axis)
    c, s = np.cos(ang)[:, None], np.sin(ang)[:, None]
    return v * c + np.cross(axis, v) * s + np.outer(v @ axis, axis) * (1 - c)


def _plan(co, tags, side, centre, direction, r, key):
    """New positions for one eye under one key, and the clearance along the blend."""
    k = 0 if side == 'L' else 1
    sx = 1 if side == 'L' else -1
    a_up, a_lo, a_ni, shrink, h = KEYS[key]
    g, up, right = frame(direction)
    c = np.array(centre)
    new = co.copy()
    pivot = c - g * h * r
    eye = np.isin(tags, (TAG['eye'][k], TAG['pupil'][k]))
    new[eye] = pivot + (co[eye] - pivot) * (1 - shrink)
    moving = []
    nasal = np.array([-sx, 0, 0.0]); nasal = nasal - g * (nasal @ g); nasal /= np.linalg.norm(nasal)
    home = nasal * 0.94 - up * 0.34; home /= np.linalg.norm(home)
    for which, ang, axis in (('lidT', a_up, np.cross(up, g)), ('lidB', a_lo, np.cross(-up, g)), ('nict', a_ni, np.cross(home, g))):
        if not ang:
            continue
        m = tags == TAG[which][k]
        rel = co[m] - c
        if which == 'nict':
            # the membrane slides as a piece (its trailing edge a little less), out to past the centre
            th = np.degrees(np.arccos(np.clip((rel / np.linalg.norm(rel, axis=1)[:, None]) @ home, -1, 1)))
            amt = np.radians(ang) * (1 - 0.25 * np.clip(th / NICT_R, 0, 1))
        else:
            th = np.degrees(np.arccos(np.clip((rel / np.linalg.norm(rel, axis=1)[:, None]) @ g, -1, 1)))
            amt = np.radians(ang) * np.clip((BACK - th) / (BACK - OPEN), 0, 1)     # the lid stretches
        b0 = _rot(rel, axis, amt)
        # push out only as much as needed to stay clear of the (retracting) eyeball all along the blend
        kk = np.ones(len(rel))
        for _ in range(60):
            bad = _clear(rel, b0 * kk[:, None], g, r, shrink, h) < CLEAR
            if not bad.any():
                break
            kk[bad] += 0.01
        new[m] = c + b0 * kk[:, None]
        moving.append((rel, b0 * kk[:, None]))
    worst = min((float(_clear(a, b, g, r, shrink, h).min()) for a, b in moving), default=9.0)
    return new, worst


def _clear(a, b, g, r, shrink, h, steps=21):
    """Smallest distance (in eyeball radii at that moment) from the eyeball's centre along a -> b."""
    out = np.full(len(a), 9.0)
    for w in np.linspace(0, 1, steps):
        p = a + w * (b - a)
        cw = -g * h * r * shrink * w          # the eyeball's centre moves toward the pivot as it shrinks
        rr = r * (1 - shrink * w)
        out = np.minimum(out, np.linalg.norm(p - cw, axis=1) / rr)
    return out


def add_keys(ob, eyes):
    """eyes: {'L': (centre, direction, r), 'R': ...}. Adds blinkL/R, eyeSquintL/R, nictitateL/R.
    Returns checks: [{name, pass, detail}]."""
    if 'eyepart' not in ob.data.attributes:
        return []
    n = len(ob.data.vertices)
    tags = np.empty(n, np.int32); ob.data.attributes['eyepart'].data.foreach_get('value', tags)
    co = np.empty(n * 3); ob.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    if ob.data.shape_keys is None:
        ob.shape_key_add(name='Basis', from_mix=False)
    checks = []
    for key in KEYS:
        for side in ('L', 'R'):
            c, d, r = eyes[side]
            new, worst = _plan(co, tags, side, c, d, r, key)
            kb = ob.shape_key_add(name=f'{key}{side}', from_mix=False)
            kb.data.foreach_set('co', new.reshape(-1))
            checks.append({'name': f'{key}{side} never cuts the eyeball', 'pass': bool(worst >= CLEAR - 1e-3),
                           'detail': f'closest lid point {worst:.3f} r from the retracting eyeball (limit {CLEAR})'})
    # a full blink shuts: on the gaze line, the upper lid edge ends below the lower lid edge
    for side in ('L', 'R'):
        c, d, r = eyes[side]
        k = 0 if side == 'L' else 1
        g, up, right = frame(d)
        kb = ob.data.shape_keys.key_blocks[f'blink{side}']
        bco = np.empty(n * 3); kb.data.foreach_get('co', bco); bco = bco.reshape(-1, 3)
        def edge(which, low):
            m = tags == TAG[which][k]
            rel = bco[m] - np.array(c)
            near = np.abs(rel @ right) < r * 0.15
            ys = rel[near] @ up
            return ys.min() if low else ys.max()
        gap = edge('lidT', True) - edge('lidB', False)
        checks.append({'name': f'blink{side} shuts the eye', 'pass': bool(gap < 0), 'detail': f'upper lid edge {"overlaps" if gap < 0 else "stops short of"} the lower by {abs(gap) * 1000:.1f} mm'})
    return checks
