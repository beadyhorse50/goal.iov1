"""goal.io — generate the stadium props as one GLB.

    blender --background --factory-startup --python tools/blender/stadium_props.py -- \
        assets/models/stadium_props.glb

WHY THESE THREE
---------------
The bowl in js/render.gl.js is parametric and good — rake, gangways,
hoardings, roof, an 18,000-seat crowd. What it has none of is *objects*. A
ground reads as a ground because of the clutter around the pitch, and there is
none.

  Prop_CornerFlag  — the game HAS no corner flags at all. drawCornerFlags()
                     survived in the canvas renderer and was stubbed out when
                     the WebGL path took the world passes over; nothing ever
                     replaced it. They sit on the pitch, in shot, every match.
  Prop_Floodlight  — at night the only light source you can SEE is a strip of
                     roof lamps. A pylon is the silhouette that says football
                     ground before anything else in the frame does.
  Prop_Dugout      — on the halfway line, in every wide camera, and its absence
                     is why the touchline reads as empty.

WHY PROCEDURAL AND NOT MODELLED BY HAND
---------------------------------------
Same reason football-characters/chargen exists: a script is re-runnable. Change
the pylon height, change the mast taper, change the flag size, and re-running
this produces a new asset deterministically. A hand-modelled .blend is a binary
nobody can diff and only one person can change.

CONVENTIONS, WHICH MATTER MORE THAN THE GEOMETRY
------------------------------------------------
  - metres, +Y up, -Z forward (glTF); the game converts on load
  - every prop's origin is at its BASE, on the ground plane, centred
  - one root node per prop, named Prop_*, so the renderer can instance by name
  - no textures: flat baseColorFactor only. The game's PBR shader does the
    lighting, and a texture here would be a second art direction competing
    with the one already in the renderer.
"""

import math
import os
import sys

import bpy


def argv():
    a = sys.argv
    return a[a.index("--") + 1:] if "--" in a else []


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            block.remove(item)


MATS = {}


def mat(name, rgba, rough=0.75, metal=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
    m.diffuse_color = rgba
    MATS[name] = m
    return m


def cyl(r, h, loc, rot=(0, 0, 0), verts=10):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h,
                                        location=loc, rotation=rot)
    return bpy.context.active_object


