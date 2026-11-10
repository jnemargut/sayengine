"""Cloth and skin textures computed in 3D (no render bake): a knit with ribs and V stitches, jersey,
twill, felt, and skin with warmth, blush, lips and a dad's stubble. Uses coat.rasterize for texel
positions and tangent frames."""
import numpy as np
import coat


def _normal_from_height(height, P, N, T, S, strength, scale):
    flat = P.reshape(-1, 3); nrm = N.reshape(-1, 3); tan = T.reshape(-1, 3); sgn = S.reshape(-1)
    h = 2e-5
    g = np.zeros_like(flat)
    for i in range(3):
        e = np.zeros(3); e[i] = h
        g[:, i] = (height(flat + e) - height(flat - e)) / (2 * h)
    g = g - np.einsum('ij,ij->i', g, nrm)[:, None] * nrm
    bit = np.cross(nrm, tan) * sgn[:, None]
    gt = np.einsum('ij,ij->i', g, tan); gb = np.einsum('ij,ij->i', g, bit)
    k = strength / scale
    n = np.stack([-gt * k, -gb * k, np.ones_like(gt)], 1)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    return n.reshape(P.shape)


def knit_height(p):
    # columns of V stitches running down the garment (stockinette), with a soft yarn noise
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    u = np.arctan2(x, -y) * 0.16 + x * 0.6          # roughly the arc length round the body
    col = (u / 0.0055) % 1.0
    v = z / 0.0045 + np.abs(col - 0.5) * 1.6
    stitch = 0.5 + 0.5 * np.cos(2 * np.pi * v)
    ridge = np.abs(np.sin(np.pi * col))
    return 0.7 * stitch * ridge + 0.3 * coat.noise3(p * 900, 7)


def rib_height(p):
    x, y = p[:, 0], p[:, 1]
    u = np.arctan2(x, -y) * 0.16 + x * 0.6
    return 0.5 + 0.5 * np.cos(2 * np.pi * u / 0.0045)


