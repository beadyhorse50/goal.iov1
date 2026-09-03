"""Cameras: gameplay, replay, miss, orthographic sheets, turntable, key art.

THE GAMEPLAY CAMERA IS NOT A CREATIVE CHOICE HERE. §5.1 gives eye, target and
field of view, §5.2 locks the elevation to a 15-25 degree band, and this module
asserts the band rather than trusting itself. A camera that has drifted out of
it is the single change that would invalidate every other section of the guide,
so it fails loudly instead of rendering something plausible.

PORTRAIT IS THE WHOLE TRICK
---------------------------
The game runs a 390x844 logical viewport at 3x. §5.1: the camera is WIDE
VERTICALLY and LONG-LENS HORIZONTALLY — 50.3 degrees down the frame, 24.5
across it, about a 90 mm lens sideways. camera.angle applies to whichever axis
sensor_fit picks, and the default AUTO picks the LONGER one — in portrait the
vertical axis, so it happens to be right, and would silently become wrong the
moment somebody rendered a landscape still. It is set explicitly for that
reason.
"""

import math

import bpy
from mathutils import Vector

from . import compat, scene, style

C = style.CAMERA
SENSOR_H = 24.0         # mm; the lens below is derived from it, not typed


def _lens_for_fov(fov_rad, sensor=SENSOR_H):
    return (sensor * 0.5) / math.tan(fov_rad * 0.5)


def game_fov():
    """(vertical, horizontal) FOV in radians, derived the way the game derives
    it: from a fixed focal length in PIXELS over the reference viewport.

    js/render.gl.js:63 declares FOVY = 0.9 as a default and then overwrites it
    every frame with 2*atan((VP.h/2)/F). Reading the 0.9 literal instead gives
    51.6 deg vertical, which is 1.3 deg wider than the game actually renders --
    small, but it is the difference between a reference frame that matches the
    build and one that nearly does."""
    w, h = C["ref_res"]
    f = C["focal_px"]
    return (2 * math.atan((h * 0.5) / f), 2 * math.atan((w * 0.5) / f))


