"""goal.io — build the whole art bible as Blender assets.

    BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"

    "$BL" --background --factory-startup --python tools/blender/build.py -- all
    "$BL" --background --factory-startup --python tools/blender/build.py -- \
          lookdev --render --engine eevee
    "$BL" --background --factory-startup --python tools/blender/build.py -- \
          sheets --render
    "$BL" --background --factory-startup --python tools/blender/build.py -- \
          stadium --two-tier --condition goldenHour --render

--factory-startup is not optional, for the reason docs/BLENDER.md gives: no
user preferences and no third-party addons, so the output is what a clean
machine produces rather than what this one happens to have installed.

TARGETS
    scene       collections, cameras, lighting rigs. Nothing else. Fast.
    pitch       turf, markings, both goals, the ball
    stadium     pitch + bowl + hoardings + crowd + props
    player      one squad of four, built to the locked ratios
    all         everything, saved as a .blend
    lookdev     all six lighting conditions, one frame each
    sheets      the four orthographic character views from §8.2
    turntable   a 120-frame revolution of one player
    keyart      the §8.1 hero frame, and the ONLY thing graded through AgX
    export      GLB out (props, and the character)
    check       build nothing, print what the style guide resolves to
"""

import argparse
import os
import sys

# Blender does not put the script's own folder on sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy                                                      # noqa: E402

from goalio import (cameras, compat, export, lighting,          # noqa: E402
                    materials, player, render, scene, stadium, style)


def argv():
    """Blender swallows its own arguments; ours come after a bare --."""
    a = sys.argv
    return a[a.index("--") + 1:] if "--" in a else []


def parse():
    p = argparse.ArgumentParser(prog="build.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("target", nargs="?", default="all",
                   choices=["scene", "pitch", "stadium", "player", "all",
                            "lookdev", "sheets", "turntable", "keyart",
                            "export", "check"])
    p.add_argument("--condition", default=style.HERO_CONDITION,
                   help="lighting preset (default: the hero, goldenHour)")
    p.add_argument("--engine", default="eevee", choices=["eevee", "cycles"])
    p.add_argument("--samples", type=int, default=None)
    p.add_argument("--crowd", type=int, default=style.CROWD_DEFAULT,
                   help="spectators to build; 0 skips the crowd entirely")
    p.add_argument("--two-tier", action="store_true",
                   help="build the §3.5 TARGET bowl instead of the live one")
    p.add_argument("--haze", action="store_true",
                   help="world volume for §4.3 haze. Slow; off by default")
    p.add_argument("--render", action="store_true")
    p.add_argument("--no-save", action="store_true")
    p.add_argument("--out", default=None, help="output directory")
    p.add_argument("--frames", type=int, default=120)
    return p.parse_args(argv())


def out_dir(args, *parts):
    root = args.out or (os.path.join(style.ROOT, "build", "blender")
                        if style.ROOT else os.path.abspath("build/blender"))
    return os.path.join(root, *parts)


# --------------------------------------------------------------------------
# builders
# --------------------------------------------------------------------------

def build_scene(args):
    """Collections, cameras and all six lighting rigs. The base every other
    target starts from."""
    scene.reset()
    scene.units()
    materials.clear_cache()
    cols = scene.build_tree()
    print("collections: %s" % ", ".join(sorted(scene.TREE)))

    lighting.build_all("01_LIGHTING", active=args.condition, haze=args.haze)
    cameras.build_all(cols["00_CAMERAS"], cols["99_UTILITY"])
    return cols


def build_pitch(args, cols):
    cond = style.CONDITIONS.get(args.condition, {})
    made = [stadium.build_turf(cols["02_PITCH"], wet=cond.get("wet", 0.0)),
            stadium.build_markings(cols["02_PITCH"])]
    for sign in (1, -1):
        goal, net = stadium.build_goal(cols["02_PITCH"], sign=sign)
        made.extend([goal, net])
    made.append(stadium.build_ball(cols["02_PITCH"]))
    return made


def build_stadium(args, cols):
    made = build_pitch(args, cols)
    bowl, _out, _back, _roof = stadium.build_bowl(cols["03_STADIUM"],
                                                 two_tier=args.two_tier)
    made.extend(bowl)
    made.append(stadium.build_hoardings(cols["03_STADIUM"]))
    if args.crowd > 0:
        crowd = stadium.build_crowd(cols["03_STADIUM"], count=args.crowd)
        if crowd:
            made.append(crowd)
    else:
        print("  crowd: skipped (--crowd 0)")
    made.extend(stadium.build_props(cols["04_PROPS"]))
    return made


def build_players(args, cols):
    return player.build_squad(cols["05_CHARACTERS"], count=4)


# --------------------------------------------------------------------------
# render targets
# --------------------------------------------------------------------------

