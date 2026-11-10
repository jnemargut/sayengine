"""Signed distance shapes in numpy (no Blender needed), used to sculpt a skin-modifier mesh by script.

A creature's form is a few big analytic shapes (a lofted barrel from a station table, round cones for
limbs, ellipsoids for the head masses) joined with smooth unions. Few, large shapes with wide blends is
what keeps the surface free of the lumps and ripples a field of many small metaballs gives.
All functions take points as an (N, 3) array and return (N,) distances (negative inside).
"""
import numpy as np


def smin(a, b, k):
    """Polynomial smooth minimum (smooth union) with blend radius k."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    """Smooth maximum (smooth intersection / subtraction with -b)."""
    return -smin(-a, -b, k)


def sphere(p, c, r):
    return np.linalg.norm(p - np.asarray(c), axis=1) - r


def ellipsoid(p, c, r):
    """Approximate ellipsoid distance (Quilez): exact on the surface, a good bound near it."""
    q = (p - np.asarray(c)) / np.asarray(r)
    k0 = np.linalg.norm(q, axis=1)
    k1 = np.linalg.norm(q / np.asarray(r), axis=1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def round_cone(p, a, b, ra, rb):
    """Exact distance to a cone between spheres (a, ra) and (b, rb) (Quilez)."""
    a = np.asarray(a, float); b = np.asarray(b, float)
    ba = b - a
    l2 = float(ba @ ba)
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    pa = p - a
    y = pa @ ba
    z = y - l2
    xv = pa * l2 - np.outer(y, ba)
    x2 = np.einsum('ij,ij->i', xv, xv)
    y2 = y * y * l2
    z2 = z * z * l2
    k = np.sign(rr) * rr * rr * x2
    out = np.empty(len(p))
    m1 = np.sign(z) * a2 * z2 > k
    m2 = (~m1) & (np.sign(y) * a2 * y2 < k)
    m3 = ~(m1 | m2)
    out[m1] = np.sqrt(x2[m1] + z2[m1]) * il2 - rb
    out[m2] = np.sqrt(x2[m2] + y2[m2]) * il2 - ra
    out[m3] = (np.sqrt(x2[m3] * a2 * il2) + y[m3] * rr) * il2 - ra
    return out


def chain(p, pts, radii, k=0.0):
    """A chain of round cones through pts with per-point radii, smooth-joined."""
    d = None
    for i in range(len(pts) - 1):
        di = round_cone(p, pts[i], pts[i + 1], radii[i], radii[i + 1])
        d = di if d is None else smin(d, di, k)
    return d


def pchip(x, y, xs):
    """Monotone cubic (Fritsch-Carlson) interpolation: smooth like a spline, no overshoot."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    h = np.diff(x); dl = np.diff(y) / h
    m = np.zeros_like(y)
    for i in range(1, len(y) - 1):
        if dl[i - 1] * dl[i] > 0:
            w1 = 2 * h[i] + h[i - 1]; w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i])
    m[0] = dl[0]; m[-1] = dl[-1]
    xs = np.clip(xs, x[0], x[-1])
    k = np.clip(np.searchsorted(x, xs) - 1, 0, len(h) - 1)
    t = (xs - x[k]) / h[k]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h[k] * m[k]
            + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h[k] * m[k + 1])


def loft(p, stations, axis_x=0, axis_f=1, axis_z=2, fsign=-1.0, cap_power=2.6):
    """A barrel lofted through a station table.

    stations: list of (f, top, bottom, half_width) along the body (f = forward coordinate). Between
    stations the profile is interpolated with a smooth (monotone cubic) curve; each cross-section is an
    ellipse with separate upper and lower half-heights so the belly can hang. The ends are rounded.
    """
    st = np.asarray(sorted(stations), float)
    f = fsign * p[:, axis_f]
    x = p[:, axis_x]
    z = p[:, axis_z]
    f0, f1 = st[0, 0], st[-1, 0]
    fc = np.clip(f, f0, f1)
    top = pchip(st[:, 0], st[:, 1], fc)
    bot = pchip(st[:, 0], st[:, 2], fc)
    wid = pchip(st[:, 0], st[:, 3], fc)
    mid = 0.5 * (top + bot)
    hu = np.maximum(top - mid, 1e-4)
    hl = np.maximum(mid - bot, 1e-4)
    # rounded ends: past the first/last station the section shrinks like a superellipse cap
    half = 0.5 * (f1 - f0)
    fm = 0.5 * (f1 + f0)
    endlen = np.array([st[1, 0] - st[0, 0], st[-1, 0] - st[-2, 0]])
    d = None
    # the cross-section ellipse (upper and lower halves)
    hz = np.where(z >= mid, hu, hl)
    qx = x / wid
    qz = (z - mid) / hz
    # end caps: treat the axial overshoot as a third ellipse axis
    over = np.where(f > f1, (f - f1) / (endlen[1] * 1.0), np.where(f < f0, (f0 - f) / (endlen[0] * 1.0), 0.0))
    q = np.stack([qx, qz, over], axis=1)
    k0 = np.linalg.norm(q, axis=1)
    rr = np.stack([wid, hz, np.where(f > fm, endlen[1], endlen[0])], axis=1)
    k1 = np.linalg.norm(q / rr, axis=1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def gradient(fn, p, h=1e-4):
    g = np.zeros_like(p)
    for i in range(3):
        e = np.zeros(3); e[i] = h
        g[:, i] = (fn(p + e) - fn(p - e)) / (2 * h)
    return g


def project(fn, p, iters=8, max_step=0.02):
    """Move points onto the zero level set by damped Newton steps along the gradient."""
    p = p.copy()
    for _ in range(iters):
        d = fn(p)
        g = gradient(fn, p)
        gl2 = np.maximum(np.einsum('ij,ij->i', g, g), 1e-12)
        step = (d / gl2)[:, None] * g
        n = np.linalg.norm(step, axis=1)
        s = np.minimum(1.0, max_step / np.maximum(n, 1e-12))
        p -= step * s[:, None]
    return p
