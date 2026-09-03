"""docs/ART-STYLE.md as data.

THE RULE FOR THIS FILE: where a number already lives in config/*.json, it is
READ, not restated. The game boots from those files; if Blender kept its own
copy, the two would drift and the first symptom would be a render that no
longer matches the build — which is a very expensive thing to notice late.

Only the values the game holds in JS literals (the rig, the bowl, the world
palette) are duplicated here, and each one names the file it was taken from so
a grep finds both halves.
"""

import json
import os

# --------------------------------------------------------------------------
# locating the repo
# --------------------------------------------------------------------------

def repo_root(start=None):
    """Walk up until we find config/pitch.json. Blender's cwd is wherever the
    user launched it, so nothing may be assumed about relative paths."""
    here = os.path.abspath(start or os.path.dirname(__file__))
    for _ in range(8):
        if os.path.isfile(os.path.join(here, "config", "pitch.json")):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return None


ROOT = repo_root()


def _load(name, fallback):
    """Read config/<name>. A missing or broken config gives the built-in
    defaults, exactly as js/config.js does for the game — a bad config must
    produce a build that runs on its defaults, not a build that does not run."""
    if ROOT:
        path = os.path.join(ROOT, "config", name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            print("  [style] %s" % os.path.relpath(path, ROOT))
            return data
        except Exception as exc:
            print("  [style] %s unreadable (%s) — using defaults" % (name, exc))
    return fallback


# --------------------------------------------------------------------------
# §3.2  pitch geometry — config/pitch.json
# --------------------------------------------------------------------------

PITCH = _load("pitch.json", {
    "halfW": 34, "halfL": 52.5, "goalHalf": 3.66, "crossbar": 2.44,
    "sixHalf": 9.16, "sixDepth": 5.5, "boxHalf": 20.16, "boxDepth": 16.5,
    "penSpot": 11, "arcR": 9.15, "centreR": 9.15, "cornerR": 1,
})

SURROUND = 6.0          # js/render.js:12 — grass outside the touchline
LINE_W = 0.12           # painted line width, metres


# --------------------------------------------------------------------------
# §4.2  lighting conditions — config/conditions.json
# --------------------------------------------------------------------------

_CONDITIONS = _load("conditions.json", {"presets": {}})
CONDITIONS = _CONDITIONS.get("presets", {})

if not CONDITIONS:      # the config is the source; this is the lifeboat
    CONDITIONS = {
        "afternoon":  {"light": 1.00, "warm": .55, "flood": .10, "wet": 0,
                       "rain": 0, "haze": 1.00, "sunEl": 40, "sunAz": 128,
                       "sky": ["#1f4f78", "#77b1cf", "#e2edee"]},
        "goldenHour": {"light": .96, "warm": 1.00, "flood": .25, "wet": 0,
                       "rain": 0, "haze": 1.25, "sunEl": 9, "sunAz": 105,
                       "sky": ["#243f6b", "#b3763f", "#f5cf9a"]},
        "overcast":   {"light": .88, "warm": .18, "flood": .30, "wet": .18,
                       "rain": 0, "haze": 1.45, "sunEl": 34, "sunAz": 142,
                       "sky": ["#43505c", "#7c8a94", "#c3ccd1"]},
        "rain":       {"light": .80, "warm": .10, "flood": .55, "wet": .72,
                       "rain": 1, "haze": 1.75, "sunEl": 27, "sunAz": 155,
                       "sky": ["#2e3944", "#5b6874", "#98a4ad"]},
        "night":      {"light": .66, "warm": .30, "flood": 1.0, "wet": .10,
                       "rain": 0, "haze": .85, "sunEl": 33, "sunAz": 205,
                       "sky": ["#070b14", "#0e1626", "#1d2a3c"]},
        "nightRain":  {"light": .62, "warm": .20, "flood": 1.0, "wet": .78,
                       "rain": 1, "haze": 1.30, "sunEl": 31, "sunAz": 212,
                       "sky": ["#060910", "#101a28", "#1f2c3a"]},
    }

HERO_CONDITION = "goldenHour"   # §4.3 — 9 deg puts the roof lip on the grass


# --------------------------------------------------------------------------
# §1  palette — js/render.js:26 (world) and config/ui.json (interface)
# --------------------------------------------------------------------------

_UI = _load("ui.json", {})
UI = _UI.get("palette", {
    "n900": "#050b16", "n700": "#0b1728", "b500": "#0090ff",
    "g400": "#ffc233", "ink": "#f2f7fc", "bad": "#ff4763", "good": "#25d97a",
})

WORLD = {
    "grass1": "#43a259", "grass2": "#2f7f45",
    "grass1Lit": "#51b166", "grass2Lit": "#388c4e",
    "line": "#f2f7fc",
    "concrete": "#20262e",
    "adBg": "#f4f7fa", "adFg": "#12305a",
    "postWhite": "#f4f7fa",
    "netWhite": "#dfe7ee",
}

KITS = {
    "home":   {"shirt": "#d8324a", "short": "#f0f4f8", "sock": "#d8324a"},
    "away":   {"shirt": "#5566d8", "short": "#2b3492", "sock": "#2b3492"},
    "keeper": {"shirt": "#25b596", "short": "#12705c", "sock": "#12705c"},
}

TRIM = "#f0f4f8"        # §1.4 — one-colour shirts, white trim. No hoops.

SKIN = ["#f0c9a4", "#dda87c", "#c08a5c", "#96613c", "#6d4227"]
HAIR = "#39291d"
BOOT = "#191c22"
BOOT_FLASH = ["#00e5a0", "#ff2e93", "#ffc233", "#38b0ff", "#f2f5f8", "#ff6a2b"]

CROWD = ["#d9ab80", "#f3ece1", "#c33b2e", "#8d5b3b", "#e7e0d3", "#6d4831",
         "#3a4170", "#d2603a", "#f5f5f5", "#a43c3c", "#e8c98a", "#4d4f57"]

# §1.6 roughness ladder. Not in the guide as numbers, but it is the same idea:
# the ball and the boots are the tightest highlights in frame, the turf the
# broadest, and everything else sits between.
ROUGH = {
    "turf": 0.92, "shirt": 0.78, "short": 0.76, "sock": 0.85,
    "skin": 0.58, "hair": 0.72, "boot": 0.34, "sole": 0.62,
    "post": 0.30, "net": 0.80, "concrete": 0.88, "seat": 0.62,
    "ball": 0.28, "ad": 0.42,
}


# --------------------------------------------------------------------------
# §2.1  the rig — js/anim.js:18, verbatim
# --------------------------------------------------------------------------
# name, parent, offset from parent in metres (x right, y forward, z up).
# 17 bones. Anything that needs an eighteenth is out of scope.

RIG = [
    ("pelvis", None,     (0, 0, 0.88)),
    ("spine",  "pelvis", (0, 0, 0.16)),
    ("chest",  "spine",  (0, 0, 0.28)),
    ("neck",   "chest",  (0, 0, 0.12)),
    ("head",   "neck",   (0, 0, 0.11)),
    ("shL",    "chest",  (-0.228, 0, 0.06)),
    ("elL",    "shL",    (0, 0, -0.26)),
    ("haL",    "elL",    (0, 0, -0.25)),
    ("shR",    "chest",  (0.228, 0, 0.06)),
    ("elR",    "shR",    (0, 0, -0.26)),
    ("haR",    "elR",    (0, 0, -0.25)),
    ("hipL",   "pelvis", (-0.095, 0, -0.06)),
    ("knL",    "hipL",   (0, 0, -0.42)),
    ("anL",    "knL",    (0, 0, -0.40)),
    ("hipR",   "pelvis", (0.095, 0, -0.06)),
    ("knR",    "hipR",   (0, 0, -0.42)),
    ("anR",    "knR",    (0, 0, -0.40)),
]

# §2.2 the locked ratios. Changing one of these is a redesign, not a tweak.
FIGURE = {
    "crown": 1.80,          # 7.2 heads at a 0.25 m head unit
    "head_unit": 0.25,
    "head_r": 0.115,        # skull radius; crown = head joint 1.55 + 2*r + a little
    "neck_r": 0.056,
    "chest_r": 0.150,       # half-depth at the chest
    "waist_r": 0.117,
    "hip_r": 0.132,
    "thigh_r": 0.086,
    "shin_r": 0.058,
    "arm_r": 0.049,
    "fore_r": 0.043,
    "hand_r": 0.057,        # §2.2 — 0.114 m across. Volume marker, not a hand
    "boot_r0": 0.074,       # tapered capsule, heel -> toe
    "boot_r1": 0.128,
    "shoulder_span": 0.456,
    "hip_span": 0.190,
}


def head_count():
    """Sanity check on the one ratio that defines the look."""
    return FIGURE["crown"] / FIGURE["head_unit"]


# --------------------------------------------------------------------------
# §3.2  the bowl — js/render.gl.js:1021
# --------------------------------------------------------------------------

BOWL = {
    "hx": PITCH["halfW"] + SURROUND + 2.4,      # 42.4
    "hy": PITCH["halfL"] + SURROUND + 2.4,      # 60.9
    "corner": 20.0,
    "K": 148,
    "rows": 26,
    "rise": 0.46,
    "run": 0.84,
    "base": 1.25,           # top of the perimeter wall = front row floor
    "roofLift": 3.6,
    "roofOver": 15.0,
    # §3.5 target: the GL bowl is one tier, the canvas one has two. Built here
    # because this is the asset that is supposed to lead the renderer.
    "tier2": True,
    "faciaZ": 7.0,
    "faciaH": 1.6,
    "tier2Rows": 14,
}


def rake_deg():
    import math
    return math.degrees(math.atan2(BOWL["rise"], BOWL["run"]))


# --------------------------------------------------------------------------
# §5.1  camera — js/render.js:16
# --------------------------------------------------------------------------

CAMERA = {
    "eye": (0.0, 20.0, 12.0),
    "target": (0.0, -10.0, 1.0),
    # The game holds a FIXED FOCAL LENGTH IN PIXELS and derives the FOV from
    # the viewport, so the FOV is derived here too (cameras.game_fov). The
    # FOVY = 0.9 literal in js/render.gl.js:63 is only a default and is
    # overwritten on the first frame.
    "focal_px": 900.0,
    "ref_res": (390, 844),      # the logical portrait viewport
    "near": 0.30,
    "far": 400.0,
    "res": (1170, 2532),        # exactly 3x the reference, so aspect matches
    "band": (15.0, 25.0),       # §5.2 the elevation band, enforced in cameras.py
}


def fov_deg():
    """(vertical, horizontal) in degrees, as the game actually renders it."""
    import math
    w, h = CAMERA["ref_res"]
    f = CAMERA["focal_px"]
    return (math.degrees(2 * math.atan((h * 0.5) / f)),
            math.degrees(2 * math.atan((w * 0.5) / f)))


def elevation_deg():
    import math
    ex, ey, ez = CAMERA["eye"]
    tx, ty, tz = CAMERA["target"]
    flat = math.hypot(tx - ex, ty - ey)
    return math.degrees(math.atan2(ez - tz, flat))


# --------------------------------------------------------------------------
# §3.4  crowd, §3.5 props
# --------------------------------------------------------------------------

CROWD_DEFAULT = 9000        # a full bowl at 0.55 m seat pitch is ~18,000
STRIPE_W = 5.25             # 20 mow bands over a 105 m pitch


def summary():
    print("style: pitch %.0fx%.0f m · bowl %.1fx%.1f m · rake %.1f deg"
          % (PITCH["halfW"] * 2, PITCH["halfL"] * 2,
             BOWL["hx"] * 2, BOWL["hy"] * 2, rake_deg()))
    fv, fh = fov_deg()
    print("       figure %.2f m = %.1f heads · camera %.1f deg elev, "
          "FOV %.1f v / %.1f h" % (FIGURE["crown"], head_count(),
                                   elevation_deg(), fv, fh))
    print("       %d lighting conditions, hero = %s"
          % (len(CONDITIONS), HERO_CONDITION))
