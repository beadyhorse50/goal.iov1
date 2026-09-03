"""Pitch, markings, goal, net, bowl, roof, hoardings and crowd.

EVERYTHING IS DERIVED FROM config/pitch.json. Nothing here types a coordinate
that could have been computed from one. That is the same rule stadium_props.py
already follows for placement — "editing config/pitch.json moves the flags and
the dugouts with the lines" — extended to the whole ground. Widen the pitch and
the bowl, the hoardings, the markings and the crowd all move together.

ONE TIER BY DEFAULT
-------------------
§3.2 of the style guide gives the live one-tier numbers: 26 rows, back row at
13.2 m, roof at 16.8 m. §3.5 marks the second tier as a TARGET, because the
canvas renderer has one and the GL renderer does not. So the default build is
the live ground and `two_tier=True` is the target — matching the guide rather
than quietly shipping a stadium the game cannot draw.
"""

import math

import bpy

from . import compat, materials, prim, scene, style

P = style.PITCH
LINE_Z = 0.006          # markings float above the turf to beat z-fighting
SEG_POST = 12


# --------------------------------------------------------------------------
# turf
# --------------------------------------------------------------------------

def build_turf(collection, wet=0.0):
    """The playing surface plus the grass surround, as one plane. The mow
    stripes come from the material, so this is four vertices."""
    hx = P["halfW"] + style.SURROUND
    hy = P["halfL"] + style.SURROUND
    verts = [(-hx, -hy, 0.0), (hx, -hy, 0.0), (hx, hy, 0.0), (-hx, hy, 0.0)]
    obj = scene.new_mesh_object("PITCH_Turf", verts, [(0, 1, 2, 3)], collection)
    scene.assign(obj, materials.turf(wet=wet))
    return obj


# --------------------------------------------------------------------------
# markings
# --------------------------------------------------------------------------

