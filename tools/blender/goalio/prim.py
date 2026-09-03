"""Mesh primitives, returned as (verts, faces) so the caller can weld them.

Everything is built from pydata rather than from bpy.ops.mesh.primitive_*.
Two reasons, both practical:

  - bpy.ops depends on context. In --background with no active object it works
    until the day it does not, and the failure is an opaque
    "context is incorrect" from four calls down the stack.

  - the player mesh is one object made of many limbs. Building each with an
    operator and joining them costs an object and a selection each, plus a
    join, and leaves the vertex order dependent on selection order — which
    means the skin weights land on different vertices between runs.

THE BOX TRAP, recorded in docs/BLENDER.md and repeated here because it is the
one that already cost time: primitive_cube_add(size=1) spans -0.5..+0.5, so the
scale for a box of full extent `size` is `size`, NOT `size / 2`. box() below
takes full extents and is unambiguous.
"""

import math

TAU = math.pi * 2.0


def ring(centre, rx, ry, seg, z=None):
    """One horizontal ellipse of `seg` points."""
    cx, cy, cz = centre
    zz = cz if z is None else z
    return [(cx + rx * math.cos(TAU * i / seg),
             cy + ry * math.sin(TAU * i / seg),
             zz) for i in range(seg)]


def bridge(a_start, b_start, seg, flip=False):
    """Quad faces between two rings of `seg` verts starting at those indices."""
    faces = []
    for i in range(seg):
        j = (i + 1) % seg
        quad = (a_start + i, a_start + j, b_start + j, b_start + i)
        faces.append(quad[::-1] if flip else quad)
    return faces


def loft(rings, seg, cap_start=False, cap_end=False):
    """Stack of rings -> (verts, faces). The workhorse: every limb, the torso,
    the goal posts and the bowl steps are lofts."""
    verts, faces = [], []
    starts = []
    for r in rings:
        starts.append(len(verts))
        verts.extend(r)
    for k in range(len(rings) - 1):
        faces.extend(bridge(starts[k], starts[k + 1], seg))
    if cap_start:
        faces.append(tuple(range(starts[0] + seg - 1, starts[0] - 1, -1)))
    if cap_end:
        faces.append(tuple(range(starts[-1], starts[-1] + seg)))
    return verts, faces


