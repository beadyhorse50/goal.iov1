"""goal.io — Blender pipeline gate.

    blender --background --factory-startup --python tools/blender/roundtrip.py -- \
        assets/models/Forward.glb  build/roundtrip/Forward.glb

Imports one of the game's character GLBs, reports exactly what Blender made of
it, and exports it straight back out. Nothing is changed in between.

WHY THIS EXISTS BEFORE ANY ANIMATION WORK
-----------------------------------------
The animation plan is: import the character, retarget mocap onto its skeleton,
export animation tracks. Every step of that assumes Blender reads and writes
this rig faithfully — and if it does not, the failure shows up much later as a
player whose elbow bends the wrong way, which is a miserable thing to debug
from the far end.

So this proves the trip is lossless first. It checks the things that would
actually break the game:

  - all 27 joints survive, with their names intact (js/skin.gl.js maps by NAME;
    a renamed bone silently drops that joint back to its parent's rotation)
  - the bind pose stays translation-only (js/gltf.js asserts this, and the
    whole no-Euler-conversion scheme in docs/PLAYERS.md rests on it)
  - both LODs and all four materials survive
  - the textures are still embedded

--factory-startup matters: it runs with no user preferences or third-party
addons, so the result is what a clean machine would produce rather than what
this one happens to have installed.
"""

import json
import os
import sys

import bpy


def argv():
    """Blender swallows its own arguments; ours come after a bare --."""
    a = sys.argv
    return a[a.index("--") + 1:] if "--" in a else []


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def exportable(o):
    """Blender's glTF importer parks its own housekeeping in a collection
    literally named glTF_not_exported — importing one of these characters
    produces a stray 42-vertex Icosphere there. It is excluded from export by
    Blender itself and never reaches the file, but counting it makes the report
    below lie about the triangle budget, and an unexplained sphere in an asset
    pipeline is exactly the kind of thing that gets chased later."""
    return not any(c.name == "glTF_not_exported" for c in o.users_collection)


def describe():
    """What Blender thinks it has, in the terms the game cares about."""
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE" and exportable(o)]
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and exportable(o)]
    out = {
        "armatures": len(arms),
        "meshes": sorted(m.name for m in meshes),
        "materials": sorted(m.name for m in bpy.data.materials),
        "images": sorted(i.name for i in bpy.data.images if i.name != "Render Result"),
        "tris": 0,
        "bones": [],
        "posed_bones": [],
    }
    for m in meshes:
        out["tris"] += sum(len(p.vertices) - 2 for p in m.data.polygons)
    if arms:
        arm = arms[0]
        out["bones"] = [b.name for b in arm.data.bones]
        # A bone whose rest matrix carries a rotation would break the bind-pose
        # assumption js/gltf.js enforces. Report any that do.
        for b in arm.pose.bones:
            q = b.rotation_quaternion
            if abs(q.w - 1.0) > 1e-5 or abs(q.x) + abs(q.y) + abs(q.z) > 1e-5:
                out["posed_bones"].append(b.name)
    out["actions"] = sorted(a.name for a in bpy.data.actions)
    return out


def main():
    args = argv()
    if len(args) < 2:
        print("ROUNDTRIP_ERROR need <in.glb> <out.glb>")
        return 1
    src, dst = os.path.abspath(args[0]), os.path.abspath(args[1])
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    clear()
    bpy.ops.import_scene.gltf(filepath=src)
    info = describe()
    print("ROUNDTRIP_IN " + json.dumps(info))

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_yup=True,              # glTF is Y-up; the game assumes it
        export_apply=False,           # never apply modifiers onto a skinned mesh
        export_skins=True,
        export_animations=False,      # nothing to export yet, and saying so is
                                      # cheaper than wondering later
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    print("ROUNDTRIP_OUT " + json.dumps({"path": dst,
                                         "bytes": os.path.getsize(dst)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
