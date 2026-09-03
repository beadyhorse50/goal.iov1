"""Blender 4.x / 5.x differences, isolated to one file.

The scripts are written against the Blender 4.x API. The machine that builds
them runs 5.2.1 LTS. Four things actually moved between those, and every one of
them fails in a way that does not look like a version problem:

  1. THE EEVEE ENGINE ID. 4.0/4.1 = 'BLENDER_EEVEE'. 4.2-4.5 = 'BLENDER_EEVEE_NEXT'.
     5.0+ went back to 'BLENDER_EEVEE'. Setting a string that is not in the enum
     raises TypeError at the assignment, which at least is loud, but hard-coding
     any one of the three guarantees the script only runs on one Blender.

  2. AUTO-SMOOTH is gone as of 4.1. mesh.use_auto_smooth no longer exists;
     shading by angle is a modifier now. Guarded here so a missing attribute
     does not take the build down.

  3. PRINCIPLED BSDF SOCKET NAMES changed wholesale in 4.0 — "Specular" became
     "Specular IOR Level", "Emission" became "Emission Color", and so on. These
     are stable from 4.0 through 5.x, so the names below are the 4.x ones, but
     they are looked up defensively because a missing socket raises KeyError and
     kills the material half-built, which then renders as flat grey and reads as
     an art problem rather than a script one.

  4. COLOUR. Blender node default_value is LINEAR. The palette in the style
     guide is sRGB hex. Feeding hex straight in is the single most common way to
     make a scene that is subtly, uniformly wrong — everything comes out pale,
     the turf goes mint, and it looks exactly like the arcade drift the guide
     exists to prevent. srgb_to_linear below is the real piecewise transform,
     not a 2.2 gamma approximation.
"""

import bpy


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------

