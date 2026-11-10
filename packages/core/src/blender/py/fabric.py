"""Cloth textures computed in 3D (no render bake): a knit with ribs and V stitches, jersey, twill and
felt. Uses coat.rasterize for texel positions and tangent frames."""
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


