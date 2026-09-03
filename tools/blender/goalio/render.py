"""Engine, sampling, colour management and output.

THE ONE SETTING THAT MATTERS MOST IS view_transform
---------------------------------------------------
§4.1 carries a trap from docs/WEBGL.md: "do not run a full filmic tonemap over
a display-referred scene. Compress the top ~20% with a highlight shoulder and
leave the rest alone."

Blender's default view transform is AgX, which is a full filmic tonemap. Render
the palette through it and every colour in the guide comes out desaturated and
lifted — #d8324a stops being the home shirt, the turf loses the value
separation the mow stripes depend on, and a swatch pulled from the render will
not match the swatch in the game. That is not a look, it is a mismatch.

So:

    'Standard'  for anything that must MATCH the game — lookdev, character
                sheets, colour checks, texture reference. This is the default
                here, against Blender's own default, on purpose.

    'AgX'       for the §8.1 hero key art only, where the frame is a
                photograph of the game rather than a reading of it, and the
                highlight rolloff is wanted.

hero_grade() is the only thing in this package that turns AgX on, and it says
so in its name.
"""

import os

import bpy

from . import compat, style

PRESETS = {
    # name          resolution      samples  transparent
    "gameplay":   (style.CAMERA["res"], 96,  False),
    "sheet":      ((2048, 2048),        128, True),
    "turntable":  ((1280, 1280),        48,  True),
    "lookdev":    ((1280, 2772),        64,  False),
    "keyart":     ((2160, 4680),        256, False),
    "draft":      ((540, 1170),         16,  False),
}


def engine(name="eevee", samples=None):
    """Set the engine and its sampling. Handles the 4.x/5.x EEVEE rename and
    every EEVEE property that has come and gone between releases."""
    scene = bpy.context.scene
    # set_engine assigns and reports what actually took. resolve_engine
    # asks the static enum, which does not list add-on engines like Cycles.
    engine_id = compat.set_engine(name)

    if engine_id == "CYCLES":
        cyc = scene.cycles
        compat.set_if(cyc, "samples", samples or 128)
        compat.set_if(cyc, "preview_samples", 32)
        compat.set_if(cyc, "use_denoising", True)
        compat.set_if(cyc, "use_adaptive_sampling", True)
        compat.set_if(cyc, "adaptive_threshold", 0.01)
        compat.set_if(cyc, "max_bounces", 8)
        compat.set_if(cyc, "transparent_max_bounces", 12)  # the net is layered
        compat.set_if(cyc, "device", "CPU")
    else:
        ee = scene.eevee
        compat.set_if(ee, "taa_render_samples", samples or 64)
        compat.set_if(ee, "taa_samples", 16)
        compat.set_if(ee, "use_raytracing", True)          # 4.2+ EEVEE Next
        compat.set_if(ee, "use_shadows", True)
        compat.set_if(ee, "shadow_ray_count", 2)
        compat.set_if(ee, "shadow_step_count", 6)
        compat.set_if(ee, "use_gtao", True)                # <= 4.1 only
        compat.set_if(ee, "gtao_distance", 0.6)
        compat.set_if(ee, "use_bloom", False)              # <= 4.1; see below
        compat.set_if(ee, "use_volumetric_lights", True)

    print("  engine: %s, %s samples" % (engine_id, samples or "default"))
    return engine_id


def colour_management(hero=False):
    """§4.1. Standard by default; AgX only for the hero frame."""
    view = bpy.context.scene.view_settings
    view.view_transform = "AgX" if hero else "Standard"
    view.look = "AgX - Medium High Contrast" if hero else "None"
    view.exposure = 0.0
    view.gamma = 1.0
    bpy.context.scene.display_settings.display_device = "sRGB"
    print("  colour: view_transform=%s%s"
          % (view.view_transform,
             "  [HERO — do not sample palette from this]" if hero else
             "  [matches the game]"))


def hero_grade(exposure=0.0):
    """The §8.1 key art only. Named so it cannot be turned on by accident."""
    colour_management(hero=True)
    bpy.context.scene.view_settings.exposure = exposure


def output(preset="gameplay", filepath=None, transparent=None):
    scene = bpy.context.scene
    res, samples, clear = PRESETS.get(preset, PRESETS["gameplay"])
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = clear if transparent is None else transparent

    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGBA" if scene.render.film_transparent else "RGB"
    img.color_depth = "8"
    compat.set_if(img, "compression", 15)

    if filepath:
        scene.render.filepath = os.path.abspath(filepath)
    print("  output: %s  %dx%d  %s"
          % (preset, res[0], res[1],
             "transparent" if scene.render.film_transparent else "opaque"))
    return res, samples


def setup(preset="gameplay", engine_name="eevee", hero=False, filepath=None):
    """One call: engine, sampling, colour, resolution and output path."""
    _res, samples = output(preset, filepath)
    engine(engine_name, samples)
    colour_management(hero=hero)
    bpy.context.scene.render.use_persistent_data = True
    return samples


def still(filepath):
    """Render one frame. Blender appends nothing to a still's path, so the
    extension has to be here or the file lands with no extension at all."""
    path = os.path.abspath(filepath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    size = os.path.getsize(path) if os.path.exists(path) else 0
    print("  rendered %s (%.0f KB)" % (path, size / 1024.0))
    return path


def animation(directory, prefix="frame_"):
    """Render the frame range as a numbered sequence. Blender treats the
    filepath as a PREFIX for animations and appends ####.png itself, which is
    why this takes a directory and a prefix rather than a filename."""
    out = os.path.abspath(directory)
    os.makedirs(out, exist_ok=True)
    bpy.context.scene.render.filepath = os.path.join(out, prefix)
    bpy.ops.render.render(animation=True)
    frames = bpy.context.scene.frame_end - bpy.context.scene.frame_start + 1
    print("  rendered %d frames to %s" % (frames, out))
    return out


def save_blend(filepath):
    """Save the .blend so the scene can be opened and looked at. A build that
    only ever emits PNGs is a build nobody can art-direct."""
    path = os.path.abspath(filepath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    print("  saved %s (%.1f MB)" % (path, os.path.getsize(path) / 1048576.0))
    return path