def _aim(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _new_camera(name, collection, lens=None, ortho=None):
    data = bpy.data.cameras.new(name)
    data.clip_start = C["near"]
    data.clip_end = C["far"]
    if ortho is not None:
        data.type = "ORTHO"
        data.ortho_scale = ortho
    else:
        data.sensor_fit = "VERTICAL"
        data.sensor_height = SENSOR_H
        data.lens = lens if lens else _lens_for_fov(game_fov()[0])
    obj = bpy.data.objects.new(name, data)
    scene.put(obj, collection)
    return obj


def elevation_of(eye, target):
    flat = math.hypot(target[0] - eye[0], target[1] - eye[1])
    return math.degrees(math.atan2(eye[2] - target[2], flat or 1e-6))


def build_gameplay(collection, make_active=True):
    """§5.1, verbatim. Eye (0, 20, 12), look-at (0, -10, 1)."""
    obj = _new_camera("CAM_Gameplay", collection)
    obj.location = C["eye"]
    _aim(obj, C["target"])

    el = elevation_of(C["eye"], C["target"])
    lo, hi = C["band"]
    fov_y, fov_x = game_fov()
    print("  CAM_Gameplay: %.1f deg elevation, %.2f mm, FOV %.1f v / %.1f h deg"
          % (el, obj.data.lens, math.degrees(fov_y), math.degrees(fov_x)))
    if not (lo <= el <= hi):
        # §5.2: below 15 the box markings collapse, above 25 it becomes a
        # top-down puzzle game. Neither looks broken in a single frame, which
        # is exactly why this shouts.
        raise ValueError(
            "gameplay camera elevation %.2f deg is outside the locked band "
            "%.0f-%.0f (style.CAMERA). This is an identity change, not a tweak."
            % (el, lo, hi))

    if make_active:
        bpy.context.scene.camera = obj
    return obj


def build_replay(collection, sign=-1):
    """§5.3 — low angle behind the near post. Derived from the goal, so it
    stays framed if config/pitch.json moves the goal line."""
    gh, hl = style.PITCH["goalHalf"], style.PITCH["halfL"]
    obj = _new_camera("CAM_Replay", collection, lens=_lens_for_fov(math.radians(62)))
    obj.location = (-gh - 5.2, sign * (hl + 5.0), 1.55)
    _aim(obj, (0.0, sign * (hl - 1.0), 1.10))
    return obj


def build_miss(collection, ball_end=(6.8, -52.0, 2.9), sign=-1):
    """§5.3 — frames the goal mouth AND the ball's end point together.

    SOLVED, not keyframed. The guide is explicit that nothing here is
    hand-placed because levels differ: the camera sits back along the bisector
    of the two subjects and pulls its distance from how far apart they are, so
    a 30 cm miss and a 4 m miss both fill the frame.
    """
    hl = style.PITCH["halfL"]
    goal = Vector((0.0, sign * hl, style.PITCH["crossbar"] * 0.5))
    ball = Vector(ball_end)
    mid = (goal + ball) * 0.5

    spread = max(2.5, (goal - ball).length)
    fov = math.radians(48)
    back = (spread * 1.6) / math.tan(fov * 0.5)

    obj = _new_camera("CAM_Miss", collection, lens=_lens_for_fov(fov))
    obj.location = (mid.x * 0.35, mid.y - sign * back, mid.z + spread * 0.42 + 1.4)
    _aim(obj, mid)
    print("  CAM_Miss: subjects %.2f m apart, camera %.1f m back" % (spread, back))
    return obj


def build_keyart(collection):
    """§8.1 — the master key art framing: behind and above the striker, long
    lens, the roof line just entering the top of frame."""
    obj = _new_camera("CAM_KeyArt", collection, lens=_lens_for_fov(math.radians(38)))
    obj.location = (4.2, -14.0, 3.4)
    _aim(obj, (0.0, -46.0, 1.6))
    return obj


# --------------------------------------------------------------------------
# character sheets
# --------------------------------------------------------------------------

SHEET_VIEWS = {
    "Front": (0.0, -4.0, 0.90),
    "Back":  (0.0, 4.0, 0.90),
    "Side":  (4.0, 0.0, 0.90),
    "Three": (2.9, -2.9, 0.90),
}


def build_sheets(collection, height=None, margin=1.22):
    """§8.2 — orthographic views for a modelling reference.

    ORTHOGRAPHIC MATTERS. The prompt in §8.2 asks for 'no perspective
    distortion' because a reference sheet with perspective cannot be traced
    against: the far shoulder is smaller than the near one and every
    measurement taken off it is wrong. ortho_scale is derived from the figure's
    own height so the framing is identical in all four views.
    """
    height = height or style.FIGURE["crown"]
    made = {}
    for name, pos in SHEET_VIEWS.items():
        obj = _new_camera("CAM_Sheet_%s" % name, collection,
                          ortho=height * margin)
        obj.location = pos
        _aim(obj, (0.0, 0.0, height * 0.5))
        made[name] = obj
    print("  sheets: 4 orthographic cameras, ortho_scale %.2f m"
          % (height * margin))
    return made


# --------------------------------------------------------------------------
# turntable
# --------------------------------------------------------------------------

def build_turntable(collection, util, subject=(0.0, 0.0, 0.9), radius=3.6,
                    height=1.5, frames=120):
    """A camera on a pivot, one full revolution over `frames`.

    The camera is PARENTED to an empty and the empty is animated, rather than
    animating the camera on a circle. Two reasons: the aim stays exact for free
    via a Track To constraint, and a turntable that is one animated value is a
    turntable somebody can re-time without touching a curve.
    """
    pivot = scene.empty("UTIL_TurntablePivot", subject, util, "SPHERE", 0.25)
    target = scene.empty("UTIL_TurntableTarget", subject, util, "PLAIN_AXES", 0.2)

    obj = _new_camera("CAM_Turntable", collection, lens=_lens_for_fov(math.radians(34)))
    obj.location = (0.0, -radius, height)
    obj.parent = pivot

    con = obj.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"

    pivot.rotation_euler = (0.0, 0.0, 0.0)
    pivot.keyframe_insert("rotation_euler", frame=1)
    pivot.rotation_euler = (0.0, 0.0, math.tau)
    pivot.keyframe_insert("rotation_euler", frame=frames)
    # LINEAR or the turntable eases at both ends and stutters on loop.
    # Action.fcurves is gone from 4.4 on — see compat.action_fcurves.
    compat.set_interpolation(pivot, "LINEAR")

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = frames
    print("  turntable: %d frames, radius %.1f m" % (frames, radius))
    return obj, pivot


def build_all(collection, util):
    """Every camera, with gameplay active."""
    made = {
        "gameplay": build_gameplay(collection),
        "replay": build_replay(collection),
        "miss": build_miss(collection),
        "keyart": build_keyart(collection),
    }
    made["sheets"] = build_sheets(collection)
    made["turntable"], made["pivot"] = build_turntable(collection, util)
    return made


def activate(name):
    obj = bpy.data.objects.get(name)
    if obj and obj.type == "CAMERA":
        bpy.context.scene.camera = obj
        return obj
    print("  [cameras] no camera named %r" % name)
    return None
