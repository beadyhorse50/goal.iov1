"""The material library, built from style.py.

Everything is generated. There are no image textures anywhere in this package,
for the reason docs/BLENDER.md already gives for the props: a painted texture
here would be a second art direction competing with the one in
js/render.gl.js. The turf stripes, the kit tint and the crowd variation are all
node graphs driven by the palette.

TWO TRAPS, BOTH SILENT
----------------------
1. default_value is LINEAR. Every colour goes through compat.hex_rgba. Feeding
   sRGB hex straight into a socket is what turns #43a259 into the mint green
   the guide's arcade-drift warning is about.

2. ShaderNodeMix has TEN inputs and four of them are called the same thing.
   'Factor' exists as both Float and Vector; 'A' and 'B' exist as Float,
   Vector, Color and Rotation. node.inputs['A'] returns the FLOAT one, so
   linking a colour to it silently converts to greyscale and the kit comes out
   grey. _mix() below picks by name AND type, which is the only stable form
   across 4.x and 5.x.
"""

import bpy

from . import compat, style

_CACHE = {}


# --------------------------------------------------------------------------
# node helpers
# --------------------------------------------------------------------------

def _fresh(name):
    """A material with a clean node tree and the Principled/Output pair."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    out = nt.nodes.get("Material Output")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    if out is None:
        out = nt.nodes.new("ShaderNodeOutputMaterial")
    if not bsdf.outputs[0].links:
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.location = (0, 0)
    out.location = (320, 0)
    return mat, nt, bsdf


def _mix(nt, data_type="RGBA"):
    """A Mix node plus its four ambiguous sockets, resolved by name and type."""
    node = nt.nodes.new("ShaderNodeMix")
    node.data_type = data_type
    want = "RGBA" if data_type == "RGBA" else "VALUE"

    def pick(sockets, name, kind):
        for sock in sockets:
            if sock.name == name and sock.type == kind:
                return sock
        raise KeyError("no %s socket named %r on ShaderNodeMix" % (kind, name))

    fac = pick(node.inputs, "Factor", "VALUE")
    a = pick(node.inputs, "A", want)
    b = pick(node.inputs, "B", want)
    res = pick(node.outputs, "Result", want)
    return node, fac, a, b, res


def _math(nt, op, value=None, loc=(0, 0), value2=None):
    node = nt.nodes.new("ShaderNodeMath")
    node.operation = op
    node.location = loc
    if value is not None:
        node.inputs[1].default_value = value
    if value2 is not None:
        node.inputs[2].default_value = value2
    return node


# --------------------------------------------------------------------------
# the plain case
# --------------------------------------------------------------------------

def pbr(name, hex_colour, rough=0.7, metal=0.0, alpha=1.0, sheen=0.0):
    """One flat PBR surface. Covers most of the build."""
    key = ("pbr", name)
    if key in _CACHE:
        return _CACHE[key]
    mat, nt, bsdf = _fresh(name)
    compat.bsdf_set(bsdf, "Base Color", compat.hex_rgba(hex_colour, alpha))
    compat.bsdf_set(bsdf, "Roughness", rough)
    compat.bsdf_set(bsdf, "Metallic", metal)
    if sheen:
        compat.bsdf_set(bsdf, "Sheen", sheen)
    if alpha < 1.0:
        compat.bsdf_set(bsdf, "Alpha", alpha)
        mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else mat.blend_method
    _CACHE[key] = mat
    return mat


# --------------------------------------------------------------------------
# §1.3  turf — the mow stripes, procedurally
# --------------------------------------------------------------------------

def turf(wet=0.0, lit=False):
    """Alternating mow bands along the length of the pitch.

    §1.3: the two directions need real value separation or the stripes vanish
    once haze lifts the far end. The bands are hard-edged (FLOOR then WRAP),
    not a sine: a real mow is a hard edge where the roller changed direction, and
    a gradient reads as a lighting artefact instead of as groundskeeping.
    """
    key = ("turf", round(wet, 3), lit)
    if key in _CACHE:
        return _CACHE[key]

    c1 = style.WORLD["grass1Lit" if lit else "grass1"]
    c2 = style.WORLD["grass2Lit" if lit else "grass2"]
    mat, nt, bsdf = _fresh("MAT_Turf" + ("_Wet" if wet > 0.02 else ""))

    tex = nt.nodes.new("ShaderNodeTexCoord")
    tex.location = (-1100, 0)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-920, 0)
    nt.links.new(tex.outputs["Object"], sep.inputs["Vector"])

    div = _math(nt, "DIVIDE", style.STRIPE_W, (-740, 40))
    flr = _math(nt, "FLOOR", None, (-570, 40))
    # WRAP, NOT MODULO. Blender's MODULO node is truncated fmod, so it returns
    # a NEGATIVE result for negative input: fmod(-3, 2) = -1, which the mix
    # then clamps to 0. The visible effect is that the mow stripes render on
    # the +Y half of the pitch and vanish on the -Y half — a half-striped pitch
    # that looks like a lighting falloff, not like a broken shader, and which
    # is invisible from a camera that only ever sees one end.
    # WRAP(value, max=2, min=0) is a true modulo and is correct on both halves.
    mod = _math(nt, "WRAP", 2.0, (-400, 40), value2=0.0)
    nt.links.new(sep.outputs["Y"], div.inputs[0])
    nt.links.new(div.outputs[0], flr.inputs[0])
    nt.links.new(flr.outputs[0], mod.inputs[0])

    # A little broadband noise so the bands are not two flat fields. Kept low:
    # this is a football pitch, not a carpet.
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-740, -240)
    noise.inputs["Scale"].default_value = 90.0
    noise.inputs["Detail"].default_value = 3.0
    nt.links.new(tex.outputs["Object"], noise.inputs["Vector"])

    band, bfac, ba, bb, bres = _mix(nt)
    band.location = (-220, 40)
    band.inputs[0].default_value = 0.0
    ba.default_value = compat.hex_rgba(c1)
    bb.default_value = compat.hex_rgba(c2)
    nt.links.new(mod.outputs[0], bfac)

    # The grain factor must be SCALED before it reaches the mix. Linking the
    # noise straight to Factor overrides the default_value set beside it and
    # drives the mix across its full 0..1 range, which blends the two greens
    # into each other and erases the stripes — the exact failure §1.3 warns
    # about ("the stripes vanish"), arrived at from the other direction.
    grain_amt = _math(nt, "MULTIPLY", 0.07, (-560, -240))
    nt.links.new(noise.outputs["Fac"], grain_amt.inputs[0])

    grain, gfac, ga, gb, gres = _mix(nt)
    grain.location = (-60, 40)
    nt.links.new(bres, ga)
    nt.links.new(grain_amt.outputs[0], gfac)
    gb.default_value = compat.hex_rgba(style.WORLD["grass2"])
    nt.links.new(gres, bsdf.inputs["Base Color"])

    # §4.3: wet is a sheen, not a colour. It drops roughness and lifts
    # specular; it must never tint the grass.
    rough = style.ROUGH["turf"] * (1.0 - 0.55 * wet)
    compat.bsdf_set(bsdf, "Roughness", rough)
    compat.bsdf_set(bsdf, "Specular", 0.5 + 0.5 * wet)

    _CACHE[key] = mat
    return mat


def line_paint():
    """Pitch markings. Slightly rough white — gloss paint on grass reads as
    plastic in every wide camera."""
    return pbr("MAT_Line", style.WORLD["line"], rough=0.66)


# --------------------------------------------------------------------------
# §1.4  kits — one material per role, tinted, never striped
# --------------------------------------------------------------------------

def kit(role):
    """Shirt colour with a white trim band driven by a vertex-colour mask.

    §8.7 describes the atlas as greyscale plus a tint mask, which is exactly
    how js/kit.js paints it at runtime. This mirrors that in shader form so a
    new club kit is two colour changes and no new geometry — and because the
    mask is a mask, halves and hoops remain impossible by construction, which
    is what §1.4 asks for.
    """
    key = ("kit", role)
    if key in _CACHE:
        return _CACHE[key]

    colours = style.KITS[role]
    mat, nt, bsdf = _fresh("MAT_Kit_%s" % role.capitalize())

    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.location = (-620, 0)
    attr.attribute_name = "trim"          # 0 = shirt body, 1 = collar/cuff
    attr.attribute_type = "GEOMETRY"

    mix, fac, a, b, res = _mix(nt)
    mix.location = (-300, 0)
    a.default_value = compat.hex_rgba(colours["shirt"])
    b.default_value = compat.hex_rgba(style.TRIM)
    nt.links.new(attr.outputs["Fac"], fac)
    nt.links.new(res, bsdf.inputs["Base Color"])

    compat.bsdf_set(bsdf, "Roughness", style.ROUGH["shirt"])
    compat.bsdf_set(bsdf, "Sheen", 0.22)      # technical fabric, faint sheen
    _CACHE[key] = mat
    return mat


def shorts(role):
    return pbr("MAT_Shorts_%s" % role.capitalize(),
               style.KITS[role]["short"], rough=style.ROUGH["short"], sheen=0.15)


def socks(role):
    return pbr("MAT_Socks_%s" % role.capitalize(),
               style.KITS[role]["sock"], rough=style.ROUGH["sock"], sheen=0.3)


def skin(index=1):
    return pbr("MAT_Skin_%d" % index, style.SKIN[index % len(style.SKIN)],
               rough=style.ROUGH["skin"])


def hair():
    return pbr("MAT_Hair", style.HAIR, rough=style.ROUGH["hair"])


def boot(flash_index=0):
    """§1.5 — modern boots are never black, and the flash is the single detail
    that dates the game most obviously if it is missing. Built as a gradient
    along the boot's local X so one material gives upper and flash without a
    second material slot."""
    key = ("boot", flash_index)
    if key in _CACHE:
        return _CACHE[key]
    mat, nt, bsdf = _fresh("MAT_Boot_%d" % flash_index)

    tex = nt.nodes.new("ShaderNodeTexCoord")
    tex.location = (-800, 0)
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.location = (-620, 0)
    grad.gradient_type = "LINEAR"
    nt.links.new(tex.outputs["Object"], grad.inputs["Vector"])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-440, 0)
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = compat.hex_rgba(style.BOOT)
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = compat.hex_rgba(
        style.BOOT_FLASH[flash_index % len(style.BOOT_FLASH)])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

    compat.bsdf_set(bsdf, "Roughness", style.ROUGH["boot"])
    _CACHE[key] = mat
    return mat


# --------------------------------------------------------------------------
# §3  stadium surfaces
# --------------------------------------------------------------------------

def concrete():
    return pbr("MAT_Concrete", style.WORLD["concrete"], rough=style.ROUGH["concrete"])


def seating():
    """Section 3.5 asks for dark navy seats. n600 taken straight from the
    UI palette renders as a black hole under a low sun - that value is
    chosen to sit BEHIND glass with a lit scene showing through it, not to
    be a large lit surface in its own right. n400 keeps the hue and gives
    the rake somewhere to read."""
    return pbr("MAT_Seat", style.UI.get("n400", "#1e344c"), rough=style.ROUGH["seat"])


def hoarding():
    return pbr("MAT_Hoarding", style.WORLD["adBg"], rough=style.ROUGH["ad"])


def post():
    return pbr("MAT_GoalPost", style.WORLD["postWhite"], rough=style.ROUGH["post"])


def net():
    """§8.13 — the net must read as VOLUME, not as lines. Slight translucency
    plus a low roughness gets the front and back panels reading at different
    values, which is the whole trick."""
    key = ("net",)
    if key in _CACHE:
        return _CACHE[key]
    mat, nt, bsdf = _fresh("MAT_Net")
    compat.bsdf_set(bsdf, "Base Color", compat.hex_rgba(style.WORLD["netWhite"]))
    compat.bsdf_set(bsdf, "Roughness", style.ROUGH["net"])
    compat.bsdf_set(bsdf, "Transmission", 0.18)
    compat.bsdf_set(bsdf, "IOR", 1.2)
    _CACHE[key] = mat
    return mat


def crowd():
    """§3.4 — mass, never individuals. One material for every spectator, with
    the colour coming from a per-vertex Color attribute so 3,000 people are one
    draw and one material. Roughness is high and flat: a specular highlight on
    a spectator makes them an individual again."""
    key = ("crowd",)
    if key in _CACHE:
        return _CACHE[key]
    mat, nt, bsdf = _fresh("MAT_Crowd")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.location = (-320, 0)
    attr.attribute_name = "crowd_col"
    attr.attribute_type = "GEOMETRY"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    compat.bsdf_set(bsdf, "Roughness", 0.95)
    compat.bsdf_set(bsdf, "Specular", 0.15)
    _CACHE[key] = mat
    return mat


def ball():
    return pbr("MAT_Ball", "#f4f7fa", rough=style.ROUGH["ball"])


def flag():
    return pbr("MAT_Flag", style.UI.get("g400", "#ffc233"), rough=0.8)


def steel():
    return pbr("MAT_Steel", "#8f9aa5", rough=0.42, metal=0.85)


def clear_cache():
    _CACHE.clear()
