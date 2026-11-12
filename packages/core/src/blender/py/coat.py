"""Coat textures without a render bake: every texel of the UV layout is mapped back to its 3D point
(a small rasterizer), and the coat colour and a fine fur-pile normal map are computed there in numpy.
Patterns live in 3D (solid, tabby, tuxedo, calico), so UV seams never show in them.
"""
import bpy
import numpy as np

TEXDIR = None   # where texture PNGs are written (set by the builder)


# ── 3D value noise (vectorised) ────────────────────────────────────────────────
def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1442695041) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def noise3(p, seed=0):
    p = np.asarray(p)
    i = np.floor(p).astype(np.int64)
    f = p - i
    u = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out = out + w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm(p, octaves=4, seed=0):
    a, s, tot = 0.5, 1.0, 0
    for o in range(octaves):
        tot = tot + a * noise3(p * s, seed + o * 17)
        a *= 0.5; s *= 2.03
    return tot


# ── texel → surface point ──────────────────────────────────────────────────────
def rasterize(ob, res):
    me = ob.data
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data
    me.calc_tangents()
    nl = len(me.loops)
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    lv = np.empty(nl, np.int64); me.loops.foreach_get('vertex_index', lv)
    luv = np.empty(nl * 2); uv.foreach_get('uv', luv); luv = luv.reshape(-1, 2)
    ln = np.empty(nl * 3); me.loops.foreach_get('normal', ln); ln = ln.reshape(-1, 3)
    lt = np.empty(nl * 3); me.loops.foreach_get('tangent', lt); lt = lt.reshape(-1, 3)
    ls = np.empty(nl); me.loops.foreach_get('bitangent_sign', ls)
    tris = np.empty(len(me.loop_triangles) * 3, np.int64); me.loop_triangles.foreach_get('loops', tris); tris = tris.reshape(-1, 3)
    mats = np.empty(len(me.loop_triangles), np.int64); me.loop_triangles.foreach_get('material_index', mats)
    P = np.zeros((res, res, 3), np.float32); N = np.zeros_like(P); T = np.zeros_like(P); S = np.zeros((res, res), np.float32)
    M = np.zeros((res, res), bool)
    for tri in tris:
        uvs = luv[tri] * res - 0.5
        x0, y0 = np.floor(uvs.min(0)).astype(int); x1, y1 = np.ceil(uvs.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, res - 1), min(y1, res - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        a, b, c = uvs
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
        w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
        w2 = 1 - w0 - w1
        e = -0.6 / max(abs(den), 1e-9) ** 0.5       # a hair of conservative coverage
        m = (w0 >= e) & (w1 >= e) & (w2 >= e)
        if not m.any():
            continue
        W = np.stack([w0[m], w1[m], w2[m]], 1)
        yy, xx = ys[m], xs[m]
        P[yy, xx] = W @ co[lv[tri]]
        N[yy, xx] = W @ ln[tri]
        T[yy, xx] = W @ lt[tri]
        S[yy, xx] = ls[tri[0]]
        M[yy, xx] = True
    N /= np.maximum(np.linalg.norm(N, axis=2, keepdims=True), 1e-9)
    return P, N, T, S, M


def dilate(img, mask, passes=8):
    img = img.copy(); m = mask.copy()
    for _ in range(passes):
        acc = np.zeros_like(img); cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sm = np.roll(np.roll(m, dy, 0), dx, 1)
            si = np.roll(np.roll(img, dy, 0), dx, 1)
            acc[sm] += si[sm]; cnt[sm] += 1
        new = (~m) & (cnt > 0)
        img[new] = acc[new] / cnt[new][..., None] if img.ndim == 3 else acc[new] / cnt[new]
        m = m | new
    return img


def hex_rgb(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)    # sRGB → linear


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def fur_flow(p, plan):
    """Direction the fur lies in at each point (Blender coords: +Y is toward the tail)."""
    flow = np.tile(np.array([0, 1.0, -0.25]), (len(p), 1))
    # legs: the fur runs down
    leg = np.clip((plan.belly + 0.03 - p[:, 2]) / 0.05, 0, 1)
    flow = flow * (1 - leg[:, None]) + np.array([0, 0.2, -1.0]) * leg[:, None]
    return flow / np.linalg.norm(flow, axis=1, keepdims=True)


def coat_colour(P, N, plan, coat):
    """Linear RGB per texel."""
    flat = P.reshape(-1, 3); nrm = N.reshape(-1, 3)
    base = hex_rgb(coat.get('color', '#7d8593'))
    pattern = coat.get('pattern', 'solid')
    q = flat * 1.0
    f = -q[:, 1]                       # forward coordinate
    # gentle variation: soft large mottling + fine strand variation along the fur flow
    big = fbm(q * 18.0, 3, seed=5) - 0.5
    flow = fur_flow(q, plan)
    along = np.einsum('ij,ij->i', q, flow)
    fine = noise3(np.stack([q[:, 0] * 900, q[:, 1] * 900, q[:, 2] * 900], 1) - flow * along[:, None] * 700, seed=9) - 0.5
    shade = 1 + 0.05 * big + 0.035 * fine
    col = base[None, :] * shade[:, None]
    # the blue BSH coat is a touch paler on the belly and inside the legs, darker along the spine
    under = np.clip((plan.belly + 0.05 - q[:, 2]) / 0.06, 0, 1) * np.clip(1 - np.abs(q[:, 0]) / 0.07, 0, 1)
    top = np.clip((q[:, 2] - (plan.top - 0.03)) / 0.03, 0, 1)
    col *= (1 + 0.08 * under - 0.06 * top)[:, None]
    toy = float(getattr(plan, 'toy', 0.0))
    if toy:
        # a cartoon coat: flat colour, with soft markings so it isn't one grey: a paler bib, muzzle and belly,
        # a darker saddle along the back and a darker tail tip
        st = lambda e0, e1, x: np.clip((x - e0) / (e1 - e0), 0, 1) ** 2 * (3 - 2 * np.clip((x - e0) / (e1 - e0), 0, 1))
        col = np.tile(base[None, :], (len(q), 1)) * (1 + 0.02 * big)[:, None]
        hc = plan.head_c; hs = plan.hs
        ax = np.abs(q[:, 0])
        se = plan.j['spine_end'][1]
        bib = st(se - 0.03, se + 0.03, f) * (1 - st(0.05, 0.09, ax)) * (1 - st(plan.top - 0.07, plan.top - 0.02, q[:, 2])) * (1 - st(hc[1] - 0.02 * hs, hc[1] + 0.01 * hs, f) * st(hc[2] - 0.06 * hs, hc[2] - 0.03 * hs, q[:, 2]))
        pad = plan.head_parts['pad'][0]
        dm = np.sqrt((ax - pad[0]) ** 2 + (f - pad[1]) ** 2 * 0.6 + (q[:, 2] - (pad[2] - 0.004 * hs)) ** 2)
        muz = (1 - st(0.018 * hs, 0.03 * hs, dm)) * st(hc[1] + 0.01 * hs, hc[1] + 0.03 * hs, f)
        belly = (1 - st(plan.belly + 0.01, plan.belly + 0.06, q[:, 2])) * (1 - st(0.07, 0.12, ax)) * st(plan.j['pelvis'][1], plan.j['pelvis'][1] + 0.05, f)
        light = np.clip(np.maximum(np.maximum(bib, muz), belly * 0.8), 0, 1)
        tip = plan.tail[-1]
        dt = np.sqrt(q[:, 0] ** 2 + (f - tip[1]) ** 2 + (q[:, 2] - tip[2]) ** 2)
        dark = np.maximum(1 - st(0.045, 0.075, dt), 0.45 * st(plan.top - 0.035, plan.top - 0.005, q[:, 2]) * (1 - st(se - 0.02, se + 0.04, f)))
        pale = np.clip(base * 1.75 + 0.06, 0, 1)
        col = col * (1 - light[:, None]) + pale[None] * light[:, None]
        col = col * (1 - 0.26 * dark[:, None])
        return col.reshape(P.shape)
    white = hex_rgb('#e9e6df'); black = hex_rgb('#26262a'); ginger = hex_rgb('#c9792f')
    if pattern == 'tabby':
        dark = base * 0.42
        hc = plan.head_c
        stripe = np.sin(f * 95 + 9 * (fbm(q * 14, 2, seed=2) - 0.5) + np.abs(q[:, 0]) * 10)
        m = np.clip((stripe - 0.25) * 2.2, 0, 1) * np.clip(1 - under * 1.5, 0, 1)
        col = col * (1 - m[:, None]) + dark[None] * m[:, None]
    elif pattern in ('tuxedo', 'calico'):
        # white bib, belly, paws and lower face
        hc = plan.head_c
        rel = q - np.array([0, -hc[1], hc[2]])
        lowface = (rel[:, 2] < -0.012) & (-q[:, 1] > hc[1] + 0.0)
        bib = (np.abs(q[:, 0]) < 0.06 + 0.02 * fbm(q * 20, 2, seed=3)) & (q[:, 2] < plan.top - 0.05) & (f > plan.j['spine_end'][1] - 0.06)
        belly = q[:, 2] < plan.belly + 0.035 + 0.02 * (fbm(q * 16, 2, seed=4) - 0.5)
        paws = q[:, 2] < 0.04
        wm = (lowface | bib | belly | paws).astype(float)
        if pattern == 'tuxedo':
            col = black[None] * shade[:, None] * (1 - wm[:, None]) + white[None] * shade[:, None] * wm[:, None]
        else:
            patch = fbm(q * 9, 3, seed=8)
            pc = np.where(patch[:, None] > 0.52, ginger[None], black[None]) * shade[:, None]
            patchy = (fbm(q * 7, 3, seed=11) > 0.47).astype(float)
            wm = np.maximum(wm, 1 - patchy)
            col = pc * (1 - wm[:, None]) + white[None] * shade[:, None] * wm[:, None]
    # the mouth line: a short dark philtrum under the nose and a soft parting under the pads
    nz = plan.nose
    rel = np.stack([q[:, 0], -q[:, 1], q[:, 2]], 1) - nz
    front = nrm[:, 1] < -0.3
    phil = (np.abs(rel[:, 0]) < 0.0009) & (rel[:, 2] < -0.003) & (rel[:, 2] > -0.012)
    curve = np.abs(rel[:, 2] + 0.0125 + 0.0016 * np.cos(np.clip(np.abs(rel[:, 0]) / 0.012, 0, 1) * np.pi)) < 0.0008
    mouth = front & (phil | (curve & (np.abs(rel[:, 0]) < 0.012)))
    col[mouth] *= 0.35
    return col.reshape(P.shape)


def fur_normal(P, N, T, S, plan, strength=0.35):
    """Tangent-space normal map of a short, dense pile: fine anisotropic strands combed along the flow."""
    flat = P.reshape(-1, 3); nrm = N.reshape(-1, 3); tan = T.reshape(-1, 3); sgn = S.reshape(-1)
    flow = fur_flow(flat, plan)
    def height(p):
        along = np.einsum('ij,ij->i', p, flow)
        q = p * 1400 - flow * along[:, None] * 1100     # strands: long along the flow, thin across
        return 0.6 * noise3(q, seed=1) + 0.4 * noise3(q * 2.1, seed=2)
    h = 2e-5
    # gradient of the height in 3D, then expressed in the tangent frame
    g = np.zeros_like(flat)
    for i in range(3):
        e = np.zeros(3); e[i] = h
        g[:, i] = (height(flat + e) - height(flat - e)) / (2 * h)
    g = g - np.einsum('ij,ij->i', g, nrm)[:, None] * nrm
    bit = np.cross(nrm, tan) * sgn[:, None]
    gt = np.einsum('ij,ij->i', g, tan); gb = np.einsum('ij,ij->i', g, bit)
    k = strength / 1400
    n = np.stack([-gt * k, -gb * k, np.ones_like(gt)], 1)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    return n.reshape(P.shape)


def to_image(name, arr, res, colorspace='sRGB', alpha=None):
    img = bpy.data.images.new(name, res, res, alpha=alpha is not None)
    a = np.ones((res, res, 4), np.float32)
    a[..., :3] = arr
    if alpha is not None:
        a[..., 3] = alpha
    img.pixels.foreach_set(a.reshape(-1))
    img.update()
    # write it out and read it back, so the pixels travel into the .blend and the glTF
    import os, tempfile
    d = TEXDIR or tempfile.mkdtemp()
    path = os.path.join(d, f'{name}.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    img.source = 'FILE'
    img.reload()
    img.colorspace_settings.name = colorspace     # a reload resets it; normal maps must stay Non-Color
    img.pack()
    return img


def bake_coat(ob, plan, coat, res=1024):
    P, N, T, S, M = rasterize(ob, res)
    col = coat_colour(P, N, plan, coat)
    col = dilate(lin_to_srgb(col), M)
    nm = fur_normal(P, N, T, S, plan, strength=float(coat.get('pile', 0.35)))
    nm = dilate(nm * 0.5 + 0.5, M)
    nm[~M] = np.array([0.5, 0.5, 1.0])[None] if (~M).any() else nm[~M]
    cimg = to_image(ob.name + '_color', col, res, 'sRGB')
    nimg = to_image(ob.name + '_normal', nm, res, 'Non-Color')
    return cimg, nimg, M


def strand_alpha(res=256, density=0.55, seed=3):
    """A tileable dot field for the optional fur shell (alpha-tested tips of the pile)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:res, 0:res] / res
    a = np.zeros((res, res), np.float32)
    n = int(res * res * 0.02)
    cx = rng.random(n); cy = rng.random(n); r = rng.uniform(0.004, 0.009, n)
    for x, y, rr in zip(cx, cy, r):
        dx = np.minimum(np.abs(xx - x), 1 - np.abs(xx - x)); dy = np.minimum(np.abs(yy - y), 1 - np.abs(yy - y))
        a = np.maximum(a, np.clip(1 - np.sqrt(dx * dx + dy * dy) / rr, 0, 1))
    return (a > (1 - density)).astype(np.float32) * a