def srgb_to_linear(c):
    """IEC 61966-2-1. Not pow(c, 2.2) — that is wrong by up to 4% in the
    shadows, which is exactly where the turf and the navy UI live."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h, a=1.0):
    """'#43a259' -> linear (r, g, b, a) ready for a shader socket."""
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), a)


def hex_rgb(h):
    return hex_rgba(h)[:3]


# --------------------------------------------------------------------------
# render engine
# --------------------------------------------------------------------------

def engine_ids():
    """The STATIC engine enum. Built-ins only.

    An add-on engine - Cycles included - registers as a RenderEngine
    subclass and never appears in this enum. Measured on 5.2.1: this
    returns ['BLENDER_EEVEE'] on a machine where Cycles is enabled and
    `scene.render.engine = "CYCLES"` succeeds. Do not use it to decide
    whether an engine exists - use cycles_available() or set_engine().
    """
    return set(
        bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys()
    )


def eevee_id():
    """Whichever EEVEE this Blender calls itself."""
    ids = engine_ids()
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if candidate in ids:
            return candidate
    return "CYCLES"


def ensure_cycles():
    """Register Cycles if this Blender has not.

    --factory-startup loads no user preferences, so on some builds the
    Cycles add-on is never enabled. Enabling one named add-on is a smaller
    price than dropping --factory-startup, which is load-bearing for
    reproducibility (docs/BLENDER.md).
    """
    if "cycles" in bpy.context.preferences.addons:
        return True
    try:
        bpy.ops.preferences.addon_enable(module="cycles")
        return "cycles" in bpy.context.preferences.addons
    except Exception as exc:
        print("  [compat] cycles unavailable (%s) - EEVEE only" % exc)
        return False


def cycles_available():
    """Whether CYCLES can actually be set. NOT an enum lookup - see
    engine_ids() for why that answers the wrong question."""
    return ensure_cycles()


def set_engine(name):
    """Set the render engine, trying the assignment rather than
    predicting it. Returns the engine actually in force."""
    scene = bpy.context.scene
    key = (name or "eevee").strip().lower()
    if key == "cycles":
        ensure_cycles()
        try:
            scene.render.engine = "CYCLES"
            return "CYCLES"
        except Exception as exc:
            print("  [compat] CYCLES rejected (%s) - falling back" % exc)
            scene.render.engine = eevee_id()
            return scene.render.engine
    if key in ("eevee", "eevee_next", "realtime"):
        scene.render.engine = eevee_id()
        return scene.render.engine
    try:
        scene.render.engine = name
    except Exception:
        scene.render.engine = eevee_id()
    return scene.render.engine


def resolve_engine(name):
    """Accept 'eevee' / 'cycles' / a raw enum id and return something settable."""
    key = (name or "eevee").strip().lower()
    if key in ("eevee", "eevee_next", "realtime"):
        return eevee_id()
    if key == "cycles":
        return "CYCLES" if cycles_available() else eevee_id()
    # NB: prefer set_engine() over resolve_engine() where you are about to
    # assign - it verifies by assigning instead of by predicting.
    return name if name in engine_ids() else eevee_id()


# --------------------------------------------------------------------------
# shading
# --------------------------------------------------------------------------

# 4.x Principled names. Anything not in this map is passed through verbatim.
BSDF_ALIAS = {
    "Specular": "Specular IOR Level",
    "Subsurface": "Subsurface Weight",
    "Transmission": "Transmission Weight",
    "Sheen": "Sheen Weight",
    "Clearcoat": "Coat Weight",
    "Clearcoat Roughness": "Coat Roughness",
    "Emission": "Emission Color",
}


def bsdf_set(bsdf, socket, value):
    """Set a Principled input by either its 3.x or 4.x name, and say so loudly
    if neither exists rather than leaving the material silently half-built."""
    for name in (socket, BSDF_ALIAS.get(socket)):
        if name and name in bsdf.inputs:
            bsdf.inputs[name].default_value = value
            return True
    print("  [compat] Principled has no socket %r — skipped" % socket)
    return False


def shade_smooth(obj, angle_deg=None):
    """Smooth shading, optionally by angle. 4.1 removed use_auto_smooth and
    replaced it with an operator that adds a modifier."""
    me = obj.data
    for poly in me.polygons:
        poly.use_smooth = True
    if angle_deg is None:
        return
    if hasattr(me, "use_auto_smooth"):           # <= 4.0
        me.use_auto_smooth = True
        me.auto_smooth_angle = angle_deg * 3.141592653589793 / 180.0
        return
    if hasattr(bpy.ops.object, "shade_smooth_by_angle"):   # >= 4.1
        prev = bpy.context.view_layer.objects.active
        try:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.shade_smooth_by_angle(angle=angle_deg * 3.141592653589793 / 180.0)
            obj.select_set(False)
        except Exception as exc:                  # pragma: no cover
            print("  [compat] shade_smooth_by_angle failed: %s" % exc)
        finally:
            bpy.context.view_layer.objects.active = prev


def action_fcurves(action):
    """Every F-curve in an action, on 4.0-4.3 and on 4.4+.

    SLOTTED ACTIONS. Up to 4.3 an Action owned `.fcurves` directly. From 4.4
    (and so on 5.x) an Action is layered: layers -> strips -> channelbags ->
    fcurves, and `.fcurves` is gone. Measured here on 5.2.1:

        AttributeError: 'Action' object has no attribute 'fcurves'

    which is raised the moment you try to set interpolation on a keyframe, i.e.
    after the animation is already built and looks fine. Anything that touches
    curves after keyframe_insert has to go through this.
    """
    if action is None:
        return []
    if hasattr(action, "fcurves"):                      # <= 4.3
        return list(action.fcurves)
    curves = []
    for layer in getattr(action, "layers", []):         # >= 4.4
        for strip in getattr(layer, "strips", []):
            bags = getattr(strip, "channelbags", None)
            if bags is None:
                continue
            for bag in bags:
                curves.extend(bag.fcurves)
    return curves


def set_interpolation(obj, mode="LINEAR"):
    """Force every keyframe on obj to one interpolation mode."""
    ad = getattr(obj, "animation_data", None)
    if not ad or not ad.action:
        return 0
    count = 0
    for fcurve in action_fcurves(ad.action):
        for kp in fcurve.keyframe_points:
            kp.interpolation = mode
            count += 1
    return count


def set_if(owner, attr, value):
    """Assign only when the property exists on this build. Used for the EEVEE
    settings that come and go between releases; returns whether it took."""
    if owner is not None and hasattr(owner, attr):
        try:
            setattr(owner, attr, value)
            return True
        except Exception as exc:
            print("  [compat] %s.%s = %r rejected: %s" % (owner, attr, value, exc))
    return False


def report():
    print("Blender %s · EEVEE id %r · Cycles %s"
          % (bpy.app.version_string, eevee_id(),
             "available" if cycles_available() else "MISSING"))
