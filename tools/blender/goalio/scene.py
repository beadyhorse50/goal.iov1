"""The collection tree, and the reset that starts every build.

WHY THE TREE IS NUMBERED
------------------------
Blender sorts collections alphabetically in the outliner and offers no way to
reorder them. A numeric prefix is the only way to make the outliner read in
build order rather than in alphabetical order, and build order is the order
somebody debugging this will want.

WHY 99_UTILITY IS EXCLUDED
--------------------------
Track targets, path curves and measurement empties must not reach a render or
an export. Excluding the layer collection (rather than just hiding it) is the
form that survives both: hide_viewport is ignored by the renderer, and
hide_render is ignored by the glTF exporter, so neither alone is enough.
"""

import bpy

# name -> (colour tag, exclude from view layer)
TREE = {
    "00_CAMERAS":    ("COLOR_05", False),
    "01_LIGHTING":   ("COLOR_03", False),
    "02_PITCH":      ("COLOR_04", False),
    "03_STADIUM":    ("COLOR_06", False),
    "04_PROPS":      ("COLOR_02", False),
    "05_CHARACTERS": ("COLOR_01", False),
    "99_UTILITY":    ("COLOR_08", True),
}

ROOT_NAME = "GOALIO"


def reset():
    """Factory settings with nothing in the file, then purge the datablocks
    read_factory_settings leaves behind. Without the second half a rebuild in
    the same session accumulates 'Material.001', 'Material.002' and the
    material lookups in materials.py start finding the wrong one."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                  bpy.data.armatures, bpy.data.cameras, bpy.data.lights,
                  bpy.data.curves, bpy.data.images, bpy.data.node_groups,
                  bpy.data.worlds, bpy.data.collections, bpy.data.actions):
        for item in list(block):
            try:
                block.remove(item)
            except Exception:
                pass


def units():
    """Metres, and a scale of 1. The rig is authored in metres and the bowl is
    derived from the pitch in metres; a unit scale of anything else silently
    rescales every export."""
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"


def _layer_collection(name, layer=None):
    """Depth-first search for a LayerCollection by name. There is no direct
    lookup for this in the API and the recursion is the documented way."""
    layer = layer or bpy.context.view_layer.layer_collection
    if layer.collection.name == name:
        return layer
    for child in layer.children:
        found = _layer_collection(name, child)
        if found:
            return found
    return None


def build_tree():
    """Create GOALIO and its children, return {name: Collection}."""
    scene = bpy.context.scene
    root = bpy.data.collections.get(ROOT_NAME) or bpy.data.collections.new(ROOT_NAME)
    if root.name not in {c.name for c in scene.collection.children}:
        scene.collection.children.link(root)

    made = {ROOT_NAME: root}
    for name, (tag, exclude) in TREE.items():
        col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
        if col.name not in {c.name for c in root.children}:
            root.children.link(col)
        col.color_tag = tag
        made[name] = col
        if exclude:
            lc = _layer_collection(name)
            if lc:
                lc.exclude = True
    return made


def set_excluded(name, excluded):
    """Toggle a collection in the view layer. This is the switch the six
    lighting rigs hang off: build all of them, exclude five. exclude is the
    only flag that keeps a collection out of BOTH the render and the glTF
    export — hide_viewport is ignored by the renderer and hide_render is
    ignored by the exporter, so neither alone is enough."""
    lc = _layer_collection(name)
    if lc:
        lc.exclude = excluded
        return True
    return False


def sub(parent_name, name, tag=None):
    """A child collection under one of the numbered groups. Used for the six
    lighting rigs and for per-kit character groups, so a whole condition can be
    toggled with one checkbox."""
    parent = bpy.data.collections.get(parent_name)
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if parent and col.name not in {c.name for c in parent.children}:
        parent.children.link(col)
    if tag:
        col.color_tag = tag
    return col


def put(obj, collection):
    """Link obj into exactly one collection. Blender links new objects into the
    active collection by default and leaves them there as well as wherever you
    put them, which is how objects end up rendering twice."""
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def new_mesh_object(name, verts, faces, collection, smooth=False, smooth_angle=None):
    """Mesh from pydata, linked, optionally smoothed. from_pydata does no
    validation, so validate() runs after — a mesh with a degenerate face
    renders as a black wedge and gives no other clue."""
    from . import compat
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()
    obj = bpy.data.objects.new(name, me)
    put(obj, collection)
    if smooth:
        compat.shade_smooth(obj, smooth_angle)
    return obj


def empty(name, location, collection, kind="PLAIN_AXES", size=0.4):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = kind
    obj.empty_display_size = size
    obj.location = location
    put(obj, collection)
    return obj


def assign(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def dimensions(obj):
    """docs/BLENDER.md: 'Print your dimensions.' The dugout that came out
    1.67 m instead of 2.26 m was caught by exactly this and nothing else."""
    bpy.context.view_layer.update()
    d = obj.dimensions
    return (round(d.x, 3), round(d.y, 3), round(d.z, 3))


def report(objects):
    print("  built %d objects" % len(objects))
    for obj in objects:
        tris = 0
        if obj.type == "MESH":
            tris = sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons)
        print("    %-26s %-6s %8s tris   dims %s"
              % (obj.name, obj.type.lower(), tris or "-", dimensions(obj)))
