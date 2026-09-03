"""The six conditions from config/conditions.json, as real Blender lighting.

All six rigs are BUILT and five are EXCLUDED. Switching condition is then one
call, not a rebuild — which is the whole point of generating them together, and
is what makes the lookdev sweep in build.py cheap.

THE MAPPING, AND WHY IT IS NOT ONE-TO-ONE
-----------------------------------------
The game's condition fields are renderer inputs for a hand-written shader, not
physical quantities. Translating them needs a decision per field:

  sunEl/sunAz  geometric, used directly. §4.3 calls elevation a STAGING
               parameter, and it is the one field that must not be touched:
               9 deg is what puts the roof lip's shadow on the grass.
  light        exposure. Drives sun strength and world strength together, so a
               dim condition dims the fill as well as the key.
  warm         colour temperature, as a lerp between a cool and a warm white.
  flood        the blend between sun-as-key and pylons-as-key. §4.3: above 0.55
               the pylons ARE the key and the sun is fill, so sun strength
               falls off with flood rather than being independent of it.
  wet          NOT lighting. It is a material property and it is handled in
               materials.turf(); §4.3 is explicit that wet must never tint.
  haze         a world volume, off by default — see build_haze().
  rain         not built. Rain streaks are a particle and compositing job, and
               faking them in the world volume looks like dirt on the lens.
"""

import math

import bpy
from mathutils import Vector

from . import compat, scene, style

SUN_BASE = 5.0          # W/m^2 for a clear day at light=1, flood=0
FLOOD_BASE = 900000.0   # W per pylon head at flood=1; they are 27 m up
WORLD_BASE = 1.0

COOL = "#bcd2ff"
WARM = "#ffc078"   # tempered: #ffab42 turned white line paint tan


def sun_vector(el_deg, az_deg):
    """Direction TOWARDS the sun.

    THIS IS NOT THE COMPASS CONVENTION. js/core.js:102 is explicit: sunAz is
    "the compass bearing measured from +X toward +Y", so azimuth 0 is +X and
    90 is +Y. Reading it as compass-from-north instead rotates every
    condition by 90 degrees, which puts golden hour's sun out to the side
    rather than behind the camera - and the entire hero effect depends on it
    being behind.

    The check: goldenHour is az 105, giving (-0.26, +0.95) - behind a camera
    that stands at y = +20 looking toward -Y. js/core.js says exactly that:
    "the sun has to sit behind the camera and low".
    """
    el, az = math.radians(el_deg), math.radians(az_deg)
    return Vector((math.cos(el) * math.cos(az),
                   math.cos(el) * math.sin(az),
                   math.sin(el)))


def _lerp_hex(a, b, t):
    ca, cb = compat.hex_rgba(a), compat.hex_rgba(b)
    return tuple(ca[i] + (cb[i] - ca[i]) * t for i in range(4))


def build_sun(collection, cond, name="LGT_Sun"):
    """A sun lamp pointed by elevation and azimuth.

    A sun lamp emits along its local -Z. to_track_quat('Z','Y') aims local +Z
    at the sun, so -Z points the way the light actually travels. Getting this
    backwards lights the scene from underground and is not obvious in a
    preview, because the ambient probe still fills everything.
    """
    data = bpy.data.lights.new(name, type="SUN")
    data.energy = SUN_BASE * cond["light"] * (1.0 - cond["flood"]) ** 0.6
    data.color = _lerp_hex(COOL, WARM, cond["warm"])[:3]
    # Angular diameter. A hard sun at 0.526 deg is right for a clear day; an
    # overcast key has no defined edge, so the shadow softens with flood.
    data.angle = math.radians(0.526 + 6.0 * min(1.0, cond["flood"] + cond["haze"] - 1.0))

    obj = bpy.data.objects.new(name, data)
    direction = sun_vector(cond["sunEl"], cond["sunAz"])
    obj.location = direction * 120.0
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    scene.put(obj, collection)
    return obj


def build_sky(cond):
    """A three-stop sky, straight from the condition's own ramp.

    §4.3: no fog colour is authored separately — haze pulls distant geometry
    toward the sky's HORIZON colour, which is why the ramp has three stops and
    why they are used in that order.
    """
    world = bpy.data.worlds.get("GOALIO_Sky") or bpy.data.worlds.new("GOALIO_Sky")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (400, 0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (200, 0)
    bg.inputs["Strength"].default_value = (
        WORLD_BASE * cond["light"] * (1.0 - 0.72 * cond["flood"]))
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    tex = nt.nodes.new("ShaderNodeTexCoord")
    tex.location = (-620, 0)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-440, 0)
    nt.links.new(tex.outputs["Generated"], sep.inputs["Vector"])

    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.location = (-260, 0)
    rng.inputs["From Min"].default_value = -1.0
    rng.inputs["From Max"].default_value = 1.0
    nt.links.new(sep.outputs["Z"], rng.inputs["Value"])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-60, 0)
    zenith, mid, horizon = cond["sky"]
    ramp.color_ramp.elements[0].position = 0.40
    ramp.color_ramp.elements[0].color = compat.hex_rgba(horizon)
    ramp.color_ramp.elements[1].position = 1.00
    ramp.color_ramp.elements[1].color = compat.hex_rgba(zenith)
    middle = ramp.color_ramp.elements.new(0.62)
    middle.color = compat.hex_rgba(mid)
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    return world