def twill_height(p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    return 0.5 + 0.5 * np.sin(2 * np.pi * (z + 0.6 * x + 0.6 * y) / 0.0018) * 0.6 + 0.2 * coat.noise3(p * 1500, 3)


def jersey_height(p):
    return coat.noise3(p * 1800, 5) * 0.6 + coat.noise3(p * 400, 6) * 0.4


def felt_height(p):
    return coat.fbm(p * 600, 3, 11)


FABRICS = {'knit': (knit_height, 0.55, 600), 'jersey': (jersey_height, 0.2, 1500), 'twill': (twill_height, 0.3, 1500), 'felt': (felt_height, 0.35, 600)}


def fabric_maps(ob, kind, color_hex, res=1024, hem=None):
    P, N, T, S, M = coat.rasterize(ob, res)
    base = coat.hex_rgb(color_hex)
    flat = P.reshape(-1, 3)
    h, strength, scale = FABRICS[kind]
    heightfn = h
    if hem is not None:
        # ribbed bands (hem, cuffs, button band): a different stitch where hem(p) > 0
        def heightfn(p, h=h):
            m = np.clip(hem(p), 0, 1)
            return h(p) * (1 - m) + rib_height(p) * m
    hv = heightfn(flat)
    var = 1 + 0.08 * (coat.fbm(flat * 14, 3, 21) - 0.5) + 0.12 * (hv - 0.5)
    col = base[None, :] * var[:, None]
    col = coat.dilate(coat.lin_to_srgb(col.reshape(P.shape)), M)
    nm = _normal_from_height(heightfn, P, N, T, S, strength, scale)
    nm = coat.dilate(nm * 0.5 + 0.5, M)
    return coat.to_image(ob.name + '_color', col, res, 'sRGB'), coat.to_image(ob.name + '_normal', nm, res, 'Non-Color')


def skin_maps(ob, person, res=1024):
    """Skin: warm base, rosier cheeks, nose and ears, lips, a light stubble shadow on the jaw and upper lip,
    the dark inside of the mouth. Positions in Blender coords (y flipped)."""
    P, N, T, S, M = coat.rasterize(ob, res)
    flat = P.reshape(-1, 3)
    q = np.stack([flat[:, 0], -flat[:, 1], flat[:, 2]], 1)          # plan coords
    hs = person.hs
    rel = (q - person.c) / hs
    base = coat.hex_rgb(person.pr['skin'])
    col = np.tile(base, (len(q), 1))
    col *= (1 + 0.05 * (coat.fbm(q * 40, 3, 4) - 0.5))[:, None]
    def g(c, r):
        d = (q - np.asarray(c)) / np.asarray(r)
        return np.exp(-np.einsum('ij,ij->i', d, d))
    rosy = coat.hex_rgb('#d98a7a')
    blush = 0.0
    for sx in (1, -1):
        blush = blush + g(person.H(0.042 * sx, 0.07, -0.03), np.array([0.022, 0.03, 0.02]) * hs)
        blush = blush + 0.5 * g(person.head_parts['ear'][0] * np.array([sx, 1, 1]), np.array([0.02, 0.03, 0.035]) * hs)
    blush = blush + 0.6 * g(person.head_parts['nose_tip'][0], np.array([0.016, 0.03, 0.014]) * hs)
    col = col * (1 - 0.35 * blush[:, None]) + rosy[None] * 0.35 * blush[:, None]
    # lips
    lipc = coat.hex_rgb('#a8584c')
    lip = np.zeros(len(q))
    for k in ('lip_up', 'lip_lo'):
        c, r = person.head_parts[k]
        d = (q - c) / (r * np.array([1.08, 1.2, 1.25]))
        lip = np.maximum(lip, np.clip(1.6 - np.sqrt(np.einsum('ij,ij->i', d, d)) * 1.6, 0, 1))
    lip *= np.clip((rel[:, 1] - 0.06) / 0.02, 0, 1)
    col = col * (1 - 0.8 * lip[:, None]) + lipc[None] * 0.8 * lip[:, None]
    # the mouth line, painted as well as cut, so it reads at any distance
    ml = person.mouth_line
    mrel = (q - ml) / hs
    line = (np.abs(mrel[:, 2] + 0.004 * (mrel[:, 0] / 0.026) ** 2) < 0.0016) & (np.abs(mrel[:, 0]) < 0.026) & (mrel[:, 1] > -0.016)
    col[line] *= 0.4
    # stubble: a soft grey-blue shadow on the jaw, chin and upper lip (not on the lips or cheeks' tops)
    st = coat.hex_rgb('#7d7470')
    beard = np.clip((-0.02 - rel[:, 2]) / 0.03, 0, 1) * np.clip((rel[:, 1] + 0.02) / 0.04, 0, 1)
    beard *= np.clip((0.115 + rel[:, 2]) / 0.02, 0, 1) * 1.0
    upperlip = g(person.H(0, 0.095, -0.045), np.array([0.024, 0.02, 0.008]) * hs)
    beard = np.clip(beard + upperlip, 0, 1) * (1 - lip) * (rel[:, 2] < 0.0)
    grain = coat.noise3(q * 2500, 13)
    col = col * (1 - 0.22 * beard[:, None] * (0.6 + 0.4 * grain[:, None])) + st[None] * 0.22 * beard[:, None] * (0.6 + 0.4 * grain[:, None])
    col = coat.dilate(coat.lin_to_srgb(col.reshape(P.shape)), M)
    nm = _normal_from_height(lambda p: coat.noise3(p * 3000, 17) * 0.5, P, N, T, S, 0.08, 3000)
    nm = coat.dilate(nm * 0.5 + 0.5, M)
    return coat.to_image(ob.name + '_color', col, res, 'sRGB'), coat.to_image(ob.name + '_normal', nm, res, 'Non-Color')


def hair_maps(ob, person, res=512):
    P, N, T, S, M = coat.rasterize(ob, res)
    flat = P.reshape(-1, 3)
    q = np.stack([flat[:, 0], -flat[:, 1], flat[:, 2]], 1)
    rel = (q - person.c) / person.hs
    base = coat.hex_rgb(person.pr['hair'])
    grey = coat.hex_rgb('#a7a39e')
    gmix = person.pr['grey'] * (0.55 + 0.45 * np.clip((np.abs(rel[:, 0]) - 0.04) / 0.04, 0, 1)) * (0.7 + 0.6 * coat.noise3(q * 700, 2))
    gmix = np.clip(gmix, 0, 1)
    strands = coat.noise3(np.stack([q[:, 0] * 1500, q[:, 1] * 300, q[:, 2] * 300], 1), 8)
    col = base[None] * (1 - gmix[:, None]) + grey[None] * gmix[:, None]
    col *= (0.82 + 0.3 * strands)[:, None]
    col = coat.dilate(coat.lin_to_srgb(col.reshape(P.shape)), M)
    nm = _normal_from_height(lambda p: coat.noise3(np.stack([p[:, 0] * 1800, p[:, 1] * 400, p[:, 2] * 400], 1), 8), P, N, T, S, 0.3, 1800)
    nm = coat.dilate(nm * 0.5 + 0.5, M)
    return coat.to_image(ob.name + '_color', col, res, 'sRGB'), coat.to_image(ob.name + '_normal', nm, res, 'Non-Color')