def do_lookdev(args, cols):
    """One frame per condition, from the gameplay camera. §4.2 is a table; this
    is the same table as pictures, which is the only way to actually judge it."""
    cameras.activate("CAM_Gameplay")
    render.setup("lookdev", args.engine, hero=False)
    for name in style.CONDITIONS:
        lighting.activate(name, haze=args.haze)
        lighting.retint_turf(name)
        render.still(out_dir(args, "lookdev", "%s.png" % name))


def do_sheets(args, cols):
    """§8.2 — four orthographic views on a transparent field."""
    render.setup("sheet", args.engine, hero=False)
    subject = bpy.data.objects.get("CHR_Player_01")
    rig = bpy.data.objects.get("RIG_CHR_Player_01")
    if rig:
        player.apply_apose(rig)
    if subject:
        # centre the sheet subject; the squad is laid out in a row
        for obj in bpy.data.objects:
            if obj.name.startswith(("CHR_Player_", "RIG_CHR_Player_")):
                obj.hide_render = not obj.name.endswith("01")
        (rig or subject).location = (0.0, 0.0, 0.0)
    for name in cameras.SHEET_VIEWS:
        cameras.activate("CAM_Sheet_%s" % name)
        render.still(out_dir(args, "sheets", "player_%s.png" % name.lower()))


def do_turntable(args, cols):
    cameras.activate("CAM_Turntable")
    render.setup("turntable", args.engine, hero=False)
    bpy.context.scene.frame_end = args.frames
    render.animation(out_dir(args, "turntable"), "player_")


def do_keyart(args, cols):
    """§8.1. The only target that grades through AgX — see render.hero_grade."""
    cameras.activate("CAM_KeyArt")
    render.setup("keyart", args.engine, hero=True)
    render.hero_grade()
    render.still(out_dir(args, "keyart", "goalio_keyart.png"))


def do_export(args, cols):
    export.props(out_dir(args, "export", "stadium_props_blender.glb"))
    mesh = bpy.data.objects.get("CHR_Player_01")
    rig = bpy.data.objects.get("RIG_CHR_Player_01")
    if mesh:
        path = out_dir(args, "export", "player_reference.glb")
        export.character(path, mesh, rig)
        export.verify(path)


def do_check(args):
    """Resolve the style guide and print it. Builds nothing, so it is the
    fastest way to see whether config/*.json is being read at all."""
    compat.report()
    style.summary()
    print("  config root: %s" % (style.ROOT or "NOT FOUND — using defaults"))
    print("  conditions:  %s" % ", ".join(style.CONDITIONS))
    print("  rig:         %d bones" % len(style.RIG))
    print("  kits:        %s" % ", ".join(style.KITS))
    el = style.elevation_deg()
    lo, hi = style.CAMERA["band"]
    print("  camera:      %.2f deg elevation %s band %.0f-%.0f"
          % (el, "INSIDE" if lo <= el <= hi else "*** OUTSIDE ***", lo, hi))


# --------------------------------------------------------------------------

def main():
    args = parse()
    compat.report()
    style.summary()

    if args.target == "check":
        do_check(args)
        return

    cols = build_scene(args)

    # Baseline render settings BEFORE the target dispatch, so a saved .blend
    # opens correct even when nothing was rendered. Without this the file
    # inherits Blender's defaults — AgX and 1920x1080 landscape — and §4.1 is
    # explicit that a full filmic tonemap misrepresents this palette. Somebody
    # opening the .blend to check a colour would read the wrong one.
    # Targets that render override this themselves (keyart -> hero grade).
    render.setup("gameplay", args.engine, hero=False)

    made = []

    if args.target in ("pitch",):
        made = build_pitch(args, cols)
    elif args.target in ("stadium", "lookdev", "keyart"):
        made = build_stadium(args, cols)
    elif args.target == "player":
        made = build_players(args, cols)
    elif args.target in ("sheets", "turntable"):
        made = build_players(args, cols)
    elif args.target in ("all", "export"):
        made = build_stadium(args, cols)
        made.extend(build_players(args, cols))
        # stand the squad on the edge of the box rather than on the centre spot
        for i, obj in enumerate(bpy.data.objects):
            if obj.name.startswith("RIG_CHR_Player_"):
                obj.location = ((i % 4 - 1.5) * 1.6, -34.0, 0.0)

    if made:
        scene.report(made)

    if args.target == "lookdev":
        do_lookdev(args, cols)
    elif args.target == "sheets":
        do_sheets(args, cols)
    elif args.target == "turntable":
        do_turntable(args, cols)
    elif args.target == "keyart":
        do_keyart(args, cols)
    elif args.target == "export":
        do_export(args, cols)
    elif args.render:
        cameras.activate("CAM_Gameplay")
        render.setup("gameplay", args.engine, hero=False)
        render.still(out_dir(args, "%s.png" % args.target))

    if not args.no_save:
        render.save_blend(out_dir(args, "goalio_%s.blend" % args.target))

    print("done: %s" % args.target)


if __name__ == "__main__":
    main()