def build_floodlights(collection, cond, back_out=None, back_z=None):
    """Four pylon heads as area lights, at the corners of the bowl.

    Placed from the bowl's own footprint, so they move when the pitch does.
    §4.3: above flood 0.55 these ARE the key light and the grade should follow
    — cooler shadows, harder falloff.
    """
    if cond["flood"] <= 0.02:
        return []
    made = []
    hx = style.BOWL["hx"] * 0.92
    hy = style.BOWL["hy"] * 0.92
    height = 27.4
    for sx in (-1, 1):
        for sy in (-1, 1):
            data = bpy.data.lights.new("LGT_Flood", type="AREA")
            data.shape = "RECTANGLE"
            data.size, data.size_y = 5.2, 2.4
            data.energy = FLOOD_BASE * cond["flood"]
            data.color = compat.hex_rgba("#eaf2ff")[:3]
            obj = bpy.data.objects.new("LGT_Flood_%s%s"
                                       % ("P" if sx > 0 else "M",
                                          "P" if sy > 0 else "M"), data)
            obj.location = (sx * hx, sy * hy, height)
            aim = Vector((0.0, 0.0, 0.0)) - Vector(obj.location)
            obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()
            scene.put(obj, collection)
            made.append(obj)
    return made


def build_haze(cond, enabled=False):
    """§4.3 — haze does the depth work.

    OFF BY DEFAULT, deliberately. A world volume is the physically right answer
    and it is also the most expensive thing in the file: it makes every EEVEE
    frame several times slower and every Cycles frame worse per sample. The
    guide's haze is a screen-space falloff in js/post.gl.js, not a volume, so
    matching it exactly is a compositing job. Turn this on for a hero still,
    leave it off for a lookdev sweep.
    """
    if not enabled:
        return None
    world = bpy.context.scene.world
    nt = world.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_WORLD"), None)
    if not out:
        return None
    scatter = nt.nodes.new("ShaderNodeVolumeScatter")
    scatter.location = (200, -220)
    scatter.inputs["Density"].default_value = 0.0016 * cond["haze"]
    scatter.inputs["Color"].default_value = compat.hex_rgba(cond["sky"][2])
    nt.links.new(scatter.outputs["Volume"], out.inputs["Volume"])
    return scatter


# --------------------------------------------------------------------------
# rigs
# --------------------------------------------------------------------------

def build_all(parent="01_LIGHTING", active=None, haze=False):
    """Build all six conditions as sibling collections, enable one.

    Returns {name: collection}. The active one is whatever HERO_CONDITION says
    unless overridden, because §4.3 makes golden hour the hero and a lookdev
    that opens on a flat 40-degree afternoon is a lookdev nobody looks at.
    """
    active = active or style.HERO_CONDITION
    if active not in style.CONDITIONS:
        print("  [lighting] unknown condition %r, falling back to %s"
              % (active, style.HERO_CONDITION))
        active = style.HERO_CONDITION

    rigs = {}
    for name, cond in style.CONDITIONS.items():
        col = scene.sub(parent, "LGT_%s" % name, "COLOR_03")
        build_sun(col, cond, "LGT_Sun_%s" % name)
        build_floodlights(col, cond)
        rigs[name] = col

    for name in rigs:
        scene.set_excluded("LGT_%s" % name, name != active)

    cond = style.CONDITIONS[active]
    build_sky(cond)
    build_haze(cond, haze)

    print("  lighting: %d rigs built, active = %s (sun %.0f deg / %.0f deg, "
          "flood %.2f, warm %.2f)"
          % (len(rigs), active, cond["sunEl"], cond["sunAz"],
             cond["flood"], cond["warm"]))
    report_shadow(active)
    return rigs


def report_shadow(name):
    """Where the roof lip's shadow edge actually lands, in pitch metres.

    Section 4.3 makes this THE staging decision, and js/core.js:121 claims 9
    degrees puts the edge "at about y = -35". Worth measuring rather than
    believing: the answer depends on roofLift, roofOver and the bowl
    footprint, three numbers anyone could change without thinking about the
    shadow at all.
    """
    cond = style.CONDITIONS.get(name)
    if not cond or cond["sunEl"] <= 0.5:
        return None
    b = style.BOWL
    lip_y = b["hy"] + (b["rows"] * b["run"] - b["roofOver"])
    lip_z = b["base"] + b["rows"] * b["rise"] + b["roofLift"]
    reach = lip_z / math.tan(math.radians(cond["sunEl"]))
    d = sun_vector(cond["sunEl"], cond["sunAz"])
    flat = math.hypot(d.x, d.y) or 1e-6
    edge_y = lip_y - reach * (d.y / flat)
    hl = style.PITCH["halfL"]
    where = ("ACROSS the pitch at y=%.0f" % edge_y
             if -hl <= edge_y <= hl else "off the pitch (y=%.0f)" % edge_y)
    print("    roof-lip shadow: lip %.1f m at y=%.1f, reach %.0f m -> %s"
          % (lip_z, lip_y, reach, where))
    return edge_y


def activate(name, haze=False):
    """Switch condition on an already-built scene. One call per lookdev frame."""
    if name not in style.CONDITIONS:
        return False
    for other in style.CONDITIONS:
        scene.set_excluded("LGT_%s" % other, other != name)
    cond = style.CONDITIONS[name]
    build_sky(cond)
    build_haze(cond, haze)
    return True


def retint_turf(name):
    """The one place lighting touches a material: §4.3's wet sheen. Called
    alongside activate() so a wet condition actually looks wet."""
    from . import materials
    cond = style.CONDITIONS.get(name)
    if not cond:
        return
    for obj in bpy.data.objects:
        if obj.name == "PITCH_Turf":
            scene.assign(obj, materials.turf(wet=cond["wet"]))