def tube(p0, p1, r0, r1, seg=12, cap=True):
    """Tapered tube from p0 to p1. Rings are built perpendicular to the axis,
    so a limb at any angle keeps a circular cross-section instead of the
    sheared ellipse an axis-aligned ring would give."""
    ax = [p1[i] - p0[i] for i in range(3)]
    length = math.sqrt(sum(c * c for c in ax)) or 1e-6
    ax = [c / length for c in ax]

    # any vector not parallel to the axis, for the first basis vector
    ref = (0.0, 0.0, 1.0) if abs(ax[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = _cross(ax, ref)
    u = _norm(u)
    v = _norm(_cross(ax, u))

    verts, faces = [], []
    for idx, (base, rad) in enumerate(((p0, r0), (p1, r1))):
        start = len(verts)
        for i in range(seg):
            ang = TAU * i / seg
            cu, sv = math.cos(ang) * rad, math.sin(ang) * rad
            verts.append(tuple(base[k] + u[k] * cu + v[k] * sv for k in range(3)))
        if idx == 0:
            first = start
        else:
            faces.extend(bridge(first, start, seg))
    if cap:
        faces.append(tuple(range(seg - 1, -1, -1)))
        faces.append(tuple(range(seg, seg * 2)))
    return verts, faces


def sphere(centre, radius, seg=16, rings=10, scale=(1.0, 1.0, 1.0)):
    """UV sphere, optionally scaled per-axis. Poles are triangle fans."""
    cx, cy, cz = centre
    sx, sy, sz = scale
    verts, faces = [], []
    verts.append((cx, cy, cz + radius * sz))                    # north pole
    for r in range(1, rings):
        phi = math.pi * r / rings
        rr, zz = math.sin(phi) * radius, math.cos(phi) * radius
        for i in range(seg):
            ang = TAU * i / seg
            verts.append((cx + rr * math.cos(ang) * sx,
                          cy + rr * math.sin(ang) * sy,
                          cz + zz * sz))
    verts.append((cx, cy, cz - radius * sz))                    # south pole
    south = len(verts) - 1

    for i in range(seg):
        faces.append((0, 1 + (i + 1) % seg, 1 + i))
    for r in range(rings - 2):
        a, b = 1 + r * seg, 1 + (r + 1) * seg
        faces.extend(bridge(a, b, seg))
    last = 1 + (rings - 2) * seg
    for i in range(seg):
        faces.append((south, last + i, last + (i + 1) % seg))
    return verts, faces


def box(centre, extent):
    """Axis-aligned box from FULL extents. See the trap note at the top."""
    cx, cy, cz = centre
    hx, hy, hz = (e * 0.5 for e in extent)
    v = [(cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
         (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
         (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
         (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def quad(p0, p1, p2, p3):
    return [p0, p1, p2, p3], [(0, 1, 2, 3)]


def merge(*parts):
    """Concatenate (verts, faces) pairs, re-basing every index."""
    verts, faces = [], []
    for pverts, pfaces in parts:
        base = len(verts)
        verts.extend(pverts)
        faces.extend(tuple(i + base for i in f) for f in pfaces)
    return verts, faces


def rounded_rect_path(hx, hy, corner, count):
    """The bowl footprint, ported from perimeterPath() in js/render.gl.js.

    Returns [(x, y, nx, ny)] sampled by arc length, normals pointing OUTWARD.
    Sampling by arc length rather than by angle matters: an angular sample puts
    most of its points in the corners, and the straight sides — which is where
    the stand actually is — end up under-tessellated.
    """
    c = max(0.0, min(corner, min(hx, hy)))
    sx, sy = hx - c, hy - c
    straight_x, straight_y = 2 * sx, 2 * sy
    arc = (math.pi / 2) * c
    total = 2 * straight_x + 2 * straight_y + 4 * arc

    out = []
    for k in range(count):
        d = total * k / count
        # +X side, walking +Y, then the +X+Y corner, and so on anticlockwise
        if d < straight_y:
            out.append((hx, -sy + d, 1.0, 0.0)); continue
        d -= straight_y
        if d < arc:
            a = (d / arc) * (math.pi / 2)
            nx, ny = math.cos(a), math.sin(a)
            out.append((sx + c * nx, sy + c * ny, nx, ny)); continue
        d -= arc
        if d < straight_x:
            out.append((sx - d, hy, 0.0, 1.0)); continue
        d -= straight_x
        if d < arc:
            a = (math.pi / 2) + (d / arc) * (math.pi / 2)
            nx, ny = math.cos(a), math.sin(a)
            out.append((-sx + c * nx, sy + c * ny, nx, ny)); continue
        d -= arc
        if d < straight_y:
            out.append((-hx, sy - d, -1.0, 0.0)); continue
        d -= straight_y
        if d < arc:
            a = math.pi + (d / arc) * (math.pi / 2)
            nx, ny = math.cos(a), math.sin(a)
            out.append((-sx + c * nx, -sy + c * ny, nx, ny)); continue
        d -= arc
        if d < straight_x:
            out.append((-sx + d, -hy, 0.0, -1.0)); continue
        d -= straight_x
        a = (3 * math.pi / 2) + (d / arc) * (math.pi / 2)
        nx, ny = math.cos(a), math.sin(a)
        out.append((sx + c * nx, -sy + c * ny, nx, ny))
    return out


# ------------------------------------------------------------------ vector

def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _norm(a):
    m = math.sqrt(sum(c * c for c in a)) or 1e-6
    return tuple(c / m for c in a)


def dist_point_segment(p, a, b):
    """Used by the skinning pass. Returns the distance from p to segment ab."""
    ab = [b[i] - a[i] for i in range(3)]
    ap = [p[i] - a[i] for i in range(3)]
    denom = sum(c * c for c in ab)
    t = 0.0 if denom < 1e-12 else max(0.0, min(1.0, sum(ap[i] * ab[i] for i in range(3)) / denom))
    closest = [a[i] + ab[i] * t for i in range(3)]
    return math.sqrt(sum((p[i] - closest[i]) ** 2 for i in range(3)))
