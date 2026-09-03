"""GLB export, in the conventions docs/BLENDER.md already fixed.

    metres, +Y up, -Z forward (glTF); the game converts on load
    every prop's origin is at its BASE, on the ground, centred
    one root node per prop, named Prop_*
    no textures: flat baseColorFactor only

The last of those is not a limitation, it is the art direction: a texture here
would be a second art direction competing with the one in js/render.gl.js. So
export_image_format defaults to 'NONE' and materials still carry their base
colour, which is exactly what js/props.gl.js reads.

WHAT NOT TO EXPORT
------------------
99_UTILITY holds track targets and turntable pivots. They are excluded from the
view layer, which keeps them out of the file — use_visible below relies on
that, and it is why scene.set_excluded uses exclude rather than hide_render.
"""

import os

import bpy


def _select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        try:
            obj.select_set(True)
        except RuntimeError:
            pass                                    # excluded from the view layer
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def glb(filepath, objects=None, animations=False, textures=False, apply_modifiers=True):
    """Export to GLB. Pass `objects` to export a subset, or None for the
    visible scene."""
    path = os.path.abspath(filepath)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    kwargs = dict(
        filepath=path,
        export_format="GLB",
        export_apply=apply_modifiers,
        export_yup=True,
        export_animations=animations,
        export_skins=True,
        export_materials="EXPORT",
        export_image_format="AUTO" if textures else "NONE",
        export_cameras=False,
        export_lights=False,
    )
    if objects:
        _select(objects)
        kwargs["use_selection"] = True
    else:
        kwargs["use_visible"] = True

    # The exporter's signature has picked up and dropped keywords across 4.x.
    # Rather than pin a version, drop anything this build does not know about.
    accepted = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    unknown = [k for k in kwargs if k not in accepted]
    for key in unknown:
        print("  [export] this Blender has no %r — dropped" % key)
        kwargs.pop(key)

    bpy.ops.export_scene.gltf(**kwargs)
    size = os.path.getsize(path) if os.path.exists(path) else 0
    print("  exported %s (%.0f KB)" % (path, size / 1024.0))
    return path


def props(filepath, collection_name="04_PROPS"):
    """Just the Prop_* objects, which is what js/props.gl.js instances."""
    col = bpy.data.collections.get(collection_name)
    if not col:
        print("  [export] no collection %r" % collection_name)
        return None
    objects = [o for o in col.objects if o.name.startswith("Prop_")]
    if not objects:
        print("  [export] no Prop_* objects to export")
        return None
    print("  exporting %d props" % len(objects))
    return glb(filepath, objects=objects, textures=False)


def character(filepath, mesh_obj, armature_obj=None, animations=False):
    """One player plus its rig. export_skins carries the vertex groups, and the
    bone NAMES are what js/skin.gl.js maps by — run tools/blender/roundtrip.py
    against the result before trusting it."""
    objects = [o for o in (armature_obj, mesh_obj) if o]
    return glb(filepath, objects=objects, animations=animations, textures=False)


def verify(filepath):
    """Re-import what was just written and report it. docs/BLENDER.md makes the
    point that the roundtrip is the gate; this is the cheap half of it, and it
    catches an empty export — which is otherwise a 300-byte file that looks
    like a success."""
    if not os.path.exists(filepath):
        print("  [verify] %s does not exist" % filepath)
        return False
    before = set(bpy.data.objects.keys())
    try:
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(filepath))
    except Exception as exc:
        print("  [verify] re-import failed: %s" % exc)
        return False
    added = [bpy.data.objects[k] for k in bpy.data.objects.keys() if k not in before]
    meshes = [o for o in added if o.type == "MESH"]
    arms = [o for o in added if o.type == "ARMATURE"]
    tris = sum(sum(max(0, len(p.vertices) - 2) for p in o.data.polygons) for o in meshes)
    bones = sum(len(o.data.bones) for o in arms)
    print("  [verify] %d meshes, %d tris, %d armatures, %d bones"
          % (len(meshes), tris, len(arms), bones))
    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)
    return bool(meshes)
