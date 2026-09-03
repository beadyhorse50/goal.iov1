"""goal.io — the match ball, as a hero asset. Cycles, studio-lit, product grade.

    # in the LIVE Blender (Cycles is absent under --factory-startup):
    exec(open(r"tools/blender/hero_ball.py").read())

    # or headless, EEVEE fallback:
    blender --background --python tools/blender/hero_ball.py -- --render

WHY THE BALL
------------
docs/ART-STYLE.md section 8.23 asks for exactly this shot, and the ball in the
game scene is a placeholder: a 24x16 UV sphere with a flat white material. It is
the one object in the frame the player looks at on every single attempt, and it
is currently the least modelled thing in the project.

THE GEOMETRY IS A REAL TRUNCATED ICOSAHEDRON
--------------------------------------------
Not a sphere with a texture painted on it. The classic 32-panel ball is the
Archimedean solid: take an icosahedron and cut every vertex at exactly one third
of the edge, and the 12 vertices become 12 pentagons while the 20 triangles
become 20 hexagons. That one number is what makes the panels regular; anything
else gives lopsided hexagons that read as wrong without being obviously wrong.

  icosahedron edge, circumradius R:   a = 4R / sqrt(10 + 2*sqrt(5))
  truncation offset:                  a / 3

Everything is then pushed back onto the sphere, the panels are inset to cut the
seam channels, and Bevel + Subdivision round them. The panel edges are real
geometry, so they catch a real specular terminator - which is the whole reason
not to fake this with a normal map.

BUILT WITH bmesh, NOT bpy.ops
-----------------------------
bpy.ops.mesh.* and bpy.ops.transform.* need an edit-mode object and, for some
operators, a VIEW_3D context. Driven over MCP from a script there is no
guarantee of either, and the failure is an opaque "context is incorrect". bmesh
takes the mesh directly and is the same code headless or live.

NO BITMAP TEXTURES, AND NO DOWNLOADED HDRI
------------------------------------------
Consistent with docs/GRAPHICS-AUDIT.md: everything here is procedural. The
leather grain, the panel wear, the seam darkening and the environment are all
node graphs. The environment is Blender's Nishita sky - a physically-modelled
atmosphere, genuinely high dynamic range - rather than a downloaded .hdr, so
this script has no external dependency and produces the same frame on any
machine. Swap in a PolyHaven HDRI if you want a specific studio reflection.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from goalio import compat
    hex_rgba = compat.hex_rgba
except Exception:                                    # standalone fallback
    def _s2l(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    def hex_rgba(h, a=1.0):
        h = h.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        return (_s2l(r), _s2l(g), _s2l(b), a)

# ---------------------------------------------------------------- constants

R = 0.110               # FIFA size 5: 68-70 cm circumference -> 0.110 m radius
# SEAM is the inset PER PANEL, so the visible gap between two panels is twice
# it. A real match ball's seam is 2-3 mm total; the first pass used 4.2 mm per
# side, giving an 8.4 mm channel - about a quarter of a panel's width - and the
# ball rendered as a cage with tiles set into it rather than as a football.
SEAM = 0.0013           # -> ~2.6 mm visible channel
BULGE = 0.0011          # how far each panel stands proud of the seam
CREASE = 0.62           # holds the panel edge against Subdivision
BEVEL_W = 0.0011        # panel edge round-over
BEVEL_SEG = 3
SUBSURF_VIEW = 2
# MEASURED, not assumed. Render-level tri counts for this cage:
#   level 1 =  28,800   silhouette shows small flats around the rim
#   level 2 = 115,200   silhouette clean at 1920 px
#   level 3 = 460,800   4x the geometry, no visible difference
# Level 2 is the optimisation: the lowest level that holds the silhouette.
SUBSURF_RENDER = 2

WHITE = "#f4f7fa"       # hexagons
BLUE = "#0090ff"        # pentagons - section 1.1 action hue
GOLD = "#ffc233"        # stitch accent
SEAM_COL = "#1b2129"    # the channel between panels
GREY = "#5a636d"        # studio sweep


def _log(msg):
    print("[hero_ball] %s" % msg)


# ---------------------------------------------------------------- geometry

def _crease_layer(bm):
    """Edge crease, across the 4.x attribute change.

    Up to 3.x this was bm.edges.layers.crease. From 4.0 crease is a generic
    named float attribute, 'crease_edge', and the old accessor is gone - so the
    obvious code raises AttributeError on any current Blender.
    """
    layers = bm.edges.layers
    if hasattr(layers, "crease"):
        try:
            return layers.crease.verify()
        except Exception:
            pass
    try:
        return layers.float.get("crease_edge") or layers.float.new("crease_edge")
    except Exception as exc:
        _log("no crease layer available (%s) - seams will be softer" % exc)
        return None


def build_ball(name="HERO_Ball", crease_w=None, cast=0.0, subsurf=None):
    """The 32-panel truncated icosahedron, panels inset and bulged."""
    bm = bmesh.new()

    # icosahedron. The bmesh op renamed diameter -> radius across versions.
    try:
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=R)
    except TypeError:
        bmesh.ops.create_icosphere(bm, subdivisions=1, diameter=R)
    _log("icosahedron: %d verts, %d faces" % (len(bm.verts), len(bm.faces)))

    # TRUNCATION. offset = a/3 where a is the icosahedron edge length for
    # circumradius R. Derived, not tuned: any other value gives irregular
    # hexagons, which look subtly wrong and are hard to diagnose later.
    edge = 4.0 * R / math.sqrt(10.0 + 2.0 * math.sqrt(5.0))
    bmesh.ops.bevel(
        bm,
        geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
        offset=edge / 3.0,
        offset_type="OFFSET",
        segments=1,
        profile=0.5,
        affect="VERTICES",
        clamp_overlap=False,
    )

    pent = sum(1 for f in bm.faces if len(f.verts) == 5)
    hexa = sum(1 for f in bm.faces if len(f.verts) == 6)
    _log("truncated: %d faces (%d pentagons, %d hexagons)"
         % (len(bm.faces), pent, hexa))
    if (pent, hexa) != (12, 20):
        _log("WARNING: not a clean truncated icosahedron - check the offset")

    # SPHERIFY, by hand. bpy.ops.transform.tosphere needs a 3D view context;
    # normalising the vectors is the same operation and needs nothing.
    for v in bm.verts:
        v.co = v.co.normalized() * R

    # Materials assigned NOW, while the faces are still clean pentagons and
    # hexagons. After the inset every panel is a rim plus an inner face and
    # telling them apart by vertex count no longer works.
    for f in bm.faces:
        f.material_index = 1 if len(f.verts) == 5 else 0

    # Seam channels. inset_individual carries material_index onto the new inner
    # face, and `depth` lifts it along its own normal in the same operator, so
    # the panel is proud of the seam without a second pass.
    bmesh.ops.inset_individual(
        bm,
        faces=bm.faces[:],
        thickness=SEAM,
        depth=BULGE,
        use_even_offset=True,
        use_interpolate=True,
    )
    # SEAM MATERIAL FROM REAL FACES, not from a pointiness mask. After
    # inset_individual every panel is its original n-gon plus a ring of QUADS,
    # so the rim is exactly the set of 4-vertex faces. Assigning slot 2 there
    # gives a crisp, controllable seam colour; pointiness gave almost nothing
    # once Subdivision had smoothed the cage.
    rims = 0
    for f in bm.faces:
        if len(f.verts) == 4:
            f.material_index = 2
            rims += 1
    # CREASE THE PANEL BOUNDARY. Without it Subdivision rounds the panel edge
    # away and eats most of the seam, so the channel has to be modelled far too
    # wide to survive - which is the other half of why the first attempt looked
    # like a cage. Creasing lets the seam stay near its real 2-3 mm.
    crease = _crease_layer(bm)
    creased = 0
    if crease is not None:
        for e in bm.edges:
            mats = {f.material_index for f in e.link_faces}
            if len(mats) > 1:
                e[crease] = CREASE if crease_w is None else crease_w
                creased += 1
    _log("panels inset: %d faces (%d seam quads, %d creased edges)"
         % (len(bm.faces), rims, creased))

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.update()

    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)

    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = BEVEL_W
    bev.segments = BEVEL_SEG
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(28)
    bev.harden_normals = True

    sub = obj.modifiers.new("Subdivision", "SUBSURF")
    sub.levels = SUBSURF_VIEW
    sub.render_levels = SUBSURF_RENDER if subsurf is None else subsurf
    sub.use_limit_surface = True

    # CAST back toward the sphere, AFTER subdivision. Creasing the panel
    # outline hard enough to keep a 2.6 mm seam also stops Subdivision rounding
    # the ball at all - it comes out as a faceted polyhedron with a visibly
    # straight-edged silhouette. Cast restores the sphere without touching the
    # seam relief, which is the standard fix and cheaper than fighting the
    # crease weight.
    if cast > 0.0:
        cst = obj.modifiers.new("Cast", "CAST")
        cst.cast_type = "SPHERE"
        cst.factor = cast
        cst.radius = R
        cst.use_radius_as_size = False

    for p in me.polygons:
        p.use_smooth = True
    return obj


def build_sweep(name="HERO_Sweep", size=3.0, rise=1.4, radius=0.55,
                cove_y=0.42, seg=28):
    """A studio cyclorama: flat floor curving into a back wall.

    A product shot needs an infinite-looking backdrop, or the horizon shows up
    as a hard edge behind the subject and the whole thing reads as a box. The
    cove is real geometry rather than a bent plane so it takes a smooth
    specular gradient.

    cove_y IS LOAD-BEARING. The first version started the cove at y = 0, which
    is exactly where the subject stands, so the ball was buried inside the back
    wall and the render came back as an empty grey field - a blank frame that
    looks like a lighting failure and is actually a placement one. The cove now
    starts BEHIND the subject and assert_clear() below checks that it does.
    """
    verts, faces = [], []
    half = size * 0.5
    profile = []

    y = -half
    while y < cove_y:                                    # floor, under the ball
        profile.append((y, 0.0))
        y += 0.12
    for i in range(seg + 1):                             # the cove
        a = (math.pi * 0.5) * i / seg
        profile.append((cove_y + radius * math.sin(a),
                        radius - radius * math.cos(a)))
    z = radius
    while z < rise:                                      # back wall
        profile.append((cove_y + radius, z))
        z += 0.12
    profile.append((cove_y + radius, rise))

    for j, (py, pz) in enumerate(profile):
        for i in (-1, 1):
            verts.append((i * half, py, pz))
    for j in range(len(profile) - 1):
        a = j * 2
        faces.append((a, a + 1, a + 3, a + 2))

    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------- materials

def _mix(nt, data_type="RGBA"):
    """ShaderNodeMix has ten inputs, four of them sharing names. Pick by name
    AND type or a colour link silently lands on the float socket."""
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = data_type
    want = "RGBA" if data_type == "RGBA" else "VALUE"

    def pick(socks, nm, kind):
        return next(s for s in socks if s.name == nm and s.type == kind)

    return (n, pick(n.inputs, "Factor", "VALUE"),
            pick(n.inputs, "A", want), pick(n.inputs, "B", want),
            pick(n.outputs, "Result", want))


def leather(name, base_hex, rough=None):
    """PBR synthetic leather: grain bump, seam darkening from pointiness, and
    a clear coat for the lacquer a match ball actually has."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]

    # SEAM DARKENING from Geometry > Pointiness. Concave geometry reads darker
    # because dirt and shadow collect there; pointiness is the cheapest honest
    # source of that and it follows the real edges rather than a painted mask.
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = (-900, 260)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-700, 260)
    ramp.color_ramp.elements[0].position = 0.42
    ramp.color_ramp.elements[0].color = (0.18, 0.18, 0.2, 1.0)
    ramp.color_ramp.elements[1].position = 0.52
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
    nt.links.new(geo.outputs["Pointiness"], ramp.inputs["Fac"])

    tint = nt.nodes.new("ShaderNodeRGB")
    tint.location = (-700, 40)
    tint.outputs[0].default_value = hex_rgba(base_hex)

    mixn, fac, a, b, res = _mix(nt)
    mixn.location = (-460, 120)
    mixn.blend_type = "MULTIPLY"
    fac.default_value = 1.0
    nt.links.new(tint.outputs[0], a)
    nt.links.new(ramp.outputs["Color"], b)
    nt.links.new(res, bsdf.inputs["Base Color"])

    # grain: fine noise into a bump, plus a broader noise breaking up roughness
    grain = nt.nodes.new("ShaderNodeTexNoise")
    grain.location = (-900, -220)
    grain.inputs["Scale"].default_value = 420.0
    grain.inputs["Detail"].default_value = 6.0
    grain.inputs["Roughness"].default_value = 0.62
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (-460, -220)
    bump.inputs["Strength"].default_value = 0.22
    bump.inputs["Distance"].default_value = 0.0006
    nt.links.new(grain.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    wear = nt.nodes.new("ShaderNodeTexNoise")
    wear.location = (-900, -520)
    wear.inputs["Scale"].default_value = 14.0
    wear.inputs["Detail"].default_value = 3.0
    rmap = nt.nodes.new("ShaderNodeMapRange")
    rmap.location = (-460, -520)
    rmap.inputs["To Min"].default_value = (rough or 0.28) - 0.04
    rmap.inputs["To Max"].default_value = (rough or 0.28) + 0.10
    nt.links.new(wear.outputs["Fac"], rmap.inputs["Value"])
    nt.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])

    for socket, value in (("Coat Weight", 0.55), ("Coat Roughness", 0.12),
                          ("Specular IOR Level", 0.5), ("Metallic", 0.0)):
        if socket in bsdf.inputs:
            bsdf.inputs[socket].default_value = value
    return mat