def _strip(p0, p1, w):
    """A painted line as a flat quad, given its centreline and width."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1e-6
    nx, ny = -dy / length * w * 0.5, dx / length * w * 0.5
    return ([(p0[0] + nx, p0[1] + ny, LINE_Z), (p1[0] + nx, p1[1] + ny, LINE_Z),
             (p1[0] - nx, p1[1] - ny, LINE_Z), (p0[0] - nx, p0[1] - ny, LINE_Z)],
            [(0, 1, 2, 3)])


def _arc(cx, cy, r, w, a0, a1, seg=48):
    """A painted arc as a band between two radii."""
    verts, faces = [], []
    inner, outer = r - w * 0.5, r + w * 0.5
    for i in range(seg + 1):
        a = a0 + (a1 - a0) * i / seg
        ca, sa = math.cos(a), math.sin(a)
        verts.append((cx + inner * ca, cy + inner * sa, LINE_Z))
        verts.append((cx + outer * ca, cy + outer * sa, LINE_Z))
    for i in range(seg):
        b = i * 2
        faces.append((b, b + 1, b + 3, b + 2))
    return verts, faces


def _rect_outline(hx, y0, y1, w):
    """Three sides of a box: two verticals and the line across. The goal line
    itself is already painted by the pitch outline, so it is not repeated —
    doubling it makes a visibly brighter line at every box edge."""
    return prim.merge(
        _strip((-hx, y0), (-hx, y1), w),
        _strip((hx, y0), (hx, y1), w),
        _strip((-hx, y1), (hx, y1), w),
    )


def build_markings(collection):
    hw, hl = P["halfW"], P["halfL"]
    w = style.LINE_W
    parts = []

    # touchlines and goal lines
    parts.append(_strip((-hw, -hl), (hw, -hl), w))
    parts.append(_strip((-hw, hl), (hw, hl), w))
    parts.append(_strip((-hw, -hl), (-hw, hl), w))
    parts.append(_strip((hw, -hl), (hw, hl), w))

    # halfway line, centre circle, centre spot
    parts.append(_strip((-hw, 0), (hw, 0), w))
    parts.append(_arc(0, 0, P["centreR"], w, 0, math.tau, 64))
    parts.append(_arc(0, 0, 0.11, 0.22, 0, math.tau, 16))

    for sign in (1, -1):
        goal_y = sign * hl
        box_y = sign * (hl - P["boxDepth"])
        six_y = sign * (hl - P["sixDepth"])
        spot_y = sign * (hl - P["penSpot"])

        parts.append(_rect_outline(P["boxHalf"], goal_y, box_y, w))
        parts.append(_rect_outline(P["sixHalf"], goal_y, six_y, w))
        parts.append(_arc(0, spot_y, 0.11, 0.22, 0, math.tau, 16))

        # the D: only the part of the penalty arc OUTSIDE the box is painted.
        # Solved from the geometry rather than eyeballed, so it stays correct
        # when boxDepth or penSpot changes in config/pitch.json.
        reach = abs(box_y - spot_y)
        if P["arcR"] > reach:
            half = math.acos(max(-1.0, min(1.0, reach / P["arcR"])))
            centre = math.pi / 2 if sign < 0 else -math.pi / 2
            parts.append(_arc(0, spot_y, P["arcR"], w,
                              centre - half, centre + half, 40))

        # corner arcs, one quadrant each
        for sx in (1, -1):
            base = 0.0 if sx > 0 else math.pi
            start = base + (math.pi / 2 if (sx * sign) > 0 else 0.0)
            parts.append(_arc(sx * hw, goal_y, P["cornerR"], w,
                              start, start + math.pi / 2, 12))

    verts, faces = prim.merge(*parts)
    obj = scene.new_mesh_object("PITCH_Markings", verts, faces, collection)
    scene.assign(obj, materials.line_paint())
    return obj


# --------------------------------------------------------------------------
# goal and net
# --------------------------------------------------------------------------

def build_goal(collection, sign=-1, net_depth=2.0, name=None):
    """Rounded posts and a crossbar, with the net as a separate object so the
    Wireframe modifier does not eat the frame."""
    name = name or ("PITCH_Goal_%s" % ("N" if sign > 0 else "S"))
    gh, cb = P["goalHalf"], P["crossbar"]
    y = sign * P["halfL"]
    r = 0.06

    frame = prim.merge(
        prim.tube((-gh, y, 0.0), (-gh, y, cb), r, r, SEG_POST),
        prim.tube((gh, y, 0.0), (gh, y, cb), r, r, SEG_POST),
        prim.tube((-gh, y, cb), (gh, y, cb), r, r, SEG_POST),
    )
    obj = scene.new_mesh_object(name, frame[0], frame[1], collection,
                                smooth=True, smooth_angle=40.0)
    scene.assign(obj, materials.post())

    net = _net_mesh(sign, gh, cb, net_depth)
    net_obj = scene.new_mesh_object(name + "_Net", net[0], net[1], collection)
    scene.assign(net_obj, materials.net())
    mod = net_obj.modifiers.new("Net", "WIREFRAME")
    mod.thickness = 0.014
    mod.use_replace = True
    mod.use_boundary = True
    net_obj.parent = obj
    return obj, net_obj


def _net_mesh(sign, gh, cb, depth, nx=14, nz=9, ny=6):
    """Back panel, roof panel and two sides, as grids. §8.13 asks the net to
    read as VOLUME rather than as lines, which is why the back panel sags and
    the roof slopes instead of both being flat planes."""
    y0 = sign * P["halfL"]
    y1 = y0 + sign * depth
    parts = []

    def grid(fn, cols, rows):
        verts = [fn(i / cols, j / rows) for j in range(rows + 1) for i in range(cols + 1)]
        faces = []
        for j in range(rows):
            for i in range(cols):
                a = j * (cols + 1) + i
                faces.append((a, a + 1, a + cols + 2, a + cols + 1))
        return verts, faces

    def sag(u, amount):
        """A hung net is a catenary; a sine is close enough at this scale and
        does not need a solver."""
        return math.sin(u * math.pi) * amount

    # back panel, leaning away from the goal and sagging in the middle
    parts.append(grid(lambda u, v: (
        -gh + 2 * gh * u,
        y1 + sign * sag(u, 0.10) * v,
        cb * 0.80 * v), nx, nz))
    # roof panel, sloping from the crossbar down to the top of the back panel
    parts.append(grid(lambda u, v: (
        -gh + 2 * gh * u,
        y0 + (y1 - y0) * v,
        cb - (cb - cb * 0.80) * v - sag(u, 0.06) * v), nx, ny))
    # sides
    for sx in (-1, 1):
        parts.append(grid(lambda u, v, sx=sx: (
            sx * gh,
            y0 + (y1 - y0) * u,
            cb * (1.0 - u * 0.20) * v), ny, nz))
    return prim.merge(*parts)


# --------------------------------------------------------------------------
# the bowl
# --------------------------------------------------------------------------

B = style.BOWL


def _offset(path, out, z):
    """Push a perimeter path outward along its own normals, at height z."""
    return [(x + nx * out, y + ny * out, z) for x, y, nx, ny in path]


def _band(lower, upper, closed=True):
    """Faces between two equal-length rings of a closed loop."""
    n = len(lower)
    faces = []
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return lower + upper, faces


def _rake(path, rows, out0, z0):
    """Real steps, not a ramp. §3.2: a smooth ramp with the treads painted on
    reads correctly from the front and falls apart in silhouette at the top
    edge, which is exactly where the crowd meets the sky."""
    parts = []
    out, z = out0, z0
    for _r in range(rows):
        tread_in = _offset(path, out, z)
        tread_out = _offset(path, out + B["run"], z)
        parts.append(_band(tread_in, tread_out))
        riser_lo = _offset(path, out + B["run"], z)
        riser_hi = _offset(path, out + B["run"], z + B["rise"])
        parts.append(_band(riser_lo, riser_hi))
        out += B["run"]
        z += B["rise"]
    return parts, out, z


def build_bowl(collection, two_tier=False):
    """The stand. Returns the objects plus the measured back-row and roof
    heights, which are printed — docs/BLENDER.md, 'print your dimensions'."""
    path = prim.rounded_rect_path(B["hx"], B["hy"], B["corner"], B["K"])
    made = []

    # perimeter wall: ground to the front row's floor
    wall = _band(_offset(path, 0.0, 0.0), _offset(path, 0.0, B["base"]))
    obj = scene.new_mesh_object("BOWL_Wall", wall[0], wall[1], collection)
    scene.assign(obj, materials.concrete())
    made.append(obj)

    if two_tier:
        lower_rows = 13
        parts, out, z = _rake(path, lower_rows, 0.0, B["base"])
        facia_lo = _offset(path, out, z)
        facia_hi = _offset(path, out, z + B["faciaH"])
        parts.append(_band(facia_lo, facia_hi))
        z += B["faciaH"]
        upper, out, z = _rake(path, B["tier2Rows"], out, z)
        parts.extend(upper)
        rows_built = lower_rows + B["tier2Rows"]
    else:
        parts, out, z = _rake(path, B["rows"], 0.0, B["base"])
        rows_built = B["rows"]

    verts, faces = prim.merge(*parts)
    rake_obj = scene.new_mesh_object("BOWL_Rake", verts, faces, collection)
    scene.assign(rake_obj, materials.seating())
    made.append(rake_obj)

    back_z, back_out = z, out

    # roof: an annulus reaching roofOver back over the rake
    roof_z = back_z + B["roofLift"]
    inner = _offset(path, max(0.0, back_out - B["roofOver"]), roof_z)
    outer = _offset(path, back_out, roof_z)
    rverts, rfaces = _band(inner, outer)
    roof = scene.new_mesh_object("BOWL_Roof", rverts, rfaces, collection)
    scene.assign(roof, materials.concrete())
    made.append(roof)

    # the fascia that closes the gap between the back row and the roof, so the
    # bowl has a silhouette against the sky instead of a floating slab
    fverts, ffaces = _band(_offset(path, back_out, back_z),
                           _offset(path, back_out, roof_z))
    backwall = scene.new_mesh_object("BOWL_BackWall", fverts, ffaces, collection)
    scene.assign(backwall, materials.concrete())
    made.append(backwall)

    print("  bowl: %d rows, rake %.1f deg, back row %.2f m, roof %.2f m%s"
          % (rows_built, style.rake_deg(), back_z, roof_z,
             " [TWO-TIER target]" if two_tier else " [live one-tier]"))
    return made, back_out, back_z, roof_z


def build_hoardings(collection):
    """Advertising boards on the perimeter, inside the wall."""
    hx = P["halfW"] + style.SURROUND
    hy = P["halfL"] + style.SURROUND
    path = prim.rounded_rect_path(hx, hy, B["corner"] * 0.9, 120)
    verts, faces = _band(_offset(path, 0.0, 0.10), _offset(path, 0.0, 1.00))
    obj = scene.new_mesh_object("BOWL_Hoardings", verts, faces, collection)
    scene.assign(obj, materials.hoarding())
    return obj


# --------------------------------------------------------------------------
# crowd
# --------------------------------------------------------------------------

def _lcg(seed):
    """Deterministic pseudo-random. NOT random.random(): every asset in this
    project derives from an index so a rebuild is byte-comparable, and a crowd
    that reshuffles on every run makes two renders impossible to diff."""
    state = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    while True:
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        yield state / 0x7FFFFFFF


def _perimeter_len(hx, hy, corner):
    c = max(0.0, min(corner, min(hx, hy)))
    return 4 * (hx - c) + 4 * (hy - c) + 2 * math.pi * c


def build_crowd(collection, count=None, rows=None, seat_pitch=0.55):
    """Mass, never individuals. One mesh, one material, colour from a
    per-vertex attribute (section 3.4).

    SEATS ARE PLACED BY ARC LENGTH, NOT BY PATH INDEX. The first version of
    this indexed the 148-point bowl path, which silently capped the crowd at
    148 x 26 = 3,848 however large --crowd was, and put every row's spectators
    on the same bearing so the stand read as radial spokes rather than as a
    crowd. Each row now gets its own path resampled at its own radius, and odd
    rows are offset by half a seat so it does not read as a grid either.

    A full bowl at a 0.55 m seat pitch comes to ~18,000 - the figure in the
    guide - so a smaller --crowd is a fraction of the real crowd chosen for
    build time, not a different design.
    """
    count = count or style.CROWD_DEFAULT
    rows = rows or B["rows"]

    spans = []
    for r in range(rows):
        out = r * B["run"] + B["run"] * 0.55
        spans.append(_perimeter_len(B["hx"] + out, B["hy"] + out, B["corner"] + out))
    total = sum(spans) or 1.0
    full = int(total / seat_pitch)
    count = min(count, full)

    rnd = _lcg(20260901)
    parts, colours, placed = [], [], 0

    for r in range(rows):
        seats = max(1, int(round(count * spans[r] / total)))
        out = r * B["run"] + B["run"] * 0.55
        z = B["base"] + r * B["rise"]
        ring = prim.rounded_rect_path(B["hx"] + out, B["hy"] + out,
                                      B["corner"] + out, seats)
        stagger = (r % 2) * 0.5
        for i in range(seats):
            x, y, nx, ny = ring[i]
            if stagger:
                nxt = ring[(i + 1) % seats]
                x += (nxt[0] - x) * stagger
                y += (nxt[1] - y) * stagger
            jitter = (next(rnd) - 0.5) * 0.10
            px, py = x + nx * jitter, y + ny * jitter
            scale = 0.86 + next(rnd) * 0.28
            body = prim.box((px, py, z + 0.28 * scale), (0.30, 0.30, 0.56 * scale))
            head = prim.sphere((px, py, z + 0.63 * scale), 0.098 * scale, 5, 4)
            parts.append(body)
            parts.append(head)
            rgba = compat.hex_rgba(
                style.CROWD[int(next(rnd) * 997) % len(style.CROWD)])
            colours.extend([rgba] * (len(body[0]) + len(head[0])))
            placed += 1

    if not parts:
        return None

    verts, faces = prim.merge(*parts)
    obj = scene.new_mesh_object("BOWL_Crowd", verts, faces, collection)
    scene.assign(obj, materials.crowd())

    attr = obj.data.attributes.new(name="crowd_col", type="FLOAT_COLOR",
                                   domain="POINT")
    for i, rgba in enumerate(colours[:len(obj.data.vertices)]):
        attr.data[i].color = rgba

    print("  crowd: %d spectators (%d%% of a %d-seat bowl), %d verts, 1 draw"
          % (placed, round(100.0 * placed / max(1, full)), full,
             len(obj.data.vertices)))
    return obj


# --------------------------------------------------------------------------
# props
# --------------------------------------------------------------------------

def build_props(collection):
    """Corner flags and floodlight pylons, placed from the pitch and the bowl.

    tools/blender/stadium_props.py already exports these as a GLB for the game.
    These are the scene-dressing copies for renders — same dimensions, built
    here so a lookdev frame is not missing the silhouette that says football
    ground before anything else in it does.
    """
    made = []
    hw, hl = P["halfW"], P["halfL"]

    for sx in (-1, 1):
        for sy in (-1, 1):
            pole = prim.merge(
                prim.tube((sx * hw, sy * hl, 0.0), (sx * hw, sy * hl, 1.50),
                          0.022, 0.018, 8),
                prim.quad((sx * hw, sy * hl, 1.50),
                          (sx * hw + sx * 0.30, sy * hl + sy * 0.10, 1.42),
                          (sx * hw + sx * 0.30, sy * hl + sy * 0.10, 1.22),
                          (sx * hw, sy * hl, 1.18)),
            )
            obj = scene.new_mesh_object("Prop_CornerFlag_%s%s"
                                        % ("P" if sx > 0 else "M",
                                           "P" if sy > 0 else "M"),
                                        pole[0], pole[1], collection)
            scene.assign(obj, materials.flag())
            made.append(obj)

    lx, ly = B["hx"] * 0.92, B["hy"] * 0.92
    for sx in (-1, 1):
        for sy in (-1, 1):
            base, top = (sx * lx, sy * ly, 0.0), (sx * lx, sy * ly, 26.0)
            head = prim.merge(
                prim.tube(base, top, 0.55, 0.26, 8),
                prim.box((sx * lx, sy * ly, 27.4), (5.2, 0.7, 2.4)),
            )
            obj = scene.new_mesh_object("Prop_Floodlight_%s%s"
                                        % ("P" if sx > 0 else "M",
                                           "P" if sy > 0 else "M"),
                                        head[0], head[1], collection)
            scene.assign(obj, materials.steel())
            made.append(obj)
    return made


def build_ball(collection, location=(0.0, -30.0, 0.11)):
    verts, faces = prim.sphere(location, 0.11, 24, 16)
    obj = scene.new_mesh_object("PITCH_Ball", verts, faces, collection,
                                smooth=True, smooth_angle=60.0)
    scene.assign(obj, materials.ball())
    return obj