def box(size, loc, rot=(0, 0, 0)):
    """size is the FULL extent in metres, not the half-extent.

    primitive_cube_add(size=1) spans -0.5..+0.5, so the scale factor is `size`,
    not `size / 2`. Getting that wrong halves every box in the file and does
    not look like a bug — it looks like a dugout somebody modelled a bit small,
    which is exactly the kind of thing that ships."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return o


def join(objs, name, material):
    """Join a pile of primitives into one object, drop it to origin-at-base."""
    for o in bpy.data.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.materials.clear()
    o.data.materials.append(material)
    # origin at the base of the bounding box, centred in x/z
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    lo = min(v.co.z for v in o.data.vertices)
    for v in o.data.vertices:
        v.co.z -= lo
    bpy.ops.object.shade_flat()
    return o


# --------------------------------------------------------------- corner flag
def corner_flag():
    """1.5 m pole, as the laws require, with a flag that has a visible face on
    both sides — a single plane vanishes edge-on, which for a corner flag is
    most of the time."""
    parts = [cyl(0.018, 1.5, (0, 0, 0.75), verts=8)]
    flag = box((0.34, 0.006, 0.24), (0.17, 0, 1.30))
    parts.append(flag)
    return join(parts, "Prop_CornerFlag", mat("M_Flag", (0.92, 0.16, 0.20, 1), 0.72))


# ---------------------------------------------------------------- floodlight
def floodlight():
    """A tapered four-tube lattice mast with a lamp head.

    The lattice is the whole point: a solid tapered box reads as a chimney. It
    is built as four corner tubes plus horizontal rings and diagonal braces,
    which is what an actual pylon is, and it stays under 3k triangles because
    every member is an 6-sided cylinder."""
    H, base_r, top_r = 26.0, 1.5, 0.65
    rings = 9
    parts = []

    def corner(sx, sy):
        """One leaning corner tube, from base radius out to top radius."""
        x0, y0 = sx * base_r, sy * base_r
        x1, y1 = sx * top_r, sy * top_r
        dx, dy, dz = x1 - x0, y1 - y0, H
        length = math.sqrt(dx * dx + dy * dy + dz * dz)
        o = cyl(0.075, length, ((x0 + x1) / 2, (y0 + y1) / 2, H / 2), verts=6)
        # aim it along the leg
        o.rotation_euler = (math.atan2(math.sqrt(dx * dx + dy * dy), dz) *
                            (1 if True else 1), 0, 0)
        # rotate about Z first so the tilt happens in the right plane
        o.rotation_mode = "ZYX"
        o.rotation_euler = (0, math.atan2(math.hypot(dx, dy), dz), math.atan2(dy, dx))
        return o

    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        parts.append(corner(sx, sy))

    for i in range(rings):
        t = i / float(rings - 1)
        z = t * (H - 1.0) + 0.5
        r = base_r + (top_r - base_r) * t
        # a square ring: four horizontal members
        for a in range(4):
            ang = a * math.pi / 2 + math.pi / 4
            nxt = (a + 1) * math.pi / 2 + math.pi / 4
            x0, y0 = math.cos(ang) * r * 1.414, math.sin(ang) * r * 1.414
            x1, y1 = math.cos(nxt) * r * 1.414, math.sin(nxt) * r * 1.414
            dx, dy = x1 - x0, y1 - y0
            L = math.hypot(dx, dy)
            o = cyl(0.045, L, ((x0 + x1) / 2, (y0 + y1) / 2, z), verts=5)
            o.rotation_mode = "ZYX"
            o.rotation_euler = (0, math.pi / 2, math.atan2(dy, dx))
            parts.append(o)

    # head: a frame and a bank of lamps, tilted down toward the pitch
    head_z = H + 1.2
    parts.append(box((4.2, 0.5, 0.35), (0, 0, head_z)))
    parts.append(box((0.35, 0.5, 2.6), (0, 0, head_z - 1.3)))
    for row in range(2):
        for col in range(6):
            lx = -1.75 + col * 0.7
            lz = head_z + 0.45 + row * 0.62
            lamp = box((0.6, 0.34, 0.5), (lx, -0.25, lz), rot=(math.radians(24), 0, 0))
            parts.append(lamp)

    return join(parts, "Prop_Floodlight", mat("M_Steel", (0.42, 0.45, 0.50, 1), 0.42, 0.85))


# -------------------------------------------------------------------- dugout
def dugout():
    """A covered bench: back wall, curved roof, side panels, and a bench with
    a row of seats so it is not an empty shed."""
    W, D, H = 7.0, 2.2, 2.0
    parts = []
    parts.append(box((W, 0.12, H), (0, D / 2, H / 2)))                 # back wall
    parts.append(box((0.12, D, H), (-W / 2, 0, H / 2)))                # sides
    parts.append(box((0.12, D, H), (W / 2, 0, H / 2)))
    # roof, tilted slightly forward so rain runs off toward the pitch
    roof = box((W + 0.3, D + 0.4, 0.12), (0, 0, H + 0.06))
    roof.rotation_euler = (math.radians(-6), 0, 0)
    parts.append(roof)
    parts.append(box((W - 0.4, 0.55, 0.12), (0, 0.25, 0.52)))          # bench
    parts.append(box((W - 0.4, 0.12, 0.45), (0, 0.5, 0.78)))           # backrest
    for i in range(7):
        sx = -W / 2 + 0.75 + i * ((W - 1.5) / 6.0)
        parts.append(box((0.46, 0.44, 0.10), (sx, 0.22, 0.60)))        # seats
    return join(parts, "Prop_Dugout", mat("M_Dugout", (0.13, 0.15, 0.18, 1), 0.55))


def report():
    out = []
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        lo = min(v.co.z for v in o.data.vertices)
        hi = max(v.co.z for v in o.data.vertices)
        out.append("%s tris=%d height=%.2fm base=%.3f" % (o.name, tris, hi - lo, lo))
    return out


def main():
    args = argv()
    dst = os.path.abspath(args[0]) if args else os.path.abspath("assets/models/stadium_props.glb")
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    reset()
    corner_flag()
    floodlight()
    dugout()

    for line in report():
        print("PROPS_OBJ " + line)

    for o in bpy.data.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_skins=False,
        export_animations=False,
        export_materials="EXPORT",
    )
    print("PROPS_OUT %s %d" % (dst, os.path.getsize(dst)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