def sweep_material():
    mat = bpy.data.materials.new("MAT_Sweep")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = hex_rgba(GREY)
    bsdf.inputs["Roughness"].default_value = 0.62
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.35
    return mat


# ------------------------------------------------------------------- world

def build_world(strength=0.08):
    """A physically-modelled sky as the environment light.

    NB on strength: a physical sky is BRIGHT. At 0.22 it swamped the
    three-point rig entirely - scaling the lamps 3x moved the frame's mean
    luminance by 0.04, because the lamps were contributing almost nothing. The
    sky is a reflection and fill source here; the key does the shaping.

    Nishita sky: a physically-modelled atmosphere, real HDR, no download.

    This is the environment light and every reflection the ball picks up. It is
    deliberately not a studio HDRI - a football is an outdoor object and a sky
    gradient in the highlights is what sells that, where a photographed studio
    would put softbox rectangles on it.
    """
    world = bpy.data.worlds.new("HERO_World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (400, 0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (200, 0)
    bg.inputs["Strength"].default_value = strength

    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.location = (-120, 0)

    # SKY TYPE MOVED IN 5.x. Blender 4.x offers 'NISHITA'; 5.2 replaced it with
    # ('SINGLE_SCATTERING', 'MULTIPLE_SCATTERING', 'PREETHAM', 'HOSEK_WILKIE')
    # and setting the old string raises TypeError outright. Pick the best
    # available rather than pinning a version - MULTIPLE_SCATTERING is the
    # higher-fidelity successor to Nishita, PREETHAM the 2.8-era fallback.
    if hasattr(sky, "sky_type"):
        available = sky.bl_rna.properties["sky_type"].enum_items.keys()
        for candidate in ("MULTIPLE_SCATTERING", "NISHITA",
                          "SINGLE_SCATTERING", "HOSEK_WILKIE", "PREETHAM"):
            if candidate in available:
                sky.sky_type = candidate
                _log("sky model: %s (available: %s)"
                     % (candidate, ", ".join(available)))
                break
        for attr, value in (("sun_elevation", math.radians(18.0)),
                            ("sun_rotation", math.radians(200.0)),
                            ("altitude", 200.0), ("air_density", 1.1),
                            ("dust_density", 1.6), ("sun_intensity", 0.35),
                            ("sun_size", math.radians(2.4)),
                            ("ozone_density", 1.0)):
            if hasattr(sky, attr):
                try:
                    setattr(sky, attr, value)
                except Exception as exc:
                    _log("sky.%s rejected: %s" % (attr, exc))
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    # Cycles ambient occlusion pass. Not a substitute for GI - it tightens the
    # contact between panel and seam where a bounce-limited render goes flat.
    ls = world.light_settings
    for attr, value in (("use_ambient_occlusion", True),
                        ("distance", 0.05), ("ao_factor", 0.35)):
        if hasattr(ls, attr):
            setattr(ls, attr, value)
    return world


# ---------------------------------------------------------------- lighting

def _aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat(
        "-Z", "Y").to_euler()


def _area(name, loc, target, size, power, colour, shape="SQUARE", size_y=None):
    d = bpy.data.lights.new(name, type="AREA")
    d.shape = shape
    d.size = size
    if size_y and shape == "RECTANGLE":
        d.size_y = size_y
    d.energy = power
    d.color = hex_rgba(colour)[:3]
    o = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    _aim(o, target)
    return o


def build_three_point(target=(0.0, 0.0, R), exposure=1.0):
    """Key, fill, rim - sized and powered for a 22 cm subject.

    The ratios are the point, not the wattages: key to fill about 4:1 so the
    shadow side still carries panel detail, and a rim hotter than the key so the
    top edge separates from the sweep. An area light smaller than the subject
    gives a hard product-catalogue look; the key here is roughly 3x the ball.
    """
    # Powers measured with probe(), not guessed. The first pass used 145 W of
    # key on a 22 cm subject and clipped 38% of the frame to pure white; these
    # land the ball's mean luminance near 0.45 with almost nothing clipped.
    key = _area("LGT_Key", (-0.95, -0.80, 1.05), target,
                0.90, 26.0 * exposure, "#fff4e2")
    fill = _area("LGT_Fill", (1.25, -0.62, 0.34), target,
                 1.40, 6.5 * exposure, "#dce8ff")
    rim = _area("LGT_Rim", (0.62, 1.10, 0.72), target,
                0.45, 34.0 * exposure, "#eef4ff")
    _log("three-point: key %.0f W / fill %.0f W / rim %.0f W (key:fill %.1f:1)"
         % (key.data.energy, fill.data.energy, rim.data.energy,
            key.data.energy / fill.data.energy))
    return key, fill, rim


# ------------------------------------------------------------------ camera

def frame_distance(subject_size, lens, res, fill=0.62, sensor=36.0):
    """Camera distance so the subject fills `fill` of the LIMITING axis.

    The limiting axis in a 16:9 frame is the SHORT one. Solving on width, which
    is the obvious thing to do, put a 0.22 m ball inside a 0.197 m frame height
    and cropped the top and bottom off it - a mistake that is invisible in the
    arithmetic and obvious in the render.
    """
    w, h = res
    sensor_h = sensor * (h / float(w))
    limiting = min(sensor, sensor_h)
    return (subject_size / fill) * lens / limiting


def build_camera(target=(0.0, 0.0, R), lens=85.0, fstop=2.8,
                 res=(1600, 900), fill=0.62):
    """85 mm, slightly below the equator, shallow.

    A long lens keeps the sphere reading as a sphere: at 35 mm this close the
    silhouette distorts toward an egg. Below the equator because a ball
    photographed from above reads as sitting in a hole.
    """
    d = bpy.data.cameras.new("CAM_Hero")
    d.lens = lens
    d.sensor_fit = "HORIZONTAL"
    d.sensor_width = 36.0
    d.clip_start = 0.01
    d.clip_end = 100.0
    o = bpy.data.objects.new("CAM_Hero", d)
    bpy.context.scene.collection.objects.link(o)

    # Direction is the art decision; distance is solved from the framing.
    dist = frame_distance(R * 2.0, lens, res, fill)
    bearing = Vector((-0.56, -0.79, 0.25)).normalized()
    o.location = Vector(target) + bearing * dist
    _aim(o, target)
    d.dof.use_dof = True
    d.dof.focus_distance = dist
    d.dof.aperture_fstop = fstop
    bpy.context.scene.camera = o
    _log("camera: %.0f mm, %.2f m away, f/%.1f, %.1f deg above the equator, "
         "ball fills %.0f%% of the short axis"
         % (lens, dist, fstop,
            math.degrees(math.asin((o.location.z - target[2]) / dist)),
            fill * 100))
    return o


# ------------------------------------------------------------------ render

def setup_render(samples=128, res=(1600, 900), use_cycles=True):
    sc = bpy.context.scene

    # CYCLES IS NOT IN THE ENGINE ENUM. It registers as a RenderEngine
    # subclass, so bl_rna enum_items reports only ['BLENDER_EEVEE'] even
    # where Cycles is installed and working. The only honest test is to
    # assign it and see. Checking the enum instead is what made an earlier
    # pass here silently fall back to EEVEE on a machine with Cycles.
    engine = None
    if use_cycles:
        if "cycles" not in bpy.context.preferences.addons:
            try:
                bpy.ops.preferences.addon_enable(module="cycles")
            except Exception:
                pass
        try:
            sc.render.engine = "CYCLES"
            engine = "CYCLES"
        except Exception as exc:
            _log("CYCLES rejected (%s)" % exc)

    if engine == "CYCLES":
        c = sc.cycles
        for attr, value in (("samples", samples), ("preview_samples", 24),
                            ("use_denoising", True),
                            ("use_adaptive_sampling", True),
                            ("adaptive_threshold", 0.01),
                            ("max_bounces", 10), ("diffuse_bounces", 4),
                            ("glossy_bounces", 6),
                            ("transmission_bounces", 8),
                            ("transparent_max_bounces", 8),
                            ("blur_glossy", 0.6), ("device", "CPU")):
            if hasattr(c, attr):
                setattr(c, attr, value)
    else:
        ids = set(bpy.types.RenderSettings.bl_rna.properties[
            "engine"].enum_items.keys())
        sc.render.engine = ("BLENDER_EEVEE_NEXT"
                            if "BLENDER_EEVEE_NEXT" in ids
                            else "BLENDER_EEVEE")
        engine = sc.render.engine
        _log("Cycles unavailable - falling back to %s" % engine)

    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"

    # AgX here, deliberately, and it is the ONE place this project wants it:
    # section 4.1 bans a filmic tonemap for anything that must MATCH the game's
    # display-referred output, but this is a photograph of the object rather
    # than a reading of its palette, and the highlight rolloff is the point.
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    _log("engine %s, %d samples, %dx%d, view_transform %s"
         % (sc.render.engine, samples, res[0], res[1],
            sc.view_settings.view_transform))
    return sc.render.engine


# ---------------------------------------------------------------- topology

def topology(obj, at_render=True):
    """Base cage against the evaluated surface.

    MEASURED AT RENDER SETTINGS. evaluated_get() uses the VIEWPORT depsgraph,
    which honours Subdivision.levels and ignores render_levels entirely - so
    the obvious version of this function reports the viewport count and calls
    it the render count. It read 115,200 tris "at subsurf 3" for every level
    from 1 to 3, which is the tell: a number that does not move when the thing
    it measures does. The viewport level is raised to the render level here,
    measured, and put back.
    """
    subs = [m for m in obj.modifiers if m.type == "SUBSURF"]
    saved = [(m, m.levels) for m in subs]
    if at_render:
        for m in subs:
            m.levels = m.render_levels
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        me = ev.to_mesh()
        tris = sum(max(0, len(p.vertices) - 2) for p in me.polygons)
        stats = {"cage_verts": len(obj.data.vertices),
                 "cage_faces": len(obj.data.polygons),
                 "eval_verts": len(me.vertices),
                 "eval_faces": len(me.polygons),
                 "eval_tris": tris,
                 "subsurf": subs[0].render_levels if subs else 0,
                 "ngons": sum(1 for p in obj.data.polygons
                              if len(p.vertices) > 4),
                 "cage_tris": sum(1 for p in obj.data.polygons
                                  if len(p.vertices) == 3)}
        ev.to_mesh_clear()
    finally:
        for m, lvl in saved:
            m.levels = lvl
    return stats


def optimise(obj):
    """Weld coincident verts and drop any face the subdivider cannot use.

    The inset leaves seam-rim vertices that are mathematically distinct and
    visually identical. Left alone they are creases the Bevel then rounds twice,
    which shows up as a faint bright line down every panel edge under a hard
    key - the kind of artefact that looks like a shader problem and is not.
    """
    before = topology(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # bmesh.ops.remove_doubles returns None on 5.x (and a dict without a
    # usable targetmap on some 4.x builds), so count the verts rather than
    # reading the return value.
    n_before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    n_removed = n_before - len(bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    after = topology(obj)
    _log("optimise: cage %d -> %d verts (%d welded), quads/ngons kept, "
         "render surface %d tris"
         % (before["cage_verts"], after["cage_verts"], n_removed,
            after["eval_tris"]))
    return before, after


# -------------------------------------------------------------------- main

def reset(hard=None):
    """Empty the scene.

    NEVER CALL read_factory_settings OVER A LIVE MCP CONNECTION. It resets the
    whole Blender state, which includes the scene properties the blender-mcp
    addon hangs its running server off - so the socket dies mid-call and the
    session comes back "Not connected to Blender" with no other explanation.
    Measured here: it took the connection down on the first attempt at this
    scene. Headless it is fine and it is the cleaner reset, so the choice is
    made automatically from bpy.app.background rather than left to the caller.
    """
    if hard is None:
        hard = bpy.app.background
    if hard:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    else:
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                  bpy.data.lights, bpy.data.cameras, bpy.data.worlds):
        for item in list(block):
            try:
                block.remove(item)
            except Exception:
                pass


def assert_framed(subject, camera, sweep=None):
    """Prove the subject is actually IN FRAME and IN FRONT of the backdrop.

    An empty render is the most expensive failure in this whole file: it costs
    a full Cycles pass to discover and it looks identical whether the cause is
    lighting, placement, a clipping plane or the camera pointing at nothing.
    Three cheap checks turn all four into one line of text.
    """
    from bpy_extras.object_utils import world_to_camera_view
    sc = bpy.context.scene

    # matrix_world IS LAZY. Setting .location / .rotation_euler does not
    # recompute it until the depsgraph runs, and in --background nothing
    # triggers that on its own. Without this line every object still reports
    # the origin, so the check above says depth 0.00 m and fails everything -
    # a false alarm that looks exactly like a real placement bug.
    bpy.context.view_layer.update()

    centre = subject.matrix_world.translation
    ndc = world_to_camera_view(sc, camera, centre)
    depth = (centre - camera.matrix_world.translation).length

    in_frame = 0.0 < ndc.x < 1.0 and 0.0 < ndc.y < 1.0 and ndc.z > 0.0
    in_clip = camera.data.clip_start < depth < camera.data.clip_end

    radius = max(subject.dimensions) * 0.5
    clear = True
    if sweep is not None:
        # The BACK of the sweep, i.e. its maximum Y. Using the minimum instead
        # measures the floor's front edge, which is correctly in front of the
        # subject and so always "fails" - a check that reports a fault where
        # there is none is worse than no check at all.
        back = max(v[1] for v in
                   (sweep.matrix_world @ Vector(c) for c in sweep.bound_box))
        clear = back > centre.y + radius

    _log("framing: ndc (%.2f, %.2f)  depth %.2f m  in-frame %s  in-clip %s  "
         "clear of backdrop %s" % (ndc.x, ndc.y, depth, in_frame, in_clip, clear))
    if not (in_frame and in_clip and clear):
        raise RuntimeError(
            "subject would not render: in_frame=%s in_clip=%s clear=%s. "
            "Fix placement before spending a Cycles pass on it."
            % (in_frame, in_clip, clear))
    return True


def build(samples=128, res=(1600, 900), use_cycles=True, exposure=1.0,
          world=0.08, crease_w=None, cast=0.70, subsurf=None):
    reset()

    ball = build_ball(crease_w=crease_w, cast=cast, subsurf=subsurf)
    ball.data.materials.append(leather("MAT_Ball_Hex", WHITE))
    ball.data.materials.append(leather("MAT_Ball_Pent", BLUE))
    ball.data.materials.append(leather("MAT_Ball_Seam", SEAM_COL, rough=0.55))
    ball.location = (0.0, 0.0, R)

    sweep = build_sweep()
    sweep.data.materials.append(sweep_material())

    build_world(world)
    build_three_point(exposure=exposure)
    cam = build_camera(res=res)
    engine = setup_render(samples, res, use_cycles)
    assert_framed(ball, cam, sweep)

    before, after = optimise(ball)
    _log("panels: 12 pentagons + 20 hexagons = 32, as a truncated icosahedron")
    _log("cage %d verts / %d faces (%d n-gons, %d tris)  ->  RENDER surface "
         "%d verts / %d tris at subsurf %d"
         % (after["cage_verts"], after["cage_faces"], after["ngons"],
            after["cage_tris"], after["eval_verts"], after["eval_tris"],
            after["subsurf"]))
    return ball, engine, after


def probe(res=(320, 180), samples=12):
    """A tiny render, measured. Exposure is not a thing to guess at 5 minutes a
    guess: this renders 320x180 in a few seconds and reports what the frame
    actually did, so the lighting is dialled on numbers and only the final pass
    costs real time.

    Reports mean luminance, the 95th percentile, and the fraction of pixels
    clipped to white - which is the number that matters, because AgX hides
    moderate overexposure right up until it does not.
    """
    import tempfile
    sc = bpy.context.scene
    keep = (sc.render.resolution_x, sc.render.resolution_y,
            sc.render.filepath,
            getattr(sc.cycles, "samples", None) if hasattr(sc, "cycles") else None)
    sc.render.resolution_x, sc.render.resolution_y = res
    if hasattr(sc, "cycles"):
        sc.cycles.samples = samples

    path = os.path.join(tempfile.gettempdir(), "goalio_probe.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)

    img = bpy.data.images.load(path, check_existing=False)
    px = img.pixels[:]
    lum = sorted(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
                 for i in range(0, len(px), 4))
    n = len(lum) or 1
    mean = sum(lum) / n
    p95 = lum[int(n * 0.95) - 1]
    clipped = sum(1 for v in lum if v > 0.99) / float(n)
    bpy.data.images.remove(img)

    sc.render.resolution_x, sc.render.resolution_y = keep[0], keep[1]
    sc.render.filepath = keep[2]
    if keep[3] is not None:
        sc.cycles.samples = keep[3]

    _log("probe: mean %.3f  p95 %.3f  clipped %.1f%%  -> %s"
         % (mean, p95, clipped * 100,
            "OK" if (0.28 < mean < 0.60 and clipped < 0.02) else "ADJUST"))
    return {"mean": mean, "p95": p95, "clipped": clipped}


def render(path):
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    kb = os.path.getsize(path) / 1024.0 if os.path.exists(path) else 0
    _log("rendered %s (%.0f KB)" % (path, kb))
    return path


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    build(samples=256, res=(1920, 1080), exposure=1.6)
    if "--render" in argv:
        render("build/blender/hero/ball_hero.png")
    if "--save" in argv:
        out = os.path.abspath("build/blender/hero/ball_hero.blend")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=out)
        _log("saved %s" % out)
